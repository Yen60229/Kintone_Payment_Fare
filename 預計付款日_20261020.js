(() => {
  'use strict';

  // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
  const KT = window.PR_KT;

  // =============================================================================
  // 預計付款日（2026-10-20）
  //   會計需要 5 個工作日作業，之後的第一個付款日（每月 10 號、20 號、月底）付款，付款日遇假日往後順延。
  //   起算日＝請款日期（不含當天）。工作日看行事曆 App（APPS.HOLIDAY_CALENDAR）：
  //     有記錄 → 看「是否假日」（是＝放假、否＝補行上班）；沒有記錄 → 週六日放假、其餘上班。
  //   存檔時寫入「預計付款日」，畫面上一律鎖住。規則見設定檔 EXPECTED_PAY_DATE。
  // =============================================================================

  const C = window.PR_CONFIG;
  const F = C.FIELDS;
  const CFG = C.EXPECTED_PAY_DATE;
  const CAL = C.REF_FIELDS.HOLIDAY_CALENDAR;

  // ── 日期工具（一律用 UTC 運算，避免時區、日光節約讓日期跑掉）──────────────
  const parseDate = (str) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
    return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  };
  const formatDate = (d) => d.toISOString().slice(0, 10);
  const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
  const lastDayOfMonth = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  /**
   * 這天上不上班。
   * @param {Date} d
   * @param {Object<string,boolean>} holidayOf  'YYYY-MM-DD' → true（放假）／false（補行上班）；沒有的日子看星期
   * @returns {boolean}
   */
  const isWorkday = (d, holidayOf) => {
    const key = formatDate(d);
    if (Object.prototype.hasOwnProperty.call(holidayOf, key)) return !holidayOf[key];
    const dow = d.getUTCDay();
    return dow !== 0 && dow !== 6;
  };

  /**
   * 某天當天或之後的第一個付款日（每月 PAY_DAYS 與月底）。
   * @param {Date} d
   * @param {number[]} payDays
   * @returns {Date}
   */
  const nextPayDayOnOrAfter = (d, payDays) => {
    let year = d.getUTCFullYear();
    let month = d.getUTCMonth();
    for (let i = 0; i < 2; i++) {
      const last = lastDayOfMonth(year, month);
      const days = [...new Set([...payDays.filter((n) => n < last), last])].sort((a, b) => a - b);
      for (const day of days) {
        const candidate = new Date(Date.UTC(year, month, day));
        if (candidate >= d) return candidate;
      }
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
    }
    return d; // 走不到這裡：當月找不到，下個月的第一個付款日一定在之後
  };

  /**
   * 算預計付款日（純函式）。
   * @param {string} requestDate 請款日期 'YYYY-MM-DD'
   * @param {Object<string,boolean>} holidayOf 見 isWorkday
   * @param {{leadWorkdays?:number, payDays?:number[]}} [opts]
   * @returns {string} 'YYYY-MM-DD'；請款日期不是合法日期時回空字串
   */
  const calcExpectedPayDate = (requestDate, holidayOf = {}, opts = {}) => {
    const start = parseDate(requestDate);
    if (!start) return '';
    const leadWorkdays = opts.leadWorkdays ?? CFG.LEAD_WORKDAYS;
    const payDays = opts.payDays ?? CFG.PAY_DAYS;

    // ① 起算日隔天開始數，第 N 個工作日＝會計作業完成日
    let ready = start;
    for (let counted = 0; counted < leadWorkdays; ) {
      ready = addDays(ready, 1);
      if (isWorkday(ready, holidayOf)) counted += 1;
    }

    // ② 完成日當天或之後的第一個付款日，③ 遇假日往後順延到上班日
    let payDate = nextPayDayOnOrAfter(ready, payDays);
    while (!isWorkday(payDate, holidayOf)) payDate = addDays(payDate, 1);
    return formatDate(payDate);
  };

  /**
   * 向行事曆查「請款日期之後 LOOKAHEAD_DAYS 天」的假日與補班日。
   * @param {string} requestDate
   * @param {Function} [api] 預設 kintone.api，測試時注入
   * @returns {Promise<Object<string,boolean>>}
   */
  const fetchHolidayMap = async (requestDate, api = kintone.api) => {
    const start = parseDate(requestDate);
    if (!start) return {};
    const end = addDays(start, CFG.LOOKAHEAD_DAYS);
    const resp = await api(kintone.api.url('/k/v1/records', true), 'GET', {
      app: C.APPS.HOLIDAY_CALENDAR,
      query: `${CAL.DATE} > "${formatDate(start)}" and ${CAL.DATE} <= "${formatDate(end)}" order by ${CAL.DATE} asc limit 500`,
      fields: [CAL.DATE, CAL.IS_HOLIDAY],
    });
    const holidayOf = {};
    let lastDate = formatDate(start);
    (resp.records || []).forEach((r) => {
      const date = r[CAL.DATE]?.value;
      const flag = r[CAL.IS_HOLIDAY]?.value;
      if (!date) return;
      if (date > lastDate) lastDate = date;
      if (flag === CAL.HOLIDAY_VALUE) holidayOf[date] = true;
      else if (flag === CAL.WORKDAY_VALUE) holidayOf[date] = false;
    });
    // 行事曆每週都有週末記錄；查詢區間尾端超過 7 天沒記錄＝那段還沒建檔（例如下一年度），只能靠星期判斷
    if (addDays(parseDate(lastDate), 7) < end) {
      console.warn(`[預計付款日] 行事曆 ${lastDate} 之後沒有資料，之後的國定假日不會排除，請補建行事曆`);
    }
    return holidayOf;
  };

  /**
   * 按下儲存時寫入預計付款日。
   * 行事曆查不到（權限、網路）時不擋存檔，改用「只看週末」的算法，並在 Console 留警告。
   */
  const handleSubmit = async (event) => {
    if (event.error) return event;
    const record = event.record;
    if (!record[F.EXPECTED_PAY_DATE]) return event; // 表單還沒建這個欄位
    const requestDate = record[F.PAYMENT_DATE]?.value;
    let holidayOf = {};
    try {
      holidayOf = await fetchHolidayMap(requestDate);
    } catch (err) {
      console.warn('[預計付款日] 查詢行事曆失敗，改用只排除週末的算法：', err);
    }
    record[F.EXPECTED_PAY_DATE].value = calcExpectedPayDate(requestDate, holidayOf) || null;
    return event;
  };

  KT.on(['app.record.create.submit', 'app.record.edit.submit'], handleSubmit);

  /**
   * 畫面：預計付款日鎖住，並在旁邊的空白欄位顯示付款說明。
   */
  const handleShow = (event) => {
    const record = event.record;
    const field = record[F.EXPECTED_PAY_DATE];
    if (!field) return event;
    if (event.type !== 'app.record.detail.show' && event.type !== 'app.record.print.show') field.disabled = true;
    const space = KT.record().getSpaceElement(C.SPACES.EXPECTED_PAY_DATE_NOTE);
    if (space) {
      space.textContent = `※ ${CFG.NOTE}`;
      space.classList.add('pr-expected-pay-note'); // 樣式在 styles/common.css
    }
    return event;
  };

  KT.on(['app.record.create.show', 'app.record.edit.show', 'app.record.detail.show', 'app.record.print.show'], handleShow);

  window.PR_EXPECTED_PAY_DATE = Object.freeze({ calcExpectedPayDate, isWorkday, nextPayDayOnOrAfter, fetchHolidayMap, handleSubmit, handleShow });
})();
