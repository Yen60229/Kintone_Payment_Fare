'use strict';

// 測試：桌面版／手機版兩套打包與 CSS 分離
//   1. PR_KT（payment_request_config.js）：桌面版原封不動；手機版改註冊 mobile.* 事件、
//      處理程式看到的 event.type 是桌面版名稱、結束後換回；略過手機版沒有的事件；record()/app() 改走 kintone.mobile
//   2. 入口檔：手機版（src/mobile.js）是桌面版（src/index.js）的子集且順序一致；mobile_target 排第一；
//      根目錄每支模組都接在桌面版；桌面版專用的模組不進手機版
//   3. 手機版用到的模組不直接呼叫 kintone.events.on／kintone.app.*（都走 PR_KT）
//   4. CSS 分開：JS 裡沒有 <style> 注入、cssText、HTML style 屬性；JS 用到的 pr-* class 在 CSS 裡都有定義，
//      手機版模組用到的 class 在 common.css
//   5. 手機版模組整組載入（kintone.mobile 替身）並觸發 mobile.* 事件不會出錯
// 單獨執行：node tests/build_targets.test.cjs

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRunner, readSrc, rootDir } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('build_targets.test.cjs');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 取出入口檔 import 的檔名（去掉 ../ 前綴），分 js 與 css */
const importsOf = (entry) => {
  const list = readSrc(entry)
    .split(/\r?\n/)
    .map((l) => /^import '(.+)';$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => m[1].replace(/^\.\.\//, '').replace(/^\.\//, 'src/'));
  return { js: list.filter((f) => f.endsWith('.js')), css: list.filter((f) => f.endsWith('.css')) };
};
const DESKTOP = importsOf('src/index.js');
const MOBILE = importsOf('src/mobile.js');
const DESKTOP_ONLY = [
  '帳號權限設定_20260722.js',
  '檔案批次_6版_PDFLib向量版_20260716.js',
  '批次整理資料.js',
  'coding_tools.js',
  'print.show顯示單據編號_請款單據編號.js',
  '請款單作廢_style_20260506.js',
  'SetFieldWidth_4_20251206.js',
  'file_reader.js',
  '轉至其他會計單位按鈕處理_20250723.js',
];
const MOBILE_MODULES = MOBILE.js.filter((f) => f !== 'src/mobile_target.js');

/**
 * 只載 config 的沙箱，看 PR_KT 的行為。
 * @param {'desktop'|'mobile'} target
 */
const loadConfig = (target) => {
  const registered = [];
  const sandbox = {
    window: target === 'mobile' ? { PR_BUILD_TARGET: 'mobile' } : {},
    kintone: {
      app: { getId: () => 749, record: { tag: 'desktop-record' } },
      mobile: { app: { getId: () => 7490, record: { tag: 'mobile-record' } } },
      events: { on: (types, handler) => registered.push({ types: [].concat(types), handler }) },
      getLoginUser: () => ({ code: 'u' }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(readSrc('payment_request_config.js'), sandbox);
  return { KT: sandbox.window.PR_KT, C: sandbox.window.PR_CONFIG, registered };
};

// ── 1. PR_KT ────────────────────────────────────────────────────────────────
check('桌面版：事件名稱與處理程式原封不動交給 kintone.events.on；record()/app() 是 kintone.app', () => {
  const { KT, C, registered } = loadConfig('desktop');
  const fn = function handleSomething(e) {
    return e;
  };
  KT.on(['app.record.create.show', 'app.record.print.show'], fn);
  assert.deepStrictEqual(registered[0].types, ['app.record.create.show', 'app.record.print.show']);
  assert.strictEqual(registered[0].handler, fn, '桌面版不包一層（測試靠處理程式名稱辨認）');
  assert.strictEqual(KT.IS_MOBILE, false);
  assert.strictEqual(KT.record().tag, 'desktop-record');
  assert.strictEqual(C.APPS.PAYMENT, 749);
});

check('手機版：改註冊 mobile.* 事件，略過列印／列表直接編輯；record()/app() 是 kintone.mobile；App ID 取手機版', () => {
  const { KT, C, registered } = loadConfig('mobile');
  KT.on(['app.record.create.show', 'app.record.print.show', 'app.record.index.edit.show', 'app.record.edit.change.申請人'], (e) => e);
  assert.deepStrictEqual(registered[0].types, ['mobile.app.record.create.show', 'mobile.app.record.edit.change.申請人']);
  KT.on('app.record.print.show', (e) => e);
  assert.strictEqual(registered.length, 1, '全部都是手機版沒有的事件 → 不註冊');
  assert.strictEqual(KT.IS_MOBILE, true);
  assert.strictEqual(KT.record().tag, 'mobile-record');
  assert.strictEqual(C.APPS.PAYMENT, 7490);
});

check('手機版：處理程式執行時 event.type 是桌面版名稱，回傳後換回 mobile.*（同步、Promise、丟例外都會換回）', async () => {
  const { KT, registered } = loadConfig('mobile');
  const seen = [];
  KT.on('app.record.detail.show', (e) => {
    seen.push(e.type);
    return e;
  });
  KT.on('app.record.create.submit', async (e) => {
    seen.push(e.type);
    await wait(1);
    return e;
  });
  KT.on('app.record.edit.show', () => {
    throw new Error('boom');
  });
  const ev1 = { type: 'mobile.app.record.detail.show' };
  assert.strictEqual(registered[0].handler(ev1), ev1);
  assert.strictEqual(ev1.type, 'mobile.app.record.detail.show');
  const ev2 = { type: 'mobile.app.record.create.submit' };
  const p = registered[1].handler(ev2);
  assert.strictEqual(ev2.type, 'app.record.create.submit', 'Promise 還沒結束前維持桌面版名稱');
  assert.strictEqual(await p, ev2);
  assert.strictEqual(ev2.type, 'mobile.app.record.create.submit');
  const ev3 = { type: 'mobile.app.record.edit.show' };
  assert.throws(() => registered[2].handler(ev3), /boom/);
  assert.strictEqual(ev3.type, 'mobile.app.record.edit.show');
  assert.deepStrictEqual(seen, ['app.record.detail.show', 'app.record.create.submit']);
});

// ── 2. 入口檔 ───────────────────────────────────────────────────────────────
check('桌面版入口：根目錄每支模組（config 以外）都有接，config 排第一', () => {
  const rootJs = fs.readdirSync(rootDir).filter((f) => f.endsWith('.js') && f !== 'vite.config.js');
  assert.strictEqual(DESKTOP.js[0], 'payment_request_config.js');
  rootJs.forEach((f) => assert.ok(DESKTOP.js.includes(f), `src/index.js 沒有接 ${f}`));
  assert.strictEqual(DESKTOP.js.length, rootJs.length);
});

check('手機版入口：mobile_target 排第一、config 第二；其餘是桌面版的子集且順序一致；桌面版專用模組不進來', () => {
  assert.strictEqual(MOBILE.js[0], 'src/mobile_target.js');
  assert.strictEqual(MOBILE.js[1], 'payment_request_config.js');
  const positions = MOBILE_MODULES.map((f) => DESKTOP.js.indexOf(f));
  positions.forEach((p, i) => assert.ok(p >= 0, `${MOBILE_MODULES[i]} 不在桌面版入口`));
  assert.deepStrictEqual([...positions].sort((a, b) => a - b), positions, '手機版的模組順序要和桌面版一致');
  DESKTOP_ONLY.forEach((f) => assert.ok(!MOBILE.js.includes(f), `${f} 是桌面版專用`));
  const covered = new Set([...MOBILE_MODULES, ...DESKTOP_ONLY]);
  DESKTOP.js.forEach((f) => assert.ok(covered.has(f), `${f} 沒決定要不要進手機版（加進 src/mobile.js 或本測試的 DESKTOP_ONLY）`));
});

check('樣式：桌面版載 common＋desktop，手機版只載 common', () => {
  assert.deepStrictEqual(DESKTOP.css, ['styles/common.css', 'styles/desktop.css']);
  assert.deepStrictEqual(MOBILE.css, ['styles/common.css']);
});

check('vite 與 npm：兩套各自輸出 JS 與 CSS，npm run build 一次打兩套', () => {
  const vite = readSrc('vite.config.js');
  assert.ok(vite.includes("input: 'src/index.js', name: 'payment_request_desktop'"));
  assert.ok(vite.includes("input: 'src/mobile.js', name: 'payment_request_mobile'"));
  assert.ok(/cssCodeSplit:\s*false/.test(vite));
  const pkg = JSON.parse(readSrc('package.json'));
  assert.strictEqual(pkg.scripts.build, 'vite build --mode desktop && vite build --mode mobile');
});

// ── 3. 手機版模組都走 PR_KT ─────────────────────────────────────────────────
check('手機版用到的模組不直接呼叫 kintone.events.on／kintone.app.*', () => {
  MOBILE_MODULES.filter((f) => f !== 'payment_request_config.js').forEach((f) => {
    const src = readSrc(f);
    assert.ok(!/kintone\.events\.on\(/.test(src), `${f} 要改用 KT.on`);
    assert.ok(!/kintone\.app\./.test(src), `${f} 要改用 KT.record()／KT.app()`);
  });
});

// ── 4. CSS 分開 ─────────────────────────────────────────────────────────────
const commonCss = readSrc('styles/common.css');
const desktopCss = readSrc('styles/desktop.css');
const classesUsedIn = (src) => {
  const out = new Set();
  [/className = '([^']+)'/g, /class="([^"]+)"/g, /classList\.add\('([^']+)'\)/g].forEach((re) => {
    for (const m of src.matchAll(re)) m[1].split(/\s+/).filter((c) => c.startsWith('pr-')).forEach((c) => out.add(c));
  });
  return out;
};
const definedIn = (css, cls) => new RegExp(`\\.${cls.replace(/-/g, '\\-')}(?![\\w-])`).test(css);

check('JS 裡沒有寫死的樣式：沒有 <style> 注入、cssText、HTML style 屬性', () => {
  DESKTOP.js.forEach((f) => {
    const src = readSrc(f);
    assert.ok(!/createElement\(['"]style['"]\)/.test(src), `${f} 不應再注入 <style>`);
    assert.ok(!/cssText/.test(src), `${f} 不應用 cssText`);
    assert.ok(!/style="/.test(src), `${f} 不應寫 HTML style 屬性`);
  });
});

check('JS 用到的 pr-* class 都在 CSS 有定義；手機版模組用到的在 common.css', () => {
  DESKTOP.js.forEach((f) => {
    const css = MOBILE_MODULES.includes(f) ? commonCss : `${commonCss}\n${desktopCss}`;
    classesUsedIn(readSrc(f)).forEach((cls) => assert.ok(definedIn(css, cls), `${f} 用到的 .${cls} 沒有定義${MOBILE_MODULES.includes(f) ? '在 common.css' : ''}`));
  });
  ['pr-validation-popup', 'pr-same-applicant-btn', 'pr-required-mark', 'pr-expected-pay-note', 'pr-noti'].forEach((cls) =>
    assert.ok(definedIn(commonCss, cls), cls),
  );
  assert.ok(/@keyframes pr-fade-out/.test(commonCss));
});

// ── 5. 手機版整組載入 ───────────────────────────────────────────────────────
check('手機版模組整組載入（kintone.mobile 替身），觸發 mobile.* 事件不出錯；只註冊 mobile.* 事件', async () => {
  const registered = [];
  const live = { record: null };
  const shown = {};
  const space = () => ({ appendChild: () => {}, addEventListener: () => {}, classList: { add: () => {} }, textContent: '', innerHTML: '' });
  const mobileRecordApi = {
    get: () => ({ record: live.record }),
    set: (r) => {
      live.record = r.record;
    },
    setFieldShown: (code, v) => {
      shown[code] = v;
    },
    setGroupFieldOpen: () => {},
    getSpaceElement: space,
  };
  const sandbox = {
    window: {},
    console: { log: () => {}, warn: () => {}, error: () => {} },
    document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null, createElement: () => ({ ...space(), remove: () => {} }), head: { appendChild: () => {} } },
    setTimeout: () => 0,
    clearTimeout: () => {},
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    localStorage: { getItem: () => null, setItem: () => {} },
    alert: () => {},
    confirm: () => true,
    kintone: {
      app: {
        getId: () => {
          throw new Error('手機版不應呼叫 kintone.app');
        },
      },
      mobile: { app: { getId: () => 749, record: mobileRecordApi } },
      events: { on: (types, handler) => registered.push({ types: [].concat(types), handler }) },
      getLoginUser: () => ({ code: 'u1' }),
      api: Object.assign(
        (url, method, params, ok) => {
          const resp = url.includes('organizations') ? { organizationTitles: [] } : url.includes('groups') ? { groups: [] } : { records: [], id: 'c', next: false };
          if (typeof ok === 'function') return ok(resp);
          return Promise.resolve(resp);
        },
        { url: (p) => p },
      ),
    },
  };
  const errors = [];
  sandbox.console.error = (...a) => errors.push(a.map(String).join(' '));
  sandbox.Swal = { fire: () => Promise.resolve({ isConfirmed: false }), isVisible: () => false, getPopup: () => null, close: () => {}, showLoading: () => {} };
  sandbox.window.Swal = sandbox.Swal;
  vm.createContext(sandbox);
  MOBILE.js.forEach((f) => vm.runInContext(readSrc(f), sandbox, { filename: f }));

  const types = registered.flatMap((r) => r.types);
  assert.ok(types.length > 20, `註冊了 ${types.length} 個事件`);
  types.forEach((t) => assert.ok(t.startsWith('mobile.app.record.'), `手機版不該註冊 ${t}`));

  const C = sandbox.window.PR_CONFIG;
  const F = C.FIELDS;
  const record = () => {
    const r = {};
    [F.APPLICANT, F.EXPENSE_OWNER].forEach((f) => (r[f] = { value: [{ code: 'u1', name: 'U1' }] }));
    [F.APPLICANT_ORG, F.EXPENSE_OWNER_ORG].forEach((f) => (r[f] = { value: [{ code: 'O', name: '總務部' }] }));
    [F.PAYMENT_DATE].forEach((f) => (r[f] = { value: '2026-10-22' }));
    [F.PAYEE, F.COMPANY_NAME, F.INVOICE_AGG, F.REASON, F.PAPER_RECEIPT, F.EXPECTED_PAY_DATE].forEach((f) => (r[f] = { value: '' }));
    [F.MANUAL_FLOW, F.ACCOUNTING_UNIT, F.ACCOUNTING_STAFF, F.PERMISSION_STAFF, F.PAY_METHOD, C.VOID_FIELD].forEach((f) => (r[f] = { value: [] }));
    ['單位主管1', '單位主管2', '單位主管3', '單位次長', '單位次長1', '單位部長_支店長'].forEach((f) => (r[f] = { value: [] }));
    ['部門主管簽核人數', '部門次長簽核人數'].forEach((f) => (r[f] = { value: '' }));
    r[F.TRAFFIC_TABLE.CODE] = { value: [] };
    r[F.STATUS_FIELD] = { value: C.STATUS.APPLY_START };
    r.$id = { value: '1' };
    return r;
  };
  for (const type of ['mobile.app.record.create.show', 'mobile.app.record.edit.show', 'mobile.app.record.detail.show', 'mobile.app.record.create.submit']) {
    const ev = { type, record: record() };
    live.record = ev.record;
    for (const r of registered.filter((x) => x.types.includes(type))) {
      const out = await r.handler(ev);
      assert.notStrictEqual(out, undefined, `${type} 有處理程式沒回傳 event`);
      assert.strictEqual(ev.type, type, `${type}：event.type 要換回手機版名稱`);
    }
  }
  assert.strictEqual(shown[F.DEV_ONLY_DATA], false, '一般使用者看不到開發人員用群組');
  await wait(5);
  assert.deepStrictEqual(errors, [], '不應有任何模組報錯');
});

done();
