// 批次整理資料 - 功能模組（index.show 專用）
// 列表頁「轉出 Excel」：選定的請款單先依受款人排序、讓使用者確認每筆的轉出日期，
// 每一筆轉成 應付帳款 1 列＋費用成本（每個明細列各 1 列）＋稅額（稅額不為 0 的明細列各 1 列），全部放在同一張工作表。
// 欄位怎麼對應由「交通費轉出欄位對應」App（APPS.SAP_MAPPING）設定，一筆記錄＝Excel 的一欄。
(function () {
  'use strict';

  // ======================== 配置 ========================
  // 註：本模組存取之欄位（如 Excel欄位代碼、應付帳款_值等）為交通費轉出欄位對應 App（APPS.SAP_MAPPING）
  // 內部之對應設定欄位，非請款單主表 FIELDS，刻意保留字面值。
  const CONFIG = {
    mappingAppId: window.PR_CONFIG.APPS.SAP_MAPPING, // 交通費轉出欄位對應設定 App ID
    costCenterAppId: window.PR_CONFIG.APPS.COST_CENTER, // 費用歸屬主檔（查 Business Area）
  };

  const FIELDS = window.PR_CONFIG.FIELDS;
  const CC = window.PR_CONFIG.REF_FIELDS.COST_CENTER;
  const TABLE = FIELDS.TRAFFIC_TABLE; // 交通費明細子表格（樣板的 {交通費請款單.欄位} 取這張表的列）
  const TAX_COL = TABLE.COLS.TAX;

  const SHEET_NAME = '交通費';
  const DEFAULT_DATE_FORMAT = 'YYYY/MM/DD';
  const DEFAULT_CELL_FORMAT = '一般';
  const MIN_COL_WIDTH = 12;
  const PAYEE_KEY_LENGTH = 5; // 受款人排序／分組只看前 5 碼數字（同樣板的「數字|左5」）
  const COST_CENTER_PAGE = 500;

  // 三種列各自取設定 App 的哪個樣板欄位
  const VALUE_FIELD = { ap: '應付帳款_值', expense: '費用成本_值', tax: '稅額_值' };

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

  /** 上個月最後一天（'YYYY-MM-DD'），給日期視窗的「月帳」按鈕；不是日期回空字串 */
  function lastDayOfPrevMonth(date) {
    const ymd = toYMD(date);
    if (!ymd) return '';
    const d = new Date(Date.UTC(ymd.y, ymd.m - 1, 0)); // 這個月 0 號＝上個月最後一天
    return d.toISOString().slice(0, 10);
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

  // ======================== 從費用歸屬主檔取得 Business Area ========================
  /**
   * 費用歸屬主檔記錄 → Map（大寫去空白的 CostCenter 代碼 → Business Area）。
   * 同一代碼可能有好幾筆（不同所屬部門），取第一個有填 Business Area 的；代碼空白的略過。
   */
  function buildBusinessAreaMap(records) {
    const map = new Map();
    for (const r of records || []) {
      const code = String(r?.[CC.CODE]?.value ?? '')
        .trim()
        .toUpperCase();
      const area = String(r?.[CC.BUSINESS_AREA]?.value ?? '').trim();
      if (code === '' || area === '') continue;
      if (!map.has(code)) map.set(code, area);
    }
    return map;
  }

  /** 讀費用歸屬主檔全部記錄（每次 500 筆，用 offset 翻頁），回傳 buildBusinessAreaMap 的結果；失敗就拋出 */
  async function fetchBusinessAreaMap() {
    const all = [];
    for (let offset = 0; ; offset += COST_CENTER_PAGE) {
      const resp = await new Promise((resolve, reject) => {
        kintone.api(
          kintone.api.url('/k/v1/records', true),
          'GET',
          {
            app: CONFIG.costCenterAppId,
            fields: [CC.CODE, CC.BUSINESS_AREA],
            query: `order by $id asc limit ${COST_CENTER_PAGE} offset ${offset}`,
          },
          resolve,
          (error) => {
            console.error('取得費用歸屬 Business Area 失敗:', error);
            reject(error);
          },
        );
      });
      all.push(...resp.records);
      if (resp.records.length < COST_CENTER_PAGE) break;
    }
    return buildBusinessAreaMap(all);
  }

  // ======================== 依受款人排序 ========================
  /** 受款人的排序／分組鍵：受款人文字取數字、前 5 碼（沒有數字回空字串） */
  function payeeKey(record) {
    return String(record?.[FIELDS.PAYEE]?.value ?? '')
      .replace(/\D/g, '')
      .slice(0, PAYEE_KEY_LENGTH);
  }

  /** 依受款人鍵由小到大排（空白鍵排最後），鍵相同依記錄編號由小到大；回傳新陣列 */
  function sortRecordsByPayee(records) {
    const idOf = (r) => Number(r?.$id?.value);
    return [...records].sort((a, b) => {
      const ka = payeeKey(a);
      const kb = payeeKey(b);
      if (ka !== kb) {
        if (ka === '') return 1;
        if (kb === '') return -1;
        return ka < kb ? -1 : 1;
      }
      return idOf(a) - idOf(b);
    });
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

  /** Cost Center 代碼 → Business Area（ctx.businessArea 是 Map 或物件，鍵為大寫代碼）；查不到回空字串並警告 */
  function lookupBusinessArea(text, ctx) {
    const key = String(text).trim().toUpperCase();
    const src = ctx?.businessArea;
    let hit;
    if (src instanceof Map) hit = src.get(key);
    else if (src && Object.prototype.hasOwnProperty.call(src, key)) hit = src[key];
    if (hit) return String(hit);
    if (key !== '') console.warn('批次整理資料：查不到 Business Area', key);
    return '';
  }

  function applyFilters(text, filters, ctx) {
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
      } else if (f === 'BusinessArea') {
        out = lookupBusinessArea(out, ctx);
      } else {
        console.warn('批次整理資料：不認得的篩選器', f);
      }
    }
    return out;
  }

  // ======================== 解析語法並取值 ========================
  // 語法（單層大括號，括號外的文字照用）：
  //   {欄位代碼}                 主表欄位
  //   {交通費請款單.欄位代碼}      明細列的欄位：取 ctx.detailRow（應付帳款列＝第一列，費用成本、稅額列＝各自對應的那一列）；其他子表格取第一列
  //   {序號}  {TODAY}  {$id}     記錄序號（匯出順序第幾筆，同一筆記錄的每一列都一樣）、今天、記錄編號
  //   {轉出日期}                 該筆記錄在日期視窗選的日期（沒選就是今天），照欄位的日期格式輸出
  //   {欄位|數字|左5}            篩選器由左到右套用：數字（只留數字）、左N（前 N 個字）、括號內（最後一組括號裡的字）、
  //                              BusinessArea（把 Cost Center 代碼換成 Business Area，查不到留空）
  //   =A+B-C                    開頭是 = 時做加減（A、B、C 是 {…} 或數字），空白當 0，不能算回空字串
  // ctx = { record, detailRow, seq, today, exportDate, businessArea, dateFormat }

  /** 明細列的稅額是否不為 0（空、0 都算 0） */
  function isNonZero(text) {
    const n = Number(String(text ?? '').replace(/,/g, '').trim());
    return Number.isFinite(n) && n !== 0;
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
    } else if (name === '轉出日期') {
      text = formatDate(ctx.exportDate || ctx.today || new Date(), dateFormat);
    } else if (name === '序號') {
      text = ctx.seq === undefined || ctx.seq === null ? '' : String(ctx.seq);
    } else if (name === '$id') {
      text = valueToText(record.$id?.value, dateFormat);
    } else if (name.includes('.')) {
      const dot = name.indexOf('.');
      const tableCode = name.slice(0, dot);
      const fieldCode = name.slice(dot + 1);
      const rows = record[tableCode]?.value;
      const row = tableCode === TABLE.CODE && ctx.detailRow ? ctx.detailRow : Array.isArray(rows) ? rows[0] : null;
      text = valueToText(row?.value?.[fieldCode]?.value, dateFormat);
    } else {
      text = valueToText(record[name]?.value, dateFormat);
    }

    return applyFilters(text, parts.slice(1), ctx);
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
   * 產生所有資料列（records 已是最後順序）。每筆記錄依序轉出：
   *   應付帳款 1 列（{交通費請款單.欄位} 取第一個明細列）、費用成本（每個明細列各 1 列）、稅額（稅額不為 0 的明細列各 1 列）；
   *   沒有明細列就只有應付帳款。{序號} 是記錄在匯出裡的順序，同一筆記錄每列都一樣。
   * opts = { today, dates, businessArea }：today 今天（測試可注入）、dates 是 { 記錄編號: 'YYYY-MM-DD' } 的轉出日期、
   *   businessArea 是 buildBusinessAreaMap 的結果。回傳 rows：每列是和 mappings 同順序的 { value, format }（value 為文字）。
   */
  function buildRows(mappings, records, opts) {
    const { today, dates, businessArea } = opts || {};
    const now = today || new Date();
    const rows = [];

    records.forEach((record, i) => {
      const id = record.$id?.value;
      const exportDate = (id !== undefined && dates?.[id]) || now;
      const details = Array.isArray(record[TABLE.CODE]?.value) ? record[TABLE.CODE].value : [];
      const make = (kind, detailRow) =>
        mappings.map((m) => ({
          value: parseTemplate(m[VALUE_FIELD[kind]] || '', { record, detailRow, seq: i + 1, today: now, exportDate, businessArea, dateFormat: m.dateFormat }),
          format: m.cellFormat || DEFAULT_CELL_FORMAT,
        }));

      rows.push(make('ap', details[0]));
      details.forEach((d) => rows.push(make('expense', d)));
      details.filter((d) => isNonZero(d?.value?.[TAX_COL]?.value)).forEach((d) => rows.push(make('tax', d)));
    });

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
  /** opts 同 buildRows（today 不給就用現在） */
  async function generateExcel(mappings, records, opts) {
    if (typeof XLSX === 'undefined') {
      alert('錯誤：SheetJS 函式庫未載入，請確認已上傳 xlsx.full.min.js');
      return null;
    }

    const rows = buildRows(mappings, records, { today: new Date(), ...opts });
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

  // ======================== 轉出日期視窗 ========================
  const escapeHtml = (text) =>
    String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  /** 金額加千分位（#,##0）；不是數字就原樣 */
  function formatAmount(value) {
    const n = Number(String(value ?? '').replace(/,/g, '').trim());
    if (String(value ?? '').trim() === '' || !Number.isFinite(n)) return String(value ?? '');
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /**
   * 日期視窗的內容 HTML（records 已排好序）：上方「全部套用」，下方每筆記錄一列（受款人、單號、費用所屬人、總金額、日期）。
   * 受款人只在同一組（受款人鍵相同）的第一列顯示，該列加 pr-export-row--group-start 讓 CSS 畫分隔線。所有值都做 HTML 跳脫。
   */
  function buildDateDialogHtml(records, todayText) {
    const today = escapeHtml(todayText);
    const monthEnd = escapeHtml(lastDayOfPrevMonth(todayText)); // 「月帳」按鈕帶入的日期
    let prevKey = null;
    const body = records
      .map((r, i) => {
        const key = payeeKey(r);
        const first = i === 0 || key !== prevKey;
        prevKey = key;
        const rowClass = first ? 'pr-export-row pr-export-row--group-start' : 'pr-export-row';
        const payee = first ? escapeHtml(key || '—') : '';
        const no = escapeHtml(valueToText(r[FIELDS.RECORD_NO]?.value));
        const owner = escapeHtml(bracketInner(valueToText(r[FIELDS.EXPENSE_OWNER]?.value)));
        const total = escapeHtml(formatAmount(r[FIELDS.TOTAL_AMOUNT]?.value));
        const id = escapeHtml(r.$id?.value);
        return (
          `<tr class="${rowClass}">` +
          `<td class="pr-export__payee" data-label="受款人">${payee}</td>` +
          `<td data-label="單號">${no}</td>` +
          `<td data-label="費用所屬人">${owner}</td>` +
          `<td class="pr-export__num" data-label="總金額">${total}</td>` +
          `<td class="pr-export__date-cell" data-label="轉出日期"><input type="date" class="pr-export__date" data-record-id="${id}" value="${today}">` +
          `<button type="button" class="pr-export__month-btn" data-date="${monthEnd}" title="帶入上個月最後一天">月帳</button></td>` +
          '</tr>'
        );
      })
      .join('');

    return (
      '<div class="pr-export">' +
      '<div class="pr-export__bulk">' +
      '<span class="pr-export__bulk-label">轉出日期</span>' +
      `<input type="date" class="pr-export__date pr-export__bulk-date" value="${today}">` +
      '<button type="button" class="pr-export__bulk-btn">全部套用</button>' +
      '</div>' +
      '<div class="pr-export__scroll"><table class="pr-export__table">' +
      '<thead><tr><th>受款人</th><th>單號</th><th>費用所屬人</th><th class="pr-export__num">總金額</th><th>轉出日期</th></tr></thead>' +
      `<tbody>${body}</tbody>` +
      '</table></div>' +
      '</div>'
    );
  }

  /**
   * 跳「轉出交通費 Excel」視窗讓使用者確認每筆的轉出日期（預設今天）。
   * 回傳 { 記錄編號: 'YYYY-MM-DD' }；按取消回傳 null；Swal 沒載入就全部用今天、不跳視窗。
   */
  async function askExportDates(records, todayText) {
    if (typeof Swal === 'undefined') {
      return Object.fromEntries(records.map((r) => [r.$id.value, todayText]));
    }

    const result = await Swal.fire({
      title: '轉出交通費 Excel',
      html: buildDateDialogHtml(records, todayText),
      showCancelButton: true,
      confirmButtonText: '轉出 Excel',
      cancelButtonText: '取消',
      reverseButtons: true,
      focusConfirm: false,
      allowOutsideClick: false,
      buttonsStyling: false,
      customClass: {
        popup: 'pr-signer-popup pr-export-popup',
        title: 'pr-signer-popup__title',
        htmlContainer: 'pr-signer-popup__body',
        actions: 'pr-signer-popup__actions',
        confirmButton: 'pr-signer-btn pr-signer-btn--primary',
        cancelButton: 'pr-signer-btn pr-signer-btn--ghost',
        validationMessage: 'pr-signer-popup__message',
      },
      didOpen: (popup) => {
        const bulkDate = popup.querySelector('.pr-export__bulk-date');
        popup.querySelector('.pr-export__bulk-btn')?.addEventListener('click', () => {
          if (!bulkDate?.value) return;
          popup.querySelectorAll('.pr-export__date[data-record-id]').forEach((input) => {
            input.value = bulkDate.value;
          });
        });
        // 「月帳」：同一列的日期改成上個月最後一天
        popup.querySelectorAll('.pr-export__month-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            const input = btn.parentElement?.querySelector('.pr-export__date');
            if (input && btn.dataset.date) input.value = btn.dataset.date;
          });
        });
      },
      preConfirm: () => {
        const dates = {};
        for (const input of Swal.getPopup().querySelectorAll('.pr-export__date[data-record-id]')) {
          const v = input.value;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !parseDateText(v)) {
            Swal.showValidationMessage('請填寫每一筆的日期');
            return false;
          }
          dates[input.dataset.recordId] = v;
        }
        return dates;
      },
    });

    return result.isConfirmed ? result.value : null;
  }

  // ======================== 主要處理函數 ========================
  async function handleBatchOrganizeData() {
    try {
      const recordIds = getRecordIdsFromUI();
      if (recordIds.length === 0) {
        alert('請輸入有效的記錄號碼範圍');
        return;
      }

      console.log('處理記錄:', recordIds);

      // 1. 一按就跳「請稍後」，同時讀欄位對應設定、請款單記錄、Business Area 對照（費用歸屬 → Business Area）
      showLoading();
      const [mappings, records, businessArea] = await Promise.all([fetchFieldMappings(), fetchSourceRecords(recordIds), fetchBusinessAreaMap()]);
      console.log('欄位對應設定:', mappings);
      console.log('請款單記錄:', records);

      if (mappings.length === 0) {
        closeLoading();
        alert('錯誤：未取得任何欄位對應設定');
        return;
      }
      if (records.length === 0) {
        closeLoading();
        alert('錯誤：未取得任何請款單記錄');
        return;
      }

      // 2. 依受款人排序，讓使用者確認每筆的轉出日期（日期視窗直接取代「請稍後」）
      const sorted = sortRecordsByPayee(records);
      const dates = await askExportDates(sorted, formatDate(new Date(), 'YYYY-MM-DD'));
      if (!dates) return;

      // 3. 產生 Excel
      console.log('正在產生 Excel...');
      const result = await generateExcel(mappings, sorted, { dates, businessArea });
      if (!result) return;

      alert(`Excel 檔案已產生並下載\n檔名：${result.fileName}\n共 ${records.length} 筆記錄、${result.rowCount} 列資料`);
    } catch (error) {
      closeLoading();
      console.error('批次整理資料錯誤:', error);
      alert('處理過程發生錯誤: ' + error.message);
    }
  }

  // ======================== 「請稍後」小視窗 ========================
  /** 讀資料時的轉圈小視窗；之後的 Swal.fire（日期視窗）會直接取代它。沒有 Swal 就不顯示 */
  function showLoading() {
    if (typeof Swal === 'undefined') return;
    Swal.fire({
      title: '請稍後',
      text: '正在讀取資料…',
      allowOutsideClick: false,
      allowEscapeKey: false,
      showConfirmButton: false,
      customClass: { popup: 'pr-export-loading' },
      didOpen: () => Swal.showLoading(),
    });
  }

  function closeLoading() {
    if (typeof Swal !== 'undefined') Swal.close();
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
    payeeKey,
    sortRecordsByPayee,
    buildBusinessAreaMap,
    buildDateDialogHtml,
    lastDayOfPrevMonth,
    showLoading,
    closeLoading,
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
