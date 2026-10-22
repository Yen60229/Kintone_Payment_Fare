'use strict';

// 測試：SetFieldWidth_4_20251206.js（依內容自動調整欄位寬度）
//   1. 寬度計算：中文 2 單位、英數 1 單位，每單位 10px＋40px，限制 50～500
//   2. 詳細頁：延遲後調寬度並開始監看；內容變化 → 防抖後再調
//   3. 換頁太快的防護：還沒調就換畫面 → 延遲的工作作廢；換畫面一律斷開觀察者；同時只會有一個觀察者
//   4. 寬度沒變就不重寫
// 單獨執行：node tests/set_field_width.test.cjs

const assert = require('assert');
const vm = require('vm');
const { createRunner, readSrc } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('set_field_width.test.cjs');

const setup = () => {
  const handlers = [];
  const timers = [];
  const observers = [];
  const getFieldCalls = [];
  const elements = {};

  // 每個欄位一組替身 DOM：欄位外框 → 控制項容器（.control-value-gaia）→ select
  const fieldElementOf = (code) => {
    if (elements[code]) return elements[code];
    let widthWrites = 0;
    const style = {};
    const container = {
      classList: { list: [], add: (c) => container.classList.list.push(c) },
      style: new Proxy(style, {
        set: (target, key, value) => {
          if (key === 'width') widthWrites += 1;
          target[key] = value;
          return true;
        },
      }),
      widthWrites: () => widthWrites,
    };
    const select = { style: {} };
    const el = {
      closest: (sel) => (sel === '.row-gaia' ? {} : null),
      querySelector: (sel) => (sel === '.control-value-gaia' ? container : null),
      querySelectorAll: (sel) => (sel === 'select' ? [select] : []),
      container,
      select,
    };
    elements[code] = el;
    return el;
  };

  class FakeObserver {
    constructor(cb) {
      this.cb = cb;
      this.connected = false;
      observers.push(this);
    }
    observe() {
      this.connected = true;
    }
    disconnect() {
      this.connected = false;
    }
  }

  const sandbox = {
    window: {},
    console: { log: () => {}, warn: () => {}, error: () => {} },
    document: { querySelector: (sel) => (sel === '.record-detail-gaia' ? { tag: 'detail' } : null) },
    MutationObserver: FakeObserver,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms, cancelled: false });
      return timers.length;
    },
    clearTimeout: (id) => {
      if (id && timers[id - 1]) timers[id - 1].cancelled = true;
    },
    kintone: {
      app: {
        getId: () => 749,
        record: {
          getFieldElement: (code) => {
            getFieldCalls.push(code);
            return fieldElementOf(code);
          },
        },
      },
      getLoginUser: () => ({ code: 'u' }),
      events: { on: (types, handler) => handlers.push({ types: [].concat(types), handler }) },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(readSrc('payment_request_config.js'), sandbox);
  vm.runInContext(readSrc('SetFieldWidth_4_20251206.js'), sandbox);
  const F = sandbox.window.PR_CONFIG.FIELDS;

  const fire = (type, record = {}) => handlers.filter((h) => h.types.includes(type)).forEach((h) => h.handler({ type, record }));
  /** 執行目前排隊、沒被取消的計時器（只跑一輪） */
  const flush = () =>
    timers
      .splice(0)
      .filter((t) => !t.cancelled)
      .forEach((t) => t.fn());
  const record = (applicantName = '王小明') => ({
    [F.APPLICANT]: { type: 'USER_SELECT', value: [{ code: 'u1', name: applicantName }] },
    [F.PAY_METHOD]: { type: 'CHECK_BOX', value: ['電匯'] },
  });
  const active = () => observers.filter((o) => o.connected);
  return { sandbox, F, fire, flush, timers, observers, active, getFieldCalls, elements, record, W: sandbox.window.PR_FIELD_WIDTH };
};

// ── 1. 寬度計算 ─────────────────────────────────────────────────────────────
check('寬度：空白 50px；英數 1 單位、中文 2 單位，×10＋40；最寬 500px', () => {
  const { W } = setup();
  assert.strictEqual(W.calcWidth(''), 50);
  assert.strictEqual(W.calcWidth('  '), 50);
  assert.strictEqual(W.calcWidth('AB'), 60);
  assert.strictEqual(W.calcWidth('王小明'), 100);
  assert.strictEqual(W.calcWidth('台中營業部-綜合物流營業課'), 12 * 2 * 10 + 10 + 40);
  assert.strictEqual(W.calcWidth('字'.repeat(100)), 500);
});

check('欄位文字：人員／組織取最長名稱、核取方塊串起來、沒有值是空字串', () => {
  const { W } = setup();
  assert.strictEqual(W.fieldContent({ type: 'USER_SELECT', value: [{ name: 'A' }, { name: '王小明' }] }), '王小明');
  assert.strictEqual(W.fieldContent({ type: 'CHECK_BOX', value: ['電匯', '現金'] }), '電匯現金');
  assert.strictEqual(W.fieldContent({ type: 'ORGANIZATION_SELECT', value: null }), '');
  assert.strictEqual(W.fieldContent(undefined), '');
});

// ── 2. 詳細頁 ───────────────────────────────────────────────────────────────
check('詳細頁：延遲 500ms 後調寬度（加 pr-auto-width class、寫 width／maxWidth、select 的 minWidth），並開始監看', () => {
  const { F, fire, flush, timers, active, elements, record } = setup();
  fire('app.record.detail.show', record());
  assert.strictEqual(timers[0].ms, 500);
  flush();
  const el = elements[F.APPLICANT];
  assert.strictEqual(el.container.style.width, '100px');
  assert.strictEqual(el.container.style.maxWidth, '100px');
  assert.ok(el.container.classList.list.includes('pr-auto-width'));
  assert.strictEqual(el.select.style.minWidth, '100px');
  assert.strictEqual(active().length, 1);
});

check('詳細頁內容變化 → 防抖 300ms 後再調；寬度沒變就不重寫', () => {
  const { F, fire, flush, timers, active, elements, record } = setup();
  fire('app.record.detail.show', record());
  flush();
  const writes = elements[F.APPLICANT].container.widthWrites();
  active()[0].cb([{ type: 'childList', addedNodes: [{}] }]);
  active()[0].cb([{ type: 'characterData', addedNodes: [] }]);
  assert.strictEqual(timers.filter((t) => !t.cancelled).length, 1, '連續變化只留最後一個計時器');
  assert.strictEqual(timers.find((t) => !t.cancelled).ms, 300);
  flush();
  assert.strictEqual(elements[F.APPLICANT].container.widthWrites(), writes, '寬度一樣就不重寫');
});

// ── 3. 換頁太快 ─────────────────────────────────────────────────────────────
check('換頁太快：詳細頁還沒調就按「編輯」→ 詳細頁的延遲工作作廢、不建觀察者；只用編輯畫面的記錄調一次', () => {
  const { F, fire, flush, active, elements, record } = setup();
  fire('app.record.detail.show', record('詳細頁的名字很長很長很長'));
  fire('app.record.edit.show', record('王小明'));
  flush();
  assert.strictEqual(active().length, 0, '編輯畫面不該有詳細頁留下的觀察者');
  assert.strictEqual(elements[F.APPLICANT].container.style.width, '100px', '用編輯畫面的值，不是詳細頁的');
});

check('換頁太快：詳細頁還沒調就回列表 → 什麼都不做', () => {
  const { fire, flush, active, getFieldCalls, record } = setup();
  fire('app.record.detail.show', record());
  fire('app.record.index.show');
  flush();
  assert.strictEqual(getFieldCalls.length, 0);
  assert.strictEqual(active().length, 0);
});

check('從詳細頁進編輯：觀察者斷開；之後畫面再怎麼變（輸入、選人）都不會用詳細頁的記錄重調', () => {
  const { F, fire, flush, observers, active, elements, record } = setup();
  fire('app.record.detail.show', record('詳細頁的名字很長很長很長'));
  flush();
  const detailObserver = observers[0];
  fire('app.record.edit.show', record('王小明'));
  assert.strictEqual(detailObserver.connected, false);
  flush();
  detailObserver.cb([{ type: 'childList', addedNodes: [{}] }]);
  flush();
  assert.strictEqual(elements[F.APPLICANT].container.style.width, '100px');
});

check('來回切換（詳細 → 編輯 → 取消回詳細）多次：同一時間只有一個觀察者', () => {
  const { fire, flush, observers, active, record } = setup();
  for (let i = 0; i < 3; i++) {
    fire('app.record.detail.show', record());
    flush();
    fire('app.record.edit.show', record());
    flush();
  }
  fire('app.record.detail.show', record());
  flush();
  assert.strictEqual(active().length, 1);
  assert.strictEqual(observers.length, 4);
});

check('原始碼：不再用全域 window.resizeTimeout，也不寫 cssText／transition 等靜態樣式（在 payment_request.css）', () => {
  const src = readSrc('SetFieldWidth_4_20251206.js');
  assert.ok(!src.includes('window.resizeTimeout'));
  assert.ok(!/style\.(transition|minWidth = 'auto'|boxSizing)/.test(src));
  assert.ok(/\.pr-auto-width\s*\{/.test(readSrc('payment_request.css')));
});

done();
