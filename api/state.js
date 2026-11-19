'use strict';
/**
 * GET /api/state  ブラウザが定期的に取得する現在の状態。
 * エージェントが動いていなければ、ついでに Riot API のチェックも行う（間隔は riot.js で制御）。
 */

const { handler, send } = require('../lib/http');
const { authenticate } = require('../lib/users');
const { loadAll, publicState } = require('../lib/state');
const { runRiotCheck } = require('../lib/riot');

module.exports = handler({
  async GET(req, res) {
    const { uid } = await authenticate(req, 'user');
    const s = await loadAll(uid);
    try {
      const riot = await runRiotCheck(uid, s.cfg, s.agent, s.riot);
      if (riot) s.riot = riot;
    } catch (e) {
      console.error('[riot]', e.message);
    }
    send(res, 200, publicState(s));
  },
});
