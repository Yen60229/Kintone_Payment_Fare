'use strict';

// 測試：詳細頁欄位寬度自動（詳細頁欄位寬度自動_20261112.js）
//   1. targetFieldCodes：子表格、群組、關聯記錄、狀態等有自己版面的型別不動
//   2. detail.show：主表欄位外框（.control-gaia）加 pr-fit-width；找不到元素略過、getFieldElement 丟錯不中斷
//   3. 只綁 detail.show（新增／編輯不動）；模組只進桌面版；CSS 有 .pr-fit-width 且 width: auto !important
// 單獨執行：node tests/detail_fit_width.test.cjs

const assert = require('assert');
const vm = require('vm');
const { createRunner, readSrc } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('detail_fit_width.test.cjs');

const FILE = '詳細頁欄位寬度自動_20261112.js';

/** 假的欄位元素：closest('.control-gaia') 回外框（可指定沒有外框） */
const makeField = (hasBox = true) => {
  const classes = new Set();
  const box = { classList: { add: (c) => classes.add(c) } };
  return { classes, el: { closest: (sel) => (hasBox && sel === '.control-gaia' ? box : null) } };
};

const load = (elements) => {
  const registered = [];
  const errors = [];
  const sandbox = {
    window: {},
    console: { log: () => {}, warn: () => {}, error: (...a) => errors.push(a) },
    kintone: {
      app: {
        getId: () => 749,
        record: {
          getFieldElement: (code) => {
            const v = elements[code];
            if (v instanceof Error) throw v;
            return v || null;
          },
        },
      },
      events: { on: (types, handler) => registered.push({ types: [].concat(types), handler }) },
      getLoginUser: () => ({ code: '24136' }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(readSrc('payment_request_config.js'), sandbox);
  vm.runInContext(readSrc(FILE), sandbox);
  return { M: sandbox.window.PR_DETAIL_FIT_WIDTH, registered, errors };
};

const record = {
  付款方式: { type: 'CHECK_BOX', value: ['匯款'] },
  是否有紙本憑證: { type: 'RADIO_BUTTON', value: '是' },
  受款人: { type: 'SINGLE_LINE_TEXT', value: '00546 王小明' },
  申請人: { type: 'USER_SELECT', value: [] },
  交通費請款單: { type: 'SUBTABLE', value: [] },
  簽核流程: { type: 'GROUP', value: null },
  關聯: { type: 'REFERENCE_TABLE', value: null },
  狀態: { type: 'STATUS', value: '未處理' },
  作業者: { type: 'STATUS_ASSIGNEE', value: [] },
  $id: { type: '__ID__', value: '1' },
  $revision: { type: '__REVISION__', value: '1' },
};

check('targetFieldCodes：只留一般欄位，子表格／群組／關聯記錄／狀態／$id 不動', () => {
  const { M } = load({});
  assert.deepStrictEqual([...M.targetFieldCodes(record)], ['付款方式', '是否有紙本憑證', '受款人', '申請人']);
  assert.deepStrictEqual([...M.targetFieldCodes(null)], []);
});

check('detail.show：主表欄位外框加 pr-fit-width，回傳同一個 event；子表格不加', () => {
  const fields = { 付款方式: makeField(), 是否有紙本憑證: makeField(), 受款人: makeField(), 申請人: makeField() };
  const sub = makeField();
  const elements = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.el]));
  elements.交通費請款單 = sub.el;
  const { registered } = load(elements);
  const event = { type: 'app.record.detail.show', record };
  assert.strictEqual(registered[0].handler(event), event);
  Object.values(fields).forEach((f) => assert.ok(f.classes.has('pr-fit-width')));
  assert.ok(!sub.classes.has('pr-fit-width'));
});

check('找不到元素或外框 → 略過；getFieldElement 丟錯 → 記錄錯誤、其他欄位照做', () => {
  const ok = makeField();
  const { M, errors } = load({ 付款方式: null, 是否有紙本憑證: makeField(false).el, 受款人: new Error('boom'), 申請人: ok.el });
  assert.strictEqual(M.applyFitWidth(record), 1);
  assert.ok(ok.classes.has('pr-fit-width'));
  assert.strictEqual(errors.length, 1);
});

check('只綁 app.record.detail.show（新增／編輯不動）', () => {
  const { registered } = load({});
  assert.deepStrictEqual(registered.flatMap((r) => r.types), ['app.record.detail.show']);
});

check('入口：只進桌面版；CSS 的 .pr-fit-width 是 width: auto !important', () => {
  assert.ok(readSrc('src/index.js').includes(`import '../${FILE}';`));
  assert.ok(!readSrc('src/mobile.js').includes(FILE));
  const rule = /\.pr-fit-width\s*\{([^}]*)\}/.exec(readSrc('payment_request.css'));
  assert.ok(rule, '.pr-fit-width 要定義');
  assert.ok(/width:\s*auto\s*!important/.test(rule[1]));
});

done();
