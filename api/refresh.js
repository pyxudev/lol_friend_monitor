'use strict';
/** POST /api/refresh  Riot API のチェックを今すぐ実行する（エージェント稼働中は何もしない） */

const { handler, send } = require('../lib/http');
const { authenticate } = require('../lib/users');
const { loadAll, publicState } = require('../lib/state');
const { runRiotCheck } = require('../lib/riot');

module.exports = handler({
  async POST(req, res) {
    const { uid } = await authenticate(req, 'user');
    const s = await loadAll(uid);
    const riot = await runRiotCheck(uid, s.cfg, s.agent, s.riot, { force: true });
    if (riot) s.riot = riot;
    send(res, 200, publicState(s));
  },
});
