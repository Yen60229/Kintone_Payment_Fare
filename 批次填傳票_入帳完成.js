// 批次填傳票／入帳完成 - 功能模組（index.show 專用；2026-11-18 從請購_庶務_轉請款單 搬來，2026-11-24 同步新版）
// 列表頁「🗂 批次動作 ▾」下拉選單的「📋 批次填傳票／入帳完成」選項（選單在 檔案批次 buildActionsMenu），開 SweetAlert2 視窗：
//   ① 列出「單位會計處理中」七個狀態、登入者看得到的請款單（不再限定自己是執行者）
//      - 登入者是執行者 → 照常
//      - 不是執行者、但在該單「會計單位」欄位的群組裡 → 可勾選，執行時先透過狀態驅動動作外掛（NXSdaApi，
//        用外掛存的本 App token）把自己加進執行者。原因：流程執行者是進入狀態當下展開群組成員，後台群組事後加人不會反映到舊單
//      - 兩者都不是（或外掛沒載入）→ 只顯示、不能勾選
//   ① 開視窗時把列表頁上方已輸入的記錄範圍（連續範圍兩格／指定記錄）帶進「單據編號範圍」並自動勾選
//   ② 勾選後一次填寫「傳票編號」「傳票日期」（日期預設今天），並可同時執行流程動作「入帳完成」（狀態變成「請款流程結束」）
// 版面：工具列（搜尋＋範圍）→ 會計標籤（多選，點一下＝開關）＋「未收到紙本」開關（筆數連動）→ 表格（鎖住的排最後、備註只標例外）
//       → 底部執行區（傳票輸入、執行摘要、按鈕顯示「執行 N 筆」；勾入帳完成時既有日期不是今年的列標紅）
// 規則：
//   - 「會計課承辦註記是否收到單據紙本」＝未收到 → 只顯示、不能勾選
//   - 兩欄都已有值 → 可勾選，但不覆蓋，只執行入帳完成；只有一欄有值 → 只補空的那一欄
//   - 要填寫的列存在時，傳票編號與傳票日期兩欄都必填；勾「同時執行入帳完成」時，每一列的傳票日期都必須是今年
//     （流程管理的「入帳完成」動作條件是 傳票日期＝今年）
//   - 先逐筆加執行者（需要的列）、再 PUT 欄位、再 PUT 流程狀態，後兩者每 100 筆一批；整批失敗就逐筆重試，收集每筆的錯誤；
//     加執行者失敗的列不填欄位也不送動作
// 與請購庶務版的差異：交通費請款單沒有「類型」欄位，所以沒有類型篩選；列表另顯示受款人。樣式在 payment_request.css（pr-bvs-*），JS 不注入樣式。
// 純函式（查詢、分類、驗證、組 payload、分批執行）全部 export（檔案批次 import openDialog；測試直接 import）。

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
  ASSIGNEE: BV.ASSIGNEE_FIELD,
  ACC_UNIT: BV.ACCOUNTING_UNIT_FIELD,
});
const DEFAULT_LABELS = Object.freeze({ no: F.VOUCHER_NO, date: F.VOUCHER_DATE });

const BUTTON_TEXT = '📋 批次填傳票／入帳完成';
const NS_FIELDS = [F.RECORD_NO, F.STATUS, F.PAYEE, F.TOTAL, F.VOUCHER_NO, F.VOUCHER_DATE, F.RECEIPT, F.ASSIGNEE, F.ACC_UNIT];

const KIND = Object.freeze({
  LOCKED: 'locked', // 未收到紙本，不能勾
  DENIED: 'denied', // 不是執行者、也不能把自己加進去，不能勾
  ACTION_ONLY: 'actionOnly', // 兩欄都有值，只簽核
  FILL: 'fill', // 至少一欄要填
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

/** 查詢字串：七個狀態（kintone 只回傳登入者看得到的單）；lastId 有值就接著往後翻頁（$id 由大到小） */
function buildQuery(lastId) {
  const statuses = BV.FROM_STATUSES.map((s) => `"${s}"`).join(',');
  const parts = [`${F.STATUS} in (${statuses})`];
  if (lastId) parts.push(`$id < ${Number(lastId)}`);
  return `${parts.join(' and ')} order by $id desc limit ${BV.PAGE_LIMIT}`;
}

const codesOf = (v) => (Array.isArray(v) ? v.map((x) => String(x?.code ?? '')).filter(Boolean) : []);

/**
 * 登入者對這張單的權限：
 *   'assignee'＝已是執行者；'join'＝不是執行者但在會計單位群組裡、且外掛可用 → 可自動加入；
 *   'noToken'＝在群組裡但外掛（NXSdaApi）沒載入；'denied'＝不在會計單位群組裡。
 * ctx＝{ loginCode, myGroups:Set<群組代碼>, canJoin:boolean }；沒給 ctx 視為執行者（舊呼叫方式）。
 */
function accessOf(assigneeCodes, accUnitCodes, ctx) {
  if (!ctx) return 'assignee';
  if (assigneeCodes.includes(ctx.loginCode)) return 'assignee';
  const inUnit = accUnitCodes.some((c) => ctx.myGroups?.has(c));
  if (!inUnit) return 'denied';
  return ctx.canJoin ? 'join' : 'noToken';
}

/** 把一筆 kintone 記錄整理成列表用的資料並分類；ctx 見 accessOf */
function classifyRow(record, ctx) {
  const val = (code) => record?.[code]?.value ?? '';
  const id = String(record?.$id?.value ?? '');
  const recordNo = String(val(F.RECORD_NO) || id);
  const vno = String(val(F.VOUCHER_NO) || '').trim();
  const vdate = String(val(F.VOUCHER_DATE) || '');
  const assignees = codesOf(record?.[F.ASSIGNEE]?.value);
  const access = accessOf(assignees, codesOf(record?.[F.ACC_UNIT]?.value), ctx);
  const needNo = !vno;
  const needDate = !vdate;
  let kind;
  if (val(F.RECEIPT) === C.OPTIONS.PAPER_RECEIVED.NOT_RECEIVED) kind = KIND.LOCKED;
  else if (access === 'denied' || access === 'noToken') kind = KIND.DENIED;
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
    access,
    assignees,
    needJoin: access === 'join' && kind !== KIND.LOCKED,
    selectable: kind !== KIND.LOCKED && kind !== KIND.DENIED,
  };
}

/**
 * 「備註」欄的小標籤。回傳 [{ text, tone }]；tone：join（加入執行者）／fill（要填寫）／only（只簽核）／locked（不能勾）
 */
function tagsOf(row) {
  if (row.kind === KIND.LOCKED) return [{ text: '📄 未收到紙本', tone: 'locked' }];
  if (row.kind === KIND.DENIED) {
    const text = row.access === 'noToken' ? '🚫 非執行者（外掛未載入，無法加入）' : '🚫 非執行者・不在會計單位群組';
    return [{ text, tone: 'locked' }];
  }
  const tags = [];
  if (row.kind === KIND.ACTION_ONLY) tags.push({ text: '已填・只簽核', tone: 'only' });
  else if (row.needNo && row.needDate) tags.push({ text: '填寫：編號＋日期', tone: 'fill' });
  else tags.push({ text: row.needNo ? '填寫：編號' : '填寫：日期', tone: 'fill' });
  if (row.needJoin) tags.push({ text: '👤 加入執行者', tone: 'join' });
  return tags;
}

/** 表格備註欄只標例外（未收到紙本、非執行者、加入執行者）；填寫／只簽核不另外標 */
const noteTagsOf = (row) => tagsOf(row).filter((t) => t.tone === 'locked' || t.tone === 'join');

/** 整串標籤文字（搜尋用）；加入執行者放最前面 */
function badgeOf(row) {
  const tags = tagsOf(row);
  const join = tags.filter((t) => t.tone === 'join');
  return [...join, ...tags.filter((t) => t.tone !== 'join')].map((t) => t.text).join('・');
}

/** 加入登入者後的執行者清單（去重、保留原順序）；超過上限回傳 null */
function joinedAssignees(current, loginCode) {
  const list = [...new Set([...(current || []), loginCode])];
  return list.length > BV.ASSIGNEE_MAX ? null : list;
}

/** 狀態縮成「會計」：單位會計處理中(台北) → 台北；沒括號原樣回傳 */
function regionOf(status) {
  const m = String(status || '').match(/\(([^)]*)\)\s*$/);
  return m ? m[1] : String(status || '');
}

/** 關鍵字比對（整列文字，不分大小寫） */
function matchKeyword(row, keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return true;
  const text = [row.recordNo, row.status, row.payee, fmtMoney(row.total), row.total, row.vno, row.vdate, badgeOf(row)].join(' ').toLowerCase();
  return text.includes(kw);
}

// ── 篩選：「會計」一列標籤，點一下＝多選切換，都不選＝不篩（同列「或」）；另有一顆「未收到紙本」開關（與會計列「且」）。
//   標籤筆數跟著另一個條件連動。
const REGION_ORDER = BV.FROM_STATUSES.map(regionOf);
const isNoPaper = (r) => r.kind === KIND.LOCKED;
const regionOfRow = (r) => regionOf(r.status);

/** 篩選狀態：{ region:Set, noPaper:boolean } */
const emptyFilter = () => ({ region: new Set(), noPaper: false });

/** 套用篩選；skip＝計算某一項筆數時略過它自己的條件（'region'／'noPaper'） */
function applyFilter(rows, state, skip) {
  return rows.filter(
    (r) => (skip === 'region' || !state.region.size || state.region.has(regionOfRow(r))) && (skip === 'noPaper' || !state.noPaper || isNoPaper(r)),
  );
}

/** 會計標籤的選項與連動筆數：[{ value, count }]，照流程狀態順序；值取自全部資料，0 筆仍列出 */
function regionOptions(rows, state) {
  const values = [...new Set(rows.map(regionOfRow))].filter((v) => v !== '');
  const pos = (v) => (REGION_ORDER.includes(v) ? REGION_ORDER.indexOf(v) : REGION_ORDER.length);
  values.sort((a, b) => pos(a) - pos(b));
  const scoped = applyFilter(rows, state, 'region');
  return values.map((value) => ({ value, count: scoped.filter((r) => regionOfRow(r) === value).length }));
}

/** 「未收到紙本」開關的連動筆數 */
const noPaperCount = (rows, state) => applyFilter(rows, state, 'noPaper').filter(isNoPaper).length;

/** 篩選是否有任何條件 */
const hasFilter = (state) => state.region.size > 0 || state.noPaper;

/** 可勾的排前面、鎖住的排最後；同組內維持原順序（$id 由大到小） */
const sortRows = (rows) => [...rows.filter((r) => r.selectable), ...rows.filter((r) => !r.selectable)];

/** 執行摘要：已選幾筆、其中加入執行者／填寫傳票／入帳完成各幾筆 */
function summarize(chosen, doAction) {
  return {
    total: chosen.length,
    join: chosen.filter((r) => r.needJoin).length,
    fill: chosen.filter((r) => r.kind === KIND.FILL).length,
    act: doAction ? chosen.length : 0,
  };
}

/** 本地日期 YYYY-MM-DD（傳票日期預設值） */
function todayStr(d) {
  const x = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

/** 執行入帳完成時，有效傳票日期（既有值或新輸入）不是今年的列 id；不執行入帳完成回空陣列 */
function badDateIds(rows, voucherDate, year, doAction) {
  if (!doAction) return [];
  return rows
    .filter((r) => {
      const eff = r.vdate || (r.needDate ? voucherDate : '');
      return eff && !eff.startsWith(`${year}-`);
    })
    .map((r) => r.id);
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
    return { ok: false, errors: ['勾選的記錄都已填好，請勾選「同時執行入帳完成」，或改選需要填寫的記錄'], badRows };
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
 * 逐筆把登入者加進執行者（kintone 沒有批次版 API）。assigneeApi(method, path, body) 用外掛存的 token 呼叫。
 * 回傳 { okIds:[], failed:[{id, message}] }
 */
async function joinAssignees(assigneeApi, appId, rows, loginCode, onProgress) {
  const okIds = [];
  const failed = [];
  let done = 0;
  for (const r of rows) {
    const list = joinedAssignees(r.assignees, loginCode);
    if (!list) {
      failed.push({ id: r.id, message: `執行者已達 ${BV.ASSIGNEE_MAX} 人上限` });
    } else {
      try {
        await assigneeApi('PUT', '/k/v1/record/assignees', { app: appId, id: r.id, assignees: list });
        okIds.push(r.id);
      } catch (e) {
        failed.push({ id: r.id, message: errMsg(e) });
      }
    }
    done += 1;
    if (onProgress) onProgress(done);
  }
  return { okIds, failed };
}

/**
 * 完整執行：先加執行者（needJoin 的列）、再填欄位、再入帳完成（前一步失敗的列不往下做）。
 * api(method, path, body) 可注入；appId 為目前 App。
 * opts.assigneeApi／opts.loginCode：加執行者用（有 needJoin 的列才需要）。
 * 回傳 { joined, filled, acted, failures:[{recordNo, step, message}] }
 */
async function execute(api, appId, allRows, opts, onProgress) {
  const byId = new Map(allRows.map((r) => [r.id, r]));
  const noOf = (id) => byId.get(id)?.recordNo || id;
  const stepsOf = (rs) => buildFillPayloads(rs, opts.voucherNo, opts.voucherDate).length + (opts.doAction ? rs.length : 0);
  const toJoin = allRows.filter((r) => r.needJoin);
  let total = toJoin.length + stepsOf(allRows);
  let base = 0;
  const report = (label) => (n) => onProgress && onProgress(base + n, total, label);
  const failures = [];

  let joined = 0;
  let rows = allRows;
  if (toJoin.length) {
    const joinRes = opts.assigneeApi
      ? await joinAssignees(opts.assigneeApi, appId, toJoin, opts.loginCode, report('加入執行者'))
      : { okIds: [], failed: toJoin.map((r) => ({ id: r.id, message: '未設定加入執行者的權限' })) };
    joined = joinRes.okIds.length;
    joinRes.failed.forEach((f) => failures.push({ recordNo: noOf(f.id), step: '加入執行者', message: f.message }));
    const failedJoin = new Set(joinRes.failed.map((f) => f.id));
    rows = allRows.filter((r) => !failedJoin.has(r.id));
    base += toJoin.length;
    total = base + stepsOf(rows); // 加入失敗的列不往下做
  }
  const fills = buildFillPayloads(rows, opts.voucherNo, opts.voucherDate);

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
  return { joined, filled: fillRes.okIds.length, acted, failures };
}

// ======================== 資料讀取 ========================
const kintoneApi = (method, path, body) => kintone.api(kintone.api.url(path, true), method, body);

/**
 * 加執行者專用：走狀態驅動動作外掛 window.NXSdaApi.call（登入者本身沒有 App 管理權限）。
 * 外掛用設定裡本 App 的 token 代為呼叫，前端拿不到 token；外掛沒載入回傳 null。plugin 可注入（測試用）。
 */
function makePluginApi(appId, plugin) {
  const p = plugin === undefined ? window.NXSdaApi : plugin;
  if (!p || typeof p.call !== 'function') return null;
  return (method, path, body) => p.call(`${path}.json`, method, body, appId);
}

/** 登入者所屬群組代碼（查詢失敗 → 空集合：不能加執行者，但原本就是執行者的單照常） */
async function fetchMyGroups(api, loginCode) {
  try {
    const res = await api('GET', '/v1/user/groups', { code: loginCode });
    return new Set((res?.groups || []).map((g) => String(g.code)));
  } catch (e) {
    console.error('[批次填傳票] 查詢登入者群組失敗，不能加執行者', e);
    return new Set();
  }
}

async function fetchRows(api, appId, ctx) {
  const rows = [];
  let lastId = null;
  for (;;) {
    const res = await api('GET', '/k/v1/records', { app: appId, query: buildQuery(lastId), fields: ['$id', ...NS_FIELDS] });
    res.records.forEach((r) => rows.push(classifyRow(r, ctx)));
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
/** 篩選區 HTML：會計一列標籤（data-k／data-v）＋「未收到紙本」開關（data-k="noPaper"） */
function renderFilters(rows, state) {
  const chip = (key, value, count, on, warn) => {
    const cls = ['pr-bvs-chip', on ? 'pr-bvs-on' : '', count ? '' : 'pr-bvs-zero', warn ? 'pr-bvs-warn' : ''].filter(Boolean).join(' ');
    return `<button type="button" class="${cls}" data-k="${key}" data-v="${esc(value)}">${esc(value)}<b>${count}</b></button>`;
  };
  const chips = regionOptions(rows, state)
    .map((o) => chip('region', o.value, o.count, state.region.has(o.value)))
    .join('');
  const noPaper = `<span class="pr-bvs-grow"></span>${chip('noPaper', '📄 未收到紙本', noPaperCount(rows, state), state.noPaper, true)}`;
  return `<div class="pr-bvs-frow"><span class="pr-bvs-flabel">會計</span>${chips}${noPaper}</div>`;
}

/** 備註小標籤的 class（寫完整名稱，才掃得到有沒有定義在 payment_request.css） */
const TAG_CLASS = Object.freeze({
  join: 'pr-bvs-tag pr-bvs-tag-join',
  fill: 'pr-bvs-tag pr-bvs-tag-fill',
  only: 'pr-bvs-tag pr-bvs-tag-only',
  locked: 'pr-bvs-tag pr-bvs-tag-locked',
});

function renderTable(rows, opts) {
  const { keyword, selected, filter, badIds } = opts;
  const visible = sortRows(applyFilter(rows, filter || emptyFilter())).filter((r) => matchKeyword(r, keyword));
  const body = visible
    .map((r) => {
      const check = r.selectable
        ? `<input type="checkbox" class="pr-bvs-cb" data-id="${esc(r.id)}"${selected.has(r.id) ? ' checked' : ''}>`
        : '🔒';
      const cls = !r.selectable ? 'pr-bvs-row-locked' : selected.has(r.id) ? 'pr-bvs-row-sel' : '';
      const tags = noteTagsOf(r)
        .map((t) => `<span class="${TAG_CLASS[t.tone]}">${esc(t.text)}</span>`)
        .join('');
      const dateCls = badIds.has(r.id) && r.vdate ? ' class="pr-bvs-bad" title="不是今年，無法入帳完成"' : '';
      return `<tr class="${cls}"><td>${check}</td><td>${esc(r.recordNo)}</td><td title="${esc(r.status)}">${esc(regionOf(r.status))}</td><td class="pr-bvs-left">${esc(r.payee)}</td>
<td class="pr-bvs-num">${esc(fmtMoney(r.total))}</td><td class="pr-bvs-left">${esc(r.vno)}</td><td${dateCls}>${esc(r.vdate)}</td>
<td class="pr-bvs-left">${tags}</td></tr>`;
    })
    .join('');
  const empty = visible.length ? '' : '<tr><td colspan="8" class="pr-bvs-empty">沒有符合條件的記錄</td></tr>';
  return {
    visible,
    html: `<table class="pr-bvs-table"><thead><tr><th></th><th>交通費請款單號</th><th>會計</th><th>受款人</th><th>總金額</th><th>傳票編號</th><th>傳票日期</th><th class="pr-bvs-left">備註</th></tr></thead><tbody>${body}${empty}</tbody></table>`,
  };
}

/** 執行摘要文字（底部執行區） */
function summaryLine(s) {
  if (!s.total) return '尚未勾選記錄';
  const parts = [`已選 <b>${s.total}</b> 筆`];
  if (s.join) parts.push(`加入執行者 <b>${s.join}</b>`);
  parts.push(`填寫傳票 <b>${s.fill}</b>`);
  parts.push(s.act ? `入帳完成 <b>${s.act}</b>` : '不執行入帳完成');
  return parts.join('<span class="pr-bvs-sum-sep">｜</span>');
}

function buildDialogHtml(labels, today) {
  return `<div class="pr-bvs-wrap">
<div class="pr-bvs-tools">
  <input id="bvs-search" type="text" placeholder="🔍 搜尋單號、會計、受款人、金額、傳票…">
  <span class="pr-bvs-sep"></span>
  <input id="bvs-range" type="text" placeholder="單據編號範圍，例：100-150, 160">
  <button type="button" class="pr-bvs-btn" id="bvs-range-apply">套用範圍勾選</button>
</div>
<div class="pr-bvs-range-msg" id="bvs-range-msg"></div>
<div class="pr-bvs-filters" id="bvs-filters"></div>
<div class="pr-bvs-meta"><span class="pr-bvs-clear" id="bvs-clear">清除篩選</span><span class="pr-bvs-grow"></span><span class="pr-bvs-link" id="bvs-all">全選</span><span class="pr-bvs-count" id="bvs-count"></span></div>
<div class="pr-bvs-tablewrap" id="bvs-table"></div>
<div class="pr-bvs-foot" id="bvs-foot">
  <div class="pr-bvs-inputs">
    <div class="pr-bvs-field"><label for="bvs-no">${esc(labels.no)} <span class="pr-bvs-req" id="bvs-no-req">*</span><small id="bvs-no-note"></small></label><input id="bvs-no" type="text" maxlength="100"></div>
    <div class="pr-bvs-field"><label for="bvs-date">${esc(labels.date)} <span class="pr-bvs-req" id="bvs-date-req">*</span></label><input id="bvs-date" type="date" value="${esc(today)}"></div>
    <label class="pr-bvs-opt"><input type="checkbox" id="bvs-action" checked> 同時執行入帳完成（變成「${esc(BV.TARGET_STATUS)}」）</label>
  </div>
  <div class="pr-bvs-sum" id="bvs-sum"></div>
  <div class="pr-bvs-hint" id="bvs-hint"></div>
</div></div>`;
}

const $ = (id) => document.getElementById(id);

const progressHtml = () => '<progress class="pr-bvs-progress" id="bvs-bar" max="100" value="0"></progress><div class="pr-bvs-prog" id="bvs-prog"></div>';

function summaryHtml(res, opts) {
  const lines = [];
  if (res.joined) lines.push(`加入執行者：<b>${res.joined}</b> 筆`);
  lines.push(`成功填入傳票：<b>${res.filled}</b> 筆`);
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
  const loginCode = kintone.getLoginUser().code;
  const assigneeApi = makePluginApi(appId);
  Swal.fire({ title: '載入記錄中…', allowOutsideClick: false, showConfirmButton: false, didOpen: () => Swal.showLoading() });
  let rows;
  let labels;
  try {
    const myGroups = await fetchMyGroups(kintoneApi, loginCode);
    const ctx = { loginCode, myGroups, canJoin: !!assigneeApi };
    [rows, labels] = await Promise.all([fetchRows(kintoneApi, appId, ctx), fetchLabels(kintoneApi, appId)]);
  } catch (e) {
    await alertMsg(`讀取記錄失敗\n${errMsg(e)}`, 'error');
    return;
  }
  if (!rows.length) {
    await alertMsg('目前沒有您看得到、狀態為單位會計處理中的記錄', 'info');
    return;
  }

  const indexRange = readIndexRange(); // 列表頁上方已輸入的範圍，開視窗時帶入並自動勾選
  const year = new Date().getFullYear();
  let keyword = '';
  let filter = emptyFilter();
  let visibleRows = rows;
  const selected = new Set();
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const chosenRows = () => [...selected].map((id) => rowById.get(id)).filter(Boolean);
  const readInput = () => ({
    voucherNo: $('bvs-no').value.trim(),
    voucherDate: $('bvs-date').value.trim(),
    doAction: $('bvs-action').checked,
    year,
    labels,
  });

  /** 底部執行區：摘要、輸入框是否需要、確認按鈕文字 */
  const refreshFoot = () => {
    const chosen = chosenRows();
    const s = summarize(chosen, readInput().doAction);
    $('bvs-sum').innerHTML = summaryLine(s);
    const needFill = s.fill > 0;
    const showReq = needFill || !s.total;
    $('bvs-foot').classList.toggle('pr-bvs-dim', s.total > 0 && !needFill);
    $('bvs-no-req').classList.toggle('pr-bvs-hide', !showReq);
    $('bvs-date-req').classList.toggle('pr-bvs-hide', !showReq);
    $('bvs-no-note').textContent = !s.total ? '' : needFill ? `（${s.fill} 筆需要）` : '（勾選的單都已填好，不需要）';
    const btn = Swal.getConfirmButton();
    if (btn) btn.textContent = s.total ? `執行 ${s.total} 筆` : '執行';
  };
  const refreshMeta = () => {
    const selectable = visibleRows.filter((r) => r.selectable);
    const allOn = selectable.length > 0 && selectable.every((r) => selected.has(r.id));
    $('bvs-all').textContent = allOn ? '取消全選' : '全選';
    $('bvs-all').classList.toggle('pr-bvs-hide', !selectable.length);
    $('bvs-count').textContent = `顯示 ${visibleRows.length} / ${rows.length} 筆・已選 ${selected.size} 筆`;
    $('bvs-clear').classList.toggle('pr-bvs-hide', !hasFilter(filter));
    refreshFoot();
  };
  const rerender = () => {
    $('bvs-filters').innerHTML = renderFilters(rows, filter);
    const input = readInput();
    const badIds = new Set(badDateIds(rows, input.voucherDate, year, input.doAction));
    const t = renderTable(rows, { keyword, selected, filter, badIds });
    visibleRows = t.visible;
    $('bvs-table').innerHTML = t.html;
    $('bvs-table')
      .querySelectorAll('.pr-bvs-cb')
      .forEach((cb) =>
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
    // 篩選標籤每次重畫，事件綁在外層：點一下＝多選切換
    $('bvs-filters').addEventListener('click', (e) => {
      const b = e.target.closest('.pr-bvs-chip');
      if (!b) return;
      const { k, v } = b.dataset;
      if (k === 'noPaper') filter.noPaper = !filter.noPaper;
      else if (filter.region.has(v)) filter.region.delete(v);
      else filter.region.add(v);
      rerender();
    });
    $('bvs-clear').addEventListener('click', () => {
      filter = emptyFilter();
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
      if (skippedLocked) parts.push(`略過 ${skippedLocked} 筆不能勾選（未收到紙本／非執行者）`);
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
    $('bvs-no').addEventListener('input', () => {
      $('bvs-hint').textContent = '';
    });
    const onInput = () => {
      $('bvs-hint').textContent = '';
      rerender(); // 日期或入帳完成改了 → 重新標出不是今年的日期
    };
    $('bvs-date').addEventListener('change', onInput);
    $('bvs-action').addEventListener('change', onInput);
  };

  const result = await Swal.fire({
    title: BUTTON_TEXT,
    width: 'auto',
    html: buildDialogHtml(labels, todayStr()),
    showCancelButton: true,
    confirmButtonText: '執行',
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
      const input = readInput();
      const chosen = chosenRows();
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
        const execOpts = { ...input, loginCode, assigneeApi };
        res = await execute(kintoneApi, appId, chosen, execOpts, (done, total, label) => {
          $('bvs-bar').value = total ? Math.round((done / total) * 100) : 100;
          $('bvs-prog').textContent = `${label}　${done} / ${total}`;
        });
      } catch (e) {
        res = { joined: 0, filled: 0, acted: 0, failures: [{ recordNo: '（全部）', step: '執行', message: errMsg(e) }] };
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
export {
  KIND,
  buildQuery,
  classifyRow,
  accessOf,
  badgeOf,
  tagsOf,
  noteTagsOf,
  regionOf,
  emptyFilter,
  applyFilter,
  regionOptions,
  noPaperCount,
  hasFilter,
  renderFilters,
  renderTable,
  sortRows,
  summarize,
  summaryLine,
  todayStr,
  badDateIds,
  buildDialogHtml,
  joinedAssignees,
  joinAssignees,
  fetchMyGroups,
  makePluginApi,
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
};
