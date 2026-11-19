'use strict';
/** Vercel の Node 関数とローカル開発サーバーの両方で動く HTTP ヘルパー */

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** JSON ボディを読む。Vercel では req.body が解析済みなのでそれを優先する */
async function readJson(req) {
  let pre;
  try { pre = req.body; } catch (_) { throw new HttpError(400, 'JSON が不正です'); }
  if (pre !== undefined && pre !== null) {
    if (typeof pre === 'object' && !Buffer.isBuffer(pre)) return pre;
    const text = Buffer.isBuffer(pre) ? pre.toString('utf8') : String(pre);
    if (!text) return {};
    try { return JSON.parse(text); } catch (_) { throw new HttpError(400, 'JSON が不正です'); }
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2e6) throw new HttpError(413, 'リクエストが大きすぎます');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch (_) { throw new HttpError(400, 'JSON が不正です'); }
}

function query(req) {
  return new URL(req.url, 'http://localhost').searchParams;
}

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : '';
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** ハンドラを包んで、メソッド制限とエラー応答を共通化する */
function handler(methods) {
  return async (req, res) => {
    try {
      const m = methods[req.method];
      if (!m) {
        res.setHeader('Allow', Object.keys(methods).join(', '));
        return send(res, 405, { error: 'method not allowed' });
      }
      await m(req, res);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('[api]', e);
      if (!res.writableEnded) send(res, status, { error: e.message || 'internal error' });
    }
  };
}

module.exports = { send, readJson, query, bearer, clientIp, handler, HttpError };
