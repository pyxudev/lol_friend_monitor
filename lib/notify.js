'use strict';
/** Discord Webhook へのサーバーサイド通知（ブラウザを閉じていても届く） */

const { isDiscordWebhook } = require('./users');

const STATUS_LABEL = { chat: 'オンライン', away: '離席中', dnd: 'ゲーム中', mobile: 'モバイル' };
const GAME_LABEL = {
  outOfGame: 'ロビー',
  inQueue: 'キュー中',
  championSelect: 'チャンピオン選択',
  inGame: 'ゲーム中',
  spectating: '観戦中',
  hosting_Custom: 'カスタム作成中',
  hosting_Practicetool: '練習ツール',
};

async function postDiscord(webhookUrl, alert) {
  if (!isDiscordWebhook(webhookUrl)) return { ok: false, error: 'Webhook URL が不正です' };

  const statusLabel = STATUS_LABEL[alert.availability] || alert.availability;
  const gameLabel = GAME_LABEL[alert.gameStatus] || alert.gameStatus || '';
  const where = alert.lolOnline === false && alert.productLabel ? alert.productLabel : 'LoL';
  const title = alert.inGame
    ? `${alert.displayName} が ${where} でゲーム中です`
    : `${alert.displayName} が ${where} でオンラインになりました`;

  const payload = {
    username: 'LoL Friend Watcher',
    embeds: [{
      title,
      description: [
        alert.source === 'riot' ? null : `状態: **${statusLabel}**`,
        gameLabel ? `ゲーム: ${gameLabel}` : null,
        alert.statusMessage ? `${alert.source === 'riot' ? 'キュー' : 'ステータス'}: ${alert.statusMessage}` : null,
        alert.source === 'riot' ? '（Riot API で検知）' : null,
      ].filter(Boolean).join('\n'),
      color: alert.inGame ? 0xef4444 : 0x3b82f6,
      timestamp: new Date(alert.at).toISOString(),
    }],
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 複数アラートをまとめて送る（失敗はログのみ） */
async function notifyAll(settings, alerts) {
  if (!settings.discordWebhook || !alerts.length) return;
  for (const a of alerts) {
    const r = await postDiscord(settings.discordWebhook, a);
    if (!r.ok) console.error('[discord] 送信失敗:', r.error || r.status);
  }
}

module.exports = { postDiscord, notifyAll };
