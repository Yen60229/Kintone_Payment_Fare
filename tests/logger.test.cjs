'use strict';

// 測試：共用 log（window.PR_LOG，在 payment_request_config.js）
//   1. 預設（沒開開關）debug／info 不印；warn／error 一律印
//   2. localStorage['pr-debug']='1' 或網址 ?pr-debug=1 → debug／info 會印；localStorage 丟錯也不會壞
//   3. 打包進 bundle 的模組（src/index.js 的 import）沒有直接寫 console.log／console.debug
//      （要印除錯訊息用 PR_LOG.debug；手動執行的診斷工具用 console.info；config 本身是 PR_LOG 的實作，除外）
// 單獨執行：node tests/logger.test.cjs

const assert = require('assert');
const vm = require('vm');
const { createRunner, readSrc } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('logger.test.cjs');

/**
 * 只載 config，回傳 PR_LOG 與攔下來的 console 輸出。
 * @param {{ search?: string, storage?: Object|'throw' }} opts
 */
const loadLogger = ({ search = '', storage } = {}) => {
  const out = { log: [], warn: [], error: [] };
  const window = { location: { search } };
  if (storage === 'throw') {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('SecurityError');
      },
    });
  } else if (storage) {
    window.localStorage = { getItem: (k) => (k in storage ? storage[k] : null) };
  }
  const sandbox = {
    window,
    kintone: {
      app: { getId: () => 749, record: {} },
      events: { on: () => {} },
      getLoginUser: () => ({ code: 'u' }),
    },
    console: {
      log: (...a) => out.log.push(a),
      warn: (...a) => out.warn.push(a),
      error: (...a) => out.error.push(a),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(readSrc('payment_request_config.js'), sandbox);
  return { LOG: sandbox.window.PR_LOG, out };
};

const fireAll = (LOG) => {
  LOG.debug('d', 1);
  LOG.info('i');
  LOG.warn('w');
  LOG.error('e');
};

// ── 1. 預設不印 ─────────────────────────────────────────────────────────────
check('預設：enabled=false，debug／info 不印，warn／error 照印', () => {
  const { LOG, out } = loadLogger();
  assert.strictEqual(LOG.enabled, false);
  fireAll(LOG);
  assert.deepStrictEqual(out.log, []);
  assert.deepStrictEqual(out.warn, [['w']]);
  assert.deepStrictEqual(out.error, [['e']]);
});

check('localStorage 有別的值（不是 "1"）、網址沒帶參數 → 不印', () => {
  const { LOG, out } = loadLogger({ storage: { 'pr-debug': '0' }, search: '?foo=1' });
  assert.strictEqual(LOG.enabled, false);
  fireAll(LOG);
  assert.deepStrictEqual(out.log, []);
});

check('PR_LOG 凍結，模組改不掉', () => {
  const { LOG } = loadLogger();
  assert.ok(Object.isFrozen(LOG));
});

// ── 2. 開關 ──────────────────────────────────────────────────────────────────
check("localStorage['pr-debug']='1' → debug／info 印出（前面帶 [PR]）", () => {
  const { LOG, out } = loadLogger({ storage: { 'pr-debug': '1' } });
  assert.strictEqual(LOG.enabled, true);
  fireAll(LOG);
  assert.deepStrictEqual(out.log, [['[PR]', 'd', 1], ['[PR]', 'i']]);
  assert.deepStrictEqual(out.warn, [['w']]);
});

check('網址 ?pr-debug=1（含與其他參數並列）→ 打開；?pr-debug=10 不算', () => {
  assert.strictEqual(loadLogger({ search: '?pr-debug=1' }).LOG.enabled, true);
  assert.strictEqual(loadLogger({ search: '?a=b&pr-debug=1&c=d' }).LOG.enabled, true);
  assert.strictEqual(loadLogger({ search: '?pr-debug=10' }).LOG.enabled, false);
});

check('localStorage 存取丟錯（無痕／封鎖網站資料）→ 不會壞，仍看網址', () => {
  assert.strictEqual(loadLogger({ storage: 'throw' }).LOG.enabled, false);
  assert.strictEqual(loadLogger({ storage: 'throw', search: '?pr-debug=1' }).LOG.enabled, true);
});

// ── 3. 模組不直接寫 console.log ─────────────────────────────────────────────
check('打包進 bundle 的模組沒有直接呼叫 console.log／console.debug（註解不算）', () => {
  const modules = readSrc('src/index.js')
    .split(/\r?\n/)
    .map((l) => /^import '\.\.\/(.+\.js)';$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => m[1])
    .filter((f) => f !== 'payment_request_config.js');
  assert.ok(modules.length > 20, `src/index.js 讀到的模組太少（${modules.length}）`);
  const hits = [];
  for (const file of modules) {
    readSrc(file)
      .split(/\r?\n/)
      .forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (/\bconsole\.(log|debug)\s*\(/.test(code)) hits.push(`${file}:${i + 1}  ${line.trim()}`);
      });
  }
  assert.deepStrictEqual(hits, [], `改用 window.PR_LOG.debug／info：\n${hits.join('\n')}`);
});

done();
