// 批次填傳票／入帳完成 - 功能模組（index.show 專用；2026-11-18 從請購_庶務_轉請款單 搬來）
// 列表頁「🗂 批次動作 ▾」下拉選單的「📋 批次填傳票／入帳完成」選項（選單在 檔案批次 buildActionsMenu），開 SweetAlert2 視窗：
//   ① 列出「單位會計處理中」七個狀態、且登入者就是目前作業者的請款單（只有作業者本人能執行動作）
//   ① 開視窗時把列表頁上方已輸入的記錄範圍（連續範圍兩格／指定記錄）帶進「單據編號範圍」並自動勾選
//   ② 勾選後一次補填「傳票編號」「傳票日期」，並可同時執行流程動作「入帳完成」（狀態變成「請款流程結束」）
// 規則：
//   - 「會計課承辦註記是否收到單據紙本」＝未收到 → 只顯示、不能勾選
//   - 兩欄都已有值 → 可勾選，但不覆蓋，只執行入帳完成；只有一欄有值 → 只補空的那一欄
//   - 要補填的列存在時，傳票編號與傳票日期兩欄都必填；勾「同時執行入帳完成」時，每一列的傳票日期都必須是今年
//     （流程管理的「入帳完成」動作條件是 傳票日期＝今年）
//   - 先 PUT 欄位、再 PUT 流程狀態，各自每 100 筆一批；整批失敗就逐筆重試，收集每筆的錯誤
// 與請購庶務版的差異：交通費請款單沒有「類型」欄位，列表那一欄改顯示受款人；樣式在 payment_request.css（pr-bvs-*），JS 不注入樣式。
// 純函式（查詢、分類、驗證、組 payload、分批執行）全部掛在 window.PR_BATCH_VOUCHER，方便測試。
(function () {
  'use strict';

  const C = window.PR_CONFIG;
  const FIELDS = C.FIELDS;
  const BV = C.BATCH_VOUCHER;

  const F = Object.freeze({
    VOUCHER_NO: FIELDS.VOUCHER_NO,
    VOUCHER_DATE: FIELDS.VOUCHER_DATE,
    RECEIPT: FIELDS.PAPER_RECEIVED,
    STATUS: FIELDS.STATUS_FIELD,
    RECORD_NO: FIELDS.RECORD_NO,
    PAYEE: FIELDS.PAYEE,
    TOTAL: FIELDS.TOTAL_AMOUNT,
  });
  const DEFAULT_LABELS = Object.freeze({ no: F.VOUCHER_NO, date: F.VOUCHER_DATE });

  const BUTTON_TEXT = '📋 批次填傳票／入帳完成';
  const NS_FIELDS = [F.RECORD_NO, F.STATUS, F.PAYEE, F.TOTAL, F.VOUCHER_NO, F.VOUCHER_DATE, F.RECEIPT];

  const KIND = Object.freeze({
    LOCKED: 'locked', // 未收到紙本，不能勾
    ACTION_ONLY: 'actionOnly', // 兩欄都有值，只簽核
    FILL: 'fill', // 至少一欄要補
  });

  // ======================== 純函式 ========================
  const esc = (v) =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const fmtMoney = (v) => {
    const n = Number(v);
    return v === '' || v == null || !Number.isFinite(n) ? '' : n.toLocaleString('en-US');
  };

  const errMsg = (e) => {
    if (!e) return '未知錯誤';
    if (typeof e === 'string') return e;
    return e.message || (e.error && e.error.message) || JSON.stringify(e);
  };

  /** 提示視窗（SweetAlert；沒有才退回原生 alert） */
  function alertMsg(text, icon) {
    if (typeof window.Swal?.fire === 'function') return window.Swal.fire({ icon: icon || 'warning', text, width: 'auto', confirmButtonText: '確定' });
    alert(text);
    return Promise.resolve();
  }

  /** 查詢字串：七個狀態、作業者是登入者；lastId 有值就接著往後翻頁（$id 由大到小） */
  function buildQuery(lastId) {
    const statuses = BV.FROM_STATUSES.map((s) => `"${s}"`).join(',');
    const parts = [`${F.STATUS} in (${statuses})`, `${BV.ASSIGNEE_FIELD} in (LOGINUSER())`];
    if (lastId) parts.push(`$id < ${Number(lastId)}`);
    return `${parts.join(' and ')} order by $id desc limit ${BV.PAGE_LIMIT}`;
  }

  /** 把一筆 kintone 記錄整理成列表用的資料並分類 */
  function classifyRow(record) {
    const val = (code) => record?.[code]?.value ?? '';
    const id = String(record?.$id?.value ?? '');
    const recordNo = String(val(F.RECORD_NO) || id);
    const vno = String(val(F.VOUCHER_NO) || '').trim();
    const vdate = String(val(F.VOUCHER_DATE) || '');
    const needNo = !vno;
    const needDate = !vdate;
    let kind;
    if (val(F.RECEIPT) === C.OPTIONS.PAPER_RECEIVED.NOT_RECEIVED) kind = KIND.LOCKED;
    else if (!needNo && !needDate) kind = KIND.ACTION_ONLY;
    else kind = KIND.FILL;
    return {
      id,
      recordNo,
      status: String(val(F.STATUS)),
      payee: String(val(F.PAYEE)),
      total: val(F.TOTAL),
      vno,
      vdate,
      needNo: kind === KIND.FILL && needNo,
      needDate: kind === KIND.FILL && needDate,
      kind,
      selectable: kind !== KIND.LOCKED,
    };
  }

  function badgeOf(row) {
    if (row.kind === KIND.LOCKED) return '📄 未收到紙本';
    if (row.kind === KIND.ACTION_ONLY) return '已填・只簽核';
    if (row.needNo && row.needDate) return '補填：編號＋日期';
    return row.needNo ? '補填：編號' : '補填：日期';
  }

  /** 關鍵字比對（整列文字，不分大小寫） */
  function matchKeyword(row, keyword) {
    const kw = String(keyword || '').trim().toLowerCase();
    if (!kw) return true;
    const text = [row.recordNo, row.status, row.payee, fmtMoney(row.total), row.total, row.vno, row.vdate, badgeOf(row)].join(' ').toLowerCase();
    return text.includes(kw);
  }

  /** 解析「100-150, 160」；回傳 { segments:[[lo,hi]], invalid:[] } */
  function parseRanges(text) {
    const segments = [];
    const invalid = [];
    String(text || '')
      .split(/[,，、\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .forEach((tok) => {
        const parts = tok.split(/[-~～－—]+/).map((s) => s.trim());
        if (parts.length === 1 && /^\d+$/.test(parts[0])) {
          segments.push([Number(parts[0]), Number(parts[0])]);
        } else if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
          let lo = Number(parts[0]);
          let hi = Number(parts[1]);
          if (lo > hi) [lo, hi] = [hi, lo];
          segments.push([lo, hi]);
        } else {
          invalid.push(tok);
        }
      });
    return { segments, invalid };
  }

  /** 依記錄號碼範圍挑出可勾選的列；回傳 { ids, skippedLocked } */
  function pickByRanges(rows, segments) {
    const ids = [];
    let skippedLocked = 0;
    rows.forEach((r) => {
      const n = Number(r.recordNo);
      if (!Number.isInteger(n) || !segments.some(([lo, hi]) => n >= lo && n <= hi)) return;
      if (r.selectable) ids.push(r.id);
      else skippedLocked += 1;
    });
    return { ids, skippedLocked };
  }

  /**
   * 讀列表頁上方的記錄範圍（檔案批次模組建的輸入格），轉成本視窗「單據編號範圍」的文字。
   * 連續範圍：兩格都有數字 → "起-迄"（只填一格就只帶那一格）；指定記錄：原樣帶入逗號清單。
   * 沒輸入或找不到輸入格回傳 ''。doc 可注入（測試用）。
   */
  function readIndexRange(doc) {
    const d = doc || document;
    const valOf = (id) => String(d.getElementById(id)?.value ?? '').trim();
    const mode = d.querySelector('input[name="input-mode"]:checked')?.value || 'range';
    if (mode !== 'range') return valOf('specific-records');
    const start = valOf('range-start');
    const end = valOf('range-end');
    if (start && end) return `${start}-${end}`;
    return start || end;
  }

  /**
   * 驗證輸入。rows＝已勾選的列；opts＝{ voucherNo, voucherDate, doAction, year }
   * 回傳 { ok, errors:[字串], badRows:[recordNo] }
   */
  function validateInput(rows, opts) {
    const o = opts || {};
    const voucherNo = String(o.voucherNo || '').trim();
    const voucherDate = String(o.voucherDate || '').trim();
    const labels = o.labels || DEFAULT_LABELS;
    const errors = [];
    const badRows = [];
    if (!rows.length) return { ok: false, errors: ['請至少勾選一筆記錄'], badRows };
    const needFill = rows.some((r) => r.kind === KIND.FILL);
    if (!needFill && !o.doAction) {
      return { ok: false, errors: ['勾選的記錄都已填好，請勾選「同時執行入帳完成」，或改選需要補填的記錄'], badRows };
    }
    if (needFill) {
      if (!voucherNo) errors.push(`請輸入${labels.no}`);
      if (!voucherDate) errors.push(`請輸入${labels.date}`);
    }
    if (o.doAction) {
      const year = String(o.year);
      rows.forEach((r) => {
        const eff = r.vdate || voucherDate;
        if (!eff) return; // 已在上面回報缺日期
        if (!eff.startsWith(`${year}-`)) badRows.push(r.recordNo);
      });
      if (badRows.length) {
        errors.push(`執行入帳完成時，${labels.date}必須是 ${year} 年（流程條件）；以下記錄的日期不是今年：${badRows.join('、')}`);
      }
    }
    return { ok: errors.length === 0, errors, badRows };
  }

  /** 組欄位更新 payload：只補空欄位，絕不覆蓋既有值；不需補的列不產生 */
  function buildFillPayloads(rows, voucherNo, voucherDate) {
    const out = [];
    rows.forEach((r) => {
      if (r.kind !== KIND.FILL) return;
      const record = {};
      if (r.needNo) record[F.VOUCHER_NO] = { value: String(voucherNo).trim() };
      if (r.needDate) record[F.VOUCHER_DATE] = { value: voucherDate };
      if (Object.keys(record).length) out.push({ id: r.id, record });
    });
    return out;
  }

  const buildActionPayloads = (ids) => ids.map((id) => ({ id, action: BV.ACTION }));

  const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  /**
   * 分批執行：每批先整批送；整批失敗就逐筆重試，收集每筆錯誤。
   * send(items) 送一批、拋錯代表整批失敗；idOf(item) 取識別用的 id。
   * 回傳 { okIds:[], failed:[{id, message}] }
   */
  async function runChunked(items, size, send, idOf, onProgress) {
    const okIds = [];
    const failed = [];
    let done = 0;
    for (const part of chunk(items, size)) {
      try {
        await send(part);
        part.forEach((it) => okIds.push(idOf(it)));
        done += part.length;
        if (onProgress) onProgress(done);
      } catch (batchErr) {
        if (part.length === 1) {
          failed.push({ id: idOf(part[0]), message: errMsg(batchErr) });
          done += 1;
          if (onProgress) onProgress(done);
          continue;
        }
        for (const it of part) {
          try {
            await send([it]);
            okIds.push(idOf(it));
          } catch (e) {
            failed.push({ id: idOf(it), message: errMsg(e) });
          }
          done += 1;
          if (onProgress) onProgress(done);
        }
      }
    }
    return { okIds, failed };
  }

  /**
   * 完整執行：先填欄位、再入帳完成（欄位失敗的列不送動作）。
   * api(method, path, body) 可注入；appId 為目前 App。
   * 回傳 { filled, acted, failures:[{recordNo, step, message}] }
   */
  async function execute(api, appId, rows, opts, onProgress) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const noOf = (id) => byId.get(id)?.recordNo || id;
    const fills = buildFillPayloads(rows, opts.voucherNo, opts.voucherDate);
    const total = fills.length + (opts.doAction ? rows.length : 0);
    let base = 0;
    const report = (label) => (n) => onProgress && onProgress(base + n, total, label);
    const failures = [];

    const fillRes = await runChunked(
      fills,
      BV.CHUNK_SIZE,
      (part) => api('PUT', '/k/v1/records', { app: appId, records: part }),
      (p) => p.id,
      report('填入傳票欄位'),
    );
    fillRes.failed.forEach((f) => failures.push({ recordNo: noOf(f.id), step: '填入傳票', message: f.message }));
    base += fills.length;

    let acted = 0;
    if (opts.doAction) {
      const failedFill = new Set(fillRes.failed.map((f) => f.id));
      const targets = rows.filter((r) => !failedFill.has(r.id));
      base += failedFill.size; // 欄位失敗的列不送動作，進度視為已處理
      const actRes = await runChunked(
        buildActionPayloads(targets.map((r) => r.id)),
        BV.CHUNK_SIZE,
        (part) => api('PUT', '/k/v1/records/status', { app: appId, records: part }),
        (p) => p.id,
        report('執行入帳完成'),
      );
      acted = actRes.okIds.length;
      actRes.failed.forEach((f) => failures.push({ recordNo: noOf(f.id), step: '入帳完成', message: f.message }));
    }
    return { filled: fillRes.okIds.length, acted, failures };
  }

  // ======================== 資料讀取 ========================
  const kintoneApi = (method, path, body) => kintone.api(kintone.api.url(path, true), method, body);

  async function fetchRows(api, appId) {
    const rows = [];
    let lastId = null;
    for (;;) {
      const res = await api('GET', '/k/v1/records', { app: appId, query: buildQuery(lastId), fields: ['$id', ...NS_FIELDS] });
      res.records.forEach((r) => rows.push(classifyRow(r)));
      if (res.records.length < BV.PAGE_LIMIT) break;
      lastId = res.records[res.records.length - 1].$id.value;
    }
    return rows;
  }

  /** 畫面上的欄位標籤（取不到就用欄位代碼） */
  async function fetchLabels(api, appId) {
    try {
      const res = await api('GET', '/k/v1/app/form/fields', { app: appId });
      const p = res.properties || {};
      return { no: p[F.VOUCHER_NO]?.label || DEFAULT_LABELS.no, date: p[F.VOUCHER_DATE]?.label || DEFAULT_LABELS.date };
    } catch (e) {
      return { ...DEFAULT_LABELS };
    }
  }

  // ======================== 畫面（樣式在 payment_request.css 的 pr-bvs-*）========================
  function renderTable(rows, keyword, selected) {
    const visible = rows.filter((r) => matchKeyword(r, keyword));
    const body = visible
      .map((r) => {
        const badgeCls = r.kind === KIND.LOCKED ? 'pr-bvs-badge-locked' : r.kind === KIND.ACTION_ONLY ? 'pr-bvs-badge-only' : '';
        const check = r.selectable
          ? `<input type="checkbox" class="pr-bvs-cb" data-id="${esc(r.id)}"${selected.has(r.id) ? ' checked' : ''}>`
          : '🔒';
        const cls = !r.selectable ? 'pr-bvs-row-locked' : selected.has(r.id) ? 'pr-bvs-row-sel' : '';
        return `<tr class="${cls}"><td>${check}</td><td>${esc(r.recordNo)}</td><td>${esc(r.status)}</td><td class="pr-bvs-left">${esc(r.payee)}</td>
<td class="pr-bvs-num">${esc(fmtMoney(r.total))}</td><td class="pr-bvs-left">${esc(r.vno)}</td><td>${esc(r.vdate)}</td>
<td><span class="pr-bvs-badge ${badgeCls}">${esc(badgeOf(r))}</span></td></tr>`;
      })
      .join('');
    const empty = visible.length ? '' : '<tr><td colspan="8" class="pr-bvs-empty">沒有符合條件的記錄</td></tr>';
    return { visible, html: `<table class="pr-bvs-table"><thead><tr><th></th><th>交通費請款單號</th><th>狀態</th><th>受款人</th><th>總金額</th><th>傳票編號</th><th>傳票日期</th><th>備註</th></tr></thead><tbody>${body}${empty}</tbody></table>` };
  }

  function buildDialogHtml(labels) {
    return `<div class="pr-bvs-wrap">
<div class="pr-bvs-inputs">
  <div class="pr-bvs-field"><label for="bvs-no">${esc(labels.no)} <span class="pr-bvs-req">*</span></label><input id="bvs-no" type="text" maxlength="100"></div>
  <div class="pr-bvs-field"><label for="bvs-date">${esc(labels.date)} <span class="pr-bvs-req">*</span></label><input id="bvs-date" type="date"></div>
</div>
<label class="pr-bvs-opt"><input type="checkbox" id="bvs-action" checked> 同時執行入帳完成（狀態變成「${esc(BV.TARGET_STATUS)}」）</label>
<div class="pr-bvs-hint" id="bvs-hint"></div>
<div class="pr-bvs-bar"><input id="bvs-search" type="text" placeholder="🔍 搜尋單號、狀態、受款人、金額、傳票…">
  <span class="pr-bvs-link" id="bvs-all">全選</span><span class="pr-bvs-count" id="bvs-count"></span></div>
<div class="pr-bvs-range"><b class="pr-bvs-range-title">單據編號範圍</b><input id="bvs-range" type="text" placeholder="例：100-150, 160, 170-175">
  <button type="button" id="bvs-range-apply">套用範圍勾選</button><span class="pr-bvs-range-msg" id="bvs-range-msg"></span></div>
<div class="pr-bvs-tablewrap" id="bvs-table"></div></div>`;
  }

  const $ = (id) => document.getElementById(id);

  const progressHtml = () => '<progress class="pr-bvs-progress" id="bvs-bar" max="100" value="0"></progress><div class="pr-bvs-prog" id="bvs-prog"></div>';

  function summaryHtml(res, opts) {
    const lines = [`成功填入傳票：<b>${res.filled}</b> 筆`];
    if (opts.doAction) lines.push(`入帳完成：<b>${res.acted}</b> 筆`);
    let html = `<div class="pr-bvs-summary">${lines.join('<br>')}</div>`;
    if (res.failures.length) {
      const items = res.failures.map((f) => `<li>${esc(f.recordNo)}（${esc(f.step)}）：${esc(f.message)}</li>`).join('');
      html += `<div class="pr-bvs-fail-title"><b>失敗 ${res.failures.length} 筆：</b></div><ul class="pr-bvs-fail">${items}</ul>`;
    }
    return html;
  }

  async function openDialog() {
    const Swal = window.Swal;
    if (typeof Swal?.fire !== 'function') {
      alert('SweetAlert 尚未載入，請重新整理頁面後再試');
      return;
    }
    const appId = kintone.app.getId();
    Swal.fire({ title: '載入記錄中…', allowOutsideClick: false, showConfirmButton: false, didOpen: () => Swal.showLoading() });
    let rows;
    let labels;
    try {
      [rows, labels] = await Promise.all([fetchRows(kintoneApi, appId), fetchLabels(kintoneApi, appId)]);
    } catch (e) {
      await alertMsg(`讀取記錄失敗\n${errMsg(e)}`, 'error');
      return;
    }
    if (!rows.length) {
      await alertMsg(`目前沒有您可以執行「${BV.ACTION}」的記錄（狀態需為單位會計處理中，且您是目前的作帳人員）`, 'info');
      return;
    }

    const indexRange = readIndexRange(); // 列表頁上方已輸入的範圍，開視窗時帶入並自動勾選
    let keyword = '';
    let visibleRows = rows;
    const selected = new Set();
    const rowById = new Map(rows.map((r) => [r.id, r]));

    const refreshMeta = () => {
      const selectable = visibleRows.filter((r) => r.selectable);
      const allOn = selectable.length > 0 && selectable.every((r) => selected.has(r.id));
      $('bvs-all').textContent = allOn ? '取消全選' : '全選';
      const locked = visibleRows.length - selectable.length;
      $('bvs-count').textContent = `共 ${visibleRows.length} 筆，已選 ${selected.size} 筆${locked ? `（📄 ${locked} 筆未收到紙本）` : ''}`;
    };
    const rerender = () => {
      const t = renderTable(rows, keyword, selected);
      visibleRows = t.visible;
      $('bvs-table').innerHTML = t.html;
      document.querySelectorAll('.pr-bvs-cb').forEach((cb) =>
        cb.addEventListener('change', (e) => {
          const id = e.target.dataset.id;
          if (e.target.checked) selected.add(id);
          else selected.delete(id);
          e.target.closest('tr').classList.toggle('pr-bvs-row-sel', e.target.checked);
          refreshMeta();
        }),
      );
      refreshMeta();
    };
    const setRangeMsg = (msg, isErr) => {
      $('bvs-range-msg').textContent = msg;
      $('bvs-range-msg').classList.toggle('pr-bvs-err', !!isErr);
    };
    let applyRange = () => {};
    const bind = () => {
      $('bvs-search').addEventListener('input', (e) => {
        keyword = e.target.value;
        rerender();
      });
      $('bvs-all').addEventListener('click', () => {
        const selectable = visibleRows.filter((r) => r.selectable);
        const allOn = selectable.length > 0 && selectable.every((r) => selected.has(r.id));
        selectable.forEach((r) => (allOn ? selected.delete(r.id) : selected.add(r.id)));
        rerender();
      });
      applyRange = () => {
        const { segments, invalid } = parseRanges($('bvs-range').value);
        if (!segments.length) {
          setRangeMsg(invalid.length ? `無法解析：${invalid.join('、')}` : '請輸入範圍，例如 100-150, 160', true);
          return;
        }
        const { ids, skippedLocked } = pickByRanges(rows, segments);
        let added = 0;
        ids.forEach((id) => {
          if (!selected.has(id)) {
            selected.add(id);
            added += 1;
          }
        });
        rerender();
        const parts = [`新增 ${added} 筆`];
        if (skippedLocked) parts.push(`略過 ${skippedLocked} 筆未收到紙本`);
        if (invalid.length) parts.push(`無法解析：${invalid.join('、')}`);
        setRangeMsg(`✅ ${parts.join('，')}`, invalid.length > 0);
      };
      $('bvs-range-apply').addEventListener('click', applyRange);
      $('bvs-range').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          applyRange();
        }
      });
    };

    const result = await Swal.fire({
      title: BUTTON_TEXT,
      width: 'auto',
      html: buildDialogHtml(labels),
      showCancelButton: true,
      confirmButtonText: '確認執行',
      cancelButtonText: '取消',
      reverseButtons: true,
      allowOutsideClick: false,
      focusCancel: true,
      didOpen: () => {
        bind();
        rerender();
        if (indexRange) {
          $('bvs-range').value = indexRange;
          applyRange();
        }
      },
      preConfirm: () => {
        const input = {
          voucherNo: $('bvs-no').value.trim(),
          voucherDate: $('bvs-date').value.trim(),
          doAction: $('bvs-action').checked,
          year: new Date().getFullYear(),
          labels,
        };
        const chosen = [...selected].map((id) => rowById.get(id)).filter(Boolean);
        const v = validateInput(chosen, input);
        $('bvs-hint').textContent = v.ok ? '' : v.errors.join('\n');
        if (!v.ok) return false;
        return { input, chosen };
      },
    });
    if (!result.isConfirmed) return;

    const { input, chosen } = result.value;
    await Swal.fire({
      title: '執行中，請勿關閉視窗…',
      html: progressHtml(),
      allowOutsideClick: false,
      allowEscapeKey: false,
      showConfirmButton: false,
      didOpen: async () => {
        let res;
        try {
          res = await execute(kintoneApi, appId, chosen, input, (done, total, label) => {
            $('bvs-bar').value = total ? Math.round((done / total) * 100) : 100;
            $('bvs-prog').textContent = `${label}　${done} / ${total}`;
          });
        } catch (e) {
          res = { filled: 0, acted: 0, failures: [{ recordNo: '（全部）', step: '執行', message: errMsg(e) }] };
        }
        await Swal.fire({
          icon: res.failures.length ? 'warning' : 'success',
          title: res.failures.length ? '執行完成（部分失敗）' : '執行完成',
          html: summaryHtml(res, input),
          width: 'auto',
          confirmButtonText: '確定（重新整理列表）',
          allowOutsideClick: false,
        });
        location.reload();
      },
    });
  }

  // ======================== 對外介面（按鈕在「批次動作」下拉選單，見 檔案批次 buildActionsMenu）========================
  window.PR_BATCH_VOUCHER = Object.freeze({
    KIND,
    buildQuery,
    classifyRow,
    badgeOf,
    matchKeyword,
    parseRanges,
    pickByRanges,
    readIndexRange,
    validateInput,
    buildFillPayloads,
    buildActionPayloads,
    runChunked,
    execute,
    openDialog,
  });
})();
