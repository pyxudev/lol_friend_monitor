'use strict';
/**
 * POST   /api/watch          { key, name, tag }  監視リストに追加
 * DELETE /api/watch?key=...                      監視リストから削除
 */

const { handler, send, readJson, query, HttpError } = require('../lib/http');
const { authenticate, loadCfg, saveCfg, MAX_WATCHED, k } = require('../lib/users');
const { redis } = require('../lib/redis');

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

module.exports = handler({
  async POST(req, res) {
    const { uid } = await authenticate(req, 'user');
    const body = await readJson(req);
    const key = str(body.key, 128);
    if (!key) throw new HttpError(400, 'key が必要です');
    const cfg = await loadCfg(uid);
    if (!cfg.watched.some((w) => w.key === key)) {
      if (cfg.watched.length >= MAX_WATCHED) throw new HttpError(400, `監視できるのは ${MAX_WATCHED} 人までです`);
      // フレンド一覧から追加した場合はアイコンなどを引き継ぐ
      const agent = await redis.getJson(k.agent(uid));
      const f = agent && Array.isArray(agent.friends) ? agent.friends.find((x) => x.key === key) : null;
      cfg.watched.push({
        key,
        name: str(body.name || (f && f.gameName) || key, 64),
        tag: str(body.tag || (f && f.tagLine) || '', 16),
        icon: (f && f.icon) || 0,
        note: str(body.note, 100),
        addedAt: new Date().toISOString(),
      });
      await saveCfg(uid, cfg);
    }
    send(res, 200, { watched: cfg.watched });
  },

  async DELETE(req, res) {
    const { uid } = await authenticate(req, 'user');
    const key = query(req).get('key') || '';
    const cfg = await loadCfg(uid);
    const before = cfg.watched.length;
    cfg.watched = cfg.watched.filter((w) => w.key !== key);
    if (cfg.watched.length !== before) await saveCfg(uid, cfg);
    send(res, 200, { watched: cfg.watched });
  },
});
