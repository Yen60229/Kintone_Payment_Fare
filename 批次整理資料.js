// 批次整理資料 - 功能模組（index.show 專用）
// 列表頁「轉出 Excel」：選定的請款單，每一筆轉成 應付帳款／費用成本（／稅額）最多三列，全部放在同一張工作表。
// 欄位怎麼對應由「交通費轉出欄位對應」App（APPS.SAP_MAPPING）設定，一筆記錄＝Excel 的一欄。
(function () {
  'use strict';

  // ======================== 配置 ========================
  // 註：本模組存取之欄位（如 Excel欄位代碼、應付帳款_值等）為交通費轉出欄位對應 App（APPS.SAP_MAPPING）
  // 內部之對應設定欄位，非請款單主表 FIELDS，刻意保留字面值。
  const CONFIG = {
    mappingAppId: window.PR_CONFIG.APPS.SAP_MAPPING, // 交通費轉出欄位對應設定 App ID
  };

  const FIELDS = window.PR_CONFIG.FIELDS;
  const TABLE = FIELDS.TRAFFIC_TABLE; // 交通費明細子表格（樣板的 {交通費請款單.欄位} 取這張表的列）
  const TAX_COL = TABLE.COLS.TAX;
  const TOTAL_TAX = FIELDS.TOTAL_TAX; // 主表總稅額（CALC）：為 0 或空白就不轉出稅額列

  const SHEET_NAME = '交通費';
  const DEFAULT_DATE_FORMAT = 'YYYY/MM/DD';
  const DEFAULT_CELL_FORMAT = '一般';
  const MIN_COL_WIDTH = 12;

  // 每筆記錄依序轉出的列種類；稅額列只有總稅額不為 0 才轉出
  const ROW_KINDS = [
    { key: 'ap', valueField: '應付帳款_值', onlyWhenTax: false },
    { key: 'expense', valueField: '費用成本_值', onlyWhenTax: false },
    { key: 'tax', valueField: '稅額_值', onlyWhenTax: true },
  ];

  // ======================== 取得 UI 輸入的記錄範圍 ========================
  function getRecordIdsFromUI() {
    const inputMode = document.querySelector('input[name="input-mode"]:checked')?.value;
    let recordIds = [];

    if (inputMode === 'range') {
      const start = parseInt(document.getElementById('range-start')?.value, 10);
      const end = parseInt(document.getElementById('range-end')?.value, 10);
      if (!isNaN(start) && !isNaN(end) && start <= end) {
        for (let i = start; i <= end; i++) {
          recordIds.push(i);
        }
      }
    } else {
      const specificInput = document.getElementById('specific-records')?.value || '';
      recordIds = specificInput
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n) && n > 0);
    }

    return recordIds;
  }

  // ======================== 日期 ========================
  /** 取出日期的年月日（'YYYY-MM-DD…' 字串直接拆，不經時區換算）；不是日期回傳 null */
  function toYMD(date) {
    if (!date) return null;
    if (typeof date === 'string') {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
      if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
      date = new Date(date);
    }
    if (!(date instanceof Date) || isNaN(date.getTime())) return null;
    return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
  }

  function formatDate(date, format) {
    const ymd = toYMD(date);
    if (!ymd) return '';
    const y = String(ymd.y).padStart(4, '0');
    const m = String(ymd.m).padStart(2, '0');
    const d = String(ymd.d).padStart(2, '0');

    switch (format) {
      case 'YYYYMMDD':
        return `${y}${m}${d}`;
      case 'YYYY-MM-DD':
        return `${y}-${m}-${d}`;
      case 'YYYY/MM/DD':
      default:
        return `${y}/${m}/${d}`;
    }
  }

  /** 把 YYYY/MM/DD、YYYYMMDD、YYYY-MM-DD 的文字解析成 {y,m,d}；不是合法日期回傳 null */
  function parseDateText(text) {
    const m = /^(\d{4})([/-]?)(\d{2})\2(\d{2})$/.exec(String(text).trim());
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[3]);
    const d = Number(m[4]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return { y, m: mo, d };
  }

  /** Excel 日期序號（1900 日期系統） */
  function dateSerial(ymd) {
    return Math.round((Date.UTC(ymd.y, ymd.m - 1, ymd.d) - Date.UTC(1899, 11, 30)) / 86400000);
  }

  // ======================== 欄位字母 ↔ 欄索引 ========================
  /** 'A'→0、'Z'→25、'AA'→26；不是英文字母回傳 -1 */
  function columnIndex(letters) {
    const s = String(letters || '')
      .trim()
      .toUpperCase();
    if (!/^[A-Z]+$/.test(s)) return -1;
    let n = 0;
    for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  /** 0→'A'、26→'AA' */
  function columnLetters(index) {
    let n = index + 1;
    let s = '';
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  // ======================== 從設定 App 取得欄位對應 ========================
  /** 設定 App 的一筆記錄 → 一欄的對應設定 */
  function mapMappingRecord(record) {
    return {
      excelColumn: String(record['Excel欄位代碼']?.value || '').trim(),
      excelColumnName: record['Excel欄位說明']?.value || '',
      sortOrder: parseInt(record['排序']?.value, 10) || 0,
      應付帳款_值: record['應付帳款_值']?.value || '',
      費用成本_值: record['費用成本_值']?.value || '',
      稅額_值: record['稅額_值']?.value || '',
      dateFormat: record['日期格式']?.value || DEFAULT_DATE_FORMAT,
      cellFormat: record['儲存格格式']?.value || DEFAULT_CELL_FORMAT,
    };
  }

  async function fetchFieldMappings() {
    return new Promise((resolve, reject) => {
      kintone.api(
        kintone.api.url('/k/v1/records', true),
        'GET',
        {
          app: CONFIG.mappingAppId,
          query: '啟用 in ("啟用") order by 排序 asc limit 500',
        },
        (resp) => resolve(resp.records.map(mapMappingRecord)),
        (error) => {
          console.error('取得欄位對應設定失敗:', error);
          reject(error);
        },
      );
    });
  }

  // ======================== 從請款單 App 取得記錄 ========================
  async function fetchSourceRecords(recordIds) {
    const appId = kintone.app.getId();

    const allRecords = [];
    const batchSize = 100;

    for (let i = 0; i < recordIds.length; i += batchSize) {
      const batchIds = recordIds.slice(i, i + batchSize);
      const query = `$id in (${batchIds.join(',')})`;

      const resp = await new Promise((resolve, reject) => {
        kintone.api(
          kintone.api.url('/k/v1/records', true),
          'GET',
          {
            app: appId,
            query: query,
          },
          (resp) => resolve(resp),
          (error) => reject(error),
        );
      });

      allRecords.push(...resp.records);
    }

    const recordMap = {};
    allRecords.forEach((r) => {
      recordMap[r.$id.value] = r;
    });

    return recordIds.map((id) => recordMap[id]).filter((r) => r !== undefined);
  }

  // ======================== 欄位值轉文字 ========================
  /** kintone 欄位值 → 文字：人員／組織／群組取名稱、陣列用逗號串、日期照 dateFormat、空值回空字串 */
  function valueToText(value, dateFormat) {
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) {
      return value.map((v) => (v && typeof v === 'object' ? v.name || v.code || '' : String(v))).join(',');
    }
    if (typeof value === 'object') return value.name || value.code || '';
    // 只有整段是日期（DATE）或日期時間（DATETIME）才換格式；「2026-11-03 拜訪」這種文字照原樣
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(value)) return formatDate(value, dateFormat);
    return String(value);
  }

  // ======================== 篩選器（{欄位|數字|左5}） ========================
  /** 括號內：最後一組括號（半形或全形）裡的文字、去頭尾空白；沒有括號回原文 */
  function bracketInner(text) {
    const matches = [...String(text).matchAll(/[(（]([^()（）]*)[)）]/g)];
    if (matches.length === 0) return text;
    return matches[matches.length - 1][1].trim();
  }

  function applyFilters(text, filters) {
    let out = String(text);
    for (const raw of filters || []) {
      const f = String(raw).trim();
      const left = /^左(\d+)$/.exec(f);
      if (f === '數字') {
        out = out.replace(/\D/g, '');
      } else if (left) {
        out = Array.from(out).slice(0, Number(left[1])).join('');
      } else if (f === '括號內') {
        out = bracketInner(out);
      } else {
        console.warn('批次整理資料：不認得的篩選器', f);
      }
    }
    return out;
  }

  // ======================== 解析語法並取值 ========================
  // 語法（單層大括號，括號外的文字照用）：
  //   {欄位代碼}                 主表欄位
  //   {交通費請款單.欄位代碼}      明細列的欄位：應付帳款、費用成本列取第一列；稅額列取第一個稅額不為 0 的列（沒有就第一列）
  //   {序號}  {TODAY}  {$id}     資料列序號（標題下第一列＝1）、今天、記錄編號
  //   {欄位|數字|左5}            篩選器由左到右套用：數字（只留數字）、左N（前 N 個字）、括號內（最後一組括號裡的字）
  //   =A+B-C                    開頭是 = 時做加減（A、B、C 是 {…} 或數字），空白當 0，不能算回空字串
  // ctx = { record, kind, seq, today, dateFormat }；kind 是 ROW_KINDS 的 key（決定 {交通費請款單.欄位} 取哪一列）

  /** 明細列的稅額是否不為 0（空、0 都算 0） */
  function isNonZero(text) {
    const n = Number(String(text ?? '').replace(/,/g, '').trim());
    return Number.isFinite(n) && n !== 0;
  }

  /** 樣板的 {交通費請款單.欄位} 用哪一列：稅額列＝第一個稅額不為 0 的列（沒有就第一列），其他＝第一列；沒有明細回 null */
  function pickDetailRow(record, kind) {
    const rows = record?.[TABLE.CODE]?.value;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    if (kind === 'tax') return rows.find((r) => isNonZero(r?.value?.[TAX_COL]?.value)) || rows[0];
    return rows[0];
  }

  /** 單一 {…} 內的內容（不含大括號）→ 文字 */
  function resolveToken(expr, ctx) {
    const parts = String(expr).split('|');
    const name = parts[0].trim();
    const dateFormat = ctx.dateFormat || DEFAULT_DATE_FORMAT;
    const record = ctx.record || {};
    let text;

    if (name === 'TODAY') {
      text = formatDate(ctx.today || new Date(), dateFormat);
    } else if (name === '序號') {
      text = ctx.seq === undefined || ctx.seq === null ? '' : String(ctx.seq);
    } else if (name === '$id') {
      text = valueToText(record.$id?.value, dateFormat);
    } else if (name.includes('.')) {
      const dot = name.indexOf('.');
      const tableCode = name.slice(0, dot);
      const fieldCode = name.slice(dot + 1);
      const rows = record[tableCode]?.value;
      const row = tableCode === TABLE.CODE ? pickDetailRow(record, ctx.kind) : Array.isArray(rows) ? rows[0] : null;
      text = valueToText(row?.value?.[fieldCode]?.value, dateFormat);
    } else {
      text = valueToText(record[name]?.value, dateFormat);
    }

    return applyFilters(text, parts.slice(1));
  }

  /** 做加減：運算式只能有 {…}、數字、+、-。空白＝0；有無法當數字的值回 null */
  function evalArithmetic(expr, ctx) {
    const src = String(expr);
    const tokenRe = /\s*(?:(\{[^{}]*\})|(\d+(?:\.\d+)?)|([+-]))/y;
    const operands = [];
    let sign = 1;
    let expectOperand = true;
    let pos = 0;
    let result = 0;

    while (pos < src.length) {
      if (/^\s*$/.test(src.slice(pos))) break;
      tokenRe.lastIndex = pos;
      const m = tokenRe.exec(src);
      if (!m) return null;
      pos = tokenRe.lastIndex;

      if (m[3]) {
        if (expectOperand) {
          // 運算子連在一起（含開頭的正負號）：負號翻轉、正號略過
          if (m[3] === '-') sign = -sign;
        } else {
          sign = m[3] === '-' ? -1 : 1;
          expectOperand = true;
        }
        continue;
      }
      if (!expectOperand) return null; // 兩個運算元中間沒有運算子

      let n;
      if (m[1]) {
        const text = resolveToken(m[1].slice(1, -1), ctx).replace(/,/g, '').trim();
        n = text === '' ? 0 : Number(text);
      } else {
        n = Number(m[2]);
      }
      if (!Number.isFinite(n)) return null;
      operands.push(n);
      result += sign * n;
      sign = 1;
      expectOperand = false;
    }

    if (operands.length === 0 || expectOperand) return null;
    return Math.round(result * 1e10) / 1e10; // 去掉浮點誤差
  }

  /** 整段樣板 → 文字 */
  function parseTemplate(template, ctx) {
    if (template === undefined || template === null) return '';
    const text = String(template);
    if (text.trim() === '') return '';

    if (text.trim().startsWith('=')) {
      const n = evalArithmetic(text.trim().slice(1), ctx);
      if (n === null) {
        console.warn('批次整理資料：算式無法計算，欄位留空', text);
        return '';
      }
      return String(n);
    }

    // 用函式取代，避免欄位值裡的 $ 被當成取代語法
    return text.replace(/\{([^{}]*)\}/g, (_, expr) => resolveToken(expr, ctx));
  }

  // ======================== 列產生 ========================
  /**
   * 產生所有資料列。每筆記錄依序轉出 應付帳款、費用成本、（總稅額不為 0 才有的）稅額，沒有明細列的記錄也一樣轉出。
   * 回傳 rows：每列是和 mappings 同順序的 { value, format }（value 為文字）。today 可注入（測試用）。
   */
  function buildRows(mappings, records, today) {
    const now = today || new Date();
    const rows = [];

    for (const record of records) {
      for (const kind of ROW_KINDS) {
        if (kind.onlyWhenTax && !isNonZero(record[TOTAL_TAX]?.value)) continue;
        const seq = rows.length + 1;
        rows.push(
          mappings.map((m) => ({
            value: parseTemplate(m[kind.valueField] || '', { record, kind: kind.key, seq, today: now, dateFormat: m.dateFormat }),
            format: m.cellFormat || DEFAULT_CELL_FORMAT,
          })),
        );
      }
    }

    return rows;
  }

  // ======================== 儲存格型別 ========================
  const PLAIN_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

  /** 一個值依儲存格格式變成 SheetJS 儲存格；空值回 null（不建立儲存格） */
  function toCell(value, format) {
    const text = value === undefined || value === null ? '' : String(value);
    if (text === '') return null;

    if (format === '文字') return { t: 's', v: text, z: '@' };

    if (format === '數值') {
      const n = Number(text.replace(/,/g, '').trim());
      if (text.trim() === '' || !Number.isFinite(n)) return null;
      return { t: 'n', v: n, z: '#,##0' };
    }

    if (format === '日期') {
      const ymd = parseDateText(text);
      return ymd ? { t: 'n', v: dateSerial(ymd), z: 'yyyy/mm/dd' } : { t: 's', v: text };
    }

    // 一般：看起來是數字（沒有前導 0、15 位數以內）就存成數字，其餘是文字
    if (PLAIN_NUMBER.test(text) && text.replace(/\D/g, '').length <= 15) return { t: 'n', v: Number(text) };
    return { t: 's', v: text };
  }

  // ======================== 組成工作表 ========================
  /**
   * 第 1 列是標題（Excel欄位說明放在 Excel欄位代碼指的那一欄），其後是 buildRows 的資料列。
   * 回傳 SheetJS 工作表物件（不依賴 XLSX 全域）。
   */
  function buildSheet(mappings, rows) {
    const ws = {};
    const colIdx = mappings.map((m) => columnIndex(m.excelColumn));
    const widths = [];
    let maxCol = -1;

    mappings.forEach((m, i) => {
      const c = colIdx[i];
      if (c < 0) {
        console.warn('批次整理資料：Excel欄位代碼不是英文字母，略過', m.excelColumn);
        return;
      }
      maxCol = Math.max(maxCol, c);
      const header = String(m.excelColumnName || '');
      widths[c] = { wch: Math.max(header.length, MIN_COL_WIDTH) };
      if (header !== '') ws[`${columnLetters(c)}1`] = { t: 's', v: header };
    });

    rows.forEach((row, r) => {
      row.forEach((cell, i) => {
        const c = colIdx[i];
        if (c < 0) return;
        const built = toCell(cell.value, cell.format);
        if (built) ws[`${columnLetters(c)}${r + 2}`] = built;
      });
    });

    ws['!ref'] = maxCol < 0 ? 'A1' : `A1:${columnLetters(maxCol)}${rows.length + 1}`;
    ws['!cols'] = Array.from({ length: maxCol + 1 }, (_, c) => widths[c] || { wch: MIN_COL_WIDTH });
    return ws;
  }

  // ======================== 產生 Excel 並下載 ========================
  async function generateExcel(mappings, records) {
    if (typeof XLSX === 'undefined') {
      alert('錯誤：SheetJS 函式庫未載入，請確認已上傳 xlsx.full.min.js');
      return null;
    }

    const rows = buildRows(mappings, records, new Date());
    if (rows.length === 0) {
      alert('沒有可轉出的資料');
      return null;
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, buildSheet(mappings, rows), SHEET_NAME);

    const fileName = `交通費轉出_${formatDate(new Date(), 'YYYYMMDD')}.xlsx`;
    XLSX.writeFile(wb, fileName);

    console.log('Excel 檔案已產生:', fileName);
    return { fileName, rowCount: rows.length };
  }

  // ======================== 主要處理函數 ========================
  async function handleBatchOrganizeData() {
    try {
      const recordIds = getRecordIdsFromUI();
      if (recordIds.length === 0) {
        alert('請輸入有效的記錄號碼範圍');
        return;
      }

      if (!confirm(`即將處理 ${recordIds.length} 筆記錄，是否繼續？`)) {
        return;
      }

      console.log('處理記錄:', recordIds);

      // 1. 取得欄位對應設定
      console.log('正在取得欄位對應設定...');
      const mappings = await fetchFieldMappings();
      console.log('欄位對應設定:', mappings);

      if (mappings.length === 0) {
        alert('錯誤：未取得任何欄位對應設定');
        return;
      }

      // 2. 取得請款單記錄
      console.log('正在取得請款單記錄...');
      const records = await fetchSourceRecords(recordIds);
      console.log('請款單記錄:', records);

      if (records.length === 0) {
        alert('錯誤：未取得任何請款單記錄');
        return;
      }

      // 3. 產生 Excel
      console.log('正在產生 Excel...');
      const result = await generateExcel(mappings, records);
      if (!result) return;

      alert(`Excel 檔案已產生並下載\n檔名：${result.fileName}\n共 ${records.length} 筆記錄、${result.rowCount} 列資料`);
    } catch (error) {
      console.error('批次整理資料錯誤:', error);
      alert('處理過程發生錯誤: ' + error.message);
    }
  }

  // ======================== 等待按鈕出現並綁定 ========================
  function waitForButtonAndBind() {
    let attempts = 0;
    const maxAttempts = 50;

    const checkButton = setInterval(function () {
      attempts++;
      const btn = document.getElementById('batch-organize-button');

      if (btn && !btn.dataset.bindOrganize) {
        btn.addEventListener('click', handleBatchOrganizeData);
        btn.dataset.bindOrganize = 'true';
        console.log('批次整理資料按鈕綁定成功');
        clearInterval(checkButton);
      } else if (attempts >= maxAttempts) {
        console.log('找不到批次整理資料按鈕（可能無權限）');
        clearInterval(checkButton);
      }
    }, 100);
  }

  // ======================== 事件註冊 ========================
  window.PR_BATCH_ORGANIZE = Object.freeze({
    parseTemplate,
    resolveToken,
    applyFilters,
    evalArithmetic,
    valueToText,
    buildRows,
    buildSheet,
    generateExcel,
    toCell,
    mapMappingRecord,
    columnIndex,
    columnLetters,
    formatDate,
  });

  kintone.events.on('app.record.index.show', function (event) {
    waitForButtonAndBind();
    return event;
  });
})();
