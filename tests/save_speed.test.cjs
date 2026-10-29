'use strict';

// 回歸測試：按下儲存後的等待時間（2026-09-23）
//   1. 「儲存中，請稍候…」提示：第一個開、擋下時關、換頁時關、只關自己的、保險計時
//   2. submit 驗證共用主程式已載入的費用歸屬代碼，不再每次存檔重查
//   3. 互不相依的查詢同時送出（費用歸屬代碼、發票重複），錯誤訊息順序固定
//   4. 載入順序：提示模組排在共用設定檔之後、其他模組之前
// 直接用 Node 執行：node tests/save_speed.test.cjs

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const readSrc = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

// ── 「儲存中」提示模組的替身環境 ────────────────────────────────────────────
const loadSavingHint = () => {
  const registered = [];
  const deferred = [];
  const swalState = { visible: false, popupClass: '', fired: [], closed: 0 };
  const fakeSwal = {
    fire: (opts) => {
      swalState.visible = true;
      swalState.popupClass = opts.customClass?.popup || '';
      swalState.fired.push(opts);
    },
    close: () => {
      swalState.visible = false;
      swalState.closed += 1;
    },
    isVisible: () => swalState.visible,
    getPopup: () => ({ classList: { contains: (c) => swalState.popupClass === c } }),
    showLoading: () => {},
  };
  const kintoneStub = { events: { on: (types, handler) => registered.push({ types, handler }) } };
  const sandbox = {
    // PR_KT 由 payment_request_config.js 提供；這裡只載提示模組，給一個桌面版的替身
    window: { Swal: fakeSwal, PR_KT: { on: (types, handler) => kintoneStub.events.on(types, handler) } },
    kintone: kintoneStub,
    setTimeout: (fn, ms) => {
      deferred.push({ fn, ms });
      return deferred.length;
    },
    clearTimeout: () => {},
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'kintone', 'setTimeout', 'clearTimeout', readSrc('存檔等待提示_20260923.js'))(
    sandbox.window,
    sandbox.kintone,
    sandbox.setTimeout,
    sandbox.clearTimeout,
  );
  // 模擬「所有模組載入完後的下一輪」：執行延後註冊（ms = 0 的那一個）
  const runDeferredRegistration = () => deferred.filter((d) => d.ms === 0).forEach((d) => d.fn());
  return { api: sandbox.window.PR_SAVING_HINT, registered, deferred, swalState, runDeferredRegistration };
};

(async () => {
  console.log('save_speed.test.cjs');

  // ── 1. 「儲存中」提示 ─────────────────────────────────────────────────────
  await check('按下儲存時的處理程式先註冊；擋下時關提示的處理程式延到下一輪才註冊（排在所有模組最後）', () => {
    const { registered, runDeferredRegistration } = loadSavingHint();
    const submitNames = () => registered.filter((r) => r.types.includes('app.record.edit.submit')).map((r) => r.handler.name);
    assert.deepStrictEqual(submitNames(), ['onSubmitStart'], '載入當下只註冊開提示的處理程式');
    runDeferredRegistration();
    assert.deepStrictEqual(submitNames(), ['onSubmitStart', 'onSubmitEnd']);
  });

  await check('按下儲存 → 開提示；存檔被擋下（event.error）→ 關提示；沒擋下 → 繼續顯示', () => {
    const { api, swalState } = loadSavingHint();
    api.onSubmitStart({});
    assert.strictEqual(swalState.visible, true);
    assert.strictEqual(swalState.fired[0].title, '儲存中，請稍候…');
    api.onSubmitEnd({});
    assert.strictEqual(swalState.visible, true, '沒被擋下時要一直顯示到換頁');
    api.onSubmitEnd({ error: '尚有必填欄位未填寫' });
    assert.strictEqual(swalState.visible, false);
  });

  await check('換到詳細頁（存檔成功）時關掉提示', () => {
    const { api, registered, swalState } = loadSavingHint();
    const leave = registered.find((r) => r.types.includes('app.record.detail.show'));
    assert.ok(leave, '要監聽 detail.show');
    api.onSubmitStart({});
    leave.handler({});
    assert.strictEqual(swalState.visible, false);
  });

  await check('只關自己開的提示：別的程式的視窗（例如錯誤訊息）不會被誤關', () => {
    const { api, swalState } = loadSavingHint();
    api.onSubmitStart({});
    swalState.popupClass = 'some-other-dialog'; // 其他程式跳出自己的視窗，取代了提示
    api.onSubmitEnd({ error: 'x' });
    api.onLeave({});
    assert.strictEqual(swalState.visible, true, '別人的視窗要留著');
    assert.strictEqual(swalState.closed, 0);
  });

  await check('保險：開提示時同時排一個自動關閉的計時；使用者也可以按 Esc 或點外面關掉', () => {
    const { api, deferred, swalState } = loadSavingHint();
    api.onSubmitStart({});
    const safety = deferred.find((d) => d.ms === api.SAFETY_CLOSE_MS);
    assert.ok(safety, '要排保險計時');
    assert.ok(api.SAFETY_CLOSE_MS <= 15000, '保險時間不要太長');
    safety.fn();
    assert.strictEqual(swalState.visible, false);
    const opts = swalState.fired[0];
    assert.strictEqual(opts.allowEscapeKey, true);
    assert.strictEqual(opts.allowOutsideClick, true);
  });

  await check('沒有載入 SweetAlert 時不報錯（什麼都不做）', () => {
    const registered = [];
    // eslint-disable-next-line no-new-func
    const on = (types, handler) => registered.push({ types, handler });
    new Function('window', 'kintone', 'setTimeout', 'clearTimeout', readSrc('存檔等待提示_20260923.js'))(
      { PR_KT: { on } },
      { events: { on } },
      () => 0,
      () => {},
    );
    const start = registered.find((r) => r.handler.name === 'onSubmitStart');
    assert.deepStrictEqual(start.handler({ a: 1 }), { a: 1 });
  });

  await check('載入順序：提示模組緊接在共用設定檔之後、所有其他模組之前', () => {
    const imports = readSrc('src/index.js')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('import ') && l.endsWith(".js';"));
    assert.ok(imports[0].includes('payment_request_config.js'));
    assert.ok(imports[1].includes('存檔等待提示_20260923.js'), `第二個應該是提示模組，實際是 ${imports[1]}`);
  });

  // ── 2. 費用歸屬代碼共用主程式的快取 ─────────────────────────────────────────
  const submitSrc = readSrc('payment_request_submit_20260506.js');
  const extract = (source, re, label) => {
    const m = source.match(re);
    assert.ok(m, `找不到 ${label}`);
    return m[0];
  };
  const getValidSrc = extract(submitSrc, /const getValidCostCenters = async \(\) => \{[\s\S]*?\n  \};/, 'getValidCostCenters');

  await check('submit 驗證優先用主程式已載入的費用歸屬代碼，不再自己查', async () => {
    let ownFetch = 0;
    const shared = { ensureLoaded: async () => {}, getValidCodes: () => new Set(['AJ30', 'aj31']) };
    // eslint-disable-next-line no-new-func
    const fn = new Function('window', 'fetchValidCostCenters', `${getValidSrc}; return getValidCostCenters;`)(
      { PR_COST_CENTER: shared },
      async () => {
        ownFetch += 1;
        return new Set();
      },
    );
    const set = await fn();
    assert.deepStrictEqual([...set], ['AJ30', 'aj31'], '原始大小寫原樣保留');
    assert.strictEqual(ownFetch, 0);
  });

  await check('主程式沒載入時，submit 驗證退回自己查', async () => {
    let ownFetch = 0;
    // eslint-disable-next-line no-new-func
    const fn = new Function('window', 'fetchValidCostCenters', `${getValidSrc}; return getValidCostCenters;`)({}, async () => {
      ownFetch += 1;
      return new Set(['AJ30']);
    });
    await fn();
    assert.strictEqual(ownFetch, 1);
  });

  await check('主程式的代碼集合用原始大小寫建（和 submit 原本自己查時的比對方式一致）', () => {
    const mainSrc = readSrc('payment_request_main_20260521.js');
    const loadBody = extract(mainSrc, /const loadCostCenterMaps = \(\) => \{[\s\S]*?\n  \};/, 'loadCostCenterMaps');
    const addIdx = loadBody.indexOf('validCodes.add(rawCode)');
    const upperIdx = loadBody.indexOf('rawCode.toUpperCase()');
    assert.ok(addIdx > 0 && addIdx < upperIdx, '要在轉大寫之前，用原始代碼加入集合');
    assert.ok(/getValidCodes: \(\) => VALID_COST_CENTER_CODES/.test(mainSrc));
    // 和 submit 自己查時一樣：只收「使用中」、去掉前後空白
    assert.ok(loadBody.includes('in ("使用中")'));
  });

  // ── 3. 互不相依的查詢同時送出 ────────────────────────────────────────────────
  await check('submit 驗證：費用歸屬代碼、發票、掛帳單位、部長帶入同時進行，錯誤訊息順序固定（代碼載入 → 表單 → 交通費明細 → 發票 → 掛帳單位 → 部長）', () => {
    const handler = extract(submitSrc, /KT\.on\(\['app\.record\.create\.submit', 'app\.record\.edit\.submit'\][\s\S]*$/, 'submit handler');
    assert.match(handler, /await Promise\.all\(\[costCentersTask, invoiceTask, scopeTask, directorTask\]\)/);
    const order = ['allErrors.push(costCenters.error)', 'allErrors.push(...validateForm(record', 'trafficRules.validate(record)', 'allErrors.push(...invoiceErrors)', 'allErrors.push(...scopeErrors)', 'allErrors.push(...directorErrors)'].map((s) => handler.indexOf(s));
    assert.ok(handler.indexOf('trafficRules.normalize(record)') < handler.indexOf('checkInvoiceDuplicate(record)'), '發票號碼記錄要先重算再查重複');
    order.forEach((idx) => assert.ok(idx > 0));
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order, '錯誤訊息的加入順序要固定');
    assert.ok(!/await fetchValidCostCenters\(\)/.test(handler), '存檔時不再直接重查費用歸屬主檔');
  });

  console.log(`\n${passed} assertions passed.`);
})().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
