'use strict';
/**
 * LoL Friend Watcher — ローカルサーバー
 *
 *  - League クライアントのローカル API を定期ポーリングしてフレンドの状態を取得
 *  - 監視登録したプレイヤーが「LoL でオンライン」になったらアラートを発火
 *    （Riot クライアントのみ / VALORANT などの在席では通知しない）
 *  - ポーリング間隔の間に offline → ゲーム中まで進んだ場合も取りこぼさない
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

/**
 * key -> {
 *   availability, present, inGame,
 *   pending,        // 在席になったが通知条件を満たしていない（離席中など）
 *   lastNotifiedAt
 * }
 */
const prevStatus = new Map();
let baselineReady = false;   // 起動直後の 1 回目はアラートを出さない
let lastSuccessAt = 0;       // 最後にポーリングが成功した時刻（復帰判定用）

/** チャット上「在席」とみなす availability */
const ONLINE_STATES = new Set(['chat', 'away', 'dnd', 'mobile']);

/**
 * LoL クライアント上の在席とみなす availability。
 * mobile は Riot モバイルアプリなので LoL 起動中ではない。
 */
const LOL_STATES = new Set(['chat', 'away', 'dnd']);

/** LCU の productId が LoL を指す値 */
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

/** チャット上オンラインかどうか（製品を問わない。表示用） */
function isOnline(availability) {
  return ONLINE_STATES.has(availability || 'offline');
}

/**
 * LoL クライアントでオンラインかどうか。
 * productId が取れるクライアントではそれを信頼し、
 * 取れない場合は LoL 固有の gameStatus があるかで判定する。
 */
function isLolOnline(availability, productId, gameStatus) {
  if (!LOL_STATES.has(availability)) return false;
  if (productId) return LOL_PRODUCTS.has(productId);
  return !!gameStatus;
}

/** 通知対象の「在席」判定。lolOnly が false なら製品を問わない */
function isPresentForNotify(f) {
  return store.settings.lolOnly ? f.lolOnline : f.online;
}

/**
 * 今この瞬間に通知してよい状態か。
 * ゲーム中（キュー／チャンピオン選択／試合中）は設定にかかわらず常に通知する。
 */
function isNotifiableNow(f) {
  if (!isPresentForNotify(f)) return false;
  if (f.inGame) return true;
  if (f.availability === 'chat') return true;
  return !!store.settings.notifyAwayAsOnline;
}

/** LCU のフレンドオブジェクトを UI 用に整形する */
function normalize(f) {
  const gameName = f.gameName || f.name || '(不明)';
  const tagLine = f.tagLine || f.gameTag || '';
  const key = f.puuid || f.pid || `${gameName}#${tagLine}`.toLowerCase();
  const lol = f.lol || {};
  const availability = f.availability || 'offline';
  const productId = String(f.productId || f.product || '').trim().toLowerCase();
  const gameStatus = lol.gameStatus || '';
  const online = isOnline(availability);
  const lolOnline = isLolOnline(availability, productId, gameStatus);
  return {
    key,
    displayName: tagLine ? `${gameName}#${tagLine}` : gameName,
    gameName,
    tagLine,
    icon: f.icon || 0,
    availability,
    online,
    lolOnline,
    productId,
    productLabel: PRODUCT_LABEL[productId] || productId || '',
    statusMessage: f.statusMessage || '',
    groupName: f.groupName || f.displayGroupName || '',
    gameStatus,
    inGame: lolOnline && isInGameStatus(gameStatus),
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
      // LoL でオンライン → 他タイトルでオンライン → オフライン の順
      if (a.lolOnline !== b.lolOnline) return a.lolOnline ? -1 : 1;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.displayName.localeCompare(b.displayName, 'ja');
    });

    if (!state.connected) {
      state.me = await safeMe();
      resumeBaseline();
    }
    state.connected = true;
    state.lastError = null;
    state.lastPollAt = new Date().toISOString();
    state.friends = friends;

    detectTransitions(friends);
    baselineReady = true;
    lastSuccessAt = Date.now();

    broadcast('state', publicState());
  } catch (err) {
    const msg = err && err.code === 'NO_CREDENTIALS'
      ? 'League クライアントが起動していません（lockfile を検出できませんでした）'
      : (err && err.message) || String(err);
    if (state.connected || state.lastError !== msg) {
      state.connected = false;
      state.lastError = msg;
      state.friends = [];
      // prevStatus はここでは消さない。短い切断なら復帰時に
      // 切断中のオンライン化も検出したいので resumeBaseline() で判断する。
      baselineReady = false;
      broadcast('state', publicState());
    }
  }
}

/**
 * 切断から復帰したときのベースライン処理。
 *
 * 短い切断（クライアントの一時的な応答不能など）なら直前の状態を信頼し、
 * 「切断中に offline → オンライン／ゲーム中になった」ケースも通知する。
 * 長い切断（クライアント再起動など）は全員が新規オンライン扱いになって
 * 通知が溢れるため、状態を取り直して 1 回目は通知しない。
 */
function resumeBaseline() {
  const staleMs = Math.max(60000, store.settings.pollIntervalMs * 6);
  const gap = lastSuccessAt ? Date.now() - lastSuccessAt : Infinity;

  if (prevStatus.size && gap <= staleMs) {
    baselineReady = true;
    console.log(`[poll] ${Math.round(gap / 1000)} 秒の切断から復帰（直前の状態を保持して差分を検出します）`);
  } else {
    prevStatus.clear();
    baselineReady = false;
    if (lastSuccessAt) console.log('[poll] 長時間の切断から復帰したため状態を取り直します（この回は通知しません）');
  }
}

/** 設定変更で「在席」の定義が変わったときに、通知せず基準を取り直す */
function resyncPresence() {
  for (const f of state.friends) {
    const prev = prevStatus.get(f.key);
    prevStatus.set(f.key, {
      availability: f.availability,
      present: isPresentForNotify(f),
      inGame: f.inGame,
      pending: false,
      lastNotifiedAt: prev ? prev.lastNotifiedAt : 0,
    });
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
    const present = isPresentForNotify(f);
    const wasPresent = prev ? prev.present : false;
    const lastNotifiedAt = prev ? prev.lastNotifiedAt : 0;

    let notified = lastNotifiedAt;
    // pending: 在席になったが通知条件を満たしていない状態。
    // 在席が続く間は保持し、ゲーム中などになった時点で通知する。
    // これにより「離席中で一旦見送った → 次のポーリングでゲーム中」も取りこぼさない。
    let pending = prev ? !!prev.pending : false;

    if (!present) {
      pending = false;
    } else if (baselineReady && watchedKeys.has(f.key)) {
      if (!wasPresent) pending = true;
      if (pending && isNotifiableNow(f)) {
        if (!quietMs || now - lastNotifiedAt > quietMs) {
          notified = now;
          pending = false;
          fireAlert(f, !wasPresent);
        }
      }
    }

    prevStatus.set(f.key, {
      availability: f.availability,
      present,
      inGame: f.inGame,
      pending,
      lastNotifiedAt: notified,
    });
  }

  // リストから消えたフレンド（＝ブロック/削除）は記録も消す
  const alive = new Set(friends.map((f) => f.key));
  for (const k of prevStatus.keys()) if (!alive.has(k)) prevStatus.delete(k);
}

function fireAlert(friend, becamePresent) {
  const alert = {
    id: `${friend.key}-${Date.now()}`,
    key: friend.key,
    displayName: friend.displayName,
    icon: friend.icon,
    availability: friend.availability,
    gameStatus: friend.gameStatus,
    inGame: friend.inGame,
    lolOnline: friend.lolOnline,
    productId: friend.productId,
    productLabel: friend.productLabel,
    statusMessage: friend.statusMessage,
    // 'online' = 在席になった瞬間 / 'resumed' = 在席のまま通知条件を満たした
    reason: becamePresent ? 'online' : 'resumed',
    at: new Date().toISOString(),
  };
  state.alerts.unshift(alert);
  state.alerts = state.alerts.slice(0, 50);

  const where = friend.lolOnline ? 'LoL' : (friend.productLabel || friend.availability);
  console.log(`[alert] ${alert.displayName} が ${where} で${friend.inGame ? 'ゲーム中です' : 'オンラインになりました'}`
    + ` (${friend.availability}${friend.gameStatus ? ' / ' + friend.gameStatus : ''})`);
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
      const beforeLolOnly = store.settings.lolOnly;
      store.updateSettings(body);
      if (store.settings.pollIntervalMs !== before) schedule();
      // 「在席」の定義が変わると全員が新規オンライン扱いになりかねないので基準を取り直す
      if (store.settings.lolOnly !== beforeLolOnly) resyncPresence();
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
        inGame: false,
        lolOnline: true,
        productId: 'league_of_legends',
        productLabel: 'League of Legends',
        reason: 'online',
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
  console.log(`  通知対象: ${store.settings.lolOnly ? 'LoL でオンラインのときだけ' : '製品を問わずオンライン時'}`);
  console.log('');
  schedule();
});

process.on('SIGINT', () => { console.log('\n終了します'); server.close(); process.exit(0); });
