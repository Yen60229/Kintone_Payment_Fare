(() => {
  'use strict';

  // =============================================================================
  // 員工匯款帳號主檔（APPS.EMPLOYEE_ACCOUNT）：Excel 匯入＋存檔去頭尾空白 —— 上傳到員工匯款帳號主檔，不是請款單
  //
  // 【上傳順序】員工匯款帳號主檔的 JavaScript（PC）：① SweetAlert2 ② SheetJS（XLSX）
  //   ③ payment_request_config.js（原始檔，自包含）④ 本檔。CSS（PC）：payment_request.css。手機版不用上傳。
  //
  // 一、存檔去頭尾空白（新增、編輯、列表直接編輯）：每個文字類欄位（單行／多行文字、連結、數值，含子表格）
  //     去掉頭尾空白（含全形空白、零寬字元），避免「00546 」和「00546」被當成不同值、唯一值檢查失效。
  // 二、列表頁「📥 匯入 Excel」：選檔 → 讀第一張工作表（第一列是標題，認欄位名稱或欄位代碼）→ 預覽視窗
  //     （每格都可修改、可取消勾選不匯入），每列標示 新增／更新／不變／錯誤 → 按「匯入」。
  //   - 所有值先去頭尾空白；員工編號是 1～4 位數字時補 0 到 5 碼（Excel 把 00546 存成數字 546 的情況）。
  //   - 用員工編號比對主檔：沒有的新增；已有的只更新「Excel 有填、且和主檔不同」的欄位（空白格不會清掉主檔的值）。
  //   - 錯誤（擋下匯入，可修正或取消勾選）：員工編號不是 5 碼數字、新增時中文姓名空白、檔案內員工編號重複、
  //     BP_CODE 檔案內重複或已屬於別的員工。
  //   - 每 100 筆一批寫入（新增 POST、更新 PUT 用員工編號當 updateKey）。新增記錄會照 App 的記錄通知設定發通知。
  // 事件走 PR_KT.on。
  // =============================================================================

  const C = window.PR_CONFIG;
  if (!C || !window.PR_KT) {
    console.error('員工帳號匯入：找不到 PR_CONFIG，請確認 payment_request_config.js 排在本檔前面');
    return;
  }

  const KT = window.PR_KT;
  const EA = C.REF_FIELDS.EMPLOYEE_ACCOUNT;
  const SUBMIT_EVENTS = ['app.record.create.submit', 'app.record.edit.submit', 'app.record.index.edit.submit'];
  const TRIM_TYPES = new Set(['SINGLE_LINE_TEXT', 'MULTI_LINE_TEXT', 'LINK', 'NUMBER']);
  const BUTTON_ID = 'pr-imp-button';
  const READ_PAGE = 500; // REST 讀取上限
  const WRITE_CHUNK = 100; // REST 寫入上限

  // 匯入欄位：key＝程式內名稱、field＝主檔欄位代碼、labels＝Excel 標題可用的寫法（另外也認欄位代碼）
  const COLUMNS = Object.freeze([
    { key: 'code', field: EA.CODE, title: '員工編號', labels: ['員工編號'] },
    { key: 'name', field: EA.NAME, title: '中文姓名', labels: ['中文姓名', '姓名'] },
    { key: 'bp', field: EA.BP_CODE, title: 'BP_CODE', labels: ['BP_CODE', 'BP CODE'] },
    { key: 'bank', field: EA.BANK_DETAIL_ID, title: 'BANK_DETAIL_ID', labels: ['BANK_DETAIL_ID', 'BANK DETAIL ID'] },
  ]);

  const KIND_TEXT = Object.freeze({ add: '新增', update: '更新', same: '不變', error: '錯誤', skip: '不匯入' });

  // ── 去頭尾空白 ───────────────────────────────────────────────────────────

  /** 去頭尾空白（含全形空白、零寬空白、BOM）；null／undefined 回空字串 */
  const clean = (value) =>
    String(value ?? '')
      .replace(/^[\s​﻿]+/, '')
      .replace(/[\s​﻿]+$/, '');

  /** 文字類欄位去頭尾空白（值有變才寫回）；回傳有沒有改 */
  const trimField = (field) => {
    if (!field || !TRIM_TYPES.has(field.type) || typeof field.value !== 'string') return false;
    const trimmed = clean(field.value);
    if (trimmed === field.value) return false;
    field.value = trimmed;
    return true;
  };

  /** 整筆記錄（含子表格）文字類欄位去頭尾空白，就地修改，回傳 record */
  const trimRecord = (record) => {
    Object.values(record || {}).forEach((field) => {
      if (field?.type === 'SUBTABLE' && Array.isArray(field.value)) {
        field.value.forEach((row) => Object.values(row?.value || {}).forEach(trimField));
      } else {
        trimField(field);
      }
    });
    return record;
  };

  // ── Excel 解析 ───────────────────────────────────────────────────────────

  /** 員工編號：去空白；1～4 位數字補 0 到 5 碼 */
  const normalizeCode = (value) => {
    const s = clean(value);
    return /^\d{1,4}$/.test(s) ? s.padStart(5, '0') : s;
  };

  const headerKey = (value) => clean(value).toLowerCase();

  /**
   * 工作表二維陣列 → { rows: [{ line, code, name, bp, bank }], error }。
   * 標題列＝第一個有「員工編號」欄的列；line＝Excel 列號（1 起算）；全部空白的列略過。
   */
  const parseSheetRows = (aoa) => {
    const lines = Array.isArray(aoa) ? aoa : [];
    const matchCol = (header, col) => {
      const k = headerKey(header);
      return k !== '' && [...col.labels, col.field].some((l) => headerKey(l) === k);
    };
    const headerIndex = lines.findIndex((row) => Array.isArray(row) && row.some((h) => matchCol(h, COLUMNS[0])));
    if (headerIndex < 0) return { rows: [], error: `找不到標題列：第一列要有「${COLUMNS[0].title}」欄` };
    const header = lines[headerIndex];
    const colIndex = {};
    COLUMNS.forEach((col) => {
      colIndex[col.key] = header.findIndex((h) => matchCol(h, col));
    });
    const rows = [];
    for (let i = headerIndex + 1; i < lines.length; i += 1) {
      const raw = Array.isArray(lines[i]) ? lines[i] : [];
      const row = { line: i + 1 };
      COLUMNS.forEach((col) => {
        const v = colIndex[col.key] >= 0 ? raw[colIndex[col.key]] : '';
        row[col.key] = col.key === 'code' ? normalizeCode(v) : clean(v);
      });
      if (COLUMNS.every((col) => row[col.key] === '')) continue;
      rows.push(row);
    }
    if (rows.length === 0) return { rows, error: '檔案裡沒有資料列' };
    return { rows, error: '' };
  };

  // ── 比對主檔 ─────────────────────────────────────────────────────────────

  /** 主檔記錄 → Map（員工編號 → { id, code, name, bp, bank }），值都先去空白 */
  const toExistingMap = (records) => {
    const map = new Map();
    (records || []).forEach((r) => {
      const code = clean(r?.[EA.CODE]?.value);
      if (code === '' || map.has(code)) return;
      map.set(code, { id: r?.$id?.value, code, name: clean(r?.[EA.NAME]?.value), bp: clean(r?.[EA.BP_CODE]?.value), bank: clean(r?.[EA.BANK_DETAIL_ID]?.value) });
    });
    return map;
  };

  /**
   * 每一列的處理方式：{ row, include, kind, errors, changes }。
   *   kind：add／update／same／error／skip（取消勾選）；changes＝更新時有變的欄位 key。
   * rows 的 include（預設 true）決定要不要匯入；只有勾選的列互相檢查重複。
   */
  const buildPlan = (rows, existing) => {
    const included = rows.filter((r) => r.include !== false);
    const countBy = (key) => {
      const m = new Map();
      included.forEach((r) => {
        if (r[key] !== '') m.set(r[key], (m.get(r[key]) || 0) + 1);
      });
      return m;
    };
    const codeCount = countBy('code');
    // BP_CODE：同一個 BP_CODE 只能屬於一個員工編號
    const bpCodes = new Map();
    included.forEach((r) => {
      if (r.bp === '') return;
      if (!bpCodes.has(r.bp)) bpCodes.set(r.bp, new Set());
      bpCodes.get(r.bp).add(r.code);
    });
    const bpOwner = new Map();
    existing.forEach((e) => {
      if (e.bp !== '') bpOwner.set(e.bp, e.code);
    });

    return rows.map((row) => {
      const include = row.include !== false;
      if (!include) return { row, include, kind: 'skip', errors: [], changes: [] };
      const errors = [];
      const old = existing.get(row.code);
      if (!/^\d{5}$/.test(row.code)) errors.push('員工編號要 5 碼數字');
      else if (codeCount.get(row.code) > 1) errors.push('檔案內員工編號重複');
      if (!old && row.name === '') errors.push('中文姓名必填');
      if (row.bp !== '') {
        if (bpCodes.get(row.bp)?.size > 1) errors.push('BP_CODE 檔案內重複');
        const owner = bpOwner.get(row.bp);
        if (owner && owner !== row.code) errors.push(`BP_CODE 已屬於員工編號 ${owner}`);
      }
      if (errors.length > 0) return { row, include, kind: 'error', errors, changes: [] };
      if (!old) return { row, include, kind: 'add', errors, changes: COLUMNS.map((c) => c.key).filter((k) => row[k] !== '') };
      const changes = COLUMNS.map((c) => c.key).filter((k) => k !== 'code' && row[k] !== '' && row[k] !== old[k]);
      return { row, include, kind: changes.length > 0 ? 'update' : 'same', errors, changes };
    });
  };

  /** 各狀態筆數 */
  const summarize = (plan) => {
    const out = { add: 0, update: 0, same: 0, error: 0, skip: 0 };
    plan.forEach((p) => {
      out[p.kind] += 1;
    });
    return out;
  };

  const summaryText = (plan) => {
    const s = summarize(plan);
    return `新增 ${s.add} 筆、更新 ${s.update} 筆、不變 ${s.same} 筆、錯誤 ${s.error} 筆、不匯入 ${s.skip} 筆`;
  };

  // ── 寫入 ─────────────────────────────────────────────────────────────────

  const chunk = (list, size) => {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  };

  /** 要寫入的資料：{ adds: [record], updates: [{ updateKey, record }] } */
  const buildWrites = (plan) => {
    const fieldsOf = (row, keys) => {
      const record = {};
      COLUMNS.filter((c) => keys.includes(c.key)).forEach((c) => {
        record[c.field] = { value: row[c.key] };
      });
      return record;
    };
    return {
      adds: plan.filter((p) => p.include && p.kind === 'add').map((p) => fieldsOf(p.row, p.changes)),
      updates: plan
        .filter((p) => p.include && p.kind === 'update')
        .map((p) => ({ updateKey: { field: EA.CODE, value: p.row.code }, record: fieldsOf(p.row, p.changes) })),
    };
  };

  /**
   * 每 100 筆一批寫入；回傳 { added, updated }。中途失敗丟出錯誤，err.done 記已完成的筆數。
   * @param {Function} api (path, method, params) => Promise
   */
  const runImport = async (plan, appId, api) => {
    const { adds, updates } = buildWrites(plan);
    const done = { added: 0, updated: 0 };
    try {
      for (const part of chunk(adds, WRITE_CHUNK)) {
        await api('/k/v1/records', 'POST', { app: appId, records: part });
        done.added += part.length;
      }
      for (const part of chunk(updates, WRITE_CHUNK)) {
        await api('/k/v1/records', 'PUT', { app: appId, records: part });
        done.updated += part.length;
      }
    } catch (err) {
      err.done = { ...done };
      throw err;
    }
    return done;
  };

  /** 讀主檔全部記錄（依 $id 翻頁） */
  const fetchAllAccounts = async (appId, api) => {
    const all = [];
    let lastId = 0;
    for (;;) {
      const resp = await api('/k/v1/records', 'GET', {
        app: appId,
        fields: ['$id', ...COLUMNS.map((c) => c.field)],
        query: `$id > ${lastId} order by $id asc limit ${READ_PAGE}`,
      });
      const records = resp?.records || [];
      all.push(...records);
      if (records.length < READ_PAGE) break;
      lastId = Number(records[records.length - 1].$id.value);
    }
    return all;
  };

  // ── 預覽視窗 ─────────────────────────────────────────────────────────────

  const escapeHtml = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const statusHtml = (p) => {
    const tip = p.errors.length > 0 ? `：${p.errors.join('；')}` : p.kind === 'update' ? `：${p.changes.map((k) => COLUMNS.find((c) => c.key === k).title).join('、')}` : '';
    return `${KIND_TEXT[p.kind]}${escapeHtml(tip)}`;
  };

  /** 預覽表格 HTML：每列一個勾選框＋狀態＋四個可修改的輸入框（data-row／data-key 對應 rows） */
  const buildPreviewHtml = (plan) => {
    const head = `<tr><th>匯入</th><th>Excel 列</th><th>狀態</th>${COLUMNS.map((c) => `<th>${escapeHtml(c.title)}</th>`).join('')}</tr>`;
    const body = plan
      .map((p, i) => {
        const cells = COLUMNS.map(
          (c) =>
            `<td><input type="text" class="pr-imp-input" data-row="${i}" data-key="${c.key}" value="${escapeHtml(p.row[c.key])}"></td>`,
        ).join('');
        return (
          `<tr class="pr-imp-row" data-row="${i}" data-kind="${p.kind}">` +
          `<td><input type="checkbox" class="pr-imp-include" data-row="${i}"${p.include ? ' checked' : ''}></td>` +
          `<td>${escapeHtml(p.row.line)}</td>` +
          `<td class="pr-imp-status" data-row="${i}">${statusHtml(p)}</td>` +
          cells +
          '</tr>'
        );
      })
      .join('');
    return (
      `<p class="pr-imp-summary">${escapeHtml(summaryText(plan))}</p>` +
      '<p class="pr-imp-hint">每格都可以修改（儲存前會去掉頭尾空白）；不想匯入的列取消勾選。已有的員工只更新有填、且不同的欄位，空白格不會清掉原本的值。</p>' +
      `<div class="pr-imp-table-wrap"><table class="pr-imp-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`
    );
  };

  /** 依目前 plan 更新畫面上的狀態欄、列的 data-kind、摘要（不重畫輸入框，游標不會跳走） */
  const refreshPreview = (popup, plan) => {
    const summary = popup.querySelector('.pr-imp-summary');
    if (summary) summary.textContent = summaryText(plan);
    plan.forEach((p, i) => {
      const status = popup.querySelector(`.pr-imp-status[data-row="${i}"]`);
      if (status) status.innerHTML = statusHtml(p);
      const tr = popup.querySelector(`.pr-imp-row[data-row="${i}"]`);
      if (tr) tr.dataset.kind = p.kind;
    });
  };

  const notify = (text, icon) => {
    if (typeof Swal === 'undefined') {
      alert(text);
      return Promise.resolve();
    }
    return Swal.fire({ icon, text, width: 'auto', confirmButtonText: '好', customClass: { htmlContainer: 'pr-notice-text' } });
  };

  const defaultApi = (path, method, params) => kintone.api(kintone.api.url(path, true), method, params);

  /**
   * 預覽＋匯入。回傳 { added, updated }；取消回 null。
   * @param {Array} rows parseSheetRows 的 rows
   * @param {Map} existing toExistingMap 的結果
   */
  const openPreview = async (rows, existing, appId, api = defaultApi) => {
    let plan = buildPlan(rows, existing);
    const result = await Swal.fire({
      title: '匯入員工匯款帳號（預覽）',
      html: buildPreviewHtml(plan),
      showCancelButton: true,
      confirmButtonText: '匯入',
      cancelButtonText: '取消',
      allowOutsideClick: false,
      showLoaderOnConfirm: true,
      customClass: { popup: 'pr-imp-popup' },
      didOpen: (popup) => {
        const recompute = () => {
          plan = buildPlan(rows, existing);
          refreshPreview(popup, plan);
        };
        popup.addEventListener('input', (e) => {
          const el = e.target;
          if (!el?.classList?.contains('pr-imp-input')) return;
          const row = rows[Number(el.dataset.row)];
          if (!row) return;
          row[el.dataset.key] = el.dataset.key === 'code' ? normalizeCode(el.value) : clean(el.value);
          recompute();
        });
        popup.addEventListener('change', (e) => {
          const el = e.target;
          if (!el?.classList?.contains('pr-imp-include')) return;
          const row = rows[Number(el.dataset.row)];
          if (!row) return;
          row.include = !!el.checked;
          recompute();
        });
      },
      preConfirm: async () => {
        plan = buildPlan(rows, existing);
        const bad = plan.filter((p) => p.kind === 'error');
        if (bad.length > 0) {
          const first = bad
            .slice(0, 3)
            .map((p) => `Excel 第 ${p.row.line} 列：${p.errors.join('；')}`)
            .join('\n');
          Swal.showValidationMessage(`還有 ${bad.length} 列有錯誤，請修正或取消勾選：\n${first}`);
          return false;
        }
        const s = summarize(plan);
        if (s.add + s.update === 0) {
          Swal.showValidationMessage('沒有要新增或更新的資料');
          return false;
        }
        try {
          return await runImport(plan, appId, api);
        } catch (err) {
          console.error('員工帳號匯入：寫入失敗', err);
          const d = err.done || { added: 0, updated: 0 };
          Swal.showValidationMessage(`匯入失敗：${err?.message || '請稍後再試'}（已完成新增 ${d.added} 筆、更新 ${d.updated} 筆）`);
          return false;
        }
      },
    });
    return result?.isConfirmed ? result.value : null;
  };

  /** 讀 Excel 檔（第一張工作表）→ 二維陣列；儲存格一律取顯示文字 */
  const readWorkbook = async (file) => {
    const data = await file.arrayBuffer();
    const wb = XLSX.read(data, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  };

  /** 選完檔案後的整個流程 */
  const importFile = async (file, api = defaultApi) => {
    const appId = KT.app().getId();
    let parsed;
    try {
      parsed = parseSheetRows(await readWorkbook(file));
    } catch (err) {
      console.error('員工帳號匯入：讀取 Excel 失敗', err);
      await notify('讀不到這個檔案，請確認是 Excel（.xlsx／.xls）或 CSV', 'error');
      return;
    }
    if (parsed.error) {
      await notify(parsed.error, 'warning');
      return;
    }
    Swal.fire({ title: '讀取主檔資料中…', allowOutsideClick: false, showConfirmButton: false, didOpen: () => Swal.showLoading() });
    let existing;
    try {
      existing = toExistingMap(await fetchAllAccounts(appId, api));
    } catch (err) {
      console.error('員工帳號匯入：讀取主檔失敗', err);
      await notify('讀取主檔資料失敗，請稍後再試', 'error');
      return;
    }
    const done = await openPreview(parsed.rows, existing, appId, api);
    if (!done) return;
    await notify(`匯入完成：新增 ${done.added} 筆、更新 ${done.updated} 筆`, 'success');
    location.reload();
  };

  /** 列表頁的「匯入 Excel」按鈕（已掛過就不重複掛） */
  const addImportButton = () => {
    if (document.getElementById(BUTTON_ID)) return;
    const space = KT.app().getHeaderMenuSpaceElement?.();
    if (!space) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xls,.csv';
    input.className = 'pr-imp-file';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = ''; // 同一個檔案可以再選一次
      if (file) importFile(file);
    });
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.className = 'pr-imp-btn';
    button.textContent = '📥 匯入 Excel';
    button.addEventListener('click', () => {
      if (typeof Swal === 'undefined' || typeof XLSX === 'undefined') {
        alert('匯入需要 SweetAlert2 與 SheetJS，請確認本 App 的 JavaScript 有上傳這兩個函式庫');
        return;
      }
      input.click();
    });
    space.appendChild(button);
    space.appendChild(input);
  };

  // ── 事件 ─────────────────────────────────────────────────────────────────

  KT.on(SUBMIT_EVENTS, (event) => {
    trimRecord(event.record);
    return event;
  });
  KT.on('app.record.index.show', (event) => {
    addImportButton();
    return event;
  });

  window.PR_EMPLOYEE_ACCOUNT_IMPORT = Object.freeze({
    clean,
    trimRecord,
    normalizeCode,
    parseSheetRows,
    toExistingMap,
    buildPlan,
    summarize,
    buildWrites,
    runImport,
    fetchAllAccounts,
    buildPreviewHtml,
    openPreview,
    COLUMNS,
  });
})();
