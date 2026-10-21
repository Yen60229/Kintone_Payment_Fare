// 批次整理資料 - 功能模組（index.show 專用）
(function () {
  'use strict';

  // ======================== 配置 ========================
  // 註：本模組存取之欄位（如 Excel欄位代碼、應付帳款_值等）為 SAP轉檔欄位對應 App（APPS.SAP_MAPPING）
  // 內部之對應設定欄位，非請款單主表 FIELDS，刻意保留字面值。
  const CONFIG = {
    mappingAppId: window.PR_CONFIG.APPS.SAP_MAPPING, // SAP轉檔欄位對應設定 App ID
  };

  // ======================== 工作表名稱與對應欄位 ========================
  const SHEETS = [
    { name: '應付帳款', valueField: '應付帳款_值' },
    { name: '費用.成本', valueField: '費用成本_值' },
    { name: '稅額', valueField: '稅額_值' },
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

  // ======================== 日期格式化 ========================
  function formatDate(date, format) {
    if (!date) return '';

    if (typeof date === 'string') {
      date = new Date(date);
    }

    if (isNaN(date.getTime())) return '';

    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');

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

  // ======================== 從設定 App 取得欄位對應 ========================
  async function fetchFieldMappings() {
    return new Promise((resolve, reject) => {
      kintone.api(
        kintone.api.url('/k/v1/records', true),
        'GET',
        {
          app: CONFIG.mappingAppId,
          query: '啟用 in ("啟用") order by 排序 asc limit 500',
        },
        (resp) => {
          const mappings = resp.records.map((record) => ({
            excelColumn: record['Excel欄位代碼']?.value || '',
            excelColumnName: record['Excel欄位說明']?.value || '',
            sortOrder: parseInt(record['排序']?.value, 10) || 0,
            應付帳款_值: record['應付帳款_值']?.value || '',
            費用成本_值: record['費用成本_值']?.value || '',
            稅額_值: record['稅額_值']?.value || '',
          }));
          resolve(mappings);
        },
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
      recordMap[r['$id'].value] = r;
    });

    return recordIds.map((id) => recordMap[id]).filter((r) => r !== undefined);
  }

  // ======================== 解析語法並取值 ========================
  // 語法：{{欄位代碼}}、{{子表格.欄位代碼}}（取第一列）、{{$id}}、{{TODAY}} 或 {{TODAY:格式}}；沒有 {{ }} 的原文照用
  function parseValue(syntax, record) {
    if (!syntax || syntax.trim() === '') {
      return '';
    }

    // 檢查是否包含 {{ }}
    if (!syntax.includes('{{')) {
      return syntax;
    }

    // 用函式取代，避免欄位值裡的 $ 被當成取代語法
    return syntax.replace(/\{\{([^}]+)\}\}/g, (_, fieldExpr) => resolveFieldValue(fieldExpr, record));
  }

  // ======================== 解析單一欄位表達式 ========================
  function resolveFieldValue(fieldExpr, record) {
    if (fieldExpr.startsWith('TODAY')) {
      const parts = fieldExpr.split(':');
      const format = parts[1] || 'YYYY/MM/DD';
      return formatDate(new Date(), format);
    }

    if (fieldExpr === '$id') {
      return record['$id']?.value || '';
    }

    if (fieldExpr.includes('.')) {
      const [tableName, fieldCode] = fieldExpr.split('.');
      const tableData = record[tableName]?.value;

      if (Array.isArray(tableData) && tableData.length > 0) {
        const firstRow = tableData[0];
        return firstRow.value?.[fieldCode]?.value || '';
      }
      return '';
    }

    const fieldValue = record[fieldExpr]?.value;

    if (fieldValue === undefined || fieldValue === null) {
      return '';
    }

    if (Array.isArray(fieldValue)) {
      return fieldValue.join(',');
    }

    if (typeof fieldValue === 'string' && fieldValue.match(/^\d{4}-\d{2}-\d{2}/)) {
      return formatDate(new Date(fieldValue), 'YYYY/MM/DD');
    }

    return String(fieldValue);
  }

  // ======================== 產生 Excel 並下載 ========================
  async function generateExcel(mappings, records) {
    if (typeof XLSX === 'undefined') {
      alert('錯誤：SheetJS 函式庫未載入，請確認已上傳 xlsx.full.min.js');
      return;
    }

    const wb = XLSX.utils.book_new();

    for (const sheet of SHEETS) {
      const { name, valueField } = sheet;

      const row1 = mappings.map((m) => m.excelColumn);
      const row2 = mappings.map((m) => m.excelColumnName);
      const wsData = [row1, row2];

      // 處理每筆記錄
      for (const record of records) {
        const rowData = [];

        for (const m of mappings) {
          rowData.push(parseValue(m[valueField] || '', record));
        }

        wsData.push(rowData);
      }

      const ws = XLSX.utils.aoa_to_sheet(wsData);

      const colWidths = row1.map((col, idx) => ({
        wch: Math.max(String(row1[idx] || '').length, String(row2[idx] || '').length, 15),
      }));
      ws['!cols'] = colWidths;

      XLSX.utils.book_append_sheet(wb, ws, name);
    }

    const timestamp = formatDate(new Date(), 'YYYYMMDD');
    const fileName = `SAP轉檔_${timestamp}.xlsx`;

    XLSX.writeFile(wb, fileName);

    console.log('Excel 檔案已產生:', fileName);
    return fileName;
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
      const fileName = await generateExcel(mappings, records);

      alert(`Excel 檔案已產生並下載\n檔名：${fileName}\n共 ${records.length} 筆記錄`);
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
  window.PR_BATCH_ORGANIZE = Object.freeze({ parseValue, resolveFieldValue, formatDate });

  kintone.events.on('app.record.index.show', function (event) {
    waitForButtonAndBind();
    return event;
  });
})();
