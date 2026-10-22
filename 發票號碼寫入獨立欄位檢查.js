(() => {
  'use strict';

  // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
  const KT = window.PR_KT;

  const F = window.PR_CONFIG.FIELDS;
  const TABLE_CODE = F.TRAFFIC_TABLE.CODE;
  const INVOICE_CODE = F.TRAFFIC_TABLE.COLS.INVOICE_NO;
  const INVOICE_AGG_CODE = F.INVOICE_AGG;
  const SEP = window.PR_CONFIG.SEP;

  // 從交通費子表格取得發票清單
  function getInvoiceList(record) {
    const rows = record[TABLE_CODE]?.value || [];
    return rows.map((r) => (r.value?.[INVOICE_CODE]?.value || '').trim()).filter((v) => v.length > 0);
  }

  // 彙整發票號碼（去重）：頭尾也加分隔字元，方便用「包含」搜尋單一號碼
  function buildInvoiceAgg(record) {
    const unique = [...new Set(getInvoiceList(record))];
    return unique.length ? `${SEP}${unique.join(SEP)}${SEP}` : '';
  }

  const allEvents = [
    `app.record.create.change.${TABLE_CODE}`,
    `app.record.edit.change.${TABLE_CODE}`,
    `app.record.create.change.${INVOICE_CODE}`,
    `app.record.edit.change.${INVOICE_CODE}`,
  ];

  KT.on(allEvents, (event) => {
    event.record[INVOICE_AGG_CODE].value = buildInvoiceAgg(event.record);
    return event;
  });

  window.PR_INVOICE_AGG = Object.freeze({ buildInvoiceAgg });
})();
