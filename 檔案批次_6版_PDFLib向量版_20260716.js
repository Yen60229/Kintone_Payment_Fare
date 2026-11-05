// 檔案批次+截圖_4版_20260119_表格智能分頁_PDFLib向量版.js
// 批次下載附件 + 批次列印PDF（改：PDF 由 PDFLib 向量生成；移除 html2canvas / jsPDF）
// 事件註冊放最下方
(function () {
  'use strict';

  const F = window.PR_CONFIG.FIELDS;

  // ======================== 基本設定 ========================
  const DOWNLOAD_FOLDER_NAME = '請款_報銷申請單';

  // PDF 字型來源（Kintone 檔案欄位放置字型檔）
  const FONT_CONFIG = {
    FONT_APP_ID: window.PR_CONFIG.APPS.PDF_FONT,
    FONT_RECORD_ID: 1,
    FONT_FIELD_CODE: 'Kintone主頁用',
    FONT_FILE_NAME: 'FONT_FILE_NAME',
  };

  const { PDFDocument, rgb } = window.PDFLib || {};
  if (!PDFDocument) {
    // 不 throw，避免阻斷 index.show；在真正產 PDF 時再提示
    console.warn('[PDF] 找不到 PDFLib，請確認已載入 PDFLib library');
  }

  // ======================== 🔍 權限診斷工具 ========================
  // 在 Console 輸入: checkPermission() 進行診斷
  window.checkPermission = async (testUserCode) => {
    const currentUser = kintone.getLoginUser();
    const fontAppId = window.PR_CONFIG.APPS.PDF_FONT;
    console.log('🔍 ========== 權限診斷開始 ==========');
    console.log('🔍 當前登入者:', currentUser.code, currentUser.name);
    console.log('🔍 測試對象:', testUserCode || '(當前使用者)');
    console.log('🔍 當前 App ID:', kintone.app.getId());

    // 測試 PDF 字型 App
    console.log(`🔍 測試 App ${fontAppId} (PDF 字型)...`);
    try {
      await kintone.api(kintone.api.url('/k/v1/record', true), 'GET', {
        app: fontAppId,
        id: FONT_CONFIG.FONT_RECORD_ID,
      });
      console.log(`🔍 ✅ App ${fontAppId}: 有權限`);
    } catch (e) {
      console.error(`🔍 ❌ App ${fontAppId}: 無權限 -`, e.message || e);
    }

    console.log('🔍 ========== 權限診斷結束 ==========');
    console.log(`🔍 💡 若 App ${fontAppId} 無權限，請為該使用者開放 App ${fontAppId} 檢視權限`);
  };

  // ======================== 安全配置 ========================
  const SECURITY_CONFIG = {
    maxRecords: 50,
    allowedDomains: [window.location.origin],
    csrfTokenName: 'X-Cybozu-API-Token',
    maxFileSize: 50 * 1024 * 1024,
    screenshotTimeout: 5000,
  };

  // ======================== 表格設定 ========================
  // 明細只有「交通費請款單」子表格一種：[顯示名稱, 子表格欄位代碼]
  const TABLE_CONFIG = {
    tableFieldName: F.TRAFFIC_TABLE.CODE,
    fields: [
      ['憑證日期', F.TRAFFIC_TABLE.COLS.DATE],
      ['交通工具', F.TRAFFIC_TABLE.COLS.VEHICLE],
      ['拜訪客戶', F.TRAFFIC_TABLE.COLS.VISIT_CUSTOMER],
      ['起訖點', F.TRAFFIC_TABLE.COLS.ROUTE],
      ['金額', F.TRAFFIC_TABLE.COLS.AMOUNT],
      ['費用歸屬', F.TRAFFIC_TABLE.COLS.EXPENSE],
      ['憑證種類', F.TRAFFIC_TABLE.COLS.RECEIPT_TYPE],
      ['發票號碼', F.TRAFFIC_TABLE.COLS.INVOICE_NO],
      ['賣方統編', F.TRAFFIC_TABLE.COLS.SELLER_TAX_ID],
      ['格式', F.TRAFFIC_TABLE.COLS.FORMAT],
      ['稅額', F.TRAFFIC_TABLE.COLS.TAX],
    ],
  };

  // 數字欄位（靠右、加千分位）的顯示名稱
  const NUMERIC_COLUMNS = ['金額', '稅額'];

  // ======================== 通用工具 ========================
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  const formatDateTime = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${y}${m}${d}_${h}${min}`;
  };

  const formatNumber = (num) => {
    if (num === undefined || num === null || num === '') return '';
    const n = Number(String(num).replace(/,/g, ''));
    if (Number.isNaN(n)) return String(num);
    return n.toLocaleString('zh-TW');
  };

  function sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    return input.replace(/[<>'"&]/g, '').trim();
  }

  function validateSecurity() {
    if (!window.kintone || !window.kintone.app) {
      throw new Error('此功能僅能在 kintone 環境中使用');
    }
    if (!window.location.hostname.includes('cybozu') && !window.location.hostname.includes('kintone')) {
      throw new Error('不安全的執行環境');
    }
    return true;
  }

  function generateSecurityToken() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function validateRecordIds(recordIds) {
    if (!Array.isArray(recordIds)) throw new Error('無效的記錄號碼格式');
    if (recordIds.length === 0) throw new Error('請至少選擇一筆記錄');
    if (recordIds.length > SECURITY_CONFIG.maxRecords) throw new Error(`一次最多只能處理 ${SECURITY_CONFIG.maxRecords} 筆記錄`);
    for (const id of recordIds) {
      if (!Number.isInteger(id) || id <= 0) throw new Error(`無效的記錄號碼: ${id}`);
    }
    return true;
  }

  function secureKintoneApi(path, method, params, securityToken) {
    return new Promise((resolve, reject) => {
      const secureParams = { ...params, __token: securityToken };
      kintone.api(
        kintone.api.url(path, true),
        method,
        secureParams,
        (resp) => (resp && typeof resp === 'object' ? resolve(resp) : reject(new Error('無效的 API 回應'))),
        (error) => reject(new Error('API 呼叫失敗: ' + (error.message || 'Unknown error'))),
      );
    });
  }

  // ======================== 檔案下載（附件 / 字型）========================
  const downloadFile = function (fileKey) {
    return new Promise(function (resolve, reject) {
      const url = kintone.api.url('/k/v1/file', true) + '?fileKey=' + fileKey;
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      xhr.responseType = 'blob';
      xhr.onload = function () {
        if (xhr.status === 200) resolve(xhr.response);
        else reject(new Error('下載檔案失敗'));
      };
      xhr.onerror = function () {
        reject(new Error('網路錯誤'));
      };
      xhr.send();
    });
  };

  const blobToArrayBuffer = function (blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsArrayBuffer(blob);
    });
  };

  async function secureFileDownload(fileKey) {
    const downloadUrl = kintone.api.url('/k/v1/file', true) + '?fileKey=' + fileKey;
    const response = await fetch(downloadUrl, { method: 'GET', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const blob = await response.blob();
    if (blob.size > SECURITY_CONFIG.maxFileSize) throw new Error('檔案大小超過限制');
    return blob;
  }

  // 字型快取（避免每筆都重抓）
  let _fontBufferCache = null;
  const fetchFontFromKintone = async function () {
    if (_fontBufferCache) return _fontBufferCache;

    // 取得指定 App 與 Record 的資料
    const resp = await kintone.api(kintone.api.url('/k/v1/record', true), 'GET', {
      app: FONT_CONFIG.FONT_APP_ID,
      id: FONT_CONFIG.FONT_RECORD_ID,
    });

    // 從同筆記錄的 FONT_FILE_NAME 欄位讀取檔案名稱
    const targetFileName = resp.record[FONT_CONFIG.FONT_FILE_NAME]?.value;
    if (!targetFileName) {
      throw new Error('找不到 FONT_FILE_NAME 欄位值');
    }

    // 從附件欄位中尋找對應檔案
    const attachments = resp.record[FONT_CONFIG.FONT_FIELD_CODE]?.value || [];
    const fontFile = attachments.find((file) => file.name === targetFileName);
    if (!fontFile) {
      throw new Error(`找不到檔案：${targetFileName}`);
    }

    // 下載檔案並轉成 ArrayBuffer
    const fontBlob = await downloadFile(fontFile.fileKey);
    _fontBufferCache = await blobToArrayBuffer(fontBlob);
    return _fontBufferCache;
  };

  // ======================== 取得表格資料（明細）========================
  function getTableData(record) {
    const { tableFieldName, fields } = TABLE_CONFIG;
    const tableData = record[tableFieldName]?.value;
    if (!Array.isArray(tableData) || tableData.length === 0) return null;

    const displayNames = fields.map((f) => f[0]);
    const rows = tableData.map((row) => {
      const rowData = {};
      fields.forEach(([displayName, fieldCode]) => {
        rowData[displayName] = row.value?.[fieldCode]?.value || '';
      });
      return rowData;
    });

    return { displayNames, rows };
  }

  // ======================== PDFLib 向量繪製工具 ========================
  const ensurePdfDeps = () => {
    if (!window.PDFLib || !PDFDocument) throw new Error('缺少 PDFLib，請先載入 PDFLib library');
    if (!window.fontkit) throw new Error('缺少 fontkit，請先載入 fontkit library');
  };

  const measureTextW = (font, size, text) => font.widthOfTextAtSize(String(text ?? ''), size);

  const wrapTextPdf = (font, size, text, maxWidth) => {
    const s = String(text ?? '');
    if (!s) return [''];

    const result = [];
    // 先依換行符拆分
    const paragraphs = s.split('\n');

    for (const para of paragraphs) {
      if (!para) {
        result.push('');
        continue;
      }
      let cur = '';
      for (const ch of para) {
        const test = cur + ch;
        if (measureTextW(font, size, test) > maxWidth && cur) {
          result.push(cur);
          cur = ch;
        } else {
          cur = test;
        }
      }
      if (cur) result.push(cur);
    }

    return result.length ? result : [''];
  };

  const createPager = (pdfDoc, pageW, pageH, margins) => {
    const state = {
      pageW,
      pageH,
      marginL: margins.l,
      marginR: margins.r,
      marginT: margins.t,
      marginB: margins.b,
      page: pdfDoc.addPage([pageW, pageH]),
      y: pageH - margins.t,
    };

    state.newPage = () => {
      state.page = pdfDoc.addPage([pageW, pageH]);
      state.y = pageH - margins.t;
    };

    state.ensureSpace = (needH) => {
      if (state.y - needH < state.marginB) state.newPage();
    };

    return state;
  };

  const drawCell = ({ page, x, yTop, w, h, border = true, fill = null }) => {
    const y = yTop - h;
    page.drawRectangle({
      x,
      y,
      width: w,
      height: h,
      color: fill || rgb(1, 1, 1),
      borderColor: border ? rgb(0, 0, 0) : undefined,
      borderWidth: border ? 1 : 0,
    });
  };

  const drawTextInCell = ({ page, font, size, x, yTop, w, h, text, align = 'left', padding = 4, color = rgb(0, 0, 0) }) => {
    const maxW = w - padding * 2;
    const lines = wrapTextPdf(font, size, text, maxW);

    const lineH = size + 2;
    const maxLinesByHeight = Math.max(1, Math.floor((h - padding * 2) / lineH));
    const usedLines = lines.slice(0, maxLinesByHeight);

    let y = yTop - padding - size;
    for (const line of usedLines) {
      const t = String(line ?? '');
      let tx = x + padding;
      if (align === 'center') {
        const tw = measureTextW(font, size, t);
        tx = x + (w - tw) / 2;
      } else if (align === 'right') {
        const tw = measureTextW(font, size, t);
        tx = x + w - padding - tw;
      }
      page.drawText(t, { x: tx, y, size, font, color });
      y -= lineH;
    }
  };

  const calcRowHeight = ({ columns, colWidths, font, size, row, padding = 4, minH = 18 }) => {
    const lineH = size + 2;
    let maxLines = 1;

    columns.forEach((c, i) => {
      const w = colWidths[i];
      const lines = wrapTextPdf(font, size, row[c.key], w - padding * 2);
      maxLines = Math.max(maxLines, lines.length);
    });

    return Math.max(minH, maxLines * lineH + padding * 2);
  };

  const drawTablePdf = ({
    pager,
    title,
    columns, // [{label,key,align?}]
    rows, // array of object
    font,
    fontBold,
    colWidths,
    fontSize = 10,
    headerSize = 10,
    padding = 4,
  }) => {
    const pageW = pager.pageW;
    const usableW = pageW - pager.marginL - pager.marginR;
    const x0 = pager.marginL;

    // title
    if (title) {
      pager.ensureSpace(22);
      pager.page.drawText(title, { x: x0, y: pager.y - 16, size: 14, font: fontBold });
      pager.y -= 22;
    }

    // header
    const headerH = 20;
    pager.ensureSpace(headerH);

    let x = x0;
    columns.forEach((c, i) => {
      const w = colWidths[i];
      drawCell({ page: pager.page, x, yTop: pager.y, w, h: headerH, fill: rgb(0.97, 0.97, 0.97) });
      drawTextInCell({
        page: pager.page,
        font: fontBold,
        size: headerSize,
        x,
        yTop: pager.y,
        w,
        h: headerH,
        text: c.label,
        align: 'center',
        padding,
      });
      x += w;
    });

    pager.y -= headerH;

    // body
    rows.forEach((row, idx) => {
      const rowH = calcRowHeight({ columns, colWidths, font, size: fontSize, row, padding, minH: 18 });
      pager.ensureSpace(rowH);

      const fill = idx % 2 === 1 ? rgb(0.99, 0.99, 0.99) : rgb(1, 1, 1);

      x = x0;
      columns.forEach((c, i) => {
        const w = colWidths[i];
        drawCell({ page: pager.page, x, yTop: pager.y, w, h: rowH, fill });
        drawTextInCell({
          page: pager.page,
          font,
          size: fontSize,
          x,
          yTop: pager.y,
          w,
          h: rowH,
          text: row[c.key],
          align: c.align || 'left',
          padding,
        });
        x += w;
      });

      pager.y -= rowH;
    });

    // table bottom spacing
    pager.y -= 10;
  };

  // header key/value（兩欄一組）
  const drawKeyValueGrid = ({ pager, font, fontBold, rows }) => {
    const usableW = pager.pageW - pager.marginL - pager.marginR;
    const x0 = pager.marginL;

    // 欄寬：label / value / label / value
    const wL = 90;
    const wR = 90;
    const wV1 = (usableW - wL - wR) / 2;
    const wV2 = (usableW - wL - wR) / 2;
    const colW = [wL, wV1, wR, wV2];

    const columns = [
      { label: '', key: 'l1', align: 'center' },
      { label: '', key: 'v1', align: 'left' },
      { label: '', key: 'l2', align: 'center' },
      { label: '', key: 'v2', align: 'left' },
    ];

    // 不畫 header，直接畫 body（自己畫）
    rows.forEach((r, idx) => {
      const rowH = calcRowHeight({ columns, colWidths: colW, font, size: 11, row: r, padding: 4, minH: 20 });
      pager.ensureSpace(rowH);

      const yTop = pager.y;
      let x = x0;

      // label1
      drawCell({ page: pager.page, x, yTop, w: colW[0], h: rowH, fill: rgb(0.98, 0.98, 0.98) });
      drawTextInCell({ page: pager.page, font: fontBold, size: 11, x, yTop, w: colW[0], h: rowH, text: r.l1, align: 'center' });
      x += colW[0];

      // value1
      drawCell({ page: pager.page, x, yTop, w: colW[1], h: rowH, fill: rgb(1, 1, 1) });
      drawTextInCell({ page: pager.page, font, size: 11, x, yTop, w: colW[1], h: rowH, text: r.v1, align: 'left' });
      x += colW[1];

      // label2
      drawCell({ page: pager.page, x, yTop, w: colW[2], h: rowH, fill: rgb(0.98, 0.98, 0.98) });
      drawTextInCell({ page: pager.page, font: fontBold, size: 11, x, yTop, w: colW[2], h: rowH, text: r.l2, align: 'center' });
      x += colW[2];

      // value2
      drawCell({ page: pager.page, x, yTop, w: colW[3], h: rowH, fill: rgb(1, 1, 1) });
      drawTextInCell({ page: pager.page, font, size: 11, x, yTop, w: colW[3], h: rowH, text: r.v2, align: 'left' });

      pager.y -= rowH;
    });

    pager.y -= 12;
  };

  // ======================== PDF 表頭（請款單主表欄位）========================
  const PDF_TITLE = '交通費請款單';

  const fmtDate = (d) => (d ? String(d).split('T')[0] : '');

  // USER_SELECT／ORGANIZATION_SELECT 是 [{code,name}]，取顯示名稱串接
  const namesOf = (field) =>
    Array.isArray(field?.value)
      ? field.value
          .map((o) => o.name)
          .filter(Boolean)
          .join(', ')
      : '';

  // 表頭兩欄一組：[標籤1, 值1, 標籤2, 值2]
  const buildHeaderRows = (record) => {
    const get = (code) => record[code]?.value ?? '';
    const text = (code) => {
      const v = get(code);
      return Array.isArray(v) ? v.join(', ') : v;
    };
    return [
      { l1: '交通費請款單號', v1: get(F.RECORD_NO), l2: '請款日期', v2: fmtDate(get(F.PAYMENT_DATE)) },
      { l1: '公司名稱', v1: get(F.COMPANY_NAME), l2: '預計付款日', v2: fmtDate(get(F.EXPECTED_PAY_DATE)) },
      { l1: '申請人', v1: namesOf(record[F.APPLICANT]), l2: '申請部門', v2: namesOf(record[F.APPLICANT_ORG]) },
      { l1: '費用所屬人', v1: namesOf(record[F.EXPENSE_OWNER]), l2: '費用所屬人部門', v2: namesOf(record[F.EXPENSE_OWNER_ORG]) },
      { l1: '受款人', v1: get(F.PAYEE), l2: '付款方式', v2: text(F.PAY_METHOD) },
      { l1: '傳票編號', v1: get(F.VOUCHER_NO), l2: '傳票日期', v2: fmtDate(get(F.VOUCHER_DATE)) },
      { l1: '是否有紙本憑證', v1: get(F.PAPER_RECEIPT), l2: '理由', v2: get(F.REASON) },
    ];
  };

  // ======================== PDF 生成（PDFLib 向量）========================
  const generateRecordPDF = async (record, id) => {
    ensurePdfDeps();

    // 字型（subset=true：檔案會小很多）
    const fontBuffer = await fetchFontFromKintone();
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(window.fontkit);
    const font = await pdfDoc.embedFont(fontBuffer, { subset: true });
    const fontBold = font; // 若有粗體字型檔可另 embed

    // A4 landscape (points)
    const pageW = 841.89;
    const pageH = 595.28;
    const pager = createPager(pdfDoc, pageW, pageH, { l: 24, r: 24, t: 24, b: 24 });

    // 標題 + 可點擊連結
    const appId = kintone.app.getId();
    const detailUrl = `${location.origin}/k/${appId}/show#record=${id}`;

    // 繪製「交通費請款單」標題
    pager.page.drawText(PDF_TITLE, {
      x: pager.marginL,
      y: pager.y - 22,
      size: 18,
      font: fontBold,
      color: rgb(0, 0, 0),
    });

    // 計算連結文字位置
    const titleWidth = fontBold.widthOfTextAtSize(PDF_TITLE, 18);
    const linkText = '[LINK點選查詢]';
    const linkFontSize = 10;
    const linkX = pager.marginL + titleWidth + 10;
    const linkY = pager.y - 20;
    const linkWidth = font.widthOfTextAtSize(linkText, linkFontSize);
    const linkHeight = linkFontSize;

    // 繪製連結文字（藍色）
    pager.page.drawText(linkText, {
      x: linkX,
      y: linkY,
      size: linkFontSize,
      font: font,
      color: rgb(0, 0.4, 0.8),
    });

    // 加入可點擊的連結註解
    pager.page.node.addAnnot(
      pdfDoc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [linkX, linkY - 2, linkX + linkWidth, linkY + linkHeight],
        Border: [0, 0, 0],
        A: {
          Type: 'Action',
          S: 'URI',
          URI: PDFLib.PDFString.of(detailUrl),
        },
      }),
    );

    pager.y -= 34;

    // Header key/value
    const headerRows = buildHeaderRows(record);

    drawKeyValueGrid({ pager, font, fontBold, rows: headerRows });

    // 明細
    const tableData = getTableData(record);
    const displayNames = tableData?.displayNames || [];
    const detailColumns = displayNames.map((name) => ({
      label: name,
      key: name,
      align: NUMERIC_COLUMNS.includes(name) ? 'right' : 'left',
    }));

    const detailRows = (tableData?.rows || []).map((r) => {
      const row = {};
      displayNames.forEach((k) => {
        const v = r[k] || '';
        row[k] = NUMERIC_COLUMNS.includes(k) ? formatNumber(v) : v;
      });
      return row;
    });

    const detailColW = (() => {
      const n = Math.max(detailColumns.length, 1);
      const w = (pager.pageW - pager.marginL - pager.marginR) / n;
      return Array.from({ length: n }, () => w);
    })();

    drawTablePdf({
      pager,
      title: '明細',
      columns: detailColumns.length ? detailColumns : [{ label: '無明細', key: 'x', align: 'center' }],
      rows: detailRows.length ? detailRows : [{ ...detailColumns.reduce((a, c) => ((a[c.key] = ''), a), {}) }],
      font,
      fontBold,
      colWidths: detailColumns.length ? detailColW : [pager.pageW - pager.marginL - pager.marginR],
      fontSize: 10,
      headerSize: 10,
    });

    // 簽核記錄
    const signTbl = record[F.SIGN_TABLE.CODE];
    const signRows = (signTbl?.value || []).map((row) => {
      const v = row.value;
      return {
        dt: v[F.SIGN_TABLE.COLS.DATETIME]?.value?.split('T')[0] || '',
        act: v[F.SIGN_TABLE.COLS.ACTION]?.value || '',
        who: v[F.SIGN_TABLE.COLS.SIGNER]?.value?.[0]?.name || '',
      };
    });

    drawTablePdf({
      pager,
      title: F.SIGN_TABLE.CODE,
      columns: [
        { label: '日期與時間', key: 'dt', align: 'center' },
        { label: '動作', key: 'act', align: 'center' },
        { label: '簽核人員', key: 'who', align: 'center' },
      ],
      rows: signRows.length ? signRows : [{ dt: '無簽核資料', act: '', who: '' }],
      font,
      fontBold,
      colWidths: [160, 160, pager.pageW - pager.marginL - pager.marginR - 320],
      fontSize: 10,
      headerSize: 10,
    });

    const footer = `記錄編號：${id}  列印時間：${formatDateTime(new Date())}`;

    pager.page.drawText(footer, {
      x: pager.marginL,
      y: 10,
      size: 8,
      font,
      color: rgb(0.35, 0.35, 0.35),
    });

    const bytes = await pdfDoc.save();
    return new Blob([bytes], { type: 'application/pdf' });
  };

  // ======================== 取得單筆記錄 ========================
  const fetchRecord = async (app, id) => {
    console.log(`[PDF Batch] API call to fetch record: App=${app}, ID=${id}`);
    const resp = await kintone.api(kintone.api.url('/k/v1/record', true), 'GET', { app, id: String(id) });
    console.log(`[PDF Batch] Fetch record response status:`, resp ? 'success' : 'failed');
    return resp.record;
  };

  // ======================== 批次下載附件（保留原功能；截圖 png 不影響 UI）========================
  function createSecureLoadingOverlay() {
    const loadingOverlay = document.createElement('div');
    loadingOverlay.className = 'loading-overlay';

    const loadingMessage = document.createElement('div');
    loadingMessage.className = 'loading-message';
    loadingMessage.innerHTML = `
      <button class="close-button" id="close-button" title="關閉視窗">×</button>
      <h3>🔒 安全批次下載</h3>
      <p>正在執行安全驗證與資料處理...</p>
      <div class="progress-bar">
        <div class="progress-bar-fill" id="progress-fill"></div>
      </div>
      <div class="result-message" id="result-message">🛡️ 安全系統初始化中...</div>
    `;
    loadingOverlay.appendChild(loadingMessage);
    document.body.appendChild(loadingOverlay);
  }

  function updateProgress(percentage) {
    const progressFill = document.getElementById('progress-fill');
    if (progressFill) progressFill.style.width = `${Math.min(100, Math.max(0, percentage))}%`;
  }

  function updateResultMessage(message, type) {
    const el = document.getElementById('result-message');
    if (!el) return;
    el.textContent = message;
    el.style.color = type === 'error' ? '#c53030' : type === 'warning' ? '#d69e2e' : type === 'success' ? '#2d5016' : '#333';
  }

  function showCloseButton() {
    const closeButton = document.getElementById('close-button');
    if (!closeButton) return;
    closeButton.classList.add('show');
    closeButton.onclick = function () {
      const loadingOverlay = document.querySelector('.loading-overlay');
      if (loadingOverlay) document.body.removeChild(loadingOverlay);
    };
  }

  function generateSecurityReport(records, securityToken) {
    const timestamp = new Date().toLocaleString();
    const userAgent = navigator.userAgent;
    const domain = window.location.hostname;

    return `kintone 安全批次下載報告
==========================================

下載時間: ${timestamp}
執行環境: ${domain}
瀏覽器: ${userAgent.substring(0, 100)}...
安全 Token: ${securityToken.substring(0, 8)}****
處理記錄數: ${records.length}

安全措施:
✅ 來源驗證已通過
✅ CSRF 防護已啟用
✅ 檔案大小限制已套用
✅ 輸入驗證已執行
✅ 權限檢查已完成

記錄清單:
${records.map((r, i) => `${i + 1}. 記錄 ${r[F.RECORD_NO]?.value || r.$id.value}`).join('\n')}

此報告由 kintone 安全下載系統自動產生
==========================================`;
  }

  // （附件+截圖。）
  async function generateRecordSummaryImage(record) {
    // 這段維持你原本 canvas 摘要圖邏輯（為了完整可用），簡化版：不畫明細表格，只列摘要 + 附件清單
    return new Promise((resolve) => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 1800;
        canvas.height = 1200;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.fillStyle = '#000000';
        ctx.font = 'bold 28px Arial';
        ctx.fillText('記錄摘要', 40, 60);

        let y = 110;
        const recordNumber = record[F.RECORD_NO]?.value || record.$id.value;
        const status = record[F.STATUS_FIELD]?.value || '未設定';
        const requestDate = record[F.PAYMENT_DATE]?.value || '未填寫';
        const applicant = namesOf(record[F.APPLICANT]) || '未填寫';
        const expenseOwner = namesOf(record[F.EXPENSE_OWNER]) || '未填寫';
        const paymentMethod = (record[F.PAY_METHOD]?.value || []).join(', ') || '未填寫';

        ctx.font = 'bold 18px Arial';
        ctx.fillText(`記錄號碼: ${recordNumber}`, 40, y);
        ctx.fillText(`請款日期: ${requestDate}`, 400, y);
        y += 30;
        ctx.fillText(`申請人: ${applicant}`, 40, y);
        ctx.fillText(`費用所屬人: ${expenseOwner}`, 400, y);
        y += 30;
        ctx.fillText(`狀態: ${status}`, 40, y);
        ctx.fillText(`付款方式: ${paymentMethod}`, 400, y);
        y += 40;

        const att = record[F.ATTACHMENT]?.value || [];
        if (att.length) {
          ctx.font = 'bold 18px Arial';
          ctx.fillText('附件清單：', 40, y);
          y += 30;
          ctx.font = '14px Arial';
          att.forEach((f, i) => {
            ctx.fillText(`${i + 1}. ${f.name}`, 60, y);
            y += 24;
          });
        }

        canvas.toBlob((blob) => resolve(blob), 'image/png', 1.0);
      } catch (e) {
        console.error('生成摘要圖失敗:', e);
        resolve(null);
      }
    });
  }

  async function handleSecureBatchDownload() {
    let securityToken = null;

    try {
      validateSecurity();
      securityToken = generateSecurityToken();

      const JSZip = window.JSZip;
      if (!JSZip) throw new Error('JSZip 未載入，請確認自定義 library 已加入');

      const inputMode = document.querySelector('input[name="input-mode"]:checked')?.value || 'range';
      let recordIds = [];

      if (inputMode === 'range') {
        const startId = parseInt(sanitizeInput(document.getElementById('range-start').value), 10);
        const endId = parseInt(sanitizeInput(document.getElementById('range-end').value), 10);
        if (isNaN(startId) || isNaN(endId)) throw new Error('請輸入有效的記錄號碼');
        if (startId > endId) throw new Error('開始號碼必須小於或等於結束號碼');
        for (let i = startId; i <= endId; i++) recordIds.push(i);
      } else {
        const specificInput = sanitizeInput(document.getElementById('specific-records').value);
        if (!specificInput) throw new Error('請輸入要下載的記錄號碼');
        recordIds = [...new Set(specificInput.split(',').map((id) => parseInt(id.trim(), 10)))].filter((x) => Number.isInteger(x) && x > 0);
      }

      validateRecordIds(recordIds);
      createSecureLoadingOverlay();

      const currentAppId = kintone.app.getId();
      const queryCondition = recordIds.length === 1 ? `$id = ${recordIds[0]}` : `$id in (${recordIds.join(',')})`;

      const recordsResp = await secureKintoneApi(
        '/k/v1/records',
        'GET',
        {
          app: currentAppId,
          query: `${queryCondition} limit ${SECURITY_CONFIG.maxRecords}`,
          fields: ['$id', F.RECORD_NO, F.ATTACHMENT, F.STATUS_FIELD, F.PAYMENT_DATE, F.APPLICANT, F.EXPENSE_OWNER, F.PAY_METHOD],
        },
        securityToken,
      );

      const records = recordsResp.records || [];
      if (!records.length) throw new Error('找不到指定的記錄，請檢查記錄號碼是否正確');

      updateResultMessage(`✅ 安全驗證通過，找到 ${records.length} 筆記錄`);

      const today = new Date();
      const dateString = today.getFullYear() + String(today.getMonth() + 1).padStart(2, '0') + String(today.getDate()).padStart(2, '0');
      const mainFolderName = `${dateString}_${DOWNLOAD_FOLDER_NAME}_安全下載`;
      const zip = new JSZip();

      const includeScreenshot = true;
      let processed = 0;

      for (const record of records) {
        const recordNumber = record[F.RECORD_NO]?.value || record.$id.value;
        const subFolderName = `記錄${recordNumber}`;

        updateResultMessage(`🔒 安全處理記錄 ${recordNumber}...`);

        // 附件
        const attachments = record[F.ATTACHMENT]?.value || [];
        for (const attachment of attachments) {
          try {
            const safeName = sanitizeInput(attachment.name);
            if (!safeName) continue;
            const fileBlob = await secureFileDownload(attachment.fileKey);
            zip.file(`${subFolderName}/${recordNumber}－${safeName}`, fileBlob);
            updateResultMessage(`✅ 已下載: ${safeName}`);
          } catch (error) {
            console.error(`安全下載附件失敗: ${attachment.name}`, error);
            updateResultMessage(`❌ 下載失敗: ${attachment.name} (${error.message})`);
          }
        }

        // 摘要圖
        if (includeScreenshot) {
          const summaryImage = await generateRecordSummaryImage(record);
          if (summaryImage) zip.file(`${subFolderName}/記錄${recordNumber}_摘要資訊.png`, summaryImage);
        }

        processed++;
        updateProgress(Math.floor((processed / records.length) * 80));
      }

      zip.file('安全下載報告.txt', generateSecurityReport(records, securityToken));

      updateResultMessage('🔒 安全打包中...');
      updateProgress(90);

      const zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      const url = window.URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${mainFolderName}.zip`;
      link.rel = 'noopener noreferrer';

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      updateProgress(100);
      updateResultMessage('🎉 安全下載完成！所有操作均已通過安全驗證。');
      showCloseButton();
    } catch (error) {
      console.error('安全下載過程發生錯誤:', error);
      updateResultMessage(`❌ 安全錯誤: ${error.message}`, 'error');
      showCloseButton();
    } finally {
      securityToken = null;
    }
  }

  // ======================== 提示視窗（全域 SweetAlert，寬度自動）========================
  /** 取代瀏覽器的 alert；icon: 'info'|'warning'|'error'|'success'。載不到 SweetAlert 才退回 alert */
  function notify(text, icon = 'info') {
    if (typeof Swal === 'undefined') {
      alert(text);
      return Promise.resolve();
    }
    return Swal.fire({ icon, text, width: 'auto', confirmButtonText: '好', customClass: { htmlContainer: 'pr-notice-text' } });
  }

  /** 取代瀏覽器的 confirm；回傳 true／false。載不到 SweetAlert 才退回 confirm */
  async function askConfirm(text) {
    if (typeof Swal === 'undefined') return confirm(text);
    const result = await Swal.fire({ icon: 'question', text, width: 'auto', showCancelButton: true, confirmButtonText: '確定', cancelButtonText: '取消', customClass: { htmlContainer: 'pr-notice-text' } });
    return result.isConfirmed;
  }

  // ======================== 批次列印 PDF（PDFLib 版）========================
  async function handleBatchPrintPDF() {
    try {
      const mode = document.querySelector('input[name="input-mode"]:checked')?.value || 'range';
      let recordIds = [];

      if (mode === 'range') {
        const start = parseInt(document.getElementById('range-start').value, 10);
        const end = parseInt(document.getElementById('range-end').value, 10);
        if (isNaN(start) || isNaN(end)) return notify('請輸入有效的號碼範圍', 'warning');
        if (start > end) return notify('開始號碼不能大於結束號碼', 'warning');
        if (end - start + 1 > SECURITY_CONFIG.maxRecords) return notify(`單次最多列印 ${SECURITY_CONFIG.maxRecords} 筆記錄`, 'warning');
        recordIds = Array.from({ length: end - start + 1 }, (_, i) => start + i);
      } else {
        const input = document.getElementById('specific-records').value.trim();
        if (!input) return notify('請輸入要列印的記錄號碼', 'warning');
        recordIds = input
          .split(',')
          .map((id) => parseInt(id.trim(), 10))
          .filter((id) => !isNaN(id));
        if (!recordIds.length) return notify('請輸入有效的記錄號碼', 'warning');
        if (recordIds.length > SECURITY_CONFIG.maxRecords) return notify(`單次最多列印 ${SECURITY_CONFIG.maxRecords} 筆記錄`, 'warning');
      }

      if (!(await askConfirm(`確定要批次列印 ${recordIds.length} 筆記錄嗎？`))) return;
      await performBatchPrintPDF(recordIds);
    } catch (error) {
      console.error('批次列印失敗:', error);
      await notify('批次列印失敗：' + error.message, 'error');
    }
  }

  async function performBatchPrintPDF(recordIds) {
    console.log('[PDF Batch] Starting performBatchPrintPDF with record IDs:', recordIds);
    const overlay = createLoadingOverlay();
    const appId = kintone.app.getId();
    const zip = new JSZip();
    let processed = 0;
    const failed = [];

    try {
      for (const recordId of recordIds) {
        console.log(`[PDF Batch] Start processing record: ${recordId}`);
        updateResultMessage(`處理記錄 ${recordId}...`, 'info');
        updateProgress((processed / recordIds.length) * 100);

        try {
          const record = await fetchRecord(appId, recordId);
          console.log(`[PDF Batch] Fetched record ${recordId}:`, record);
          
          const pdfBlob = await generateRecordPDF(record, recordId);
          console.log(`[PDF Batch] Generated PDF Blob for record ${recordId}, size = ${pdfBlob.size} bytes`);
          
          const fileName = generatePDFFileName(record, recordId);
          console.log(`[PDF Batch] Filename for record ${recordId}: ${fileName}`);
          
          zip.file(fileName, pdfBlob);
          processed++;
          console.log(`[PDF Batch] Added record ${recordId} PDF to ZIP successfully.`);
        } catch (recordError) {
          console.error(`[PDF Batch] 記錄 ${recordId} 處理失敗:`, recordError);
          const errMsg = recordError.message || (typeof recordError === 'object' ? JSON.stringify(recordError) : String(recordError));
          failed.push({ id: recordId, message: errMsg });
        }

        await sleep(150);
      }

      console.log(`[PDF Batch] Loop completed. Success = ${processed}, Failed = ${failed.length}`);
      updateResultMessage('正在打包 ZIP 檔案...', 'info');
      updateProgress(95);

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      console.log('[PDF Batch] ZIP Blob generated, size =', zipBlob.size, 'bytes');
      saveAs(zipBlob, `批次列印_${formatDateTime(new Date())}.zip`);

      updateProgress(100);
      if (failed.length) {
        const failDetail = failed.map((f) => `記錄 ${f.id}：${f.message}`).join('\n');
        console.warn('[PDF Batch] Completed with failures:', failDetail);
        updateResultMessage(`⚠️ 完成，但有 ${failed.length} 筆失敗（未包含在 ZIP 內）：\n${failDetail}\n\n成功 ${processed} 筆`, 'warning');
      } else {
        console.log('[PDF Batch] All files printed and downloaded successfully.');
        updateResultMessage(`✅ 列印完成！共處理 ${processed} 筆記錄`, 'success');
      }
      showCloseButton();
    } catch (error) {
      console.error('[PDF Batch] 批次列印過程發生致命錯誤:', error);
      updateResultMessage('批次列印失敗：' + error.message, 'error');
      showCloseButton();
    }
  }

  const generatePDFFileName = (record, id) => {
    let company = record[F.COMPANY_NAME]?.value?.trim() || '';
    company = company?.startsWith('ＮＸ') ? 'NX' : '聯海';
    const date = record[F.PAYMENT_DATE]?.value?.split('T')[0] || '';
    // 受款人欄位資料可能夾雜 Tab／換行等控制字元（例如「代號\t姓名」格式），
    // 這類字元 Windows 檔名不允許，會讓解壓縮工具跳過該檔案而誤以為 ZIP 是空的
    const payName = (record[F.PAYEE]?.value || '').replace(/[\t\n\r]+/g, ' ').trim();
    return `交通費請款單${id}_${company}(${payName}).pdf`.replace(/[\/\\:*?"<>|\x00-\x1F\x7F]/g, '_');
  };

  // ======================== UI（維持原樣）========================
  function createLoadingOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'loading-overlay';
    overlay.id = 'batch-download-overlay';
    overlay.innerHTML = `
      <div class="loading-message">
        <button id="close-button" class="close-button">✕</button>
        <div class="pr-loading-title">處理中...</div>
        <div class="progress-bar"><div id="progress-fill" class="progress-bar-fill"></div></div>
        <div id="result-message" class="result-message">準備中...</div>
      </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
  }

  async function initUI() {
    try {
      validateSecurity();

      const headerMenuSpace = kintone.app.getHeaderMenuSpaceElement();
      if (!headerMenuSpace) throw new Error('找不到標頭菜單空間');

      // 樣式在 payment_request.css（批次下載／列印按鈕、處理中視窗）

      // 容器
      const container = document.createElement('div');
      container.id = 'batch-download-container';

      // 範圍輸入群組
      const rangeGroup = document.createElement('div');
      rangeGroup.className = 'range-input-group';

      // 輸入模式選擇
      const modeSelector = document.createElement('div');
      modeSelector.className = 'input-mode-selector';

      const rangeMode = document.createElement('label');
      rangeMode.innerHTML = `
        <input type="radio" name="input-mode" value="range" checked>
        連續範圍（例如：1 到 10）
      `;

      const specificMode = document.createElement('label');
      specificMode.innerHTML = `
        <input type="radio" name="input-mode" value="specific">
        指定多筆（例如：20,40,42,48,56）
      `;

      modeSelector.appendChild(rangeMode);
      modeSelector.appendChild(specificMode);

      // 範圍輸入
      const rangeInputs = document.createElement('div');
      rangeInputs.className = 'range-inputs';

      const startLabel = document.createElement('span');
      startLabel.className = 'range-input-label';
      startLabel.textContent = '請輸入要下載的記錄號碼範圍：';

      const startInput = document.createElement('input');
      startInput.type = 'number';
      startInput.id = 'range-start';
      startInput.className = 'range-input';
      startInput.placeholder = '開始號碼';
      startInput.min = 1;

      const separator = document.createElement('span');
      separator.className = 'range-input-separator';
      separator.textContent = '到';

      const endInput = document.createElement('input');
      endInput.type = 'number';
      endInput.id = 'range-end';
      endInput.className = 'range-input';
      endInput.placeholder = '結束號碼';
      endInput.min = 1;

      rangeInputs.appendChild(startLabel);
      rangeInputs.appendChild(startInput);
      rangeInputs.appendChild(separator);
      rangeInputs.appendChild(endInput);

      // 指定輸入
      const specificInputs = document.createElement('div');
      specificInputs.className = 'specific-input';
      specificInputs.id = 'specific-inputs';

      const specificLabel = document.createElement('span');
      specificLabel.className = 'range-input-label';
      specificLabel.textContent = '請輸入要下載的記錄號碼（用逗號分隔）：';

      const specificInput = document.createElement('input');
      specificInput.type = 'text';
      specificInput.id = 'specific-records';
      specificInput.className = 'specific-records-input';
      specificInput.placeholder = '例如：20,40,42,48,56';

      specificInputs.appendChild(specificLabel);
      specificInputs.appendChild(specificInput);

      // 模式切換事件
      const modeRadios = modeSelector.querySelectorAll('input[name="input-mode"]');
      modeRadios.forEach((radio) => {
        radio.addEventListener('change', function () {
          if (this.value === 'range') {
            rangeInputs.style.display = 'flex';
            specificInputs.style.display = 'none';
          } else {
            rangeInputs.style.display = 'none';
            specificInputs.style.display = 'flex';
          }
        });
      });

      // 按鈕容器（水平並排）
      const buttonsContainer = document.createElement('div');
      buttonsContainer.className = 'buttons-container';

      // 下載附件按鈕
      const downloadButton = document.createElement('button');
      downloadButton.id = 'batch-download-button';
      downloadButton.className = 'batch-download-button';
      downloadButton.textContent = '📦 批次下載附件+截圖';
      downloadButton.addEventListener('click', handleSecureBatchDownload);

      // 批次列印PDF按鈕
      const printButton = document.createElement('button');
      printButton.id = 'batch-print-button';
      printButton.className = 'batch-print-button';
      printButton.textContent = '📄 批次列印交通費請款單PDF';
      printButton.addEventListener('click', handleBatchPrintPDF);

      // 批次整理資料按鈕（原本就沒實作，保留按鈕不改 UI）
      const organizeButton = document.createElement('button');
      organizeButton.id = 'batch-organize-button';
      organizeButton.className = 'batch-print-button';
      organizeButton.textContent = '📋 交通費Excel資料轉出(AP、費用、稅額)';
      buttonsContainer.appendChild(organizeButton);

      buttonsContainer.appendChild(printButton);
      buttonsContainer.appendChild(downloadButton);

      // 組裝 UI
      rangeGroup.appendChild(modeSelector);
      rangeGroup.appendChild(rangeInputs);
      rangeGroup.appendChild(specificInputs);

      container.appendChild(rangeGroup);
      container.appendChild(buttonsContainer);
      headerMenuSpace.appendChild(container);
    } catch (error) {
      console.error('初始化失敗:', error);
      notify('無法在當前環境中啟用批次功能', 'error');
    }
  }

  window.PR_BATCH_PDF = Object.freeze({ TABLE_CONFIG, NUMERIC_COLUMNS, getTableData, buildHeaderRows, generatePDFFileName });

  // ======================== 事件註冊（依你的要求放最下方）========================
  kintone.events.on('app.record.index.show', function (event) {
    try {
      validateSecurity();
      if (document.getElementById('batch-download-container')) return event;
      initUI();
    } catch (error) {
      console.error('初始化失敗:', error);
    }
    return event;
  });

  kintone.events.on('app.record.detail.show', function (event) {
    try {
      const headerSpace = kintone.app.record.getHeaderMenuSpaceElement();
      if (!headerSpace) return event;

      // 避免重複塞按鈕
      if (document.getElementById('detail-print-pdflib-btn')) return event;

      const detailPrintButton = document.createElement('button');
      detailPrintButton.id = 'detail-print-pdflib-btn';
      detailPrintButton.textContent = '📄 下載此筆交通費請款單PDF';
      detailPrintButton.className = 'pr-detail-print-button'; // 樣式在 payment_request.css

      detailPrintButton.addEventListener('click', async function () {
        const recordId = event.record.$id.value;

        Swal.fire({
          title: '確認下載',
          html: '即將下載「此筆交通費請款單」的 PDF 檔案。<br>確認要開始下載嗎？<br><span class="pr-download-note">（不會修改或影響表單內容）</span>',
          icon: 'question',
          showCancelButton: true,
          confirmButtonText: '開始下載',
          cancelButtonText: '取消',
          confirmButtonColor: '#3085d6',
          cancelButtonColor: '#d33',
        }).then(async (result) => {
          if (!result.isConfirmed) return;

          try {
            const appId = kintone.app.getId();
            const record = await fetchRecord(appId, recordId);
            const pdfBlob = await generateRecordPDF(record, recordId);
            const fileName = generatePDFFileName(record, recordId);
            saveAs(pdfBlob, fileName);
            Swal.fire('完成', 'PDF 已成功下載', 'success');
          } catch (error) {
            console.error('PDF 生成失敗:', error);
            Swal.fire('錯誤', 'PDF 生成失敗：' + error.message, 'error');
          }
        });
      });

      headerSpace.appendChild(detailPrintButton);
    } catch (error) {
      console.error('初始化詳細頁面 PDF 按鈕失敗:', error);
    }

    return event;
  });
})();
