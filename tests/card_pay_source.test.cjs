'use strict';

// 測試：公司卡付款來源_20261116.js（從請款單交際費搬來的公司卡支付／受款人明細）
//   - 749 還沒建欄位 → 整支不動作
//   - 顯示：勾公司卡才顯示支付方式；部分支付才顯示明細表；全額／部分自動填主表受款人
//   - 部分支付且明細沒資料 → 帶一列員工代墊（主表受款人、總金額）
//   - 存檔：明細合計＝總金額（交通費明細 金額＋手續費）、至少一列公司信用卡與一列員工代墊、員工代墊只能一位、格式
//   - 錯誤交給 PR_SAVE_ERRORS，和 payment_request_submit 同一個視窗（載入順序在 submit 前）
//   - 員工代墊列 → 開共用的員工選人視窗（PR_PAYEE.openUserPicker）
// 單獨執行：node tests/card_pay_source.test.cjs

const assert = require('assert');
const { createEnv, createRunner, readSrc } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('card_pay_source.test.cjs');

const env = createEnv({ api: () => Promise.resolve({ users: [] }) });
env.load('payment_request_config.js');
env.load('使用者主檔快取.js');
env.load('受款人填寫設定_20250902.js');
env.load('公司卡付款來源_20261116.js');
const W = env.window;
const C = W.PR_CONFIG;
const F = C.FIELDS;
const P = C.CARD_PAY;
const COLS = P.TABLE.COLS;
const S = P.OPTIONS.SOURCE;
const M = W.PR_CARD_PAY;
const T = F.TRAFFIC_TABLE;

const trafficRow = (amount, fee = '') => ({ value: { [T.COLS.AMOUNT]: { type: 'NUMBER', value: String(amount) }, [T.COLS.FEE]: { type: 'NUMBER', value: String(fee) } } });
const payeeRow = (source, payee, amount) => ({
  value: {
    [COLS.PAY_SOURCE]: { type: 'DROP_DOWN', value: source },
    [COLS.PAYEE]: { type: 'SINGLE_LINE_TEXT', value: payee },
    [COLS.AMOUNT]: { type: 'NUMBER', value: amount === '' ? '' : String(amount) },
  },
});
const blankRow = () => payeeRow('', '', '');

/** 一張單：flag＝勾公司卡、mode＝支付方式（陣列）、rows＝受款人明細、traffic＝交通費明細金額 */
const makeRecord = ({ flag = false, mode = [], rows = [blankRow()], traffic = [trafficRow(1000, 20)], payee = '00546 王小明', installed = true } = {}) => {
  const r = {
    [F.PAYEE]: { type: 'SINGLE_LINE_TEXT', value: payee },
    [F.TOTAL_AMOUNT]: { type: 'CALC', value: '999999' }, // 計算欄位可能還沒更新：程式要自己算
    [T.CODE]: { type: 'SUBTABLE', value: traffic },
    [C.VOID_FIELD]: { type: 'CHECK_BOX', value: [] },
  };
  if (installed) {
    r[P.FLAG] = { type: 'CHECK_BOX', value: flag ? [P.OPTIONS.FLAG.YES] : [] };
    r[P.MODE] = { type: 'CHECK_BOX', value: mode };
    r[P.TABLE.CODE] = { type: 'SUBTABLE', value: rows };
  }
  return r;
};
const PARTIAL = [P.OPTIONS.MODE.PARTIAL];
const FULL = [P.OPTIONS.MODE.FULL];
const rowsOf = (r) => [...r[P.TABLE.CODE].value].map((row) => [row.value[COLS.PAY_SOURCE].value, row.value[COLS.PAYEE].value, row.value[COLS.AMOUNT].value]);
const submit = async (record) => {
  W.PR_SAVE_ERRORS.take();
  await env.fire('app.record.create.submit', { record });
  return [...W.PR_SAVE_ERRORS.take()];
};

check('749 還沒建欄位：show／存檔都不動作、不報錯', async () => {
  const r = makeRecord({ installed: false });
  const before = JSON.stringify(r);
  await env.fire('app.record.create.show', { record: r });
  assert.deepStrictEqual(await submit(r), []);
  assert.strictEqual(JSON.stringify(r), before);
  assert.strictEqual(env.shown[P.FLAG], undefined);
});

check('totalOf：交通費明細 金額＋手續費（不讀還沒更新的總金額計算欄位）', () => {
  assert.strictEqual(M.totalOf(makeRecord({ traffic: [trafficRow(1000, 20), trafficRow('1,500')] })), 2520);
  const noTable = makeRecord();
  delete noTable[T.CODE];
  assert.strictEqual(M.totalOf(noTable), 999999, '沒有明細表才讀總金額欄位');
});

check('沒勾公司卡：支付方式與明細表隱藏，明細清成一列空白列，主表受款人不動', async () => {
  const r = makeRecord({ mode: FULL, rows: [payeeRow(S.EMPLOYEE, '00546 王小明', 100)] });
  await env.fire('app.record.edit.show', { record: r });
  assert.strictEqual(env.shown[P.FLAG], true);
  assert.strictEqual(env.shown[P.MODE], false);
  assert.strictEqual(env.shown[P.TABLE.CODE], false);
  assert.deepStrictEqual([...r[P.MODE].value], []);
  assert.deepStrictEqual(rowsOf(r), [['', '', '']]);
  assert.strictEqual(r[F.PAYEE].value, '00546 王小明');
});

check('全額支付：主表受款人＝公司卡全額支付，明細不顯示並清空；取消勾公司卡 → 自動字樣清掉', async () => {
  const r = makeRecord({ flag: true, mode: FULL, rows: [payeeRow(S.CARD, '', 100)] });
  await env.fire(`app.record.create.change.${P.MODE}`, { record: r });
  assert.strictEqual(r[F.PAYEE].value, P.TEXT.FULL_PAYEE);
  assert.strictEqual(env.shown[P.MODE], true);
  assert.strictEqual(env.shown[P.TABLE.CODE], false);
  assert.deepStrictEqual(rowsOf(r), [['', '', '']]);
  r[P.FLAG].value = [];
  await env.fire(`app.record.create.change.${P.FLAG}`, { record: r });
  assert.strictEqual(r[F.PAYEE].value, '');
});

check('部分支付、明細沒資料：帶一列員工代墊（原本的主表受款人、總金額），主表受款人＝公司卡部分支付', async () => {
  const r = makeRecord({ flag: true, mode: PARTIAL, traffic: [trafficRow(1000, 20)] });
  await env.fire(`app.record.create.change.${P.MODE}`, { record: r });
  assert.strictEqual(env.shown[P.TABLE.CODE], true);
  assert.deepStrictEqual(rowsOf(r), [[S.EMPLOYEE, '00546 王小明', '1020']]);
  assert.strictEqual(r[F.PAYEE].value, P.TEXT.PARTIAL_PAYEE);
  // 已經有資料就不再帶
  r[P.TABLE.CODE].value = [payeeRow(S.CARD, '', 500), payeeRow(S.EMPLOYEE, '00546 王小明', 520)];
  await env.fire(`app.record.create.change.${P.MODE}`, { record: r });
  assert.strictEqual(r[P.TABLE.CODE].value.length, 2);
});

check('支付方式兩個都勾：保留新勾的那個', async () => {
  const r = makeRecord({ flag: true, mode: FULL });
  await env.fire('app.record.create.show', { record: r });
  r[P.MODE].value = [P.OPTIONS.MODE.FULL, P.OPTIONS.MODE.PARTIAL];
  await env.fire(`app.record.create.change.${P.MODE}`, { record: r });
  assert.deepStrictEqual([...r[P.MODE].value], PARTIAL);
});

check('存檔：部分支付、信用卡＋員工代墊、合計＝總金額 → 通過', async () => {
  const r = makeRecord({ flag: true, mode: PARTIAL, rows: [payeeRow(S.CARD, '', 600), payeeRow(S.EMPLOYEE, '00546 王小明', 420), blankRow()] });
  assert.deepStrictEqual(await submit(r), []);
  assert.strictEqual(r[F.PAYEE].value, P.TEXT.PARTIAL_PAYEE);
});

check('存檔：明細合計 ≠ 總金額 → 擋下並寫出兩個數字', async () => {
  const errs = await submit(makeRecord({ flag: true, mode: PARTIAL, rows: [payeeRow(S.CARD, '', 600), payeeRow(S.EMPLOYEE, '00546 王小明', 400)] }));
  assert.strictEqual(errs.length, 1);
  assert.ok(errs[0].includes('1,000') && errs[0].includes('1,020') && errs[0].includes(F.TOTAL_AMOUNT));
});

check('存檔：沒有公司信用卡列、員工代墊兩位、員工受款人格式錯、金額 0 → 各自報錯', async () => {
  const noCard = await submit(makeRecord({ flag: true, mode: PARTIAL, rows: [payeeRow(S.EMPLOYEE, '00546 王小明', 1020)] }));
  assert.ok(noCard.some((e) => e.includes('至少要有一列公司信用卡')));
  const two = await submit(makeRecord({ flag: true, mode: PARTIAL, rows: [payeeRow(S.CARD, '', 20), payeeRow(S.EMPLOYEE, '00546 王小明', 500), payeeRow(S.EMPLOYEE, '00777 陳大文', 500)] }));
  assert.ok(two.some((e) => e.startsWith('依規定，員工代墊只能有一位受款人') && e.includes('2 位')));
  const bad = await submit(makeRecord({ flag: true, mode: PARTIAL, rows: [payeeRow(S.CARD, '', 1020), payeeRow(S.EMPLOYEE, '王', 0)] }));
  assert.ok(bad.some((e) => e.includes('第 2 行') && e.includes('5 碼員工編號')));
  assert.ok(bad.some((e) => e.includes('第 2 行') && e.includes('金額必須大於 0')));
});

check('存檔：全部同一張公司信用卡 → 請改選全額支付；不同卡片不擋', async () => {
  const same = await submit(makeRecord({ flag: true, mode: PARTIAL, rows: [payeeRow(S.CARD, '', 520), payeeRow(S.CARD, '', 500)] }));
  assert.ok(same.some((e) => e.includes(P.OPTIONS.MODE.FULL)));
  const diff = await submit(makeRecord({ flag: true, mode: PARTIAL, rows: [payeeRow(S.CARD, '卡A', 520), payeeRow(S.CARD, '卡B', 500)] }));
  assert.deepStrictEqual(diff, []);
});

check('存檔：勾公司卡但支付方式沒選 → 擋下；全額支付清明細、填主表受款人；表單作廢不檢查', async () => {
  const none = await submit(makeRecord({ flag: true, mode: [] }));
  assert.strictEqual(none.length, 1);
  assert.ok(none[0].includes(P.MODE));
  const full = makeRecord({ flag: true, mode: FULL, rows: [payeeRow(S.CARD, '', 1)] });
  assert.deepStrictEqual(await submit(full), []);
  assert.deepStrictEqual(rowsOf(full), [['', '', '']]);
  assert.strictEqual(full[F.PAYEE].value, P.TEXT.FULL_PAYEE);
  const voided = makeRecord({ flag: true, mode: [] });
  voided[C.VOID_FIELD].value = ['作廢'];
  assert.deepStrictEqual(await submit(voided), []);
});

check('員工代墊列：改付款來源 → 開共用的員工選人視窗；受款人已是合格格式就不再開', async () => {
  const r = makeRecord({ flag: true, mode: PARTIAL, rows: [payeeRow(S.CARD, '', 520), payeeRow(S.EMPLOYEE, '', 500)] });
  const row = r[P.TABLE.CODE].value[1];
  env.timers.length = 0;
  env.swalCalls.length = 0;
  await env.fire(`app.record.create.change.${COLS.PAY_SOURCE}`, { record: r, changes: { row } });
  env.flushTimers();
  assert.strictEqual(env.swalCalls.length, 1);
  assert.ok(env.swalCalls[0].title.includes('第 2 行'));
  assert.deepStrictEqual(M.pickerRequest({ record: r, changes: { row } }, COLS.PAYEE), null, '受款人空白時改受款人不開');
  row.value[COLS.PAYEE].value = '00546 王小明';
  assert.deepStrictEqual(M.pickerRequest({ record: r, changes: { row } }, COLS.PAYEE), null);
  row.value[COLS.PAYEE].value = '王';
  assert.deepStrictEqual({ ...M.pickerRequest({ record: r, changes: { row } }, COLS.PAYEE) }, { index: 1, keyword: '王' });
  assert.deepStrictEqual(M.pickerRequest({ record: r, changes: { row: r[P.TABLE.CODE].value[0] } }, COLS.PAY_SOURCE), null, '公司信用卡列不開');
});

check('載入順序：桌面版與手機版都在 payment_request_submit 前面（錯誤才會併進同一個視窗）；JS 不注入樣式', () => {
  ['src/index.js', 'src/mobile.js'].forEach((file) => {
    const src = readSrc(file);
    const at = src.indexOf("'../公司卡付款來源_20261116.js'");
    assert.ok(at > 0, `${file} 要接公司卡付款來源`);
    assert.ok(at < src.indexOf("'../payment_request_submit_20260506.js'"), `${file}：要排在 submit 前`);
  });
  const src = readSrc('公司卡付款來源_20261116.js');
  assert.ok(!src.includes('<style') && !src.includes('cssText') && !src.includes('kintone.events.on'));
});

done();
