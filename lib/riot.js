'use strict';
/**
 * Riot 公開 API による「試合中」検知（エージェントが動いていないときの補完）。
 *
 * 公開 API ではフレンドリストやオンライン状態は取れないため、
 * 監視リストの Riot ID を PUUID に解決し、Spectator-V5 で進行中の試合があるかだけを見る。
 * ロビー・キュー・チャンピオン選択は検知できず、試合開始のタイミングで通知される。
 *
 * エージェントが LCU のデータを送っている間は動かない（そちらの方が詳細で速いため）。
 */

const { redis } = require('./redis');
const { k } = require('./users');
const { agentLive, lastNotified } = require('./core');
const { notifyAll } = require('./notify');

const API_KEY = process.env.RIOT_API_KEY || '';
const RIOT_INTERVAL_MS = 60000;   // 1 ユーザーあたりの確認間隔
const FORCE_MIN_MS = 15000;       // 手動更新でもこれより短い間隔では叩かない
const MAX_PER_RUN = 20;
const PUUID_TTL = 7 * 86400;

const REGION = {
  jp1: 'asia', kr: 'asia', oc1: 'asia', sg2: 'asia', tw2: 'asia', vn2: 'asia', th2: 'asia', ph2: 'asia',
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe', me1: 'europe',
};

const QUEUE_LABEL = {
  0: 'カスタム', 400: 'ノーマル（ドラフト）', 420: 'ランク（ソロ/デュオ）', 430: 'ノーマル（ブラインド）',
  440: 'ランク（フレックス）', 450: 'ARAM', 490: 'クイックプレイ', 700: 'Clash', 900: 'URF',
  1700: 'アリーナ', 1900: 'URF', 830: 'Co-op vs AI', 840: 'Co-op vs AI', 850: 'Co-op vs AI',
};

function riotAvailable() { return !!API_KEY; }

class RateLimited extends Error {}

async function riotGet(url) {
  const res = await fetch(url, {
    headers: { 'X-Riot-Token': API_KEY },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 429) throw new RateLimited('Riot API のレート制限に達しました');
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new Error(`Riot API キーが無効です（${res.status}）`);
  if (!res.ok) { const e = new Error(`Riot API ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

function emptyRiotState() {
  return { lastRunAt: 0, lastError: null, players: {}, notified: {}, alerts: [] };
}

/** Riot ID → PUUID（キャッシュあり。PUUID は API キーごとに暗号化されるのでキー変更時は 400 になる） */
async function resolvePuuid(name, tag, platform) {
  const id = `${name}#${tag}`.toLowerCase();
  const cacheKey = `riot:puuid:${id}`;
  const cached = await redis.cmd('GET', cacheKey);
  if (cached === '!') return null;
  if (cached) return cached;

  const region = REGION[platform] || 'asia';
  const acc = await riotGet(`https://${region}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);
  if (!acc || !acc.puuid) {
    await redis.cmd('SET', cacheKey, '!', 'EX', 3600);   // 存在しない Riot ID は 1 時間覚えておく
    return null;
  }
  await redis.cmd('SET', cacheKey, acc.puuid, 'EX', PUUID_TTL);
  return acc.puuid;
}

async function activeGame(puuid, platform) {
  return riotGet(`https://${platform}.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${encodeURIComponent(puuid)}`);
}

function makeRiotAlert(w, game, now) {
  const queue = QUEUE_LABEL[game.gameQueueConfigId] || game.gameMode || '';
  const name = w.tag ? `${w.name}#${w.tag}` : w.name;
  return {
    id: `${w.key}-${now}`,
    key: w.key,
    displayName: name,
    icon: w.icon || 0,
    availability: 'dnd',
    gameStatus: 'inGame',
    inGame: true,
    lolOnline: true,
    productId: 'league_of_legends',
    productLabel: 'League of Legends',
    statusMessage: queue,
    reason: 'online',
    source: 'riot',
    at: new Date(now).toISOString(),
  };
}

/**
 * 1 ユーザー分の Riot API チェック。
 * 実行条件を満たさなければ何もしない。状態の保存と Discord 通知まで行う。
 * @returns {Promise<object|null>} 更新後の riot 状態（実行しなかった場合は null）
 */
async function runRiotCheck(uid, cfg, agent, riot, { now = Date.now(), force = false } = {}) {
  if (!API_KEY || !cfg.settings.riotEnabled) return null;
  riot = { ...emptyRiotState(), ...(riot || {}) };

  // エージェントが動いている間は Riot API は使わない。
  // 再開時に古い状態と比べて誤通知しないよう、基準を捨てておく。
  if (agentLive(agent, now)) {
    if (Object.keys(riot.players).length) {
      riot.players = {};
      await redis.setJson(k.riot(uid), riot);
      return riot;
    }
    return null;
  }

  const minGap = force ? FORCE_MIN_MS : RIOT_INTERVAL_MS;
  if (now - riot.lastRunAt < minGap) return null;

  // 同じユーザーを複数のリクエストが同時にチェックしないようにロックする
  const got = await redis.cmd('SET', k.riotLock(uid), String(now), 'NX', 'EX', 50);
  if (got !== 'OK') return null;
  try {
    return await checkPlayers(uid, cfg, agent, riot, now);
  } finally {
    await redis.cmd('DEL', k.riotLock(uid)).catch(() => {});
  }
}

async function checkPlayers(uid, cfg, agent, riot, now) {
  const platform = cfg.settings.riotPlatform || 'jp1';
  const targets = cfg.watched.filter((w) => w.name && w.tag).slice(0, MAX_PER_RUN);
  const quietMs = cfg.settings.quietMinutes * 60 * 1000;
  const players = {};
  const alerts = [];
  riot.lastError = null;

  try {
    for (const w of targets) {
      const prev = riot.players[w.key];
      try {
        const puuid = await resolvePuuid(w.name, w.tag, platform);
        if (!puuid) { players[w.key] = { inGame: false, checkedAt: now, error: 'Riot ID が見つかりません' }; continue; }
        let game;
        try {
          game = await activeGame(puuid, platform);
        } catch (e) {
          // API キーを変えた後は古い PUUID を復号できず 400 になる → キャッシュを捨てる
          if (e.status === 400) await redis.cmd('DEL', `riot:puuid:${`${w.name}#${w.tag}`.toLowerCase()}`);
          throw e;
        }
        const inGame = !!game;
        players[w.key] = {
          inGame,
          checkedAt: now,
          queue: game ? (QUEUE_LABEL[game.gameQueueConfigId] || game.gameMode || '') : '',
          startedAt: game && game.gameStartTime ? game.gameStartTime : 0,
        };
        // 前回の確認で試合外だった相手が試合に入っていたら通知（初回の確認は基準取得のみ）
        if (inGame && prev && !prev.inGame && !prev.error) {
          const last = lastNotified(w.key, agent, riot);
          if (!last || !quietMs || now - last > quietMs) {
            riot.notified[w.key] = now;
            alerts.push(makeRiotAlert(w, game, now));
          }
        }
      } catch (e) {
        if (e instanceof RateLimited) throw e;
        players[w.key] = { ...(prev || { inGame: false }), checkedAt: now, error: e.message };
        if (/API キー/.test(e.message)) throw e;
      }
    }
  } catch (e) {
    riot.lastError = e.message;
    // 取得できなかったプレイヤーは前回の状態を引き継ぐ
    for (const w of targets) if (!players[w.key] && riot.players[w.key]) players[w.key] = riot.players[w.key];
  }

  riot.players = players;
  riot.lastRunAt = now;
  riot.alerts = [...alerts, ...riot.alerts].slice(0, 50);
  for (const [key, t] of Object.entries(riot.notified)) if (now - t > 86400000) delete riot.notified[key];

  await redis.setJson(k.riot(uid), riot);
  await notifyAll(cfg.settings, alerts);
  return riot;
}

module.exports = { runRiotCheck, riotAvailable, emptyRiotState, RIOT_INTERVAL_MS };
