'use strict';
// 着せ替え: 背景・メイン・アクセントの3色を変えるパネル（設定タブの「色の設定」から開く）
// 背景10色 × メイン10色 × アクセント10色 = 1000通りから選べ、RGBで細かく調整もできる。
// <head> で読み込み、画面を描く前に色を当てる（起動時に初期色がちらつかないように）。
// メインとアクセントは「色の種類」で選び、濃さは背景の濃い/薄いに合わせて自動で切り替える
(function () {
  const KEY = 'mjr.theme.v1';

  // 背景: 前半5つが濃いグループ、後半5つが薄いグループ
  const BGS = [
    { name: '黒', c: [10, 10, 12], light: false },
    { name: '濃い赤', c: [42, 10, 16], light: false },
    { name: '濃い青', c: [8, 20, 52], light: false },
    { name: '濃い黄', c: [40, 34, 8], light: false },
    { name: '濃い緑', c: [6, 36, 26], light: false },
    { name: '薄い赤', c: [253, 236, 238], light: true },
    { name: '薄い青', c: [234, 242, 252], light: true },
    { name: '薄い黄', c: [253, 248, 224], light: true },
    { name: '薄い緑', c: [234, 246, 236], light: true },
    { name: '白', c: [255, 255, 255], light: true },
  ];
  // メイン（文字・枠）: 目が疲れないよう少し落ち着かせた色。dark = 濃い背景用、light = 薄い背景用
  const MAINS = [
    { name: '白/黒', dark: [240, 240, 240], light: [28, 28, 32] },
    { name: '赤', dark: [255, 110, 110], light: [180, 20, 35] },
    { name: 'オレンジ', dark: [255, 160, 70], light: [190, 85, 0] },
    { name: '金', dark: [225, 195, 120], light: [140, 105, 20] },
    { name: '黄', dark: [255, 232, 60], light: [130, 110, 0] },
    { name: '緑', dark: [110, 220, 150], light: [20, 120, 60] },
    { name: '水色', dark: [100, 215, 245], light: [0, 115, 150] },
    { name: '青', dark: [130, 170, 255], light: [30, 60, 170] },
    { name: '紫', dark: [190, 150, 255], light: [90, 50, 170] },
    { name: 'ピンク', dark: [255, 130, 200], light: [185, 30, 110] },
  ];
  // アクセント（目立たせたいところ）: メインより鮮やか
  const ACCENTS = [
    { name: '白/黒', dark: [255, 255, 255], light: [0, 0, 0] },
    { name: '赤', dark: [255, 60, 70], light: [215, 15, 30] },
    { name: 'オレンジ', dark: [255, 140, 30], light: [225, 95, 0] },
    { name: '金', dark: [240, 200, 80], light: [165, 120, 0] },
    { name: '黄', dark: [255, 240, 0], light: [160, 135, 0] },
    { name: '緑', dark: [60, 230, 120], light: [0, 150, 70] },
    { name: '水色', dark: [40, 215, 255], light: [0, 140, 190] },
    { name: '青', dark: [70, 130, 255], light: [20, 70, 220] },
    { name: '紫', dark: [170, 100, 255], light: [120, 50, 210] },
    { name: 'ピンク', dark: [255, 70, 180], light: [210, 20, 130] },
  ];

  const ITEMS = [
    { v: '--bg', label: '背景', note: '画面の地の色', list: BGS },
    { v: '--primary', label: 'メイン', note: '文字・枠・数値', list: MAINS },
    { v: '--accent', label: 'アクセント', note: '選択中・収支・警告など', list: ACCENTS },
  ];
  // 最初の色: ほぼ黒 × 青 × 赤（RGBで決めた色なので、パネルでは「カスタム」と表示される）
  const DEFAULT_SEL = { '--bg': null, '--primary': null, '--accent': null };
  const DEFAULT_CUSTOM = { '--bg': [20, 20, 20], '--primary': [54, 52, 255], '--accent': [185, 48, 48] };

  const root = document.documentElement;
  const hex = c => '#' + c.map(n => n.toString(16).padStart(2, '0')).join('');
  const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;

  // sel: 選んだ色の番号。null のときは RGB で細かく調整した色（custom）を使う
  let sel = Object.assign({}, DEFAULT_SEL);
  let custom = Object.assign({}, DEFAULT_CUSTOM);
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved) { sel = Object.assign(sel, saved.sel); custom = Object.assign(custom, saved.custom); }
  } catch (e) {}

  const isLight = () => sel['--bg'] != null ? BGS[sel['--bg']].light : lum(custom['--bg']) > 140;
  const colorOf = v => {
    if (sel[v] == null) return custom[v];
    const it = ITEMS.find(i => i.v === v).list[sel[v]];
    return v === '--bg' ? it.c : (isLight() ? it.light : it.dark);
  };

  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ sel, custom })); } catch (e) {} };
  const apply = () => {
    ITEMS.forEach(it => root.style.setProperty(it.v, `rgb(${colorOf(it.v).join(', ')})`));
    // 背景が明るいときは、補足文字・枠を濃くし、日付入力などの部品も明るい配色にする
    const light = isLight();
    root.style.colorScheme = light ? 'light' : 'dark';
    root.dataset.bg = light ? 'light' : 'dark';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = hex(colorOf('--bg'));
  };
  apply();

  document.addEventListener('DOMContentLoaded', () => {
    const css = document.createElement('style');
    css.textContent = `
      #pc-panel { position: fixed; left: 8px; right: 8px; bottom: 8px; z-index: 901; max-width: 480px; margin: 0 auto;
        max-height: calc(100vh - 16px); max-height: calc(100dvh - 16px); overflow-y: auto;
        background: #1c1c1e; color: #eee; border: 1px solid #555; border-radius: 14px; padding: 12px 14px;
        font: 14px/1.4 -apple-system, "Yu Gothic UI", "Meiryo", sans-serif; box-shadow: 0 6px 30px rgba(0,0,0,.7); }
      #pc-panel[hidden] { display: none; }
      #pc-panel * { all: revert; box-sizing: border-box; font: inherit; color: inherit; }
      #pc-panel input { background-image: none !important; clip-path: none; }
      #pc-panel .pc-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
      #pc-panel .pc-head b { font-weight: 700; font-size: 15px; }
      #pc-panel .pc-item { border-top: 1px solid #333; padding: 8px 0; }
      #pc-panel .pc-title { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
      #pc-panel .pc-title b { font-weight: 700; }
      #pc-panel .pc-title small { color: #999; font-size: 12px; }
      #pc-panel .pc-cur { margin-left: auto; color: #ddd; font-size: 12px; }
      #pc-panel .pc-chips { display: grid; grid-template-columns: repeat(5, 1fr); gap: 5px; }
      #pc-panel .pc-chip { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px 2px 3px;
        background: #2a2a2c; border: 2px solid transparent; border-radius: 8px; cursor: pointer; }
      #pc-panel .pc-chip.on { border-color: #fff; background: #3a3a3e; }
      #pc-panel .pc-sw { display: flex; align-items: center; justify-content: center; width: 100%; height: 24px;
        border-radius: 4px; border: 1px solid #555; }
      #pc-panel .pc-sw i { display: block; width: 14px; height: 14px; border-radius: 50%; }
      #pc-panel .pc-chip span { font-size: 11px; white-space: nowrap; }
      #pc-panel details { margin-top: 6px; }
      #pc-panel summary { cursor: pointer; color: #aaa; font-size: 12px; }
      #pc-panel .pc-rgbhead { display: flex; align-items: center; gap: 8px; margin: 6px 0 4px; }
      #pc-panel input[type=color] { width: 36px; height: 24px; padding: 0; border: 1px solid #666; background: none; cursor: pointer; }
      #pc-panel .pc-code { margin-left: auto; color: #bbb; font-family: Consolas, monospace; font-size: 12px; user-select: all; }
      #pc-panel .pc-row { display: grid; grid-template-columns: 14px 1fr 52px; gap: 8px; align-items: center; }
      #pc-panel .pc-row span { font-family: Consolas, monospace; font-weight: 700; }
      #pc-panel input[type=range] { width: 100%; margin: 0; }
      #pc-panel input[type=number] { width: 52px; padding: 2px 4px; background: #111; border: 1px solid #555; border-radius: 4px; text-align: right; }
      #pc-panel button { padding: 4px 12px; background: #333; border: 1px solid #666; border-radius: 6px; cursor: pointer; }
      #pc-panel .pc-foot { display: flex; gap: 8px; justify-content: space-between; align-items: center; border-top: 1px solid #333; padding-top: 8px; }
      #pc-panel .pc-foot small { color: #999; font-size: 12px; }
    `;
    document.head.appendChild(css);

    const panel = document.createElement('div');
    panel.id = 'pc-panel'; panel.hidden = true;
    panel.innerHTML = `<div class="pc-head"><b>色の設定</b><button data-pc="close">閉じる</button></div>` +
      ITEMS.map(it => `<div class="pc-item" data-var="${it.v}">
        <div class="pc-title"><b>${it.label}</b><small>${it.note}</small><span class="pc-cur"></span></div>
        <div class="pc-chips">${it.list.map((c, i) =>
          `<button class="pc-chip" data-i="${i}" title="${c.name}"><span class="pc-sw"><i></i></span><span>${c.name}</span></button>`).join('')}</div>
        <details><summary>RGBで細かく調整</summary>
          <div class="pc-rgbhead"><input type="color"><span class="pc-code"></span></div>
          ${['R', 'G', 'B'].map((ch, k) => `<div class="pc-row"><span>${ch}</span>
            <input type="range" min="0" max="255" data-k="${k}"><input type="number" min="0" max="255" data-k="${k}"></div>`).join('')}
        </details>
      </div>`).join('') +
      `<div class="pc-foot"><small>背景 10 × メイン 10 × アクセント 10 通り</small><button data-pc="reset">最初の色に戻す</button></div>`;
    document.body.append(panel);

    const render = () => {
      const bg = colorOf('--bg');
      const light = isLight();
      panel.querySelectorAll('.pc-item').forEach(el => {
        const v = el.dataset.var;
        const item = ITEMS.find(i => i.v === v);
        // 色見本: 背景は色そのもの。メイン・アクセントは今の背景の上に、実際に使う濃さの丸を置く
        el.querySelectorAll('.pc-chip').forEach(chip => {
          const c = item.list[chip.dataset.i];
          const sw = chip.querySelector('.pc-sw'), dot = chip.querySelector('i');
          if (v === '--bg') { sw.style.background = `rgb(${c.c})`; dot.style.display = 'none'; }
          else { sw.style.background = `rgb(${bg})`; dot.style.background = `rgb(${light ? c.light : c.dark})`; }
          chip.classList.toggle('on', sel[v] === Number(chip.dataset.i));
        });
        const c = colorOf(v);
        el.querySelector('.pc-cur').textContent = sel[v] == null ? 'カスタム' : item.list[sel[v]].name;
        el.querySelector('input[type=color]').value = hex(c);
        el.querySelector('.pc-code').textContent = `rgb(${c.join(', ')})`;
        el.querySelectorAll('[data-k]').forEach(inp => { if (document.activeElement !== inp) inp.value = c[inp.dataset.k]; });
      });
    };

    // RGB を動かしたら、その色は「カスタム」になる（背景を変えても自動では切り替わらない）
    panel.addEventListener('input', e => {
      const el = e.target.closest('.pc-item');
      if (!el) return;
      const v = el.dataset.var;
      const c = colorOf(v).slice();
      if (e.target.type === 'color') {
        const h = e.target.value;
        [1, 3, 5].forEach((p, k) => { c[k] = parseInt(h.slice(p, p + 2), 16); });
      } else {
        c[e.target.dataset.k] = Math.max(0, Math.min(255, parseInt(e.target.value, 10) || 0));
      }
      custom[v] = c; sel[v] = null;
      apply(); save(); render();
    });
    panel.addEventListener('click', e => {
      const chip = e.target.closest('.pc-chip');
      if (chip) { sel[chip.closest('.pc-item').dataset.var] = Number(chip.dataset.i); apply(); save(); render(); return; }
      const a = e.target.dataset.pc;
      if (a === 'close') panel.hidden = true;
      if (a === 'reset') { sel = Object.assign({}, DEFAULT_SEL); custom = Object.assign({}, DEFAULT_CUSTOM); apply(); save(); render(); }
    });
    const open = document.getElementById('theme-open');
    if (open) open.addEventListener('click', () => { panel.hidden = false; render(); });
  });
})();
