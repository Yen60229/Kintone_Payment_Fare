'use strict';

// 測試：公司卡付款來源.js（從請款單交際費搬來的公司卡支付／受款人明細）
//   - 749 還沒建欄位 → 整支不動作
//   - 顯示：勾公司卡才顯示支付方式；部分支付才顯示明細表；全額／部分自動填主表受款人
//   - 部分支付且明細沒資料 → 帶一列員工代墊（主表受款人、總金額）
//   - 存檔：明細合計＝總金額（交通費明細 金額＋手續費）、至少一列公司信用卡與一列員工代墊、員工代墊只能一位、格式
//   - 錯誤交給 PR_SAVE_ERRORS，和 payment_request_submit 同一個視窗（載入順序在 submit 前）
//   - 員工代墊列 → 開共用的員工選人視窗（PR_PAYEE.openUserPicker）
//   - 存檔：受款人要已建立匯款帳號（員工匯款帳號主檔）：非公司卡查主表受款人、部分支付查員工代墊列、全額支付不查
// 單獨執行：node tests/card_pay_source.test.cjs

const assert = require('assert');
const { createEnv, createRunner, readSrc } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('card_pay_source.test.cjs');

// 員工匯款帳號主檔：只有 knownAccounts 裡的編號查得到
const knownAccounts = new Set(['00546', '00777']);
const accountCalls = [];
const env = createEnv({
  api: (url, method, params) => {
    if (url !== '/k/v1/records') return Promise.resolve({ users: [] });
    accountCalls.push(params);
    const codes = [...String(params.query).matchAll(/"(\d{5})"/g)].map((m) => m[1]);
    return Promise.resolve({ records: codes.filter((c) => knownAccounts.has(c)).map((c) => ({ five_digit_num: { value: c } })) });
  },
});
env.load('payment_request_config.js');
env.load('使用者主檔快取.js');
env.load('受款人填寫設定.js');
const M = env.load('公司卡付款來源.js');
const W = env.window;
const C = W.PR_CONFIG;
const F = C.FIELDS;
const P = C.CARD_PAY;
const COLS = P.TABLE.COLS;
const S = P.OPTIONS.SOURCE;
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
// 沙箱裡的物件換成本地物件再比（deepStrictEqual 會比原型）
const toCheck = (r) => JSON.parse(JSON.stringify(M.payeesToCheck(r)));
const accountErrors = async (...a) => [...(await M.checkPayeeAccounts(...a))];
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

check('匯款帳號：要查的受款人——非公司卡查主表、全額不查、部分只查格式正確的員工代墊列', () => {
  assert.deepStrictEqual(toCheck(makeRecord()), [{ label: F.PAYEE, payee: '00546 王小明', code: '00546', rowIndex: -1 }]);
  assert.deepStrictEqual(toCheck(makeRecord({ installed: false, payee: '王小明' })), [{ label: F.PAYEE, payee: '王小明', code: '', rowIndex: -1 }]);
  assert.deepStrictEqual(toCheck(makeRecord({ payee: '' })), []);
  const full = makeRecord({ flag: true, mode: FULL, payee: P.TEXT.FULL_PAYEE });
  assert.deepStrictEqual(toCheck(full), []);
  const partial = makeRecord({
    flag: true,
    mode: PARTIAL,
    payee: P.TEXT.PARTIAL_PAYEE,
    rows: [payeeRow(S.CARD, P.TEXT.CARD_PAYEE, 20), payeeRow(S.EMPLOYEE, '00777 陳大文', 500), payeeRow(S.EMPLOYEE, '王', 500)],
  });
  assert.deepStrictEqual(toCheck(partial), [{ label: `${P.TABLE.CODE}第 2 行受款人`, payee: '00777 陳大文', code: '00777', rowIndex: 1 }]);
});

check('匯款帳號：查不到的編號報「尚未建立匯款帳號」；主表沒有 5 碼報格式；作廢不查', async () => {
  const find = async (codes) => codes.filter((c) => c !== '00546');
  assert.deepStrictEqual(await accountErrors(makeRecord(), find), []);
  const missing = await accountErrors(makeRecord({ payee: '12345 新同仁' }), find);
  assert.strictEqual(missing.length, 1);
  assert.ok(missing[0].includes('12345 新同仁') && missing[0].includes('尚未建立匯款帳號') && missing[0].includes('新增員工帳號'));
  const noCode = await accountErrors(makeRecord({ payee: '王小明' }), find);
  assert.ok(noCode[0].includes('選擇員工') && noCode[0].includes('王小明'));
  const voided = makeRecord({ payee: '12345 新同仁' });
  voided[C.VOID_FIELD].value = ['作廢'];
  assert.deepStrictEqual(await accountErrors(voided, () => assert.fail('作廢不該查')), []);
});

check('匯款帳號：存檔時只查用到的編號（一次查詢），查不到併進同一個錯誤視窗；查詢失敗也擋下', async () => {
  accountCalls.length = 0;
  const ok = makeRecord({ flag: true, mode: PARTIAL, rows: [payeeRow(S.CARD, '', 520), payeeRow(S.EMPLOYEE, '00777 陳大文', 500)] });
  assert.deepStrictEqual(await submit(ok), []);
  assert.strictEqual(accountCalls.length, 1);
  assert.strictEqual(accountCalls[0].app, C.APPS.EMPLOYEE_ACCOUNT);
  assert.ok(accountCalls[0].query.includes('"00777"'));
  const bad = makeRecord({ flag: true, mode: PARTIAL, rows: [payeeRow(S.CARD, '', 520), payeeRow(S.EMPLOYEE, '99999 沒帳號', 500)] });
  const errs = await submit(bad);
  assert.strictEqual(errs.length, 1);
  assert.ok(errs[0].includes('第 2 行受款人') && errs[0].includes('99999 沒帳號'));
  accountCalls.length = 0;
  assert.deepStrictEqual(await submit(makeRecord({ flag: true, mode: FULL, payee: P.TEXT.FULL_PAYEE })), []);
  assert.strictEqual(accountCalls.length, 0, '全額支付不查');
});

check('存檔查不到匯款帳號：沒有其他錯誤 → 跳確認視窗（編號＋姓名填好）；確認 → 新增、改過的值寫回原欄位、重開儲存中提示、不擋', async () => {
  const r = makeRecord({ payee: '12345 新同仁' });
  const asked = [];
  let reopened = 0;
  const deps = {
    find: async (codes) => codes,
    confirm: async (m) => (asked.push(JSON.parse(JSON.stringify(m))), [{ code: '12346', name: '新同事' }]),
    reopen: () => (reopened += 1),
  };
  assert.deepStrictEqual([...(await M.handlePayeeAccountsOnSubmit(r, false, deps))], []);
  assert.deepStrictEqual(asked, [[{ label: F.PAYEE, payee: '12345 新同仁', code: '12345', name: '新同仁', rowIndexes: [-1] }]]);
  assert.strictEqual(r[F.PAYEE].value, '12346 新同事', '改過的值寫回主表受款人');
  assert.strictEqual(reopened, 1);
  // 部分支付：同一位員工兩列都寫回
  const p = makeRecord({ flag: true, mode: PARTIAL, rows: [payeeRow(S.CARD, '', 20), payeeRow(S.EMPLOYEE, '21211 大小小', 500), payeeRow(S.EMPLOYEE, '21211 大小小', 500)] });
  await M.handlePayeeAccountsOnSubmit(p, false, { ...deps, confirm: async () => [{ code: '21212', name: '大小中' }] });
  assert.deepStrictEqual(rowsOf(p).map((x) => x[1]), ['', '21212 大小中', '21212 大小中']);
  // 取消 → 擋下、受款人不動
  const c = makeRecord({ payee: '12345 新同仁' });
  const cancel = await M.handlePayeeAccountsOnSubmit(c, false, { ...deps, confirm: async () => null });
  assert.ok(cancel.length === 1 && cancel[0].includes('尚未建立匯款帳號'));
  assert.strictEqual(c[F.PAYEE].value, '12345 新同仁');
  // 已有其他錯誤 → 不跳視窗，直接當錯誤
  asked.length = 0;
  const other = await M.handlePayeeAccountsOnSubmit(makeRecord({ payee: '12345 新同仁' }), true, deps);
  assert.strictEqual(asked.length, 0);
  assert.strictEqual(other.length, 1);
});

check('確認視窗：編號姓名可修改；檢查 5 碼／中文姓名／重複；改成主檔已有的編號不新增；失敗不關並顯示原因；成功回最後的值', async () => {
  const missing = [{ label: F.PAYEE, payee: '12345 新同仁', code: '12345', name: '新同仁', rowIndexes: [-1] }];
  const html = M.buildConfirmHtml(missing);
  assert.ok(html.includes('value="12345"') && html.includes('value="新同仁"') && !html.includes('readonly') && html.includes('3個工作天'));
  const v = (code, name) => ({ code, name });
  const two = [missing[0], { ...missing[0], label: '第二位' }];
  assert.ok(M.validateConfirmInputs([v('1234', '新同仁')], missing).includes('5 碼'));
  assert.ok(M.validateConfirmInputs([v('12345', 'Amy')], missing).includes('中文'));
  assert.ok(M.validateConfirmInputs([v('12345', '新同仁'), v('12345', '別人')], two).includes('重複'));
  assert.strictEqual(M.validateConfirmInputs([v('12345', '新同仁')], missing), '');

  const shown = [];
  let opts = null;
  let inputs = { code: '12345', name: '新同仁' };
  const popup = { querySelector: (sel) => ({ value: sel.includes('new-code') ? inputs.code : inputs.name }) };
  W.origSwal = env.run('this.Swal'); // 測完換回 env 的 Swal 替身（後面的測試要看 swalCalls）
  W.Swal = {
    fire: async (o) => {
      opts = o;
      let out = await o.preConfirm();
      if (out === false) out = await o.preConfirm();
      return { isConfirmed: out !== false, value: out };
    },
    getPopup: () => popup,
    showValidationMessage: (m) => shown.push(m),
  };
  env.run('this.Swal = window.Swal;');
  const created = [];
  let calls = 0;
  const create = async (x) => {
    calls += 1;
    if (calls === 1) throw { code: 'CB_NO02' };
    created.push({ ...x });
  };
  inputs = { code: '12346', name: '新同事' };
  const out = await M.confirmCreateAccounts(missing, { create, find: async (codes) => codes });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), [{ code: '12346', name: '新同事' }]);
  assert.strictEqual(opts.confirmButtonText, '新增匯款帳號並儲存');
  assert.deepStrictEqual(created, [{ code: '12346', name: '新同事' }], '用修改後的值新增；失敗後再按一次才成功');
  assert.ok(shown[0].includes('權限'));
  // 改成主檔已有的編號 → 不新增，直接回傳
  created.length = 0;
  inputs = { code: '00546', name: '王小明' };
  const exist = await M.confirmCreateAccounts(missing, { create, find: async () => [] });
  assert.strictEqual(created.length, 0);
  assert.strictEqual(exist[0].code, '00546');
  env.run('delete this.Swal;');
  delete W.Swal;
  assert.strictEqual(await M.confirmCreateAccounts(missing, { create }), null, '沒有 SweetAlert → 不新增');
  env.run('this.Swal = window.origSwal; delete window.origSwal;');
});

check('員工代墊列的受款人鎖住、其他來源解開：show、改付款來源、加列都會套用', async () => {
  const r = makeRecord({ flag: true, mode: PARTIAL, rows: [payeeRow(S.CARD, '', 20), payeeRow(S.EMPLOYEE, '00546 王小明', 1000)] });
  await env.fire('app.record.edit.show', { record: r });
  assert.deepStrictEqual(r[P.TABLE.CODE].value.map((row) => row.value[COLS.PAYEE].disabled), [false, true]);
  const row = r[P.TABLE.CODE].value[0];
  row.value[COLS.PAY_SOURCE].value = S.EMPLOYEE;
  await env.fire(`app.record.edit.change.${COLS.PAY_SOURCE}`, { record: r, changes: { row } });
  assert.strictEqual(row.value[COLS.PAYEE].disabled, true);
  r[P.TABLE.CODE].value.push(payeeRow(S.CARD, '', 1));
  await env.fire(`app.record.edit.change.${P.TABLE.CODE}`, { record: r });
  assert.deepStrictEqual(r[P.TABLE.CODE].value.map((x) => x.value[COLS.PAYEE].disabled), [true, true, false]);
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
    const at = src.indexOf("'../公司卡付款來源.js");
    assert.ok(at > 0, `${file} 要接公司卡付款來源`);
    assert.ok(at < src.indexOf("'../payment_request_submit.js"), `${file}：要排在 submit 前`);
  });
  const src = readSrc('公司卡付款來源.js');
  assert.ok(!src.includes('<style') && !src.includes('cssText') && !src.includes('kintone.events.on'));
});

done();
