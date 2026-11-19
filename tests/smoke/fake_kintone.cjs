'use strict';

// 冒煙測試用的假 kintone 執行環境（不連真的 kintone）。
// installFakeKintone 會被 Playwright 的 page.addInitScript 序列化後在「瀏覽器」裡執行，
// 所以函式內不能用外面的變數或 require；一律經 globalThis 取 window／document（ESLint 用 node 全域檢查本檔）。
//
// 提供：
//   kintone.events.on／app.getId／app.record.get・set・setFieldShown・getFieldElement・getSpaceElement
//   kintone.api（依網址＋app 回假資料，資料放 globalThis.__smoke.db）、getLoginUser、user.getOrganizations
//   Swal（只做 fire／close／showLoading 等，fire 會在畫面上畫出 .swal2-popup，按鈕可關）
//   __smoke.fire(type, event)：依註冊順序跑處理程式（可回傳 Promise），回傳最後的 event（同 tests/lib/pr_env.cjs 的 fire）

/**
 * @param {{ appId: number, loginUser: { id: string, code: string, name: string } }} opts
 */
function installFakeKintone(opts) {
  const g = globalThis;
  const handlers = [];
  const smoke = {
    // kintone.api GET /k/v1/records 回這裡的資料（不看 query 條件）。
    // 鍵可以是 App ID，或 PR_CONFIG.APPS 的名稱（例：COST_CENTER），測試裡就不用寫 App 的數字。
    db: {},
    apiCalls: [],
    swalCalls: [],
    shown: {},
    record: null,
    errors: [],
    /** 觸發事件：依註冊順序執行所有監聽該事件的處理程式，回傳最後的 event */
    fire: async (type, event) => {
      let ev = { type, appId: opts.appId, recordId: null, ...event };
      smoke.record = ev.record;
      for (const h of handlers.filter((x) => x.types.includes(type))) {
        const result = await h.handler(ev);
        if (result && typeof result === 'object') ev = result;
      }
      smoke.record = ev.record;
      return ev;
    },
    handlerCount: (type) => handlers.filter((x) => x.types.includes(type)).length,
    /**
     * 做一筆 event.record：真的 kintone 會帶齊表單所有欄位，這裡只給測試在意的欄位，
     * 其他欄位第一次被讀到時補成空白文字欄位（{ value: '' }）。
     */
    makeRecord: (fields) =>
      new Proxy(fields, {
        get: (target, key) => {
          if (typeof key === 'string' && !(key in target)) target[key] = { type: 'SINGLE_LINE_TEXT', value: '' };
          return target[key];
        },
      }),
  };
  g.__smoke = smoke;

  const reply = (body) => Promise.resolve(JSON.parse(JSON.stringify(body)));
  const fakeApi = (url, method, params = {}) => {
    smoke.apiCalls.push({ url, method, params });
    const path = String(url).replace(/^.*?(\/k\/v1\/|\/v1\/)/, '$1').replace(/\.json$/, '');
    const appName = Object.entries(g.PR_CONFIG?.APPS || {}).find(([, id]) => id === params.app)?.[0];
    const records = smoke.db[params.app] || smoke.db[appName] || [];
    if (method === 'GET') {
      if (path === '/k/v1/records') return reply({ records, totalCount: String(records.length) });
      if (path === '/k/v1/record') {
        const record = records.find((r) => String(r.$id?.value) === String(params.id));
        return record ? reply({ record }) : Promise.reject(new Error(`假 kintone：App ${params.app} 沒有記錄 ${params.id}`));
      }
      if (path === '/k/v1/app/form/fields') return reply({ properties: {} });
      if (path === '/v1/users') return reply({ users: [] });
      if (path === '/v1/user/organizations') return reply({ organizationTitles: [] });
      if (path === '/v1/user/groups') return reply({ groups: [] });
      if (path === '/v1/organizations') return reply({ organizations: [] });
      if (path === '/v1/group/users') return reply({ users: [] });
    }
    if (method === 'POST' && path === '/k/v1/records/cursor') return reply({ id: 'cursor-1', totalCount: String(records.length) });
    if (method === 'GET' && path === '/k/v1/records/cursor') return reply({ records, next: false });
    return reply({});
  };
  fakeApi.url = (p) => `https://smoke.cybozu.test${p.endsWith('.json') ? p : `${p}.json`}`;

  const byId = (id) => g.document.getElementById(id);
  g.kintone = {
    events: {
      on: (types, handler) => handlers.push({ types: [].concat(types), handler }),
    },
    app: {
      getId: () => opts.appId,
      getFormFields: () => Promise.resolve({}),
      getHeaderMenuSpaceElement: () => byId('smoke-header-menu'),
      record: {
        get: () => ({ record: smoke.record }),
        set: (r) => {
          smoke.record = r.record;
        },
        getId: () => null,
        setFieldShown: (code, value) => {
          smoke.shown[code] = value;
        },
        getFieldElement: () => null,
        getSpaceElement: (id) => {
          let el = byId(`smoke-space-${id}`);
          if (!el) {
            el = g.document.createElement('div');
            el.id = `smoke-space-${id}`;
            byId('smoke-record').appendChild(el);
          }
          return el;
        },
      },
    },
    api: fakeApi,
    getLoginUser: () => ({ ...opts.loginUser }),
    user: { getOrganizations: () => Promise.resolve([]) },
  };

  // SweetAlert2 替身：畫出一個 .swal2-popup，記下參數；按確認鈕關閉
  const closePopup = () => g.document.querySelectorAll('.swal2-container').forEach((n) => n.remove());
  g.Swal = {
    fire: (arg, text, icon) => {
      const o = typeof arg === 'object' && arg ? arg : { title: arg, text, icon };
      smoke.swalCalls.push({ title: o.title, html: o.html, text: o.text, icon: o.icon });
      closePopup();
      const box = g.document.createElement('div');
      box.className = 'swal2-container';
      const popup = g.document.createElement('div');
      popup.className = `swal2-popup ${o.customClass?.popup || ''}`.trim();
      popup.setAttribute('role', 'dialog');
      const title = g.document.createElement('h2');
      title.className = 'swal2-title';
      title.textContent = o.title || '';
      const body = g.document.createElement('div');
      body.className = 'swal2-html-container';
      if (o.html) body.innerHTML = o.html;
      else body.textContent = o.text || '';
      const ok = g.document.createElement('button');
      ok.className = 'swal2-confirm';
      ok.textContent = o.confirmButtonText || 'OK';
      popup.append(title, body, ok);
      box.appendChild(popup);
      g.document.body.appendChild(box);
      return new Promise((resolve) => {
        ok.addEventListener('click', () => {
          closePopup();
          resolve({ isConfirmed: true, value: true });
        });
      });
    },
    close: closePopup,
    showLoading: () => {},
    showValidationMessage: () => {},
    getPopup: () => g.document.querySelector('.swal2-popup'),
    isVisible: () => !!g.document.querySelector('.swal2-popup'),
  };

  g.addEventListener('error', (e) => smoke.errors.push(String(e.message)));
  g.addEventListener('unhandledrejection', (e) => smoke.errors.push(String(e.reason?.message || e.reason)));
}

module.exports = { installFakeKintone };
