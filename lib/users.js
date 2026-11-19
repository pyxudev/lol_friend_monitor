'use strict';
/**
 * ユーザー（アカウント）・トークン・設定・監視リスト。
 *
 * Redis キー:
 *   users                 SET   全ユーザー ID（cron で巡回する）
 *   tok:<sha256>          STR   "<uid>:user" | "<uid>:agent"
 *   u:<uid>:cfg           JSON  { watched, settings, agentToken, createdAt }
 *   u:<uid>:agent         JSON  エージェント（LCU）由来の状態  … core.js
 *   u:<uid>:riot          JSON  Riot API 由来の状態            … riot.js
 *
 * トークンは 2 種類:
 *   ユーザートークン   … ブラウザ用。すべての操作が可能。作成時に 1 度だけ表示し、サーバーにはハッシュのみ保存。
 *   エージェントトークン … PC 上のエージェント用。フレンド状態の送信だけが可能。
 */

const crypto = require('crypto');
const { redis } = require('./redis');
const { HttpError, bearer } = require('./http');

const PLATFORMS = ['jp1', 'kr', 'na1', 'br1', 'la1', 'la2', 'euw1', 'eun1', 'tr1', 'ru', 'me1', 'oc1', 'sg2', 'tw2', 'vn2', 'th2', 'ph2'];

const DEFAULT_SETTINGS = {
  pollIntervalMs: 5000,     // エージェントが LCU をポーリングする間隔
  discordWebhook: '',       // 空ならサーバー側通知は無効
  lolOnly: true,            // LoL でオンラインのときだけ通知する
  notifyAwayAsOnline: true, // away / dnd もオンライン扱いにする（false でもゲーム中は常に通知）
  soundEnabled: true,
  quietMinutes: 10,         // 同一プレイヤーへの再通知を抑制する分数
  riotEnabled: true,        // エージェント停止中は Riot API で試合中を検知する
  riotPlatform: 'jp1',      // Riot API のプラットフォーム（サーバー）
  riotApiKey: '',           // ユーザーが登録した Riot API キー（空なら Riot API は使わない）
};

const MAX_WATCHED = 30;

const k = {
  cfg: (uid) => `u:${uid}:cfg`,
  agent: (uid) => `u:${uid}:agent`,
  riot: (uid) => `u:${uid}:riot`,
  riotLock: (uid) => `u:${uid}:riotlock`,
  tok: (hash) => `tok:${hash}`,
};

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function randomToken(prefix) { return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`; }

function normalizeCfg(cfg) {
  return {
    watched: Array.isArray(cfg.watched) ? cfg.watched : [],
    settings: { ...DEFAULT_SETTINGS, ...(cfg.settings || {}) },
    agentToken: cfg.agentToken,
    createdAt: cfg.createdAt,
  };
}

async function createAccount() {
  const uid = crypto.randomBytes(9).toString('base64url');
  const userToken = randomToken('lfwu');
  const agentToken = randomToken('lfwa');
  const cfg = { watched: [], settings: { ...DEFAULT_SETTINGS }, agentToken, createdAt: new Date().toISOString() };
  await redis.setJson(k.cfg(uid), cfg);
  await redis.cmd('SET', k.tok(sha256(userToken)), `${uid}:user`);
  await redis.cmd('SET', k.tok(sha256(agentToken)), `${uid}:agent`);
  await redis.cmd('SADD', 'users', uid);
  return { uid, userToken, agentToken };
}

async function deleteAccount(uid, userToken) {
  const cfg = await redis.getJson(k.cfg(uid));
  const keys = [k.cfg(uid), k.agent(uid), k.riot(uid), k.riotLock(uid), k.tok(sha256(userToken))];
  if (cfg && cfg.agentToken) keys.push(k.tok(sha256(cfg.agentToken)));
  await redis.cmd('DEL', ...keys);
  await redis.cmd('SREM', 'users', uid);
}

/** 新しいエージェントトークンを発行し、古いものを無効化する */
async function rotateAgentToken(uid) {
  const cfg = await loadCfg(uid);
  const agentToken = randomToken('lfwa');
  if (cfg.agentToken) await redis.cmd('DEL', k.tok(sha256(cfg.agentToken)));
  await redis.cmd('SET', k.tok(sha256(agentToken)), `${uid}:agent`);
  cfg.agentToken = agentToken;
  await saveCfg(uid, cfg);
  return agentToken;
}

/** Authorization: Bearer からユーザーを特定する。kind は 'user' | 'agent' */
async function authenticate(req, kind) {
  const token = bearer(req);
  if (!token) throw new HttpError(401, 'トークンがありません');
  const v = await redis.cmd('GET', k.tok(sha256(token)));
  if (!v) throw new HttpError(401, 'トークンが無効です');
  const [uid, tkind] = String(v).split(':');
  if (tkind !== kind) throw new HttpError(403, kind === 'agent' ? 'エージェントトークンを指定してください' : 'ユーザートークンを指定してください');
  return { uid, token };
}

async function loadCfg(uid) {
  const cfg = await redis.getJson(k.cfg(uid));
  if (!cfg) throw new HttpError(401, 'アカウントが見つかりません');
  return normalizeCfg(cfg);
}

async function saveCfg(uid, cfg) {
  await redis.setJson(k.cfg(uid), cfg);
}

function applySettingsPatch(s, patch) {
  const num = (v, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : undefined;
  };
  if (patch.pollIntervalMs !== undefined) {
    const v = num(patch.pollIntervalMs, 2000, 60000);
    if (v !== undefined) s.pollIntervalMs = v;
  }
  if (patch.quietMinutes !== undefined) {
    const v = num(patch.quietMinutes, 0, 600);
    if (v !== undefined) s.quietMinutes = v;
  }
  if (patch.discordWebhook !== undefined) {
    const hook = String(patch.discordWebhook || '').trim();
    if (hook && !isDiscordWebhook(hook)) throw new HttpError(400, 'Discord の Webhook URL（https://discord.com/api/webhooks/…）を指定してください');
    s.discordWebhook = hook;
  }
  for (const key of ['lolOnly', 'notifyAwayAsOnline', 'soundEnabled', 'riotEnabled']) {
    if (patch[key] !== undefined) s[key] = !!patch[key];
  }
  if (patch.riotPlatform !== undefined) {
    const p = String(patch.riotPlatform).toLowerCase();
    if (!PLATFORMS.includes(p)) throw new HttpError(400, 'サーバー（プラットフォーム）が不正です');
    s.riotPlatform = p;
  }
  if (patch.riotApiKey !== undefined) {
    const key = String(patch.riotApiKey || '').trim();
    // 有効性は api/settings.js で Riot API に問い合わせて確認する
    if (key && !/^RGAPI-[0-9a-f-]{36}$/i.test(key)) throw new HttpError(400, 'Riot API キーは RGAPI-… の形式で入力してください');
    s.riotApiKey = key;
  }
  return s;
}

/** サーバーから任意の URL へリクエストさせないよう、Discord の Webhook のみ許可する */
function isDiscordWebhook(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:'
      && ['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'].includes(u.hostname)
      && u.pathname.startsWith('/api/webhooks/');
  } catch (_) { return false; }
}

function publicSettings(s) {
  // 秘密の値はブラウザへ返さない（登録済みかどうかだけ伝える）
  return {
    ...s,
    discordWebhook: s.discordWebhook ? '(設定済み)' : '',
    riotApiKey: s.riotApiKey ? `RGAPI-…${s.riotApiKey.slice(-4)}` : '',
  };
}

module.exports = {
  k, DEFAULT_SETTINGS, PLATFORMS, MAX_WATCHED,
  createAccount, deleteAccount, rotateAgentToken, authenticate,
  loadCfg, saveCfg, normalizeCfg, applySettingsPatch, publicSettings, isDiscordWebhook,
};
