'use strict';
/** 監視対象プレイヤーと設定を data/config.json に永続化する */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  watched: [],          // [{ key, name, tag, icon, note, addedAt }]
  settings: {
    pollIntervalMs: 5000,
    discordWebhook: '',       // 空ならサーバー側通知は無効
    lolOnly: true,            // LoL でオンラインのときだけ通知する
                              // （Riot クライアントのみ / VALORANT などは無視）
    notifyAwayAsOnline: true, // away / dnd もオンライン扱いにする
                              // （false でもゲーム中は常に通知する）
    soundEnabled: true,
    quietMinutes: 10,         // 同一プレイヤーへの再通知を抑制する分数
  },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

class Store {
  constructor() {
    this.state = clone(DEFAULTS);
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(FILE, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = {
        watched: Array.isArray(parsed.watched) ? parsed.watched : [],
        settings: { ...DEFAULTS.settings, ...(parsed.settings || {}) },
      };
    } catch (_) {
      this.state = clone(DEFAULTS);
    }
  }

  save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (e) {
      console.error('[store] 保存に失敗しました:', e.message);
    }
  }

  get watched() { return this.state.watched; }
  get settings() { return this.state.settings; }

  isWatched(key) { return this.state.watched.some((w) => w.key === key); }

  addWatch(entry) {
    if (!entry || !entry.key) throw new Error('key が必要です');
    if (this.isWatched(entry.key)) return this.state.watched;
    this.state.watched.push({
      key: entry.key,
      name: entry.name || entry.key,
      tag: entry.tag || '',
      icon: entry.icon || 0,
      note: entry.note || '',
      addedAt: new Date().toISOString(),
    });
    this.save();
    return this.state.watched;
  }

  removeWatch(key) {
    const before = this.state.watched.length;
    this.state.watched = this.state.watched.filter((w) => w.key !== key);
    if (this.state.watched.length !== before) this.save();
    return this.state.watched;
  }

  updateSettings(patch) {
    const s = this.state.settings;
    if (patch.pollIntervalMs !== undefined) {
      const v = Number(patch.pollIntervalMs);
      if (Number.isFinite(v)) s.pollIntervalMs = Math.min(60000, Math.max(2000, Math.round(v)));
    }
    if (patch.discordWebhook !== undefined) s.discordWebhook = String(patch.discordWebhook || '').trim();
    if (patch.lolOnly !== undefined) s.lolOnly = !!patch.lolOnly;
    if (patch.notifyAwayAsOnline !== undefined) s.notifyAwayAsOnline = !!patch.notifyAwayAsOnline;
    if (patch.soundEnabled !== undefined) s.soundEnabled = !!patch.soundEnabled;
    if (patch.quietMinutes !== undefined) {
      const v = Number(patch.quietMinutes);
      if (Number.isFinite(v)) s.quietMinutes = Math.min(600, Math.max(0, Math.round(v)));
    }
    this.save();
    return s;
  }
}

module.exports = { Store };
