'use strict';

// sw.js の VERSION と必ず揃える（テストで確認している）
const APP_VERSION = '1.2.2';
const DATA_VERSION = 1;
const DATA_KEY = 'mjr.data.v1';
const DATA_PREV_KEY = 'mjr.data.v1.prev';
const SETTINGS_KEY = 'mjr.settings.v1';

const TYPES = { set: 'セット', onRateFree: 'オンレートフリー', noRateFree: 'ノーレートフリー' };
// 順位点（Mリーグ準拠 + 同点時）
const RANK_POINTS = { 1: 50, 1.5: 30, 2: 10, 2.5: 0, 3: -10, 3.5: -20, 4: -30 };
const RANK_LABELS = { 1: '1着', 1.5: '1-2着同点', 2: '2着', 2.5: '2-3着同点', 3: '3着', 3.5: '3-4着同点', 4: '4着' };
const RANKS = [1, 1.5, 2, 2.5, 3, 3.5, 4];
// オンレートの店ルール。1着は全員分のゲーム代とトップ賞を店に払う
const SHOPS = {
  marchao: { name: 'マーチャオ', gameFee: 350, topPrize: 400 },
};
const WEEKDAYS = '日月火水木金土';
const UNDO_LIMIT_MS = 10 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 60 * 1000;
const STALE_SESSION_MS = 6 * 60 * 60 * 1000;
const BACKUP_WARN_MS = 3 * 24 * 60 * 60 * 1000;

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
function fmtPt(p) {
  const v = Math.round(p * 10) / 10;
  if (v === 0) return '±0.0';
  return (v > 0 ? '+' : '') + v.toFixed(1);
}
function fmtNum(n) { return n.toLocaleString('ja-JP'); }
function fmtYen(n) { return fmtNum(n) + '円'; }
function fmtSigned(n) { return n === 0 ? '±0' : (n > 0 ? '+' : '-') + fmtNum(Math.abs(n)); }
function fmtYenSigned(n) { return fmtSigned(n) + '円'; }
function ptClass(p) { return p > 0 ? 'plus' : p < 0 ? 'minus' : ''; }
function fmtCount(n) { return Number.isInteger(n) ? String(n) : n.toFixed(1); }
function fmtTime(iso) {
  const d = new Date(iso);
  const day = dateStr(d) === todayStr() ? '今日' : `${d.getMonth() + 1}/${d.getDate()}`;
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 計算 ----------
function isOnRate(s) { return s.type === 'onRateFree'; }

// ポイント = (素点 - 30000) / 1000 + 順位点。誤差を避けるため0.1単位の整数で計算する
function pointTenths(g) { return Math.round((g.score - 30000) / 100) + RANK_POINTS[g.rank] * 10; }
function calcPoint(score, rank) { return pointTenths({ score, rank }) / 10; }
function sumPoints(games) { return games.reduce((t, g) => t + pointTenths(g), 0) / 10; }

// オンレートの半荘収支。1着は受け取った額から「ゲーム代×4人 + トップ賞」を店に払う
function gameNet(g) { return g.rank === 1 ? g.amount - (g.gameFee * 4 + g.topPrize) : g.amount; }
function sumNet(games) { return games.reduce((t, g) => t + gameNet(g), 0); }
function chipDiff(s) { return s.chipStart != null && s.chipEnd != null ? s.chipEnd - s.chipStart : 0; }
// 収支 = 半荘収支の合計 + チップ収支（追加費用は含めない）
function sessionMoney(s) { return sumNet(s.games) + chipDiff(s); }
function sessionFinal(s) { return sessionMoney(s) - (s.extraCost || 0); }
function rankCounts(games) {
  const c = [0, 0, 0, 0];
  for (const g of games) c[g.rank - 1]++;
  return c;
}
// セッション一覧などで使う成績の短い表記
function sessionResultText(s) {
  return isOnRate(s) ? fmtYenSigned(sessionMoney(s)) : fmtPt(sumPoints(s.games));
}
function sessionResultValue(s) { return isOnRate(s) ? sessionMoney(s) : sumPoints(s.games); }

// ---------- data ----------
function emptyData() { return { version: DATA_VERSION, sessions: [] }; }

function isValidGame(g, onRate) {
  if (!g || typeof g.id !== 'string') return false;
  if (onRate) return [1, 2, 3, 4].includes(Number(g.rank)) && Number.isFinite(Number(g.amount));
  return RANK_POINTS[g.rank] !== undefined && Number.isFinite(Number(g.score));
}

function isValidData(d) {
  return !!d && Array.isArray(d.sessions) && d.sessions.every(s =>
    s && typeof s.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && TYPES[s.type] &&
    Array.isArray(s.games) && s.games.every(g => isValidGame(g, s.type === 'onRateFree')));
}

// データ形式の変換。形式を変えるときは DATA_VERSION を上げ、ここに変換処理を追加する
function migrateData(d) {
  if (!d.version) d.version = 1;
  // 例: if (d.version === 1) { ...変換...; d.version = 2; }
  return d;
}

const numOrNull = v => (v === null || v === undefined || v === '' ? null : Number(v));

function normalizeData(d) {
  for (const s of d.sessions) {
    s.status = s.status === 'active' ? 'active' : 'done';
    s.venueFee = numOrNull(s.venueFee);
    if (isOnRate(s)) {
      if (!SHOPS[s.shop]) s.shop = 'marchao';
      s.chipStart = numOrNull(s.chipStart);
      s.chipEnd = numOrNull(s.chipEnd);
      s.extraCost = numOrNull(s.extraCost);
      s.chip = s.chipStart != null && s.chipEnd != null ? chipDiff(s) : null;
    } else if (s.chip === undefined) {
      s.chip = null;
    }
    for (const g of s.games) {
      g.rank = Number(g.rank);
      if (isOnRate(s)) {
        const shop = SHOPS[s.shop];
        g.score = null;
        g.amount = Number(g.amount);
        if (!Number.isFinite(Number(g.gameFee))) g.gameFee = shop.gameFee;
        if (!Number.isFinite(Number(g.topPrize))) g.topPrize = shop.topPrize;
        g.gameFee = Number(g.gameFee);
        g.topPrize = Number(g.topPrize);
        g.balance = gameNet(g);
      } else {
        g.score = Number(g.score);
        if (g.balance === undefined) g.balance = null;
      }
    }
  }
  // 進行中セッションは最新の1つだけ
  const actives = d.sessions.filter(s => s.status === 'active')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  actives.slice(1).forEach(s => { s.status = 'done'; });
  return d;
}

// 読み込みの結果: 正常 / 新しすぎる / 壊れている を区別する
function parseStoredData(raw) {
  let d;
  try { d = JSON.parse(raw); } catch (e) { return { error: 'broken' }; }
  if (d && d.version > DATA_VERSION) return { error: 'newer' };
  if (!isValidData(d)) return { error: 'broken' };
  return { data: normalizeData(migrateData(d)) };
}

let loadProblem = null;

function loadData() {
  let raw = null;
  try { raw = localStorage.getItem(DATA_KEY); } catch (e) { /* ignore */ }
  if (raw === null) return emptyData();
  const r = parseStoredData(raw);
  if (r.data) return r.data;
  // 読めなかった元データは消さずに退避しておく
  try { localStorage.setItem('mjr.data.unreadable.' + Date.now(), raw); } catch (e) { /* ignore */ }
  loadProblem = r.error;
  let prev = null;
  try { prev = localStorage.getItem(DATA_PREV_KEY); } catch (e) { /* ignore */ }
  if (prev !== null) {
    const p = parseStoredData(prev);
    if (p.data) return p.data;
  }
  return emptyData();
}

let data = loadData();

function saveData() {
  data.version = DATA_VERSION;
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

function newOnRateGame(s, rank, amount) {
  const shop = SHOPS[s.shop];
  const g = { id: uid(), rank, score: null, amount, gameFee: shop.gameFee, topPrize: shop.topPrize, createdAt: nowIso() };
  g.balance = gameNet(g);
  return g;
}

// 確定前の注意事項（止めはしない）。value は素点（ノーレート）または収支（オンレート）
function gameWarnings(value, rank, session, onRate = false) {
  const w = [];
  if (!onRate) {
    if ((rank === 1 || rank === 1.5) && value < 25000) w.push(`${RANK_LABELS[rank]}なのに25,000点未満です`);
    if ((rank === 4 || rank === 3.5) && value > 25000) w.push(`${RANK_LABELS[rank]}なのに25,000点を超えています`);
    if (Math.abs(value) >= 100000) w.push('素点が10万点以上です');
  }
  const last = session && session.games[session.games.length - 1];
  if (last && (onRate ? last.amount : last.score) === value && last.rank === rank &&
      Date.now() - Date.parse(last.createdAt) < DUPLICATE_WINDOW_MS) {
    w.push('直前の半荘と同じ内容です（二重登録ではありませんか？）');
  }
  return w;
}

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
  renderSyncUI();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 500);
}

async function syncNow() {
  if (!settings.backupUrl) return false;
  // 空データでクラウド側を上書きしないためのガード
  if (!data.sessions.length) return false;
  if (syncing) { syncQueued = true; return false; }
  syncing = true;
  renderSyncUI();
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
    renderSyncUI();
    if (syncQueued) { syncQueued = false; syncNow(); }
  }
  return ok;
}

function renderSyncUI() {
  renderSyncBadge();
  renderSyncStatus();
  renderHomeBackup();
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

function renderHomeBackup() {
  const el = $('#home-backup');
  let text, warn = false;
  if (!settings.backupUrl) {
    text = '⚠ 自動バックアップが未設定です（タップで設定）';
    warn = true;
  } else if (settings.pending) {
    const since = settings.lastSyncAt ? Date.now() - Date.parse(settings.lastSyncAt) : Infinity;
    if (since > BACKUP_WARN_MS && data.sessions.length) {
      text = settings.lastSyncAt
        ? `⚠ ${fmtTime(settings.lastSyncAt)} からバックアップできていません`
        : '⚠ まだ一度もバックアップできていません';
      warn = true;
    } else {
      text = '☁ 未送信の変更があります（自動で再送します）';
    }
  } else {
    text = settings.lastSyncAt ? `☁ 最終バックアップ: ${fmtTime(settings.lastSyncAt)}` : '☁ 自動バックアップ: 設定済み';
  }
  el.textContent = text;
  el.classList.toggle('warn', warn);
}

window.addEventListener('online', () => { if (settings.pending) syncNow(); });

// ---------- tap guard ----------
// ダイアログを閉じた直後や画面切り替え直後の「2度押し」が下のボタンに届かないようにする
let ignoreTapsUntil = 0;
function guardTaps(ms) { ignoreTapsUntil = Date.now() + ms; }
document.addEventListener('click', e => {
  if (Date.now() < ignoreTapsUntil) { e.stopPropagation(); e.preventDefault(); }
}, true);

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
    let done = false;
    for (const b of buttons) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'btn ' + (b.cls || '');
      el.textContent = b.label;
      el.addEventListener('click', () => {
        if (done) return;
        let value = b.value;
        if (b.validate) {
          value = b.validate();
          if (value === null || value === false || value === undefined) return;
        }
        done = true;
        $('#modal').hidden = true;
        guardTaps(400);
        resolve(value);
      });
      wrap.append(el);
    }
    $('#modal').hidden = false;
  });
}
const OK_BUTTON = [{ label: 'OK', value: true, cls: 'btn-primary' }];
function isDialogOpen() { return !$('#modal').hidden; }

// メッセージ + 警告一覧のダイアログ本文
function messageWithWarnings(message, warnings) {
  const wrap = document.createElement('div');
  wrap.className = 'form';
  wrap.innerHTML = `<p class="modal-msg">${esc(message)}</p>` +
    (warnings.length ? `<ul class="warn-list">${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : '');
  return wrap;
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
}

// ---------- keypad ----------
// mode:
//   hundreds … 1キー＝100単位（素点・半荘収支・持ちチップ）。表示の下2桁「00」は固定
//   yen      … 1円単位（場代・追加費用）
// allowNegative: ±キーを出すか / defaultZero: 未入力を0として扱うか
function createKeypad(el, onChange) {
  const state = { digits: '', negative: false, cfg: { mode: 'hundreds', allowNegative: true, defaultZero: false } };
  const labels = { back: '⌫', clear: 'C', sign: '±' };
  const aria = { back: '1文字消す', clear: '全部消す', sign: 'プラスマイナス切替' };

  function layout(cfg) {
    const top = ['7', '8', '9', 'back', '4', '5', '6', 'clear', '1', '2', '3'];
    if (cfg.mode === 'hundreds') {
      return cfg.allowNegative ? [...top, 'sign', '0:4'] : [...top, '0'];
    }
    return [...top, cfg.allowNegative ? 'sign' : 'blank', '0:2', '00:2'];
  }
  function render() {
    el.innerHTML = layout(state.cfg).map(item => {
      const [k, span] = item.split(':');
      if (k === 'blank') return '<span></span>';
      const cls = ['btn', 'key'];
      if (span) cls.push('span' + span);
      if (labels[k]) cls.push('fn');
      if (k === 'sign' && state.negative) cls.push('sign-on');
      return `<button type="button" class="${cls.join(' ')}" data-key="${k}" aria-label="${aria[k] || k}">${labels[k] || k}</button>`;
    }).join('');
  }
  const maxDigits = () => (state.cfg.mode === 'hundreds' ? 5 : 7);
  const update = () => {
    const signKey = $('[data-key="sign"]', el);
    if (signKey) signKey.classList.toggle('sign-on', state.negative);
    onChange();
  };
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-key]');
    if (!b) return;
    const k = b.dataset.key;
    if (k === 'back') state.digits = state.digits.slice(0, -1);
    else if (k === 'clear') { state.digits = ''; state.negative = false; }
    else if (k === 'sign') state.negative = !state.negative;
    else {
      const next = (state.digits + k).replace(/^0+(?=\d)/, '');
      if (next.length > maxDigits()) return;
      state.digits = next;
    }
    update();
  });

  const pad = {
    value() {
      if (state.digits === '') return state.cfg.defaultZero ? 0 : null;
      let v = parseInt(state.digits, 10);
      if (state.cfg.mode === 'hundreds') v *= 100;
      return state.negative && v !== 0 ? -v : v;
    },
    // 表示欄の中身を描画する（高さが変わらないよう常に1行のテキスト）
    renderTo(target) {
      const minus = state.negative ? '−' : '';
      const v = pad.value();
      target.className = 'nd-value' + (state.negative ? ' minus' : '');
      if (state.cfg.mode === 'hundreds') {
        const body = state.digits === '' ? '' : fmtNum(Math.abs(v)).slice(0, -2);
        target.innerHTML = v === 0 ? '0' : `${minus}${body}<span class="fixed">00</span>`;
        if (state.digits === '') target.classList.add('empty');
      } else {
        target.textContent = minus + (v === null ? '0' : fmtNum(Math.abs(v)));
        if (state.digits === '' && !state.cfg.defaultZero) target.classList.add('empty');
      }
    },
    reset(cfg) {
      if (cfg) state.cfg = Object.assign({ mode: 'hundreds', allowNegative: false, defaultZero: false }, cfg);
      state.digits = '';
      state.negative = false;
      render();
      update();
    },
  };
  render();
  return pad;
}

// ---------- screens ----------
function show(name) {
  $$('.screen').forEach(el => { el.hidden = el.id !== 'screen-' + name; });
  window.scrollTo(0, 0);
  guardTaps(250);
  const render = { home: renderHome, input: renderInput, review: renderReview }[name];
  if (render) render();
}
function currentScreen() {
  const el = $$('.screen').find(s => !s.hidden);
  return el ? el.id.replace('screen-', '') : '';
}

function renderHome() {
  const s = activeSession();
  $('#resume-banner').hidden = !s;
  if (s) {
    $('#resume-info').textContent =
      `${fmtDate(s.date)} ${TYPES[s.type]}・${s.games.length}半荘 ${sessionResultText(s)}`;
  }
  renderHomeBackup();
}

// ----- 金額入力画面（場代・持ちチップ・追加費用で共用） -----
// cfg: { title, note, label, allowNegative, step100（1キー＝100円）, defaultZero, back, confirmText(v), onConfirm(v), showDiscard }
let amountCfg = null;
let amountPad;

function openAmountScreen(cfg) {
  amountCfg = cfg;
  $('#amount-title').textContent = cfg.title;
  $('#amount-note').textContent = cfg.note || '';
  $('#amount-label').textContent = cfg.label;
  $('#discard-btn').hidden = !cfg.showDiscard;
  amountPad.reset({ mode: cfg.step100 ? 'hundreds' : 'yen', allowNegative: !!cfg.allowNegative, defaultZero: !!cfg.defaultZero });
  show('amount');
}

function renderAmountPreview() {
  amountPad.renderTo($('#amount-value'));
}

async function amountConfirm() {
  const cfg = amountCfg;
  if (!cfg) return;
  const v = amountPad.value();
  if (v === null) { toast('金額を入力してください'); return; }
  const ok = await dialog(cfg.confirmText(v), [
    { label: 'キャンセル', value: false },
    { label: '確定', value: true, cls: 'btn-primary' },
  ]);
  if (ok) cfg.onConfirm(v);
}

// ----- 成績入力 -----
const form = { rank: null, tieMode: false };
let scorePad;
let pendingStart = null; // セッション開始前に選んだ日付・タイプ

function inputIsOnRate() {
  const s = activeSession();
  return !!s && isOnRate(s);
}

function resetForm() {
  form.rank = null;
  form.tieMode = false;
  scorePad.reset({ mode: 'hundreds', allowNegative: true });
  renderRankButtons();
}

function renderRankButtons() {
  const onRate = inputIsOnRate();
  if (onRate) form.tieMode = false;
  const ranks = form.tieMode ? [1.5, 2.5, 3.5] : [1, 2, 3, 4];
  const wrap = $('#rank-buttons');
  wrap.className = 'rank-buttons' + (form.tieMode ? ' tie' : '') + (onRate ? ' no-tie' : '');
  wrap.innerHTML = ranks.map(r => {
    const main = form.tieMode ? `${Math.floor(r)}-${Math.ceil(r)}` : r;
    const sub = form.tieMode ? '着同点' : '着';
    return `<button type="button" class="btn rank-btn${form.rank === r ? ' selected' : ''}" data-rank="${r}">${main}<small>${sub}</small></button>`;
  }).join('') +
    (onRate ? '' : `<button type="button" class="btn rank-btn tie-toggle" data-action="toggle-tie">${form.tieMode ? '戻す' : '同点'}</button>`);
  renderScorePreview();
}

function renderScorePreview() {
  const onRate = inputIsOnRate();
  const v = scorePad.value();
  scorePad.renderTo($('#score-value'));
  const el = $('#score-preview');
  el.className = 'preview';
  if (v === null) { el.textContent = onRate ? '下のキーで半荘収支を入力（100円単位）' : '下のキーで素点を入力（100点単位）'; return; }
  if (form.rank === null) { el.textContent = onRate ? '順位を選ぶと実収支を表示' : '順位を選ぶとポイントを表示'; return; }
  if (onRate) {
    const net = gameNet(newOnRateGame(activeSession(), form.rank, v));
    el.innerHTML = `${RANK_LABELS[form.rank]} → 実収支 <b class="${ptClass(net)}">${fmtYenSigned(net)}</b>`;
  } else {
    const p = calcPoint(v, form.rank);
    el.innerHTML = `${RANK_LABELS[form.rank]} → <b class="${ptClass(p)}">${fmtPt(p)}</b>`;
  }
}

function gameRowHtml(g, i, opts = {}) {
  let inner;
  if (g.score === null) {
    const net = gameNet(g);
    inner = `<span class="idx">${i + 1}</span><span class="rank">${RANK_LABELS[g.rank]}</span>` +
      `<span class="score">${fmtYenSigned(g.amount)}</span><span class="pt ${ptClass(net)}">${fmtSigned(net)}</span>`;
  } else {
    const p = calcPoint(g.score, g.rank);
    inner = `<span class="idx">${i + 1}</span><span class="rank">${RANK_LABELS[g.rank]}</span>` +
      `<span class="score">${g.score}点</span><span class="pt ${ptClass(p)}">${fmtPt(p)}</span>`;
  }
  if (opts.sid) {
    return `<button type="button" class="game-row" data-action="edit-game" data-sid="${opts.sid}" data-gid="${g.id}">${inner}</button>`;
  }
  if (opts.undo) {
    return `<div class="game-row with-undo">${inner}<button type="button" class="undo-btn" data-action="undo-game">取消</button></div>`;
  }
  return `<div class="game-row">${inner}</div>`;
}

function undoRemaining(g) {
  return g ? UNDO_LIMIT_MS - (Date.now() - Date.parse(g.createdAt)) : 0;
}

let undoTimer = null;
function renderInput() {
  const s = activeSession();
  if (!s) { show('home'); return; }
  const onRate = isOnRate(s);
  $('#input-title').textContent = onRate ? `${SHOPS[s.shop].name}` : TYPES[s.type];
  $('#score-label').textContent = onRate ? '半荘収支' : '素点';
  $('#score-unit').textContent = onRate ? '円' : '点';
  const total = onRate ? sumNet(s.games) : sumPoints(s.games);
  $('#input-summary').innerHTML =
    `<span>${fmtDate(s.date)}</span><span>${s.games.length}半荘</span>` +
    `<span class="${ptClass(total)}">${onRate ? fmtYenSigned(total) : fmtPt(total)}</span>`;
  const last = s.games[s.games.length - 1];
  const remaining = undoRemaining(last);
  $('#game-list').innerHTML = s.games
    .map((g, i) => gameRowHtml(g, i, { undo: g === last && remaining > 0 }))
    .reverse().join('');
  // 取消ボタンの期限が来たら表示を更新する
  clearTimeout(undoTimer);
  if (remaining > 0) {
    undoTimer = setTimeout(() => { if (currentScreen() === 'input') renderInput(); }, remaining + 100);
  }
  renderRankButtons();
  renderSyncBadge();
}

function createSession(extra = {}) {
  const s = Object.assign({
    id: uid(), date: pendingStart.date, type: pendingStart.type, status: 'active',
    venueFee: null, chip: null, games: [], createdAt: nowIso(), updatedAt: nowIso(),
  }, extra);
  data.sessions.push(s);
  saveData();
  pendingStart = null;
  show('input');
  resetForm();
  return s;
}

function selectType(type) {
  pendingStart = { date: $('#type-date').value || todayStr(), type };
  if (type === 'onRateFree') { show('shop'); return; }
  createSession();
}

function selectShop(shop) {
  pendingStart.shop = shop;
  openAmountScreen({
    title: `${SHOPS[shop].name}・開始`,
    note: 'セッション開始時に持っている祝儀チップの額',
    label: '開始チップ',
    step100: true,
    back: () => show('shop'),
    confirmText: v => `開始時の持ちチップ：${fmtYen(v)}`,
    onConfirm: v => createSession({ shop, chipStart: v, chipEnd: null, extraCost: null }),
  });
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
    if (r === 'resume') { show('input'); resetForm(); return; }
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
  const onRate = isOnRate(s);
  const v = scorePad.value();
  if (v === null) { toast(onRate ? '半荘収支を入力してください' : '素点を入力してください'); return; }
  if (v % 100 !== 0) { toast(onRate ? '100円単位で入力してください' : '素点は100点単位です（下2桁は00）'); return; }
  if (form.rank === null) { toast('順位を選んでください'); return; }

  let message;
  let game;
  if (onRate) {
    game = newOnRateGame(s, form.rank, v);
    message = `${RANK_LABELS[form.rank]}・${fmtYenSigned(v)}\n（実収支 ${fmtYenSigned(gameNet(game))}）`;
  } else {
    game = { id: uid(), rank: form.rank, score: v, balance: null, createdAt: nowIso() };
    message = `${RANK_LABELS[form.rank]}・${v}点(${fmtPt(calcPoint(v, form.rank))})`;
  }
  const warnings = gameWarnings(v, form.rank, s, onRate);
  const ok = await dialog(messageWithWarnings(message, warnings), [
    { label: '修正', value: false },
    { label: '確定', value: true, cls: 'btn-primary' },
  ]);
  if (!ok) return;
  game.createdAt = nowIso();
  s.games.push(game);
  touch(s);
  saveData();
  resetForm();
  renderInput();
  toast(`${s.games.length}半荘目を記録しました`);
}

function describeGame(g) {
  return g.score === null ? `${RANK_LABELS[g.rank]}・${fmtYenSigned(g.amount)}` : `${RANK_LABELS[g.rank]}・${g.score}点`;
}

async function undoGame() {
  const s = activeSession();
  const g = s && s.games[s.games.length - 1];
  if (!g) return;
  if (undoRemaining(g) <= 0) {
    toast('10分を過ぎたので、記録一覧から編集してください');
    renderInput();
    return;
  }
  const n = s.games.length;
  const ok = await dialog(`${n}半荘目（${describeGame(g)}）を取り消しますか？`, [
    { label: 'いいえ', value: false },
    { label: '取り消す', value: true, cls: 'danger' },
  ]);
  if (!ok) return;
  s.games.pop();
  touch(s);
  saveData();
  renderInput();
  toast(`${n}半荘目を取り消しました`);
}

// ----- セッション終了 -----
function openEndFlow() {
  const s = activeSession();
  if (!s) return;
  if (isOnRate(s)) openChipEndScreen(s);
  else openFeeScreen(s);
}

function openFeeScreen(s) {
  openAmountScreen({
    title: '場代入力',
    note: '麻雀にかかったお金の合計（場代・ドリンク代など）',
    label: '場代',
    back: () => show('input'),
    showDiscard: s.games.length === 0,
    confirmText: v => `今日の場代：${fmtYen(v)}`,
    onConfirm: v => finishSession(s, { venueFee: v }),
  });
}

function openChipEndScreen(s) {
  openAmountScreen({
    title: '終了時チップ',
    note: `セッション終了時に持っている祝儀チップの額（開始時 ${fmtYen(s.chipStart || 0)}）`,
    label: '終了チップ',
    step100: true,
    back: () => show('input'),
    showDiscard: s.games.length === 0,
    confirmText: v => `終了時の持ちチップ：${fmtYen(v)}\n（チップ収支 ${fmtYenSigned(v - (s.chipStart || 0))}）`,
    onConfirm: v => {
      s.chipEnd = v;
      s.chip = chipDiff(s);
      touch(s);
      saveData();
      openExtraCostScreen(s);
    },
  });
}

function openExtraCostScreen(s) {
  openAmountScreen({
    title: '追加費用',
    note: '追加でかかったお金を入力してください（クーポンなどで減額された場合はマイナスで入力）',
    label: '追加費用',
    allowNegative: true,
    defaultZero: true,
    back: () => openChipEndScreen(s),
    confirmText: v => `追加でかかったお金：${v < 0 ? fmtYenSigned(v) : fmtYen(v)}`,
    onConfirm: v => finishSession(s, { extraCost: v }),
  });
}

function finishSession(s, fields) {
  Object.assign(s, fields);
  s.status = 'done';
  s.endedAt = nowIso();
  touch(s);
  saveData();
  renderResult(s);
  show('result');
}

function renderResult(s) {
  const n = s.games.length;
  if (isOnRate(s)) {
    const money = sessionMoney(s);
    const final = sessionFinal(s);
    const c = rankCounts(s.games);
    $('#result-text').innerHTML =
      `今日は${n}半荘打って<br>順位は${c.join('/')}でした<br>収支は<br><span class="big ${ptClass(money)}">${fmtYenSigned(money)}</span>`;
    $('#result-sub').innerHTML =
      `<span>半荘収支 ${fmtYenSigned(sumNet(s.games))} ／ チップ ${fmtYenSigned(chipDiff(s))}</span>` +
      `<span>追加費用 ${fmtYen(s.extraCost || 0)}</span>` +
      `<span class="final">最終収支 <span class="${ptClass(final)}">${fmtYenSigned(final)}</span></span>`;
  } else {
    const total = sumPoints(s.games);
    $('#result-text').innerHTML =
      `今日は${n}半荘打って<br><span class="big ${ptClass(total)}">${fmtPt(total)}</span><br>でした`;
    $('#result-sub').innerHTML = `<span>場代 ${fmtYen(s.venueFee || 0)}</span>`;
  }
}

async function endSession() {
  if (!activeSession()) return;
  const ok = await dialog('このセッションを終了しますか？', [
    { label: 'いいえ', value: false },
    { label: 'はい', value: true, cls: 'btn-primary' },
  ]);
  if (ok) openEndFlow();
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

// 日付をまたいで放置された進行中セッションの確認
let staleChecked = false;
async function checkStaleSession() {
  const s = activeSession();
  if (!s || staleChecked || isDialogOpen()) return;
  const lastActive = Date.parse(s.updatedAt || s.createdAt || 0);
  if (!(s.date < todayStr() && Date.now() - lastActive > STALE_SESSION_MS)) return;
  staleChecked = true;
  const r = await dialog(
    `${fmtDate(s.date)} ${TYPES[s.type]}（${s.games.length}半荘）のセッションが終了していません`, [
      { label: 'あとで', value: null },
      { label: '続ける', value: 'resume' },
      { label: '終了する', value: 'end', cls: 'btn-primary' },
    ]);
  if (r === 'resume') { show('input'); resetForm(); }
  else if (r === 'end') openEndFlow();
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

function sessionSubHtml(s) {
  const r = sessionResultValue(s);
  const parts = [`<span>${s.games.length}半荘</span>`, `<span class="pt ${ptClass(r)}">${sessionResultText(s)}</span>`];
  if (isOnRate(s)) {
    parts.push(`<span class="muted">チップ ${s.chipEnd == null ? '未入力' : fmtYenSigned(chipDiff(s))}</span>`);
    parts.push(`<span class="muted">追加 ${s.extraCost == null ? '未入力' : fmtYen(s.extraCost)}</span>`);
  } else {
    parts.push(`<span class="muted">場代 ${s.venueFee == null ? '未入力' : fmtYen(s.venueFee)}</span>`);
  }
  return parts.join('');
}

function renderList() {
  const el = $('#tab-list');
  if (!data.sessions.length) { el.innerHTML = '<p class="empty">まだ記録がありません</p>'; return; }
  el.innerHTML = sessionsNewestFirst(data.sessions).map(s => {
    const games = s.games.map((g, i) => gameRowHtml(g, i, { sid: s.id })).join('');
    const shop = isOnRate(s) ? `<span class="tag">${SHOPS[s.shop].name}</span>` : '';
    return `<details class="card session" data-sid="${s.id}"${openSessions.has(s.id) ? ' open' : ''}>
      <summary>
        <div class="s-head"><span class="s-date">${fmtDate(s.date)}</span><span class="tag tag-${s.type}">${TYPES[s.type]}</span>${shop}${s.status === 'active' ? '<span class="tag tag-active">進行中</span>' : ''}</div>
        <div class="s-sub">${sessionSubHtml(s)}</div>
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

function signedInputHtml(cls, unit) {
  return `<div class="score-row">
      <button type="button" class="btn btn-sign"></button>
      <input type="text" inputmode="numeric" pattern="[0-9]*" class="${cls}" autocomplete="off">
      <span class="unit">${unit}</span>
    </div>`;
}

// ±ボタン付きの数値入力欄。read() は null（未入力・不正）か数値を返す
function bindSignedInput(wrap, cls, initial) {
  let negative = initial != null && initial < 0;
  const signBtn = $('.btn-sign', wrap);
  const input = $('.' + cls, wrap);
  const renderS = () => { signBtn.textContent = negative ? '−' : '＋'; signBtn.classList.toggle('negative', negative); };
  signBtn.addEventListener('click', () => { negative = !negative; renderS(); });
  renderS();
  if (initial != null) input.value = Math.abs(initial);
  return () => {
    const v = parseIntStrict(input.value.trim());
    if (v === null) return null;
    if (v < 0) { negative = true; renderS(); }
    return negative ? -Math.abs(v) : v;
  };
}

function gameForm(g, onRate) {
  const wrap = document.createElement('div');
  wrap.className = 'form';
  const ranks = onRate ? [1, 2, 3, 4] : RANKS;
  const rankOption = r => onRate
    ? `<option value="${r}">${RANK_LABELS[r]}</option>`
    : `<option value="${r}">${RANK_LABELS[r]}（${RANK_POINTS[r] > 0 ? '+' : ''}${RANK_POINTS[r]}）</option>`;
  wrap.innerHTML = `<h3>${g ? '半荘を編集' : '半荘を追加'}</h3>
    <div class="field"><span>${onRate ? '半荘収支' : '素点'}</span>${signedInputHtml('f-value', onRate ? '円' : '点')}</div>
    <label class="field"><span>順位</span><select class="f-rank">${ranks.map(rankOption).join('')}</select></label>
    <p class="f-error error"></p>`;
  const readValue = bindSignedInput(wrap, 'f-value', g ? (onRate ? g.amount : g.score) : null);
  const rankSel = $('.f-rank', wrap);
  rankSel.value = g ? String(g.rank) : '1';
  const err = msg => { $('.f-error', wrap).textContent = msg; return null; };
  wrap.read = () => {
    const value = readValue();
    if (value === null) return err(onRate ? '半荘収支を半角数字で入力してください' : '素点を半角数字で入力してください');
    if (value % 100 !== 0) return err(onRate ? '100円単位で入力してください' : '素点は100点単位です（下2桁は00）');
    return { value, rank: Number(rankSel.value) };
  };
  return wrap;
}

// 編集・追加時も矛盾があれば確認する
async function confirmWarnings(r, onRate) {
  const warnings = gameWarnings(r.value, r.rank, null, onRate);
  if (!warnings.length) return true;
  return dialog(messageWithWarnings(`${RANK_LABELS[r.rank]}・${r.value}点`, warnings), [
    { label: '修正', value: false },
    { label: 'このまま保存', value: true, cls: 'btn-primary' },
  ]);
}

async function addGame(t) {
  const s = findSession(t.dataset.sid);
  if (!s) return;
  const onRate = isOnRate(s);
  const f = gameForm(null, onRate);
  const r = await dialog(f, [
    { label: 'キャンセル', value: null },
    { label: '追加', cls: 'btn-primary', validate: f.read },
  ]);
  if (!r || !(await confirmWarnings(r, onRate))) return;
  s.games.push(onRate
    ? newOnRateGame(s, r.rank, r.value)
    : { id: uid(), rank: r.rank, score: r.value, balance: null, createdAt: nowIso() });
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
  const onRate = isOnRate(s);
  const f = gameForm(g, onRate);
  const r = await dialog(f, [
    { label: '削除', value: 'delete', cls: 'danger' },
    { label: 'キャンセル', value: null },
    { label: '保存', cls: 'btn-primary', validate: f.read },
  ]);
  if (!r) return;
  if (r === 'delete') {
    const idx = s.games.indexOf(g);
    const ok = await dialog(`${idx + 1}半荘目（${describeGame(g)}）を削除しますか？`, [
      { label: 'いいえ', value: false },
      { label: '削除する', value: true, cls: 'danger' },
    ]);
    if (!ok) return;
    s.games.splice(idx, 1);
    toast('削除しました');
  } else {
    if (!(await confirmWarnings(r, onRate))) return;
    g.rank = r.rank;
    if (onRate) { g.amount = r.value; g.balance = gameNet(g); }
    else g.score = r.value;
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
  const onRate = isOnRate(s);
  const yenField = (cls, label) =>
    `<label class="field"><span>${label}</span><input type="text" inputmode="numeric" pattern="[0-9]*" class="${cls}" autocomplete="off"></label>`;
  // オンレートとノーレート系では半荘の記録内容が違うので、タイプの行き来はできない
  const typeField = onRate
    ? `<p class="muted small">${TYPES[s.type]}・${SHOPS[s.shop].name}</p>`
    : `<label class="field"><span>対局タイプ</span><select class="f-type">${['set', 'noRateFree'].map(k => `<option value="${k}">${TYPES[k]}</option>`).join('')}</select></label>`;
  const moneyFields = onRate
    ? yenField('f-chip-start', '開始時の持ちチップ（円）') + yenField('f-chip-end', '終了時の持ちチップ（円・空欄で未入力）') +
      `<div class="field"><span>追加費用（円・空欄で未入力）</span>${signedInputHtml('f-extra', '円')}</div>`
    : yenField('f-fee', '場代（円・空欄で未入力）');
  wrap.innerHTML = `<h3>セッションを編集</h3>
    <label class="field"><span>日付</span><input type="date" class="f-date"></label>
    ${typeField}${moneyFields}
    <p class="f-error error"></p>`;
  $('.f-date', wrap).value = s.date;
  let readExtra = null;
  if (onRate) {
    $('.f-chip-start', wrap).value = s.chipStart == null ? '' : s.chipStart;
    $('.f-chip-end', wrap).value = s.chipEnd == null ? '' : s.chipEnd;
    readExtra = bindSignedInput(wrap, 'f-extra', s.extraCost);
    if (s.extraCost == null) $('.f-extra', wrap).value = '';
  } else {
    $('.f-type', wrap).value = s.type;
    $('.f-fee', wrap).value = s.venueFee == null ? '' : s.venueFee;
  }
  const err = msg => { $('.f-error', wrap).textContent = msg; return null; };
  // 空欄は null、不正なら undefined
  const readYen = (cls, step100) => {
    const raw = $('.' + cls, wrap).value.trim();
    if (raw === '') return null;
    const v = parseIntStrict(raw);
    if (v === null || v < 0 || (step100 && v % 100 !== 0)) return undefined;
    return v;
  };
  wrap.read = () => {
    const date = $('.f-date', wrap).value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err('日付を入力してください');
    if (!onRate) {
      const venueFee = readYen('f-fee', false);
      if (venueFee === undefined) return err('場代を半角数字で入力してください');
      return { date, type: $('.f-type', wrap).value, venueFee };
    }
    const chipStart = readYen('f-chip-start', true);
    const chipEnd = readYen('f-chip-end', true);
    if (chipStart === undefined || chipEnd === undefined) return err('持ちチップは100円単位の半角数字で入力してください');
    if (chipStart === null) return err('開始時の持ちチップを入力してください');
    const extraRaw = $('.f-extra', wrap).value.trim();
    const extraCost = extraRaw === '' ? null : readExtra();
    if (extraRaw !== '' && extraCost === null) return err('追加費用を半角数字で入力してください');
    return { date, chipStart, chipEnd, extraCost };
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
    if (isOnRate(s)) s.chip = s.chipEnd == null ? null : chipDiff(s);
    touch(s);
    toast('保存しました');
  }
  saveData();
  renderList();
}

// ----- Data -----
const statsFilter = { period: 'all', type: 'all' };
// Data画面のタイプ絞り込み。noRate は「お金を賭けていないもの」（ノーレートフリー + セット）のまとめ
const TYPE_FILTERS = {
  all: () => true,
  onRateFree: s => s.type === 'onRateFree',
  noRateFree: s => s.type === 'noRateFree',
  set: s => s.type === 'set',
  noRate: s => s.type !== 'onRateFree',
};

function periodSessions() {
  const today = todayStr();
  if (statsFilter.period === '30d') {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    const from = dateStr(d);
    return data.sessions.filter(s => s.date >= from && s.date <= today);
  }
  return data.sessions;
}

function computeStats(sessions) {
  const ordered = sessionsOldestFirst(sessions);
  const games = ordered.flatMap(s => s.games);
  const n = games.length;
  const dist = [0, 0, 0, 0];
  let rankSum = 0;
  for (const g of games) {
    rankSum += g.rank;
    if (Number.isInteger(g.rank)) dist[g.rank - 1] += 1;
    else { dist[Math.floor(g.rank) - 1] += 0.5; dist[Math.ceil(g.rank) - 1] += 0.5; }
  }
  // ポイント・素点はノーレート系（素点あり）の半荘だけで集計
  const ptGames = games.filter(g => g.score !== null);
  const tenths = ptGames.reduce((t, g) => t + pointTenths(g), 0);
  const scoreSum = ptGames.reduce((t, g) => t + g.score, 0);
  // 収支はオンレートのセッションだけで集計
  const moneySessions = ordered.filter(isOnRate);
  const moneyGames = moneySessions.flatMap(s => s.games);
  const net = sumNet(moneyGames);
  const chip = moneySessions.reduce((t, s) => t + chipDiff(s), 0);
  const extra = moneySessions.reduce((t, s) => t + (s.extraCost || 0), 0);
  return {
    games, n, dist,
    sessions: sessions.length,
    avgRank: n ? rankSum / n : 0,
    ptGames, ptN: ptGames.length,
    avgScore: ptGames.length ? scoreSum / ptGames.length : 0,
    total: tenths / 10,
    avgPt: ptGames.length ? tenths / 10 / ptGames.length : 0,
    fee: ordered.filter(s => !isOnRate(s)).reduce((t, s) => t + (s.venueFee || 0), 0),
    hasNoRate: ordered.some(s => !isOnRate(s)),
    moneySessions, moneyN: moneyGames.length,
    net, chip, extra, money: net + chip, final: net + chip - extra,
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

// vals: 0 から始まる累計値の配列
function chartSvg(vals, fmt, xLabel) {
  const W = 340, H = 180, L = 52, R = 10, T = 12, B = 22;
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
  const label = (v, yy) => `<text x="${L - 6}" y="${yy}" text-anchor="end" font-size="11" fill="var(--muted)">${fmt(v)}</text>`;
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img">
    <line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)" stroke-dasharray="4 4"/>
    ${label(max, y(max) + 4)}${min < 0 && max > 0 ? label(0, y(0) + 4) : ''}${label(min, y(min) + 4)}
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>
    ${dots}
    <text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="11" fill="var(--muted)">${vals.length - 1}${xLabel}</text>
    <text x="${L}" y="${H - 6}" font-size="11" fill="var(--muted)">0</text>
  </svg></div>`;
}

function pointChart(games) {
  const vals = [0];
  let acc = 0;
  for (const g of games) { acc += pointTenths(g); vals.push(acc / 10); }
  return chartSvg(vals, fmtPt, '半荘');
}

// 収支はセッション単位（半荘収支 + チップ）で累計
function moneyChart(sessions) {
  const vals = [0];
  let acc = 0;
  for (const s of sessions) { acc += sessionMoney(s); vals.push(acc); }
  return chartSvg(vals, v => fmtSigned(Math.round(v)), '回');
}

function typeTable(sessions) {
  const rows = Object.keys(TYPES).map(k => {
    const st = computeStats(sessions.filter(s => s.type === k));
    if (!st.n) return '';
    const total = k === 'onRateFree'
      ? `<td class="${ptClass(st.money)}">${fmtYenSigned(st.money)}</td>`
      : `<td class="${ptClass(st.total)}">${fmtPt(st.total)}</td>`;
    return `<tr><td>${TYPES[k]}</td><td>${st.n}</td><td>${st.avgRank.toFixed(2)}</td>${total}</tr>`;
  }).join('');
  if (!rows) return '';
  return `<table class="types"><thead><tr><th>タイプ</th><th>半荘</th><th>平均着順</th><th>合計</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderStats() {
  const seg = (action, cur, opts) =>
    `<div class="seg">${opts.map(([v, l]) => `<button class="${cur === v ? 'active' : ''}" data-action="${action}" data-value="${v}">${l}</button>`).join('')}</div>`;
  let html = seg('set-period', statsFilter.period, [['30d', '直近30日'], ['all', '全期間']]) +
    `<div class="seg seg-types">${[
      ['all', '全タイプ'], ['onRateFree', 'オンレート'],
      ['noRateFree', 'ノーレート'], ['set', 'セット'], ['noRate', 'ノーレート+セット'],
    ].map(([v, l]) => `<button class="${statsFilter.type === v ? 'active' : ''}" data-action="set-ftype" data-value="${v}">${l}</button>`).join('')}</div>`;
  const pSessions = periodSessions();
  const sessions = pSessions.filter(TYPE_FILTERS[statsFilter.type]);
  const st = computeStats(sessions);
  if (!st.n) {
    $('#tab-stats').innerHTML = html + '<p class="empty">この条件の記録はありません</p>';
    return;
  }
  const mixed = st.ptN && st.moneyN;
  let grid = statBox('半荘数', `${st.n}<small>（${st.sessions}回）</small>`) + statBox('平均着順', st.avgRank.toFixed(2));
  if (st.moneyN) {
    grid += statBox(mixed ? '収支（オンレート）' : '収支', `<span class="${ptClass(st.money)}">${fmtYenSigned(st.money)}</span>`) +
      statBox('1半荘あたり（チップ除く）', `<span class="${ptClass(st.net / st.moneyN)}">${fmtYenSigned(Math.round(st.net / st.moneyN))}</span>`) +
      statBox('チップ収支', `<span class="${ptClass(st.chip)}">${fmtYenSigned(st.chip)}</span>`) +
      statBox('追加費用込み最終収支', `<span class="${ptClass(st.final)}">${fmtYenSigned(st.final)}</span>`);
  }
  if (st.ptN) {
    grid += statBox(mixed ? '合計pt（ノーレート系）' : '合計ポイント', `<span class="${ptClass(st.total)}">${fmtPt(st.total)}</span>`) +
      statBox('平均ポイント', `<span class="${ptClass(st.avgPt)}">${fmtPt(st.avgPt)}</span>`) +
      statBox('平均素点', fmtNum(Math.round(st.avgScore)) + '<small>点</small>');
  }
  if (st.hasNoRate) grid += statBox('累計場代', fmtYen(st.fee));
  html += `<div class="stat-grid">${grid}</div>`;
  html += '<h3>着順分布</h3>' + distHtml(st);
  if (st.moneyN) html += '<h3>収支の推移（オンレート・チップ込み）</h3>' + moneyChart(st.moneySessions);
  if (st.ptN) html += `<h3>累計ポイント推移${mixed ? '（ノーレート系）' : ''}</h3>` + pointChart(st.ptGames);
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

// 取り込み前チェック。問題があればメッセージを返す
function importProblem(d) {
  if (d && d.version > DATA_VERSION) return '新しいバージョンのアプリで作られたデータです。アプリを更新してから取り込んでください';
  if (!isValidData(d)) return 'このアプリのデータ形式ではありません';
  return null;
}

async function applyImported(d, label) {
  normalizeData(migrateData(d));
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
    data = { version: DATA_VERSION, sessions: d.sessions };
  } else {
    const map = new Map(data.sessions.map(s => [s.id, s]));
    for (const s of d.sessions) {
      const cur = map.get(s.id);
      if (!cur || (s.updatedAt || '') > (cur.updatedAt || '')) map.set(s.id, s);
    }
    data = { version: DATA_VERSION, sessions: [...map.values()] };
  }
  normalizeData(data);
  saveData();
  renderSettings();
  toast('取り込みました');
}

async function saveBackupSettings() {
  const url = $('#backup-url').value.trim();
  if (url && !/^https:\/\//.test(url)) { toast('URLは https:// で始まる必要があります'); return; }
  settings.backupUrl = url;
  settings.token = $('#backup-token').value.trim();
  settings.lastSyncError = '';
  saveSettings();
  renderSyncUI();
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
    const problem = importProblem(j.data);
    if (problem) throw new Error(problem);
    await applyImported(j.data, `クラウド：セッション${j.data.sessions.length}件`);
  } catch (e) {
    await dialog('クラウドから取得できませんでした\n' + (e.message || e), OK_BUTTON);
  }
}

// ---------- アプリ更新 ----------
let waitingWorker = null;
let updateRequested = false;

function showUpdateBanner(worker) {
  waitingWorker = worker;
  $('#update-banner').hidden = false;
}

function applyUpdate() {
  if (!waitingWorker) { location.reload(); return; }
  updateRequested = true;
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
}

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // 「更新する」を押したときだけ再読み込みする（初回インストール時の切り替えでは読み込み直さない）
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateRequested) return;
    updateRequested = false;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').then(reg => {
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(w);
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});
}

// ---------- エラー表示 ----------
function showFatalError(message) {
  $('#error-detail').textContent = message;
  $('#error-bar').hidden = false;
}
window.addEventListener('error', e => showFatalError(e.message || String(e.error)));
window.addEventListener('unhandledrejection', e => showFatalError(String((e.reason && e.reason.message) || e.reason)));

// ---------- events ----------
const actions = {
  home: () => show('home'),
  'go-input': goInput,
  'go-review': () => show('review'),
  'go-settings': () => { currentTab = 'settings'; show('review'); },
  resume: () => { show('input'); resetForm(); },
  'back-type': () => show('type'),
  'toggle-tie': () => { form.tieMode = !form.tieMode; form.rank = null; renderRankButtons(); },
  'confirm-game': confirmGame,
  'undo-game': undoGame,
  'end-session': endSession,
  'amount-back': () => { if (amountCfg) amountCfg.back(); },
  'amount-confirm': amountConfirm,
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
  'apply-update': applyUpdate,
};

// 処理中（ダイアログ表示中など）に別の操作が走らないようにする
let busy = false;
document.addEventListener('click', e => {
  if (e.target.closest('#modal')) return;
  const t = e.target.closest('[data-action],[data-type],[data-shop],[data-rank],[data-tab]');
  if (!t || t.disabled || busy) return;
  if (t.dataset.type) { selectType(t.dataset.type); return; }
  if (t.dataset.shop) { selectShop(t.dataset.shop); return; }
  if (t.dataset.rank) { form.rank = Number(t.dataset.rank); renderRankButtons(); return; }
  if (t.dataset.tab) { switchTab(t.dataset.tab); return; }
  const fn = actions[t.dataset.action];
  if (!fn) return;
  const r = fn(t, e);
  if (r && typeof r.then === 'function') {
    busy = true;
    r.finally(() => { busy = false; });
  }
});

$('#tab-list').addEventListener('toggle', e => {
  const d = e.target;
  if (!d.dataset || !d.dataset.sid) return;
  if (d.open) openSessions.add(d.dataset.sid); else openSessions.delete(d.dataset.sid);
}, true);

$('#import-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let d;
  try { d = JSON.parse(await file.text()); }
  catch (err) { await dialog('JSONファイルを読み込めませんでした', OK_BUTTON); return; }
  const problem = importProblem(d);
  if (problem) { await dialog(problem, OK_BUTTON); return; }
  await applyImported(d, `ファイル：セッション${d.sessions.length}件`);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (settings.pending) syncNow();
  if (currentScreen() === 'home') renderHome();
  checkStaleSession();
});

// ---------- init ----------
scorePad = createKeypad($('#score-keypad'), renderScorePreview);
amountPad = createKeypad($('#amount-keypad'), renderAmountPreview);
$('#app-version').textContent = APP_VERSION;
resetForm();
show('home');
setupServiceWorker();
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}
if (settings.pending) syncNow();
if (loadProblem) {
  dialog(loadProblem === 'newer'
    ? '保存データが新しいバージョンのアプリで作られています。アプリを更新してください。\n（元のデータは端末内に退避してあります）'
    : '保存データの一部が読み込めませんでした。1つ前の保存状態から復元しています。\n（元のデータは端末内に退避してあります）', OK_BUTTON)
    .then(checkStaleSession);
} else {
  checkStaleSession();
}
