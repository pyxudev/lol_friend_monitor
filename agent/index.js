#!/usr/bin/env node
'use strict';
/**
 * LoL Friend Watcher エージェント
 *
 * League クライアントが動いている PC で起動し、LCU API から取得したフレンドの状態を
 * Web 版（Vercel）へ送信する。ブラウザから LCU には直接アクセスできないための中継役。
 *
 *   node agent/index.js --server https://<your-app>.vercel.app --token lfwa_xxx
 *
 * 2 回目以降は ~/.lol-friend-watcher/agent.json に保存した値を使うので引数は不要。
 *
 * オプション:
 *   --server <url>   Web 版の URL（環境変数 LFW_SERVER）
 *   --token <token>  設定画面に表示されるエージェントトークン（環境変数 LFW_TOKEN）
 *   --mock           League クライアントの代わりにダミーデータを送る（動作確認用）
 *   --no-save        server / token を保存しない
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { LcuClient } = require('./lcu');
const { MockSource } = require('./mock');

const HEARTBEAT_MS = 60000;   // 状態が変わらなくてもこの間隔で送る（サーバーは 180 秒途切れると停止扱い）
const CONFIG_DIR = path.join(os.homedir(), '.lol-friend-watcher');
const CONFIG_FILE = path.join(CONFIG_DIR, 'agent.json');

/* ------------------------------------------------------------- 引数 */

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [name, inline] = a.slice(2).split('=', 2);
    if (inline !== undefined) out[name] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[name] = argv[++i];
    else out.flags.add(name);
  }
  return out;
}

function loadSaved() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { return {}; }
}

function save(conf) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(conf, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn('[agent] 設定の保存に失敗しました:', e.message);
  }
}

const args = parseArgs(process.argv.slice(2));
const saved = loadSaved();
const MOCK = args.flags.has('mock') || process.env.MOCK === '1';
const SERVER = String(args.server || process.env.LFW_SERVER || saved.server || '').replace(/\/+$/, '');
const TOKEN = String(args.token || process.env.LFW_TOKEN || saved.token || '');

if (!SERVER || !TOKEN) {
  console.error('使い方: node agent/index.js --server https://<your-app>.vercel.app --token <エージェントトークン>');
  console.error('エージェントトークンは Web 版の「設定」→「エージェント」に表示されます。');
  process.exit(1);
}
if (!/^https?:\/\//.test(SERVER)) {
  console.error(`--server には http(s):// から始まる URL を指定してください: ${SERVER}`);
  process.exit(1);
}
if (!args.flags.has('no-save') && (saved.server !== SERVER || saved.token !== TOKEN)) {
  save({ server: SERVER, token: TOKEN });
  console.log(`[agent] 接続先を ${CONFIG_FILE} に保存しました（次回から引数なしで起動できます）`);
}

const source = MOCK ? new MockSource() : new LcuClient();

/* --------------------------------------------------------- 送信データ */

/** LCU のフレンドオブジェクトから必要な項目だけを取り出す（送信量とプライバシーのため） */
function pick(f) {
  if (!f) return null;
  const lol = f.lol || {};
  const o = {
    gameName: f.gameName, tagLine: f.tagLine, gameTag: f.gameTag, name: f.name,
    icon: f.icon, availability: f.availability,
    productId: f.productId, product: f.product,
    statusMessage: f.statusMessage,
    groupName: f.groupName, displayGroupName: f.displayGroupName,
    summonerLevel: f.summonerLevel,
    lol: { gameStatus: lol.gameStatus, gameQueueType: lol.gameQueueType, level: lol.level },
  };
  if (f.puuid) o.puuid = f.puuid; else if (f.pid) o.pid = f.pid;
  return o;
}

async function collect(state) {
  try {
    const friends = (await source.getFriends()).map(pick);
    if (!state.me) state.me = pick(await source.getCurrentSummoner());
    return { connected: true, mock: MOCK, me: state.me, friends };
  } catch (err) {
    state.me = null;
    const error = err && err.code === 'NO_CREDENTIALS'
      ? 'League クライアントが起動していません（lockfile を検出できませんでした）'
      : (err && err.message) || String(err);
    return { connected: false, mock: MOCK, error };
  }
}

async function push(payload) {
  const res = await fetch(`${SERVER}/api/agent/push`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) {
    const e = new Error(data.error || `認証に失敗しました (${res.status})`);
    e.fatal = true;
    throw e;
  }
  if (!res.ok) throw new Error(data.error || `サーバーエラー (${res.status})`);
  return data;
}

/* ------------------------------------------------------------- ループ */

async function main() {
  console.log('');
  console.log('  LoL Friend Watcher エージェント');
  console.log(`  → 送信先: ${SERVER}`);
  console.log(`  モード: ${MOCK ? 'モック（デモデータ）' : 'LCU 接続'}`);
  console.log('  Ctrl+C で終了します');
  console.log('');

  const state = { me: null };
  let interval = 5000;
  let lastSig = null;
  let lastPushAt = 0;
  let lastConnected = null;
  let failures = 0;

  for (;;) {
    const payload = await collect(state);
    if (payload.connected !== lastConnected) {
      console.log(payload.connected
        ? `[agent] League クライアントに接続しました（フレンド ${payload.friends.length} 人）`
        : `[agent] ${payload.error}`);
      lastConnected = payload.connected;
    }

    const sig = JSON.stringify(payload);
    const now = Date.now();
    if (sig !== lastSig || now - lastPushAt >= HEARTBEAT_MS) {
      try {
        const r = await push(payload);
        lastSig = sig;
        lastPushAt = now;
        if (failures) console.log('[agent] サーバーへの送信が復旧しました');
        failures = 0;
        if (r.alerts) console.log(`[agent] 通知 ${r.alerts} 件`);
        if (r.pollIntervalMs && r.pollIntervalMs !== interval) {
          interval = r.pollIntervalMs;
          console.log(`[agent] 更新間隔: ${interval / 1000} 秒`);
        }
      } catch (e) {
        if (e.fatal) {
          console.error(`[agent] ${e.message}`);
          console.error('[agent] Web 版の設定画面で最新のエージェントトークンを確認し、--token を付けて再起動してください。');
          process.exit(1);
        }
        failures++;
        if (failures === 1 || failures % 12 === 0) console.warn(`[agent] 送信に失敗しました（再試行します）: ${e.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

process.on('SIGINT', () => { console.log('\n終了します'); process.exit(0); });
main();
