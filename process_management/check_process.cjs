'use strict';

// 檢查一份流程管理設定（kintone 後台匯出的 JSON，格式同 GET /k/v1/app/status.json）。
// 用法：
//   node process_management/check_process.cjs [檔案路徑]
//   npm run check:process                      檢查 process_management/exports/ 裡 revision 最大的 749_rev*.json
//   node process_management/check_process.cjs process_management/exports/749_rev1791.json
//
// 做三件事：
//   1. 結構檢查（tests/lib/process_lint.cjs）：狀態、動作、作業者欄位、條件值有沒有寫錯
//   2. 全部走一遍（tests/lib/process_exhaustive.cjs）：每一種合法的假資料從申請開始走到會計，
//      每一關要剛好一顆送出按鈕、作業者要找得到人、最後停在對的會計狀態
//   3. 每個狀態的按鈕（tests/lib/process_buttons.cjs）：把所有作業者按鈕（含駁回、再申請、轉至其他會計、入帳完成）
//      都按過一遍，每個狀態要有送出按鈕、而且不會有兩顆；會計狀態分傳票日期空白、已填（今年）兩種情況檢查，
//      並另外列出「傳票日期填去年」「條件永遠不成立的動作」這些不算失敗、但該知道的事
//
// 有任何結構問題、走流程問題或按鈕問題，結束代碼是 1。

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./load_config.cjs');
const { lintProcess } = require('../tests/lib/process_lint.cjs');
const { checkAll } = require('../tests/lib/process_exhaustive.cjs');
const { checkButtons } = require('../tests/lib/process_buttons.cjs');

const MAX_GROUPS = 20;
const EXPORTS_DIR = path.join(__dirname, 'exports');
const EXPORT_PATTERN = /^749_rev(\d+)\.json$/;

/** exports 裡 revision 最大的 749 流程檔 */
const latestExport = (dir = EXPORTS_DIR) => {
  const found = fs
    .readdirSync(dir)
    .map((name) => ({ name, rev: Number((EXPORT_PATTERN.exec(name) || [])[1]) }))
    .filter((f) => Number.isFinite(f.rev))
    .sort((a, b) => b.rev - a.rev);
  if (found.length === 0) throw new Error(`${dir} 裡沒有 749_rev<revision>.json，請先從 kintone 匯出流程管理設定放進去`);
  return path.join(dir, found[0].name);
};

const parseArgs = (argv) => ({ file: argv[0] ? path.resolve(argv[0]) : latestExport() });

const readProcess = (file) => {
  let proc;
  try {
    proc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`讀不到流程管理設定「${file}」：${e.message}`);
  }
  if (!proc || typeof proc.states !== 'object' || !Array.isArray(proc.actions)) {
    throw new Error(`「${file}」不是流程管理設定（要有 states 和 actions）`);
  }
  return proc;
};

// 把同一類的問題併成一組：拿掉「經過…」的路徑，會計狀態名稱統一
const groupKey = (message) => message.replace(/；經過.*/, '').replace(/單位會計處理中\([^)]*\)/g, '單位會計處理中(…)');

const printGroups = (failures, indent) => {
  const groups = new Map();
  failures.forEach((f) => {
    const key = groupKey(f.message);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  });
  [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_GROUPS)
    .forEach(([message, list]) => {
      console.log(`${indent}${list.length} 筆：${message}`);
      console.log(`${indent}  例：${list[0].id}`);
    });
  if (groups.size > MAX_GROUPS) console.log(`${indent}…還有 ${groups.size - MAX_GROUPS} 類沒列出`);
};

const main = () => {
  const opts = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const proc = readProcess(opts.file);
  const rel = (f) => path.relative(path.join(__dirname, '..'), f) || f;

  console.log(`檢查：${rel(opts.file)}（revision ${proc.revision ?? '?'}）`);
  console.log(`狀態 ${Object.keys(proc.states).length} 個、動作 ${proc.actions.length} 條`);

  // 1. 結構檢查
  const problems = lintProcess(proc, config);
  console.log(`\n[1] 結構檢查：${problems.length === 0 ? '沒有問題' : `${problems.length} 個問題`}`);
  problems.forEach((p) => console.log(`  - ${p}`));

  // 2. 全部走一遍
  const started = Date.now();
  const { total, failures } = checkAll(proc, config);
  console.log(`\n[2] 全部走一遍：${total} 種假資料，${Date.now() - started} 毫秒`);
  console.log(`  走不通或作業者找不到人：${failures.length} 筆`);
  if (failures.length > 0) {
    console.log(`  問題（最多列前 ${MAX_GROUPS} 類）：`);
    printGroups(failures, '    ');
  }

  // 3. 每個狀態的按鈕
  const startedButtons = Date.now();
  const buttons = checkButtons(proc, config);
  console.log(`
[3] 每個狀態的按鈕：${buttons.total} 種假資料，走到 ${buttons.reached.size} 個狀態，${Date.now() - startedButtons} 毫秒`);
  console.log(`  按鈕有問題：${buttons.failures.length} 筆`);
  if (buttons.failures.length > 0) {
    console.log(`  問題（最多列前 ${MAX_GROUPS} 類）：`);
    printGroups(buttons.failures, '    ');
  }
  if (buttons.notes.length > 0) {
    console.log('  注意（不算失敗，但請確認這是想要的行為）：');
    buttons.notes.forEach((n) => console.log(`    - ${n}`));
  }
  if (buttons.unusedActions.length > 0) {
    console.log(`  沒有任何假資料按得到的動作（條件永遠不成立或被前面擋掉，不算失敗）：${buttons.unusedActions.length} 條`);
    buttons.unusedActions.forEach((a) => console.log(`    - ${a}`));
  }
  console.log(`  預期走不到的狀態（初始狀態、只有作廢才到的狀態）：${buttons.expected.join('、') || '（無）'}`);
  console.log(`  其他沒有任何資料走得到的狀態（資訊用，不算失敗）：${buttons.unreached.join('、') || '（無）'}`);

  const ok = problems.length === 0 && failures.length === 0 && buttons.failures.length === 0;
  console.log(`\n${ok ? '通過' : '未通過'}`);
  process.exit(ok ? 0 : 1);
};

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { latestExport, groupKey, readProcess };
