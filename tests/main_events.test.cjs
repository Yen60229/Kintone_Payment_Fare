'use strict';

// 測試：payment_request_main_20260521.js 的畫面事件（749 交通費請款單）
//   1. 說明文字 Space_Noti_1/2/3（不再依類型切換）
//   2. 欄位鎖定：請款日期鎖、申請人只有管理員能改（受款人開放手 key）、申請人部門／費用所屬人部門一律鎖（依人員帶入）、
//      會計單位承辦人／權限開放人員只有管理員看得到、手動簽核欄位在詳細頁有勾才顯示
//   3. 費用歸屬變更：轉大寫；不動會計單位（會計單位只依費用所屬人部門，由簽核人員程式帶入）
//   4. 費用歸屬中文名稱（綠字）／代碼不存在（紅字）提示
//   5. 詳細頁／列印頁的交通費明細欄寬（依 MCP 讀的版面＋記錄值、換頁太快的防護）、新增頁的取消按鈕重綁
//   6. 稅額不自動算、已刪的 723 功能不再註冊事件
// 單獨執行：node tests/main_events.test.cjs

const assert = require('assert');
const { createEnv, createRunner, readSrc } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('main_events.test.cjs');

const plain = (v) => JSON.parse(JSON.stringify(v));

/** 載入 main；costCenters 為費用歸屬主檔記錄 [{code, name}] */
const loadMain = async ({ loginCode = 'someone', costCenters = [] } = {}) => {
  const env = createEnv({
    appId: 749,
    loginCode,
    api: (url, method) => {
      if (method === 'POST') return Promise.resolve({ id: 'c' });
      const CC = env.window.PR_CONFIG.REF_FIELDS.COST_CENTER;
      return Promise.resolve({
        records: costCenters.map((c) => ({ [CC.CODE]: { value: c.code }, [CC.NAME]: { value: c.name || '' } })),
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
check('一般使用者：請款日期、申請人、申請人部門、費用所屬人部門鎖住；費用所屬人、受款人不鎖（受款人可手 key）', async () => {
  const { env, F } = await loadMain({ loginCode: 'someone' });
  for (const type of ['create', 'edit']) {
    const ev = await env.fire(`app.record.${type}.show`, { record: baseRecord(F) });
    assert.strictEqual(ev.record[F.PAYMENT_DATE].disabled, true);
    assert.strictEqual(ev.record[F.APPLICANT].disabled, true);
    assert.strictEqual(ev.record[F.APPLICANT_ORG].disabled, true);
    assert.ok(!ev.record[F.PAYEE].disabled);
    assert.ok(!ev.record[F.EXPENSE_OWNER].disabled);
    assert.strictEqual(ev.record[F.EXPENSE_OWNER_ORG].disabled, true);
  }
});

check('管理員：申請人、受款人都可改；請款日期、申請人部門、費用所屬人部門照樣鎖（部門只依人員帶入）', async () => {
  const { env, F } = await loadMain({ loginCode: '24136' });
  for (const type of ['create', 'edit']) {
    const ev = await env.fire(`app.record.${type}.show`, { record: baseRecord(F) });
    assert.strictEqual(ev.record[F.PAYMENT_DATE].disabled, true);
    assert.strictEqual(ev.record[F.APPLICANT].disabled, false);
    assert.ok(!ev.record[F.PAYEE].disabled);
    assert.strictEqual(ev.record[F.APPLICANT_ORG].disabled, true);
    assert.strictEqual(ev.record[F.EXPENSE_OWNER_ORG].disabled, true);
  }
});

// 列表直接編輯：一列的記錄（帶型別；帳號權限設定模組已先套用的 disabled 用 pre 指定）
const inlineRecord = (F, C, pre = {}) => {
  const f = (type, code) => ({ type, value: '', ...(code in pre ? { disabled: pre[code] } : {}) });
  return {
    [F.APPLICANT]: f('USER_SELECT', F.APPLICANT),
    [F.APPLICANT_ORG]: f('ORGANIZATION_SELECT', F.APPLICANT_ORG),
    [F.EXPENSE_OWNER]: f('USER_SELECT', F.EXPENSE_OWNER),
    [F.EXPENSE_OWNER_ORG]: f('ORGANIZATION_SELECT', F.EXPENSE_OWNER_ORG),
    [F.PAY_METHOD]: f('CHECK_BOX', F.PAY_METHOD),
    [F.ACCOUNTING_UNIT]: f('GROUP_SELECT', F.ACCOUNTING_UNIT),
    [F.EXPECTED_PAY_DATE]: f('DATE', F.EXPECTED_PAY_DATE),
    [F.REASON]: f('MULTI_LINE_TEXT', F.REASON),
    單位主管1: f('USER_SELECT', '單位主管1'),
    [F.VOUCHER_NO]: f('SINGLE_LINE_TEXT', F.VOUCHER_NO),
    [F.VOUCHER_DATE]: f('DATE', F.VOUCHER_DATE),
    [C.VOID_FIELD]: f('CHECK_BOX', C.VOID_FIELD),
    [F.RECORD_NO]: { type: 'RECORD_NUMBER', value: '12' },
    [F.STATUS_FIELD]: { type: 'STATUS', value: '草稿（未送出）' },
  };
};

check('列表直接編輯：程式管的欄位一律鎖住（即使帳號權限設定給可編輯）', async () => {
  const { env, F, C } = await loadMain();
  const ev = await env.fire('app.record.index.edit.show', { record: inlineRecord(F, C, { [F.APPLICANT]: false, [F.PAY_METHOD]: false }) });
  [F.APPLICANT, F.APPLICANT_ORG, F.EXPENSE_OWNER, F.EXPENSE_OWNER_ORG, F.PAY_METHOD, F.ACCOUNTING_UNIT, F.EXPECTED_PAY_DATE, F.REASON, '單位主管1'].forEach((code) =>
    assert.strictEqual(ev.record[code].disabled, true, code),
  );
});

check('列表直接編輯：傳票編號、傳票日期、表單作廢不動，照帳號權限設定的結果', async () => {
  const { env, F, C } = await loadMain();
  const ev = await env.fire('app.record.index.edit.show', { record: inlineRecord(F, C, { [F.VOUCHER_NO]: false, [F.VOUCHER_DATE]: true }) });
  assert.strictEqual(ev.record[F.VOUCHER_NO].disabled, false, '權限給可編輯 → 維持可編輯');
  assert.strictEqual(ev.record[F.VOUCHER_DATE].disabled, true, '權限鎖住 → 維持鎖住');
  assert.ok(!('disabled' in ev.record[C.VOID_FIELD]), '沒有規則就不碰');
});

check('列表直接編輯：記錄號碼、狀態這類系統欄位不設 disabled', async () => {
  const { env, F, C } = await loadMain();
  const ev = await env.fire('app.record.index.edit.show', { record: inlineRecord(F, C) });
  assert.ok(!('disabled' in ev.record[F.RECORD_NO]));
  assert.ok(!('disabled' in ev.record[F.STATUS_FIELD]));
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

// ── 3. 費用歸屬變更 ─────────────────────────────────────────────────────────
const CENTERS = [
  { code: 'TPE1', name: '台北一課' },
  { code: 'KHH1', name: '高雄一課' },
  { code: 'AJA2', name: '機場特殊' },
  { code: 'AJI1', name: '海運特殊' },
];

check('費用歸屬變更不動會計單位（會計單位只依費用所屬人部門）；自動、手動簽核都一樣', async () => {
  const { env, F, C } = await loadMain({ costCenters: CENTERS });
  const acc = [{ code: C.ACCOUNTING.MAP.TPE, name: C.ACCOUNTING.MAP.TPE }];
  for (const codes of [['khh1'], ['AJA2', 'AJA2'], ['KHH1', 'AJI1'], ['ZZZZ']]) {
    const record = baseRecord(F, { codes, orgName: '航空貨物部-桃園機場營業所' });
    record[F.ACCOUNTING_UNIT] = { value: acc };
    const ev = await fireCost(env, F, record);
    assert.deepStrictEqual(plain(ev.record[F.ACCOUNTING_UNIT].value), acc, codes.join(','));
  }
  const manual = baseRecord(F, { codes: ['KHH1'] });
  manual[F.MANUAL_FLOW] = { value: [C.OPTIONS.MANUAL_FLOW.ON] };
  const ev = await fireCost(env, F, manual);
  assert.deepStrictEqual(plain(ev.record[F.ACCOUNTING_UNIT].value), []);
});

check('main 不再依費用歸屬據點判斷會計單位（據點對照、特殊代碼已刪）', () => {
  const src = readSrc('payment_request_main_20260521.js');
  ['determineAllocation', 'updateAccountingDepartment', 'LOCATION', 'SPECIAL_CODES', 'ACCOUNTING_UNIT'].forEach((s_) => {
    assert.ok(!src.includes(s_), `不應殘留 ${s_}`);
  });
});

check('費用歸屬欄位轉大寫並去掉前後空白；空白列維持空白', async () => {
  const { env, F } = await loadMain({ costCenters: CENTERS });
  const record = baseRecord(F, { codes: [' khh1 ', ''] });
  const ev = await fireCost(env, F, record, 'edit');
  const rows = ev.record[F.TRAFFIC_TABLE.CODE].value;
  assert.strictEqual(rows[0].value[F.TRAFFIC_TABLE.COLS.EXPENSE].value, 'KHH1');
  assert.strictEqual(rows[1].value[F.TRAFFIC_TABLE.COLS.EXPENSE].value, '');
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

// ── 5. 詳細頁／列印頁：交通費明細子表格欄寬（資料驅動）、取消按鈕 ─────────────
const tableRan = (env) => {
  env.documentCalls.querySelectorAll.length = 0;
  env.flushTimers();
  return env.documentCalls.querySelectorAll.some((s) => s.includes('subtable-row-gaia'));
};
const DONE = '單位會計處理中(台北)'; // 會調欄寬的狀態

/** 子表格一列：{ 欄位代碼: 值 } */
const tableRow = (values) => ({ value: Object.fromEntries(Object.entries(values).map(([code, v]) => [code, { value: v }])) });
const recordWithRows = (F, rows, status = DONE) => {
  const r = baseRecord(F, { status });
  r[F.TRAFFIC_TABLE.CODE] = { value: rows };
  return r;
};
/** 每一欄都有值的一列（欄寬測試用） */
const fullRow = (F) => {
  const c = F.TRAFFIC_TABLE.COLS;
  return tableRow({
    [c.DATE]: '2026-10-01',
    [c.VEHICLE]: '高鐵',
    [c.RECEIPT_TYPE]: '高鐵票',
    [c.ROUTE]: '台北→台中',
    [c.VISIT_CUSTOMER]: '台中營業部-綜合物流營業課',
    [c.AMOUNT]: '1490',
    [c.EXPENSE]: 'AJ30',
    [c.INVOICE_NO]: 'AB12345678',
    [c.SELLER_TAX_ID]: '00000000',
    [c.FORMAT]: '22',
    [c.TAX]: '71',
  });
};

/**
 * 畫面上一張子表格的替身：表頭依 labels，rowCount 列；editMode＝格子裡有輸入框（編輯畫面）
 */
const fakeTable = (labels, { editMode = false, rowCount = 1 } = {}) => {
  const cell = (textContent = '') => {
    const el = {
      textContent,
      style: {},
      attrs: {},
      setAttribute: (k, v) => (el.attrs[k] = v),
      removeAttribute: (k) => delete el.attrs[k],
    };
    return el;
  };
  const headers = labels.map((l) => cell(l));
  const rows = Array.from({ length: rowCount }, () => {
    const tds = labels.map(() => cell());
    return { tds, querySelectorAll: (sel) => (sel === 'td' ? tds : []) };
  });
  const container = {
    querySelector: (sel) => (sel === 'input, select, textarea' && editMode ? {} : null),
    querySelectorAll: (sel) => {
      if (sel === 'thead th.subtable-label-gaia') return headers;
      if (sel === 'tbody tr') return rows;
      return [];
    },
  };
  const cells = [...headers, ...rows.flatMap((r) => r.tds)];
  const col = (label) => {
    const i = labels.indexOf(label);
    return { th: headers[i], tds: rows.map((r) => r.tds[i]) };
  };
  return { container, headers, rows, cells, col, marked: () => cells.filter((c) => c.attrs['data-pr-auto-width']) };
};
const useTables = (env, ...tables) =>
  env.setQuerySelectorAll((sel) => {
    if (sel.includes('subtable-row-gaia')) return tables.map((t) => t.container);
    if (sel === '[data-pr-auto-width]') return tables.flatMap((t) => t.marked());
    return [];
  });
const labelsOf = (C) => C.TRAFFIC_TABLE_LAYOUT.COLUMNS.map((c) => c.label);
const SIGN_LABELS = ['日期與時間', '變更前的狀態', '動作', '變更後的狀態', '簽核人員', '經過的時間(分)'];

check('planTrafficTable：整欄沒有值就藏；有值依最長顯示文字與表頭文字算寬；數值加千分位與單位、0 當沒有值', async () => {
  const { env, F, C } = await loadMain();
  const T = env.window.PR_TABLE_LAYOUT;
  const c = F.TRAFFIC_TABLE.COLS;
  const plan = T.planTrafficTable([tableRow({ [c.AMOUNT]: '1490', [c.TAX]: '0', [c.ROUTE]: '台北→台中' }), tableRow({ [c.AMOUNT]: '12345', [c.TAX]: '' })]);
  const byCode = Object.fromEntries(plan.map((p) => [p.code, p]));
  assert.deepStrictEqual(plan.map((p) => p.code), C.TRAFFIC_TABLE_LAYOUT.COLUMNS.map((col) => col.code), '依版面順序');
  assert.strictEqual(byCode[c.TAX].hidden, true, '稅額全是 0／空白 → 藏');
  assert.strictEqual(byCode[c.FORMAT].hidden, true, '格式沒填 → 藏');
  // 金額：顯示「12,345元」7 單位 < 表頭「金額（含稅）」12 單位 → 12 × 8 ＋ 32
  assert.strictEqual(T.displayText({ value: '12345' }, { type: 'NUMBER', unit: '元' }), '12,345元');
  assert.strictEqual(byCode[c.AMOUNT].width, '128px');
  // 起訖點：「台北→台中」4 個中文 8 ＋ → 1 ＝ 9 單位 > 表頭 6 單位 → 9 × 8 ＋ 32 ＝ 104，但最小 64 → 104
  assert.strictEqual(byCode[c.ROUTE].width, '104px');
  assert.strictEqual(T.textUnits('（AB）'), 6);
});

check('planTrafficTable：寬度限制在 MIN～MAX；沒有任何列 → 全部藏', async () => {
  const { env, F, C } = await loadMain();
  const T = env.window.PR_TABLE_LAYOUT;
  const c = F.TRAFFIC_TABLE.COLS;
  const W = C.TRAFFIC_TABLE_LAYOUT.WIDTH;
  const plan = T.planTrafficTable([tableRow({ [c.VISIT_CUSTOMER]: '很長的客戶名稱'.repeat(20), [c.FORMAT]: '2' })]);
  const byCode = Object.fromEntries(plan.map((p) => [p.code, p]));
  assert.strictEqual(byCode[c.VISIT_CUSTOMER].width, `${W.MAX_PX}px`);
  assert.strictEqual(byCode[c.FORMAT].width, `${Math.max(W.MIN_PX, 4 * W.PX_PER_UNIT + W.PADDING_PX)}px`, '「格式」表頭 4 單位');
  assert.ok(T.planTrafficTable([]).every((p) => p.hidden));
  assert.ok(T.planTrafficTable(undefined).every((p) => p.hidden));
});

check('詳細頁：狀態不是「報銷人填單」「草稿（未送出）」才調欄寬', async () => {
  const { env, F, C } = await loadMain();
  for (const status of [C.STATUS.REIMBURSEMENT_FILL, C.STATUS.APPLY_START]) {
    await env.fire('app.record.detail.show', { record: baseRecord(F, { status }) });
    assert.strictEqual(tableRan(env), false, `狀態 ${status} 不處理`);
  }
  for (const status of [DONE, C.STATUS.VOID, '請款流程結束']) {
    await env.fire('app.record.detail.show', { record: baseRecord(F, { status }) });
    assert.strictEqual(tableRan(env), true, `狀態 ${status} 要處理`);
  }
});

check('列印頁一律調欄寬；新增／編輯畫面不排延遲處理', async () => {
  const { env, F } = await loadMain();
  await env.fire('app.record.print.show', { record: baseRecord(F, { status: '請款流程結束' }) });
  assert.strictEqual(tableRan(env), true);
  await env.fire('app.record.create.show', { record: baseRecord(F) });
  assert.strictEqual(env.timers.some((t) => t.ms === 1000), false);
});

check('詳細頁：依記錄的值定寬、沒有值的欄藏起來；只設 width／min-width，不設 max-width（內容長只會撐開，不會溢出）', async () => {
  const { env, F, C } = await loadMain();
  const c = F.TRAFFIC_TABLE.COLS;
  const t = fakeTable(labelsOf(C), { rowCount: 2 });
  useTables(env, t);
  const row1 = fullRow(F);
  row1.value[c.FORMAT].value = '';
  const row2 = fullRow(F);
  row2.value[c.FORMAT].value = '';
  await env.fire('app.record.detail.show', { record: recordWithRows(F, [row1, row2]) });
  env.flushTimers();
  const visit = t.col('拜訪客戶（目的）');
  assert.strictEqual(visit.th.style.width, `${'台中營業部-綜合物流營業課'.length * 2 * 8 - 8 + 32}px`, '12 個中文 ＋ 1 個「-」');
  assert.deepStrictEqual(visit.tds.map((td) => td.style.minWidth), [visit.th.style.width, visit.th.style.width]);
  assert.ok(t.cells.every((cell) => !cell.style.maxWidth), '不設 max-width');
  const format = t.col('格式');
  assert.strictEqual(format.th.style.display, 'none');
  assert.ok(format.tds.every((td) => td.style.display === 'none'));
  assert.strictEqual(t.marked().length, t.cells.length, '每一格都有記號（可還原）');
});

check('依表頭文字對欄位：順序不同也對得上、表頭的必填 * 不影響、對不到的欄不動', async () => {
  const { env, F, C } = await loadMain();
  const labels = [...labelsOf(C)].reverse();
  labels[labels.indexOf('憑證日期')] = '憑證日期 *';
  labels.push('不明欄位');
  const t = fakeTable(labels);
  useTables(env, t);
  await env.fire('app.record.detail.show', { record: recordWithRows(F, [fullRow(F)]) });
  env.flushTimers();
  assert.ok(t.col('憑證日期 *').th.style.width, '去掉 * 後對得上');
  assert.strictEqual(t.col('金額（含稅）').th.style.width, '128px', '反過來的順序也找到正確的欄');
  assert.deepStrictEqual(t.col('不明欄位').th.style, {}, '對不到的欄不動');
});

check('表頭對不上交通費明細的子表格（簽核記錄）整張不動', async () => {
  const { env, F, C } = await loadMain();
  const traffic = fakeTable(labelsOf(C));
  const sign = fakeTable(SIGN_LABELS, { rowCount: 3 });
  useTables(env, sign, traffic);
  await env.fire('app.record.detail.show', { record: recordWithRows(F, [fullRow(F)]) });
  env.flushTimers();
  assert.strictEqual(sign.marked().length, 0);
  assert.ok(traffic.marked().length > 0);
});

check('換頁太快：詳細頁還沒處理就按編輯 → 延遲的欄寬處理作廢，不會在編輯畫面上定寬（截圖的表格畸形）', async () => {
  const { env, F, C } = await loadMain();
  const t = fakeTable(labelsOf(C));
  useTables(env, t);
  await env.fire('app.record.detail.show', { record: recordWithRows(F, [fullRow(F)]) });
  await env.fire('app.record.edit.show', { record: recordWithRows(F, [fullRow(F)]) });
  env.flushTimers();
  assert.strictEqual(t.marked().length, 0, '編輯畫面的格子不能被定寬或藏起來');
});

check('表格裡有輸入框（已經是編輯畫面）→ 不處理，即使計時器還算同一個畫面', async () => {
  const { env, F, C } = await loadMain();
  const t = fakeTable(labelsOf(C), { editMode: true });
  useTables(env, t);
  await env.fire('app.record.detail.show', { record: recordWithRows(F, [fullRow(F)]) });
  env.flushTimers();
  assert.strictEqual(t.marked().length, 0);
});

check('進新增／編輯畫面：把詳細頁調過的格子寬度與隱藏還原、拿掉記號', async () => {
  const { env, F, C } = await loadMain();
  for (const type of ['edit', 'create']) {
    const t = fakeTable(labelsOf(C));
    useTables(env, t);
    await env.fire('app.record.detail.show', { record: recordWithRows(F, [tableRow({ [F.TRAFFIC_TABLE.COLS.ROUTE]: '台北→台中' })]) });
    env.flushTimers();
    assert.strictEqual(t.col('格式').th.style.display, 'none', '沒有值的欄位在詳細頁藏起來');
    assert.ok(t.col('起訖點').th.style.width);
    await env.fire(`app.record.${type}.show`, { record: baseRecord(F) });
    assert.ok(t.cells.every((cell) => !cell.style.display && !cell.style.width && !cell.style.minWidth), type);
    assert.strictEqual(t.marked().length, 0, type);
  }
});

check('原始碼：不再從畫面抓文字猜欄寬（getCellValue／processTableByContainer 已刪）', () => {
  const src = readSrc('payment_request_main_20260521.js');
  ['getCellValue', 'processTableByContainer', 'autoProcessAllTables', 'auto_table_'].forEach((s) => assert.ok(!src.includes(s), s));
  assert.ok(src.includes('C.TRAFFIC_TABLE_LAYOUT'));
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
  [T.COLS.AMOUNT, T.COLS.TAX, T.COLS.RECEIPT_TYPE, T.CODE, F.PAY_METHOD].forEach((code) => {
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
