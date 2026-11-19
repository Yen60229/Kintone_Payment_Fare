'use strict';

// 回歸測試：tools/audit/audit_signers.cjs（簽核人員／會計單位稽核，唯讀）
//   用 tests/fixtures/audit_signers.json 的假資料跑（不連線），確認：
//   重算結果與存檔值比對、規則錯誤、手動與作廢的處理、只送 GET、憑證不外洩、報表格式、CLI 結束代碼。
// 直接用 Node 執行：node tests/audit_signers.test.cjs

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createRunner, rootDir } = require('./lib/pr_env.cjs');
const audit = require('../tools/audit/audit_signers.cjs');

const FIXTURE_FILE = path.join(__dirname, 'fixtures', 'audit_signers.json');
const loadFixture = () => JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
const APP_ID = 749;

const { C } = audit.createAuditSandbox(() => Promise.reject(new Error('unused')), APP_ID);
const F = C.FIELDS;
const fixtureApi = (fixture) => audit.makeFixtureApi(fixture, { apps: C.APPS, paymentAppId: APP_ID });
const run = (fixture = loadFixture()) => audit.runAudit({ api: fixtureApi(fixture), appId: APP_ID });
const rowsOf = (rows, id) => rows.filter((r) => r.id === String(id));

const t = createRunner('audit_signers.test.cjs');

t.check('假資料：7 筆、作廢略過 1、差異 1、規則 3、手動 1、失敗 0', async () => {
  const { summary } = await run();
  assert.deepStrictEqual(summary, { total: 7, voided: 1, audited: 6, withDiff: 1, withRuleError: 3, manual: 1, failed: 0 });
});

t.check('一致的單（一般主管鏈、對照表部長）沒有任何列；作廢的單不列', async () => {
  const { rows } = await run();
  assert.deepStrictEqual(rowsOf(rows, 1), []);
  assert.deepStrictEqual(rowsOf(rows, 6), []);
  assert.deepStrictEqual(rowsOf(rows, 5), []);
});

t.check('簽核人被改（已送出）：列出主管1、部長、主管人數三個差異，重算值依簽核流程主檔', async () => {
  const { rows } = await run();
  const r2 = rowsOf(rows, 2);
  assert.deepStrictEqual(
    r2.map((r) => [r.kind, r.field, r.actual, r.expected]),
    [
      ['差異', '單位主管1', '', '課長甲(M1)'],
      ['差異', '單位部長_支店長', '自己人(X9)', '部長甲(H1)'],
      ['差異', '部門主管簽核人數', '0人', '1人'],
    ],
  );
  assert.ok(r2.every((r) => r.editable === '否' && r.status === '部長確認中'));
});

t.check('掛帳單位跨部：規則列（說明去掉 ** 粗體、換行併成一行）', async () => {
  const [row, ...rest] = rowsOf((await run()).rows, 3);
  assert.strictEqual(rest.length, 0);
  assert.strictEqual(row.kind, '規則');
  assert.match(row.note, /只能是費用所屬人的部內/);
  assert.match(row.note, /CC200/);
  assert.ok(!row.note.includes('**') && !row.note.includes('\n'));
});

t.check('非排除群組勾手動：規則列＋手動列（登入者不當管理員，不會被略過）', async () => {
  const r4 = rowsOf((await run()).rows, 4);
  assert.deepStrictEqual(r4.map((r) => r.kind), ['規則', '手動']);
  assert.match(r4[0].note, new RegExp(`「${F.MANUAL_FLOW}」只開放給`));
});

t.check('費用所屬人部門不是本人的：簽核、會計單位、同部門三條規則', async () => {
  const notes = rowsOf((await run()).rows, 7).map((r) => r.note);
  assert.strictEqual(notes.length, 3);
  assert.match(notes[0], /不是費用所屬人的所屬單位/);
  assert.match(notes[1], /找不到對應的會計單位/);
  assert.match(notes[2], /必須同部門/);
});

t.check('對照表部長的上一階主管被改：重算值是群組成員（扣掉本人）', async () => {
  const fixture = loadFixture();
  const r6 = fixture.records.find((r) => r.$id.value === '6');
  r6[C.DIRECTOR_UPLINE.SLOT].value = [{ code: 'U006', name: '部長己' }];
  const rows = rowsOf((await run(fixture)).rows, 6);
  assert.deepStrictEqual(rows.map((r) => [r.field, r.actual, r.expected]), [[C.DIRECTOR_UPLINE.SLOT, '部長己(U006)', '上階主管(H9)']]);
});

t.check('會計單位被改：列出會計單位與承辦人差異', async () => {
  const fixture = loadFixture();
  const r1 = fixture.records.find((r) => r.$id.value === '1');
  r1[F.ACCOUNTING_UNIT].value = [{ code: 'ACC_OTHER', name: 'ACC_OTHER' }];
  r1[F.ACCOUNTING_STAFF].value = [];
  const rows = rowsOf((await run(fixture)).rows, 1);
  assert.deepStrictEqual(rows.map((r) => [r.field, r.expected]), [
    [F.ACCOUNTING_UNIT, 'ACC_TPE'],
    [F.ACCOUNTING_STAFF, '會計甲(A1)'],
  ]);
});

t.check('不改到讀進來的記錄（重算用複本）', async () => {
  const fixture = loadFixture();
  const before = JSON.stringify(fixture.records);
  await run(fixture);
  assert.strictEqual(JSON.stringify(fixture.records), before);
});

t.check('簽核流程主檔讀不到：該筆列「無法安排簽核人員」，不會當成一致', async () => {
  const fixture = loadFixture();
  const base = fixtureApi(fixture);
  const api = (p, method, params) => (Number(params?.app) === C.APPS.APPROVAL_FLOW ? Promise.reject(new Error('boom')) : base(p, method, params));
  const { rows } = await audit.runAudit({ api, appId: APP_ID });
  const r1 = rowsOf(rows, 1);
  assert.strictEqual(r1.length, 1);
  assert.match(r1[0].note, /無法安排簽核人員/);
});

t.check('假資料查詢：= / in / $id > / limit；不支援的寫法丟錯', () => {
  const rec = { $id: { value: '5' }, A: { value: 'x' }, O: { value: [{ code: 'C1' }] } };
  assert.ok(audit.matchQuery(rec, 'A = "x"'));
  assert.ok(audit.matchQuery(rec, 'O in ("C0", "C1") and A in ("x")'));
  assert.ok(audit.matchQuery(rec, '(A = "x") and $id > 4 order by $id asc limit 500'));
  assert.ok(!audit.matchQuery(rec, '$id > 5'));
  assert.throws(() => audit.matchQuery(rec, 'A like "x"'), /不支援/);
});

t.check('只允許 GET：假資料與連線版都拒絕 PUT，連線版不會送出', async () => {
  await assert.rejects(fixtureApi(loadFixture())('/k/v1/record', 'PUT', {}), /只允許 GET/);
  let called = 0;
  const live = audit.makeLiveApi({ baseUrl: 'https://example.invalid', apiToken: 'tok', fetchImpl: async () => called++ });
  await assert.rejects(live('/k/v1/records', 'PUT', {}), /只允許 GET/);
  assert.strictEqual(called, 0);
});

t.check('連線版：/k/ 用 API token、/v1/ 用帳密；陣列參數展開；同樣查詢只打一次；錯誤訊息不含憑證', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers, method: opts.method });
    if (url.includes('fail')) return { ok: false, status: 403, json: async () => ({ message: 'denied', code: 'CB_NO02' }) };
    return { ok: true, status: 200, json: async () => ({ records: [] }) };
  };
  const live = audit.makeLiveApi({ baseUrl: 'https://example.invalid/', apiToken: 'TOKEN-A,TOKEN-B', username: 'admin', password: 'secret', fetchImpl });
  await live('/k/v1/records', 'GET', { app: 1, fields: ['a', 'b'], query: 'x = "1"' });
  await live('/k/v1/records', 'GET', { app: 1, fields: ['a', 'b'], query: 'x = "1"' });
  await live('/v1/user/organizations.json', 'GET', { code: 'U1' });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].method, 'GET');
  assert.ok(calls[0].url.startsWith('https://example.invalid/k/v1/records.json?'));
  assert.ok(decodeURIComponent(calls[0].url).includes('fields[0]=a&fields[1]=b'));
  assert.deepStrictEqual(calls[0].headers, { 'X-Cybozu-API-Token': 'TOKEN-A,TOKEN-B' });
  assert.deepStrictEqual(calls[1].headers, { 'X-Cybozu-Authorization': Buffer.from('admin:secret').toString('base64') });
  const err = await live('/k/v1/fail', 'GET', {}).catch((e) => e);
  assert.match(err.message, /403/);
  assert.ok(!/TOKEN|secret|admin:/.test(err.message));
});

t.check('連線版：缺網址或憑證直接報錯；只有 token 時打 /v1/ 會提示要帳密', async () => {
  assert.throws(() => audit.makeLiveApi({ apiToken: 't' }), /KINTONE_BASE_URL/);
  assert.throws(() => audit.makeLiveApi({ baseUrl: 'https://example.invalid' }), /缺少憑證/);
  const live = audit.makeLiveApi({ baseUrl: 'https://example.invalid', apiToken: 't', fetchImpl: async () => assert.fail('不該送出') });
  await assert.rejects(live('/v1/user/groups.json', 'GET', { code: 'U1' }), /KINTONE_USERNAME/);
});

t.check('CSV：UTF-8 BOM、逗號／引號／換行加引號', () => {
  const csv = audit.toCsv([{ id: '1', note: 'a,"b"\nc' }]);
  assert.ok(csv.startsWith('﻿$id,單號,'));
  assert.ok(csv.includes('"a,""b""\nc"'));
});

t.check('寫出報表：CSV＋Markdown 兩個檔，Markdown 有摘要與表格', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-audit-'));
  try {
    const result = await run();
    const files = audit.writeReports(result, { outDir, appId: APP_ID, query: '', now: new Date(2026, 10, 19, 9, 8, 7) });
    assert.strictEqual(path.basename(files.csv), 'signers_audit_749_20261119_090807.csv');
    const md = fs.readFileSync(files.md, 'utf8');
    assert.match(md, /欄位有差異：\*\*1\*\* 筆/);
    assert.match(md, /\| 2 \| TR-0002 \| 部長確認中 \| 否 \|/);
    assert.strictEqual(fs.readFileSync(files.csv, 'utf8').split('\r\n').filter(Boolean).length, 1 + result.rows.length);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

t.check('CLI：--fixture 不需憑證；--fail-on-diff 有差異時結束代碼 2；不認得的參數報錯', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-audit-cli-'));
  const env = { ...process.env, KINTONE_API_TOKEN: '', KINTONE_USERNAME: '', KINTONE_PASSWORD: '', KINTONE_BASE_URL: '' };
  const script = path.join(rootDir, 'tools', 'audit', 'audit_signers.cjs');
  try {
    const out = execFileSync(process.execPath, [script, '--fixture', FIXTURE_FILE, '--out', outDir], { env, encoding: 'utf8' });
    assert.match(out, /稽核 6 筆/);
    assert.strictEqual(fs.readdirSync(outDir).length, 2);
    let code = 0;
    try {
      execFileSync(process.execPath, [script, '--fixture', FIXTURE_FILE, '--out', outDir, '--fail-on-diff'], { env, stdio: 'pipe' });
    } catch (e) {
      code = e.status;
    }
    assert.strictEqual(code, 2);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  assert.throws(() => audit.parseArgs(['--nope']), /不認得的參數/);
  assert.throws(() => audit.parseArgs(['--query']), /後面要接值/);
});

t.check('預設輸出資料夾已列入 .gitignore；package.json 有 audit:signers', () => {
  const ignore = fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf8');
  assert.match(ignore, /^tools\/audit\/out\/$/m);
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts['audit:signers'], 'node tools/audit/audit_signers.cjs');
});

t.done();
