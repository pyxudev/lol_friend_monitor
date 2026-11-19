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
  app: $('#app'), onboard: $('#onboard'),
};

/** 公開リポジトリ（エージェントの配布元） */
const AGENT_REPO = 'pyxudev/lol_frend_monitor';
const POLL_MS = 5000;
const TOKEN_KEY = 'lfw.token';

let S = {
  friends: [], watched: [], alerts: [], settings: {}, me: null,
  agent: { alive: false, connected: false, mock: false, error: null },
  riot: { available: false, enabled: false, active: false, players: {} },
};
let filter = 'all';
let query = '';

/* ------------------------------------------------------------ helpers */

const AVAIL_LABEL = { chat: 'オンライン', away: '離席中', dnd: '取り込み中', mobile: 'モバイル', offline: 'オフライン' };
const GAME_LABEL = {
  outOfGame: 'ロビー', inQueue: 'キュー中', championSelect: 'チャンピオン選択',
  inGame: 'ゲーム中', hosting_Custom: 'カスタム作成中', hosting_Practicetool: '練習ツール',
  spectating: '観戦中',
};
const PRODUCT_LABEL = {
  league_of_legends: 'League of Legends', valorant: 'VALORANT',
  bacon: 'Legends of Runeterra', wildrift: 'ワイルドリフト',
  riot: 'Riot クライアント', '2xko': '2XKO',
};

/** 一覧で使う状態ラベル */
function statusLabel(f) {
  if (!f.online) return 'オフライン';
  if (f.lolOnline) return GAME_LABEL[f.gameStatus] || AVAIL_LABEL[f.availability] || f.availability;
  // LoL 以外の在席（通知対象外）は、どこに居るのかを出す
  const prod = f.productLabel || PRODUCT_LABEL[f.productId] || '他タイトル';
  return `${prod}（LoL 外）`;
}

/** アラートの見出し */
function alertTitle(a) {
  const where = a.lolOnline === false
    ? (a.productLabel || PRODUCT_LABEL[a.productId] || '他タイトル')
    : 'LoL';
  return a.inGame
    ? `${a.displayName} が ${where} でゲーム中です`
    : `${a.displayName} が ${where} でオンラインになりました`;
}

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
    const n = new Notification(alertTitle(alert), {
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
  toast(alertTitle(alert),
        [AVAIL_LABEL[alert.availability], GAME_LABEL[alert.gameStatus]].filter(Boolean).join(' · '),
        alert.inGame ? '' : 'info');
  desktopNotify(alert);
  beep();
}

/* --------------------------------------------------------------- 描画 */

function render() {
  renderConn();
  renderFriends();
  renderWatched();
  renderAlerts();
}

function setBanner(text, kind) {
  el.banner.hidden = !text;
  el.banner.className = 'banner' + (kind ? ` ${kind}` : '');
  el.banner.textContent = text || '';
}

function renderConn() {
  const a = S.agent;
  const r = S.riot;
  let cls = 'conn-off';
  let text = '未接続';
  if (a.connected) {
    cls = a.mock ? 'conn-mock' : 'conn-on';
    text = a.mock ? 'モックエージェント（デモデータ）' : 'League クライアントに接続中';
  } else if (r.active) {
    cls = 'conn-riot';
    text = 'Riot API で試合を監視中';
  } else if (a.alive) {
    text = 'エージェント稼働中（クライアント未起動）';
  }
  el.conn.className = `conn ${cls}`;
  el.connText.textContent = text;

  const riotNote = r.active ? ' それまでは Riot API で監視中のプレイヤーの試合開始だけを検知します（約 1 分間隔）。' : '';
  if (a.connected && a.mock) {
    setBanner('モックエージェントのデモデータを表示しています。実データを使うには League クライアントを起動した PC で --mock を付けずにエージェントを起動してください。', 'info');
  } else if (a.connected) {
    setBanner(r.lastError && r.active ? `Riot API: ${r.lastError}` : '');
  } else if (a.alive) {
    setBanner(`${a.error || 'League クライアントに接続できません'} — League クライアントを起動してログインすると自動で接続します。${riotNote}`);
  } else {
    setBanner(`エージェントが動いていません。フレンド一覧とオンライン通知には、League クライアントを起動する PC でエージェントを動かす必要があります（右上の「設定」→「エージェント」）。${riotNote}`
      + (r.active && r.lastError ? ` [Riot API: ${r.lastError}]` : ''), 'info');
  }
}

function matchFilter(f) {
  if (query && !f.displayName.toLowerCase().includes(query)) return false;
  if (filter === 'online') return f.online;
  if (filter === 'lol') return f.lolOnline;
  if (filter === 'ingame') return f.inGame;
  if (filter === 'watched') return isWatched(f.key);
  return true;
}

function isWatched(key) { return S.watched.some((w) => w.key === key); }

function renderFriends() {
  const list = S.friends.filter(matchFilter);
  el.countFriends.textContent = `LoL ${S.friends.filter((f) => f.lolOnline).length} / 全${S.friends.length}`;
  el.friends.textContent = '';

  if (!list.length) {
    el.friendsEmpty.hidden = false;
    el.friendsEmpty.textContent = S.friends.length
      ? '条件に合うフレンドがいません。'
      : (S.agent.connected ? 'フレンドが見つかりませんでした。' : 'エージェントが League クライアントに接続するとフレンドが表示されます。');
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
  st.className = 'st' + (!f.online || !f.lolOnline ? ' st-other'
    : (f.gameStatus === 'inGame' || f.gameStatus === 'spectating' ? ' st-ingame'
      : (f.inGame ? ' st-queue' : '')));
  st.textContent = statusLabel(f);
  sub.appendChild(st);
  const extra = [f.level ? `Lv.${f.level}` : '', f.statusMessage, f.groupName].filter(Boolean).join(' · ');
  if (extra) { const e = document.createElement('span'); e.textContent = ' · ' + extra; sub.appendChild(e); }

  main.append(nameLine, sub);

  const star = document.createElement('button');
  star.className = 'star' + (isWatched(f.key) ? ' on' : '');
  star.textContent = isWatched(f.key) ? '★' : '☆';
  star.title = isWatched(f.key) ? '監視を解除' : 'LoL でオンラインになったら通知する';
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
    const rp = S.riot.players && S.riot.players[w.key];
    if (live) {
      sub.textContent = statusLabel(live);
    } else if (S.riot.active && rp) {
      const st = document.createElement('span');
      st.className = 'st' + (rp.inGame ? ' st-ingame' : ' st-other');
      st.textContent = rp.error ? rp.error
        : (rp.inGame ? `試合中${rp.queue ? `（${rp.queue}）` : ''}${rp.startedAt ? ` · ${timeAgo(new Date(rp.startedAt).toISOString()).replace('前', '')}経過` : ''}` : '試合していない');
      const src = document.createElement('span'); src.className = 'src-badge'; src.textContent = 'Riot API';
      sub.append(st, src);
    } else if (S.riot.active && !w.tag) {
      sub.textContent = 'タグが無いため Riot API で確認できません';
    } else {
      sub.textContent = S.agent.connected ? 'フレンドリストに未確認' : '状態不明（エージェント停止中）';
    }
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
    const tx = document.createElement('div'); tx.className = 'alert-text';
    tx.textContent = a.source === 'riot'
      ? `${a.displayName} が試合開始${a.statusMessage ? `（${a.statusMessage}）` : ''}`
      : (a.inGame
        ? `${a.displayName} がゲーム中（${GAME_LABEL[a.gameStatus] || a.gameStatus}）`
        : `${a.displayName} が ${a.lolOnline === false ? (a.productLabel || '他タイトル') : 'LoL'} でオンライン`);
    if (a.source === 'riot') { const b = document.createElement('span'); b.className = 'src-badge'; b.textContent = 'Riot API'; tx.appendChild(b); }
    const tm = document.createElement('div'); tm.className = 'alert-time'; tm.textContent = timeAgo(a.at);
    row.append(ic, tx, tm);
    frag.appendChild(row);
  }
  el.alerts.appendChild(frag);
}

/* ---------------------------------------------------------- API 呼び出し */

function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } }
function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (_) {} }

async function api(path, opts = {}) {
  const token = opts.token !== undefined ? opts.token : getToken();
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 401 && token && opts.token === undefined) {
    logout('ログインの有効期限が切れたか、アカウントが削除されました');
    throw new Error('ログインが必要です');
  }
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
      await api(`/api/watch?key=${encodeURIComponent(f.key)}`, { method: 'DELETE' });
      S.watched = S.watched.filter((w) => w.key !== f.key);
    } else {
      const r = await api('/api/watch', {
        method: 'POST',
        body: JSON.stringify({ key: f.key, name: f.gameName, tag: f.tagLine }),
      });
      S.watched = r.watched;
      toast(`${f.displayName} を監視リストに追加しました`, 'LoL でオンラインになると通知します', 'info');
    }
    renderFriends(); renderWatched();
  } catch (e) { toast('操作に失敗しました', e.message, 'err'); }
}

async function removeWatch(key) {
  try {
    await api(`/api/watch?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
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
    toast(`${raw} を追加しました`, tag.trim()
      ? 'フレンドリスト上の名前と一致したとき、またはエージェント停止中は Riot API で試合開始を検知したときに通知します'
      : 'タグ（#以降）が無いと Riot API での検知はできません', 'info');
  } catch (e) { toast('追加に失敗しました', e.message, 'err'); }
}

/* ------------------------------------------------------------- 設定 UI */

let account = null;

function agentCommands() {
  const tok = (account && account.agentToken) || '<エージェントトークン>';
  const args = `--server ${location.origin} --token ${tok}`;
  return {
    npx: `npx -y github:${AGENT_REPO} ${args}`,
    clone: `git clone https://github.com/${AGENT_REPO}.git\ncd ${AGENT_REPO.split('/')[1]}\nnpm run agent -- ${args}`,
  };
}

function renderAgentCommands() {
  const c = agentCommands();
  $('#agent-cmd').textContent = c.npx;
  $('#agent-cmd-clone').textContent = c.clone;
}

async function copyText(text, label) {
  try { await navigator.clipboard.writeText(text); toast(`${label}をコピーしました`, null, 'info'); }
  catch (_) { toast('コピーできませんでした', '手動で選択してコピーしてください', 'err'); }
}

async function openSettings() {
  $('#set-interval').value = Math.round((S.settings.pollIntervalMs || 5000) / 1000);
  $('#set-quiet').value = S.settings.quietMinutes ?? 10;
  $('#set-lolonly').checked = S.settings.lolOnly !== false;
  $('#set-away').checked = !!S.settings.notifyAwayAsOnline;
  $('#set-sound').checked = !!S.settings.soundEnabled;
  $('#set-webhook').value = '';
  $('#set-webhook').placeholder = S.settings.discordWebhook ? '(設定済み — 変更する場合のみ入力)' : 'https://discord.com/api/webhooks/…';
  $('#set-riot').checked = S.settings.riotEnabled !== false;
  $('#set-platform').value = S.settings.riotPlatform || 'jp1';
  $('#set-riot').disabled = !S.riot.available;
  $('#riot-note').textContent = S.riot.available
    ? '監視リストの Riot ID が試合を開始したら通知します（約 1 分間隔。ロビー・キュー中は検知できません）。ブラウザを閉じていても検知するには、運営者が /api/cron を定期実行する設定をしている必要があります。'
    : 'このサーバーには Riot API キー（RIOT_API_KEY）が設定されていないため利用できません。';
  $('#user-token').value = getToken();
  renderAgentCommands();
  el.dlg.showModal();
  try {
    account = await api('/api/account');
    renderAgentCommands();
  } catch (_) {}
}

$('#btn-copy-agent').onclick = () => copyText(agentCommands().npx, 'コマンド');
$('#btn-copy-user').onclick = () => copyText(getToken(), 'ユーザートークン');
$('#btn-rotate-agent').onclick = async () => {
  if (!confirm('エージェントトークンを再発行しますか？\n今動いているエージェントは停止するので、新しいトークンで起動し直す必要があります。')) return;
  try {
    const r = await api('/api/agent/token', { method: 'POST' });
    account = { ...(account || {}), agentToken: r.agentToken };
    renderAgentCommands();
    toast('エージェントトークンを再発行しました', null, 'info');
  } catch (e) { toast('再発行に失敗しました', e.message, 'err'); }
};
$('#btn-logout').onclick = () => {
  if (!confirm('ログアウトしますか？\nユーザートークンを控えていないと、このアカウントに戻れなくなります。')) return;
  el.dlg.close();
  logout();
};
$('#btn-delete').onclick = async () => {
  if (!confirm('アカウントを削除しますか？\n監視リスト・設定・通知ログがすべて削除され、元に戻せません。')) return;
  try {
    await api('/api/account', { method: 'DELETE' });
    el.dlg.close();
    logout('アカウントを削除しました');
  } catch (e) { toast('削除に失敗しました', e.message, 'err'); }
};

el.dlg.addEventListener('close', async () => {
  if (el.dlg.returnValue !== 'save') return;
  const patch = {
    pollIntervalMs: Number($('#set-interval').value) * 1000,
    quietMinutes: Number($('#set-quiet').value),
    lolOnly: $('#set-lolonly').checked,
    notifyAwayAsOnline: $('#set-away').checked,
    soundEnabled: $('#set-sound').checked,
    riotPlatform: $('#set-platform').value,
  };
  if (!$('#set-riot').disabled) patch.riotEnabled = $('#set-riot').checked;
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
el.btnRefresh.onclick = async () => {
  try { applyState(await api('/api/refresh', { method: 'POST' })); } catch (e) { toast('更新に失敗しました', e.message, 'err'); }
};
el.btnTest.onclick = async () => {
  try {
    const r = await api('/api/test-notify', { method: 'POST' });
    handleAlert(r.alert);
    if (r.discord && !r.discord.ok) toast('Discord への送信に失敗しました', r.discord.error || `HTTP ${r.discord.status}`, 'err');
  } catch (e) { toast('テストに失敗', e.message, 'err'); }
};
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

/* ------------------------------------------------- 状態の取得（ポーリング） */

const seenAlerts = new Set();
let firstState = true;

function applyState(data) {
  // 新しいアラートだけ通知する（初回取得分は既読扱い）
  for (const a of [...(data.alerts || [])].reverse()) {
    if (seenAlerts.has(a.id)) continue;
    seenAlerts.add(a.id);
    if (!firstState) handleAlert(a);
  }
  firstState = false;
  S = { ...S, ...data };
  render();
}

let pollTimer = null;
async function pollState() {
  clearTimeout(pollTimer);
  try {
    applyState(await api('/api/state'));
  } catch (e) {
    if (!getToken()) return;
    el.conn.className = 'conn conn-off';
    el.connText.textContent = 'サーバーに再接続中…';
  }
  if (getToken()) pollTimer = setTimeout(pollState, POLL_MS);
}

/* ---------------------------------------------------------- ログイン */

function showApp(loggedIn) {
  el.app.hidden = !loggedIn;
  el.onboard.hidden = loggedIn;
  el.btnSettings.hidden = !loggedIn;
  el.btnRefresh.hidden = !loggedIn;
  if (!loggedIn) {
    el.banner.hidden = true;
    el.conn.className = 'conn conn-off';
    el.connText.textContent = '未ログイン';
  }
}

function start() {
  showApp(true);
  firstState = true;
  seenAlerts.clear();
  pollState();
}

function logout(message) {
  setToken('');
  clearTimeout(pollTimer);
  account = null;
  S = { ...S, friends: [], watched: [], alerts: [] };
  showApp(false);
  if (message) toast(message, null, 'info');
}

$('#btn-create').onclick = async () => {
  try {
    const r = await api('/api/account', { method: 'POST', token: '' });
    setToken(r.userToken);
    account = { agentToken: r.agentToken };
    start();
    toast('アカウントを作成しました', '次に「設定」→「エージェント」のコマンドを PC で実行してください', 'info');
    setTimeout(openSettings, 400);
  } catch (e) { toast('作成に失敗しました', e.message, 'err'); }
};

async function login() {
  const t = $('#login-token').value.trim();
  if (!t) return;
  try {
    await api('/api/account', { token: t });
    setToken(t);
    $('#login-token').value = '';
    start();
  } catch (e) { toast('ログインに失敗しました', e.message, 'err'); }
}
$('#btn-login').onclick = login;
$('#login-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });

setInterval(renderAlerts, 30000); // 「〜分前」表示を更新
if (getToken()) start(); else showApp(false);
