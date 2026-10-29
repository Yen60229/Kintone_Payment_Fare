'use strict';

// 測試：payment_request_submit_20260506.js 的存檔驗證（749 交通費請款單）
//   公司名稱必填、付款方式必選且只能一種、子表格每列費用歸屬必填且要在「使用中」代碼內、
//   發票號碼重複檢查（查本 App：狀態 not in 表單作廢、發票號碼記錄 like、排除自己）、
//   表單作廢時跳過、驗證失敗視窗；整合交通費明細規則與掛帳單位限部內。
// 單獨執行：node tests/submit_validation.test.cjs

const assert = require('assert');
const { createEnv, createRunner, readSrc } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('submit_validation.test.cjs');

/**
 * 載入 main + submit。validCodes 為「使用中」費用歸屬代碼；invoiceHits 為發票重複查詢要回的筆數。
 * 回傳 env 與 api 呼叫紀錄。
 */
const loadSubmit = async ({ validCodes = ['AJ30', 'AJ31'], invoiceHits = 0, failCostCenter = false, failInvoice = false, invoiceRecords = null } = {}) => {
  const calls = [];
  const env = createEnv({
    appId: 749,
    api: (url, method, params) => {
      calls.push({ url, method, params });
      const apps = env.window.PR_CONFIG.APPS;
      if (params.app === apps.COST_CENTER || params.id || url.includes('cursor')) {
        if (failCostCenter) return Promise.reject(new Error('cc down'));
        if (method === 'POST') return Promise.resolve({ id: 'c' });
        const CC = env.window.PR_CONFIG.REF_FIELDS.COST_CENTER;
        return Promise.resolve({ records: validCodes.map((code) => ({ [CC.CODE]: { value: code } })), next: false });
      }
      if (failInvoice) return Promise.reject(new Error('invoice down'));
      if (invoiceRecords) return Promise.resolve({ records: invoiceRecords(env.window.PR_CONFIG.FIELDS) });
      return Promise.resolve({ records: Array.from({ length: invoiceHits }, () => ({ $id: { value: '1' } })) });
    },
  });
  env.load('payment_request_config.js');
  env.load('payment_request_main_20260521.js');
  env.load('payment_request_submit_20260506.js');
  return { env, calls, C: env.window.PR_CONFIG, F: env.window.PR_CONFIG.FIELDS };
};

const goodRecord = (F, over = {}) => {
  const T = F.TRAFFIC_TABLE;
  return {
    [F.COMPANY_NAME]: { value: 'ＮＸ臺灣國際物流' },
    [F.PAY_METHOD]: { value: ['電匯'] },
    [F.INVOICE_AGG]: { value: '' },
    [T.CODE]: { value: [{ value: { [T.COLS.EXPENSE]: { value: 'AJ30' } } }] },
    ...over,
  };
};

const withRows = (F, codes) => {
  const T = F.TRAFFIC_TABLE;
  return { [T.CODE]: { value: codes.map((c) => ({ value: { [T.COLS.EXPENSE]: { value: c } } })) } };
};

const submit = (env, record, type = 'create') => env.fire(`app.record.${type}.submit`, { record });
const popupText = (env) => env.swalCalls.map((c) => c.html || c.text || '').join('\n').replace(/<[^>]+>/g, ' ');
const plainText = (html) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');

// ── 通過與基本必填 ─────────────────────────────────────────────────────────
check('全部合法 → 不擋存檔、不跳視窗', async () => {
  const { env, F } = await loadSubmit();
  const ev = await submit(env, goodRecord(F));
  assert.strictEqual(ev.error, undefined);
  assert.strictEqual(env.swalCalls.length, 0);
});

check('更早的存檔檢查（帳號權限設定的必填）放進 PR_SAVE_ERRORS → 和這裡的錯誤合成同一個視窗，排在最前面', async () => {
  const { env, F } = await loadSubmit();
  env.window.PR_SAVE_ERRORS.add(['尚有必填欄位未填寫\n▸傳票編號']);
  const ev = await submit(env, goodRecord(F, { [F.COMPANY_NAME]: { value: '' } }));
  assert.strictEqual(ev.error, '儲存失敗');
  assert.strictEqual(env.swalCalls.length, 1, '只跳一個視窗');
  const text = plainText(env.swalCalls[0].html);
  assert.ok(text.indexOf('尚有必填欄位未填寫') < text.indexOf('需填寫公司名稱欄位'), text);
  assert.ok(text.includes('傳票編號'));
  assert.strictEqual(env.window.PR_SAVE_ERRORS.take().length, 0, '顯示後清空');
});

check('只有更早的檢查有錯（這裡全部合法）→ 照樣擋下並跳視窗', async () => {
  const { env, F } = await loadSubmit();
  env.window.PR_SAVE_ERRORS.add(['尚有必填欄位未填寫\n▸傳票日期']);
  const ev = await submit(env, goodRecord(F));
  assert.strictEqual(ev.error, '儲存失敗');
  assert.ok(plainText(env.swalCalls[0].html).includes('傳票日期'));
});

check('勾了表單作廢（這裡不檢查）但更早的檢查有錯 → 仍擋下並跳視窗；沒錯就直接放行', async () => {
  const { env, F, C } = await loadSubmit();
  env.window.PR_SAVE_ERRORS.add(['尚有必填欄位未填寫\n▸傳票編號']);
  const voided = await submit(env, goodRecord(F, { [C.VOID_FIELD]: { value: ['作廢'] } }));
  assert.strictEqual(voided.error, '儲存失敗');
  assert.strictEqual(env.swalCalls.length, 1);
  const ok = await submit(env, goodRecord(F, { [C.VOID_FIELD]: { value: ['作廢'] } }));
  assert.strictEqual(ok.error, undefined);
});

check('新增與編輯畫面的存檔都有註冊', async () => {
  const { env } = await loadSubmit();
  const types = env.registeredTypes();
  assert.ok(types.includes('app.record.create.submit'));
  assert.ok(types.includes('app.record.edit.submit'));
});

check('公司名稱空白 → 擋下並提示', async () => {
  const { env, F } = await loadSubmit();
  const ev = await submit(env, goodRecord(F, { [F.COMPANY_NAME]: { value: '' } }));
  assert.strictEqual(ev.error, '儲存失敗');
  assert.ok(plainText(env.swalCalls[0].html).includes('需填寫公司名稱欄位'));
});

check('付款方式：沒選 → 「需選擇一種付款方式」；選兩種 → 「限選一種付款方式」；選一種 → 通過', async () => {
  const { env, F } = await loadSubmit();
  const none = await submit(env, goodRecord(F, { [F.PAY_METHOD]: { value: [] } }));
  assert.strictEqual(none.error, '儲存失敗');
  assert.ok(plainText(env.swalCalls.at(-1).html).includes('需選擇一種付款方式'));

  const two = await submit(env, goodRecord(F, { [F.PAY_METHOD]: { value: ['現金', '電匯'] } }));
  assert.strictEqual(two.error, '儲存失敗');
  assert.ok(plainText(env.swalCalls.at(-1).html).includes('限選一種付款方式'));

  for (const way of ['現金', '電匯', '票據', '部門零用金']) {
    const ok = await submit(env, goodRecord(F, { [F.PAY_METHOD]: { value: [way] } }));
    assert.strictEqual(ok.error, undefined, way);
  }
});

// ── 費用歸屬驗證 ───────────────────────────────────────────────────────────
check('費用歸屬空白（含只有空白字元）→ 「第 N 行請確實填寫費用歸屬」，列號正確', async () => {
  const { env, F } = await loadSubmit();
  const ev = await submit(env, goodRecord(F, withRows(F, ['AJ30', '', '   ', 'AJ31'])));
  assert.strictEqual(ev.error, '儲存失敗');
  const text = plainText(env.swalCalls[0].html);
  assert.ok(text.includes('第 2 行請確實填寫費用歸屬'), text);
  assert.ok(text.includes('第 3 行請確實填寫費用歸屬'), text);
  assert.ok(!text.includes('第 1 行') && !text.includes('第 4 行'), text);
});

check('費用歸屬不在「使用中」代碼內 → 「第 N 行的 XXX 不屬於 YYYY 年最新分攤表」', async () => {
  const { env, F } = await loadSubmit();
  const ev = await submit(env, goodRecord(F, withRows(F, ['AJ30', 'ZZ99'])));
  assert.strictEqual(ev.error, '儲存失敗');
  const text = plainText(env.swalCalls[0].html);
  assert.ok(text.includes(`第 2 行的 ZZ99 不屬於${new Date().getFullYear()}年最新分攤表，請重新填寫`), text);
});

check('費用歸屬前後有空白但代碼合法 → 通過（比對時先去空白）', async () => {
  const { env, F } = await loadSubmit();
  const ev = await submit(env, goodRecord(F, withRows(F, [' AJ30 '])));
  assert.strictEqual(ev.error, undefined);
});

check('「如附件」不再是合法的費用歸屬（沒有分攤填寫方式了）', async () => {
  const { env, F } = await loadSubmit();
  const ev = await submit(env, goodRecord(F, withRows(F, ['如附件'])));
  assert.strictEqual(ev.error, '儲存失敗');
});

check('取不到費用歸屬主檔 → 只報一條「無法取得最新費用歸屬代碼」，不會對每一列誤報不存在', async () => {
  const { env, F } = await loadSubmit({ failCostCenter: true });
  const ev = await submit(env, goodRecord(F, withRows(F, ['AJ30', 'AJ31', ''])));
  assert.strictEqual(ev.error, '儲存失敗');
  const text = plainText(env.swalCalls[0].html);
  assert.ok(text.includes('無法取得最新費用歸屬代碼'), text);
  assert.ok(!text.includes('不屬於'), text);
  assert.ok(text.includes('第 3 行請確實填寫費用歸屬'), '空白仍要擋');
});

check('子表格不存在 → 「找不到 … 表格資料」', async () => {
  const { env, F } = await loadSubmit();
  const record = goodRecord(F);
  delete record[F.TRAFFIC_TABLE.CODE];
  const ev = await submit(env, record);
  assert.strictEqual(ev.error, '儲存失敗');
  assert.ok(plainText(env.swalCalls[0].html).includes(`找不到 ${F.TRAFFIC_TABLE.CODE} 表格資料`));
});

check('多個錯誤一次列在同一個視窗（逐條編號）', async () => {
  const { env, F } = await loadSubmit();
  await submit(env, goodRecord(F, { [F.COMPANY_NAME]: { value: '' }, [F.PAY_METHOD]: { value: [] }, ...withRows(F, ['']) }));
  assert.strictEqual(env.swalCalls.length, 1);
  const html = env.swalCalls[0].html;
  assert.strictEqual((html.match(/pr-validation-item/g) || []).length, 3);
  assert.ok(html.includes('請修正以下 3 個問題'));
  assert.strictEqual(env.swalCalls[0].customClass.popup, 'pr-validation-popup');
  assert.strictEqual(env.swalCalls[0].icon, 'error');
});

// ── 發票號碼重複檢查 ───────────────────────────────────────────────────────
const invoiceQueryOf = (calls) => calls.find((c) => c.url.includes('records.json'));

check('發票重複查詢字串：狀態 not in 表單作廢 + 每張發票各一個 like + 排除自己，沒有類型條件', async () => {
  const { env, calls, C, F } = await loadSubmit();
  const record = goodRecord(F, { [F.INVOICE_AGG]: { value: ' / AB12345678 / CD87654321 / ' }, $id: { value: '77' } });
  await submit(env, record, 'edit');
  const q = invoiceQueryOf(calls);
  assert.strictEqual(q.method, 'GET');
  assert.strictEqual(q.params.app, C.APPS.PAYMENT);
  assert.deepStrictEqual([...q.params.fields], ['$id', F.RECORD_NO, F.INVOICE_AGG]);
  assert.strictEqual(
    q.params.query,
    `${F.STATUS_FIELD} not in ("${C.STATUS.VOID}") and (${F.INVOICE_AGG} like " / AB12345678 / " or ${F.INVOICE_AGG} like " / CD87654321 / ") and $id != 77 limit 100`,
  );
  assert.ok(!q.params.query.includes('in ("交通'), '不應有類型條件');
});

check('新增（還沒有 $id）時查詢不帶「排除自己」', async () => {
  const { env, calls, F } = await loadSubmit();
  await submit(env, goodRecord(F, { [F.INVOICE_AGG]: { value: ' / A1 / ' } }));
  assert.ok(!invoiceQueryOf(calls).params.query.includes('$id !='));
  assert.ok(invoiceQueryOf(calls).params.query.endsWith('limit 100'));
});

check('發票號碼含雙引號或反斜線時要跳脫，不破壞查詢字串', async () => {
  const { env, calls, F } = await loadSubmit();
  await submit(env, goodRecord(F, { [F.INVOICE_AGG]: { value: ' / A"B\\C / ' } }));
  assert.ok(invoiceQueryOf(calls).params.query.includes('like " / A\\"B\\\\C / "'), invoiceQueryOf(calls).params.query);
});

check('發票號碼記錄空白 → 不發查詢', async () => {
  const { env, calls, F } = await loadSubmit();
  await submit(env, goodRecord(F));
  assert.strictEqual(invoiceQueryOf(calls), undefined);
});

check('查到重複 → 擋下並提示；沒查到 → 通過', async () => {
  const dup = await loadSubmit({ invoiceHits: 1 });
  const evDup = await submit(dup.env, goodRecord(dup.F, { [dup.F.INVOICE_AGG]: { value: ' / A1 / ' } }));
  assert.strictEqual(evDup.error, '儲存失敗');
  assert.ok(plainText(dup.env.swalCalls[0].html).includes('發票號碼重複：已存在相同發票號碼'));

  const clean = await loadSubmit({ invoiceHits: 0 });
  const evClean = await submit(clean.env, goodRecord(clean.F, { [clean.F.INVOICE_AGG]: { value: ' / A1 / ' } }));
  assert.strictEqual(evClean.error, undefined);
});

check('發票重複訊息：點名重複號碼與對方單號，每個號碼一行 ▸；沒重複的號碼不列', async () => {
  const { env, F } = await loadSubmit({
    invoiceRecords: (FF) => [{ $id: { value: '5' }, [FF.RECORD_NO]: { value: 'TR-0005' }, [FF.INVOICE_AGG]: { value: ' / AB12345678 / ZZ00000000 / ' } }],
  });
  const ev = await submit(env, goodRecord(F, { [F.INVOICE_AGG]: { value: ' / AB12345678 / CD87654321 / ' } }));
  assert.strictEqual(ev.error, '儲存失敗');
  const html = env.swalCalls[0].html;
  const text = plainText(html);
  assert.ok(text.includes('發票號碼重複'));
  assert.ok(html.includes('pr-v-chip'), '▸ 行要畫成紅框標籤');
  assert.ok(/AB12345678\s*交通費請款單號 TR-0005/.test(text), text);
  assert.ok(!text.includes('CD87654321'), '沒重複的號碼不該列出');
  assert.ok(!text.includes('ZZ00000000'), '對方獨有的號碼不該列出');
});

check('發票重複訊息：同一號碼撞到多張單、多個號碼各撞不同單 → 全部列出', async () => {
  const { env, F } = await loadSubmit({
    invoiceRecords: (FF) => [
      { $id: { value: '1' }, [FF.RECORD_NO]: { value: '101' }, [FF.INVOICE_AGG]: { value: ' / A1 / ' } },
      { $id: { value: '2' }, [FF.RECORD_NO]: { value: '102' }, [FF.INVOICE_AGG]: { value: ' / A1 / B2 / ' } },
      { $id: { value: '3' }, [FF.RECORD_NO]: { value: '103' }, [FF.INVOICE_AGG]: { value: ' / B2 / ' } },
    ],
  });
  await submit(env, goodRecord(F, { [F.INVOICE_AGG]: { value: ' / A1 / B2 / ' } }));
  const text = plainText(env.swalCalls[0].html);
  ['A1', 'B2', '101', '102', '103'].forEach((t) => assert.ok(text.includes(t), `${t}\n${text}`));
  assert.ok(text.includes('101、102') && text.includes('102、103'), text);
  assert.strictEqual((env.swalCalls[0].html.match(/pr-v-chip"/g) || []).length, 2, '兩個號碼兩個標籤');
});

check('發票重複訊息：號碼要完整比對，不會把 A1 當成 A12 的重複（退回原訊息）', async () => {
  const { env, F } = await loadSubmit({
    invoiceRecords: (FF) => [{ $id: { value: '9' }, [FF.RECORD_NO]: { value: '109' }, [FF.INVOICE_AGG]: { value: ' / A12 / ' } }],
  });
  await submit(env, goodRecord(F, { [F.INVOICE_AGG]: { value: ' / A1 / ' } }));
  assert.ok(plainText(env.swalCalls[0].html).includes('發票號碼重複：已存在相同發票號碼，請更換後再儲存。'));
});

check('發票重複訊息：比對不出明細（對方沒有單號）→ 退回原本那句話、沒有標籤', async () => {
  const { env, F } = await loadSubmit({ invoiceRecords: (FF) => [{ $id: { value: '9' }, [FF.INVOICE_AGG]: { value: ' / A1 / ' } }] });
  await submit(env, goodRecord(F, { [F.INVOICE_AGG]: { value: ' / A1 / ' } }));
  const html = env.swalCalls[0].html;
  assert.ok(plainText(html).includes('發票號碼重複：已存在相同發票號碼，請更換後再儲存。'));
  assert.ok(!html.includes('pr-v-chip"'));
});

check('發票查詢失敗 → 擋下並提示稍後再試（不放行）', async () => {
  const { env, F } = await loadSubmit({ failInvoice: true });
  const ev = await submit(env, goodRecord(F, { [F.INVOICE_AGG]: { value: ' / A1 / ' } }));
  assert.strictEqual(ev.error, '儲存失敗');
  assert.ok(plainText(env.swalCalls[0].html).includes('發票號碼檢查失敗'));
});

check('查 API 的兩項檢查（費用歸屬主檔、發票重複）同時送出，不互相等待', async () => {
  const sent = [];
  const waiting = [];
  const env = createEnv({
    appId: 749,
    api: (url, method, params) =>
      new Promise((resolve) => {
        const kind = params.app === env.window.PR_CONFIG.APPS.PAYMENT ? 'invoice' : `cc-${method}`;
        sent.push(kind);
        waiting.push(() => {
          if (kind === 'invoice') resolve({ records: [] });
          else if (kind === 'cc-POST') resolve({ id: 'c' });
          else resolve({ records: [{ [env.window.PR_CONFIG.REF_FIELDS.COST_CENTER.CODE]: { value: 'AJ30' } }], next: false });
        });
      }),
  });
  env.load('payment_request_config.js');
  env.load('payment_request_main_20260521.js');
  env.load('payment_request_submit_20260506.js');
  const F = env.window.PR_CONFIG.FIELDS;
  // 主程式 show 時已經在載入主檔；這裡直接讓存檔去等它，並讓發票查詢同時發出
  const done_ = submit(env, goodRecord(F, { [F.INVOICE_AGG]: { value: ' / A1 / ' } }));
  await new Promise((r) => setImmediate(r));
  assert.ok(sent.includes('invoice') && sent.includes('cc-POST'), `兩個查詢都該已送出：${sent}`);
  // 依序放行
  while (waiting.length) {
    waiting.shift()();
    await new Promise((r) => setImmediate(r));
  }
  const ev = await done_;
  assert.strictEqual(ev.error, undefined);
});

// ── 作廢跳過 ───────────────────────────────────────────────────────────────
check('表單作廢有勾 → 整段驗證跳過：不打 API、不擋存檔，即使公司名稱／付款方式／費用歸屬都有問題', async () => {
  const { env, calls, C, F } = await loadSubmit();
  const record = goodRecord(F, {
    [F.COMPANY_NAME]: { value: '' },
    [F.PAY_METHOD]: { value: [] },
    [F.INVOICE_AGG]: { value: ' / A1 / ' },
    ...withRows(F, ['']),
    [C.VOID_FIELD]: { value: [C.STATUS.VOID] },
  });
  const ev = await submit(env, record, 'edit');
  assert.strictEqual(ev.error, undefined);
  assert.strictEqual(env.swalCalls.length, 0);
  assert.strictEqual(calls.length, 0);
});

check('表單作廢沒勾（空陣列）→ 照常驗證', async () => {
  const { env, C, F } = await loadSubmit();
  const record = goodRecord(F, { [F.COMPANY_NAME]: { value: '' }, [C.VOID_FIELD]: { value: [] } });
  const ev = await submit(env, record, 'edit');
  assert.strictEqual(ev.error, '儲存失敗');
});

// ── 結構 ───────────────────────────────────────────────────────────────────
check('submit 原始碼沒有 723 的殘留（借支、分攤、交際費、帶入來源單、請購金額上限）', () => {
  const src = readSrc('payment_request_submit_20260506.js');
  [
    'F.TYPE', 'TYPES', 'ALLOWED_TYPES', 'COMPANY_PAYMENT_REQUEST', 'SRC.', 'SOURCE_FIELDS', 'fetchOriginalData', 'PR_ENT_AMOUNT',
    'PR_COST_CENTER_SCOPE', 'EXPENSE_FILL_MODE', 'AMOUNT_CHANGE', 'ENTERTAINMENT', 'VENDOR_TABLE', 'ATTACHMENT_TEXT', 'ADVANCE',
    'INVOICE_CHECK_TYPES', 'grand-total-display', 'docs/',
  ].forEach((s) => assert.ok(!src.includes(s), `不應殘留 ${s}`));
});

// ── 交通費明細規則＋掛帳單位限部內（2026-10-22）整合 ─────────────────────────
const loadFull = async ({ groups = [], invoiceHits = 0 } = {}) => {
  const calls = [];
  const env = createEnv({
    appId: 749,
    loginCode: 'ME',
    api: (url, method, params) => {
      calls.push({ url, method, params });
      const C = env.window.PR_CONFIG;
      if (url === '/v1/user/groups.json') return Promise.resolve({ groups: groups.map((name) => ({ code: name, name })) });
      if (url === '/v1/organizations.json') return Promise.resolve({ organizations: [{ code: 'LOG', parentCode: null }, { code: 'LOG-CS', parentCode: 'LOG' }, { code: 'GA', parentCode: null }] });
      if (params.app === C.APPS.COST_CENTER || params.id || url.includes('cursor')) {
        if (method === 'POST') return Promise.resolve({ id: 'c' });
        const CC = C.REF_FIELDS.COST_CENTER;
        const row = (code, dept) => ({ [CC.CODE]: { value: code }, [CC.DEPT]: { value: [{ code: dept, name: dept === 'LOG' ? '物流部' : '總務部' }] } });
        return Promise.resolve({ records: [row('AJ50', 'LOG'), row('AJ30', 'GA')], next: false });
      }
      return Promise.resolve({ records: Array.from({ length: invoiceHits }, () => ({ $id: { value: '1' } })) });
    },
  });
  ['payment_request_config.js', 'payment_request_main_20260521.js', '費用歸屬部門限制_20261022.js', '發票號碼寫入獨立欄位檢查.js', '交通費明細規則_20261022.js', 'payment_request_submit_20260506.js'].forEach((f) => env.load(f));
  return { env, calls, F: env.window.PR_CONFIG.FIELDS };
};

const trafficRecord = (F, rows, over = {}) => {
  const T = F.TRAFFIC_TABLE;
  return {
    [F.COMPANY_NAME]: { value: 'ＮＸ臺灣國際物流' },
    [F.PAY_METHOD]: { value: ['電匯'] },
    [F.INVOICE_AGG]: { value: '' },
    [F.APPLICANT]: { value: [{ code: 'ME', name: 'ME' }] },
    [F.EXPENSE_OWNER_ORG]: { value: [{ code: 'LOG-CS', name: '物流部-CS課' }] },
    [F.PAPER_RECEIPT]: { value: '否' },
    [F.REASON]: { value: '' },
    [T.CODE]: {
      value: rows.map((r) => {
        const value = {};
        Object.values(T.COLS).forEach((c) => (value[c] = { value: '' }));
        Object.entries(r).forEach(([c, v]) => (value[c] = { value: v }));
        return { value };
      }),
    },
    ...over,
  };
};

check('整合：部內代碼、高鐵票有號碼 → 通過；存檔時寫入高鐵固定值、發票號碼記錄，稅額保留畫面上的值（會計可手改）', async () => {
  const { env, F } = await loadFull();
  const C = F.TRAFFIC_TABLE.COLS;
  const r = trafficRecord(F, [{ [C.EXPENSE]: 'AJ50', [C.VEHICLE]: '高鐵', [C.AMOUNT]: '1490', [C.RECEIPT_TYPE]: '高鐵票', [C.INVOICE_NO]: 'T1', [C.TAX]: '70' }]);
  const ev = await submit(env, r);
  assert.strictEqual(ev.error, undefined, popupText(env));
  const v = ev.record[F.TRAFFIC_TABLE.CODE].value[0].value;
  assert.strictEqual(v[C.TAX].value, '70', '存檔不重算稅額');
  assert.strictEqual(v[C.SELLER_TAX_ID].value, '00000000');
  assert.strictEqual(v[C.FORMAT].value, '22');
  assert.strictEqual(ev.record[F.INVOICE_AGG].value, `${env.window.PR_CONFIG.SEP}T1${env.window.PR_CONFIG.SEP}`);
});

check('整合：部外代碼＋計程車沒理由＋發票沒號碼 → 一個視窗列出全部錯誤；紙本憑證強制為「是」', async () => {
  const { env, F } = await loadFull();
  const C = F.TRAFFIC_TABLE.COLS;
  const r = trafficRecord(F, [
    { [C.EXPENSE]: 'AJ30', [C.VEHICLE]: '計程車', [C.AMOUNT]: '300', [C.RECEIPT_TYPE]: '發票' },
  ]);
  const ev = await submit(env, r);
  assert.strictEqual(ev.error, '儲存失敗');
  const text = plainText(env.swalCalls[0].html);
  ['請填寫「發票號碼」', '請填寫「理由」', '只能是費用所屬人的部內'].forEach((s) => assert.ok(text.includes(s), `${s}\n${text}`));
  assert.strictEqual(ev.record[F.PAPER_RECEIPT].value, '是', '有計程車，存檔時強制選「是」');
});

check('整合：申請人在「費用歸屬不限部門」群組 → 部外代碼也放行', async () => {
  const { env, F } = await loadFull({ groups: ['費用歸屬不限部門'] });
  const C = F.TRAFFIC_TABLE.COLS;
  const ev = await submit(env, trafficRecord(F, [{ [C.EXPENSE]: 'AJ30', [C.AMOUNT]: '100' }]));
  assert.strictEqual(ev.error, undefined, popupText(env));
});

done();
