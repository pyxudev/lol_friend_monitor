'use strict';
/** PUT /api/settings  設定の部分更新 */

const { handler, send, readJson } = require('../lib/http');
const users = require('../lib/users');
const { redis } = require('../lib/redis');
const { resyncPresence } = require('../lib/core');

module.exports = handler({
  async PUT(req, res) {
    const { uid } = await users.authenticate(req, 'user');
    const patch = await readJson(req);
    const cfg = await users.loadCfg(uid);
    const beforeLolOnly = cfg.settings.lolOnly;
    users.applySettingsPatch(cfg.settings, patch);
    await users.saveCfg(uid, cfg);

    // 「在席」の定義が変わると全員が新規オンライン扱いになりかねないので基準を取り直す
    if (cfg.settings.lolOnly !== beforeLolOnly) {
      const agent = await redis.getJson(users.k.agent(uid));
      if (agent) await redis.setJson(users.k.agent(uid), resyncPresence(agent, cfg.settings));
    }
    send(res, 200, { settings: users.publicSettings(cfg.settings) });
  },
});
