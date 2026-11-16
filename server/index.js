'use strict';
/**
 * LoL Friend Watcher — ローカルサーバー
 *
 *  - League クライアントのローカル API を定期ポーリングしてフレンドの状態を取得
 *  - 監視登録したプレイヤーが offline → online に変化したらアラートを発火
 *  - ブラウザへは SSE でリアルタイム配信（デスクトップ通知＋音）
 *  - Discord Webhook を設定すればブラウザを閉じていても通知が届く
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { LcuClient } = require('./lcu');
const { MockSource } = require('./mock');
const { Store } = require('./store');
const { postDiscord } = require('./notify');

const MOCK = process.argv.includes('--mock') || process.env.MOCK === '1';
const PORT = Number(process.env.PORT || 7320);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const store = new Store();
const source = MOCK ? new MockSource() : new LcuClient();

/* ---------------------------------------------------------------- 状態 */

const state = {
  connected: false,
  mock: MOCK,
  lastError: null,
  lastPollAt: null,
  me: null,
  friends: [],
  alerts: [],        // 直近のアラート（新しい順、最大 50 件）
};

/** key -> { availability, online, lastNotifiedAt } */
const prevStatus = new Map();
let baselineReady = false;   // 起動直後の 1 回目はアラートを出さない

const ONLINE_STATES = new Set(['chat', 'away', 'dnd', 'mobile']);

function isOnline(availability) {
  if (!availability) return false;
  if (!ONLINE_STATES.has(availability)) return false;
  if (!store.settings.notifyAwayAsOnline && availability !== 'chat') return false;
  return true;
}

/** LCU のフレンドオブジェクトを UI 用に整形する */
function normalize(f) {
  const gameName = f.gameName || f.name || '(不明)';
  const tagLine = f.tagLine || f.gameTag || '';
  const key = f.puuid || f.pid || `${gameName}#${tagLine}`.toLowerCase();
  const lol = f.lol || {};
  return {
    key,
    displayName: tagLine ? `${gameName}#${tagLine}` : gameName,
    gameName,
    tagLine,
    icon: f.icon || 0,
    availability: f.availability || 'offline',
    online: isOnline(f.availability),
    statusMessage: f.statusMessage || '',
    groupName: f.groupName || f.displayGroupName || '',
    gameStatus: lol.gameStatus || '',
    gameQueueType: lol.gameQueueType || '',
    level: Number(lol.level || f.summonerLevel || 0),
    note: f.note || '',
  };
}

/* ------------------------------------------------------------ SSE 配信 */

const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

function publicState() {
  return {
    connected: state.connected,
    mock: state.mock,
    lastError: state.lastError,
    lastPollAt: state.lastPollAt,
    me: state.me,
    friends: state.friends,
    watched: store.watched,
    settings: { ...store.settings, discordWebhook: store.settings.discordWebhook ? '(設定済み)' : '' },
    alerts: state.alerts,
  };
}

/* -------------------------------------------------------------- 監視処理 */

async function poll() {
  try {
    const raw = await source.getFriends();
    const friends = raw.map(normalize).sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.displayName.localeCompare(b.displayName, 'ja');
    });

    if (!state.connected) {
      // 再接続時は誤爆防止のためベースラインを取り直す
      baselineReady = false;
      state.me = await safeMe();
    }
    state.connected = true;
    state.lastError = null;
    state.lastPollAt = new Date().toISOString();
    state.friends = friends;

    detectTransitions(friends);
    baselineReady = true;

    broadcast('state', publicState());
  } catch (err) {
    const msg = err && err.code === 'NO_CREDENTIALS'
      ? 'League クライアントが起動していません（lockfile を検出できませんでした）'
      : (err && err.message) || String(err);
    if (state.connected || state.lastError !== msg) {
      state.connected = false;
      state.lastError = msg;
      state.friends = [];
      prevStatus.clear();
      baselineReady = false;
      broadcast('state', publicState());
    }
  }
}

async function safeMe() {
  try {
    const me = await source.getCurrentSummoner();
    return me ? normalize(me) : null;
  } catch (_) { return null; }
}

function detectTransitions(friends) {
  const watchedKeys = new Set(store.watched.map((w) => w.key));
  const now = Date.now();
  const quietMs = store.settings.quietMinutes * 60 * 1000;

  for (const f of friends) {
    const prev = prevStatus.get(f.key);
    const wasOnline = prev ? prev.online : false;
    const lastNotifiedAt = prev ? prev.lastNotifiedAt : 0;

    let notified = lastNotifiedAt;
    const becameOnline = !wasOnline && f.online;

    if (baselineReady && becameOnline && watchedKeys.has(f.key)) {
      if (!quietMs || now - lastNotifiedAt > quietMs) {
        notified = now;
        fireAlert(f);
      }
    }
    prevStatus.set(f.key, { availability: f.availability, online: f.online, lastNotifiedAt: notified });
  }

  // リストから消えたフレンド（＝ブロック/削除）は記録も消す
  const alive = new Set(friends.map((f) => f.key));
  for (const k of prevStatus.keys()) if (!alive.has(k)) prevStatus.delete(k);
}

function fireAlert(friend) {
  const alert = {
    id: `${friend.key}-${Date.now()}`,
    key: friend.key,
    displayName: friend.displayName,
    icon: friend.icon,
    availability: friend.availability,
    gameStatus: friend.gameStatus,
    statusMessage: friend.statusMessage,
    at: new Date().toISOString(),
  };
  state.alerts.unshift(alert);
  state.alerts = state.alerts.slice(0, 50);

  console.log(`[alert] ${alert.displayName} がオンラインになりました (${alert.availability})`);
  broadcast('alert', alert);

  const hook = store.settings.discordWebhook;
  if (hook) {
    postDiscord(hook, alert).then((r) => {
      if (!r.ok) console.error('[discord] 送信失敗:', r.error || r.status);
    });
  }
}

/* ----------------------------------------------------------- ポーリング */

let timer = null;
function schedule() {
  if (timer) clearTimeout(timer);
  const run = async () => {
    await poll();
    timer = setTimeout(run, store.settings.pollIntervalMs);
  };
  timer = setTimeout(run, 0);
}

/* --------------------------------------------------------- HTTP サーバー */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new Error('リクエストが大きすぎます')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('JSON が不正です')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // localhost 以外からのアクセスは拒否（認証情報を扱うため）
  const ra = req.socket.remoteAddress || '';
  if (!(ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('このサーバーは localhost からのみ利用できます');
  }

  try {
    if (p === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, publicState());
    }

    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
      sseClients.add(res);
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
      req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
      return;
    }

    if (p === '/api/watch' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.key) return sendJson(res, 400, { error: 'key が必要です' });
      const f = state.friends.find((x) => x.key === body.key);
      store.addWatch({
        key: body.key,
        name: body.name || (f && f.gameName) || body.key,
        tag: body.tag || (f && f.tagLine) || '',
        icon: (f && f.icon) || 0,
        note: body.note || '',
      });
      broadcast('state', publicState());
      return sendJson(res, 200, { watched: store.watched });
    }

    if (p.startsWith('/api/watch/') && req.method === 'DELETE') {
      const key = decodeURIComponent(p.slice('/api/watch/'.length));
      store.removeWatch(key);
      broadcast('state', publicState());
      return sendJson(res, 200, { watched: store.watched });
    }

    if (p === '/api/settings' && req.method === 'PUT') {
      const body = await readBody(req);
      const before = store.settings.pollIntervalMs;
      store.updateSettings(body);
      if (store.settings.pollIntervalMs !== before) schedule();
      broadcast('state', publicState());
      return sendJson(res, 200, { settings: publicState().settings });
    }

    if (p === '/api/test-notify' && req.method === 'POST') {
      const sample = {
        id: `test-${Date.now()}`,
        key: 'test',
        displayName: 'テスト通知',
        icon: 0,
        availability: 'chat',
        gameStatus: 'outOfGame',
        statusMessage: '通知の動作確認です',
        at: new Date().toISOString(),
      };
      broadcast('alert', sample);
      let discord = null;
      if (store.settings.discordWebhook) discord = await postDiscord(store.settings.discordWebhook, sample);
      return sendJson(res, 200, { ok: true, discord });
    }

    if (p === '/api/refresh' && req.method === 'POST') {
      await poll();
      return sendJson(res, 200, { ok: true });
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

    return serveStatic(req, res, p);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  LoL Friend Watcher');
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  モード: ${MOCK ? 'モック（デモデータ）' : 'LCU 接続'}`);
  console.log(`  監視中のプレイヤー: ${store.watched.length} 人`);
  console.log('');
  schedule();
});

process.on('SIGINT', () => { console.log('\n終了します'); server.close(); process.exit(0); });
