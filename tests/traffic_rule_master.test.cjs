'use strict';

// 測試：交通費明細規則改讀規則主檔（APPS.TRAFFIC_RULE_MASTER）
//   a. 快照（初始記錄）轉出來的規則必須和 config 的 TRAFFIC_RULES 等價（「不動原功能」的保證）
//   b. 資料不合法 → errors
//   c. loadRules：成功用主檔；失敗／逾時／0 筆／不合法 → 維持 config；只讀一次
//   d. 改主檔真的改變行為（旗標、可選憑證種類、固定賣方統編、要算稅）
//   e. show 事件回傳 Promise，await 後規則已套用
// 單獨執行：node tests/traffic_rule_master.test.cjs

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createEnv, createRunner, rootDir } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('traffic_rule_master.test.cjs');

const snapshot = JSON.parse(fs.readFileSync(path.join(rootDir, 'form_snapshots', '752_rev9_records.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const snapshotRecords = () => clone(snapshot.records || snapshot);

const setup = (opts) => {
  const env = createEnv(opts);
  env.load('payment_request_config.js');
  env.load('發票號碼寫入獨立欄位檢查.js');
  env.load('交通費明細規則_20261022.js');
  return { env, R: env.window.PR_TRAFFIC_RULES, C: env.window.PR_CONFIG };
};

const { C } = setup();
const F = C.FIELDS;
const T = F.TRAFFIC_TABLE;
const COLS = T.COLS;
const M = C.REF_FIELDS.TRAFFIC_RULE_MASTER;

const row = (over = {}) => {
  const value = {};
  Object.values(COLS).forEach((code) => (value[code] = { value: '' }));
  Object.entries(over).forEach(([code, v]) => (value[code] = { value: v }));
  return { value };
};
const record = (rows, over = {}) => ({
  [T.CODE]: { value: rows },
  [F.PAPER_RECEIPT]: { value: '否' },
  [F.REASON]: { value: '' },
  [F.INVOICE_AGG]: { value: '' },
  ...over,
});

/** 快照記錄（改完之後）→ api 替身，回傳 { records } */
const apiOf = (records, calls) => async (url, method, params) => {
  if (calls) calls.push({ url, method, params });
  return { records };
};
const find = (records, name) => records.find((r) => r[M.NAME].value === name);

// ── a. 等價 ────────────────────────────────────────────────────────────────
check('快照 → rulesFromMaster 與 rulesFromConfig 深度相等（除了 source）', () => {
  const { R } = setup();
  const fromMaster = R.rulesFromMaster(snapshotRecords());
  assert.ok(!fromMaster.errors, JSON.stringify(fromMaster.errors));
  const fromConfig = R.rulesFromConfig(C.TRAFFIC_RULES, C.OPTIONS);
  assert.strictEqual(fromMaster.source, 'master');
  assert.strictEqual(fromConfig.source, 'config');
  // 沙箱裡建的物件原型不同，先過 JSON 再比
  assert.deepStrictEqual(clone({ ...fromMaster, source: '' }), clone({ ...fromConfig, source: '' }));
});

check('快照有 12 筆：7 個交通工具＋5 個憑證種類，名稱與 749 的選項一致', () => {
  const recs = snapshotRecords();
  assert.strictEqual(recs.length, 12);
  const names = (type) => recs.filter((r) => r[M.TYPE].value === type).map((r) => r[M.NAME].value).sort();
  assert.deepStrictEqual(names(M.TYPE_VEHICLE), Object.values(C.OPTIONS.VEHICLE).sort());
  assert.deepStrictEqual(names(M.TYPE_RECEIPT), Object.values(C.OPTIONS.RECEIPT_TYPE).sort());
});

check('停用的記錄忽略（等同沒列）：停用「Uber」→ 不限制憑證種類', () => {
  const { R } = setup();
  const recs = snapshotRecords();
  find(recs, 'Uber')[M.IN_USE].value = '停用';
  const rules = R.rulesFromMaster(recs);
  assert.ok(!rules.errors);
  assert.ok(!('Uber' in rules.receiptByVehicle));
});

// ── b. 不合法 ──────────────────────────────────────────────────────────────
check('不合法資料 → 回傳 errors', () => {
  const { R } = setup();
  const bad = (mutate, pattern) => {
    const recs = snapshotRecords();
    mutate(recs);
    const result = R.rulesFromMaster(recs);
    assert.ok(Array.isArray(result.errors) && result.errors.length, `應該有 errors：${pattern}`);
    assert.ok(result.errors.some((e) => pattern.test(e)), result.errors.join('\n'));
  };
  assert.ok(R.rulesFromMaster([]).errors, '0 筆');
  assert.ok(R.rulesFromMaster(undefined).errors, 'undefined');
  bad((recs) => recs.splice(0, recs.length, ...recs.filter((r) => r[M.TYPE].value !== M.TYPE_VEHICLE)), /沒有任何使用中的「交通工具」/);
  bad((recs) => recs.splice(0, recs.length, ...recs.filter((r) => r[M.TYPE].value !== M.TYPE_RECEIPT)), /沒有任何使用中的「憑證種類」/);
  bad((recs) => (recs[0][M.NAME].value = '  '), /名稱.*空白/);
  bad((recs) => (recs[1][M.NAME].value = recs[0][M.NAME].value), /重複/);
  bad((recs) => (find(recs, '捷運／公車')[M.FIXED_FORMAT].value = '25'), /固定賣方統編.*空白/);
  bad((recs) => (recs[0][M.TYPE].value = '其他'), /不是「交通工具」或「憑證種類」/);
});

// ── c. loadRules ───────────────────────────────────────────────────────────
check('loadRules：api 成功 → source master；查的是 APPS.TRAFFIC_RULE_MASTER、只查使用中；只呼叫一次（快取）', async () => {
  const calls = [];
  const { R } = setup({ api: apiOf(snapshotRecords(), calls) });
  assert.strictEqual(R.getActiveRules().source, 'config', '載入前就有 config 規則');
  const rules = await R.loadRules();
  assert.strictEqual(rules.source, 'master');
  assert.strictEqual(R.getActiveRules().source, 'master');
  await R.loadRules();
  await R.loadRules();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].method, 'GET');
  assert.strictEqual(calls[0].params.app, C.APPS.TRAFFIC_RULE_MASTER);
  assert.ok(calls[0].params.query.includes(`${M.IN_USE} in ("${M.IN_USE_VALUE}")`));
  assert.ok(calls[0].params.fields.includes(M.VEHICLE_FLAGS));
});

check('loadRules：api reject → 維持 config 並 console.warn，不 reject', async () => {
  const { env, R } = setup({ api: async () => Promise.reject(new Error('403')) });
  const rules = await R.loadRules();
  assert.strictEqual(rules.source, 'config');
  assert.ok(env.logs.warn.length >= 1);
});

check('loadRules：api 同步丟例外 → 維持 config', async () => {
  const { R } = setup({ api: () => { throw new Error('boom'); } });
  assert.strictEqual((await R.loadRules()).source, 'config');
});

check('loadRules：api 永不回應 → 逾時後維持 config（逾時秒數取自 config）', async () => {
  const { env, R } = setup({ api: () => new Promise(() => {}) });
  assert.strictEqual(C.TRAFFIC_RULES.MASTER_TIMEOUT_MS, 5000);
  const pending = R.loadRules();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(env.timers.some((t) => t.ms === 5000), '有掛逾時計時器');
  env.flushTimers();
  assert.strictEqual((await pending).source, 'config');
  assert.ok(env.logs.warn.some((w) => w.includes('改用 config 規則')));
});

check('loadRules：回傳 0 筆／資料不合法 → 維持 config', async () => {
  let { R } = setup({ api: apiOf([]) });
  assert.strictEqual((await R.loadRules()).source, 'config');
  const recs = snapshotRecords();
  recs[0][M.NAME].value = '';
  ({ R } = setup({ api: apiOf(recs) }));
  assert.strictEqual((await R.loadRules()).source, 'config');
});

check('維持 config 時行為和原本一樣：沒有 api 替身 → 讀不到 → 計程車仍要紙本憑證與理由', async () => {
  const { env, R } = setup();
  const ev = await env.fire('app.record.create.show', { record: record([row({ [COLS.VEHICLE]: '計程車' })]) });
  assert.strictEqual(R.getActiveRules().source, 'config');
  assert.strictEqual(ev.record[F.PAPER_RECEIPT].value, '是');
  const errs = R.validate(ev.record);
  assert.ok(errs.some((e) => e.includes('有搭乘計程車') && e.includes('必須選「是」')) === false, '紙本憑證已自動選是');
  assert.ok(errs.some((e) => e.includes('有搭乘計程車') && e.includes('請填寫「理由」')), errs.join('\n'));
});

// ── d. 改主檔真的改變行為 ──────────────────────────────────────────────────
const withMaster = async (mutate) => {
  const recs = snapshotRecords();
  mutate(recs);
  const t = setup({ api: apiOf(recs) });
  assert.strictEqual((await t.R.loadRules()).source, 'master');
  return t;
};

check('計程車取消「需紙本憑證」「理由必填」→ 有計程車也不強制、不擋；錯誤訊息不再提計程車', async () => {
  const { env, R } = await withMaster((recs) => (find(recs, '計程車')[M.VEHICLE_FLAGS].value = []));
  const ev = await env.fire(`app.record.create.change.${COLS.VEHICLE}`, { record: record([row({ [COLS.VEHICLE]: '計程車' })]) });
  assert.strictEqual(ev.record[F.PAPER_RECEIPT].value, '否');
  assert.deepStrictEqual(clone(R.validate(ev.record)), []);
});

check('只留「理由必填」→ 紙本憑證不自動選，但理由要填；多個交通工具用「、」接', async () => {
  const { env, R } = await withMaster((recs) => {
    find(recs, '計程車')[M.VEHICLE_FLAGS].value = [M.FLAG_REASON_REQUIRED];
    find(recs, 'Uber')[M.VEHICLE_FLAGS].value = [M.FLAG_REASON_REQUIRED];
  });
  const ev = await env.fire(`app.record.create.change.${COLS.VEHICLE}`, { record: record([row({ [COLS.VEHICLE]: 'Uber' }), row({ [COLS.VEHICLE]: '計程車' }), row({ [COLS.VEHICLE]: 'Uber' })]) });
  assert.strictEqual(ev.record[F.PAPER_RECEIPT].value, '否');
  const errs = R.validate(ev.record);
  assert.strictEqual(errs.length, 1);
  assert.ok(errs[0].includes('有搭乘Uber、計程車，**請填寫「理由」**'), errs[0]);
});

check('新增交通工具「自行車」只能選「收據」→ 選發票被清空、選了就自動帶入收據、存檔擋下不能用的組合', async () => {
  const { env, R } = await withMaster((recs) => {
    recs.push({
      [M.TYPE]: { value: M.TYPE_VEHICLE },
      [M.NAME]: { value: '自行車' },
      [M.IN_USE]: { value: M.IN_USE_VALUE },
      [M.ALLOWED_RECEIPTS]: { value: ['收據'] },
      [M.FIXED_SELLER_TAX_ID]: { value: '' },
      [M.FIXED_FORMAT]: { value: '' },
      [M.VEHICLE_FLAGS]: { value: [] },
      [M.RECEIPT_FLAGS]: { value: [] },
    });
  });
  assert.deepStrictEqual([...R.allowedReceiptTypes('自行車')], ['收據']);
  let ev = await env.fire(`app.record.edit.change.${COLS.VEHICLE}`, { record: record([row({ [COLS.VEHICLE]: '自行車', [COLS.RECEIPT_TYPE]: '發票', [COLS.INVOICE_NO]: 'AB12345678' })]) });
  assert.strictEqual(ev.record[T.CODE].value[0].value[COLS.RECEIPT_TYPE].value, '收據', '發票被清空後只剩一種 → 自動帶入收據');
  assert.strictEqual(ev.record[T.CODE].value[0].value[COLS.INVOICE_NO].value, '');
  const errs = R.validate(record([row({ [COLS.VEHICLE]: '自行車', [COLS.RECEIPT_TYPE]: '發票', [COLS.INVOICE_NO]: 'AB12345678' })]));
  assert.ok(errs.some((e) => e.includes('第 1 行') && e.includes('自行車') && e.includes('不能選「發票」') && e.includes('可選：收據')), errs.join('\n'));
});

check('某交通工具加固定賣方統編 → 帶入並鎖；改選別的交通工具 → 清空解鎖；高鐵拿掉固定統編 → 不再鎖', async () => {
  const { env } = await withMaster((recs) => {
    find(recs, 'Uber')[M.FIXED_SELLER_TAX_ID].value = '12345678';
    find(recs, 'Uber')[M.FIXED_FORMAT].value = '25';
    find(recs, '高鐵')[M.FIXED_SELLER_TAX_ID].value = '';
    find(recs, '高鐵')[M.FIXED_FORMAT].value = '';
  });
  let ev = await env.fire(`app.record.create.change.${COLS.VEHICLE}`, { record: record([row({ [COLS.VEHICLE]: 'Uber' })]) });
  let v = ev.record[T.CODE].value[0].value;
  assert.strictEqual(v[COLS.SELLER_TAX_ID].value, '12345678');
  assert.strictEqual(v[COLS.FORMAT].value, '25');
  assert.strictEqual(v[COLS.SELLER_TAX_ID].disabled, true);
  assert.strictEqual(v[COLS.FORMAT].disabled, true);
  ev = await env.fire(`app.record.create.change.${COLS.VEHICLE}`, { record: record([row({ [COLS.VEHICLE]: '火車', [COLS.SELLER_TAX_ID]: '12345678', [COLS.FORMAT]: '25' })]) });
  v = ev.record[T.CODE].value[0].value;
  assert.strictEqual(v[COLS.SELLER_TAX_ID].value, '');
  assert.strictEqual(v[COLS.FORMAT].value, '');
  assert.strictEqual(v[COLS.SELLER_TAX_ID].disabled, false);
  ev = await env.fire(`app.record.create.change.${COLS.VEHICLE}`, { record: record([row({ [COLS.VEHICLE]: '高鐵' })]) });
  v = ev.record[T.CODE].value[0].value;
  assert.strictEqual(v[COLS.SELLER_TAX_ID].value, '');
  assert.notStrictEqual(v[COLS.SELLER_TAX_ID].disabled, true);
});

check('「車票（高鐵外）」加上「要算稅」→ 車票也算稅；高鐵票拿掉「要算稅」→ 寫 0', async () => {
  const { env } = await withMaster((recs) => {
    find(recs, '車票（高鐵外）')[M.RECEIPT_FLAGS].value = [M.FLAG_TAX];
    find(recs, '高鐵票')[M.RECEIPT_FLAGS].value = [M.FLAG_INVOICE_NO];
  });
  const r = record([
    row({ [COLS.VEHICLE]: '火車', [COLS.AMOUNT]: '1050', [COLS.RECEIPT_TYPE]: '車票（高鐵外）' }),
    row({ [COLS.VEHICLE]: '高鐵', [COLS.AMOUNT]: '1050', [COLS.RECEIPT_TYPE]: '高鐵票', [COLS.INVOICE_NO]: 'T1' }),
  ]);
  let ev = await env.fire(`app.record.create.change.${COLS.AMOUNT}`, { record: r, changes: { row: r[T.CODE].value[0], field: {} } });
  assert.strictEqual(ev.record[T.CODE].value[0].value[COLS.TAX].value, '50');
  ev = await env.fire(`app.record.create.change.${COLS.AMOUNT}`, { record: r, changes: { row: r[T.CODE].value[1], field: {} } });
  assert.strictEqual(ev.record[T.CODE].value[1].value[COLS.TAX].value, '0');
});

check('主檔替「收據」加上「要算稅」→ 收據仍寫 0 並鎖住（config 的 PLAIN_RECEIPT_TYPES 優先）', async () => {
  const { env } = await withMaster((recs) => {
    find(recs, '收據')[M.RECEIPT_FLAGS].value = [M.FLAG_TAX];
  });
  const r = record([row({ [COLS.VEHICLE]: '火車', [COLS.AMOUNT]: '1050', [COLS.RECEIPT_TYPE]: '收據' })]);
  const ev = await env.fire(`app.record.create.change.${COLS.AMOUNT}`, { record: r, changes: { row: r[T.CODE].value[0], field: {} } });
  const v = ev.record[T.CODE].value[0].value;
  assert.strictEqual(v[COLS.TAX].value, '0');
  assert.strictEqual(v[COLS.TAX].disabled, true);
});

check('「開放發票號碼」由主檔決定：收據開放後存檔要填發票號碼；發票拿掉後不再要求', async () => {
  const { R } = await withMaster((recs) => {
    find(recs, '收據')[M.RECEIPT_FLAGS].value = [M.FLAG_INVOICE_NO];
    find(recs, '發票')[M.RECEIPT_FLAGS].value = [M.FLAG_TAX];
  });
  const errs = R.validate(record([row({ [COLS.VEHICLE]: '火車', [COLS.RECEIPT_TYPE]: '收據' }), row({ [COLS.VEHICLE]: 'Uber', [COLS.RECEIPT_TYPE]: '發票' })]));
  assert.strictEqual(errs.length, 1);
  assert.ok(errs[0].includes('第 1 行') && errs[0].includes('請填寫'), errs[0]);
});

check('選單過濾：主檔新增的憑證種類也認得（不在可選清單就藏起來）', async () => {
  const { R } = await withMaster((recs) => {
    recs.push({
      [M.TYPE]: { value: M.TYPE_RECEIPT },
      [M.NAME]: { value: '電子票證' },
      [M.IN_USE]: { value: M.IN_USE_VALUE },
      [M.ALLOWED_RECEIPTS]: { value: [] },
      [M.FIXED_SELLER_TAX_ID]: { value: '' },
      [M.FIXED_FORMAT]: { value: '' },
      [M.VEHICLE_FLAGS]: { value: [] },
      [M.RECEIPT_FLAGS]: { value: [] },
    });
  });
  const mkItem = (text) => {
    const classes = new Set();
    return { textContent: text, classes, classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
  };
  const items = ['發票', '電子票證'].map(mkItem);
  const menu = { querySelectorAll: () => items };
  assert.strictEqual(R.filterMenuItems(menu, ['發票']), 1);
  assert.ok(items[1].classes.has('pr-option-hidden'));
});

// ── e. show 事件 ───────────────────────────────────────────────────────────
check('show 事件回傳 Promise；await 後主檔規則已套用（捷運／公車加固定賣方統編，開畫面時就帶入並鎖住）', async () => {
  const recs = snapshotRecords();
  find(recs, '捷運／公車')[M.FIXED_SELLER_TAX_ID].value = '99999999';
  find(recs, '捷運／公車')[M.FIXED_FORMAT].value = '21';
  const { env, R } = setup({ api: apiOf(recs) });
  const handler = env.handlers.find((h) => h.types.includes('app.record.create.show'));
  assert.ok(handler);
  const pending = handler.handler({ type: 'app.record.create.show', record: record([row({ [COLS.VEHICLE]: '捷運／公車' })]) });
  assert.ok(pending && typeof pending.then === 'function', 'show 處理程式回傳 Promise');
  const ev = await pending;
  assert.strictEqual(R.getActiveRules().source, 'master');
  const v = ev.record[T.CODE].value[0].value;
  assert.strictEqual(v[COLS.SELLER_TAX_ID].value, '99999999');
  assert.strictEqual(v[COLS.FORMAT].value, '21');
  assert.strictEqual(v[COLS.SELLER_TAX_ID].disabled, true);
});

check('edit.show 同樣先讀主檔：整個頁面只讀一次', async () => {
  const calls = [];
  const { env } = setup({ api: apiOf(snapshotRecords(), calls) });
  await env.fire('app.record.create.show', { record: record([]) });
  await env.fire('app.record.edit.show', { record: record([]) });
  assert.strictEqual(calls.length, 1);
});

check('_resetForTest：回到 config 規則並清快取', async () => {
  const calls = [];
  const { R } = setup({ api: apiOf(snapshotRecords(), calls) });
  await R.loadRules();
  R._resetForTest();
  assert.strictEqual(R.getActiveRules().source, 'config');
  await R.loadRules();
  assert.strictEqual(calls.length, 2);
});

done();
