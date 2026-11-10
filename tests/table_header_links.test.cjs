'use strict';

// 測試：交通費明細表頭的說明文件連結（表頭查詢連結_20261105.js）
//   1. splitByLinks：單一連結、兩個連結中間留分隔字、找不到的略過
//   2. 假 DOM：連結屬性正確、表頭文字不變、必填 * 留著、不相關的表頭不動
//   3. 重複觸發不重複加；畫面還沒畫好會重試；列印頁不綁、找不到表頭不丟錯
//   4. 模組只進桌面版、CSS 有對應的 class
// 單獨執行：node tests/table_header_links.test.cjs

const assert = require('assert');
const vm = require('vm');
const { createRunner, readSrc } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('table_header_links.test.cjs');

const FILE = '表頭查詢連結_20261105.js';
const INVOICE_LABEL = '發票號碼／高鐵票號';
const LAYOUT = {
  COLUMNS: [
    { code: '金額', label: '金額（含稅）' },
    { code: '發票號碼', label: INVOICE_LABEL },
    { code: '賣方統編', label: '賣方統編' },
  ],
  HEADER_LINKS: {
    發票號碼: [
      { text: '發票號碼', url: 'https://invoice.example/', title: '查發票' },
      { text: '高鐵票號', url: 'https://ticket.example/', title: '查車票' },
    ],
    賣方統編: [{ text: '賣方統編', url: 'https://tax.example/' }],
  },
};

const makeText = (value) => ({ nodeType: 3, nodeValue: value, parentNode: null, get textContent() { return this.nodeValue; } });

const makeEl = (tag) => {
  const classes = new Set();
  const el = {
    nodeType: 1,
    tag,
    className: '',
    childNodes: [],
    attributes: {},
    parentNode: null,
    classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) },
    setAttribute(k, v) {
      el.attributes[k] = String(v);
    },
    appendChild(child) {
      child.parentNode = el;
      el.childNodes.push(child);
      return child;
    },
    insertBefore(child, ref) {
      child.parentNode = el;
      el.childNodes.splice(el.childNodes.indexOf(ref), 0, child);
      return child;
    },
    removeChild(child) {
      el.childNodes.splice(el.childNodes.indexOf(child), 1);
      return child;
    },
    get textContent() {
      return el.childNodes.map((n) => n.textContent).join('');
    },
    set textContent(value) {
      el.childNodes = [makeText(value)];
    },
  };
  return el;
};

/** 一格 kintone 表頭：th > span > 文字，必填多一個放 * 的 span */
const makeTh = (label, required) => {
  const th = makeEl('th');
  const inner = makeEl('span');
  inner.appendChild(makeText(label));
  th.appendChild(inner);
  if (required) {
    const star = makeEl('span');
    star.appendChild(makeText('*'));
    th.appendChild(star);
  }
  return th;
};

const linksOf = (th) => th.childNodes[0].childNodes.filter((n) => n.tag === 'a');

/** 載入模組（沙箱）；headers 可以之後再塞，模擬畫面還沒畫好 */
const load = (headers = []) => {
  const handlers = {};
  const timers = [];
  const state = { headers };
  const document = {
    createElement: (tag) => makeEl(tag),
    createTextNode: (value) => makeText(value),
    querySelectorAll: () => state.headers,
  };
  const sandbox = {
    window: {
      PR_CONFIG: { TRAFFIC_TABLE_LAYOUT: LAYOUT },
      PR_KT: { on: (types, fn) => types.forEach((type) => (handlers[type] = fn)) },
    },
    document,
    setTimeout: (fn) => timers.push(fn),
    console: { log: () => {}, warn: () => {}, error: () => {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(readSrc(FILE), sandbox, { filename: FILE });
  return { api: sandbox.window.PR_TABLE_HEADER_LINKS, handlers, timers, state, document };
};

const plain = (value) => JSON.parse(JSON.stringify(value)); // vm 跨 realm 物件，轉一手才能 deepStrictEqual

check('splitByLinks：單一連結整段都是連結', () => {
  const { api } = load();
  assert.deepStrictEqual(plain(api.splitByLinks('賣方統編', LAYOUT.HEADER_LINKS.賣方統編)), [{ text: '賣方統編', url: 'https://tax.example/' }]);
});

check('splitByLinks：兩個連結，中間的分隔字留成一般文字', () => {
  const { api } = load();
  const segments = plain(api.splitByLinks(INVOICE_LABEL, LAYOUT.HEADER_LINKS.發票號碼));
  assert.deepStrictEqual(segments.map((s) => s.text), ['發票號碼', '／', '高鐵票號']);
  assert.deepStrictEqual(segments.map((s) => s.url), ['https://invoice.example/', undefined, 'https://ticket.example/']);
});

check('splitByLinks：找不到連結文字 → 略過，文字維持原樣', () => {
  const { api } = load();
  assert.deepStrictEqual(plain(api.splitByLinks('其他文字', LAYOUT.HEADER_LINKS.賣方統編)), [{ text: '其他文字' }]);
});

check('畫面：連結另開新分頁且帶 noopener，表頭文字與必填 * 不變，其他表頭不動', () => {
  const invoice = makeTh(INVOICE_LABEL);
  const tax = makeTh('賣方統編', true);
  const amount = makeTh('金額（含稅）', true);
  const m = load([amount, invoice, tax]);
  const event = { type: 'app.record.edit.show' };
  assert.strictEqual(m.handlers['app.record.edit.show'](event), event);

  const [first, second] = linksOf(invoice);
  assert.strictEqual(first.textContent, '發票號碼');
  assert.strictEqual(first.className, 'pr-header-link');
  assert.deepStrictEqual(first.attributes, { href: 'https://invoice.example/', target: '_blank', rel: 'noopener noreferrer', title: '查發票' });
  assert.strictEqual(second.attributes.href, 'https://ticket.example/');
  assert.strictEqual(invoice.textContent, INVOICE_LABEL, '文字不變，main 才找得到這一欄');

  assert.strictEqual(linksOf(tax)[0].attributes.href, 'https://tax.example/');
  assert.strictEqual(linksOf(tax)[0].attributes.title, undefined, '沒設定 title 就不加');
  assert.strictEqual(tax.textContent, '賣方統編*');
  assert.strictEqual(amount.childNodes[0].childNodes[0].nodeType, 3, '沒設定連結的表頭維持文字');
});

check('重複觸發不會重複加連結', () => {
  const invoice = makeTh(INVOICE_LABEL);
  const m = load([invoice]);
  m.handlers['app.record.create.show']({});
  m.handlers['app.record.detail.show']({});
  assert.strictEqual(linksOf(invoice).length, 2);
  assert.strictEqual(invoice.textContent, INVOICE_LABEL);
});

check('畫面還沒畫好 → 稍後重試，有限次數；畫好就加上去', () => {
  const m = load([]);
  m.handlers['app.record.create.show']({});
  assert.strictEqual(m.timers.length, 1);
  const invoice = makeTh(INVOICE_LABEL);
  m.state.headers = [invoice];
  m.timers.shift()();
  assert.strictEqual(linksOf(invoice).length, 2);
  assert.strictEqual(m.timers.length, 0, '加好就不再排重試');

  const never = load([]);
  never.handlers['app.record.detail.show']({});
  let runs = 0;
  while (never.timers.length) {
    never.timers.shift()();
    runs += 1;
    assert.ok(runs < 20, '重試要有上限');
  }
});

check('找 DOM 出錯也不影響表單', () => {
  const m = load([]);
  m.document.querySelectorAll = () => {
    throw new Error('DOM 改版');
  };
  const event = {};
  assert.strictEqual(m.handlers['app.record.edit.show'](event), event);
});

check('列印頁不綁；簽核記錄這類標籤對不上的子表格不動', () => {
  const sign = makeTh('變更前的狀態');
  const m = load([sign]);
  assert.deepStrictEqual(Object.keys(m.handlers).sort(), ['app.record.create.show', 'app.record.detail.show', 'app.record.edit.show']);
  assert.strictEqual(m.api.decorateHeaders(m.document, LAYOUT), 0);
  assert.strictEqual(linksOf(sign).length, 0);
});

check('CSS：連結用亮色＋底線＋粗體，且 !important 蓋過 kintone 自己的 a 樣式；hover 換白色', () => {
  const css = readSrc('payment_request.css');
  const base = /\.pr-header-link,[^{]*\{([^}]*)\}/.exec(css)?.[1] || '';
  assert.ok(/color:\s*#ffe066\s*!important/i.test(base), base);
  assert.ok(/text-decoration:\s*underline\s*!important/.test(base), base);
  assert.ok(/font-weight:\s*bold\s*!important/.test(base), base);
  assert.ok(/\.pr-header-link:hover[^{]*\{[^}]*color:\s*#ffffff\s*!important/i.test(css));
});

check('只進桌面版入口；CSS 有 .pr-header-link；模組不寫 inline 樣式', () => {
  assert.ok(readSrc('src/index.js').includes(FILE));
  assert.ok(!readSrc('src/mobile.js').includes(FILE));
  assert.ok(readSrc('payment_request.css').includes('.pr-header-link'));
  assert.ok(!/\.style\b|cssText/.test(readSrc(FILE)));
});

done();
