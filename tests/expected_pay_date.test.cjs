'use strict';

// 測試：預計付款日_20261020.js（2026-10-20）
//   請款日期（不含當天）＋5 個工作日後，取第一個 10 號／20 號／月底，遇假日往後順延。
//   工作日看行事曆 App（有記錄看「是否假日」，沒記錄看星期）。
// 單獨執行：node tests/expected_pay_date.test.cjs

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
const readSrc = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8');

let apiHandler = async () => ({ records: [] });
const apiCalls = [];
const registered = [];
const shown = {};

global.window = {};
global.kintone = {
  app: {
    getId: () => 749,
    record: { setFieldShown: (code, v) => (shown[code] = v), getSpaceElement: () => null },
  },
  getLoginUser: () => ({ code: 'x' }),
  api: Object.assign(
    (url, method, params) => {
      apiCalls.push({ url, method, params });
      return apiHandler(url, method, params);
    },
    { url: (p) => p },
  ),
  events: { on: (types, handler) => registered.push({ types, handler }) },
};

// eslint-disable-next-line no-eval
eval(readSrc('payment_request_config.js'));
// eslint-disable-next-line no-eval
eval(readSrc('預計付款日_20261020.js'));

const C = global.window.PR_CONFIG;
const F = C.FIELDS;
const M = global.window.PR_EXPECTED_PAY_DATE;
console.warn = () => {};

// 2026 年行事曆的一小段（取自 App 620 實際資料）：除夕～春節補假、和平紀念日補假
const CNY_2026 = {
  '2026-02-14': true, '2026-02-15': true, '2026-02-16': true, '2026-02-17': true, '2026-02-18': true,
  '2026-02-19': true, '2026-02-20': true, '2026-02-21': true, '2026-02-22': true,
  '2026-02-27': true, '2026-02-28': true, '2026-03-01': true,
};

// App 620 實際資料：2026/10 國慶日補假、光復節補假
const OCT_2026 = {
  '2026-10-03': true, '2026-10-04': true, '2026-10-09': true, '2026-10-10': true, '2026-10-11': true,
  '2026-10-17': true, '2026-10-18': true, '2026-10-24': true, '2026-10-25': true, '2026-10-26': true,
  '2026-10-31': true, '2026-11-01': true,
};

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

(async () => {
  console.log('expected_pay_date.test.cjs');

  // ── 設定 ──────────────────────────────────────────────────────────────
  await check('設定：5 個工作日、10／20 號（另加月底）、不分類型（設定檔沒有適用類型清單）、行事曆 App 有登記', () => {
    assert.strictEqual(C.EXPECTED_PAY_DATE.LEAD_WORKDAYS, 5);
    assert.deepStrictEqual([...C.EXPECTED_PAY_DATE.PAY_DAYS], [10, 20]);
    assert.ok(!('APPLY_TYPES' in C.EXPECTED_PAY_DATE));
    assert.ok(Number(C.APPS.HOLIDAY_CALENDAR) > 0);
    assert.strictEqual(F.EXPECTED_PAY_DATE, '預計付款日');
    assert.strictEqual(C.EXPECTED_PAY_DATE.NOTE, '員工代墊款項支付日期為每月10、20、月底，遇假日順延');
  });

  // ── 純計算 ────────────────────────────────────────────────────────────
  await check('沒有假日：10/1（四）＋5 工作日＝10/8（四）→ 10/10（六）遇假日順延到 10/12（一）', () => {
    assert.strictEqual(M.calcExpectedPayDate('2026-10-01', {}), '2026-10-12');
  });

  await check('完成日剛好是付款日當天就付：10/13（二）＋5＝10/20（二）', () => {
    assert.strictEqual(M.calcExpectedPayDate('2026-10-13', {}), '2026-10-20');
  });

  await check('月底：10/21（三）＋5＝10/28（三）→ 10/31（六）順延到 11/2（一）', () => {
    assert.strictEqual(M.calcExpectedPayDate('2026-10-21', {}), '2026-11-02');
  });

  await check('過了月底跳下個月 10 號：12/28（一）＋5＝1/4（一）→ 1/10（日）順延到 1/11（一）', () => {
    assert.strictEqual(M.calcExpectedPayDate('2026-12-28', {}), '2027-01-11');
  });

  await check('2 月月底是 28 號：2/12 起算（中間春節連假）→ 完成日 2/26，付款日 2/28 放假 → 3/1 放假 → 3/2', () => {
    assert.strictEqual(M.calcExpectedPayDate('2026-02-12', CNY_2026), '2026-03-02');
  });

  await check('行事曆的假日不算工作日：2/12（四）只剩 2/13、2/23、2/24、2/25、2/26 五天', () => {
    // 沒有行事曆時只排週末：2/13、16、17、18、19 → 完成日 2/19，付款日 2/20
    assert.strictEqual(M.calcExpectedPayDate('2026-02-12', {}), '2026-02-20');
    assert.strictEqual(M.calcExpectedPayDate('2026-02-12', CNY_2026), '2026-03-02');
  });

  await check('補行上班日（isHoliday＝否）算工作日、付款日落在補班日不順延', () => {
    // 10/10（六）設成補班：10/1 ＋5＝10/8 → 10/10 照付
    assert.strictEqual(M.calcExpectedPayDate('2026-10-01', { '2026-10-10': false }), '2026-10-10');
  });

  await check('起算日不算在 5 天內；請款日期空白或格式錯 → 空字串', () => {
    assert.strictEqual(M.calcExpectedPayDate('2026-10-05', {}), '2026-10-20'); // 10/6～10/12 → 10/12 → 10/20
    assert.strictEqual(M.calcExpectedPayDate('', {}), '');
    assert.strictEqual(M.calcExpectedPayDate('2026/10/05', {}), '');
  });

  await check('nextPayDayOnOrAfter：月中、當天、閏年 2 月底', () => {
    const d = (s) => new Date(`${s}T00:00:00Z`);
    const f = (x) => x.toISOString().slice(0, 10);
    assert.strictEqual(f(M.nextPayDayOnOrAfter(d('2026-10-11'), [10, 20])), '2026-10-20');
    assert.strictEqual(f(M.nextPayDayOnOrAfter(d('2026-10-10'), [10, 20])), '2026-10-10');
    assert.strictEqual(f(M.nextPayDayOnOrAfter(d('2028-02-21'), [10, 20])), '2028-02-29');
  });

  // ── 查行事曆 ──────────────────────────────────────────────────────────
  await check('fetchHolidayMap：查 App 620 起算日後 60 天，是＝放假、否＝補班、其他值忽略', async () => {
    apiCalls.length = 0;
    apiHandler = async () => ({
      records: [
        { date: { value: '2026-10-10' }, isHoliday: { value: '是' } },
        { date: { value: '2026-10-17' }, isHoliday: { value: '否' } },
        { date: { value: '2026-10-18' }, isHoliday: { value: '' } },
      ],
    });
    const map = await M.fetchHolidayMap('2026-10-01');
    assert.deepStrictEqual(map, { '2026-10-10': true, '2026-10-17': false });
    assert.strictEqual(apiCalls[0].params.app, C.APPS.HOLIDAY_CALENDAR);
    assert.match(apiCalls[0].params.query, /date > "2026-10-01" and date <= "2026-11-30"/);
  });

  await check('實際行事曆：10/20（二）＋5 跳過 10/26 光復節補假＝10/28 → 10/31（六）順延到 11/2（一）', () => {
    assert.strictEqual(M.calcExpectedPayDate('2026-10-20', OCT_2026), '2026-11-02');
    // 10/2（五）＋5 跳過 10/9 國慶補假：10/5、6、7、8、12 → 完成日 10/12 → 10/20
    assert.strictEqual(M.calcExpectedPayDate('2026-10-02', OCT_2026), '2026-10-20');
    assert.strictEqual(M.calcExpectedPayDate('2026-10-02', {}), '2026-10-12'); // 沒行事曆會誤算成 10/12
  });

  await check('fetchHolidayMap：行事曆尾端超過 7 天沒資料（下一年度未建檔）→ Console 警告；有資料則不警告', async () => {
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    try {
      apiHandler = async () => ({ records: [{ date: { value: '2026-12-27' }, isHoliday: { value: '是' } }] });
      await M.fetchHolidayMap('2026-12-01'); // 查到 2027-01-30
      assert.strictEqual(warns.length, 1);
      assert.match(warns[0], /2026-12-27 之後沒有資料/);

      warns.length = 0;
      apiHandler = async () => ({ records: [{ date: { value: '2026-11-28' }, isHoliday: { value: '是' } }] });
      await M.fetchHolidayMap('2026-10-01'); // 查到 2026-11-30，最後一筆 11/28
      assert.strictEqual(warns.length, 0);
    } finally {
      console.warn = origWarn;
    }
  });

  // ── 存檔 ──────────────────────────────────────────────────────────────
  const recordOf = (extra = {}) => ({
    [F.PAYMENT_DATE]: { value: '2026-10-01' },
    [F.EXPECTED_PAY_DATE]: { value: '' },
    ...extra,
  });

  await check('存檔：不分類型，新增與編輯一律寫入預計付款日', async () => {
    apiHandler = async () => ({ records: [] });
    for (const type of ['app.record.create.submit', 'app.record.edit.submit']) {
      const event = { type, record: recordOf() };
      await M.handleSubmit(event);
      assert.strictEqual(event.record[F.EXPECTED_PAY_DATE].value, '2026-10-12', type);
    }
  });

  await check('存檔：編輯時舊值會依新的請款日期重算', async () => {
    apiHandler = async () => ({ records: [] });
    const event = { type: 'app.record.edit.submit', record: recordOf({ [F.PAYMENT_DATE]: { value: '2026-10-13' }, [F.EXPECTED_PAY_DATE]: { value: '2026-10-12' } }) };
    await M.handleSubmit(event);
    assert.strictEqual(event.record[F.EXPECTED_PAY_DATE].value, '2026-10-20');
  });

  await check('存檔：請款日期空白 → 預計付款日寫 null', async () => {
    const event = { type: 'app.record.create.submit', record: recordOf({ [F.PAYMENT_DATE]: { value: '' } }) };
    await M.handleSubmit(event);
    assert.strictEqual(event.record[F.EXPECTED_PAY_DATE].value, null);
  });

  await check('存檔：行事曆查詢失敗不擋存檔，改用只排週末的算法', async () => {
    apiHandler = async () => {
      throw new Error('403');
    };
    const event = { type: 'app.record.edit.submit', record: recordOf() };
    await M.handleSubmit(event);
    assert.strictEqual(event.error, undefined);
    assert.strictEqual(event.record[F.EXPECTED_PAY_DATE].value, '2026-10-12');
  });

  await check('存檔：表單沒這欄位就略過、已有錯誤不處理', async () => {
    const noField = { type: 'app.record.create.submit', record: { [F.PAYMENT_DATE]: { value: '2026-10-01' } } };
    await M.handleSubmit(noField);
    assert.deepStrictEqual(Object.keys(noField.record), [F.PAYMENT_DATE]);

    apiCalls.length = 0;
    const blocked = { type: 'app.record.create.submit', error: 'x', record: recordOf() };
    await M.handleSubmit(blocked);
    assert.strictEqual(blocked.record[F.EXPECTED_PAY_DATE].value, '');
    assert.strictEqual(apiCalls.length, 0);
  });

  await check('畫面：編輯時鎖住、一律顯示說明；詳細頁不鎖', () => {
    const edit = { type: 'app.record.edit.show', record: recordOf() };
    M.handleShow(edit);
    assert.strictEqual(edit.record[F.EXPECTED_PAY_DATE].disabled, true);
    assert.ok(!(F.EXPECTED_PAY_DATE in shown), '不再切換顯示／隱藏');
    const detail = { type: 'app.record.detail.show', record: recordOf() };
    M.handleShow(detail);
    assert.notStrictEqual(detail.record[F.EXPECTED_PAY_DATE].disabled, true);
  });

  await check('事件：只註冊 show 與 submit，沒有任何 change 事件', () => {
    const all = registered.flatMap((r) => (Array.isArray(r.types) ? r.types : [r.types]));
    assert.ok(all.includes('app.record.create.show') && all.includes('app.record.edit.submit'));
    assert.ok(!all.some((t) => t.includes('.change.')));
  });

  await check('載入順序：src/index.js 有接線', () => {
    const index = readSrc('src/index.js');
    assert.ok(index.includes("import '../預計付款日_20261020.js';"));
    assert.ok(index.indexOf('payment_request_config.js') < index.indexOf('預計付款日_20261020.js'));
  });

  console.log(`${passed} assertions passed.`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
