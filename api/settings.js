'use strict';
/** PUT /api/settings  設定の部分更新 */

const { handler, send, readJson } = require('../lib/http');
const users = require('../lib/users');
const { redis } = require('../lib/redis');
const { resyncPresence } = require('../lib/core');
const { validateApiKey } = require('../lib/riot');
const { HttpError } = require('../lib/http');

module.exports = handler({
  async PUT(req, res) {
    const { uid } = await users.authenticate(req, 'user');
    const patch = await readJson(req);
    const cfg = await users.loadCfg(uid);
    const beforeLolOnly = cfg.settings.lolOnly;
    const beforeKey = cfg.settings.riotApiKey;
    users.applySettingsPatch(cfg.settings, patch);

    // 新しい Riot API キーは、保存する前に Riot に問い合わせて使えるか確かめる
    const keyChanged = cfg.settings.riotApiKey !== beforeKey;
    if (keyChanged && cfg.settings.riotApiKey) {
      const r = await validateApiKey(cfg.settings.riotApiKey, cfg.settings.riotPlatform);
      if (!r.ok) throw new HttpError(400, `Riot API キーを確認できませんでした: ${r.error}`);
    }
    await users.saveCfg(uid, cfg);

    // キーが変わったら前回の確認結果とエラーを捨て、次の取得ですぐ確認し直す（通知ログは残す）
    if (keyChanged) {
      const riot = await redis.getJson(users.k.riot(uid));
      if (riot) await redis.setJson(users.k.riot(uid), { ...riot, players: {}, lastRunAt: 0, lastError: null });
    }

    // 「在席」の定義が変わると全員が新規オンライン扱いになりかねないので基準を取り直す
    if (cfg.settings.lolOnly !== beforeLolOnly) {
      const agent = await redis.getJson(users.k.agent(uid));
      if (agent) await redis.setJson(users.k.agent(uid), resyncPresence(agent, cfg.settings));
    }
    send(res, 200, { settings: users.publicSettings(cfg.settings) });
  },
});
