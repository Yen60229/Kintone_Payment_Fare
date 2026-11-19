'use strict';

// 測試：使用者主檔快取.js（ES module；過渡期 install() 另掛 window.PR_USERS）
//   一、fetchAll：/v1/users.json 一次 100 筆分頁，抓到不足一頁為止；停用帳號也回傳（由使用端過濾）
//   二、loadAll：同一頁面共用同一個 Promise（同時呼叫只打一次 API）、抓過就用快取、失敗清掉下次重抓
//   三、受款人選擇員工＋手動簽核人視窗同一頁面一起開：/v1/users.json 只抓一輪
//   四、使用端不再自己打 /v1/users.json
// 單獨執行：node tests/user_cache.test.cjs

const assert = require('assert');
const { createEnv, createRunner, readSrc } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('user_cache.test.cjs');
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const usersOf = (n) => Array.from({ length: n }, (_, i) => ({ code: `p${String(i).padStart(3, '0')}`, name: `人${i}`, valid: i !== 3 }));

/** 假 /v1/users.json：依 offset／size 切片；fail 為 true 時整個失敗 */
const setup = ({ users = usersOf(250), fail = () => false } = {}) => {
  const calls = [];
  const env = createEnv({
    api: (url, method, params) => {
      calls.push({ url, method, params });
      if (url !== '/v1/users.json') return Promise.reject(new Error(`未預期的 API ${url}`));
      if (fail()) return Promise.reject(new Error('403'));
      return Promise.resolve({ users: users.slice(params.offset, params.offset + params.size) });
    },
  });
  const U = env.load('使用者主檔快取.js');
  assert.strictEqual(env.window.PR_USERS.loadAll, U.loadAll, '過渡期：window.PR_USERS 和 import 拿到的是同一份');
  return { env, U, calls };
};

check('fetchAll：一次 100 筆分頁抓到不足一頁為止；停用帳號也回傳', async () => {
  const { U, calls } = setup();
  assert.strictEqual(U.PAGE_SIZE, 100);
  const list = await U.fetchAll();
  assert.deepStrictEqual(
    calls.map((c) => [c.method, c.params.offset, c.params.size]),
    [
      ['GET', 0, 100],
      ['GET', 100, 100],
      ['GET', 200, 100],
    ],
  );
  assert.strictEqual(list.length, 250);
  assert.strictEqual(list[3].valid, false);
});

check('fetchAll：剛好整頁時多抓一頁空的才停；可注入 api', async () => {
  const { U, calls } = setup();
  const offsets = [];
  const list = await U.fetchAll(async (url, method, params) => {
    offsets.push(params.offset);
    return { users: usersOf(200).slice(params.offset, params.offset + params.size) };
  });
  assert.deepStrictEqual(offsets, [0, 100, 200]);
  assert.strictEqual(list.length, 200);
  assert.strictEqual(calls.length, 0, '注入 api 時不打 kintone.api');
});

check('loadAll：同時呼叫共用同一個 Promise，只抓一輪；之後用快取；回傳的陣列凍結', async () => {
  const { U, calls } = setup();
  const p1 = U.loadAll();
  const p2 = U.loadAll();
  assert.strictEqual(p1, p2);
  const [a, b] = await Promise.all([p1, p2]);
  assert.strictEqual(a, b);
  assert.strictEqual(calls.length, 3);
  assert.ok(Object.isFrozen(a));
  assert.strictEqual(await U.loadAll(), a);
  assert.strictEqual(calls.length, 3, '抓過就不再打 API');
});

check('loadAll：失敗就清掉，下次呼叫重抓', async () => {
  let failing = true;
  const { U, calls } = setup({ fail: () => failing });
  await assert.rejects(U.loadAll(), /403/);
  failing = false;
  const list = await U.loadAll();
  assert.strictEqual(list.length, 250);
  assert.strictEqual(calls.length, 4, '第一次失敗 1 次＋重抓 3 頁');
});

check('受款人選擇員工＋手動簽核人視窗同一頁面一起開：/v1/users.json 只抓一輪，兩邊都拿到名單', async () => {
  const users = usersOf(130);
  const { env, calls } = setup({ users });
  // 假 SweetAlert：開視窗就跑 didOpen（受款人用 popup.querySelector 找搜尋框與清單；手動簽核人畫在 opts.html）
  const stub = () => ({ value: '', innerHTML: '', addEventListener() {}, focus() {} });
  const payeeParts = { '.pr-emp-search': stub(), '.pr-emp-list': stub() };
  const fired = [];
  const swal = {
    fire: (opts) => {
      fired.push(opts);
      if (opts.didOpen) opts.didOpen({ querySelector: (sel) => payeeParts[sel] });
      return new Promise(() => {});
    },
    close() {},
    showValidationMessage() {},
    resetValidationMessage() {},
  };
  env.window.Swal = swal;
  env.window.localStorage = { getItem: () => null, setItem() {} };
  env.run('this.Swal = window.Swal;');
  env.load('payment_request_config.js');
  env.load('手動簽核人設定.js');
  const payee = env.load('受款人填寫設定.js');

  env.window.PR_MANUAL_SIGNERS.openDialog({ initial: [], applicant: { code: 'ME' }, accounting: [] });
  assert.strictEqual(payee.openUserPicker({ title: '選擇員工', keyword: '人12', onPick() {} }), true);
  await settle();
  assert.strictEqual(fired.length, 2);
  assert.deepStrictEqual(
    calls.map((c) => c.params.offset),
    [0, 100],
    '兩個視窗共用同一輪',
  );
  assert.ok(payeeParts['.pr-emp-list'].innerHTML.includes('人12'), '受款人視窗有列出名單');
  assert.strictEqual(env.logs.error.length, 0, env.logs.error.join('|'));

  // 再開一次：都用快取
  payee.openUserPicker({ title: '選擇員工', onPick() {} });
  env.window.PR_MANUAL_SIGNERS.openDialog({ initial: [], applicant: { code: 'ME' }, accounting: [] });
  await settle();
  assert.strictEqual(calls.length, 2);
});

check('使用端不再自己打 /v1/users.json，改用使用者主檔快取的 loadAll()', () => {
  ['受款人填寫設定.js', '手動簽核人設定.js'].forEach((f) => {
    const src = readSrc(f);
    assert.ok(!/kintone\.api\(\s*kintone\.api\.url\(\s*['"]\/v1\/users\.json/.test(src), `${f} 不應直接打 /v1/users.json`);
    assert.ok(!/USERS_API/.test(src), `${f} 不應自己定義 USERS_API`);
    const imported = /^import \{[^}]*\bloadAll\b[^}]*\} from '\.\/使用者主檔快取\.js';/m.test(src) && /\bloadAll\(\)/.test(src);
    assert.ok(imported || src.includes('window.PR_USERS.loadAll()'), `${f} 要用使用者主檔快取的 loadAll()`);
  });
});

check('入口檔：使用者主檔快取排在手動簽核人與受款人前面（桌面版、手機版）', () => {
  ['src/index.js', 'src/mobile.js'].forEach((entry) => {
    const src = readSrc(entry);
    // 傳統 script 是 import '../x.js';，ES module 是 import '../x.js?install';
    const at = (f) => src.search(new RegExp(`import '\\.\\./${f.replace('.', '\\.')}(\\?install)?';`));
    assert.ok(at('使用者主檔快取.js') >= 0, `${entry} 沒有接使用者主檔快取`);
    assert.ok(at('使用者主檔快取.js') < at('手動簽核人設定.js'), entry);
    assert.ok(at('使用者主檔快取.js') < at('受款人填寫設定.js'), entry);
  });
});

done();
