'use strict';
// 掃描全 repo *.js 中仍剩餘的硬編碼字面值（欄位代碼 / App ID / 狀態 / 選項 / space ID / change 事件…）
// 對照 payment_request_config.js（window.PR_CONFIG）已收斂的常數，找出尚未接線之處。
// 規則 1（App ID）刻意連註解一起掃：註解請寫常數名（如 APPS.APPROVAL_FLOW），不要寫 App 的數字。
// 用法：node tests/scan_hardcoded.cjs
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const EXCLUDE_FILES = new Set(['payment_request_config.js', 'vite.config.js']);
const files = fs
  .readdirSync(rootDir)
  .filter((f) => f.endsWith('.js') && !EXCLUDE_FILES.has(f));

const cfgSrc = fs.readFileSync(path.join(rootDir, 'payment_request_config.js'), 'utf8');

// ── 從 config 源檔動態抽取已註冊的字面值，避免規則與 config 漂移 ──────────────
const extractQuoted = (block) => [...new Set([...block.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]))];

// 依 config 的宣告順序切片：APPS → ACCOUNTING …，STATUS → ACTIONS …，OPTIONS → 共用工具
const sliceBetween = (from, to) => {
  const start = cfgSrc.indexOf(from);
  const end = cfgSrc.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`scan_hardcoded：config 找不到「${from}」到「${to}」這一段，請同步更新本檔的切片標記`);
  return cfgSrc.slice(start, end);
};

const APP_IDS = [...sliceBetween('const APPS', 'const ACCOUNTING').matchAll(/:\s*(\d{3,4})\s*,/g)].map((m) => Number(m[1]));
const STATUS = extractQuoted(sliceBetween('const STATUS', 'const ACTIONS'));
const OPTIONS = extractQuoted(sliceBetween('const OPTIONS', '// ── 共用工具'));
const ADMINS = extractQuoted(sliceBetween('const ADMIN_USERS', 'const SUPER_ADMIN'));
const ACC_CODES = extractQuoted(cfgSrc.slice(cfgSrc.indexOf('MAP: Object.freeze'), cfgSrc.indexOf('SPECIAL_CODES_AIRPORT')));

const results = {};
const add = (file, cat, line, text) => {
  results[cat] = results[cat] || {};
  results[cat][file] = results[cat][file] || [];
  results[cat][file].push({ line, text: text.trim().slice(0, 160) });
};

const usesConfig = {};

for (const file of files) {
  const full = path.join(rootDir, file);
  if (fs.statSync(full).isDirectory()) continue;
  const src = fs.readFileSync(full, 'utf8');
  const lines = src.split(/\r?\n/);
  usesConfig[file] = (src.match(/PR_CONFIG/g) || []).length;

  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw;
    const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);

    // 1. App ID 硬編碼（含 console/comment 內殘留，故不排除註解行；同一行多次命中只計一次）
    {
      const hits = new Set();
      const patterns = [
        /\b(?:app|appId|APP_ID)\s*[:=]\s*(\d{3,4})\b/g,
        /['"`]\/k\/(\d{3,4})/g,
        /[Aa]pp[\s=_]?(\d{3,4})\b/g,
      ];
      for (const re of patterns) {
        let mm;
        while ((mm = re.exec(line)) !== null) hits.add(Number(mm[1]));
      }
      if ([...hits].some((num) => APP_IDS.includes(num))) add(file, '1_APP_ID', n, line);
    }

    if (isComment) return; // 以下規則只看可執行程式碼行

    // 3. 流程狀態字串
    for (const s of STATUS) {
      if (new RegExp(`['"\`]${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(line) && !line.includes('STATUS.')) {
        add(file, '3_STATUS', n, line);
        break;
      }
    }

    // 4. 欄位選項值
    for (const o of OPTIONS) {
      if (new RegExp(`['"\`]${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(line) && !line.includes('OPTIONS.')) {
        add(file, '4_OPTION', n, line);
        break;
      }
    }

    // 5. 白名單帳號
    for (const a of ADMINS) {
      if (new RegExp(`['"\`]${a}['"\`]`).test(line) && !line.includes('ADMIN_USERS') && !line.includes('isAdmin')) {
        add(file, '5_ADMIN_USER', n, line);
        break;
      }
    }

    // 6. 會計單位代碼
    for (const a of ACC_CODES) {
      if ((line.includes(`'${a}'`) || line.includes(`"${a}"`)) && !line.includes('ACCOUNTING.')) {
        add(file, '6_ACCOUNTING', n, line);
        break;
      }
    }

    // 8-a. 外部資源 URL
    if (/https?:\/\//.test(line)) add(file, '8a_URL', n, line);

    // 8-b. 欄位代碼硬編碼：record[...] / row.value[...]
    if (/(?:record|row\.value|rec|r)\[\s*['"][^'"]+['"]\s*\]/.test(line) && !line.includes('FIELDS.')) {
      add(file, '8b_FIELD_bracket', n, line);
    }
    // 8-c. getFieldElement / getSpaceElement / setFieldShown 字面值
    const domM = line.match(/(?:getFieldElement|getSpaceElement|setFieldShown|setFieldRequired)\(\s*['"]([^'"]+)['"]/);
    if (domM && !line.includes('FIELDS.') && !line.includes('SPACES.')) add(file, '8c_FIELD_dom', n, line);
    // 8-d. data-field-code selector
    if (/data-field-code=/.test(line)) add(file, '8d_FIELD_selector', n, line);
    // 8-e. change 事件欄位名（樣板字串外的字面值）
    if (/app\.record\.(?:create|edit|index\.edit)\.change\.[^$`]/.test(line)) add(file, '8e_EVENT_change_literal', n, line);

    // 其他：分隔符 / 固定文字
    if (/['"`]\s\/\s['"`]/.test(line) && !line.includes('SEP')) add(file, 'x_SEP', n, line);
  });
}

const out = [];
out.push('=== PR_CONFIG 引用次數（0 = 完全未接線）===');
Object.entries(usesConfig)
  .sort((a, b) => a[1] - b[1])
  .forEach(([f, c]) => out.push(`${String(c).padStart(4)}  ${f}`));

out.push('\n=== 各類硬編碼統計 ===');
let grandTotal = 0;
for (const cat of Object.keys(results).sort()) {
  const per = Object.entries(results[cat])
    .map(([f, arr]) => [f, arr.length])
    .sort((a, b) => b[1] - a[1]);
  const total = per.reduce((s, x) => s + x[1], 0);
  grandTotal += total;
  out.push(`\n--- ${cat} (總計 ${total}) ---`);
  per.forEach(([f, c]) => out.push(`  ${String(c).padStart(4)}  ${f}`));
}
out.push(`\n總計: ${grandTotal}`);

console.log(out.join('\n'));

if (process.argv.includes('--json')) {
  fs.writeFileSync(path.join(__dirname, 'scan_hardcoded.report.json'), JSON.stringify(results, null, 1), 'utf8');
  console.log('\n詳細結果已輸出至 tests/scan_hardcoded.report.json');
}
