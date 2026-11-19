'use strict';
/**
 * GET /api/cron  全ユーザーの Riot API チェック（ブラウザを閉じていても試合開始を検知するため）。
 *
 * Authorization: Bearer <CRON_SECRET> が必要。
 * Vercel Cron（Pro プランなら毎分可）や cron-job.org などの外部サービスから 1 分ごとに呼ぶ。
 */

const { handler, send, bearer, HttpError } = require('../lib/http');
const { redis } = require('../lib/redis');
const { loadAll } = require('../lib/state');
const { runRiotCheck, riotAvailable } = require('../lib/riot');

const BUDGET_MS = 50000;

module.exports = handler({
  async GET(req, res) {
    const secret = process.env.CRON_SECRET;
    if (!secret || bearer(req) !== secret) throw new HttpError(401, 'unauthorized');
    if (!riotAvailable()) return send(res, 200, { ok: true, skipped: 'RIOT_API_KEY が未設定です' });

    const started = Date.now();
    const uids = await redis.cmd('SMEMBERS', 'users');
    let checked = 0;
    let errors = 0;
    for (const uid of uids) {
      if (Date.now() - started > BUDGET_MS) break;
      try {
        const s = await loadAll(uid);
        if (!s.cfg.watched.length) continue;
        if (await runRiotCheck(uid, s.cfg, s.agent, s.riot)) checked++;
      } catch (e) {
        errors++;
        console.error('[cron]', uid, e.message);
      }
    }
    send(res, 200, { ok: true, users: uids.length, checked, errors, ms: Date.now() - started });
  },
});
