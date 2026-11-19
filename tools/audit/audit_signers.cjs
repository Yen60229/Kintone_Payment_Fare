#!/usr/bin/env node
'use strict';

// =============================================================================
// 簽核人員／會計單位稽核（唯讀）
//
//   簽核人員、會計單位、掛帳單位限部內等規則只在瀏覽器 JS 執行，REST API、CSV 匯入、手機版、
//   開發者工具都能繞過。這支工具讀出已存檔的請款單，用「同一份」前端程式重算一次，列出存檔值與重算值不同的單。
//
//   重算方式：用 tests/lib/pr_env.cjs 的 vm 沙箱載入原始模組（不複製邏輯）
//     payment_request_config.js、費用歸屬部門限制_20261022.js、signing_personnel_manager_20260506.js、部長上一階主管_20261116.js
//   每筆記錄複製一份、把狀態清空（讓「只在可編輯狀態重算」的檢查放行），再依存檔時的順序呼叫：
//     PR_SIGNING_CHAIN.applyOnSave → applyAccountingOnSave → PR_DIRECTOR_UPLINE.apply → PR_COST_SCOPE.validate
//   比對六格簽核人、主管／次長人數、會計單位、會計單位承辦人、權限開放人員；規則錯誤（掛帳單位跨部、
//   申請人與費用所屬人不同部門、非排除群組勾手動、部門不是費用所屬人的）另列一列。
//   PR_COST_CENTER（費用歸屬主檔快取，原本在 payment_request_main）在這裡用同樣的查詢重建，避免載入整支畫面程式。
//
//   只讀不寫：只送 GET，不呼叫任何更新 API。
//
// 用法（PowerShell）：
//   $env:KINTONE_BASE_URL = 'https://<子網域>.cybozu.com'
//   $env:KINTONE_API_TOKEN = '<請款單token>,<簽核流程主檔token>,<會計對應主檔token>,<費用歸屬主檔token>'
//   $env:KINTONE_USERNAME = '<管理員帳號>'; $env:KINTONE_PASSWORD = '<密碼>'   # 使用者／群組／組織 API 不吃 API token
//   npm run audit:signers -- --query '更新時間 >= "2026-10-01T00:00:00Z"'
//   npm run audit:signers -- --fixture tests/fixtures/audit_signers.json      # 不連線，用假資料跑
//
// 參數：
//   --app <id>         請款單 App ID（預設環境變數 KINTONE_APP_ID，再沒有就用測試區 749）
//   --query "<條件>"   只稽核符合條件的記錄（kintone 查詢語法，不要加 order by／limit）
//   --out <資料夾>     報表輸出位置（預設 tools/audit/out，已加入 .gitignore）
//   --fixture <json>   用假資料，不連線
//   --fail-on-diff     有差異時結束代碼 2（排程用）
//   --verbose          印出模組的 console 訊息
//
// 憑證只從環境變數讀，不寫檔、不印出；報表裡不會有任何憑證。
// =============================================================================

const fs = require('fs');
const path = require('path');
const { createEnv, rootDir } = require('../../tests/lib/pr_env.cjs');

const DEFAULT_APP_ID = 749; // 測試區交通費請款單；正式區用 --app 或 KINTONE_APP_ID
const DEFAULT_OUT_DIR = path.join(__dirname, 'out');
const PAGE_SIZE = 500;
const MAX_PAGES = 200;

const MODULES = ['payment_request_config.js', '費用歸屬部門限制_20261022.js', 'signing_personnel_manager_20260506.js', '部長上一階主管_20261116.js'];

// ── 資料來源：kintone.api(path, method, params) 的替身 ─────────────────────────

/** kintone.api.url 在沙箱是原樣回傳；這裡補 .json，兩種寫法都接受 */
const normPath = (p) => (/\.json$/.test(p) ? p : `${p}.json`);

/** GET 參數 → query string（陣列用 fields[0]=… 的寫法，kintone 支援） */
const toQueryString = (params = {}) => {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((item, i) => sp.append(`${k}[${i}]`, String(item)));
    else sp.append(k, String(v));
  });
  return sp.toString();
};

/**
 * 連線版：只送 GET。/k/ 開頭用 API token（有給才用，否則用帳密）；/v1/ 開頭（使用者、群組、組織）一律用帳密。
 * 同樣的查詢只打一次（主檔、使用者職稱在多筆記錄間共用）。
 */
const makeLiveApi = ({ baseUrl, apiToken, username, password, fetchImpl = globalThis.fetch }) => {
  if (!baseUrl) throw new Error('缺少環境變數 KINTONE_BASE_URL（例：https://<子網域>.cybozu.com）');
  if (!apiToken && !(username && password)) throw new Error('缺少憑證：請設定 KINTONE_API_TOKEN，或 KINTONE_USERNAME＋KINTONE_PASSWORD');
  const base = String(baseUrl).replace(/\/+$/, '');
  const passwordHeader = username && password ? Buffer.from(`${username}:${password}`).toString('base64') : null;
  const memo = new Map();

  const call = async (p, method, params) => {
    if (String(method).toUpperCase() !== 'GET') throw new Error(`稽核工具只允許 GET，拒絕 ${method} ${p}`);
    const apiPath = normPath(p);
    const headers = {};
    if (apiPath.startsWith('/k/') && apiToken) headers['X-Cybozu-API-Token'] = apiToken;
    else if (passwordHeader) headers['X-Cybozu-Authorization'] = passwordHeader;
    else throw new Error(`${apiPath} 不接受 API token，請設定 KINTONE_USERNAME＋KINTONE_PASSWORD（cybozu.com 共通管理者）`);
    const qs = toQueryString(params);
    const resp = await fetchImpl(`${base}${apiPath}${qs ? `?${qs}` : ''}`, { method: 'GET', headers });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(`kintone ${resp.status} ${apiPath}: ${body.message || ''}${body.code ? ` (${body.code})` : ''}`);
      err.status = resp.status;
      throw err;
    }
    return body;
  };

  return (p, method, params) => {
    const key = `${normPath(p)} ${JSON.stringify(params || {})}`;
    // 請款單本身翻頁的查詢每次都不同，記住也無害；失敗的不記
    if (!memo.has(key)) {
      const task = call(p, method, params);
      memo.set(key, task);
      task.catch(() => memo.delete(key));
    }
    return memo.get(key);
  };
};

/**
 * 假資料版查詢條件：只支援本工具與被載入模組實際用到的寫法
 *   欄位 = "x"、欄位 in ("a", "b")、$id > N，用 and 串起來；order by／limit 只認 limit
 */
const matchQuery = (record, query) => {
  const cond = String(query || '')
    .replace(/\s+order by[\s\S]*$/i, '')
    .replace(/\s+limit\s+\d+[\s\S]*$/i, '')
    .trim()
    .replace(/^\((.*)\)(\s+and\s+)/i, '$1$2');
  if (!cond) return true;
  return cond.split(/\s+and\s+/i).every((raw) => {
    const term = raw.trim();
    let m = /^\$id\s*>\s*(\d+)$/.exec(term);
    if (m) return Number(record.$id?.value) > Number(m[1]);
    m = /^(\S+)\s+in\s+\((.*)\)$/i.exec(term) || /^(\S+)\s*=\s*(".*")$/.exec(term);
    if (!m) throw new Error(`假資料不支援的查詢條件：${term}`);
    const wanted = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
    const v = record[m[1]]?.value;
    const values = Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? x.code : x)) : [v];
    return values.some((x) => wanted.includes(String(x)));
  });
};

/**
 * 假資料版（不連線）。fixture 格式見 tests/fixtures/audit_signers.json：
 *   records（請款單）、apps.{APPROVAL_FLOW,ACCOUNTING_MAP,COST_CENTER}（依 config 的 APPS 名稱）、
 *   userOrgs{code:organizationTitles}、userGroups{code:groups}、groupUsers{group:users}、organizations[{code,parentCode}]
 */
const makeFixtureApi = (fixture, { apps, paymentAppId }) => {
  const appRecords = (appId) => {
    if (Number(appId) === Number(paymentAppId)) return fixture.records || [];
    const name = Object.keys(fixture.apps || {}).find((k) => Number(apps[k]) === Number(appId));
    if (!name) throw new Error(`假資料沒有 App ${appId} 的記錄`);
    return fixture.apps[name];
  };
  return async (p, method, params = {}) => {
    if (String(method).toUpperCase() !== 'GET') throw new Error(`稽核工具只允許 GET，拒絕 ${method} ${p}`);
    const apiPath = normPath(p);
    switch (apiPath) {
      case '/k/v1/records.json': {
        const limit = Number(/limit\s+(\d+)/i.exec(params.query || '')?.[1]) || Infinity;
        const list = appRecords(params.app).filter((r) => matchQuery(r, params.query));
        return { records: JSON.parse(JSON.stringify(list.slice(0, limit))) };
      }
      case '/v1/user/organizations.json':
        return { organizationTitles: fixture.userOrgs?.[params.code] || [] };
      case '/v1/user/groups.json':
        return { groups: fixture.userGroups?.[params.code] || [] };
      case '/v1/group/users.json': {
        const all = fixture.groupUsers?.[params.code] || [];
        const offset = Number(params.offset) || 0;
        return { users: all.slice(offset, offset + (Number(params.size) || 100)) };
      }
      case '/v1/organizations.json': {
        const all = fixture.organizations || [];
        const offset = Number(params.offset) || 0;
        return { organizations: all.slice(offset, offset + (Number(params.size) || 100)) };
      }
      default:
        throw new Error(`假資料不支援 ${apiPath}`);
    }
  };
};

// ── 沙箱：載入原始模組 ───────────────────────────────────────────────────────

/**
 * @param {Function} api kintone.api 替身
 * @param {number} appId 請款單 App ID（config 的 APPS.PAYMENT 由它決定）
 */
const createAuditSandbox = (api, appId) => {
  // 登入者給一個不在管理員名單的代碼：「非排除群組勾手動」的檢查才不會因管理員身分略過
  // kintone.api 有 Promise 與 callback（第 4、5 個參數）兩種寫法，模組兩種都有用
  const kintoneApi = (p, method, params, onSuccess, onError) => {
    const task = Promise.resolve().then(() => api(p, method, params));
    if (typeof onSuccess !== 'function') return task;
    task.then(onSuccess, (err) => (typeof onError === 'function' ? onError(err) : undefined));
    return undefined;
  };
  const env = createEnv({ appId, loginCode: '__audit__', api: kintoneApi });
  env.load(MODULES[0]);
  const C = env.window.PR_CONFIG;

  // PR_COST_CENTER：與 payment_request_main 的 loadCostCenterMaps 同一個查詢與對照方式
  let loaded = null;
  const maps = { validCodes: new Set(), deptsOfCode: {}, deptNames: {} };
  env.window.PR_COST_CENTER = Object.freeze({
    ensureLoaded: () => {
      if (!loaded) {
        const CC = C.REF_FIELDS.COST_CENTER;
        loaded = env.window.PR_KT.fetchAllRecords({ app: C.APPS.COST_CENTER, fields: [CC.CODE, CC.NAME, CC.DEPT], query: `${CC.IN_USE} in ("使用中")` }).then((records) => {
          records.forEach((r) => {
            const raw = r[CC.CODE]?.value?.trim();
            if (!raw) return;
            maps.validCodes.add(raw);
            const code = raw.toUpperCase();
            (r[CC.DEPT]?.value || []).forEach((dept) => {
              if (!dept?.code) return;
              const depts = (maps.deptsOfCode[code] = maps.deptsOfCode[code] || []);
              if (!depts.includes(dept.code)) depts.push(dept.code);
              maps.deptNames[dept.code] = dept.name || dept.code;
            });
          });
        });
        loaded.catch(() => {
          loaded = null;
        });
      }
      return loaded;
    },
    getValidCodes: () => maps.validCodes,
    getDeptsOfCode: () => maps.deptsOfCode,
    getDeptNames: () => maps.deptNames,
  });

  MODULES.slice(1).forEach((file) => env.load(file));
  return { env, C };
};

// ── 比對 ────────────────────────────────────────────────────────────────────

/** 欄位值 → 比對用的鍵與顯示文字 */
const describe = (value) => {
  if (Array.isArray(value)) {
    const items = value.filter(Boolean).map((u) => (typeof u === 'object' ? { code: String(u.code ?? ''), name: String(u.name ?? u.code ?? '') } : { code: String(u), name: String(u) }));
    return {
      key: items.map((u) => u.code).sort().join(','),
      text: items.map((u) => (u.name && u.name !== u.code ? `${u.name}(${u.code})` : u.code)).join('、'),
    };
  }
  const s = value === undefined || value === null ? '' : String(value);
  return { key: s, text: s };
};

/** 規則訊息裡的 markdown 粗體、換行整理成一行 */
const plain = (msg) =>
  String(msg)
    .replace(/\*\*/g, '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' / ');

/** 要比對的欄位（全部取自 config，不在這裡寫欄位代碼） */
const compareFields = (C) => [
  ...C.DIRECTOR_UPLINE.CLEAR_FIELDS,
  C.DIRECTOR_UPLINE.SLOT,
  C.DIRECTOR_UPLINE.COUNT_FIELDS.MANAGER,
  C.DIRECTOR_UPLINE.COUNT_FIELDS.DEPUTY,
  C.FIELDS.ACCOUNTING_UNIT,
  C.FIELDS.ACCOUNTING_STAFF,
  C.FIELDS.PERMISSION_STAFF,
];

/**
 * 稽核一筆記錄。
 * @returns {Promise<Array<{kind:string, field:string, actual:string, expected:string, note:string}>>}
 */
const auditRecord = async ({ env, C }, record) => {
  const F = C.FIELDS;
  const w = env.window;
  if (record[C.VOID_FIELD]?.value?.length > 0) return [];

  const clone = JSON.parse(JSON.stringify(record));
  // 清空狀態：applyOnSave 等只在可編輯狀態重算，稽核要對每一張都算
  if (clone[F.STATUS_FIELD]) clone[F.STATUS_FIELD].value = '';
  else clone[F.STATUS_FIELD] = { type: 'STATUS', value: '' };

  const findings = [];
  const ruleErrors = [];
  // 與 payment_request_submit 存檔時相同的呼叫；依序執行（簽核格只會被其中一支寫）
  ruleErrors.push(...(await w.PR_SIGNING_CHAIN.applyOnSave(clone)));
  ruleErrors.push(...(await w.PR_SIGNING_CHAIN.applyAccountingOnSave(clone)));
  ruleErrors.push(...(await w.PR_DIRECTOR_UPLINE.apply(clone)));
  ruleErrors.push(...(await w.PR_COST_SCOPE.validate(clone)));

  ruleErrors.forEach((msg) => findings.push({ kind: '規則', field: '', actual: '', expected: '', note: plain(msg) }));

  const isManual = record[F.MANUAL_FLOW]?.value?.length > 0;
  if (isManual) {
    findings.push({ kind: '手動', field: F.MANUAL_FLOW, actual: '已勾選', expected: '', note: '簽核人由申請人自選，無法重算；請確認申請人在排除群組' });
  }

  compareFields(C).forEach((field) => {
    const a = describe(record[field]?.value);
    const e = describe(clone[field]?.value);
    if (a.key !== e.key) findings.push({ kind: '差異', field, actual: a.text, expected: e.text, note: '' });
  });
  return findings;
};

/** 讀出請款單（$id 翻頁，不用 cursor） */
const fetchPaymentRecords = (env, appId, query) => env.window.PR_KT.fetchAllRecords({ app: appId, query, pageSize: PAGE_SIZE, maxPages: MAX_PAGES });

const userText = (v) => describe(v).text;

/**
 * 跑整個稽核。
 * @param {{ api: Function, appId: number, query?: string }} p
 * @returns {Promise<{ rows: Object[], summary: Object }>}
 */
const runAudit = async ({ api, appId, query = '' }) => {
  const sandbox = createAuditSandbox(api, appId);
  const { env, C } = sandbox;
  const F = C.FIELDS;
  const records = await fetchPaymentRecords(env, appId, query);
  const rows = [];
  const summary = { total: records.length, voided: 0, audited: 0, withDiff: 0, withRuleError: 0, manual: 0, failed: 0 };

  for (const record of records) {
    if (record[C.VOID_FIELD]?.value?.length > 0) {
      summary.voided += 1;
      continue;
    }
    summary.audited += 1;
    const status = record[F.STATUS_FIELD]?.value || '';
    const base = {
      id: record.$id?.value || '',
      recordNo: record[F.RECORD_NO]?.value || '',
      status,
      editable: env.window.PR_SIGNING_CHAIN.isEditableStatus(status) ? '是' : '否',
      applicant: userText(record[F.APPLICANT]?.value),
      owner: userText(record[F.EXPENSE_OWNER]?.value),
      ownerOrg: userText(record[F.EXPENSE_OWNER_ORG]?.value),
    };
    let findings;
    try {
      // eslint-disable-next-line no-await-in-loop
      findings = await auditRecord(sandbox, record);
    } catch (err) {
      summary.failed += 1;
      findings = [{ kind: '錯誤', field: '', actual: '', expected: '', note: `重算失敗：${err?.message || err}` }];
    }
    if (findings.some((f) => f.kind === '差異')) summary.withDiff += 1;
    if (findings.some((f) => f.kind === '規則')) summary.withRuleError += 1;
    if (findings.some((f) => f.kind === '手動')) summary.manual += 1;
    findings.forEach((f) => rows.push({ ...base, ...f }));
  }
  return { rows, summary, logs: env.logs };
};

// ── 報表 ────────────────────────────────────────────────────────────────────

const COLUMNS = [
  ['id', '$id'],
  ['recordNo', '單號'],
  ['status', '狀態'],
  ['editable', '可編輯狀態'],
  ['applicant', '申請人'],
  ['owner', '費用所屬人'],
  ['ownerOrg', '費用所屬人部門'],
  ['kind', '種類'],
  ['field', '欄位'],
  ['actual', '存檔值'],
  ['expected', '重算值'],
  ['note', '說明'],
];

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV（UTF-8 BOM，Excel 直接開不會亂碼） */
const toCsv = (rows) => `﻿${[COLUMNS.map((c) => c[1]), ...rows.map((r) => COLUMNS.map((c) => r[c[0]]))].map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;

const mdCell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const toMarkdown = (rows, summary, { appId, query, generatedAt }) => {
  const lines = [
    '# 簽核人員／會計單位稽核報表',
    '',
    `- 產生時間：${generatedAt}`,
    `- App：${appId}${query ? `　條件：\`${query}\`` : ''}`,
    `- 記錄 ${summary.total} 筆（作廢略過 ${summary.voided}、稽核 ${summary.audited}）`,
    `- 簽核／會計欄位有差異：**${summary.withDiff}** 筆；規則不符：**${summary.withRuleError}** 筆；手動簽核：${summary.manual} 筆；重算失敗：${summary.failed} 筆`,
    '',
    '判讀：「可編輯狀態＝是」的單存檔時前端會重算，有差異多半是繞過前端（API／CSV／手機版／開發者工具）；',
    '「否」的單是送出時的值，主檔或組織事後異動也會出現差異，請對照更新時間與主檔異動紀錄。',
    '',
  ];
  if (rows.length === 0) {
    lines.push('沒有發現差異。');
  } else {
    lines.push(`| ${COLUMNS.map((c) => c[1]).join(' | ')} |`, `| ${COLUMNS.map(() => '---').join(' | ')} |`);
    rows.forEach((r) => lines.push(`| ${COLUMNS.map((c) => mdCell(r[c[0]])).join(' | ')} |`));
  }
  return `${lines.join('\n')}\n`;
};

const timestamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** 寫出 CSV 與 Markdown，回傳兩個檔案路徑 */
const writeReports = ({ rows, summary }, { outDir = DEFAULT_OUT_DIR, appId, query, now = new Date() }) => {
  fs.mkdirSync(outDir, { recursive: true });
  const stem = path.join(outDir, `signers_audit_${appId}_${timestamp(now)}`);
  fs.writeFileSync(`${stem}.csv`, toCsv(rows), 'utf8');
  fs.writeFileSync(`${stem}.md`, toMarkdown(rows, summary, { appId, query, generatedAt: now.toISOString() }), 'utf8');
  return { csv: `${stem}.csv`, md: `${stem}.md` };
};

// ── CLI ─────────────────────────────────────────────────────────────────────

const parseArgs = (argv) => {
  const out = { query: '', outDir: DEFAULT_OUT_DIR, fixture: null, app: null, failOnDiff: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} 後面要接值`);
      i += 1;
      return argv[i];
    };
    if (a === '--query') out.query = next();
    else if (a === '--out') out.outDir = path.resolve(next());
    else if (a === '--fixture') out.fixture = path.resolve(next());
    else if (a === '--app') out.app = Number(next());
    else if (a === '--fail-on-diff') out.failOnDiff = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`不認得的參數：${a}（--help 看用法）`);
  }
  return out;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    const src = fs.readFileSync(__filename, 'utf8');
    console.log(src.slice(src.indexOf('// 用法'), src.indexOf('// =====', src.indexOf('// 用法'))).replace(/^\/\/ ?/gm, ''));
    return 0;
  }
  const appId = args.app || Number(process.env.KINTONE_APP_ID) || DEFAULT_APP_ID;
  let api;
  if (args.fixture) {
    const fixture = JSON.parse(fs.readFileSync(args.fixture, 'utf8'));
    // 先載一次 config 取 App 對照（APPS.PAYMENT 以外是固定值）
    const { C } = createAuditSandbox(() => Promise.reject(new Error('unused')), appId);
    api = makeFixtureApi(fixture, { apps: C.APPS, paymentAppId: appId });
  } else {
    api = makeLiveApi({
      baseUrl: process.env.KINTONE_BASE_URL,
      apiToken: process.env.KINTONE_API_TOKEN,
      username: process.env.KINTONE_USERNAME,
      password: process.env.KINTONE_PASSWORD,
    });
  }
  const result = await runAudit({ api, appId, query: args.query });
  if (args.verbose) ['log', 'warn', 'error'].forEach((level) => result.logs[level].forEach((m) => console.log(`[${level}] ${m}`)));
  const files = writeReports(result, { outDir: args.outDir, appId, query: args.query });
  const s = result.summary;
  console.log(`稽核 ${s.audited} 筆（作廢略過 ${s.voided}）：欄位差異 ${s.withDiff} 筆、規則不符 ${s.withRuleError} 筆、手動 ${s.manual} 筆、重算失敗 ${s.failed} 筆`);
  console.log(`報表：${path.relative(rootDir, files.csv)}`);
  console.log(`      ${path.relative(rootDir, files.md)}`);
  return args.failOnDiff && (s.withDiff > 0 || s.withRuleError > 0) ? 2 : 0;
};

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`稽核失敗：${err?.message || err}\n`);
      process.exit(1);
    },
  );
}

module.exports = { runAudit, auditRecord, createAuditSandbox, makeLiveApi, makeFixtureApi, matchQuery, toCsv, toMarkdown, writeReports, parseArgs, describe };
