'use strict';

// 測試共用：把 payment_request_config.js 與要測的模組放進 vm 沙箱執行，
// 用替身的 kintone／document／Swal 攔下事件處理程式，測試時再用 fire() 觸發。
//   const env = createEnv({ appId: 749, loginCode: '24136' });
//   env.load('payment_request_main_20260521.js');
//   const event = await env.fire('app.record.create.show', { record });

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const rootDir = path.join(__dirname, '..', '..');
const readSrc = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8');

const makeElement = () => {
  const el = {
    className: '',
    textContent: '',
    innerHTML: '',
    id: '',
    style: {},
    children: [],
    listeners: {},
    removed: false,
    attributes: {},
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    replaceChildren(...nodes) {
      el.children = nodes;
    },
    setAttribute(name, value) {
      el.attributes[name] = String(value);
    },
    focus() {
      el.focused = true;
    },
    addEventListener(type, fn) {
      el.listeners[type] = fn;
    },
    click() {
      if (el.listeners.click) el.listeners.click();
    },
    remove() {
      el.removed = true;
    },
  };
  return el;
};

/**
 * 讀出選單位視窗（簽核人員的 openOrgDialog，掛在 document.body 的 .pr-org-picker-overlay）。
 * @param {Object} overlay makeElement 做出來的元素
 * @returns {{ title: string, hint: string, options: Array, labels: string[], cancel: Object|undefined }}
 */
const readOrgPicker = (overlay) => {
  const box = overlay.children[0];
  const byClass = (cls) => box.children.filter((c) => c.className === cls);
  const options = byClass('pr-org-picker__option');
  return {
    title: byClass('pr-org-picker__title')[0]?.textContent || '',
    hint: byClass('pr-org-picker__hint')[0]?.textContent || '',
    options,
    labels: options.map((b) => b.textContent),
    cancel: byClass('pr-org-picker__cancel')[0],
  };
};

/**
 * @param {Object} [opts]
 * @param {number} [opts.appId=749]
 * @param {string} [opts.loginCode='24136'] 登入者代碼（24136 在管理員名單內）
 * @param {Function} [opts.api] 替身 kintone.api(url, method, params)
 * @param {Object|Function} [opts.swalAnswer] 有給才讓 Swal.fire 回傳 Promise（視窗的回答；函式時以 opts 決定）
 */
const createEnv = ({ appId = 749, loginCode = '24136', api, swalAnswer } = {}) => {
  const handlers = [];
  const timers = [];
  const logs = { log: [], warn: [], error: [] };
  const spaces = {};
  const shown = {};
  const documentCalls = { querySelectorAll: [], querySelector: [], createdElements: [], headAppended: [], bodyAppended: [] };
  const swalCalls = [];

  const overrides = { querySelectorAll: null, querySelector: null };
  const documentStub = {
    getElementById: () => null,
    createElement: () => {
      const el = makeElement();
      documentCalls.createdElements.push(el);
      return el;
    },
    head: { appendChild: (el) => documentCalls.headAppended.push(el) },
    body: {
      appendChild: (el) => {
        documentCalls.bodyAppended.push(el);
        if (env.onBodyAppend) env.onBodyAppend(el);
        return el;
      },
    },
    querySelectorAll: (selector) => {
      documentCalls.querySelectorAll.push(selector);
      return overrides.querySelectorAll ? overrides.querySelectorAll(selector) : [];
    },
    querySelector: (selector) => {
      documentCalls.querySelector.push(selector);
      return overrides.querySelector ? overrides.querySelector(selector) : null;
    },
  };

  const kintoneStub = {
    app: {
      getId: () => appId,
      record: {
        get: () => ({ record: env.currentRecord }),
        set: (r) => {
          env.setCalls.push(r);
          env.currentRecord = r.record;
        },
        getSpaceElement: (id) => {
          spaces[id] = spaces[id] || makeElement();
          return spaces[id];
        },
        setFieldShown: (code, value) => {
          shown[code] = value;
        },
      },
    },
    getLoginUser: () => ({ code: loginCode }),
    events: { on: (types, handler) => handlers.push({ types: Array.isArray(types) ? types : [types], handler }) },
    api: Object.assign((...args) => (api ? api(...args) : Promise.reject(new Error('未設定 api 替身'))), { url: (p) => p }),
  };

  const sandbox = {
    window: { location: { href: '' } },
    kintone: kintoneStub,
    document: documentStub,
    Swal: {
      fire: (opts) => {
        const n = swalCalls.push(opts);
        if (swalAnswer === undefined) return n;
        return Promise.resolve(typeof swalAnswer === 'function' ? swalAnswer(opts) : swalAnswer);
      },
    },
    console: {
      log: (...a) => logs.log.push(a.join(' ')),
      warn: (...a) => logs.warn.push(a.join(' ')),
      error: (...a) => logs.error.push(a.join(' ')),
    },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {},
    getComputedStyle: () => ({ display: '', visibility: '' }),
  };
  vm.createContext(sandbox);

  const env = {
    window: sandbox.window,
    spaces,
    shown,
    timers,
    logs,
    documentCalls,
    swalCalls,
    handlers,
    currentRecord: null,
    setCalls: [],
    /** document.body.appendChild 時呼叫（測試用來「點」選單位視窗的按鈕） */
    onBodyAppend: null,
    /** 換掉 document.querySelectorAll／querySelector 的回傳（仍會記錄被查詢的選擇器） */
    setQuerySelectorAll: (fn) => {
      overrides.querySelectorAll = fn;
    },
    setQuerySelector: (fn) => {
      overrides.querySelector = fn;
    },
    /** 載入（執行）專案根目錄的一支 js */
    load: (file) => vm.runInContext(readSrc(file), sandbox, { filename: file }),
    /** 觸發事件：依註冊順序執行所有監聽該事件的處理程式，回傳最後的 event */
    fire: async (type, event) => {
      const ev = { type, ...event };
      for (const h of handlers.filter((x) => x.types.includes(type))) {
        const result = await h.handler(ev);
        if (result && result !== ev) Object.assign(ev, result);
      }
      return ev;
    },
    /** 執行目前排隊的 setTimeout（只跑一輪） */
    flushTimers: () => timers.splice(0).forEach((t) => t.fn()),
    registeredTypes: () => handlers.flatMap((h) => h.types),
  };
  return env;
};

/** 建立一個斷言輔助：check(label, fn) 依序執行（支援 async），最後印出總數 */
const createRunner = (title) => {
  let passed = 0;
  let chain = Promise.resolve();
  console.log(title);
  return {
    check: (label, fn) => {
      chain = chain.then(async () => {
        await fn();
        passed += 1;
        console.log(`  ok - ${label}`);
      });
    },
    done: () =>
      chain.then(
        () => console.log(`\n${passed} assertions passed.`),
        (err) => {
          process.stderr.write(`${err.stack || err}\n`);
          process.exit(1);
        },
      ),
  };
};

module.exports = { createEnv, createRunner, readSrc, rootDir, makeElement, readOrgPicker };
