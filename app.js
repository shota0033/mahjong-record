'use strict';

const APP_VERSION = '1.0.0';
const DATA_KEY = 'mjr.data.v1';
const DATA_PREV_KEY = 'mjr.data.v1.prev';
const SETTINGS_KEY = 'mjr.settings.v1';

const TYPES = { set: 'セット', onRateFree: 'オンレートフリー', noRateFree: 'ノーレートフリー' };
// 順位点（Mリーグ準拠 + 同点時）
const RANK_POINTS = { 1: 50, 1.5: 30, 2: 10, 2.5: 0, 3: -10, 3.5: -20, 4: -30 };
const RANK_LABELS = { 1: '1着', 1.5: '1-2着同点', 2: '2着', 2.5: '2-3着同点', 3: '3着', 3.5: '3-4着同点', 4: '4着' };
const RANKS = [1, 1.5, 2, 2.5, 3, 3.5, 4];
const WEEKDAYS = '日月火水木金土';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- utils ----------
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function nowIso() { return new Date().toISOString(); }
function pad(n) { return String(n).padStart(2, '0'); }
function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayStr() { return dateStr(new Date()); }
function fmtDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return `${y}/${m}/${d}(${WEEKDAYS[new Date(y, m - 1, d).getDay()]})`;
}
function toHalfWidth(s) {
  return s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[－ー−]/g, '-');
}
function parseIntStrict(s) {
  s = toHalfWidth(String(s)).replace(/[,\s]/g, '');
  if (!/^-?\d+$/.test(s)) return null;
  return parseInt(s, 10);
}
// ポイント = (素点 - 30000) / 1000 + 順位点。誤差を避けるため0.1単位の整数で計算する
function pointTenths(g) { return Math.round((g.score - 30000) / 100) + RANK_POINTS[g.rank] * 10; }
function calcPoint(score, rank) { return pointTenths({ score, rank }) / 10; }
function sumPoints(games) { return games.reduce((t, g) => t + pointTenths(g), 0) / 10; }
function fmtPt(p) {
  const v = Math.round(p * 10) / 10;
  if (v === 0) return '±0.0';
  return (v > 0 ? '+' : '') + v.toFixed(1);
}
function fmtYen(n) { return n.toLocaleString('ja-JP') + '円'; }
function ptClass(p) { return p > 0 ? 'plus' : p < 0 ? 'minus' : ''; }
function fmtCount(n) { return Number.isInteger(n) ? String(n) : n.toFixed(1); }
function fmtTime(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- data ----------
function emptyData() { return { version: 1, sessions: [] }; }

function isValidData(d) {
  return !!d && Array.isArray(d.sessions) && d.sessions.every(s =>
    s && typeof s.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && TYPES[s.type] &&
    Array.isArray(s.games) && s.games.every(g =>
      g && typeof g.id === 'string' && RANK_POINTS[g.rank] !== undefined && Number.isFinite(Number(g.score))));
}

function normalizeData(d) {
  for (const s of d.sessions) {
    s.status = s.status === 'active' ? 'active' : 'done';
    if (s.venueFee === undefined) s.venueFee = null;
    if (s.chip === undefined) s.chip = null;
    for (const g of s.games) {
      g.rank = Number(g.rank);
      g.score = Number(g.score);
      if (g.balance === undefined) g.balance = null;
    }
  }
  // 進行中セッションは最新の1つだけ
  const actives = d.sessions.filter(s => s.status === 'active')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  actives.slice(1).forEach(s => { s.status = 'done'; });
  return d;
}

function loadData() {
  for (const key of [DATA_KEY, DATA_PREV_KEY]) {
    try {
      const d = JSON.parse(localStorage.getItem(key));
      if (isValidData(d)) return normalizeData(d);
    } catch (e) { /* 次の候補へ */ }
  }
  return emptyData();
}

let data = loadData();

function saveData() {
  data.updatedAt = nowIso();
  try {
    const cur = localStorage.getItem(DATA_KEY);
    if (cur) localStorage.setItem(DATA_PREV_KEY, cur);
    localStorage.setItem(DATA_KEY, JSON.stringify(data));
  } catch (e) {
    alert('端末への保存に失敗しました: ' + e.message);
  }
  scheduleSync();
}

function activeSession() { return data.sessions.find(s => s.status === 'active') || null; }
function findSession(id) { return data.sessions.find(s => s.id === id) || null; }
function touch(s) { s.updatedAt = nowIso(); }
function byCreated(a, b) { return (a.createdAt || '').localeCompare(b.createdAt || ''); }
function sessionsNewestFirst(list) { return [...list].sort((a, b) => b.date.localeCompare(a.date) || byCreated(b, a)); }
function sessionsOldestFirst(list) { return [...list].sort((a, b) => a.date.localeCompare(b.date) || byCreated(a, b)); }
function totalGames() { return data.sessions.reduce((t, s) => t + s.games.length, 0); }

// ---------- settings / cloud sync ----------
function loadSettings() {
  const defaults = { backupUrl: '', token: '', lastSyncAt: '', lastSyncError: '', pending: false };
  try { return Object.assign(defaults, JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}); }
  catch (e) { return defaults; }
}
let settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
}

let syncTimer = null;
let syncing = false;
let syncQueued = false;

function scheduleSync() {
  if (!settings.backupUrl) return;
  settings.pending = true;
  saveSettings();
  renderSyncBadge();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 500);
}

async function syncNow() {
  if (!settings.backupUrl) return false;
  // 空データでクラウド側を上書きしないためのガード
  if (!data.sessions.length) return false;
  if (syncing) { syncQueued = true; return false; }
  syncing = true;
  renderSyncBadge();
  let ok = false;
  try {
    const res = await fetch(settings.backupUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: settings.token, data }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'サーバーエラー');
    settings.lastSyncAt = nowIso();
    settings.lastSyncError = '';
    if (!syncQueued) settings.pending = false;
    ok = true;
  } catch (e) {
    settings.lastSyncError = navigator.onLine === false ? 'オフライン' : String(e.message || e);
  } finally {
    syncing = false;
    saveSettings();
    renderSyncBadge();
    renderSyncStatus();
    if (syncQueued) { syncQueued = false; syncNow(); }
  }
  return ok;
}

function renderSyncBadge() {
  const el = $('#sync-badge');
  el.className = 'sync-badge';
  if (!settings.backupUrl) { el.textContent = ''; return; }
  if (syncing) { el.textContent = '送信中…'; return; }
  if (settings.pending) { el.textContent = '☁ 未送信'; el.classList.add('ng'); return; }
  el.textContent = '☁ 保存済'; el.classList.add('ok');
}

function renderSyncStatus() {
  const el = $('#sync-status');
  if (!settings.backupUrl) { el.textContent = '未設定'; return; }
  const parts = [];
  parts.push(settings.lastSyncAt ? `最終送信: ${fmtTime(settings.lastSyncAt)}` : 'まだ送信していません');
  if (settings.pending) parts.push('未送信の変更あり');
  if (settings.lastSyncError) parts.push(`エラー: ${settings.lastSyncError}`);
  el.textContent = parts.join(' / ');
}

window.addEventListener('online', () => { if (settings.pending) syncNow(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && settings.pending) syncNow();
});

// ---------- dialog / toast ----------
// buttons: [{label, value, cls, validate}]  validate() が null/false を返すと閉じない。値を返すとそれで resolve
function dialog(content, buttons) {
  return new Promise(resolve => {
    const body = $('#modal-body');
    body.innerHTML = '';
    if (typeof content === 'string') {
      const p = document.createElement('p');
      p.className = 'modal-msg' + (content.length > 40 ? ' sm' : '');
      p.textContent = content;
      body.append(p);
    } else {
      body.append(content);
    }
    const wrap = $('#modal-buttons');
    wrap.innerHTML = '';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'btn ' + (b.cls || '');
      el.textContent = b.label;
      el.addEventListener('click', () => {
        let value = b.value;
        if (b.validate) {
          value = b.validate();
          if (value === null || value === false || value === undefined) return;
        }
        $('#modal').hidden = true;
        resolve(value);
      });
      wrap.append(el);
    }
    $('#modal').hidden = false;
  });
}
const OK_BUTTON = [{ label: 'OK', value: true, cls: 'btn-primary' }];

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
}

// ---------- screens ----------
function show(name) {
  $$('.screen').forEach(el => { el.hidden = el.id !== 'screen-' + name; });
  window.scrollTo(0, 0);
  const render = { home: renderHome, input: renderInput, review: renderReview }[name];
  if (render) render();
}

function renderHome() {
  const s = activeSession();
  $('#resume-banner').hidden = !s;
  if (s) {
    $('#resume-info').textContent =
      `${fmtDate(s.date)} ${TYPES[s.type]}・${s.games.length}半荘 ${fmtPt(sumPoints(s.games))}`;
  }
}

// ----- 成績入力 -----
const form = { rank: null, tieMode: false, negative: false };

function resetForm() {
  form.rank = null;
  form.tieMode = false;
  form.negative = false;
  $('#score-input').value = '';
  renderRankButtons();
  renderSign();
}

function renderRankButtons() {
  const ranks = form.tieMode ? [1.5, 2.5, 3.5] : [1, 2, 3, 4];
  const wrap = $('#rank-buttons');
  wrap.className = 'rank-buttons' + (form.tieMode ? ' tie' : '');
  wrap.innerHTML = ranks.map(r => {
    const main = form.tieMode ? `${Math.floor(r)}-${Math.ceil(r)}` : r;
    const sub = form.tieMode ? '着同点' : '着';
    return `<button type="button" class="btn rank-btn${form.rank === r ? ' selected' : ''}" data-rank="${r}">${main}<small>${sub}</small></button>`;
  }).join('') +
    `<button type="button" class="btn rank-btn tie-toggle" data-action="toggle-tie">${form.tieMode ? '戻す' : '同点'}</button>`;
}

function renderSign() {
  const b = $('#sign-btn');
  b.textContent = form.negative ? '−' : '＋';
  b.classList.toggle('negative', form.negative);
}

function gameRowHtml(g, i, sid) {
  const p = calcPoint(g.score, g.rank);
  const inner = `<span class="idx">${i + 1}</span><span class="rank">${RANK_LABELS[g.rank]}</span>` +
    `<span class="score">${g.score}点</span><span class="pt ${ptClass(p)}">${fmtPt(p)}</span>`;
  return sid
    ? `<button type="button" class="game-row" data-action="edit-game" data-sid="${sid}" data-gid="${g.id}">${inner}</button>`
    : `<div class="game-row">${inner}</div>`;
}

function renderInput() {
  const s = activeSession();
  if (!s) { show('home'); return; }
  $('#input-title').textContent = TYPES[s.type];
  const total = sumPoints(s.games);
  $('#input-summary').innerHTML =
    `<span>${fmtDate(s.date)}</span><span>${s.games.length}半荘</span><span class="${ptClass(total)}">${fmtPt(total)}</span>`;
  $('#game-list').innerHTML = s.games.map((g, i) => gameRowHtml(g, i)).reverse().join('');
  renderSyncBadge();
}

function startSession(type) {
  const date = $('#type-date').value || todayStr();
  const s = {
    id: uid(), date, type, status: 'active', venueFee: null, chip: null, games: [],
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  data.sessions.push(s);
  saveData();
  resetForm();
  show('input');
}

async function goInput() {
  const s = activeSession();
  if (s) {
    const r = await dialog(
      `進行中のセッションがあります\n${fmtDate(s.date)} ${TYPES[s.type]}（${s.games.length}半荘）`,
      [
        { label: '新しく始める', value: 'new' },
        { label: '再開する', value: 'resume', cls: 'btn-primary' },
      ]);
    if (r === 'resume') { resetForm(); show('input'); return; }
    if (s.games.length === 0) {
      data.sessions = data.sessions.filter(x => x !== s);
    } else {
      s.status = 'done';
      touch(s);
    }
    saveData();
  }
  $('#type-date').value = todayStr();
  show('type');
}

async function confirmGame() {
  const s = activeSession();
  if (!s) return;
  let score = parseIntStrict($('#score-input').value.trim());
  if (score === null) { toast('素点を半角数字で入力してください'); return; }
  if (form.negative) score = -Math.abs(score);
  if (score % 100 !== 0) { toast('素点は100点単位で入力してください'); return; }
  if (Math.abs(score) > 200000) { toast('素点の値を確認してください'); return; }
  if (form.rank === null) { toast('順位を選んでください'); return; }

  const p = calcPoint(score, form.rank);
  const ok = await dialog(`${RANK_LABELS[form.rank]}・${score}点(${fmtPt(p)})`, [
    { label: '修正', value: false },
    { label: '確定', value: true, cls: 'btn-primary' },
  ]);
  if (!ok) return;
  s.games.push({ id: uid(), rank: form.rank, score, balance: null, createdAt: nowIso() });
  touch(s);
  saveData();
  resetForm();
  renderInput();
  toast(`${s.games.length}半荘目を記録しました`);
}

async function endSession() {
  const s = activeSession();
  if (!s) return;
  const ok = await dialog('このセッションを終了しますか？', [
    { label: 'いいえ', value: false },
    { label: 'はい', value: true, cls: 'btn-primary' },
  ]);
  if (!ok) return;
  $('#fee-input').value = '';
  $('#discard-btn').hidden = s.games.length > 0;
  show('fee');
}

async function confirmFee() {
  const s = activeSession();
  if (!s) { show('home'); return; }
  const fee = parseIntStrict($('#fee-input').value.trim());
  if (fee === null || fee < 0) { toast('場代を半角数字で入力してください'); return; }
  const ok = await dialog(`今日の場代：${fmtYen(fee)}`, [
    { label: 'キャンセル', value: false },
    { label: '確定', value: true, cls: 'btn-primary' },
  ]);
  if (!ok) return;
  s.venueFee = fee;
  s.status = 'done';
  s.endedAt = nowIso();
  touch(s);
  saveData();
  const total = sumPoints(s.games);
  $('#result-text').innerHTML =
    `今日は${s.games.length}半荘打って<br><span class="big ${ptClass(total)}">${fmtPt(total)}</span><br>でした`;
  $('#result-sub').textContent = `場代 ${fmtYen(fee)}`;
  show('result');
}

async function discardSession() {
  const s = activeSession();
  if (!s) { show('home'); return; }
  const ok = await dialog('このセッションを記録せずに破棄しますか？', [
    { label: 'いいえ', value: false },
    { label: '破棄する', value: true, cls: 'danger' },
  ]);
  if (!ok) return;
  data.sessions = data.sessions.filter(x => x !== s);
  saveData();
  show('home');
}

// ----- 成績確認 -----
let currentTab = 'list';

function renderReview() { switchTab(currentTab); }

function switchTab(tab) {
  currentTab = tab;
  $$('.tabs [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  for (const t of ['list', 'stats', 'settings']) $('#tab-' + t).hidden = t !== tab;
  ({ list: renderList, stats: renderStats, settings: renderSettings })[tab]();
}

const openSessions = new Set();

function renderList() {
  const el = $('#tab-list');
  if (!data.sessions.length) { el.innerHTML = '<p class="empty">まだ記録がありません</p>'; return; }
  el.innerHTML = sessionsNewestFirst(data.sessions).map(s => {
    const total = sumPoints(s.games);
    const games = s.games.map((g, i) => gameRowHtml(g, i, s.id)).join('');
    return `<details class="card session" data-sid="${s.id}"${openSessions.has(s.id) ? ' open' : ''}>
      <summary>
        <div class="s-head"><span class="s-date">${fmtDate(s.date)}</span><span class="tag tag-${s.type}">${TYPES[s.type]}</span>${s.status === 'active' ? '<span class="tag tag-active">進行中</span>' : ''}</div>
        <div class="s-sub"><span>${s.games.length}半荘</span><span class="pt ${ptClass(total)}">${fmtPt(total)}</span><span class="muted">場代 ${s.venueFee == null ? '未入力' : fmtYen(s.venueFee)}</span></div>
      </summary>
      <div class="s-body">
        <div class="game-list">${games || '<p class="muted small">半荘の記録なし</p>'}</div>
        <p class="muted small">半荘をタップすると編集・削除できます</p>
        <div class="s-actions">
          <button class="btn" data-action="add-game" data-sid="${s.id}">＋ 半荘を追加</button>
          <button class="btn" data-action="edit-session" data-sid="${s.id}">セッション編集</button>
        </div>
      </div>
    </details>`;
  }).join('');
}

function gameForm(g) {
  const wrap = document.createElement('div');
  wrap.className = 'form';
  wrap.innerHTML = `<h3>${g ? '半荘を編集' : '半荘を追加'}</h3>
    <div class="field"><span>素点</span>
      <div class="score-row">
        <button type="button" class="btn btn-sign"></button>
        <input type="text" inputmode="numeric" pattern="[0-9]*" class="f-score" autocomplete="off">
        <span class="unit">点</span>
      </div>
    </div>
    <label class="field"><span>順位</span>
      <select class="f-rank">${RANKS.map(r => `<option value="${r}">${RANK_LABELS[r]}（${RANK_POINTS[r] > 0 ? '+' : ''}${RANK_POINTS[r]}）</option>`).join('')}</select>
    </label>
    <p class="f-error error"></p>`;
  let negative = g ? g.score < 0 : false;
  const signBtn = $('.btn-sign', wrap);
  const input = $('.f-score', wrap);
  const rankSel = $('.f-rank', wrap);
  const renderS = () => { signBtn.textContent = negative ? '−' : '＋'; signBtn.classList.toggle('negative', negative); };
  signBtn.addEventListener('click', () => { negative = !negative; renderS(); });
  renderS();
  if (g) { input.value = Math.abs(g.score); rankSel.value = String(g.rank); }
  else { rankSel.value = '1'; }
  const err = msg => { $('.f-error', wrap).textContent = msg; return null; };
  wrap.read = () => {
    let score = parseIntStrict(input.value.trim());
    if (score === null) return err('素点を半角数字で入力してください');
    if (negative) score = -Math.abs(score);
    if (score % 100 !== 0) return err('素点は100点単位で入力してください');
    if (Math.abs(score) > 200000) return err('素点の値を確認してください');
    return { score, rank: Number(rankSel.value) };
  };
  return wrap;
}

async function addGame(t) {
  const s = findSession(t.dataset.sid);
  if (!s) return;
  const f = gameForm(null);
  const r = await dialog(f, [
    { label: 'キャンセル', value: null },
    { label: '追加', cls: 'btn-primary', validate: f.read },
  ]);
  if (!r) return;
  s.games.push({ id: uid(), rank: r.rank, score: r.score, balance: null, createdAt: nowIso() });
  touch(s);
  saveData();
  openSessions.add(s.id);
  renderList();
  toast('追加しました');
}

async function editGame(t) {
  const s = findSession(t.dataset.sid);
  const g = s && s.games.find(x => x.id === t.dataset.gid);
  if (!g) return;
  const f = gameForm(g);
  const r = await dialog(f, [
    { label: '削除', value: 'delete', cls: 'danger' },
    { label: 'キャンセル', value: null },
    { label: '保存', cls: 'btn-primary', validate: f.read },
  ]);
  if (!r) return;
  if (r === 'delete') {
    const idx = s.games.indexOf(g);
    const ok = await dialog(`${idx + 1}半荘目（${RANK_LABELS[g.rank]}・${g.score}点）を削除しますか？`, [
      { label: 'いいえ', value: false },
      { label: '削除する', value: true, cls: 'danger' },
    ]);
    if (!ok) return;
    s.games.splice(idx, 1);
    toast('削除しました');
  } else {
    g.score = r.score;
    g.rank = r.rank;
    g.updatedAt = nowIso();
    toast('保存しました');
  }
  touch(s);
  saveData();
  renderList();
}

function sessionForm(s) {
  const wrap = document.createElement('div');
  wrap.className = 'form';
  const typeOptions = Object.keys(TYPES)
    .filter(k => k !== 'onRateFree' || s.type === 'onRateFree')
    .map(k => `<option value="${k}">${TYPES[k]}</option>`).join('');
  wrap.innerHTML = `<h3>セッションを編集</h3>
    <label class="field"><span>日付</span><input type="date" class="f-date"></label>
    <label class="field"><span>対局タイプ</span><select class="f-type">${typeOptions}</select></label>
    <label class="field"><span>場代（円・空欄で未入力）</span><input type="text" inputmode="numeric" pattern="[0-9]*" class="f-fee" autocomplete="off"></label>
    <p class="f-error error"></p>`;
  $('.f-date', wrap).value = s.date;
  $('.f-type', wrap).value = s.type;
  $('.f-fee', wrap).value = s.venueFee == null ? '' : s.venueFee;
  const err = msg => { $('.f-error', wrap).textContent = msg; return null; };
  wrap.read = () => {
    const date = $('.f-date', wrap).value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err('日付を入力してください');
    const feeRaw = $('.f-fee', wrap).value.trim();
    let venueFee = null;
    if (feeRaw !== '') {
      venueFee = parseIntStrict(feeRaw);
      if (venueFee === null || venueFee < 0) return err('場代を半角数字で入力してください');
    }
    return { date, type: $('.f-type', wrap).value, venueFee };
  };
  return wrap;
}

async function editSession(t) {
  const s = findSession(t.dataset.sid);
  if (!s) return;
  const f = sessionForm(s);
  const r = await dialog(f, [
    { label: '削除', value: 'delete', cls: 'danger' },
    { label: 'キャンセル', value: null },
    { label: '保存', cls: 'btn-primary', validate: f.read },
  ]);
  if (!r) return;
  if (r === 'delete') {
    const ok = await dialog(
      `${fmtDate(s.date)} ${TYPES[s.type]}（${s.games.length}半荘）を丸ごと削除しますか？\nこの操作は取り消せません。`, [
        { label: 'いいえ', value: false },
        { label: '削除する', value: true, cls: 'danger' },
      ]);
    if (!ok) return;
    data.sessions = data.sessions.filter(x => x !== s);
    toast('削除しました');
  } else {
    Object.assign(s, r);
    touch(s);
    toast('保存しました');
  }
  saveData();
  renderList();
}

// ----- Data -----
const statsFilter = { period: 'all', type: 'all' };

function periodSessions() {
  const today = todayStr();
  if (statsFilter.period === 'month') return data.sessions.filter(s => s.date.startsWith(today.slice(0, 7)));
  if (statsFilter.period === '30d') {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    const from = dateStr(d);
    return data.sessions.filter(s => s.date >= from && s.date <= today);
  }
  return data.sessions;
}

function computeStats(sessions) {
  const games = sessionsOldestFirst(sessions).flatMap(s => s.games);
  const n = games.length;
  const dist = [0, 0, 0, 0];
  let rankSum = 0, scoreSum = 0, tenths = 0;
  for (const g of games) {
    rankSum += g.rank;
    scoreSum += g.score;
    tenths += pointTenths(g);
    if (Number.isInteger(g.rank)) dist[g.rank - 1] += 1;
    else { dist[Math.floor(g.rank) - 1] += 0.5; dist[Math.ceil(g.rank) - 1] += 0.5; }
  }
  return {
    games, n, dist,
    sessions: sessions.length,
    avgRank: n ? rankSum / n : 0,
    avgScore: n ? scoreSum / n : 0,
    total: tenths / 10,
    avgPt: n ? tenths / 10 / n : 0,
    fee: sessions.reduce((t, s) => t + (s.venueFee || 0), 0),
  };
}

function statBox(label, value) {
  return `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div></div>`;
}

function distHtml(st) {
  const pct = v => (v / st.n * 100).toFixed(1) + '%';
  const rows = st.dist.map((c, i) =>
    `<div class="dist-row"><span>${i + 1}着</span><div class="dist-bar"><div style="width:${c / st.n * 100}%"></div></div><span class="num">${fmtCount(c)}回 ${pct(c)}</span></div>`
  ).join('');
  return `<div class="dist">${rows}
    <div class="dist-foot"><span>連対率 ${pct(st.dist[0] + st.dist[1])}</span><span>ラス回避率 ${pct(st.n - st.dist[3])}</span></div>
  </div>`;
}

function chartSvg(games) {
  const vals = [0];
  let acc = 0;
  for (const g of games) { acc += pointTenths(g); vals.push(acc / 10); }
  const W = 340, H = 180, L = 44, R = 10, T = 12, B = 22;
  let min = Math.min(0, ...vals), max = Math.max(0, ...vals);
  if (max === min) { max += 10; min -= 10; }
  const x = i => L + (W - L - R) * i / (vals.length - 1);
  const y = v => T + (H - T - B) * (max - v) / (max - min);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = vals[vals.length - 1];
  const color = last >= 0 ? 'var(--plus)' : 'var(--minus)';
  const dots = vals.length <= 40
    ? vals.slice(1).map((v, i) => `<circle cx="${x(i + 1).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" fill="${color}"/>`).join('')
    : '';
  const label = (v, yy) => `<text x="${L - 6}" y="${yy}" text-anchor="end" font-size="11" fill="var(--muted)">${fmtPt(v)}</text>`;
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="累計ポイント推移">
    <line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)" stroke-dasharray="4 4"/>
    ${label(max, y(max) + 4)}${min < 0 && max > 0 ? label(0, y(0) + 4) : ''}${label(min, y(min) + 4)}
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>
    ${dots}
    <text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="11" fill="var(--muted)">${games.length}半荘</text>
    <text x="${L}" y="${H - 6}" font-size="11" fill="var(--muted)">0</text>
  </svg></div>`;
}

function typeTable(sessions) {
  const rows = Object.keys(TYPES).map(k => {
    const st = computeStats(sessions.filter(s => s.type === k));
    if (!st.n) return '';
    return `<tr><td>${TYPES[k]}</td><td>${st.n}</td><td>${st.avgRank.toFixed(2)}</td>` +
      `<td class="${ptClass(st.total)}">${fmtPt(st.total)}</td><td class="${ptClass(st.avgPt)}">${fmtPt(st.avgPt)}</td></tr>`;
  }).join('');
  if (!rows) return '';
  return `<table class="types"><thead><tr><th>タイプ</th><th>半荘</th><th>平均着順</th><th>合計pt</th><th>平均pt</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderStats() {
  const seg = (action, cur, opts) =>
    `<div class="seg">${opts.map(([v, l]) => `<button class="${cur === v ? 'active' : ''}" data-action="${action}" data-value="${v}">${l}</button>`).join('')}</div>`;
  let html = seg('set-period', statsFilter.period, [['month', '今月'], ['30d', '直近30日'], ['all', '全期間']]) +
    seg('set-ftype', statsFilter.type, [['all', '全タイプ'], ['set', 'セット'], ['noRateFree', 'ノーレート'], ['onRateFree', 'オンレート']]);
  const pSessions = periodSessions();
  const sessions = statsFilter.type === 'all' ? pSessions : pSessions.filter(s => s.type === statsFilter.type);
  const st = computeStats(sessions);
  if (!st.n) {
    $('#tab-stats').innerHTML = html + '<p class="empty">この条件の記録はありません</p>';
    return;
  }
  html += `<div class="stat-grid">
    ${statBox('合計ポイント', `<span class="${ptClass(st.total)}">${fmtPt(st.total)}</span>`)}
    ${statBox('半荘数', `${st.n}<small>（${st.sessions}回）</small>`)}
    ${statBox('平均着順', st.avgRank.toFixed(2))}
    ${statBox('平均ポイント', `<span class="${ptClass(st.avgPt)}">${fmtPt(st.avgPt)}</span>`)}
    ${statBox('平均素点', Math.round(st.avgScore).toLocaleString('ja-JP') + '<small>点</small>')}
    ${statBox('累計場代', fmtYen(st.fee))}
  </div>`;
  html += '<h3>着順分布</h3>' + distHtml(st);
  html += '<h3>累計ポイント推移</h3>' + chartSvg(st.games);
  const tt = typeTable(pSessions);
  if (tt) html += '<h3>対局タイプ別（期間内）</h3>' + tt;
  $('#tab-stats').innerHTML = html;
}

// ----- 設定 -----
function renderSettings() {
  $('#data-summary').textContent = `セッション ${data.sessions.length}件 / 半荘 ${totalGames()}件`;
  $('#backup-url').value = settings.backupUrl;
  $('#backup-token').value = settings.token;
  renderSyncStatus();
  const ps = $('#persist-status');
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then(p => {
      ps.textContent = p ? '端末ストレージ: 永続化済み' : '端末ストレージ: 通常（ホーム画面から使えば通常は消えません）';
    }).catch(() => {});
  }
}

async function exportJson() {
  const text = JSON.stringify(data, null, 2);
  const name = `mahjong-record-${todayStr()}.json`;
  const file = new File([text], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function applyImported(d, label) {
  normalizeData(d);
  const mode = await dialog(
    `${label}\n現在の端末：セッション${data.sessions.length}件\n\n統合：両方のデータを合わせる（同じ記録は新しい方を残す）\n置き換え：端末のデータを取り込んだデータで上書き`, [
      { label: 'キャンセル', value: null },
      { label: '置き換え', value: 'replace', cls: 'danger' },
      { label: '統合', value: 'merge', cls: 'btn-primary' },
    ]);
  if (!mode) return;
  if (mode === 'replace') {
    const ok = await dialog('端末のデータをすべて置き換えます。よろしいですか？', [
      { label: 'やめる', value: false },
      { label: '置き換える', value: true, cls: 'danger' },
    ]);
    if (!ok) return;
    data = { version: 1, sessions: d.sessions };
  } else {
    const map = new Map(data.sessions.map(s => [s.id, s]));
    for (const s of d.sessions) {
      const cur = map.get(s.id);
      if (!cur || (s.updatedAt || '') > (cur.updatedAt || '')) map.set(s.id, s);
    }
    data = { version: 1, sessions: [...map.values()] };
  }
  normalizeData(data);
  saveData();
  renderSettings();
  toast('取り込みました');
}

$('#import-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let d;
  try { d = JSON.parse(await file.text()); }
  catch (err) { await dialog('JSONファイルを読み込めませんでした', OK_BUTTON); return; }
  if (!isValidData(d)) { await dialog('このアプリのデータ形式ではありません', OK_BUTTON); return; }
  await applyImported(d, `ファイル：セッション${d.sessions.length}件`);
});

async function saveBackupSettings() {
  const url = $('#backup-url').value.trim();
  if (url && !/^https:\/\//.test(url)) { toast('URLは https:// で始まる必要があります'); return; }
  settings.backupUrl = url;
  settings.token = $('#backup-token').value.trim();
  settings.lastSyncError = '';
  saveSettings();
  renderSyncStatus();
  if (!url) { toast('自動バックアップをオフにしました'); return; }
  if (!data.sessions.length) { toast('保存しました（記録ができたら送信します）'); return; }
  toast('送信テスト中…');
  const ok = await syncNow();
  toast(ok ? '送信に成功しました' : '送信に失敗しました');
}

async function syncNowAction() {
  if (!settings.backupUrl) { toast('URLを設定してください'); return; }
  if (!data.sessions.length) { toast('送信する記録がありません'); return; }
  const ok = await syncNow();
  toast(ok ? '送信しました' : '送信に失敗しました');
}

async function restoreServer() {
  if (!settings.backupUrl) { toast('URLを設定してください'); return; }
  try {
    const url = settings.backupUrl + (settings.backupUrl.includes('?') ? '&' : '?') +
      'token=' + encodeURIComponent(settings.token);
    const res = await fetch(url);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'サーバーエラー');
    if (!isValidData(j.data)) throw new Error('データ形式が正しくありません');
    await applyImported(j.data, `クラウド：セッション${j.data.sessions.length}件`);
  } catch (e) {
    await dialog('クラウドから取得できませんでした\n' + (e.message || e), OK_BUTTON);
  }
}

// ---------- events ----------
const actions = {
  home: () => show('home'),
  'go-input': goInput,
  'go-review': () => show('review'),
  resume: () => { resetForm(); show('input'); },
  'toggle-sign': () => { form.negative = !form.negative; renderSign(); },
  'toggle-tie': () => { form.tieMode = !form.tieMode; form.rank = null; renderRankButtons(); },
  'confirm-game': confirmGame,
  'end-session': endSession,
  'back-input': () => show('input'),
  'confirm-fee': confirmFee,
  'discard-session': discardSession,
  'add-game': addGame,
  'edit-game': editGame,
  'edit-session': editSession,
  'set-period': t => { statsFilter.period = t.dataset.value; renderStats(); },
  'set-ftype': t => { statsFilter.type = t.dataset.value; renderStats(); },
  export: exportJson,
  'save-backup': saveBackupSettings,
  'sync-now': syncNowAction,
  'restore-server': restoreServer,
};

document.addEventListener('click', e => {
  if (e.target.closest('#modal')) return;
  const t = e.target.closest('[data-action],[data-type],[data-rank],[data-tab]');
  if (!t || t.disabled) return;
  if (t.dataset.type) { startSession(t.dataset.type); return; }
  if (t.dataset.rank) { form.rank = Number(t.dataset.rank); renderRankButtons(); return; }
  if (t.dataset.tab) { switchTab(t.dataset.tab); return; }
  const fn = actions[t.dataset.action];
  if (fn) fn(t, e);
});

$('#tab-list').addEventListener('toggle', e => {
  const d = e.target;
  if (!d.dataset || !d.dataset.sid) return;
  if (d.open) openSessions.add(d.dataset.sid); else openSessions.delete(d.dataset.sid);
}, true);

// ---------- init ----------
$('#app-version').textContent = APP_VERSION;
resetForm();
show('home');
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}
if (settings.pending) syncNow();
