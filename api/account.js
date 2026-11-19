'use strict';
/**
 * POST   /api/account  アカウント作成（ユーザートークンとエージェントトークンを返す）
 * GET    /api/account  アカウント情報（エージェントトークンを含む）
 * DELETE /api/account  アカウントと保存データをすべて削除
 */

const { handler, send, clientIp, HttpError } = require('../lib/http');
const { redis } = require('../lib/redis');
const users = require('../lib/users');
const { riotAvailable } = require('../lib/riot');

const MAX_CREATE_PER_HOUR = 10;

module.exports = handler({
  async POST(req, res) {
    const rl = `rl:acct:${clientIp(req)}`;
    const n = await redis.cmd('INCR', rl);
    if (n === 1) await redis.cmd('EXPIRE', rl, 3600);
    if (n > MAX_CREATE_PER_HOUR) throw new HttpError(429, 'アカウント作成の回数が多すぎます。しばらく待ってから再度お試しください');
    const acct = await users.createAccount();
    send(res, 201, acct);
  },

  async GET(req, res) {
    const { uid } = await users.authenticate(req, 'user');
    const cfg = await users.loadCfg(uid);
    send(res, 200, { uid, agentToken: cfg.agentToken, createdAt: cfg.createdAt, riotAvailable: riotAvailable() });
  },

  async DELETE(req, res) {
    const { uid, token } = await users.authenticate(req, 'user');
    await users.deleteAccount(uid, token);
    send(res, 200, { ok: true });
  },
});
