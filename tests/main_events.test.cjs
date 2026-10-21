'use strict';

// 測試：payment_request_main_20260521.js 的畫面事件（749 交通費請款單）
//   1. 說明文字 Space_Noti_1/2/3（不再依類型切換）
//   2. 欄位鎖定：請款日期鎖、申請人／申請人部門／受款人只有管理員能改、會計單位承辦人／權限開放人員只有管理員看得到、
//      手動簽核欄位在詳細頁有勾才顯示
//   3. 費用歸屬變更：轉大寫、依 LOCATION 判斷會計單位（機場／海運特殊代碼、單一據點、多據點回 TPE、手動簽核不動）
//   4. 費用歸屬中文名稱（綠字）／代碼不存在（紅字）提示
//   5. 詳細頁／列印頁的 autoProcessAllTables、新增頁的取消按鈕重綁
//   6. 稅額不自動算、已刪的 723 功能不再註冊事件
// 單獨執行：node tests/main_events.test.cjs

const assert = require('assert');
const { createEnv, createRunner, readSrc } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('main_events.test.cjs');

const plain = (v) => JSON.parse(JSON.stringify(v));

/** 載入 main；costCenters 為費用歸屬主檔記錄 [{code, loc, name}] */
const loadMain = async ({ loginCode = 'someone', costCenters = [] } = {}) => {
  const env = createEnv({
    appId: 749,
    loginCode,
    api: (url, method) => {
      if (method === 'POST') return Promise.resolve({ id: 'c' });
      const CC = env.window.PR_CONFIG.REF_FIELDS.COST_CENTER;
      return Promise.resolve({
        records: costCenters.map((c) => ({ [CC.CODE]: { value: c.code }, [CC.LOCATION]: { value: c.loc || '' }, [CC.NAME]: { value: c.name || '' } })),
        next: false,
      });
    },
  });
  env.load('payment_request_config.js');
  env.load('payment_request_main_20260521.js');
  await env.window.PR_COST_CENTER.ensureLoaded();
  return { env, C: env.window.PR_CONFIG, F: env.window.PR_CONFIG.FIELDS };
};

const baseRecord = (F, { orgCode = '總務部-總務課', orgName = '總務部-總務課', codes = [''], status } = {}) => {
  const T = F.TRAFFIC_TABLE;
  const record = {
    [F.PAYMENT_DATE]: { value: '2026-10-21' },
    [F.APPLICANT]: { value: [{ code: 'u1', name: 'U1' }] },
    [F.APPLICANT_ORG]: { value: [{ code: orgCode, name: orgName }] },
    [F.EXPENSE_OWNER]: { value: [{ code: 'u1', name: 'U1' }] },
    [F.EXPENSE_OWNER_ORG]: { value: [{ code: orgCode, name: orgName }] },
    [F.PAYEE]: { value: '' },
    [F.COMPANY_NAME]: { value: '' },
    [F.ACCOUNTING_UNIT]: { value: [] },
    [F.MANUAL_FLOW]: { value: [] },
    [T.CODE]: { value: codes.map((c) => ({ value: { [T.COLS.EXPENSE]: { value: c } } })) },
  };
  if (status !== undefined) record[F.STATUS_FIELD] = { value: status };
  return record;
};

const fireCost = (env, F, record, phase = 'create') => env.fire(`app.record.${phase}.change.${F.TRAFFIC_TABLE.COLS.EXPENSE}`, { record });
const accountingCode = (ev, F) => ev.record[F.ACCOUNTING_UNIT].value?.[0]?.code;

// ── 1. 說明文字 ─────────────────────────────────────────────────────────────
check('Space_Noti_1 空白；Space_Noti_2 為付款方式／付款原則／交通費請款三行；Space_Noti_3 為受款人說明', async () => {
  const { env, C, F } = await loadMain();
  await env.fire('app.record.create.show', { record: baseRecord(F) });
  const text = (id) => env.spaces[id].innerHTML.replace(/<[^>]+>/g, '').replace(/&ensp;/g, '');
  assert.strictEqual(env.spaces[C.SPACES.NOTI_1].innerHTML, '');
  const noti2 = env.spaces[C.SPACES.NOTI_2].innerHTML;
  assert.strictEqual(noti2.split('<br>').length, 3);
  assert.ok(text(C.SPACES.NOTI_2).includes('付款方式：皆以電匯為主，除特殊情況才可使用現金'));
  assert.ok(text(C.SPACES.NOTI_2).includes('付款原則：一般帳款２個月，特殊期限請標註日期'));
  assert.ok(text(C.SPACES.NOTI_2).includes('交通費請款：搭乘計程車請說明理由'));
  assert.ok(text(C.SPACES.NOTI_3).includes('受款人為員工 ➡︎ 員工編號＋中文姓名'));
});

check('說明文字在新增／編輯／詳細／列印四種畫面都有套用，且不碰「請款單使用須知」按鈕的空白欄位', async () => {
  const { env, C, F } = await loadMain();
  for (const type of ['create', 'edit', 'detail', 'print']) {
    delete env.spaces[C.SPACES.NOTI_3];
    await env.fire(`app.record.${type}.show`, { record: baseRecord(F) });
    assert.ok(env.spaces[C.SPACES.NOTI_3].innerHTML.includes('受款人為員工'), type);
  }
  assert.ok(!('Purchase_button' in env.spaces));
  assert.ok(!readSrc('payment_request_main_20260521.js').includes('Purchase_button'));
});

// ── 2. 欄位鎖定 ─────────────────────────────────────────────────────────────
check('一般使用者：請款日期、申請人、申請人部門、受款人鎖住；費用所屬人與其部門不鎖', async () => {
  const { env, F } = await loadMain({ loginCode: 'someone' });
  for (const type of ['create', 'edit']) {
    const ev = await env.fire(`app.record.${type}.show`, { record: baseRecord(F) });
    assert.strictEqual(ev.record[F.PAYMENT_DATE].disabled, true);
    assert.strictEqual(ev.record[F.APPLICANT].disabled, true);
    assert.strictEqual(ev.record[F.APPLICANT_ORG].disabled, true);
    assert.strictEqual(ev.record[F.PAYEE].disabled, true);
    assert.ok(!ev.record[F.EXPENSE_OWNER].disabled);
    assert.ok(!ev.record[F.EXPENSE_OWNER_ORG].disabled);
  }
});

check('管理員：請款日期仍鎖住，但申請人、申請人部門、受款人可改', async () => {
  const { env, F } = await loadMain({ loginCode: '24136' });
  const ev = await env.fire('app.record.create.show', { record: baseRecord(F) });
  assert.strictEqual(ev.record[F.PAYMENT_DATE].disabled, true);
  assert.strictEqual(ev.record[F.APPLICANT].disabled, false);
  assert.strictEqual(ev.record[F.APPLICANT_ORG].disabled, false);
  assert.strictEqual(ev.record[F.PAYEE].disabled, false);
});

check('會計單位承辦人、權限開放人員：只有管理員看得到', async () => {
  const user = await loadMain({ loginCode: 'someone' });
  await user.env.fire('app.record.detail.show', { record: baseRecord(user.F) });
  assert.strictEqual(user.env.shown[user.F.ACCOUNTING_STAFF], false);
  assert.strictEqual(user.env.shown[user.F.PERMISSION_STAFF], false);

  const admin = await loadMain({ loginCode: '24145' });
  await admin.env.fire('app.record.detail.show', { record: baseRecord(admin.F) });
  assert.strictEqual(admin.env.shown[admin.F.ACCOUNTING_STAFF], true);
  assert.strictEqual(admin.env.shown[admin.F.PERMISSION_STAFF], true);
});

check('詳細頁：「手動設定簽核流程」有勾才顯示，沒勾就隱藏', async () => {
  const { env, F, C } = await loadMain();
  const checkedRec = baseRecord(F);
  checkedRec[F.MANUAL_FLOW] = { value: [C.OPTIONS.MANUAL_FLOW.ON] };
  await env.fire('app.record.detail.show', { record: checkedRec });
  assert.strictEqual(env.shown[F.MANUAL_FLOW], true);
  await env.fire('app.record.detail.show', { record: baseRecord(F) });
  assert.strictEqual(env.shown[F.MANUAL_FLOW], false);
});

// ── 3. 費用歸屬 → 會計單位 ──────────────────────────────────────────────────
const CENTERS = [
  { code: 'TPE1', loc: 'TPE', name: '台北一課' },
  { code: 'TPE2', loc: 'TPE', name: '台北二課' },
  { code: 'KHH1', loc: 'KHH', name: '高雄一課' },
  { code: 'CKS1', loc: 'CKS', name: '桃園一課' },
  { code: 'AJA2', loc: 'TPE', name: '機場特殊' },
  { code: 'AJA3', loc: 'TPE', name: '機場特殊3' },
  { code: 'AJI1', loc: 'TPE', name: '海運特殊' },
];

check('單一據點 → 該據點的會計單位（KHH → ACC_KHH）', async () => {
  const { env, F, C } = await loadMain({ costCenters: CENTERS });
  const ev = await fireCost(env, F, baseRecord(F, { codes: ['khh1'] }));
  assert.strictEqual(accountingCode(ev, F), C.ACCOUNTING.MAP.KHH);
  assert.strictEqual(ev.record[F.ACCOUNTING_UNIT].disabled, true);
  assert.strictEqual(ev.record[F.ACCOUNTING_UNIT].type, 'GROUP_SELECT');
});

check('多列同一據點 → 該據點；多列不同據點 → 回 TPE', async () => {
  const { env, F, C } = await loadMain({ costCenters: CENTERS });
  const same = await fireCost(env, F, baseRecord(F, { codes: ['KHH1', 'KHH1'] }));
  assert.strictEqual(accountingCode(same, F), C.ACCOUNTING.MAP.KHH);
  const multi = await fireCost(env, F, baseRecord(F, { codes: ['KHH1', 'TPE1', 'CKS1'] }));
  assert.strictEqual(accountingCode(multi, F), C.ACCOUNTING.MAP.TPE);
});

check('機場特殊代碼：費用所屬人部門含「桃園機場」→ CKS，否則 TPE', async () => {
  const { env, F, C } = await loadMain({ costCenters: CENTERS });
  const taoyuan = await fireCost(env, F, baseRecord(F, { codes: ['AJA2', 'AJA3'], orgCode: 'TYA', orgName: '航空貨物部-桃園機場營業所' }));
  assert.strictEqual(accountingCode(taoyuan, F), C.ACCOUNTING.MAP.CKS);
  const other = await fireCost(env, F, baseRecord(F, { codes: ['AJA2'], orgName: '總務部-總務課' }));
  assert.strictEqual(accountingCode(other, F), C.ACCOUNTING.MAP.TPE);
});

check('機場特殊代碼要「每一列」都是特殊代碼才算；混入一般代碼就照據點判斷', async () => {
  const { env, F, C } = await loadMain({ costCenters: CENTERS });
  const mixed = await fireCost(env, F, baseRecord(F, { codes: ['AJA2', 'KHH1'], orgName: '桃園機場營業所' }));
  assert.strictEqual(accountingCode(mixed, F), C.ACCOUNTING.MAP.TPE, '據點 TPE（AJA2）與 KHH 不同 → 回 TPE');
});

check('海運特殊代碼：任何一列有 → TPE海運', async () => {
  const { env, F, C } = await loadMain({ costCenters: CENTERS });
  const ev = await fireCost(env, F, baseRecord(F, { codes: ['KHH1', 'AJI1'] }));
  assert.strictEqual(accountingCode(ev, F), C.ACCOUNTING.MAP.TPE海運);
});

check('費用歸屬主檔查不到據點 → 回 TPE（不是 undefined）', async () => {
  const { env, F, C } = await loadMain({ costCenters: CENTERS });
  const ev = await fireCost(env, F, baseRecord(F, { codes: ['ZZZZ'] }));
  assert.strictEqual(accountingCode(ev, F), C.ACCOUNTING.MAP.TPE);
});

check('手動設定簽核流程：不動會計單位', async () => {
  const { env, F, C } = await loadMain({ costCenters: CENTERS });
  const record = baseRecord(F, { codes: ['KHH1'] });
  record[F.MANUAL_FLOW] = { value: [C.OPTIONS.MANUAL_FLOW.ON] };
  const ev = await fireCost(env, F, record);
  assert.deepStrictEqual(plain(ev.record[F.ACCOUNTING_UNIT].value), []);
});

check('費用歸屬欄位轉大寫並去掉前後空白；空白列不影響其他列的判斷', async () => {
  const { env, F, C } = await loadMain({ costCenters: CENTERS });
  const record = baseRecord(F, { codes: [' khh1 ', ''] });
  const ev = await fireCost(env, F, record, 'edit');
  const rows = ev.record[F.TRAFFIC_TABLE.CODE].value;
  assert.strictEqual(rows[0].value[F.TRAFFIC_TABLE.COLS.EXPENSE].value, 'KHH1');
  assert.strictEqual(rows[1].value[F.TRAFFIC_TABLE.COLS.EXPENSE].value, '');
  assert.strictEqual(accountingCode(ev, F), C.ACCOUNTING.MAP.KHH);
});

check('新增與編輯畫面都有註冊費用歸屬變更事件', async () => {
  const { env, F } = await loadMain();
  const col = F.TRAFFIC_TABLE.COLS.EXPENSE;
  const types = env.registeredTypes();
  assert.ok(types.includes(`app.record.create.change.${col}`));
  assert.ok(types.includes(`app.record.edit.change.${col}`));
});

// ── 4. 中文名稱／代碼不存在提示 ─────────────────────────────────────────────
check('代碼存在 → 在該格下方掛綠字中文名稱；不存在 → 掛紅字「代碼不存在」', async () => {
  const { env, F } = await loadMain({ costCenters: CENTERS });
  const appended = [];
  // 替身 DOM：每個值一個輸入框，各自掛在一個 td 下
  const inputs = ['TPE1', 'NOPE'].map((value) => {
    const td = { querySelectorAll: () => [], appendChild: (el) => appended.push(el) };
    return { value, closest: (sel) => (sel === 'td' ? td : null), parentElement: td };
  });
  env.setQuerySelectorAll((sel) => (sel.includes('input[type="text"]') ? inputs : []));
  await fireCost(env, F, baseRecord(F, { codes: ['tpe1', 'nope'] }));
  env.flushTimers();
  const classes = appended.map((el) => `${el.className}|${el.textContent}`);
  assert.deepStrictEqual(classes, ['department-hint|台北一課', 'department-error|⚠ 代碼 "NOPE" 不存在']);
});

check('空白列不產生提示；變更時先清掉畫面上舊的提示', async () => {
  const { env, F } = await loadMain({ costCenters: CENTERS });
  const removed = [];
  env.setQuerySelectorAll((sel) => (sel === '.department-hint, .department-error' ? [{ remove: () => removed.push(1) }, { remove: () => removed.push(2) }] : []));
  await fireCost(env, F, baseRecord(F, { codes: [''] }));
  assert.deepStrictEqual(removed, [1, 2]);
  assert.strictEqual(env.timers.length, 0, '沒有任何列有值，就不排提示');
});

// ── 5. 詳細頁／列印頁表格處理、取消按鈕 ─────────────────────────────────────
const autoProcessRan = (env) => {
  env.documentCalls.querySelectorAll.length = 0;
  env.flushTimers();
  return env.documentCalls.querySelectorAll.some((s) => s.includes('subtable-row-gaia'));
};

check('詳細頁：狀態不是「報銷人填單」「申請開始」才跑 autoProcessAllTables', async () => {
  const { env, F, C } = await loadMain();
  for (const status of [C.STATUS.REIMBURSEMENT_FILL, C.STATUS.APPLY_START]) {
    await env.fire('app.record.detail.show', { record: baseRecord(F, { status }) });
    assert.strictEqual(autoProcessRan(env), false, `狀態 ${status} 不處理`);
  }
  for (const status of ['單位會計處理中(台北)', C.STATUS.VOID, '請款流程結束']) {
    await env.fire('app.record.detail.show', { record: baseRecord(F, { status }) });
    assert.strictEqual(autoProcessRan(env), true, `狀態 ${status} 要處理`);
  }
});

check('列印頁一律跑 autoProcessAllTables；新增／編輯畫面不跑', async () => {
  const { env, F } = await loadMain();
  await env.fire('app.record.print.show', { record: baseRecord(F, { status: '請款流程結束' }) });
  assert.strictEqual(autoProcessRan(env), true);
  await env.fire('app.record.create.show', { record: baseRecord(F) });
  assert.strictEqual(env.timers.some((t) => t.ms === 1000), false);
});

check('autoProcessAllTables 不處理簽核記錄表（標題等於簽核記錄表代碼）', async () => {
  const { env, F } = await loadMain();
  const processed = [];
  const table = (title) => ({
    classList: ['subtable-row-gaia', 'subtable-row-12'],
    offsetParent: {},
    querySelector: (sel) => (sel.includes('label-text') ? { textContent: title } : null),
    getAttribute: () => 'x',
    closest: () => null,
    querySelectorAll: (sel) => {
      if (sel.includes('thead')) processed.push(title);
      return [];
    },
  });
  env.setQuerySelectorAll((sel) => (sel.includes('subtable-row-gaia') ? [table(F.SIGN_TABLE.CODE), table(F.TRAFFIC_TABLE.CODE)] : []));
  await env.fire('app.record.print.show', { record: baseRecord(F) });
  env.flushTimers();
  assert.ok(processed.length > 0 && processed.every((t) => t === F.TRAFFIC_TABLE.CODE), JSON.stringify(processed));
});

check('新增畫面：取消按鈕重綁成回到本 App 列表', async () => {
  const { env, F, C } = await loadMain();
  let handler = null;
  const clone = { addEventListener: (type, fn) => (handler = fn) };
  const cancel = { cloneNode: () => clone, parentNode: { replaceChild: () => {} } };
  env.setQuerySelector((sel) => (sel === '.gaia-ui-actionmenu-cancel' ? cancel : null));
  await env.fire('app.record.create.show', { record: baseRecord(F) });
  env.flushTimers();
  assert.ok(handler, '應重新綁定 click');
  let prevented = false;
  handler({ preventDefault: () => (prevented = true) });
  assert.ok(prevented);
  assert.strictEqual(env.window.location.href, `/k/${C.APPS.PAYMENT}/`);
});

// ── 6. 不再有的 723 功能 ────────────────────────────────────────────────────
check('稅額、總金額、借支等 723 功能已刪：沒有註冊稅額／金額相關事件', async () => {
  const { env, F } = await loadMain();
  const T = F.TRAFFIC_TABLE;
  const registered = env.registeredTypes().join('\n');
  [T.COLS.AMOUNT, T.COLS.TAX, T.COLS.NOTE, T.COLS.RECEIPT_TYPE, T.CODE, F.PAY_METHOD].forEach((code) => {
    assert.ok(!registered.includes(`change.${code}`), `不應註冊 ${code} 的 change 事件`);
  });
});

check('稅額維持手填：費用歸屬變更不會改動金額或稅額', async () => {
  const { env, F } = await loadMain({ costCenters: CENTERS });
  const T = F.TRAFFIC_TABLE;
  const record = baseRecord(F, { codes: ['TPE1'] });
  const row = record[T.CODE].value[0].value;
  row[T.COLS.AMOUNT] = { value: '105' };
  row[T.COLS.TAX] = { value: '' };
  const ev = await fireCost(env, F, record);
  assert.strictEqual(ev.record[T.CODE].value[0].value[T.COLS.TAX].value, '');
  assert.strictEqual(ev.record[T.CODE].value[0].value[T.COLS.AMOUNT].value, '105');
});

check('main 原始碼沒有 723 的殘留（類型、分攤、交際費、帶入、借支、使用須知）', () => {
  const src = readSrc('payment_request_main_20260521.js');
  [
    'F.TYPE', 'TYPES', 'APPLY_UNIT', 'EXPENSE_FILL_MODE', 'ATTACHMENT_TEXT', 'VENDOR_TABLE', 'ENTERTAINMENT', 'TRIP_',
    'localStorage', 'SOURCE_FIELDS', 'C.TAX', 'ADVANCE', 'AMOUNT_CHANGE', 'NXAccountPermission', 'NOTICE_CONFIG', 'docs/',
  ].forEach((s) => assert.ok(!src.includes(s), `不應殘留 ${s}`));
});

done();
