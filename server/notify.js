'use strict';
/** Discord Webhook へのサーバーサイド通知（ブラウザを閉じていても届く） */

const https = require('https');
const { URL } = require('url');

function postDiscord(webhookUrl, alert) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(webhookUrl);
    } catch (_) {
      return resolve({ ok: false, error: 'Webhook URL が不正です' });
    }
    if (u.protocol !== 'https:') return resolve({ ok: false, error: 'https のみ対応しています' });

    const statusLabel = {
      chat: 'オンライン',
      away: '離席中',
      dnd: 'ゲーム中',
      mobile: 'モバイル',
    }[alert.availability] || alert.availability;

    const gameLabel = {
      outOfGame: 'ロビー',
      inQueue: 'キュー中',
      championSelect: 'チャンピオン選択',
      inGame: 'ゲーム中',
      spectating: '観戦中',
      hosting_Custom: 'カスタム作成中',
      hosting_Practicetool: '練習ツール',
    }[alert.gameStatus] || alert.gameStatus || '';

    const where = alert.lolOnline === false && alert.productLabel
      ? alert.productLabel
      : 'LoL';
    const title = alert.inGame
      ? `${alert.displayName} が ${where} でゲーム中です`
      : `${alert.displayName} が ${where} でオンラインになりました`;

    const payload = JSON.stringify({
      username: 'LoL Friend Watcher',
      embeds: [{
        title,
        description: [
          `状態: **${statusLabel}**`,
          gameLabel ? `ゲーム: ${gameLabel}` : null,
          alert.statusMessage ? `ステータス: ${alert.statusMessage}` : null,
        ].filter(Boolean).join('\n'),
        color: alert.inGame ? 0xef4444 : 0x3b82f6,
        timestamp: new Date(alert.at).toISOString(),
      }],
    });

    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 8000,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode }));
    });

    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(payload);
    req.end();
  });
}

module.exports = { postDiscord };
