'use strict';

// 測試：舊單補登記腳本（scripts/backfill.cjs），用假的 fetch，不連 kintone
// 單獨執行：node plugins/invoice-registry/tests/backfill.test.cjs

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs, plan, run } = require('../scripts/backfill.cjs');

let passed = 0;
const queue = [];
const check = (label, fn) => queue.push({ label, fn });

const ARGV = ['--app', '749', '--registry', '757', '--field', '發票號碼記錄', '--status-field', '狀態', '--void-status', '表單作廢', '--void-check', '表單作廢'];
const ENV = { KINTONE_BASE_URL: 'https://example.cybozu.com/', KINTONE_API_TOKEN: 'T1,T2' };
const rec = (id, agg, status = '報銷人填單', check = []) => ({ $id: { value: String(id) }, 發票號碼記錄: { value: agg }, 狀態: { value: status }, 表單作廢: { value: check } });
const row = (id, no, app, owner, voided = '') => ({ $id: { value: String(id) }, invoice_number: { value: no }, app_id: { value: String(app) }, request_record_number: { value: String(owner) }, voided: { value: voided } });

check('參數：--void-status 可重複或逗號分隔；--apply 是開關', () => {
  const a = parseArgs([...ARGV, '--void-status', '取消,退回', '--apply']);
  assert.deepStrictEqual(a.voidStatuses, ['表單作廢', '取消', '退回']);
  assert.strictEqual(a.apply, true);
  assert.strictEqual(parseArgs(ARGV).apply, false);
  assert.throws(() => parseArgs(['749']), /看不懂/);
});

check('計畫：作廢的單不算；同號碼給最小記錄編號、另列衝突；已登記給本單略過；登記給別張單列衝突', () => {
  const args = parseArgs(ARGV);
  const records = [
    rec(9, ' / ab1 / CD2 / '),
    rec(3, ' / AB1 / '),
    rec(4, ' / EF3 / ', '表單作廢'),
    rec(5, ' / GH4 / ', '報銷人填單', ['作廢']),
    rec(6, ' / IJ5 / '),
    rec(7, ' / KL6 / '),
  ];
  const rows = [row(50, 'IJ5', 749, 6), row(51, 'KL6', 723, 2), row(52, 'CD2', 749, 9, '是')];
  const p = plan({ records, rows, args });
  assert.deepStrictEqual(p.toAdd, [
    { no: 'AB1', id: '3' },
    { no: 'CD2', id: '9' },
  ]);
  assert.strictEqual(p.already, 1);
  assert.deepStrictEqual(
    p.conflicts.map((c) => [c.no, c.type, c.ids.join('、'), c.registered]),
    [
      ['AB1', '同 App 多張單用同一號碼', '3、9', ''],
      ['KL6', '已登記給其他單據', '7', 'App 723 記錄 2（登記 51）'],
    ],
  );
});

const fakeFetch = ({ records, rows, failNos = [] }) => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, method: opts.method, override: opts.headers['X-HTTP-Method-Override'], token: opts.headers['X-Cybozu-API-Token'], body });
    const ok = (json) => ({ ok: true, status: 200, json: async () => json });
    if (opts.headers['X-HTTP-Method-Override'] === 'GET') {
      const after = Number((body.query.match(/\$id > (\d+)/) || [])[1]);
      const src = String(body.app) === '757' ? rows : records;
      return ok({ records: src.filter((r) => Number(r.$id.value) > after) });
    }
    if (body.records.some((r) => failNos.includes(r.invoice_number.value))) return { ok: false, status: 400, json: async () => ({ code: 'CB_VA01', message: '重複' }) };
    return ok({ ids: body.records.map(() => '1') });
  };
  return { calls, fetchImpl };
};

check('執行：沒加 --apply 只讀不寫，產生報表（UTF-8 BOM、Excel 可開）；用 API token 與 method override 讀', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-ir-backfill-'));
  const { calls, fetchImpl } = fakeFetch({ records: [rec(3, ' / AB1 / CD2 / ')], rows: [] });
  const logs = [];
  const s = await run({ argv: ARGV, env: ENV, fetchImpl, log: (m) => logs.push(m), outDir, now: () => new Date('2026-11-19T10:00:00Z') });
  assert.deepStrictEqual([s.toAdd, s.added, s.conflicts], [2, 0, 0]);
  assert.ok(calls.every((c) => c.override === 'GET' && c.token === 'T1,T2'), '預覽只有讀取');
  assert.strictEqual(calls[0].url, 'https://example.cybozu.com/k/v1/records.json');
  assert.ok(calls[0].body.query.startsWith('(狀態 not in ("表單作廢")) and $id > 0'), calls[0].body.query);
  const csv = fs.readFileSync(s.report, 'utf8');
  assert.ok(csv.startsWith('﻿"發票號碼"') && csv.includes('"AB1","預覽：會登記","3"'), csv);
  assert.ok(path.basename(s.report) === 'backfill_749_20261119-100000.csv');
  assert.ok(logs.join('\n').includes('加 --apply'));
});

check('執行：--apply 分批新增；整批失敗改一筆一筆，失敗的寫進報表；缺參數或環境變數 → 丟錯', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-ir-backfill-'));
  const { calls, fetchImpl } = fakeFetch({ records: [rec(3, ' / AB1 / CD2 / ')], rows: [], failNos: ['CD2'] });
  const s = await run({ argv: [...ARGV, '--apply'], env: ENV, fetchImpl, log: () => {}, outDir });
  assert.deepStrictEqual([s.added, s.failed], [1, 1]);
  const posts = calls.filter((c) => !c.override);
  assert.deepStrictEqual(posts.map((c) => c.body.records.length), [2, 1, 1]);
  assert.deepStrictEqual(posts[1].body.records[0], { invoice_number: { value: 'AB1' }, app_id: { value: '749' }, request_record_number: { value: '3' }, storage_key: { value: 'backfill' } });
  assert.ok(fs.readFileSync(s.report, 'utf8').includes('"CD2","失敗：CB_VA01 重複"'));
  await assert.rejects(run({ argv: ['--app', '749'], env: {}, fetchImpl, log: () => {}, outDir }), /--registry[\s\S]*--field[\s\S]*KINTONE_BASE_URL/);
});

(async () => {
  console.log('backfill.test.cjs（發票登記 舊單補登記）');
  for (const { label, fn } of queue) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok - ${label}`);
    } catch (err) {
      console.log(`  not ok - ${label}`);
      console.error(err);
      process.exit(1);
    }
  }
  console.log(`\n${passed} assertions passed.`);
})();
