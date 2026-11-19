'use strict';

// 測試：發票登記 plug-in 核心（src/js/core.js）＋事件接線（src/js/desktop.js）＋設定檔格式
// 單獨執行：node plugins/invoice-registry/tests/core.test.cjs（或在 plug-in 資料夾 npm test）

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

let passed = 0;
const queue = [];
const check = (label, fn) => queue.push({ label, fn });

const THIS_APP = 749;
const REG_APP = 757;
const ME = 'E001';
const NOW = Date.parse('2026-11-19T10:00:00Z');
const minutesAgo = (m) => new Date(NOW - m * 60000).toISOString();
const plain = (x) => JSON.parse(JSON.stringify(x));

const RAW_CONFIG = {
  registryApp: String(REG_APP),
  pendingTtlMinutes: '10',
  fields: {},
  self: { invoiceField: '發票號碼記錄', statusField: '狀態', voidStatuses: ['表單作廢'], voidCheckField: '表單作廢' },
};

const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
};

/**
 * 假 kintone：只有發票登記 App（store）。rows：{ no, app, owner, token, created, creator, voided, reason }
 * fail：{ 'REG:GET': err, 'REG:POST': err, stealRevision: true, putFailTimes: n }
 */
const setup = ({ rows = [], fail = {}, config = RAW_CONFIG, loginUser = ME, storage = memoryStorage() } = {}) => {
  const calls = [];
  const store = [];
  let nextId = 100;
  let putFails = fail.putFailTimes || 0;
  const R = {};
  const kintone = {
    api: Object.assign(
      (url, method, params) => {
        calls.push({ url, method, params: plain(params) });
        assert.strictEqual(String(params.app), String(REG_APP), '只查發票登記 App，不查請款單');
        if (fail[`REG:${method}`]) return Promise.reject(fail[`REG:${method}`]);
        if (method === 'GET') {
          const q = params.query;
          let list;
          const inList = q.match(new RegExp(`${R.INVOICE} in \\(([^)]*)\\)`));
          if (inList) {
            const nos = [...inList[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
            list = store.filter((r) => nos.includes(r[R.INVOICE].value));
          } else {
            assert.ok(q.includes(`${R.VOIDED} not in ("是")`), '只看沒作廢的登記');
            const app = (q.match(new RegExp(`${R.OWNER_APP} = (\\d+)`)) || [])[1];
            const tok = (q.match(new RegExp(`${R.TOKEN} = "([^"]*)"`)) || [])[1];
            const id = (q.match(new RegExp(`${R.OWNER_ID} = "([^"]+)"`)) || [])[1];
            list = store.filter(
              (r) =>
                r[R.VOIDED]?.value !== '是' &&
                r[R.OWNER_APP].value === app &&
                ((tok !== undefined && r[R.TOKEN].value === tok && r[R.OWNER_ID].value === '') || (id !== undefined && r[R.OWNER_ID].value === id)),
            );
          }
          return Promise.resolve({ records: plain(list) });
        }
        if (method === 'POST') {
          if (params.records.some((rec) => store.some((r) => r[R.INVOICE].value === rec[R.INVOICE].value))) {
            return Promise.reject({ code: 'CB_VA01', message: '入力内容が正しくありません。' });
          }
          params.records.forEach((rec) =>
            store.push({
              $id: { value: String(nextId++) },
              $revision: { value: '1' },
              ...plain(rec),
              [R.CREATED]: { value: new Date(NOW).toISOString() },
              建立人: { type: 'CREATOR', value: { code: loginUser } },
            }),
          );
          return Promise.resolve({});
        }
        if (method === 'PUT') {
          if (fail.stealRevision) return Promise.reject({ code: 'GAIA_CO02', message: '版本號不符' });
          if (putFails > 0) {
            putFails -= 1;
            return Promise.reject(new Error('network'));
          }
          params.records.forEach(({ id, revision, record }) => {
            const row = store.find((r) => r.$id.value === id);
            if (revision !== undefined) assert.strictEqual(revision, row.$revision.value, '作廢要帶目前的版本號');
            Object.assign(row, plain(record));
            row.$revision = { value: String(Number(row.$revision?.value || 1) + 1) };
          });
          return Promise.resolve({});
        }
        return Promise.reject(new Error(`未預期 ${method}`));
      },
      { url: (p) => p },
    ),
  };
  const sandbox = { console: { log() {}, warn() {}, error: (...a) => (sandbox.errors = (sandbox.errors || []).concat(a.join(' '))) }, Date, JSON, Promise };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('js/core.js'), sandbox, { filename: 'core.js' });
  const Core = sandbox.NXInvoiceRegistry;
  const parsed = Core.parseConfig({ config: JSON.stringify(config) }, THIS_APP);
  Object.assign(R, parsed.fields);
  let tokenNo = 0;
  const sleeps = [];
  const reg = Core.create({
    kintone,
    config: parsed,
    appId: THIS_APP,
    loginUser,
    now: () => NOW,
    newToken: () => `TOK${++tokenNo}`,
    storage,
    sleep: (ms) => (sleeps.push(ms), Promise.resolve()),
  });
  rows.forEach(({ no, app = String(THIS_APP), owner = '', token = 'OTHER', created = minutesAgo(60), creator = 'E999', voided = '', reason = '' }) =>
    store.push({
      $id: { value: String(nextId++) },
      $revision: { value: '3' },
      [R.INVOICE]: { value: no },
      [R.OWNER_APP]: { value: app },
      [R.OWNER_ID]: { value: owner },
      [R.TOKEN]: { value: token },
      [R.CREATED]: { value: created },
      [R.VOIDED]: { value: voided },
      [R.VOID_REASON]: { value: reason },
      [R.ORIGINAL]: { value: '' },
      建立人: { type: 'CREATOR', value: { code: creator } },
    }),
  );
  const record = (agg, id, over = {}) => ({ 發票號碼記錄: { value: agg }, ...(id ? { $id: { value: String(id) } } : {}), ...over });
  // 有效的登記（作廢的不列）；作廢的另外看 voidedRows
  const regRows = () => store.filter((r) => r[R.VOIDED]?.value !== '是').map((r) => ({ no: r[R.INVOICE].value, app: r[R.OWNER_APP].value, owner: r[R.OWNER_ID].value, token: r[R.TOKEN].value }));
  const voidedRows = () =>
    store.filter((r) => r[R.VOIDED]?.value === '是').map((r) => ({ no: r[R.INVOICE].value, original: r[R.ORIGINAL].value, app: r[R.OWNER_APP].value, owner: r[R.OWNER_ID].value, reason: r[R.VOID_REASON].value }));
  const writes = () => calls.filter((c) => c.method !== 'GET');
  const reserve = async (rec) => plain(await reg.checkAndReserve(rec));
  return { Core, parsed, reg, reserve, R, store, calls, record, regRows, voidedRows, writes, sandbox, storage, sleeps };
};

// ── 設定 ───────────────────────────────────────────────────────────────────
check('設定：沒設定、App ID 不是數字、沒選發票號碼記錄欄位 → null（plug-in 不動作）', () => {
  const { Core } = setup();
  assert.strictEqual(Core.parseConfig({}, THIS_APP), null);
  assert.strictEqual(Core.parseConfig({ config: '{bad' }, THIS_APP), null);
  assert.strictEqual(Core.parseConfig({ config: JSON.stringify({ ...RAW_CONFIG, registryApp: 'x' }) }, THIS_APP), null);
  assert.strictEqual(Core.parseConfig({ config: JSON.stringify({ ...RAW_CONFIG, self: {} }) }, THIS_APP), null);
});

check('設定：登記表欄位代碼沒填用預設；TTL 分鐘→毫秒；舊版的其他 App／單號欄位設定忽略', () => {
  const { Core } = setup();
  const c = Core.parseConfig(
    { config: JSON.stringify({ ...RAW_CONFIG, pendingTtlMinutes: '', fields: { INVOICE: '' }, self: { ...RAW_CONFIG.self, recordNoField: '單號', label: 'x' }, others: [{ app: '723', invoiceField: 'x' }] }) },
    THIS_APP,
  );
  assert.deepStrictEqual(plain(c.fields), {
    INVOICE: 'invoice_number',
    OWNER_APP: 'app_id',
    OWNER_ID: 'request_record_number',
    TOKEN: 'storage_key',
    CREATED: '建立時間',
    ORIGINAL: 'original_invoice_number',
    VOIDED: 'voided',
    VOID_REASON: 'void_reason',
  });
  assert.strictEqual(c.pendingTtlMs, 600000);
  assert.deepStrictEqual(plain(c.self), { app: '749', invoiceField: '發票號碼記錄', statusField: '狀態', voidStatuses: ['表單作廢'], voidCheckField: '表單作廢' });
  assert.strictEqual(c.others, undefined);
});

check('manifest：PC／手機都載入 core.js＋desktop.js，設定頁必填 config，圖示存在；三支 JS 語法正確；設定頁沒有其他 App／單號欄位', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.deepStrictEqual(m.desktop.js, ['js/core.js', 'js/desktop.js']);
  assert.deepStrictEqual(m.mobile.js, ['js/core.js', 'js/desktop.js']);
  assert.deepStrictEqual(m.config.required_params, ['config']);
  [m.icon, m.config.html, ...m.config.js, ...m.config.css].forEach((p) => assert.ok(fs.existsSync(path.join(SRC, p)), p));
  ['js/core.js', 'js/desktop.js', 'js/config.js'].forEach((p) => {
    const r = spawnSync(process.execPath, ['--check', path.join(SRC, p)]);
    assert.strictEqual(r.status, 0, `${p}: ${r.stderr}`);
  });
  const html = read('html/config.html');
  assert.ok(!html.includes('nx-ir-others') && !html.includes('nx-ir-self-recno'));
});

// ── 登記 ───────────────────────────────────────────────────────────────────
check('登記：新單一次新增全部號碼（大寫、去重），帶本 App ID、記錄編號空白、這次的儲存鍵', async () => {
  const t = setup();
  assert.deepStrictEqual(await t.reserve(t.record(' / ab123 / CD456 / AB123 / ')), []);
  assert.strictEqual(t.writes().length, 1);
  assert.deepStrictEqual(t.regRows(), [
    { no: 'AB123', app: '749', owner: '', token: t.reg.token() },
    { no: 'CD456', app: '749', owner: '', token: t.reg.token() },
  ]);
});

check('登記：編輯時本單已登記的不重登、只加新號碼；存檔失敗再按一次（同儲存鍵）不擋自己', async () => {
  const t = setup({ rows: [{ no: 'AB123', owner: '7' }] });
  assert.deepStrictEqual(await t.reserve(t.record(' / AB123 / NEW1 / ', 7)), []);
  assert.deepStrictEqual(t.regRows().map((r) => [r.no, r.owner]), [['AB123', '7'], ['NEW1', '7']]);
  const n = setup();
  await n.reserve(n.record(' / AB123 / '));
  assert.deepStrictEqual(await n.reserve(n.record(' / AB123 / ')), []);
  assert.strictEqual(n.writes().length, 1);
});

check('登記：號碼已被別張單登記（本 App、其他 App、剛登記、別人沒存成的）→「已使用過」，只列號碼、不說哪個 App 哪筆記錄，不寫入', async () => {
  const t = setup({
    rows: [
      { no: 'AB123', owner: '3' },
      { no: 'CD456', app: '723', owner: '8' },
      { no: 'EF789', created: minutesAgo(1), creator: ME },
      { no: 'GH000', created: minutesAgo(60), creator: 'E999' },
    ],
  });
  const errors = await t.reserve(t.record(' / ab123 / CD456 / EF789 / GH000 / NEW1 / ', 9));
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0].startsWith('發票號碼已使用過：AB123、CD456、EF789、GH000'), errors[0]);
  assert.ok(errors[0].includes('有其他問題請洽管理單位詢問'), errors[0]);
  assert.ok(!/723|記錄 |App /.test(errors[0]) && !errors[0].includes('NEW1'), errors[0]);
  assert.deepStrictEqual(t.writes(), [], '重複時不登記');
  // 同記錄編號但別的 App → 不是自己的
  const u = setup({ rows: [{ no: 'AB123', app: '723', owner: '7' }] });
  assert.ok((await u.reserve(u.record(' / AB123 / ', 7)))[0]?.includes('已使用過'));
});

check('登記：自己之前沒存成的登記（自己建的、沒記錄編號、超過 TTL）→ 作廢（舊登記清除）換本單', async () => {
  const t = setup({ rows: [{ no: 'AB123', creator: ME, created: minutesAgo(11) }] });
  assert.deepStrictEqual(await t.reserve(t.record(' / AB123 / ', 9)), []);
  assert.deepStrictEqual(t.writes().map((c) => c.method), ['PUT', 'POST'], '舊登記用更新作廢，不刪除');
  assert.deepStrictEqual(t.regRows().map((r) => [r.no, r.owner]), [['AB123', '9']]);
  assert.deepStrictEqual(t.voidedRows(), [{ no: 'VOID-100', original: 'AB123', app: '749', owner: '', reason: '舊登記清除' }]);
  const noUser = setup({ rows: [{ no: 'AB123', creator: '', created: minutesAgo(11) }], loginUser: '' });
  assert.ok((await noUser.reserve(noUser.record(' / AB123 / ')))[0]?.includes('已使用過'), '拿不到登入者就不認');
});

check('登記：管理單位手動把作廢改成「是」（號碼還沒換）→ 補換成 VOID-、保留管理單位寫的原因，換本單', async () => {
  const t = setup({ rows: [{ no: 'AB123', owner: '3', voided: '是', reason: '單據作廢' }, { no: 'CD456', owner: '4', voided: '是' }] });
  assert.deepStrictEqual(await t.reserve(t.record(' / AB123 / CD456 / ', 9)), []);
  assert.deepStrictEqual(t.voidedRows(), [
    { no: 'VOID-100', original: 'AB123', app: '749', owner: '3', reason: '單據作廢' },
    { no: 'VOID-101', original: 'CD456', app: '749', owner: '4', reason: '舊登記清除' },
  ]);
  assert.deepStrictEqual(t.regRows().map((r) => r.no), ['AB123', 'CD456']);
});

check('登記：兩個人同時作廢同一筆 → 版本號不符；查詢到新增之間被搶先（值重複）→ 都請再按一次儲存', async () => {
  const t = setup({ rows: [{ no: 'AB123', creator: ME }], fail: { stealRevision: true } });
  const errors = await t.reserve(t.record(' / AB123 / ', 9));
  assert.ok(errors[0]?.includes('剛被其他單據登記') && errors[0].includes('管理單位'), String(errors));
  const raced = setup({ fail: { 'REG:POST': { code: 'CB_VA01' } } });
  assert.ok((await raced.reserve(raced.record(' / AB123 / ')))[0]?.includes('剛被其他單據登記'));
});

check('登記：讀不到登記表 → 擋存檔請稍後；沒有發票號碼 → 不打 API', async () => {
  const down = setup({ fail: { 'REG:GET': new Error('down') } });
  assert.ok((await down.reserve(down.record(' / AB123 / ')))[0]?.includes('目前無法檢查發票號碼'));
  const none = setup();
  assert.deepStrictEqual(await none.reserve(none.record('')), []);
  assert.strictEqual(none.calls.length, 0);
});

// ── 存檔成功 ────────────────────────────────────────────────────────────────
check('存檔成功：新單回填記錄編號、不再用的號碼作廢（改號或刪列）、換新儲存鍵；只動本 App 的登記', async () => {
  const t = setup({ rows: [{ no: 'X1', app: '723', owner: '12' }] });
  await t.reserve(t.record(' / AB123 / OLD9 / '));
  const tok = t.reg.token();
  await t.reg.confirm(t.record(' / AB123 / '), 12);
  assert.deepStrictEqual(t.regRows(), [
    { no: 'X1', app: '723', owner: '12', token: 'OTHER' },
    { no: 'AB123', app: '749', owner: '12', token: tok },
  ]);
  assert.deepStrictEqual(t.voidedRows().map((r) => [r.original, r.reason]), [['OLD9', '改號或刪列']]);
  assert.notStrictEqual(t.reg.token(), tok);
  assert.strictEqual(t.storage.map.size, 0);
});

check('存檔成功：單據作廢（狀態或核取方塊）→ 本單登記全部作廢（單據作廢）、號碼釋出；已作廢的不再動', async () => {
  const t = setup({ rows: [{ no: 'AB123', owner: '7' }, { no: 'CD456', owner: '7' }] });
  await t.reg.confirm(t.record(' / AB123 / CD456 / ', 7, { 表單作廢: { value: ['作廢'] } }), 7);
  assert.deepStrictEqual(t.regRows(), []);
  assert.deepStrictEqual(t.voidedRows().map((r) => [r.original, r.reason]), [['AB123', '單據作廢'], ['CD456', '單據作廢']]);
  const before = t.writes().length;
  await t.reg.confirm(t.record(' / AB123 / CD456 / ', 7, { 表單作廢: { value: ['作廢'] } }), 7);
  assert.strictEqual(t.writes().length, before, '已作廢的登記不重複作廢');
  assert.deepStrictEqual(await t.reserve(t.record(' / AB123 / ', 8)), [], '號碼已釋出，別張單可以用');
  const s = setup();
  assert.strictEqual(s.reg.isVoid(s.record('', 7, { 狀態: { value: '表單作廢' } })), true);
});

check('存檔成功：回填失敗會重試；重試成功不留待補', async () => {
  const t = setup({ fail: { putFailTimes: 1 } });
  await t.reserve(t.record(' / AB123 / '));
  await t.reg.confirm(t.record(' / AB123 / '), 12);
  assert.deepStrictEqual(t.sleeps, [500]);
  assert.deepStrictEqual(t.regRows().map((r) => r.owner), ['12']);
  assert.strictEqual(t.storage.map.size, 0);
});

check('存檔成功：重試都失敗 → 不丟例外、記到瀏覽器；下次開畫面補回填記錄編號並清掉待補', async () => {
  const storage = memoryStorage();
  const t = setup({ fail: { putFailTimes: 3 }, storage });
  await t.reserve(t.record(' / AB123 / '));
  await t.reg.confirm(t.record(' / AB123 / '), 12);
  assert.deepStrictEqual(t.sleeps, [500, 1500]);
  assert.deepStrictEqual(t.regRows().map((r) => r.owner), ['']);
  assert.ok((t.sandbox.errors || []).join('').includes('下次打開畫面再補'));
  assert.deepStrictEqual(JSON.parse(storage.getItem(`nx-invoice-registry:pending:${REG_APP}:${THIS_APP}`)), [{ id: '12', token: 'TOK1' }]);
  await t.reg.retryPending();
  assert.deepStrictEqual(t.regRows().map((r) => r.owner), ['12']);
  assert.strictEqual(storage.map.size, 0);
  // 補了以後，自己再存同號碼不會被當成別人的
  assert.deepStrictEqual(await t.reserve(t.record(' / AB123 / ', 12)), []);
});

check('存檔成功：讀不到登記表 → 不丟例外；沒有待補時不打 API', async () => {
  const f = setup({ fail: { 'REG:GET': new Error('down') } });
  await f.reg.confirm(f.record(' / AB123 / ', 7), 7);
  assert.ok((f.sandbox.errors || []).join('').includes('發票登記'));
  const n = setup();
  await n.reg.retryPending();
  assert.strictEqual(n.calls.length, 0);
});

// ── 刪除／流程作廢 ────────────────────────────────────────────────────────
check('刪除單據：本單（本 App）的登記全部作廢（單據刪除），別的 App 同記錄編號不動；失敗回 false 不丟例外', async () => {
  const t = setup({ rows: [{ no: 'AB123', owner: '7' }, { no: 'CD456', owner: '7' }, { no: 'X1', app: '723', owner: '7' }, { no: 'Y1', owner: '8' }] });
  assert.strictEqual(await t.reg.release('7', t.Core.REASON.DELETED), true);
  assert.deepStrictEqual(t.voidedRows().map((r) => [r.original, r.reason]), [['AB123', '單據刪除'], ['CD456', '單據刪除']]);
  assert.deepStrictEqual(t.regRows().map((r) => r.no), ['X1', 'Y1']);
  const f = setup({ fail: { 'REG:GET': new Error('down') } });
  assert.strictEqual(await f.reg.release('7', '單據刪除'), false);
});

check('詳細頁：單據已作廢（流程按鈕作廢）→ 登記作廢（單據作廢）；沒作廢 → 不打 API', async () => {
  const t = setup({ rows: [{ no: 'AB123', owner: '7' }] });
  await t.reg.reconcile(t.record(' / AB123 / ', 7, { 狀態: { value: '報銷人填單' } }), 7);
  assert.strictEqual(t.calls.length, 0);
  await t.reg.reconcile(t.record(' / AB123 / ', 7, { 狀態: { value: '表單作廢' } }), 7);
  assert.deepStrictEqual(t.voidedRows().map((r) => [r.original, r.reason]), [['AB123', '單據作廢']]);
});

// ── 事件接線（desktop.js）───────────────────────────────────────────────────
check('事件：PC 與手機事件都註冊（含刪除、詳細頁）；App 的程式已擋下或作廢 → 不查不登記；刪除 → 作廢登記；沒設定 → 不註冊', async () => {
  const load = (configRaw) => {
    const handlers = {};
    const calls = [];
    const sandbox = {
      console: { log() {}, warn() {}, error() {} },
      alerts: [],
      kintone: {
        $PLUGIN_ID: 'pid',
        app: { getId: () => THIS_APP },
        getLoginUser: () => ({ code: ME }),
        plugin: { app: { getConfig: () => configRaw } },
        api: Object.assign((url, method, params) => (calls.push({ method, params }), Promise.resolve({ records: [] })), { url: (p) => p }),
        events: { on: (types, fn) => [].concat(types).forEach((x) => ((handlers[x] = handlers[x] || []).push(fn))) },
      },
      Date,
      JSON,
      Promise,
    };
    sandbox.window = sandbox;
    sandbox.alert = (m) => sandbox.alerts.push(m);
    vm.createContext(sandbox);
    vm.runInContext(read('js/core.js'), sandbox);
    vm.runInContext(read('js/desktop.js'), sandbox);
    return { handlers, sandbox, calls };
  };
  const off = load({});
  assert.deepStrictEqual(Object.keys(off.handlers), []);
  const { handlers, calls } = load({ config: JSON.stringify(RAW_CONFIG) });
  [
    'app.record.create.submit',
    'mobile.app.record.edit.submit',
    'app.record.create.submit.success',
    'mobile.app.record.edit.submit.success',
    'app.record.create.show',
    'mobile.app.record.edit.show',
    'app.record.detail.show',
    'mobile.app.record.detail.show',
    'app.record.detail.delete.submit',
    'app.record.index.delete.submit',
    'mobile.app.record.detail.delete.submit',
  ].forEach((type) => assert.ok(handlers[type]?.length === 1, type));
  const submit = handlers['app.record.create.submit'][0];
  const blocked = { error: '儲存失敗', record: { 發票號碼記錄: { value: ' / AB123 / ' } } };
  assert.strictEqual((await submit(blocked)).error, '儲存失敗');
  const voided = { record: { 發票號碼記錄: { value: ' / AB123 / ' }, 表單作廢: { value: ['作廢'] } } };
  assert.strictEqual((await submit(voided)).error, undefined);
  assert.strictEqual(calls.length, 0);
  const ev = { recordId: 7, record: { $id: { value: '7' } } };
  assert.strictEqual(await handlers['app.record.index.delete.submit'][0](ev), ev);
  assert.ok(calls.some((c) => c.method === 'GET' && c.params.query.includes('request_record_number = "7"')), '刪除時查本單的登記');
});

(async () => {
  console.log('core.test.cjs（發票登記 plug-in）');
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
