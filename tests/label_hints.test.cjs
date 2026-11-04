'use strict';

// 測試：欄位標籤說明圖示（欄位標籤說明圖示_20261104.js，上傳到規則主檔 App）
//   1. splitLabel：全形、半形、混用、無括號、括號不在結尾、空字串、巢狀
//   2. 假 DOM 上跑 index.show／detail.show／create.show／edit.show：欄名換掉、有問號、hint 正確
//   3. 重複觸發不會重複加問號；找不到 DOM 不丟錯；有子元素（排序圖示）的標籤不動
//   4. 點問號 stopPropagation；CSS 有對應的 class
// 單獨執行：node tests/label_hints.test.cjs

const assert = require('assert');
const vm = require('vm');
const { createRunner, readSrc } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('label_hints.test.cjs');

/** 最小假元素：夠 decorate 用 */
const makeEl = (tag = 'span', text = '') => {
  const classes = new Set();
  const el = {
    tag,
    className: '',
    textContent: text,
    children: [],
    parentElement: null,
    attributes: {},
    listeners: {},
    classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) },
    setAttribute(k, v) {
      el.attributes[k] = String(v);
    },
    addEventListener(type, fn) {
      el.listeners[type] = fn;
    },
    appendChild(child) {
      child.parentElement = el;
      el.children.push(child);
      return child;
    },
  };
  return el;
};
/** 假 document：只做 createElement 與 querySelectorAll(selector) */
const makeDoc = (labelsBySelector) => ({
  createElement: (tag) => makeEl(tag),
  querySelectorAll: (sel) => labelsBySelector[sel] || [],
});

/** 載入模組（沙箱）；回傳 { api, fire, document } */
const load = (labelsBySelector) => {
  const handlers = {};
  const document = makeDoc(labelsBySelector);
  const sandbox = {
    window: { PR_KT: { on: (type, fn) => (handlers[type] = fn) } },
    document,
    console: { log: () => {}, warn: () => {}, error: () => {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(readSrc('欄位標籤說明圖示_20261104.js'), sandbox, { filename: '欄位標籤說明圖示_20261104.js' });
  return { api: sandbox.window.PR_LABEL_HINTS, handlers, document, sandbox };
};

const base = load({});
const splitLabel = (t) => JSON.parse(JSON.stringify(base.api.splitLabel(t))); // vm 跨 realm 物件，轉一手才能 deepStrictEqual
const LIST_SEL = base.api.LIST_LABEL_SELECTOR;
const REC_SEL = base.api.RECORD_LABEL_SELECTOR;

// ── 1. splitLabel ────────────────────────────────────────────────────────────
check('splitLabel：全形括號', () => {
  assert.deepStrictEqual(splitLabel('名稱（與 749 下拉選項一字不差）'), { title: '名稱', hint: '與 749 下拉選項一字不差' });
  assert.deepStrictEqual(splitLabel('固定賣方統編（交通工具用；有填就自動帶入並鎖住）'), { title: '固定賣方統編', hint: '交通工具用；有填就自動帶入並鎖住' });
});
check('splitLabel：半形括號、混用', () => {
  assert.deepStrictEqual(splitLabel('名稱(說明)'), { title: '名稱', hint: '說明' });
  assert.deepStrictEqual(splitLabel('名稱（說明)'), { title: '名稱', hint: '說明' });
  assert.deepStrictEqual(splitLabel('名稱(說明）'), { title: '名稱', hint: '說明' });
});
check('splitLabel：前後空白會 trim，括號前有空白也去掉', () => {
  assert.deepStrictEqual(splitLabel('  交通工具規則 （交通工具用） '), { title: '交通工具規則', hint: '交通工具用' });
});
check('splitLabel：沒有括號、空字串、null 不處理', () => {
  assert.deepStrictEqual(splitLabel('名稱'), { title: '名稱', hint: '' });
  assert.deepStrictEqual(splitLabel(''), { title: '', hint: '' });
  assert.deepStrictEqual(splitLabel(null), { title: '', hint: '' });
  assert.deepStrictEqual(splitLabel(undefined), { title: '', hint: '' });
});
check('splitLabel：括號不在結尾、括號是空的、開頭就是括號 → 不處理', () => {
  assert.strictEqual(splitLabel('金額（含稅）合計').hint, '');
  assert.strictEqual(splitLabel('A（x）B（y）').hint, '');
  assert.strictEqual(splitLabel('名稱（）').hint, '');
  assert.strictEqual(splitLabel('（說明）').hint, '');
  assert.strictEqual(splitLabel('名稱（說明').hint, '');
  assert.strictEqual(splitLabel('名稱說明）').hint, '');
  assert.strictEqual(splitLabel('金額（含稅）合計').title, '金額（含稅）合計');
});
check('splitLabel：括號內再有括號以最外層為準', () => {
  assert.deepStrictEqual(splitLabel('名稱（說明（補充）更多）'), { title: '名稱', hint: '說明（補充）更多' });
  assert.deepStrictEqual(splitLabel('名稱(a(b)c)'), { title: '名稱', hint: 'a(b)c' });
  assert.deepStrictEqual(splitLabel('名稱（a(b）c)'), { title: '名稱', hint: 'a(b）c' });
});
check('splitLabel：必填 * 是另外的元素，標籤文字不含 *；真的含 * 結尾就不處理', () => {
  assert.strictEqual(splitLabel('名稱（說明）*').hint, '');
});

// ── 2. 假 DOM ────────────────────────────────────────────────────────────────
const buildHeader = (texts) =>
  texts.map((t) => {
    const label = makeEl('span', t);
    const cell = makeEl('th');
    const row = makeEl('tr');
    cell.appendChild(label);
    row.appendChild(cell);
    return label;
  });

check('index.show：欄名只留括號前、加問號、hint 正確、無括號的欄名不動', async () => {
  const labels = buildHeader(['名稱（與 749 下拉選項一字不差）', '類型', '可選憑證種類（交通工具用；全不勾＝不限制）']);
  const m = load({ [LIST_SEL]: labels });
  assert.deepStrictEqual(Object.keys(m.handlers).sort(), ['app.record.create.show', 'app.record.detail.show', 'app.record.edit.show', 'app.record.index.show']);
  const event = { type: 'app.record.index.show' };
  assert.strictEqual(m.handlers['app.record.index.show'](event), event);
  assert.strictEqual(labels[0].textContent, '名稱');
  assert.strictEqual(labels[1].textContent, '類型');
  assert.strictEqual(labels[2].textContent, '可選憑證種類');
  assert.strictEqual(labels[1].children.length, 0);
  const icon = labels[0].children[0];
  assert.strictEqual(icon.className, 'pr-label-hint');
  assert.strictEqual(icon.textContent, '?');
  assert.strictEqual(icon.attributes['data-pr-hint'], '與 749 下拉選項一字不差');
  assert.strictEqual(icon.attributes['aria-label'], '與 749 下拉選項一字不差');
  assert.strictEqual(icon.attributes.tabindex, '0');
  assert.strictEqual(icon.attributes.title, undefined, '不設 title，免得出現兩個 tooltip');
  assert.strictEqual(labels[2].children[0].attributes['data-pr-hint'], '交通工具用；全不勾＝不限制');
  // 祖先加 host class（解 overflow:hidden）
  assert.ok(labels[0].parentElement.classList.contains('pr-label-hint-host'));
});

['app.record.detail.show', 'app.record.create.show', 'app.record.edit.show'].forEach((type) => {
  check(`${type}：記錄畫面標籤也處理（用 .control-label-text-gaia）`, () => {
    const labels = buildHeader(['固定格式（交通工具用；要和固定賣方統編一起填）', '說明']);
    const m = load({ [REC_SEL]: labels, [LIST_SEL]: buildHeader(['不該被動到（x）']) });
    m.handlers[type]({ type });
    assert.strictEqual(labels[0].textContent, '固定格式');
    assert.strictEqual(labels[0].children[0].attributes['data-pr-hint'], '交通工具用；要和固定賣方統編一起填');
    assert.strictEqual(labels[1].children.length, 0);
    assert.strictEqual(m.document.querySelectorAll(LIST_SEL)[0].textContent, '不該被動到（x）');
  });
});

// ── 3. 重複、找不到、有子元素 ─────────────────────────────────────────────────
check('重複觸發（換頁、排序、篩選）不會重複加問號', () => {
  const labels = buildHeader(['名稱（說明）']);
  const m = load({ [LIST_SEL]: labels });
  m.handlers['app.record.index.show']({});
  m.handlers['app.record.index.show']({});
  m.handlers['app.record.index.show']({});
  assert.strictEqual(labels[0].children.length, 1);
  assert.strictEqual(labels[0].textContent, '名稱');
});

check('找不到 DOM（selector 沒有元素、querySelectorAll 回 null、root 壞掉）不丟錯', () => {
  const m = load({});
  assert.doesNotThrow(() => m.handlers['app.record.index.show']({}));
  assert.strictEqual(m.api.decorate(null, LIST_SEL, m.document), 0);
  assert.strictEqual(m.api.decorate({}, LIST_SEL, m.document), 0);
  assert.strictEqual(m.api.decorate({ querySelectorAll: () => null }, LIST_SEL, m.document), 0);
});

check('事件處理程式內部出錯只 warn、仍回傳 event', () => {
  const m = load({});
  m.document.querySelectorAll = () => {
    throw new Error('boom');
  };
  const event = { a: 1 };
  assert.strictEqual(m.handlers['app.record.detail.show'](event), event);
});

check('標籤裡有子元素（例如排序圖示）→ 不動', () => {
  const label = makeEl('span', '名稱（說明）');
  label.appendChild(makeEl('i'));
  const m = load({ [LIST_SEL]: [label] });
  m.handlers['app.record.index.show']({});
  assert.strictEqual(label.textContent, '名稱（說明）');
  assert.strictEqual(label.children.length, 1);
});

check('沒有 PR_KT 時只 console.error，不丟錯；PR_LABEL_HINTS 仍匯出', () => {
  const errors = [];
  const sandbox = { window: {}, document: makeDoc({}), console: { log() {}, warn() {}, error: (m) => errors.push(m) } };
  vm.createContext(sandbox);
  assert.doesNotThrow(() => vm.runInContext(readSrc('欄位標籤說明圖示_20261104.js'), sandbox));
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(typeof sandbox.window.PR_LABEL_HINTS.splitLabel, 'function');
});

// ── 4. 點問號、CSS ───────────────────────────────────────────────────────────
check('點問號：stopPropagation＋preventDefault（不觸發欄位排序）', () => {
  const labels = buildHeader(['名稱（說明）']);
  const m = load({ [LIST_SEL]: labels });
  m.handlers['app.record.index.show']({});
  const calls = [];
  labels[0].children[0].listeners.click({ stopPropagation: () => calls.push('stop'), preventDefault: () => calls.push('prevent') });
  assert.deepStrictEqual(calls, ['stop', 'prevent']);
});

check('CSS：.pr-label-hint 圖標、::after tooltip（attr(data-pr-hint)）、:focus-visible、host overflow', () => {
  const css = readSrc('payment_request.css');
  assert.ok(/\.pr-label-hint\s*\{/.test(css));
  assert.ok(/\.pr-label-hint::after\s*\{[^}]*content:\s*attr\(data-pr-hint\)/.test(css));
  assert.ok(/\.pr-label-hint:focus-visible::after/.test(css));
  assert.ok(/\.pr-label-hint:hover::after/.test(css));
  assert.ok(/\.pr-label-hint-host\s*\{[^}]*overflow:\s*visible/.test(css));
  assert.ok(/max-width:\s*280px/.test(css));
});

check('只套 752：不在 src 入口（不進 749 bundle）、JS 沒有寫死樣式', () => {
  assert.ok(!readSrc('src/index.js').includes('欄位標籤說明圖示'));
  assert.ok(!readSrc('src/mobile.js').includes('欄位標籤說明圖示'));
  const src = readSrc('欄位標籤說明圖示_20261104.js');
  assert.ok(!/\.style\b|cssText|style="|createElement\(['"]style/.test(src));
});

done();
