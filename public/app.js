'use strict';
/* LoL Friend Watcher — フロントエンド */

const $ = (sel) => document.querySelector(sel);

const el = {
  conn: $('#conn'), connText: $('#conn-text'), banner: $('#banner'),
  friends: $('#friends'), friendsEmpty: $('#friends-empty'), countFriends: $('#count-friends'),
  watched: $('#watched'), watchedEmpty: $('#watched-empty'), countWatched: $('#count-watched'),
  alerts: $('#alerts'), alertsEmpty: $('#alerts-empty'),
  search: $('#search'), filters: $('#filters'),
  btnPerm: $('#btn-perm'), btnRefresh: $('#btn-refresh'), btnSettings: $('#btn-settings'),
  btnTest: $('#btn-test'), btnManualAdd: $('#btn-manual-add'), manualName: $('#manual-name'),
  dlg: $('#dlg-settings'), toasts: $('#toasts'),
};

let S = { friends: [], watched: [], alerts: [], settings: {}, connected: false, mock: false, lastError: null };
let filter = 'all';
let query = '';

/* ------------------------------------------------------------ helpers */

const AVAIL_LABEL = { chat: 'オンライン', away: '離席中', dnd: '取り込み中', mobile: 'モバイル', offline: 'オフライン' };
const GAME_LABEL = {
  outOfGame: 'ロビー', inQueue: 'キュー中', championSelect: 'チャンピオン選択',
  inGame: 'ゲーム中', hosting_Custom: 'カスタム作成中', hosting_Practicetool: '練習ツール',
  spectating: '観戦中',
};

function iconUrl(id) {
  if (!id) return null;
  return `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/profile-icons/${id}.jpg`;
}

function timeAgo(iso) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)}分前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}時間前`;
  return new Date(iso).toLocaleDateString('ja-JP');
}

function avatarNode(icon, name) {
  if (icon) {
    const img = document.createElement('img');
    img.className = 'avatar';
    img.src = iconUrl(icon);
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => img.replaceWith(fallbackNode(name));
    return img;
  }
  return fallbackNode(name);
}

function fallbackNode(name) {
  const d = document.createElement('div');
  d.className = 'avatar-fallback';
  d.textContent = (name || '?').trim().charAt(0).toUpperCase();
  return d;
}

/* ------------------------------------------------------------- 通知系 */

let audioCtx = null;
function beep() {
  if (!S.settings.soundEnabled) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.25, now + i * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.14 + 0.22);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + i * 0.14);
      osc.stop(now + i * 0.14 + 0.25);
    });
  } catch (_) { /* 音が出せなくても続行 */ }
}

function desktopNotify(alert) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(`${alert.displayName} がオンラインです`, {
      body: [AVAIL_LABEL[alert.availability] || alert.availability,
             GAME_LABEL[alert.gameStatus] || '',
             alert.statusMessage].filter(Boolean).join(' · '),
      icon: iconUrl(alert.icon) || undefined,
      tag: `lolfw-${alert.key}`,
      renotify: false,
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (_) {}
}

function toast(title, sub, kind) {
  const d = document.createElement('div');
  d.className = `toast ${kind || ''}`;
  const icon = document.createElement('div');
  icon.className = 'alert-icon';
  icon.textContent = kind === 'err' ? '!' : (kind === 'info' ? 'i' : '✓');
  const body = document.createElement('div');
  const t = document.createElement('div'); t.className = 'toast-title'; t.textContent = title;
  body.appendChild(t);
  if (sub) { const s = document.createElement('div'); s.className = 'toast-sub'; s.textContent = sub; body.appendChild(s); }
  d.append(icon, body);
  el.toasts.appendChild(d);
  setTimeout(() => { d.classList.add('out'); setTimeout(() => d.remove(), 320); }, 6000);
}

function handleAlert(alert) {
  toast(`${alert.displayName} がオンラインになりました`,
        [AVAIL_LABEL[alert.availability], GAME_LABEL[alert.gameStatus]].filter(Boolean).join(' · '));
  desktopNotify(alert);
  beep();
  S.alerts = [alert, ...S.alerts].slice(0, 50);
  renderAlerts();
}

/* --------------------------------------------------------------- 描画 */

function render() {
  renderConn();
  renderFriends();
  renderWatched();
  renderAlerts();
}

function renderConn() {
  el.conn.className = 'conn ' + (S.mock ? 'conn-mock' : (S.connected ? 'conn-on' : 'conn-off'));
  el.connText.textContent = S.mock
    ? 'モックモード（デモデータ）'
    : (S.connected ? 'League クライアントに接続中' : '未接続');

  if (!S.connected && S.lastError) {
    el.banner.hidden = false;
    el.banner.className = 'banner';
    el.banner.textContent = `${S.lastError} — League クライアントを起動してログインすると自動で接続します。`;
  } else if (S.mock) {
    el.banner.hidden = false;
    el.banner.className = 'banner info';
    el.banner.textContent = 'モックモードで動作中です。実データを使うには League クライアントを起動した PC で `npm start` を実行してください。';
  } else {
    el.banner.hidden = true;
  }
}

function matchFilter(f) {
  if (query && !f.displayName.toLowerCase().includes(query)) return false;
  if (filter === 'online') return f.online;
  if (filter === 'ingame') return f.gameStatus === 'inGame' || f.gameStatus === 'championSelect';
  if (filter === 'watched') return isWatched(f.key);
  return true;
}

function isWatched(key) { return S.watched.some((w) => w.key === key); }

function renderFriends() {
  const list = S.friends.filter(matchFilter);
  el.countFriends.textContent = `${S.friends.filter((f) => f.online).length} / ${S.friends.length}`;
  el.friends.textContent = '';

  if (!list.length) {
    el.friendsEmpty.hidden = false;
    el.friendsEmpty.textContent = S.friends.length
      ? '条件に合うフレンドがいません。'
      : (S.connected ? 'フレンドが見つかりませんでした。' : 'League クライアントに接続するとフレンドが表示されます。');
    return;
  }
  el.friendsEmpty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const f of list) frag.appendChild(friendRow(f));
  el.friends.appendChild(frag);
}

function friendRow(f) {
  const row = document.createElement('div');
  row.className = 'row' + (f.online ? '' : ' is-offline');

  const wrap = document.createElement('div');
  wrap.className = 'avatar-wrap';
  wrap.appendChild(avatarNode(f.icon, f.gameName));
  const pres = document.createElement('span');
  pres.className = `pres pres-${f.availability}`;
  pres.title = AVAIL_LABEL[f.availability] || f.availability;
  wrap.appendChild(pres);

  const main = document.createElement('div');
  main.className = 'row-main';
  const nameLine = document.createElement('div');
  nameLine.className = 'row-name';
  const nm = document.createElement('span'); nm.textContent = f.gameName;
  nameLine.appendChild(nm);
  if (f.tagLine) { const tg = document.createElement('span'); tg.className = 'row-tag'; tg.textContent = `#${f.tagLine}`; nameLine.appendChild(tg); }

  const sub = document.createElement('div');
  sub.className = 'row-sub';
  const st = document.createElement('span');
  st.className = 'st' + (f.gameStatus === 'inGame' ? ' st-ingame' : (f.gameStatus === 'inQueue' || f.gameStatus === 'championSelect' ? ' st-queue' : ''));
  st.textContent = f.online ? (GAME_LABEL[f.gameStatus] || AVAIL_LABEL[f.availability] || f.availability) : 'オフライン';
  sub.appendChild(st);
  const extra = [f.level ? `Lv.${f.level}` : '', f.statusMessage, f.groupName].filter(Boolean).join(' · ');
  if (extra) { const e = document.createElement('span'); e.textContent = ' · ' + extra; sub.appendChild(e); }

  main.append(nameLine, sub);

  const star = document.createElement('button');
  star.className = 'star' + (isWatched(f.key) ? ' on' : '');
  star.textContent = isWatched(f.key) ? '★' : '☆';
  star.title = isWatched(f.key) ? '監視を解除' : 'オンライン時に通知する';
  star.onclick = () => toggleWatch(f);

  row.append(wrap, main, star);
  return row;
}

function renderWatched() {
  el.countWatched.textContent = String(S.watched.length);
  el.watched.textContent = '';
  el.watchedEmpty.hidden = S.watched.length > 0;

  const frag = document.createDocumentFragment();
  for (const w of S.watched) {
    const live = S.friends.find((f) => f.key === w.key);
    const row = document.createElement('div');
    row.className = 'row' + (live && live.online ? '' : ' is-offline');

    const wrap = document.createElement('div');
    wrap.className = 'avatar-wrap';
    wrap.appendChild(avatarNode((live && live.icon) || w.icon, w.name));
    const pres = document.createElement('span');
    pres.className = `pres pres-${live ? live.availability : 'offline'}`;
    wrap.appendChild(pres);

    const main = document.createElement('div');
    main.className = 'row-main';
    const nameLine = document.createElement('div');
    nameLine.className = 'row-name';
    const nm = document.createElement('span'); nm.textContent = w.name;
    nameLine.appendChild(nm);
    if (w.tag) { const tg = document.createElement('span'); tg.className = 'row-tag'; tg.textContent = `#${w.tag}`; nameLine.appendChild(tg); }
    const sub = document.createElement('div');
    sub.className = 'row-sub';
    sub.textContent = live
      ? (live.online ? (GAME_LABEL[live.gameStatus] || AVAIL_LABEL[live.availability]) : 'オフライン')
      : 'フレンドリストに未確認';
    main.append(nameLine, sub);

    const del = document.createElement('button');
    del.className = 'row-remove';
    del.textContent = '✕';
    del.title = '監視を解除';
    del.onclick = () => removeWatch(w.key);

    row.append(wrap, main, del);
    frag.appendChild(row);
  }
  el.watched.appendChild(frag);
}

function renderAlerts() {
  el.alerts.textContent = '';
  el.alertsEmpty.hidden = S.alerts.length > 0;
  const frag = document.createDocumentFragment();
  for (const a of S.alerts.slice(0, 30)) {
    const row = document.createElement('div');
    row.className = 'alert-row';
    const ic = document.createElement('div'); ic.className = 'alert-icon'; ic.textContent = '✓';
    const tx = document.createElement('div'); tx.className = 'alert-text'; tx.textContent = `${a.displayName} がオンライン`;
    const tm = document.createElement('div'); tm.className = 'alert-time'; tm.textContent = timeAgo(a.at);
    row.append(ic, tx, tm);
    frag.appendChild(row);
  }
  el.alerts.appendChild(frag);
}

/* ---------------------------------------------------------- API 呼び出し */

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

async function toggleWatch(f) {
  try {
    if (isWatched(f.key)) {
      await api(`/api/watch/${encodeURIComponent(f.key)}`, { method: 'DELETE' });
      S.watched = S.watched.filter((w) => w.key !== f.key);
    } else {
      const r = await api('/api/watch', {
        method: 'POST',
        body: JSON.stringify({ key: f.key, name: f.gameName, tag: f.tagLine }),
      });
      S.watched = r.watched;
      toast(`${f.displayName} を監視リストに追加しました`, 'オンラインになると通知します', 'info');
    }
    renderFriends(); renderWatched();
  } catch (e) { toast('操作に失敗しました', e.message, 'err'); }
}

async function removeWatch(key) {
  try {
    await api(`/api/watch/${encodeURIComponent(key)}`, { method: 'DELETE' });
    S.watched = S.watched.filter((w) => w.key !== key);
    renderFriends(); renderWatched();
  } catch (e) { toast('削除に失敗しました', e.message, 'err'); }
}

async function manualAdd() {
  const raw = el.manualName.value.trim();
  if (!raw) return;
  const [name, tag = ''] = raw.split('#');
  const key = `${name.trim()}#${tag.trim()}`.toLowerCase();
  try {
    const r = await api('/api/watch', { method: 'POST', body: JSON.stringify({ key, name: name.trim(), tag: tag.trim() }) });
    S.watched = r.watched;
    el.manualName.value = '';
    renderWatched(); renderFriends();
    toast(`${raw} を追加しました`, 'フレンドリスト上の名前と一致すると通知されます', 'info');
  } catch (e) { toast('追加に失敗しました', e.message, 'err'); }
}

/* ------------------------------------------------------------- 設定 UI */

function openSettings() {
  $('#set-interval').value = Math.round((S.settings.pollIntervalMs || 5000) / 1000);
  $('#set-quiet').value = S.settings.quietMinutes ?? 10;
  $('#set-away').checked = !!S.settings.notifyAwayAsOnline;
  $('#set-sound').checked = !!S.settings.soundEnabled;
  $('#set-webhook').value = '';
  $('#set-webhook').placeholder = S.settings.discordWebhook ? '(設定済み — 変更する場合のみ入力)' : 'https://discord.com/api/webhooks/…';
  el.dlg.showModal();
}

el.dlg.addEventListener('close', async () => {
  if (el.dlg.returnValue !== 'save') return;
  const patch = {
    pollIntervalMs: Number($('#set-interval').value) * 1000,
    quietMinutes: Number($('#set-quiet').value),
    notifyAwayAsOnline: $('#set-away').checked,
    soundEnabled: $('#set-sound').checked,
  };
  const hook = $('#set-webhook').value.trim();
  if (hook) patch.discordWebhook = hook;
  try {
    const r = await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
    S.settings = r.settings;
    toast('設定を保存しました', null, 'info');
  } catch (e) { toast('保存に失敗しました', e.message, 'err'); }
});

/* ------------------------------------------------------------ イベント */

el.search.addEventListener('input', () => { query = el.search.value.trim().toLowerCase(); renderFriends(); });

el.filters.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.chip');
  if (!btn) return;
  filter = btn.dataset.filter;
  el.filters.querySelectorAll('.chip').forEach((c) => c.classList.toggle('chip-on', c === btn));
  renderFriends();
});

el.btnSettings.onclick = openSettings;
el.btnRefresh.onclick = async () => { try { await api('/api/refresh', { method: 'POST' }); } catch (_) {} };
el.btnTest.onclick = async () => { try { await api('/api/test-notify', { method: 'POST' }); } catch (e) { toast('テストに失敗', e.message, 'err'); } };
el.btnManualAdd.onclick = manualAdd;
el.manualName.addEventListener('keydown', (e) => { if (e.key === 'Enter') manualAdd(); });

el.btnPerm.onclick = async () => {
  const p = await Notification.requestPermission();
  syncNotifyButton();
  if (p === 'granted') toast('デスクトップ通知を有効にしました', null, 'info');
};

function syncNotifyButton() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    el.btnPerm.hidden = false;
    el.btnPerm.textContent = '通知を許可';
    el.btnPerm.disabled = false;
  } else if (Notification.permission === 'denied') {
    el.btnPerm.hidden = false;
    el.btnPerm.textContent = '通知がブロック中';
    el.btnPerm.title = 'ブラウザのアドレスバーのサイト設定からこのページの通知を許可してください。画面内のトーストと通知音は引き続き動作します。';
    el.btnPerm.disabled = true;
  } else {
    el.btnPerm.hidden = true;
  }
}
syncNotifyButton();

/* ---------------------------------------------------------------- SSE */

function connect() {
  const es = new EventSource('/api/events');

  es.addEventListener('state', (ev) => {
    const data = JSON.parse(ev.data);
    S = { ...S, ...data };
    render();
  });

  es.addEventListener('alert', (ev) => handleAlert(JSON.parse(ev.data)));

  es.onerror = () => {
    el.conn.className = 'conn conn-off';
    el.connText.textContent = 'サーバーに再接続中…';
    // EventSource は自動再接続するのでここでは閉じない
  };
}

setInterval(renderAlerts, 30000); // 「〜分前」表示を更新
connect();
