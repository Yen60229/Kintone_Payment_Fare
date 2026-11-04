'use strict';

// 測試：交通費明細規則主檔檢查_20261104.js（上傳到規則主檔，存檔時檢查名稱與請款單下拉選項一致）
//   a. config 原始檔 + 本檔在「規則主檔」（getId 回 752、沒有 getLoginUser 等）單獨可執行
//   b. 快照 12 筆全部通過
//   c. 各種錯誤：前後空白、不存在、類型選錯、可選憑證種類不存在、固定格式無統編、憑證種類填了交通工具欄位…
//   d. 讀請款單設定失敗 → 擋下、下次重試；成功後只讀一次；三個 submit 事件都註冊且會擋
// 單獨執行：node tests/traffic_rule_master_check.test.cjs

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRunner, readSrc, rootDir } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('traffic_rule_master_check.test.cjs');

const FILE = '交通費明細規則主檔檢查_20261104.js';
const snapshot = JSON.parse(fs.readFileSync(path.join(rootDir, 'form_snapshots', '752_rev9_records.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const snapshotRecords = () => clone(snapshot.records || snapshot);

/**
 * 載入 config + 本檔，模擬在規則主檔（App 752）執行：kintone 只有 app.getId、events.on、api。
 * @param {Function} apiImpl (url, method, params) => Promise
 */
const setup = (apiImpl) => {
  const handlers = [];
  const apiCalls = [];
  const errors = [];
  const kintone = {
    app: { getId: () => 752 },
    events: { on: (types, handler) => handlers.push({ types: [].concat(types), handler }) },
    api: Object.assign(
      (url, method, params) => {
        apiCalls.push({ url, method, params });
        return apiImpl(url, method, params);
      },
      { url: (p) => p },
    ),
  };
  const sandbox = { window: {}, kintone, console: { log() {}, warn() {}, error: (...a) => errors.push(a.join(' ')) } };
  vm.createContext(sandbox);
  vm.runInContext(readSrc('payment_request_config.js'), sandbox, { filename: 'config' });
  vm.runInContext(readSrc(FILE), sandbox, { filename: FILE });
  const fire = async (type, record) => {
    const ev = { type, record };
    for (const h of handlers.filter((x) => x.types.includes(type))) {
      const r = await h.handler(ev);
      if (r && r !== ev) Object.assign(ev, r);
    }
    return ev;
  };
  return { win: sandbox.window, C: sandbox.window.PR_CONFIG, handlers, apiCalls, errors, fire };
};

const base = setup(async () => ({ properties: {} }));
const C = base.C;
const M = C.REF_FIELDS.TRAFFIC_RULE_MASTER;
const T = C.FIELDS.TRAFFIC_TABLE;
const OPT = C.OPTIONS;

/** 用 config 選項組出請款單 form fields 回應 */
const formFields = () => {
  const opts = (o) => Object.fromEntries(Object.values(o).map((v, i) => [v, { label: v, index: String(i) }]));
  return {
    properties: {
      [T.CODE]: {
        type: 'SUBTABLE',
        fields: {
          [T.COLS.VEHICLE]: { type: 'DROP_DOWN', options: opts(OPT.VEHICLE) },
          [T.COLS.RECEIPT_TYPE]: { type: 'DROP_DOWN', options: opts(OPT.RECEIPT_TYPE) },
        },
      },
    },
  };
};
const CHECK = base.win.PR_TRAFFIC_RULE_MASTER_CHECK;
const options = CHECK.extractOptions(formFields().properties);
const V = (r, o) => [...CHECK.validateMasterRecord(r, o)];

const rec = (over = {}) => {
  const r = {
    [M.TYPE]: { value: M.TYPE_VEHICLE },
    [M.NAME]: { value: OPT.VEHICLE.TAXI },
    [M.IN_USE]: { value: M.IN_USE_VALUE },
    [M.ALLOWED_RECEIPTS]: { value: [] },
    [M.FIXED_SELLER_TAX_ID]: { value: '' },
    [M.FIXED_FORMAT]: { value: '' },
    [M.VEHICLE_FLAGS]: { value: [] },
    [M.RECEIPT_FLAGS]: { value: [] },
  };
  Object.entries(over).forEach(([k, v]) => (r[k] = { value: v }));
  return r;
};

// ── a. 單獨執行 ─────────────────────────────────────────────────────────────
check('config 原始檔在規則主檔單獨可執行：APPS.PAYMENT 變規則主檔、TRAFFIC_PAYMENT 仍是請款單；本檔掛出檢查函式', () => {
  assert.strictEqual(C.APPS.PAYMENT, 752);
  assert.notStrictEqual(C.APPS.TRAFFIC_PAYMENT, C.APPS.PAYMENT);
  assert.strictEqual(typeof CHECK.validateMasterRecord, 'function');
});

check('本檔沒有用 APPS.PAYMENT／getId，也沒有直接寫 kintone.events.on', () => {
  const src = readSrc(FILE).replace(/\/\/.*$/gm, '');
  assert.ok(!/APPS\.PAYMENT/.test(src));
  assert.ok(!/getId\(/.test(src));
  assert.ok(!/kintone\.events\.on/.test(src));
});

check('extractOptions：取子表格兩個下拉的選項文字；結構不對就丟錯', () => {
  assert.deepStrictEqual([...options.vehicles], Object.values(OPT.VEHICLE));
  assert.deepStrictEqual([...options.receipts], Object.values(OPT.RECEIPT_TYPE));
  assert.throws(() => CHECK.extractOptions({}));
  assert.throws(() => CHECK.extractOptions(undefined));
});

// ── b. 快照 ─────────────────────────────────────────────────────────────────
check('快照 12 筆全部通過', () => {
  const records = snapshotRecords();
  assert.strictEqual(records.length, 12);
  records.forEach((r) => assert.deepStrictEqual(V(r, options), [], `${r[M.NAME].value} 應通過`));
});

// ── c. 各種錯誤 ─────────────────────────────────────────────────────────────
check('名稱前後有空白（含全形空白）', () => {
  const e = V(rec({ [M.NAME]: `${OPT.VEHICLE.TAXI} ` }), options);
  assert.deepStrictEqual(e, [`「名稱」「${OPT.VEHICLE.TAXI} 」前後有空白`]);
  assert.strictEqual(V(rec({ [M.NAME]: `　${OPT.VEHICLE.TAXI}` }), options).length, 1);
});

check('名稱不存在：點名並列出可選項', () => {
  const e = V(rec({ [M.NAME]: '計程 車' }), options);
  assert.strictEqual(e.length, 1);
  assert.ok(e[0].includes('「名稱」「計程 車」不是'));
  assert.ok(e[0].includes('「交通工具」的選項'));
  Object.values(OPT.VEHICLE).forEach((v) => assert.ok(e[0].includes(v)));
  assert.ok(!e[0].includes('類型是否選錯'));
});

check('類型選錯：交通工具填「發票」→ 提示是憑證種類的選項；憑證種類填「高鐵」同理', () => {
  const e = V(rec({ [M.NAME]: OPT.RECEIPT_TYPE.INVOICE }), options);
  assert.strictEqual(e.length, 1);
  assert.ok(e[0].includes('這是憑證種類的選項，類型是否選錯？'));
  const e2 = V(rec({ [M.TYPE]: M.TYPE_RECEIPT, [M.NAME]: OPT.VEHICLE.HSR }), options);
  assert.strictEqual(e2.length, 1);
  assert.ok(e2[0].includes('「憑證種類」的選項') && e2[0].includes('這是交通工具的選項'));
});

check('可選憑證種類有請款單沒有的選項', () => {
  const e = V(rec({ [M.ALLOWED_RECEIPTS]: [OPT.RECEIPT_TYPE.INVOICE, '電子發票'] }), options);
  assert.strictEqual(e.length, 1);
  assert.ok(e[0].includes('「電子發票」'));
});

check('固定格式有填但固定賣方統編空白 → 錯；兩個都填或都空白通過', () => {
  assert.strictEqual(V(rec({ [M.FIXED_FORMAT]: '22' }), options).length, 1);
  assert.deepStrictEqual(V(rec({ [M.FIXED_FORMAT]: '22', [M.FIXED_SELLER_TAX_ID]: '00000000' }), options), []);
});

check('憑證種類記錄填了交通工具用欄位 → 逐欄報錯；交通工具記錄填憑證種類規則 → 錯', () => {
  const e = V(
    rec({
      [M.TYPE]: M.TYPE_RECEIPT,
      [M.NAME]: OPT.RECEIPT_TYPE.INVOICE,
      [M.ALLOWED_RECEIPTS]: [OPT.RECEIPT_TYPE.INVOICE],
      [M.FIXED_SELLER_TAX_ID]: '1',
      [M.FIXED_FORMAT]: '2',
      [M.VEHICLE_FLAGS]: [M.FLAG_REASON_REQUIRED],
    }),
    options,
  );
  assert.strictEqual(e.length, 4);
  [M.ALLOWED_RECEIPTS, M.FIXED_SELLER_TAX_ID, M.FIXED_FORMAT, M.VEHICLE_FLAGS].forEach((f) => assert.ok(e.some((x) => x.includes(`「${f}」`)), f));
  const e2 = V(rec({ [M.RECEIPT_FLAGS]: [M.FLAG_TAX] }), options);
  assert.strictEqual(e2.length, 1);
  assert.ok(e2[0].includes(`「${M.RECEIPT_FLAGS}」`));
});

check('停用的記錄也檢查名稱；列表直接編輯沒帶名稱欄位時不誤報', () => {
  assert.strictEqual(V(rec({ [M.IN_USE]: '停用', [M.NAME]: '打錯' }), options).length, 1);
  assert.deepStrictEqual(V({ [M.IN_USE]: { value: M.IN_USE_VALUE } }, options), []);
});

// ── d. 事件 ─────────────────────────────────────────────────────────────────
const EVENTS = ['app.record.create.submit', 'app.record.edit.submit', 'app.record.index.edit.submit'];
const NO_FORM = '讀不到交通費請款單的欄位設定，無法檢查名稱，請稍後再試或聯絡系統管理員';

check('三個 submit 事件都有註冊；有錯都會擋，訊息每條一行、開頭「・」；沒錯不設 error', async () => {
  const s = setup(async () => formFields());
  assert.deepStrictEqual(s.handlers.flatMap((h) => h.types).sort(), [...EVENTS].sort());
  for (const type of EVENTS) {
    const bad = await s.fire(type, rec({ [M.NAME]: '打錯', [M.FIXED_FORMAT]: '22' }));
    const lines = bad.error.split('\n');
    assert.strictEqual(lines.length, 2, type);
    lines.forEach((l) => assert.ok(l.startsWith('・')));
    const ok = await s.fire(type, rec());
    assert.strictEqual(ok.error, undefined, type);
  }
});

check('form fields 只讀一次（快取），參數是請款單的 App ID 與 GET', async () => {
  const s = setup(async () => formFields());
  for (const type of EVENTS) await s.fire(type, rec());
  assert.strictEqual(s.apiCalls.length, 1);
  assert.strictEqual(s.apiCalls[0].method, 'GET');
  assert.strictEqual(s.apiCalls[0].params.app, C.APPS.TRAFFIC_PAYMENT);
  assert.ok(s.apiCalls[0].url.includes('/k/v1/app/form/fields'));
});

check('讀請款單設定失敗 → 三個事件都擋下並 console.error', async () => {
  for (const type of EVENTS) {
    const s = setup(async () => {
      throw new Error('403');
    });
    const ev = await s.fire(type, rec());
    assert.strictEqual(ev.error, NO_FORM);
    assert.strictEqual(s.errors.length, 1);
  }
});

check('失敗後下次存檔會重試，成功後放行並只讀一次', async () => {
  let fail = true;
  const s = setup(async () => {
    if (fail) throw new Error('403');
    return formFields();
  });
  const ev1 = await s.fire(EVENTS[0], rec());
  assert.strictEqual(ev1.error, NO_FORM);
  fail = false;
  const ev2 = await s.fire(EVENTS[0], rec());
  assert.strictEqual(ev2.error, undefined);
  assert.strictEqual(s.apiCalls.length, 2, '失敗清掉快取，第二次重讀');
  await s.fire(EVENTS[1], rec());
  assert.strictEqual(s.apiCalls.length, 2, '成功後不再讀');
});

check('回應結構不對（沒有子表格）也算讀不到 → 擋下', async () => {
  const s = setup(async () => ({ properties: {} }));
  const ev = await s.fire(EVENTS[0], rec());
  assert.strictEqual(ev.error, NO_FORM);
});

done();
