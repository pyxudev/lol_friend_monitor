'use strict';
/**
 * ローカル開発用サーバー。Vercel と同じく public/ を配信し、/api/* を api/ 配下の関数に振り分ける。
 * Upstash の環境変数が無ければメモリに保存する（再起動で消える）。
 *
 *   npm run dev            → http://localhost:7320
 *   npm run agent:mock     → 別ターミナルでモックエージェント（--server / --token を付ける）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 7320);
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const API_DIR = path.join(ROOT, 'api');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://localhost').pathname;
  if (p.startsWith('/api/')) {
    const file = path.normalize(path.join(API_DIR, `${p.slice(5).replace(/\/+$/, '')}.js`));
    if (!file.startsWith(API_DIR) || !fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{"error":"not found"}');
    }
    return require(file)(req, res);
  }
  return serveStatic(res, p);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\n  LoL Friend Watcher（開発サーバー）\n  → http://localhost:${PORT}\n`);
});
