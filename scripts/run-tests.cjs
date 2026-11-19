#!/usr/bin/env node
/**
 * 測試執行器：自動找 tests/*.test.cjs 與 plugins/*\/tests/*.test.cjs，
 * 每支各開一個 node 程序跑，失敗也繼續跑完，最後印總結；有任何失敗就 exit 1。
 *
 * 用法：
 *   npm test                      跑全部
 *   npm test -- signing           只跑路徑含 "signing" 的檔（可給多個關鍵字）
 *   npm test -- --verbose         每支都印完整輸出（預設只印失敗那支的輸出）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const filters = args.filter(a => !a.startsWith('-'));

function listTests(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter(f => f.endsWith('.test.cjs'))
    .sort()
    .map(f => path.posix.join(dir, f));
}

function discover() {
  const files = listTests('tests');
  const pluginsDir = path.join(ROOT, 'plugins');
  if (fs.existsSync(pluginsDir)) {
    for (const p of fs.readdirSync(pluginsDir).sort()) {
      if (fs.statSync(path.join(pluginsDir, p)).isDirectory()) {
        files.push(...listTests(`plugins/${p}/tests`));
      }
    }
  }
  return files;
}

// 測試檔最後一行慣例：「N assertions passed.」或「N 項斷言全部通過」
const PASS_RE = /(\d+)\s*(?:assertions passed|項斷言全部通過)/;

let files = discover();
if (filters.length) files = files.filter(f => filters.some(k => f.includes(k)));
if (!files.length) {
  console.error('找不到符合的測試檔。');
  process.exit(1);
}

const results = [];
const t0 = Date.now();
for (const file of files) {
  const start = Date.now();
  const r = spawnSync(process.execPath, [file], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(new RegExp(PASS_RE.source, 'g'));
  const assertions = m ? m.reduce((s, x) => s + Number(x.match(PASS_RE)[1]), 0) : 0;
  const ok = r.status === 0 && !r.error;
  const ms = Date.now() - start;
  results.push({ file, ok, assertions, ms, status: r.status, signal: r.signal });

  const mark = ok ? 'PASS' : 'FAIL';
  const note = ok
    ? (m ? `${assertions} 項` : '（沒印斷言數）')
    : `exit ${r.status === null ? r.signal : r.status}`;
  console.log(`${mark}  ${file}  ${note}  ${ms}ms`);
  if (!ok || verbose) {
    const body = (r.error ? String(r.error) + '\n' : '') + out.trimEnd();
    console.log(body.split('\n').map(l => '    ' + l).join('\n'));
  }
}

const failed = results.filter(x => !x.ok);
const total = results.reduce((s, x) => s + x.assertions, 0);
console.log('\n' + '-'.repeat(60));
console.log(`測試檔：${results.length} 支，通過 ${results.length - failed.length}，失敗 ${failed.length}`);
console.log(`斷言：${total} 項（通過的檔案合計 ${results.filter(x => x.ok).reduce((s, x) => s + x.assertions, 0)} 項）`);
console.log(`耗時：${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (failed.length) {
  console.log('\n失敗：');
  for (const f of failed) console.log(`  - ${f.file}`);
  process.exit(1);
}
