#!/usr/bin/env node
'use strict';

/*
 * 舊單補登記（一次性，由管理單位執行）：把某個請款 App 現有、沒作廢的單的發票號碼登記到發票登記 App。
 * plug-in 判斷重複只看登記 App，上線前的舊單不補登記就查不到。
 *
 * 用 API token（不受記錄權限限制，看得到所有單）。token 只放環境變數，不要寫進檔案：
 *   請款 App：記錄檢視；發票登記 App：記錄檢視＋新增。多個 token 用逗號分隔。
 *
 *   PowerShell：
 *     $env:KINTONE_BASE_URL = "https://xxx.cybozu.com"
 *     $env:KINTONE_API_TOKEN = "<請款App token>,<登記App token>"
 *     node scripts/backfill.cjs --app 749 --registry 757 --field 發票號碼記錄 --status-field 狀態 --void-status 表單作廢 --void-check 表單作廢
 *     （確認報表沒問題後，同一行加 --apply 才真的寫入）
 *
 * 規則：
 *   - 同一號碼只登記一次，給記錄編號最小的那張單；同 App 多張單用同一號碼 → 列進報表（衝突），請管理單位確認。
 *   - 登記 App 已有這個號碼：是本單的 → 略過；是別張單的 → 列進報表（衝突），不改。
 *   - 報表：out/backfill_<App>_<時間>.csv（Excel 可直接開），每次都產生；不加 --apply 不寫入任何資料。
 *   - 重跑安全：已登記的會略過。
 */

const fs = require('fs');
const path = require('path');
require('../src/js/core.js');

const Core = globalThis.NXInvoiceRegistry;
const R = Core.DEFAULT_REGISTRY_FIELDS;
const PAGE = 500;
const CHUNK = 100;

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** --key value／--flag → { key: value | true }；--void-status 可重複或逗號分隔 */
const parseArgs = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([\w-]+)$/);
    if (!m) throw new Error(`看不懂的參數：${argv[i]}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[m[1]] = true;
    else {
      out[m[1]] = out[m[1]] && m[1] === 'void-status' ? `${out[m[1]]},${next}` : next;
      i += 1;
    }
  }
  return {
    app: String(out.app || ''),
    registry: String(out.registry || ''),
    field: String(out.field || ''),
    statusField: String(out['status-field'] || ''),
    voidStatuses: String(out['void-status'] || '')
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter(Boolean),
    voidCheck: String(out['void-check'] || ''),
    apply: out.apply === true,
  };
};

/**
 * 算出要登記哪些、哪些是衝突（純函式，不打 API）
 * @param {{ records: Object[], rows: Object[], args: Object }} p records＝請款 App 沒作廢的單；rows＝登記 App 沒作廢的登記
 */
const plan = ({ records, rows, args }) => {
  const owners = new Map(); // 號碼 → 用到它的記錄編號（小到大）
  records
    .filter((r) => !(args.voidCheck && r[args.voidCheck]?.value?.length > 0))
    .filter((r) => !(args.statusField && args.voidStatuses.includes(r[args.statusField]?.value)))
    .sort((a, b) => Number(a.$id.value) - Number(b.$id.value))
    .forEach((r) =>
      Core.invoicesOfValue(r[args.field]?.value).forEach((no) => {
        const list = owners.get(no) || [];
        if (!list.includes(r.$id.value)) list.push(r.$id.value);
        owners.set(no, list);
      }),
    );
  const existing = new Map(rows.filter((row) => row[R.VOIDED]?.value !== '是').map((row) => [String(row[R.INVOICE].value).trim().toUpperCase(), row]));
  const toAdd = [];
  const conflicts = [];
  let already = 0;
  owners.forEach((ids, no) => {
    const row = existing.get(no);
    if (ids.length > 1) conflicts.push({ no, type: '同 App 多張單用同一號碼', ids, registered: '' });
    if (row) {
      const regApp = String(row[R.OWNER_APP]?.value || '');
      const regId = String(row[R.OWNER_ID]?.value || '');
      if (regApp === args.app && ids.includes(regId)) already += 1;
      else conflicts.push({ no, type: '已登記給其他單據', ids, registered: `App ${regApp} 記錄 ${regId || '（未回填）'}（登記 ${row.$id.value}）` });
      return;
    }
    toAdd.push({ no, id: ids[0] });
  });
  return { toAdd, conflicts, already, invoiceCount: owners.size };
};

const createApi = ({ baseUrl, token, fetchImpl }) => async (p, method, body) => {
  const headers = { 'X-Cybozu-API-Token': token, 'Content-Type': 'application/json' };
  if (method === 'GET') headers['X-HTTP-Method-Override'] = 'GET';
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/k/v1/${p}`, { method: method === 'GET' ? 'POST' : method, headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.message || `HTTP ${res.status}`), { code: json.code, errors: json.errors });
  return json;
};

const fetchAll = async (api, app, cond, fields) => {
  const out = [];
  let lastId = 0;
  for (;;) {
    const query = `${cond ? `(${cond}) and ` : ''}$id > ${lastId} order by $id asc limit ${PAGE}`;
    const resp = await api('records.json', 'GET', { app, query, fields });
    const list = resp.records || [];
    out.push(...list);
    if (list.length < PAGE) return out;
    lastId = list[list.length - 1].$id.value;
  }
};

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/**
 * @returns {Promise<{ toAdd: number, added: number, already: number, conflicts: number, failed: number, report: string }>}
 */
const run = async ({ argv, env, fetchImpl, log = console.log, outDir = path.join(__dirname, '..', 'out'), now = () => new Date() }) => {
  const args = parseArgs(argv);
  const problems = [];
  if (!/^\d+$/.test(args.app)) problems.push('--app 要填請款 App ID');
  if (!/^\d+$/.test(args.registry)) problems.push('--registry 要填發票登記 App ID');
  if (!args.field) problems.push('--field 要填發票號碼記錄欄位代碼');
  if (args.statusField && args.voidStatuses.length === 0) problems.push('--status-field 要搭配 --void-status');
  if (!env.KINTONE_BASE_URL || !env.KINTONE_API_TOKEN) problems.push('請先設定環境變數 KINTONE_BASE_URL、KINTONE_API_TOKEN');
  if (problems.length > 0) throw new Error(problems.join('\n'));

  const api = createApi({ baseUrl: env.KINTONE_BASE_URL, token: env.KINTONE_API_TOKEN, fetchImpl });
  const statusCond = args.statusField ? `${args.statusField} not in (${args.voidStatuses.map((v) => `"${esc(v)}"`).join(', ')})` : '';
  const recFields = ['$id', args.field, ...(args.statusField ? [args.statusField] : []), ...(args.voidCheck ? [args.voidCheck] : [])];
  log(`讀取 App ${args.app} 的單…`);
  const records = await fetchAll(api, args.app, statusCond, recFields);
  log(`讀取發票登記 App ${args.registry}…`);
  const rows = await fetchAll(api, args.registry, `${R.VOIDED} not in ("是")`, ['$id', R.INVOICE, R.OWNER_APP, R.OWNER_ID, R.VOIDED]);
  const result = plan({ records, rows, args });

  const failures = [];
  let added = 0;
  if (args.apply) {
    const post = (items) =>
      api('records.json', 'POST', {
        app: args.registry,
        records: items.map(({ no, id }) => ({ [R.INVOICE]: { value: no }, [R.OWNER_APP]: { value: args.app }, [R.OWNER_ID]: { value: id }, [R.TOKEN]: { value: 'backfill' } })),
      });
    for (let i = 0; i < result.toAdd.length; i += CHUNK) {
      const part = result.toAdd.slice(i, i + CHUNK);
      try {
        await post(part);
        added += part.length;
      } catch (err) {
        // 整批失敗（例如剛好有人登記了其中一個號碼）→ 一筆一筆重來，找出是哪幾筆
        for (const item of part) {
          try {
            await post([item]);
            added += 1;
          } catch (e) {
            failures.push({ ...item, message: `${e.code || ''} ${e.message}`.trim() });
          }
        }
      }
    }
  }

  const lines = [['發票號碼', '結果', '使用的記錄編號', '登記 App 現況'].map(csvCell).join(',')];
  const failedNos = new Set(failures.map((f) => f.no));
  result.toAdd.forEach(({ no, id }) => {
    const status = !args.apply ? '預覽：會登記' : failedNos.has(no) ? `失敗：${failures.find((f) => f.no === no).message}` : '已登記';
    lines.push([no, status, id, ''].map(csvCell).join(','));
  });
  result.conflicts.forEach((c) => lines.push([c.no, `衝突：${c.type}`, c.ids.join('、'), c.registered].map(csvCell).join(',')));
  fs.mkdirSync(outDir, { recursive: true });
  const report = path.join(outDir, `backfill_${args.app}_${stamp(now())}.csv`);
  fs.writeFileSync(report, `﻿${lines.join('\r\n')}\r\n`, 'utf8');

  const summary = { toAdd: result.toAdd.length, added, already: result.already, conflicts: result.conflicts.length, failed: failures.length, report };
  log(
    [
      `App ${args.app}：有效單 ${records.length} 張、發票號碼 ${result.invoiceCount} 個`,
      `  已登記（略過）${summary.already}`,
      args.apply ? `  新登記 ${added}／${summary.toAdd}，失敗 ${summary.failed}` : `  會登記 ${summary.toAdd}（預覽，沒有寫入；確認後加 --apply）`,
      `  衝突 ${summary.conflicts}（請管理單位看報表處理）`,
      `報表：${report}`,
    ].join('\n'),
  );
  return summary;
};

if (require.main === module) {
  run({ argv: process.argv.slice(2), env: process.env, fetchImpl: globalThis.fetch }).catch((err) => {
    console.error(`補登記失敗：${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, plan, run };
