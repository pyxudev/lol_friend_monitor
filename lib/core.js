'use strict';
/**
 * エージェント（LCU）から届いたフレンド状態の正規化と、通知すべき変化の検出。
 *
 * 判定ルールはローカル版と同じ:
 *  - 監視中のプレイヤーが「LoL で在席していない」→「在席」に変わったら 1 回通知
 *  - 離席中などで一旦見送った場合は pending として覚え、ゲームに入った時点で通知
 *  - 短い途切れ（STALE_MS 以内）は直前の状態を保持し、その間のオンライン化も通知
 *  - 長い途切れ・初回は基準の取得だけ行い通知しない
 */

/** エージェントの送信が途切れたとみなす時間（エージェントは最低 60 秒ごとに送信する） */
const STALE_MS = 180000;

const ONLINE_STATES = new Set(['chat', 'away', 'dnd', 'mobile']);
/** LoL クライアント上の在席とみなす availability（mobile は Riot モバイルアプリ） */
const LOL_STATES = new Set(['chat', 'away', 'dnd']);
const LOL_PRODUCTS = new Set(['league_of_legends', 'leagueoflegends', 'lol']);

const PRODUCT_LABEL = {
  league_of_legends: 'League of Legends',
  valorant: 'VALORANT',
  bacon: 'Legends of Runeterra',
  wildrift: 'ワイルドリフト',
  riot: 'Riot クライアント',
  '2xko': '2XKO',
};

/** ゲームに入っている（＝確実に LoL を起動している）と言える gameStatus */
const IN_GAME_STATES = new Set(['inqueue', 'championselect', 'ingame', 'spectating']);

function isInGameStatus(gameStatus) {
  const s = String(gameStatus || '').toLowerCase();
  if (!s) return false;
  return IN_GAME_STATES.has(s) || s.startsWith('hosting_');
}

function isLolOnline(availability, productId, gameStatus) {
  if (!LOL_STATES.has(availability)) return false;
  if (productId) return LOL_PRODUCTS.has(productId);
  return !!gameStatus;
}

const str = (v, max = 120) => String(v == null ? '' : v).slice(0, max);

/** LCU のフレンドオブジェクトを UI 用に整形する（クライアントから来た値なので長さも制限する） */
function normalize(f) {
  f = f || {};
  const gameName = str(f.gameName || f.name || '(不明)', 64);
  const tagLine = str(f.tagLine || f.gameTag || '', 16);
  const key = str(f.puuid || f.pid || `${gameName}#${tagLine}`.toLowerCase(), 128);
  const lol = (f.lol && typeof f.lol === 'object') ? f.lol : {};
  const availability = str(f.availability || 'offline', 16);
  const productId = str(f.productId || f.product || '', 32).trim().toLowerCase();
  const gameStatus = str(lol.gameStatus || '', 32);
  const online = ONLINE_STATES.has(availability);
  const lolOnline = isLolOnline(availability, productId, gameStatus);
  return {
    key,
    displayName: tagLine ? `${gameName}#${tagLine}` : gameName,
    gameName,
    tagLine,
    icon: Number(f.icon) || 0,
    availability,
    online,
    lolOnline,
    productId,
    productLabel: PRODUCT_LABEL[productId] || productId || '',
    statusMessage: str(f.statusMessage, 140),
    groupName: str(f.groupName || f.displayGroupName || '', 40),
    gameStatus,
    inGame: lolOnline && isInGameStatus(gameStatus),
    gameQueueType: str(lol.gameQueueType || '', 40),
    level: Number(lol.level || f.summonerLevel || 0) || 0,
  };
}

function sortFriends(list) {
  return list.sort((a, b) => {
    // LoL でオンライン → 他タイトルでオンライン → オフライン の順
    if (a.lolOnline !== b.lolOnline) return a.lolOnline ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.displayName.localeCompare(b.displayName, 'ja');
  });
}

function isPresentForNotify(f, settings) {
  return settings.lolOnly ? f.lolOnline : f.online;
}

/** 今この瞬間に通知してよい状態か。ゲーム中は設定にかかわらず常に通知する */
function isNotifiableNow(f, settings) {
  if (!isPresentForNotify(f, settings)) return false;
  if (f.inGame) return true;
  if (f.availability === 'chat') return true;
  return !!settings.notifyAwayAsOnline;
}

function emptyAgentState() {
  return {
    connected: false, mock: false, error: null,
    lastPushAt: 0, lastSuccessAt: 0,
    me: null, friends: [], prev: {}, notified: {}, alerts: [],
  };
}

function makeAlert(f, becamePresent, now, source) {
  return {
    id: `${f.key}-${now}`,
    key: f.key,
    displayName: f.displayName,
    icon: f.icon,
    availability: f.availability,
    gameStatus: f.gameStatus,
    inGame: f.inGame,
    lolOnline: f.lolOnline,
    productId: f.productId,
    productLabel: f.productLabel,
    statusMessage: f.statusMessage,
    // 'online' = 在席になった瞬間 / 'resumed' = 在席のまま通知条件を満たした
    reason: becamePresent ? 'online' : 'resumed',
    source,
    at: new Date(now).toISOString(),
  };
}

/** 最後に通知した時刻（エージェント／Riot API のどちらで通知したかを問わない） */
function lastNotified(key, agent, riot) {
  return Math.max((agent && agent.notified && agent.notified[key]) || 0,
                  (riot && riot.notified && riot.notified[key]) || 0);
}

/**
 * エージェントからの送信を状態に反映する。
 * @returns {{ agent: object, alerts: object[] }} 新しい状態と、今回発火したアラート
 */
function applyPush(cfg, prevAgent, riot, payload, now) {
  const agent = { ...emptyAgentState(), ...(prevAgent || {}) };
  const settings = cfg.settings;
  agent.lastPushAt = now;
  agent.mock = !!payload.mock;

  if (!payload.connected) {
    // クライアント未起動など。prev は消さず、短い途切れなら復帰時に差分を検出する
    agent.connected = false;
    agent.error = str(payload.error || 'League クライアントに接続できません', 200);
    agent.friends = [];
    return { agent, alerts: [] };
  }

  const raw = Array.isArray(payload.friends) ? payload.friends.slice(0, 1000) : [];
  const friends = sortFriends(raw.map(normalize));

  // 途切れが長い（またはまったくの初回）なら基準を取り直し、この回は通知しない
  const gap = agent.lastSuccessAt ? now - agent.lastSuccessAt : Infinity;
  let baselineReady = gap <= STALE_MS && Object.keys(agent.prev).length > 0;
  if (!baselineReady) agent.prev = {};

  const watchedKeys = new Set(cfg.watched.map((w) => w.key));
  const quietMs = settings.quietMinutes * 60 * 1000;
  const alerts = [];
  const nextPrev = {};

  for (const f of friends) {
    const prev = agent.prev[f.key];
    const present = isPresentForNotify(f, settings);
    const wasPresent = prev ? prev.present : false;
    let pending = prev ? !!prev.pending : false;

    if (!present) {
      pending = false;
    } else if (baselineReady && watchedKeys.has(f.key)) {
      if (!wasPresent) pending = true;
      if (pending && isNotifiableNow(f, settings)) {
        const last = lastNotified(f.key, agent, riot);
        if (!last || !quietMs || now - last > quietMs) {
          agent.notified[f.key] = now;
          pending = false;
          alerts.push(makeAlert(f, !wasPresent, now, 'agent'));
        }
      }
    }
    nextPrev[f.key] = { present, inGame: f.inGame, pending };
  }

  agent.prev = nextPrev;   // リストから消えたフレンドの記録も消える
  agent.friends = friends;
  agent.me = payload.me ? normalize(payload.me) : agent.me;
  agent.connected = true;
  agent.error = null;
  agent.lastSuccessAt = now;
  agent.alerts = [...alerts, ...agent.alerts].slice(0, 50);

  // 1 日以上前の通知記録は不要
  for (const [key, t] of Object.entries(agent.notified)) if (now - t > 86400000) delete agent.notified[key];

  return { agent, alerts };
}

/** 設定変更で「在席」の定義が変わったときに、通知せず基準を取り直す */
function resyncPresence(agent, settings) {
  if (!agent || !agent.friends) return agent;
  const prev = {};
  for (const f of agent.friends) prev[f.key] = { present: isPresentForNotify(f, settings), inGame: f.inGame, pending: false };
  return { ...agent, prev };
}

/** エージェントのプロセスが動いているか（LCU に繋がっているかは問わない） */
function agentAlive(agent, now) {
  return !!(agent && agent.lastPushAt && now - agent.lastPushAt <= STALE_MS);
}

/** エージェント経由で LCU のフレンド状態が取れているか */
function agentLive(agent, now) {
  return agentAlive(agent, now) && !!agent.connected;
}

module.exports = {
  STALE_MS, normalize, applyPush, resyncPresence, agentAlive, agentLive,
  emptyAgentState, lastNotified, PRODUCT_LABEL,
};
