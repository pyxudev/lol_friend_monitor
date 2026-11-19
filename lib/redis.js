'use strict';
/**
 * Upstash Redis（REST API）への薄いクライアント。依存パッケージなし。
 *
 * 環境変数（どちらの名前でも可）:
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 *   KV_REST_API_URL        / KV_REST_API_TOKEN   … Vercel Marketplace 連携時の名前
 *
 * どちらも未設定ならプロセス内メモリで動く（ローカル開発用）。
 * Vercel 上では関数インスタンス間でメモリを共有できないので、未設定のときはエラーにする。
 */

const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';

async function upstash(args) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Redis: ${data.error || res.status}`);
  return data.result;
}

/* ------------------------------------------------ メモリ実装（開発用） */

const mem = new Map();          // key -> { v, exp }
function memGet(k) {
  const e = mem.get(k);
  if (!e) return undefined;
  if (e.exp && e.exp < Date.now()) { mem.delete(k); return undefined; }
  return e.v;
}
function memCmd(args) {
  const [cmd, ...a] = args;
  switch (String(cmd).toUpperCase()) {
    case 'GET': { const v = memGet(a[0]); return typeof v === 'string' ? v : null; }
    case 'MGET': return a.map((k) => { const v = memGet(k); return typeof v === 'string' ? v : null; });
    case 'SET': {
      const [k, v, ...opt] = a;
      const o = opt.map((x) => String(x).toUpperCase());
      if (o.includes('NX') && memGet(k) !== undefined) return null;
      const exIdx = o.indexOf('EX');
      const exp = exIdx >= 0 ? Date.now() + Number(opt[exIdx + 1]) * 1000 : 0;
      mem.set(k, { v: String(v), exp });
      return 'OK';
    }
    case 'DEL': { let n = 0; for (const k of a) if (mem.delete(k)) n++; return n; }
    case 'INCR': {
      const e = mem.get(a[0]);
      const n = Number((e && memGet(a[0])) || 0) + 1;
      mem.set(a[0], { v: String(n), exp: e ? e.exp : 0 });
      return n;
    }
    case 'EXPIRE': { const e = mem.get(a[0]); if (!e) return 0; e.exp = Date.now() + Number(a[1]) * 1000; return 1; }
    case 'SADD': { const s = memGet(a[0]) || new Set(); a.slice(1).forEach((x) => s.add(String(x))); mem.set(a[0], { v: s, exp: 0 }); return 1; }
    case 'SREM': { const s = memGet(a[0]); if (s) a.slice(1).forEach((x) => s.delete(String(x))); return 1; }
    case 'SMEMBERS': { const s = memGet(a[0]); return s ? [...s] : []; }
    default: throw new Error(`memory redis: 未対応のコマンド ${cmd}`);
  }
}

let warned = false;
async function cmd(...args) {
  if (URL_ && TOKEN) return upstash(args);
  if (process.env.VERCEL) throw new Error('Upstash Redis が未設定です（UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN）');
  if (!warned) { warned = true; console.warn('[redis] Upstash 未設定のためメモリに保存します（再起動で消えます）'); }
  return memCmd(args);
}

/* ------------------------------------------------------- JSON ヘルパー */

function parse(v) {
  if (v == null) return null;
  try { return JSON.parse(v); } catch (_) { return null; }
}

const redis = {
  cmd,
  async getJson(key) { return parse(await cmd('GET', key)); },
  async mgetJson(...keys) { return (await cmd('MGET', ...keys)).map(parse); },
  async setJson(key, value, ttlSec) {
    return ttlSec ? cmd('SET', key, JSON.stringify(value), 'EX', ttlSec) : cmd('SET', key, JSON.stringify(value));
  },
};

module.exports = { redis };
