'use strict';

// 測試：交通費明細規則_20261022.js
//   1. 高鐵 → 賣方統編 00000000、格式 22，並鎖住；改選其他交通工具清空並解鎖
//   2. 稅額＝含稅金額 ÷ 1.05 × 0.05，四捨五入到個位數（只算高鐵票／發票，其他寫 0）；只重算變更事件改到的那一列，開畫面／存檔不動；稅額不鎖
//   3. 憑證種類＝高鐵票／發票才開放發票號碼；其他種類清空並鎖住；存檔必填、本單不可重複、重算發票號碼記錄
//   4. 有計程車 → 是否有紙本憑證自動選「是」、理由動態必填（紅色 *）；存檔驗證
//   5. 交通工具限制憑證種類：變更事件清掉不能用的、只有一種就帶入；存檔擋；桌面版選單藏起不能選的項目
//   6. 憑證種類＝無 → 賣方統編、格式、稅額清空並鎖住（show／變更事件／存檔前）；改回別的只回到權限給的鎖定狀態
//   7. 是否有紙本憑證＝否 → 會計課承辦註記是否收到單據紙本 寫「不適用」；變更事件改回「是」→ 未收到
// 單獨執行：node tests/traffic_rules.test.cjs

const assert = require('assert');
const { createEnv, createRunner } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('traffic_rules.test.cjs');

const setup = () => {
  const env = createEnv();
  env.load('payment_request_config.js');
  env.load('發票號碼寫入獨立欄位檢查.js');
  env.load('交通費明細規則_20261022.js');
  return { env, R: env.window.PR_TRAFFIC_RULES, C: env.window.PR_CONFIG };
};

const { env: env0, C } = setup();
const F = C.FIELDS;
const T = F.TRAFFIC_TABLE;
const COLS = T.COLS;
const SEP = C.SEP;
void env0;

const row = (over = {}) => {
  const value = {};
  Object.values(COLS).forEach((code) => (value[code] = { value: '' }));
  Object.entries(over).forEach(([code, v]) => (value[code] = { value: v }));
  return { value };
};
const record = (rows, over = {}) => ({
  [T.CODE]: { value: rows },
  [F.PAPER_RECEIPT]: { value: '否' },
  [F.PAPER_RECEIVED]: { value: '未收到' },
  [F.REASON]: { value: '' },
  [F.INVOICE_AGG]: { value: '' },
  ...over,
});

// ── 2. 稅額 ─────────────────────────────────────────────────────────────────
check('calcTax：含稅金額 ÷ 1.05 × 0.05 四捨五入到個位數', () => {
  const { R } = setup();
  assert.strictEqual(R.calcTax('1050'), '50');
  assert.strictEqual(R.calcTax('100'), '5'); // 4.76 → 5
  assert.strictEqual(R.calcTax('1234'), '59'); // 58.76 → 59
  assert.strictEqual(R.calcTax('10'), '0'); // 0.476 → 0
  assert.strictEqual(R.calcTax('11'), '1'); // 0.5238 → 1
  assert.strictEqual(R.calcTax(2100), '100');
  assert.strictEqual(R.calcTax('0'), '0');
});

check('calcTax：空白／非數字 → 空字串；負數（退款）照絕對值四捨五入再補負號', () => {
  const { R } = setup();
  assert.strictEqual(R.calcTax(''), '');
  assert.strictEqual(R.calcTax(undefined), '');
  assert.strictEqual(R.calcTax('abc'), '');
  assert.strictEqual(R.calcTax('-1234'), '-59');
  assert.strictEqual(R.calcTax('-5'), '0');
});

// 變更事件：kintone 用 event.changes.row 指出改到的那一列
const fireRowChange = (env, type, r, index) => env.fire(type, { record: r, changes: { row: r[T.CODE].value[index], field: {} } });
const taxOf = (r, i) => r[T.CODE].value[i].value[COLS.TAX].value;

check('金額變更事件 → 只重算被改的那一列；其他列（例如會計手改的）不動；稅額不鎖', async () => {
  const { env } = setup();
  const r = record([row({ [COLS.AMOUNT]: '1050', [COLS.RECEIPT_TYPE]: '發票' }), row({ [COLS.AMOUNT]: '315', [COLS.RECEIPT_TYPE]: '高鐵票', [COLS.TAX]: '14' })]);
  const ev = await fireRowChange(env, `app.record.create.change.${COLS.AMOUNT}`, r, 0);
  assert.strictEqual(taxOf(ev.record, 0), '50');
  assert.strictEqual(taxOf(ev.record, 1), '14', '第 2 列手改的 14 保留（系統算是 15）');
  assert.notStrictEqual(ev.record[T.CODE].value[0].value[COLS.TAX].disabled, true);
});

check('稅額只算高鐵票／發票：收據、車票、沒選憑證種類 → 改到那一列時稅額寫 0（無 → 清空，見 6.）', async () => {
  const { env } = setup();
  for (const receipt of ['收據', '車票（高鐵外）', '']) {
    const r = record([row({ [COLS.AMOUNT]: '1050', [COLS.RECEIPT_TYPE]: receipt, [COLS.TAX]: '50' })]);
    const ev = await fireRowChange(env, `app.record.edit.change.${COLS.AMOUNT}`, r, 0);
    assert.strictEqual(taxOf(ev.record, 0), '0', receipt || '沒選');
  }
});

check('憑證種類改成發票 → 那一列稅額重算；改回收據 → 變 0', async () => {
  const { env } = setup();
  const r = record([row({ [COLS.AMOUNT]: '1490', [COLS.RECEIPT_TYPE]: '發票' })]);
  let ev = await fireRowChange(env, `app.record.create.change.${COLS.RECEIPT_TYPE}`, r, 0);
  assert.strictEqual(taxOf(ev.record, 0), '71');
  ev.record[T.CODE].value[0].value[COLS.RECEIPT_TYPE].value = '收據';
  ev = await fireRowChange(env, `app.record.create.change.${COLS.RECEIPT_TYPE}`, ev.record, 0);
  assert.strictEqual(taxOf(ev.record, 0), '0');
});

check('改交通工具成高鐵 → 自動帶入高鐵票後，那一列稅額照高鐵票算', async () => {
  const { env } = setup();
  const r = record([row({ [COLS.VEHICLE]: '高鐵', [COLS.AMOUNT]: '1490' })]);
  const ev = await fireRowChange(env, `app.record.edit.change.${COLS.VEHICLE}`, r, 0);
  assert.strictEqual(ev.record[T.CODE].value[0].value[COLS.RECEIPT_TYPE].value, '高鐵票');
  assert.strictEqual(taxOf(ev.record, 0), '71');
});

check('新增列（子表格變更）→ 只算新的那一列，舊列手改的稅額不動；刪除列（沒有 changes.row）→ 都不動', async () => {
  const { env } = setup();
  const r = record([row({ [COLS.AMOUNT]: '1050', [COLS.RECEIPT_TYPE]: '發票', [COLS.TAX]: '49' }), row()]);
  let ev = await fireRowChange(env, `app.record.edit.change.${T.CODE}`, r, 1);
  assert.strictEqual(taxOf(ev.record, 0), '49');
  assert.strictEqual(taxOf(ev.record, 1), '0', '新列沒有憑證種類 → 0');
  ev = await env.fire(`app.record.edit.change.${T.CODE}`, { record: ev.record, changes: { row: null } });
  assert.strictEqual(taxOf(ev.record, 0), '49');
});

check('changes.row 是另一份物件（同列 id）時也找得到畫面上那一列', () => {
  const { R } = setup();
  const r = record([{ id: '11', ...row() }, { id: '22', ...row() }]);
  assert.strictEqual(R.changedRow({ record: r, changes: { row: { id: '22', value: {} } } }), r[T.CODE].value[1]);
  assert.strictEqual(R.changedRow({ record: r }), null);
});

check('高鐵票／發票但金額空白 → 稅額空白', () => {
  const { R } = setup();
  const r = record([row({ [COLS.RECEIPT_TYPE]: '發票' })]);
  R.recalcRowTax(r[T.CODE].value[0]);
  assert.strictEqual(taxOf(r, 0), '');
});

check('開畫面不動稅額、不鎖稅額，也不解開帳號權限設定已鎖的稅額', async () => {
  const { env } = setup();
  const r = record([row({ [COLS.AMOUNT]: '1050', [COLS.RECEIPT_TYPE]: '發票', [COLS.TAX]: '49' }), row({ [COLS.AMOUNT]: '315' })]);
  r[T.CODE].value[1].value[COLS.TAX].disabled = true; // 權限模組鎖的
  const ev = await env.fire('app.record.edit.show', { record: r });
  assert.strictEqual(taxOf(ev.record, 0), '49', '會計手改的保留');
  assert.notStrictEqual(ev.record[T.CODE].value[0].value[COLS.TAX].disabled, true);
  assert.strictEqual(ev.record[T.CODE].value[1].value[COLS.TAX].disabled, true);
});

// ── 1. 高鐵 ─────────────────────────────────────────────────────────────────
check('交通工具＝高鐵 → 賣方統編 00000000、格式 22，兩欄鎖住', async () => {
  const { env } = setup();
  const r = record([row({ [COLS.VEHICLE]: '高鐵', [COLS.SELLER_TAX_ID]: '12345678', [COLS.FORMAT]: '21' })]);
  const ev = await env.fire(`app.record.edit.change.${COLS.VEHICLE}`, { record: r });
  const v = ev.record[T.CODE].value[0].value;
  assert.strictEqual(v[COLS.SELLER_TAX_ID].value, '00000000');
  assert.strictEqual(v[COLS.FORMAT].value, '22');
  assert.strictEqual(v[COLS.SELLER_TAX_ID].disabled, true);
  assert.strictEqual(v[COLS.FORMAT].disabled, true);
});

check('改選高鐵以外（變更事件）→ 賣方統編還是高鐵固定值時，賣方統編、格式清空並解鎖', async () => {
  const { env } = setup();
  const r = record([row({ [COLS.VEHICLE]: '計程車', [COLS.SELLER_TAX_ID]: '00000000', [COLS.FORMAT]: '22' })]);
  const ev = await env.fire(`app.record.create.change.${COLS.VEHICLE}`, { record: r });
  const v = ev.record[T.CODE].value[0].value;
  assert.strictEqual(v[COLS.SELLER_TAX_ID].disabled, false);
  assert.strictEqual(v[COLS.FORMAT].disabled, false);
  assert.strictEqual(v[COLS.SELLER_TAX_ID].value, '');
  assert.strictEqual(v[COLS.FORMAT].value, '');
});

check('改選高鐵以外：使用者自己填的賣方統編、格式不清', async () => {
  const { env } = setup();
  const r = record([row({ [COLS.VEHICLE]: '計程車', [COLS.SELLER_TAX_ID]: '12345678', [COLS.FORMAT]: '22' })]);
  const ev = await env.fire(`app.record.create.change.${COLS.VEHICLE}`, { record: r });
  const v = ev.record[T.CODE].value[0].value;
  assert.strictEqual(v[COLS.SELLER_TAX_ID].value, '12345678');
  assert.strictEqual(v[COLS.FORMAT].value, '22');
});

check('開畫面（show）只加鎖不解鎖：不蓋掉帳號權限設定已鎖的欄位', async () => {
  const { env } = setup();
  const r = record([row({ [COLS.VEHICLE]: '計程車', [COLS.RECEIPT_TYPE]: '發票', [COLS.INVOICE_NO]: 'AB12345678' })]);
  r[T.CODE].value[0].value[COLS.SELLER_TAX_ID].disabled = true; // 權限模組鎖的
  r[T.CODE].value[0].value[COLS.INVOICE_NO].disabled = true;
  const ev = await env.fire('app.record.edit.show', { record: r });
  const v = ev.record[T.CODE].value[0].value;
  assert.strictEqual(v[COLS.SELLER_TAX_ID].disabled, true);
  assert.strictEqual(v[COLS.INVOICE_NO].disabled, true);
  assert.strictEqual(v[COLS.INVOICE_NO].value, 'AB12345678');
});

// ── 3. 發票號碼 ─────────────────────────────────────────────────────────────
check('憑證種類＝發票／高鐵票 → 發票號碼開放；其他種類 → 清空並鎖住，發票號碼記錄跟著重算', async () => {
  const { env } = setup();
  const r = record([
    row({ [COLS.RECEIPT_TYPE]: '發票', [COLS.INVOICE_NO]: 'AB11111111' }),
    row({ [COLS.RECEIPT_TYPE]: '高鐵票', [COLS.INVOICE_NO]: 'T001' }),
    row({ [COLS.RECEIPT_TYPE]: '收據', [COLS.INVOICE_NO]: 'XX99999999' }),
  ]);
  const ev = await env.fire(`app.record.create.change.${COLS.RECEIPT_TYPE}`, { record: r });
  const rows = ev.record[T.CODE].value;
  assert.strictEqual(rows[0].value[COLS.INVOICE_NO].disabled, false);
  assert.strictEqual(rows[1].value[COLS.INVOICE_NO].disabled, false);
  assert.strictEqual(rows[2].value[COLS.INVOICE_NO].disabled, true);
  assert.strictEqual(rows[2].value[COLS.INVOICE_NO].value, '');
  assert.strictEqual(ev.record[F.INVOICE_AGG].value, `${SEP}AB11111111${SEP}T001${SEP}`);
});

check('新增列（子表格變更事件）→ 新列沒選憑證種類，發票號碼鎖住', async () => {
  const { env } = setup();
  const r = record([row({ [COLS.RECEIPT_TYPE]: '發票', [COLS.INVOICE_NO]: 'A1' }), row()]);
  const ev = await env.fire(`app.record.edit.change.${T.CODE}`, { record: r });
  assert.strictEqual(ev.record[T.CODE].value[1].value[COLS.INVOICE_NO].disabled, true);
});

check('validate：發票／高鐵票沒填發票號碼 → 必填錯誤，點名第幾行', () => {
  const { R } = setup();
  const errs = R.validate(record([row({ [COLS.RECEIPT_TYPE]: '發票' }), row({ [COLS.RECEIPT_TYPE]: '收據' })]));
  assert.strictEqual(errs.length, 1);
  assert.ok(errs[0].includes('第 1 行') && errs[0].includes(COLS.INVOICE_NO), errs[0]);
});

check('validate：同一張發票在本單填兩次 → 錯誤列出重複的行；前後空白視為相同', () => {
  const { R } = setup();
  const r = record([
    row({ [COLS.RECEIPT_TYPE]: '發票', [COLS.INVOICE_NO]: 'AB12345678' }),
    row({ [COLS.RECEIPT_TYPE]: '高鐵票', [COLS.INVOICE_NO]: 'T1' }),
    row({ [COLS.RECEIPT_TYPE]: '發票', [COLS.INVOICE_NO]: ' AB12345678 ' }),
  ]);
  const errs = R.validate(r);
  assert.strictEqual(errs.length, 1);
  assert.ok(errs[0].includes('AB12345678') && errs[0].includes('1、3'), errs[0]);
});

check('normalize：存檔前不動稅額（會計手改的保留），高鐵固定值、清掉非發票列的號碼並重算發票號碼記錄（去重）', () => {
  const { R } = setup();
  const r = record([
    row({ [COLS.VEHICLE]: '高鐵', [COLS.AMOUNT]: '1490', [COLS.RECEIPT_TYPE]: '高鐵票', [COLS.INVOICE_NO]: ' T9 ', [COLS.TAX]: '71' }),
    row({ [COLS.AMOUNT]: '200', [COLS.RECEIPT_TYPE]: '收據', [COLS.INVOICE_NO]: 'ZZ' }),
    row({ [COLS.AMOUNT]: '300', [COLS.RECEIPT_TYPE]: '發票', [COLS.INVOICE_NO]: 'T9' }),
  ]);
  r[F.INVOICE_AGG].value = `${SEP}OLD${SEP}`;
  r[T.CODE].value[2].value[COLS.TAX].value = '13'; // 會計手改（系統算是 14）
  R.normalize(r);
  const rows = r[T.CODE].value;
  assert.strictEqual(rows[0].value[COLS.TAX].value, '71');
  assert.strictEqual(rows[2].value[COLS.TAX].value, '13');
  assert.strictEqual(rows[0].value[COLS.SELLER_TAX_ID].value, '00000000');
  assert.strictEqual(rows[0].value[COLS.FORMAT].value, '22');
  assert.strictEqual(rows[0].value[COLS.INVOICE_NO].value, 'T9');
  assert.strictEqual(rows[1].value[COLS.INVOICE_NO].value, '');
  assert.strictEqual(r[F.INVOICE_AGG].value, `${SEP}T9${SEP}`);
  assert.ok(R.validate(r).some((e) => e.includes('T9')), '整理後本單重複要被抓到');
});

// ── 4. 計程車 ───────────────────────────────────────────────────────────────
check('有計程車 → 是否有紙本憑證自動選「是」；沒有計程車不動', async () => {
  const { env } = setup();
  let ev = await env.fire(`app.record.create.change.${COLS.VEHICLE}`, { record: record([row({ [COLS.VEHICLE]: '計程車' })]) });
  assert.strictEqual(ev.record[F.PAPER_RECEIPT].value, '是');
  ev = await env.fire(`app.record.create.change.${COLS.VEHICLE}`, { record: record([row({ [COLS.VEHICLE]: '高鐵' })]) });
  assert.strictEqual(ev.record[F.PAPER_RECEIPT].value, '否');
});

check('validate：有計程車但紙本憑證不是「是」、理由空白 → 兩條錯誤；補齊後通過', () => {
  const { R } = setup();
  const r = record([row({ [COLS.VEHICLE]: '計程車' })]);
  let errs = R.validate(r);
  assert.strictEqual(errs.length, 2);
  assert.ok(errs[0].includes(F.PAPER_RECEIPT) && errs[1].includes(F.REASON));
  r[F.PAPER_RECEIPT].value = '是';
  r[F.REASON].value = '   ';
  errs = R.validate(r);
  assert.strictEqual(errs.length, 1, '只有空白也算沒填');
  r[F.REASON].value = '深夜無大眾運輸';
  assert.deepStrictEqual([...R.validate(r)], []);
});

check('validate：沒有計程車 → 理由與紙本憑證不檢查', () => {
  const { R } = setup();
  assert.deepStrictEqual([...R.validate(record([row({ [COLS.VEHICLE]: '高鐵' })]))], []);
});

check('理由動態必填：有計程車在「理由」標籤後加紅色 *；沒有計程車／找不到標籤不報錯', async () => {
  const { env, R } = setup();
  const label = { textContent: '理由（計程車）', children: [], appendChild(c) { this.children.push(c); } };
  const other = { textContent: '備註', children: [], appendChild(c) { this.children.push(c); } };
  env.setQuerySelectorAll((sel) => (sel === '.control-label-text-gaia' ? [other, label] : []));
  await env.fire(`app.record.create.change.${COLS.VEHICLE}`, { record: record([row({ [COLS.VEHICLE]: '計程車' })]) });
  assert.strictEqual(label.children.length, 1);
  assert.strictEqual(label.children[0].textContent, '*');
  assert.strictEqual(other.children.length, 0);

  assert.doesNotThrow(() => R.updateReasonRequiredMark(false));
  env.setQuerySelectorAll(() => []);
  assert.doesNotThrow(() => R.updateReasonRequiredMark(true));
});

check('事件註冊：create/edit 的 show，以及子表格／交通工具／金額／憑證種類的 change', () => {
  const { env } = setup();
  const types = env.registeredTypes();
  ['app.record.create.show', 'app.record.edit.show'].forEach((t) => assert.ok(types.includes(t), t));
  [T.CODE, COLS.VEHICLE, COLS.AMOUNT, COLS.RECEIPT_TYPE].forEach((code) => {
    assert.ok(types.includes(`app.record.create.change.${code}`), code);
    assert.ok(types.includes(`app.record.edit.change.${code}`), code);
  });
});

// ── 5. 交通工具限制憑證種類 ─────────────────────────────────────────────────
check('改交通工具：憑證種類不能用就清空（計程車不能選高鐵票），可以用就保留', async () => {
  const { env } = setup();
  let ev = await env.fire(`app.record.edit.change.${COLS.VEHICLE}`, {
    record: record([row({ [COLS.VEHICLE]: '計程車', [COLS.RECEIPT_TYPE]: '高鐵票', [COLS.INVOICE_NO]: 'T1' })]),
  });
  let v = ev.record[T.CODE].value[0].value;
  assert.strictEqual(v[COLS.RECEIPT_TYPE].value, '');
  assert.strictEqual(v[COLS.INVOICE_NO].value, '', '憑證種類清掉，發票號碼跟著清');
  ev = await env.fire(`app.record.edit.change.${COLS.VEHICLE}`, { record: record([row({ [COLS.VEHICLE]: '計程車', [COLS.RECEIPT_TYPE]: '收據' })]) });
  assert.strictEqual(ev.record[T.CODE].value[0].value[COLS.RECEIPT_TYPE].value, '收據');
});

check('改憑證種類：選了這個交通工具不能用的 → 清空', async () => {
  const { env } = setup();
  const ev = await env.fire(`app.record.create.change.${COLS.RECEIPT_TYPE}`, { record: record([row({ [COLS.VEHICLE]: 'Uber', [COLS.RECEIPT_TYPE]: '無' })]) });
  assert.strictEqual(ev.record[T.CODE].value[0].value[COLS.RECEIPT_TYPE].value, '');
});

check('選高鐵：只能高鐵票 → 自動帶入，發票號碼開放', async () => {
  const { env } = setup();
  const ev = await env.fire(`app.record.create.change.${COLS.VEHICLE}`, { record: record([row({ [COLS.VEHICLE]: '高鐵', [COLS.RECEIPT_TYPE]: '發票' })]) });
  const v = ev.record[T.CODE].value[0].value;
  assert.strictEqual(v[COLS.RECEIPT_TYPE].value, '高鐵票');
  assert.strictEqual(v[COLS.INVOICE_NO].disabled, false);
});

check('開畫面不改憑證種類（舊單照原樣顯示），存檔時 validate 擋下並列出可選項目', async () => {
  const { env, R } = setup();
  const r = record([row({ [COLS.VEHICLE]: '計程車', [COLS.RECEIPT_TYPE]: '高鐵票', [COLS.INVOICE_NO]: 'T1' })]);
  const ev = await env.fire('app.record.edit.show', { record: r });
  assert.strictEqual(ev.record[T.CODE].value[0].value[COLS.RECEIPT_TYPE].value, '高鐵票');
  const errs = R.validate(r);
  assert.ok(errs.some((e) => e.includes('第 1 行') && e.includes('計程車') && e.includes('高鐵票') && e.includes('發票、收據')), errs.join('\n'));
});

check('allowedReceiptTypes：交通工具空白 → null（不限制）', () => {
  const { R } = setup();
  assert.strictEqual(R.allowedReceiptTypes(''), null);
  assert.deepStrictEqual([...R.allowedReceiptTypes('高鐵')], ['高鐵票']);
});

// ── 6. 憑證種類＝無 → 賣方統編、格式、稅額清空並鎖住 ───────────────────────
const NO_COLS = [COLS.SELLER_TAX_ID, COLS.FORMAT, COLS.TAX];
const assertNoReceiptRow = (v, label) => {
  NO_COLS.forEach((code) => {
    assert.strictEqual(v[code].value, '', `${label}：${code} 清空`);
    assert.strictEqual(v[code].disabled, true, `${label}：${code} 鎖住`);
  });
};

check('改憑證種類成「無」（create／edit 變更事件）→ 賣方統編、格式、稅額清空並鎖住；別的列不動', async () => {
  for (const type of ['create', 'edit']) {
    const { env } = setup();
    const r = record([
      row({ [COLS.VEHICLE]: '捷運／公車', [COLS.AMOUNT]: '1050', [COLS.RECEIPT_TYPE]: '無', [COLS.SELLER_TAX_ID]: '12345678', [COLS.FORMAT]: '21', [COLS.TAX]: '50' }),
      row({ [COLS.VEHICLE]: '計程車', [COLS.AMOUNT]: '1050', [COLS.RECEIPT_TYPE]: '發票', [COLS.SELLER_TAX_ID]: '87654321', [COLS.FORMAT]: '21', [COLS.TAX]: '50' }),
    ]);
    const ev = await fireRowChange(env, `app.record.${type}.change.${COLS.RECEIPT_TYPE}`, r, 0);
    assertNoReceiptRow(ev.record[T.CODE].value[0].value, type);
    const other = ev.record[T.CODE].value[1].value;
    assert.strictEqual(other[COLS.SELLER_TAX_ID].value, '87654321');
    assert.strictEqual(other[COLS.TAX].value, '50');
    assert.notStrictEqual(other[COLS.TAX].disabled, true);
  }
});

check('create.show／edit.show：已選「無」的列清空並鎖住', async () => {
  for (const type of ['create', 'edit']) {
    const { env } = setup();
    const r = record([row({ [COLS.VEHICLE]: '捷運／公車', [COLS.RECEIPT_TYPE]: '無', [COLS.SELLER_TAX_ID]: '12345678', [COLS.FORMAT]: '21', [COLS.TAX]: '5' })]);
    const ev = await env.fire(`app.record.${type}.show`, { record: r });
    assertNoReceiptRow(ev.record[T.CODE].value[0].value, `${type}.show`);
  }
});

check('detail.show 不處理（唯讀頁面不清值）', async () => {
  const { env } = setup();
  assert.ok(!env.registeredTypes().includes('app.record.detail.show'));
});

check('從「無」改回發票 → 三欄解鎖，稅額重算', async () => {
  const { env } = setup();
  const r = record([row({ [COLS.VEHICLE]: '捷運／公車', [COLS.AMOUNT]: '1050', [COLS.RECEIPT_TYPE]: '無' })]);
  let ev = await fireRowChange(env, `app.record.edit.change.${COLS.RECEIPT_TYPE}`, r, 0);
  ev.record[T.CODE].value[0].value[COLS.VEHICLE].value = '計程車'; // 「無」只有捷運／公車能選，要改回發票得先換成能開發票的交通工具
  ev.record[T.CODE].value[0].value[COLS.RECEIPT_TYPE].value = '發票';
  ev = await fireRowChange(env, `app.record.edit.change.${COLS.RECEIPT_TYPE}`, ev.record, 0);
  const v = ev.record[T.CODE].value[0].value;
  NO_COLS.forEach((code) => assert.strictEqual(v[code].disabled, false, code));
  assert.strictEqual(v[COLS.TAX].value, '50');
});

// ── 6. 憑證種類＝收據 → 賣方統編、格式清空並鎖住，稅額 0 並鎖住 ──────────────
const assertPlainReceiptRow = (v, label) => {
  assert.strictEqual(v[COLS.SELLER_TAX_ID].value, '', `${label}：賣方統編清空`);
  assert.strictEqual(v[COLS.FORMAT].value, '', `${label}：格式清空`);
  assert.strictEqual(v[COLS.TAX].value, '0', `${label}：稅額 0`);
  assert.strictEqual(v[COLS.INVOICE_NO].value, '', `${label}：發票號碼清空`);
  [...NO_COLS, COLS.INVOICE_NO].forEach((code) => assert.strictEqual(v[code].disabled, true, `${label}：${code} 鎖住`));
};

check('改憑證種類成「收據」（create／edit 變更事件）→ 賣方統編、格式、發票號碼清空鎖住，稅額 0 鎖住；別的列不動', async () => {
  for (const type of ['create', 'edit']) {
    const { env } = setup();
    const r = record([
      row({ [COLS.VEHICLE]: '計程車', [COLS.AMOUNT]: '1050', [COLS.RECEIPT_TYPE]: '收據', [COLS.SELLER_TAX_ID]: '12345678', [COLS.FORMAT]: '21', [COLS.TAX]: '50', [COLS.INVOICE_NO]: 'AB12345678' }),
      row({ [COLS.VEHICLE]: '計程車', [COLS.AMOUNT]: '1050', [COLS.RECEIPT_TYPE]: '發票', [COLS.SELLER_TAX_ID]: '87654321', [COLS.FORMAT]: '21', [COLS.TAX]: '50' }),
    ]);
    const ev = await fireRowChange(env, `app.record.${type}.change.${COLS.RECEIPT_TYPE}`, r, 0);
    assertPlainReceiptRow(ev.record[T.CODE].value[0].value, type);
    const other = ev.record[T.CODE].value[1].value;
    assert.strictEqual(other[COLS.SELLER_TAX_ID].value, '87654321');
    assert.strictEqual(other[COLS.TAX].value, '50');
    assert.notStrictEqual(other[COLS.TAX].disabled, true);
  }
});

check('create.show／edit.show、改金額、存檔前 normalize：收據的列一律清空鎖住、稅額 0', async () => {
  for (const type of ['create', 'edit']) {
    const { env } = setup();
    const r = record([row({ [COLS.VEHICLE]: '火車', [COLS.AMOUNT]: '1050', [COLS.RECEIPT_TYPE]: '收據', [COLS.SELLER_TAX_ID]: '12345678', [COLS.FORMAT]: '21', [COLS.TAX]: '50' })]);
    const ev = await env.fire(`app.record.${type}.show`, { record: r });
    assertPlainReceiptRow(ev.record[T.CODE].value[0].value, `${type}.show`);
  }
  const { env, R } = setup();
  const r = record([row({ [COLS.VEHICLE]: '計程車', [COLS.AMOUNT]: '2100', [COLS.RECEIPT_TYPE]: '收據' })]);
  const ev = await fireRowChange(env, `app.record.edit.change.${COLS.AMOUNT}`, r, 0);
  assertPlainReceiptRow(ev.record[T.CODE].value[0].value, '改金額');
  const r2 = record([row({ [COLS.RECEIPT_TYPE]: '收據', [COLS.SELLER_TAX_ID]: '1', [COLS.FORMAT]: '2', [COLS.TAX]: '3' })]);
  R.normalize(r2);
  const v2 = r2[T.CODE].value[0].value;
  assert.deepStrictEqual([v2[COLS.SELLER_TAX_ID].value, v2[COLS.FORMAT].value, v2[COLS.TAX].value], ['', '', '0']);
});

check('從「無」改收據 → 仍鎖住、稅額 0；收據改發票 → 解鎖、稅額重算', async () => {
  const { env } = setup();
  const r = record([row({ [COLS.VEHICLE]: '捷運／公車', [COLS.AMOUNT]: '1050', [COLS.RECEIPT_TYPE]: '無' })]);
  let ev = await fireRowChange(env, `app.record.edit.change.${COLS.RECEIPT_TYPE}`, r, 0);
  ev.record[T.CODE].value[0].value[COLS.RECEIPT_TYPE].value = '收據';
  ev = await fireRowChange(env, `app.record.edit.change.${COLS.RECEIPT_TYPE}`, ev.record, 0);
  ev.record[T.CODE].value[0].value[COLS.VEHICLE].value = '計程車'; // 捷運／公車不能選發票，先換成能開發票的交通工具
  assertPlainReceiptRow(ev.record[T.CODE].value[0].value, '無→收據');
  ev.record[T.CODE].value[0].value[COLS.RECEIPT_TYPE].value = '發票';
  ev = await fireRowChange(env, `app.record.edit.change.${COLS.RECEIPT_TYPE}`, ev.record, 0);
  const v = ev.record[T.CODE].value[0].value;
  [...NO_COLS, COLS.INVOICE_NO].forEach((code) => assert.strictEqual(v[code].disabled, false, code));
  assert.strictEqual(v[COLS.TAX].value, '50');
});

check('lockedColsOf：收據＝賣方統編、格式、稅額寫 0；車票＝只有賣方統編；發票、高鐵票、空白＝不鎖', () => {
  const { R } = setup();
  const of = (t) => JSON.parse(JSON.stringify(R.lockedColsOf(row({ [COLS.RECEIPT_TYPE]: t }))));
  assert.deepStrictEqual(of('收據'), { sellerTaxId: true, format: true, tax: '0' });
  assert.deepStrictEqual(of('車票（高鐵外）'), { sellerTaxId: true, format: false, tax: null });
  ['發票', '高鐵票', ''].forEach((t) => assert.deepStrictEqual(of(t), { sellerTaxId: false, format: false, tax: null }, t));
});

check('憑證種類＝車票 → 賣方統編清空並鎖住；格式、稅額不鎖（稅額照舊寫 0）；改成收據以外解鎖', async () => {
  const { env, R } = setup();
  const r = record([row({ [COLS.VEHICLE]: '火車', [COLS.AMOUNT]: '1050', [COLS.RECEIPT_TYPE]: '車票（高鐵外）', [COLS.SELLER_TAX_ID]: '12345678', [COLS.FORMAT]: '21' })]);
  let ev = await fireRowChange(env, `app.record.edit.change.${COLS.RECEIPT_TYPE}`, r, 0);
  let v = ev.record[T.CODE].value[0].value;
  assert.strictEqual(v[COLS.SELLER_TAX_ID].value, '');
  assert.strictEqual(v[COLS.SELLER_TAX_ID].disabled, true);
  assert.strictEqual(v[COLS.FORMAT].value, '21', '格式不動');
  assert.notStrictEqual(v[COLS.FORMAT].disabled, true);
  assert.strictEqual(v[COLS.TAX].value, '0');
  assert.notStrictEqual(v[COLS.TAX].disabled, true);
  ev.record[T.CODE].value[0].value[COLS.VEHICLE].value = '計程車';
  ev.record[T.CODE].value[0].value[COLS.RECEIPT_TYPE].value = '發票';
  ev = await fireRowChange(env, `app.record.edit.change.${COLS.RECEIPT_TYPE}`, ev.record, 0);
  assert.strictEqual(ev.record[T.CODE].value[0].value[COLS.SELLER_TAX_ID].disabled, false, '改發票解鎖');
  // 開畫面與存檔前也清空鎖住
  const r2 = record([row({ [COLS.VEHICLE]: '火車', [COLS.RECEIPT_TYPE]: '車票（高鐵外）', [COLS.SELLER_TAX_ID]: '99999999' })]);
  ev = await env.fire('app.record.create.show', { record: r2 });
  v = ev.record[T.CODE].value[0].value;
  assert.strictEqual(v[COLS.SELLER_TAX_ID].value, '');
  assert.strictEqual(v[COLS.SELLER_TAX_ID].disabled, true);
  const r3 = record([row({ [COLS.RECEIPT_TYPE]: '車票（高鐵外）', [COLS.SELLER_TAX_ID]: '99999999' })]);
  R.normalize(r3);
  assert.strictEqual(r3[T.CODE].value[0].value[COLS.SELLER_TAX_ID].value, '');
});

check('改回別的種類時只回到開畫面的權限狀態：帳號權限設定鎖住的稅額不會被打開', async () => {
  const { env } = setup();
  const r = record([row({ [COLS.VEHICLE]: '計程車', [COLS.AMOUNT]: '1050', [COLS.RECEIPT_TYPE]: '收據' })]);
  r[T.CODE].value[0].value[COLS.TAX].disabled = true; // 權限模組鎖的
  let ev = await env.fire('app.record.edit.show', { record: r });
  ev.record[T.CODE].value[0].value[COLS.RECEIPT_TYPE].value = '無';
  ev = await fireRowChange(env, `app.record.edit.change.${COLS.RECEIPT_TYPE}`, ev.record, 0);
  assert.strictEqual(ev.record[T.CODE].value[0].value[COLS.TAX].disabled, true);
  ev.record[T.CODE].value[0].value[COLS.RECEIPT_TYPE].value = '發票';
  ev = await fireRowChange(env, `app.record.edit.change.${COLS.RECEIPT_TYPE}`, ev.record, 0);
  const v = ev.record[T.CODE].value[0].value;
  assert.strictEqual(v[COLS.TAX].disabled, true, '權限鎖的稅額維持鎖住');
  assert.strictEqual(v[COLS.SELLER_TAX_ID].disabled, false, '權限沒鎖的賣方統編解鎖');
});

check('改交通工具（變更事件）時「無」的列一樣清空並鎖住；normalize（存檔前）也清空', async () => {
  const { env, R } = setup();
  const r = record([row({ [COLS.VEHICLE]: '捷運／公車', [COLS.RECEIPT_TYPE]: '無', [COLS.TAX]: '9', [COLS.FORMAT]: '21' })]);
  const ev = await fireRowChange(env, `app.record.edit.change.${COLS.VEHICLE}`, r, 0);
  assertNoReceiptRow(ev.record[T.CODE].value[0].value, '改交通工具');
  const r2 = record([row({ [COLS.RECEIPT_TYPE]: '無', [COLS.SELLER_TAX_ID]: '1', [COLS.FORMAT]: '2', [COLS.TAX]: '3' })]);
  R.normalize(r2);
  NO_COLS.forEach((code) => assert.strictEqual(r2[T.CODE].value[0].value[code].value, '', code));
});

check('lockedColsOf：無＝賣方統編、格式、稅額全部清空', () => {
  const { R } = setup();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(R.lockedColsOf(row({ [COLS.RECEIPT_TYPE]: '無' })))), { sellerTaxId: true, format: true, tax: '' });
});

// ── 7. 是否有紙本憑證＝否 → 會計課承辦註記是否收到單據紙本＝不適用 ─────────────
const receivedOf = (r) => r[F.PAPER_RECEIVED].value;

check('create.show／edit.show：是否有紙本憑證＝否 → 寫「不適用」；＝是 → 不動（會計選的保留）', async () => {
  for (const type of ['create', 'edit']) {
    const { env } = setup();
    let ev = await env.fire(`app.record.${type}.show`, { record: record([row({ [COLS.VEHICLE]: '火車' })]) });
    assert.strictEqual(receivedOf(ev.record), '不適用', `${type}：否`);
    const r = record([row({ [COLS.VEHICLE]: '火車' })], { [F.PAPER_RECEIPT]: { value: '是' }, [F.PAPER_RECEIVED]: { value: '已收到' } });
    ev = await env.fire(`app.record.${type}.show`, { record: r });
    assert.strictEqual(receivedOf(ev.record), '已收到', `${type}：是`);
  }
});

check('是否有紙本憑證的變更事件：改成否 → 不適用；改回是 → 未收到', async () => {
  const { env } = setup();
  const r = record([row({ [COLS.VEHICLE]: '火車' })], { [F.PAPER_RECEIPT]: { value: '是' } });
  r[F.PAPER_RECEIPT].value = '否';
  let ev = await env.fire(`app.record.edit.change.${F.PAPER_RECEIPT}`, { record: r });
  assert.strictEqual(receivedOf(ev.record), '不適用');
  ev.record[F.PAPER_RECEIPT].value = '是';
  ev = await env.fire(`app.record.edit.change.${F.PAPER_RECEIPT}`, { record: ev.record });
  assert.strictEqual(receivedOf(ev.record), '未收到');
});

check('原本邏輯維持：有計程車 → 是否有紙本憑證強制「是」，不適用改回未收到；改否也會被拉回是', async () => {
  const { env } = setup();
  const r = record([row({ [COLS.VEHICLE]: '計程車' })], { [F.PAPER_RECEIVED]: { value: '不適用' } });
  const ev = await env.fire(`app.record.create.change.${F.PAPER_RECEIPT}`, { record: r });
  assert.strictEqual(ev.record[F.PAPER_RECEIPT].value, '是');
  assert.strictEqual(receivedOf(ev.record), '未收到');
});

check('normalize（存檔前）：否 → 不適用；是＋不適用 → 不動（只有變更事件才改回）', () => {
  const { R } = setup();
  const r = record([row({ [COLS.VEHICLE]: '火車' })]);
  R.normalize(r);
  assert.strictEqual(receivedOf(r), '不適用');
  const r2 = record([row({ [COLS.VEHICLE]: '火車' })], { [F.PAPER_RECEIPT]: { value: '是' }, [F.PAPER_RECEIVED]: { value: '不適用' } });
  R.normalize(r2);
  assert.strictEqual(receivedOf(r2), '不適用');
});

check('事件註冊：是否有紙本憑證的 create／edit change', () => {
  const { env } = setup();
  const types = env.registeredTypes();
  assert.ok(types.includes(`app.record.create.change.${F.PAPER_RECEIPT}`));
  assert.ok(types.includes(`app.record.edit.change.${F.PAPER_RECEIPT}`));
});

/** 假 DOM：一列子表格（交通工具、憑證種類兩欄）＋一個選單 */
const fakeEl = (tag, { text = '', cls = [] } = {}) => {
  const el = {
    tag,
    textContent: text,
    children: [],
    parentNode: null,
    classes: new Set(cls),
    classList: { toggle: (c, on) => (on ? el.classes.add(c) : el.classes.delete(c)) },
    append(...kids) {
      kids.forEach((k) => {
        k.parentNode = el;
        el.children.push(k);
      });
      return el;
    },
    matches: (sel) => sel.split(',').some((s) => (s.trim().startsWith('.') ? el.classes.has(s.trim().slice(1)) : el.tag === s.trim())),
    closest(sel) {
      for (let n = el; n; n = n.parentNode) if (n.matches(sel)) return n;
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      const [first, second] = sel.split(' ');
      const walk = (n, inFirst) => n.children.forEach((k) => {
        const hit = second ? inFirst && k.matches(second) : k.matches(first);
        if (hit) out.push(k);
        walk(k, inFirst || (second && k.matches(first)));
      });
      walk(el, false);
      return out;
    },
  };
  return el;
};

check('menuContext：點憑證種類欄的下拉 → 依這列交通工具限制；點交通工具欄 → 不限制；不是交通費明細 → undefined', () => {
  const { env, R } = setup();
  env.currentRecord = record([row({ [COLS.VEHICLE]: '計程車' })]);
  const thead = fakeEl('thead').append(fakeEl('tr').append(fakeEl('th', { text: '交通工具*' }), fakeEl('th', { text: '憑證種類*' })));
  const vehicleSel = fakeEl('div', { cls: ['gaia-argoui-select'] });
  const receiptSel = fakeEl('div', { cls: ['gaia-argoui-select'] });
  const tbody = fakeEl('tbody').append(fakeEl('tr').append(fakeEl('td').append(vehicleSel), fakeEl('td').append(receiptSel)));
  fakeEl('table').append(thead, tbody);
  assert.deepStrictEqual([...R.menuContext(receiptSel).allowed], ['發票', '收據']);
  assert.strictEqual(R.menuContext(vehicleSel).allowed, null);
  const other = fakeEl('div', { cls: ['gaia-argoui-select'] });
  fakeEl('table').append(fakeEl('thead').append(fakeEl('tr').append(fakeEl('th', { text: '公司' }))), fakeEl('tbody').append(fakeEl('tr').append(fakeEl('td').append(other))));
  assert.strictEqual(R.menuContext(other), undefined);
});

check('filterMenuItems：藏起不能選的憑證種類、不碰「-----」；allowed＝null 全部還原', () => {
  const { R } = setup();
  const items = ['-----', '高鐵票', '車票（高鐵外）', '發票', '收據', '無'].map((t) => fakeEl('div', { text: t, cls: ['goog-menuitem'] }));
  const menu = fakeEl('div', { cls: ['goog-menu'] }).append(...items);
  assert.strictEqual(R.filterMenuItems(menu, ['發票', '收據']), 3);
  assert.deepStrictEqual(items.filter((i) => i.classes.has('pr-option-hidden')).map((i) => i.textContent), ['高鐵票', '車票（高鐵外）', '無']);
  assert.strictEqual(R.filterMenuItems(menu, null), 0);
  assert.ok(items.every((i) => !i.classes.has('pr-option-hidden')));
});

done();
