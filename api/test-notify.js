'use strict';
/** POST /api/test-notify  テスト用アラートを返し、Discord が設定されていれば送信する */

const { handler, send } = require('../lib/http');
const { authenticate, loadCfg } = require('../lib/users');
const { postDiscord } = require('../lib/notify');

module.exports = handler({
  async POST(req, res) {
    const { uid } = await authenticate(req, 'user');
    const cfg = await loadCfg(uid);
    const alert = {
      id: `test-${Date.now()}`,
      key: 'test',
      displayName: 'テスト通知',
      icon: 0,
      availability: 'chat',
      gameStatus: 'outOfGame',
      inGame: false,
      lolOnline: true,
      productId: 'league_of_legends',
      productLabel: 'League of Legends',
      reason: 'online',
      source: 'test',
      statusMessage: '通知の動作確認です',
      at: new Date().toISOString(),
    };
    let discord = null;
    if (cfg.settings.discordWebhook) discord = await postDiscord(cfg.settings.discordWebhook, alert);
    send(res, 200, { ok: true, alert, discord });
  },
});
