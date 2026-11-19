'use strict';
/**
 * POST /api/agent/push  PC 上のエージェントから LCU のフレンド状態を受け取る。
 *
 * body: { connected: boolean, error?: string, mock?: boolean, me?: object, friends?: object[] }
 * エージェントは状態が変わったとき、または最低 60 秒ごとに送ってくる。
 * 応答の pollIntervalMs でエージェントのポーリング間隔を指示する。
 */

const { handler, send, readJson } = require('../../lib/http');
const { authenticate, k } = require('../../lib/users');
const { redis } = require('../../lib/redis');
const { loadAll } = require('../../lib/state');
const { applyPush } = require('../../lib/core');
const { notifyAll } = require('../../lib/notify');

module.exports = handler({
  async POST(req, res) {
    const { uid } = await authenticate(req, 'agent');
    const payload = await readJson(req);
    const s = await loadAll(uid);
    const { agent, alerts } = applyPush(s.cfg, s.agent, s.riot, payload, Date.now());
    await redis.setJson(k.agent(uid), agent);
    await notifyAll(s.cfg.settings, alerts);
    send(res, 200, {
      ok: true,
      alerts: alerts.length,
      pollIntervalMs: s.cfg.settings.pollIntervalMs,
      watched: s.cfg.watched.length,
    });
  },
});
