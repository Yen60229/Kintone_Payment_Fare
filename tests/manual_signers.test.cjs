'use strict';

// 測試：手動簽核人設定_20261102.js
//   一、排法規則（checkSigners）：第 1 位必填、不能跳格、不能重複、申請人不能簽自己的單、一格只能一人
//   二、存檔檢查（validate）：只限費用歸屬不限部門群組、手動會計承辦人必填（管理員略過）、寫入手動簽核人數
//   三、找人（searchUsers、/v1/users.json 分頁與快取）
//   四、指定簽核人視窗（SweetAlert）：鎖格、點選、換人往前補、擋申請人與重複、會計承辦人（第 4 格）、完成／取消、最近選過
//   五、畫面：三格顯示與鎖住、人數欄位隱藏、「設定簽核人」按鈕、按完成後寫回畫面（含會計承辦人）
// 單獨執行：node tests/manual_signers.test.cjs

const assert = require('assert');
const { createEnv, createRunner } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('manual_signers.test.cjs');
const U = (code, name = code) => ({ code, name });
const S = ['手動簽核人1', '手動簽核人2', '手動簽核人3'];
const COUNT = '手動簽核人數';
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** 遞迴找出 className 含某個 class 的元素 */
const findAll = (root, cls) => {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (String(node.className || '').split(' ').includes(cls)) out.push(node);
    (node.children || []).forEach(walk);
  };
  walk(root);
  return out;
};
const find = (root, cls) => findAll(root, cls)[0];
/** 簽核路線（.pr-route）每一站：「標籤 名字」 */
const routeOf = (root) =>
  findAll(root, 'pr-route__stop').map((li) => `${find(li, 'pr-route__label').textContent} ${find(li, 'pr-route__name').textContent}`);

/**
 * 假的 SweetAlert：記下 fire 的設定，confirm() 會跑 preConfirm（回 false 時視窗不關），cancel() 當按取消。
 * html 是視窗內容的元素，測試直接在上面點。
 */
const fakeSwal = () => {
  const popups = [];
  const swal = {
    fire: (opts) =>
      new Promise((resolve) => {
        const popup = {
          opts,
          validation: '',
          closed: false,
          confirm: async () => {
            const value = await opts.preConfirm();
            if (value === false) return false;
            popup.closed = true;
            resolve({ isConfirmed: true, value });
            return value;
          },
          cancel: () => {
            popup.closed = true;
            resolve({ isConfirmed: false, dismiss: 'cancel' });
          },
        };
        popups.push(popup);
        if (opts.didOpen) opts.didOpen();
      }),
    showValidationMessage: (m) => {
      popups[popups.length - 1].validation = m;
    },
    resetValidationMessage: () => {
      popups[popups.length - 1].validation = '';
    },
  };
  return { swal, popups };
};

const USERS = [U('a01', '王小明'), U('a02', '王大同'), U('b01', '李美玲'), U('ME', '申請人甲'), U('x99', '離職者')];

const setup = ({ loginCode = 'u1', exempt = true, users = USERS, storage } = {}) => {
  const apiCalls = [];
  const env = createEnv({
    loginCode,
    api: (url, method, params) => {
      apiCalls.push({ url, params });
      if (url === '/v1/users.json') {
        const page = users.slice(params.offset, params.offset + params.size).map((u) => ({ ...u, valid: u.code !== 'x99' }));
        return Promise.resolve({ users: page });
      }
      return Promise.reject(new Error(`未預期的 API ${url}`));
    },
  });
  const store = storage || {};
  env.window.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = v;
    },
  };
  const { swal, popups } = fakeSwal();
  env.window.Swal = swal;
  env.load('payment_request_config.js');
  env.window.PR_COST_SCOPE = { applicantCodeOf: (r) => r['申請人']?.value?.[0]?.code, ensureExempt: () => Promise.resolve(exempt), isExempt: () => exempt };
  env.load('手動簽核人設定_20261102.js');
  return { env, M: env.window.PR_MANUAL_SIGNERS, C: env.window.PR_CONFIG, apiCalls, popups, store };
};

const recordOf = ({ manual = true, signers = [], status = '草稿（未送出）', staff = [U('ACC1')], voided = false } = {}) => {
  const r = {
    申請人: { type: 'USER_SELECT', value: [U('ME', '申請人甲')] },
    手動設定簽核流程: { type: 'CHECK_BOX', value: manual ? ['手動設定簽核流程'] : [] },
    手動會計承辦人: { type: 'USER_SELECT', value: staff },
    表單作廢: { type: 'CHECK_BOX', value: voided ? ['作廢'] : [] },
    狀態: { type: 'STATUS', value: status },
    [COUNT]: { type: 'DROP_DOWN', value: '' },
  };
  S.forEach((f, i) => {
    const v = signers[i];
    r[f] = { type: 'USER_SELECT', value: Array.isArray(v) ? v : v ? [v] : [] };
  });
  return r;
};

// ── 一、排法規則 ────────────────────────────────────────────────────────────
check('排法：1 位或 1→2→3 都可以', () => {
  const { M } = setup();
  assert.strictEqual(M.checkSigners([[U('a')], [], []], 'ME').length, 0);
  assert.strictEqual(M.checkSigners([[U('a')], [U('b')], [U('c')]], 'ME').length, 0);
});

check('排法：一個都沒有 → 提醒至少要第 1 位', () => {
  const { M } = setup();
  const errors = M.checkSigners([[], [], []], 'ME');
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /還沒指定簽核人/);
  assert.match(errors[0], /設定簽核人/);
});

check('排法：中間空格（第 2 位空、第 3 位有人；或只填第 3 位）→ 請往前補', () => {
  const { M } = setup();
  assert.match(M.checkSigners([[U('a')], [], [U('c')]], 'ME').join('|'), /第 2 位空著，後面卻有人/);
  const onlyThird = M.checkSigners([[], [], [U('c')]], 'ME').join('|');
  assert.match(onlyThird, /還沒指定簽核人/);
  assert.match(onlyThird, /第 2 位空著/);
});

check('排法：同一個人排兩次 → 擋下並列出是哪幾位', () => {
  const { M } = setup();
  const errors = M.checkSigners([[U('a', '王小明')], [U('b')], [U('a', '王小明')]], 'ME');
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /王小明 排了 2 次（第 1 位、第 3 位）/);
});

check('排法：申請人自己 → 擋下；一格選了兩個人 → 擋下', () => {
  const { M } = setup();
  assert.match(M.checkSigners([[U('ME', '申請人甲')], [], []], 'ME').join('|'), /申請人不能簽自己的單\n▸第 1 位：申請人甲/);
  assert.match(M.checkSigners([[U('a'), U('b')], [], []], 'ME').join('|'), /第 1 位簽核人只能選 1 個人（現在有 2 位）/);
});

check('人數欄位的值：依實際填的人數，沒人是空白', () => {
  const { M } = setup();
  assert.strictEqual(M.countValueOf([U('a'), null, null]), '1人');
  assert.strictEqual(M.countValueOf([U('a'), U('b'), U('c')]), '3人');
  assert.strictEqual(M.countValueOf([null, null, null]), '');
});

// ── 二、存檔檢查 ────────────────────────────────────────────────────────────
check('存檔：不是手動模式、或勾了作廢 → 不檢查', async () => {
  const { M } = setup();
  assert.strictEqual((await M.validate(recordOf({ manual: false }))).length, 0);
  assert.strictEqual((await M.validate(recordOf({ voided: true }))).length, 0);
});

check('存檔：排得對就通過，並把手動簽核人數寫成實際人數（流程管理靠它分關卡）', async () => {
  const { M } = setup();
  const r = recordOf({ signers: [U('a01'), U('b01')] });
  assert.strictEqual((await M.validate(r)).length, 0);
  assert.strictEqual(r[COUNT].value, '2人');
});

check('存檔：送出後（不能改簽核人的狀態）不重寫人數欄位；駁回狀態可以', async () => {
  const { M } = setup();
  const sent = recordOf({ signers: [U('a01')], status: '手動簽核1確認中' });
  await M.validate(sent);
  assert.strictEqual(sent[COUNT].value, '');
  const rejected = recordOf({ signers: [U('a01')], status: '手動簽核駁回' });
  await M.validate(rejected);
  assert.strictEqual(rejected[COUNT].value, '1人');
});

check('存檔：申請人不在「費用歸屬不限部門」群組 → 只說不能手動設定，不列其他問題', async () => {
  const { M } = setup({ exempt: false });
  const errors = await M.validate(recordOf({ signers: [] }));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /只有「費用歸屬不限部門」的同仁可以手動設定簽核流程/);
  assert.match(errors[0], /請取消勾選/);
});

check('存檔：手動會計承辦人空白 → 一般使用者擋下，管理員略過', async () => {
  const user = setup({ loginCode: 'nobody' });
  assert.match((await user.M.validate(recordOf({ signers: [U('a01')], staff: [] }))).join('|'), /還沒指定會計承辦人/);
  const admin = setup({ loginCode: '24136' });
  assert.strictEqual((await admin.M.validate(recordOf({ signers: [U('a01')], staff: [] }))).length, 0);
});

// ── 三、找人 ───────────────────────────────────────────────────────────────
check('找人：姓名或帳號包含就算、開頭符合的排前面、最多 8 筆、空白不找', () => {
  const { M } = setup();
  const users = [U('z1', '林王一'), U('a01', '王小明'), U('wang', '陳大文')];
  assert.deepStrictEqual(
    Array.from(M.searchUsers(users, '王'), (u) => u.code),
    ['a01', 'z1'],
  );
  assert.deepStrictEqual(
    Array.from(M.searchUsers(users, 'WANG'), (u) => u.code),
    ['wang'],
  );
  assert.strictEqual(M.searchUsers(users, '  ').length, 0);
  const many = Array.from({ length: 20 }, (_, i) => U(`p${i}`, `王${i}`));
  assert.strictEqual(M.searchUsers(many, '王').length, 8);
});

// ── 四、視窗 ───────────────────────────────────────────────────────────────
const openWith = async (t, opts) => {
  const result = t.M.openDialog({ applicant: U('ME', '申請人甲'), accounting: [U('ACC1', '會計王')], ...opts });
  await settle();
  const popup = t.popups[t.popups.length - 1];
  const root = popup.opts.html;
  const steps = () => findAll(root, 'pr-signer__step');
  const type = async (slot, text) => {
    const input = find(steps()[slot], 'pr-signer__input');
    input.value = text;
    input.listeners.input();
    await settle();
    return findAll(steps()[slot], 'pr-signer__result');
  };
  return { result, popup, root, steps, type };
};

check('視窗：用 SweetAlert 開（自訂按鈕樣式、不能點外面關掉）；四格＝三位簽核人＋會計承辦人', async () => {
  const t = setup();
  const d = await openWith(t, { initial: [] });
  const o = d.popup.opts;
  assert.strictEqual(o.title, '指定簽核人');
  assert.strictEqual(o.showCancelButton, true);
  assert.strictEqual(o.confirmButtonText, '完成');
  assert.strictEqual(o.buttonsStyling, false);
  assert.strictEqual(o.allowOutsideClick, false);
  assert.match(o.customClass.popup, /pr-signer-popup/);
  assert.match(o.customClass.confirmButton, /pr-signer-btn--primary/);
  assert.match(o.customClass.cancelButton, /pr-signer-btn--ghost/);
  assert.strictEqual(d.steps().length, 4);
  const acc = d.steps()[3];
  assert.ok(acc.className.includes('pr-signer__step--accounting'));
  assert.ok(acc.className.includes('is-filled'), '會計承辦人預設帶入');
  assert.strictEqual(find(acc, 'pr-signer__name').textContent, '會計王');
  assert.match(find(acc, 'pr-signer__hint').textContent, /單位會計處理中/);
});

check('視窗：上方「簽核會經過」一行最多 5 格、即時更新；下一個要填的那格亮呼吸燈；簽核人不到 3 位時多一格「可不填」', async () => {
  const t = setup();
  const d = await openWith(t, { initial: [], accounting: [] });
  const box = () => find(d.root, 'pr-signer__route');
  const route = () => routeOf(box());
  const next = () => findAll(box(), 'is-next').map((li) => find(li, 'pr-route__label').textContent);
  assert.strictEqual(find(d.root, 'pr-signer__route-title').textContent, '簽核會經過');
  assert.deepStrictEqual(route(), ['申請人 申請人甲', '第 1 關 尚未指定', '會計 尚未指定']);
  assert.strictEqual(findAll(box(), 'is-empty').length, 2);
  assert.deepStrictEqual(next(), ['第 1 關']);
  (await d.type(0, '王小明'))[0].click();
  assert.deepStrictEqual(route(), ['申請人 申請人甲', '第 1 關 王小明', '第 2 關 可不填', '會計 尚未指定']);
  assert.deepStrictEqual(next(), ['第 2 關']);
  (await d.type(1, '李美玲'))[0].click();
  (await d.type(3, '王大同'))[0].click();
  assert.deepStrictEqual(route(), ['申請人 申請人甲', '第 1 關 王小明', '第 2 關 李美玲', '第 3 關 可不填', '會計 王大同']);
  assert.strictEqual(findAll(box(), 'pr-route__stop').length, 5, '最多 5 格');
  assert.strictEqual(findAll(box(), 'is-empty').length, 0, '可不填是選填，不標紅');
});

check('視窗：簽核人排滿 3 位 → 不再多一格，仍是 5 格；會計還沒指定時呼吸燈在會計那格', async () => {
  const t = setup();
  const d = await openWith(t, { initial: [U('a01', '王小明'), U('b01', '李美玲'), U('a02', '王大同')], accounting: [] });
  const box = find(d.root, 'pr-signer__route');
  assert.strictEqual(findAll(box, 'pr-route__stop').length, 5);
  assert.deepStrictEqual(
    findAll(box, 'is-next').map((li) => find(li, 'pr-route__label').textContent),
    ['會計'],
  );
});

check('視窗：一開始只有第 1 位能填，第 2、3 位提示要先選前一位；游標在第 1 位', async () => {
  const t = setup();
  const d = await openWith(t, { initial: [] });
  assert.ok(find(d.steps()[0], 'pr-signer__input'));
  assert.match(find(d.steps()[1], 'pr-signer__locked').textContent, /先選好第 1 位/);
  assert.ok(d.steps()[2].className.includes('is-locked'));
  assert.strictEqual(find(d.steps()[0], 'pr-signer__input').focused, true, '游標直接在第 1 位');
});

check('視窗：沒選第 1 位就按完成 → 視窗不關，SweetAlert 底下提醒', async () => {
  const t = setup();
  const d = await openWith(t, { initial: [] });
  assert.strictEqual(await d.popup.confirm(), false);
  assert.match(d.popup.validation, /還沒指定簽核人/);
  assert.strictEqual(d.popup.closed, false);
});

check('視窗：打字列出符合的人（不含停用帳號）；申請人本人列出但不能點', async () => {
  const t = setup();
  const d = await openWith(t, { initial: [] });
  const rows = await d.type(0, '王');
  assert.deepStrictEqual(
    rows.map((r) => r.children[0].textContent),
    ['王小明', '王大同'],
  );
  const self = await d.type(0, '申請人');
  assert.strictEqual(self.length, 1);
  assert.ok(self[0].className.includes('is-blocked'));
  assert.strictEqual(self[0].children[1].textContent, '申請人本人');
  assert.strictEqual(self[0].listeners.click, undefined);
  const none = await d.type(0, '不存在的人');
  assert.strictEqual(none.length, 0);
  assert.match(find(d.steps()[0], 'pr-signer__results').children[0].textContent, /找不到「不存在的人」/);
  assert.strictEqual((await d.type(0, '離職')).length, 0);
});

check('視窗：點選第 1 位 → 這格顯示名字，第 2 位開放；已排過的人在第 2 位顯示「已排在第 1 位」；選人後清掉提醒', async () => {
  const t = setup();
  const d = await openWith(t, { initial: [] });
  await d.popup.confirm();
  (await d.type(0, '王小明'))[0].click();
  assert.strictEqual(d.popup.validation, '');
  assert.strictEqual(find(d.steps()[0], 'pr-signer__name').textContent, '王小明');
  assert.ok(d.steps()[0].className.includes('is-filled'));
  assert.strictEqual(find(d.steps()[1], 'pr-signer__input').focused, true, '游標跳到下一位');
  const rows = await d.type(1, '王');
  assert.strictEqual(rows[0].children[1].textContent, '已排在第 1 位');
  assert.ok(rows[0].className.includes('is-blocked'));
});

check('視窗：鍵盤 ↓ Enter 選人', async () => {
  const t = setup();
  const d = await openWith(t, { initial: [] });
  await d.type(0, '王');
  const input = find(d.steps()[0], 'pr-signer__input');
  const key = (k) => input.listeners.keydown({ key: k, preventDefault: () => {} });
  key('ArrowDown');
  key('ArrowDown');
  assert.ok(findAll(d.steps()[0], 'pr-signer__result')[1].className.includes('is-active'));
  key('Enter');
  assert.strictEqual(find(d.steps()[0], 'pr-signer__name').textContent, '王大同');
});

check('視窗：第 1 位換人 → 後面的人自動往前補，不會留空格', async () => {
  const t = setup();
  const d = await openWith(t, { initial: [U('a01', '王小明'), U('b01', '李美玲')] });
  find(d.steps()[0], 'pr-signer__change').click();
  assert.strictEqual(find(d.steps()[0], 'pr-signer__name').textContent, '李美玲');
  assert.ok(find(d.steps()[1], 'pr-signer__input'));
  assert.ok(d.steps()[2].className.includes('is-locked'));
});

check('視窗：舊資料有空格（1、3 有人）→ 開視窗時往前補成 1、2', async () => {
  const t = setup();
  const d = await openWith(t, { initial: [U('a01', '王小明'), null, U('b01', '李美玲')] });
  assert.strictEqual(find(d.steps()[1], 'pr-signer__name').textContent, '李美玲');
  assert.ok(find(d.steps()[2], 'pr-signer__input'));
});

check('視窗：會計承辦人可換人（不限申請人、可和簽核人同一位）；空著按完成要提醒，管理員可不填', async () => {
  const t = setup();
  const d = await openWith(t, { initial: [U('a01', '王小明')] });
  find(d.steps()[3], 'pr-signer__change').click();
  assert.strictEqual(find(d.steps()[3], 'pr-signer__input').focused, true);
  assert.strictEqual(await d.popup.confirm(), false);
  assert.match(d.popup.validation, /請指定會計承辦人/);
  const rows = await d.type(3, '王小明');
  assert.ok(!rows[0].className.includes('is-blocked'));
  rows[0].click();
  await d.popup.confirm();
  const out = await d.result;
  assert.deepStrictEqual(
    Array.from(out.accounting, (u) => u.code),
    ['a01'],
  );

  const admin = await openWith(t, { initial: [U('a01')], accounting: [], accountingRequired: false });
  assert.strictEqual(find(admin.steps()[3], 'pr-signer__tag').textContent, '可不填');
  assert.ok(!find(admin.steps()[3], 'pr-signer__tag').className.includes('is-required'));
  assert.ok(find(admin.steps()[0], 'pr-signer__tag').className.includes('is-required'), '必填標籤用紅色');
  await admin.popup.confirm();
  assert.strictEqual((await admin.result).accounting.length, 0);
});

check('視窗：會計承辦人比視窗晚帶入 → 空著才補上，已選的人不蓋掉', async () => {
  const t = setup();
  t.env.currentRecord = recordOf({ signers: [] });
  const d = await openWith(t, { initial: [], accounting: [] });
  assert.ok(find(d.steps()[3], 'pr-signer__input'));
  t.M.offerAccounting([U('ACC2', '會計李')]);
  assert.strictEqual(find(d.steps()[3], 'pr-signer__name').textContent, '會計李');
  t.M.offerAccounting([U('ACC3', '會計陳')]);
  assert.strictEqual(find(d.steps()[3], 'pr-signer__name').textContent, '會計李');
});

check('視窗：按完成回傳簽核人與會計承辦人、記住最近選過；按取消回傳 null', async () => {
  const t = setup();
  const d = await openWith(t, { initial: [U('a01', '王小明')] });
  await d.popup.confirm();
  const out = await d.result;
  assert.deepStrictEqual(
    Array.from(out.signers, (u) => u && u.code),
    ['a01', null, null],
  );
  assert.deepStrictEqual(
    Array.from(out.accounting, (u) => u.code),
    ['ACC1'],
  );
  assert.strictEqual(d.popup.closed, true);
  assert.match(t.store[t.C.MANUAL_SIGNERS.RECENT_KEY], /a01/);

  const d2 = await openWith(t, { initial: [] });
  d2.popup.cancel();
  assert.strictEqual(await d2.result, null);
});

check('視窗：沒打字時列出這台電腦最近選過的人；localStorage 壞掉也照常開', async () => {
  const t = setup({ storage: { pr_manual_signers_recent: JSON.stringify([U('b01', '李美玲')]) } });
  const d = await openWith(t, { initial: [] });
  const input = find(d.steps()[0], 'pr-signer__input');
  input.listeners.focus();
  const list = find(d.steps()[0], 'pr-signer__results');
  assert.strictEqual(list.children[0].textContent, '最近選過');
  assert.strictEqual(list.children[1].children[0].textContent, '李美玲');

  const broken = setup();
  broken.env.window.localStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  const d3 = await openWith(broken, { initial: [U('a01')] });
  await d3.popup.confirm();
  assert.strictEqual((await d3.result).signers[0].code, 'a01');
});

check('人員名單：分頁抓到最後一頁、抓過就不再抓；抓不到時視窗說明；沒有 SweetAlert 不開視窗', async () => {
  const many = Array.from({ length: 130 }, (_, i) => U(`p${i}`, `人${i}`));
  const t = setup({ users: many });
  const d = await openWith(t, { initial: [] });
  const calls = t.apiCalls.filter((c) => c.url === '/v1/users.json');
  assert.deepStrictEqual(
    calls.map((c) => c.params.offset),
    [0, 100],
  );
  assert.strictEqual(calls[0].params.size, 100);
  assert.strictEqual((await d.type(0, '人12')).length, 8);
  d.popup.cancel();
  await d.result;
  await openWith(t, { initial: [] });
  assert.strictEqual(t.apiCalls.filter((c) => c.url === '/v1/users.json').length, 2, '第二次開視窗用快取');

  const failing = createEnv({ api: () => Promise.reject(new Error('403')) });
  const fs = fakeSwal();
  failing.window.Swal = fs.swal;
  failing.load('payment_request_config.js');
  failing.load('手動簽核人設定_20261102.js');
  failing.window.PR_MANUAL_SIGNERS.openDialog({ initial: [], applicant: U('ME'), accounting: [] });
  await settle();
  assert.match(find(fs.popups[0].opts.html, 'pr-signer__results').children[0].textContent, /讀不到人員名單/);

  const noSwal = createEnv();
  noSwal.load('payment_request_config.js');
  noSwal.load('手動簽核人設定_20261102.js');
  assert.strictEqual(await noSwal.window.PR_MANUAL_SIGNERS.openDialog({ initial: [], applicant: null, accounting: [] }), null);
  assert.match(noSwal.logs.error.join('|'), /找不到 SweetAlert/);
});

// ── 五、畫面 ───────────────────────────────────────────────────────────────
check('新增／編輯畫面：手動模式顯示三格（鎖住，只能從視窗改）、人數欄位不顯示、出現「設定簽核人」按鈕', async () => {
  const t = setup();
  const r = recordOf({ signers: [] });
  await t.env.fire('app.record.create.show', { record: r });
  S.forEach((f) => {
    assert.strictEqual(t.env.shown[f], true, f);
    assert.strictEqual(r[f].disabled, true, f);
  });
  assert.strictEqual(t.env.shown[COUNT], false);
  assert.strictEqual(t.env.shown['手動會計承辦人'], true);
  assert.strictEqual(r['手動會計承辦人'].disabled, true, '手動會計承辦人也只能從視窗改');
  const entry = t.env.spaces[t.C.SPACES.MANUAL_SIGNERS].children[0];
  assert.strictEqual(find(entry, 'pr-signer-entry__btn').textContent, '設定簽核人');
  assert.strictEqual(find(entry, 'pr-signer-entry__summary').textContent, '還沒指定簽核人');
});

check('自動模式：三格不顯示、沒有按鈕；送出後的狀態：手動也不出現按鈕', async () => {
  const t = setup();
  await t.env.fire('app.record.edit.show', { record: recordOf({ manual: false }) });
  S.forEach((f) => assert.strictEqual(t.env.shown[f], false, f));
  assert.strictEqual(t.env.spaces[t.C.SPACES.MANUAL_SIGNERS].children.length, 0);
  await t.env.fire('app.record.edit.show', { record: recordOf({ signers: [U('a01')], status: '手動簽核1確認中' }) });
  assert.strictEqual(t.env.spaces[t.C.SPACES.MANUAL_SIGNERS].children.length, 0);
});

check('詳細畫面：手動模式只顯示有填的格子', async () => {
  const t = setup();
  await t.env.fire('app.record.detail.show', { record: recordOf({ signers: [U('a01'), U('b01')] }) });
  assert.deepStrictEqual(
    S.map((f) => t.env.shown[f]),
    [true, true, false],
  );
});

check('按「設定簽核人」→ 選人按完成 → 寫回畫面（三格、人數、會計承辦人並鎖住），按鈕改成「更改簽核人」並列出順序', async () => {
  const t = setup();
  t.env.currentRecord = recordOf({ signers: [] });
  await t.env.fire('app.record.create.show', { record: t.env.currentRecord });
  find(t.env.spaces[t.C.SPACES.MANUAL_SIGNERS], 'pr-signer-entry__btn').click();
  await settle();
  const popup = t.popups[0];
  const step = (i) => findAll(popup.opts.html, 'pr-signer__step')[i];
  const pick = async (i, text) => {
    const input = find(step(i), 'pr-signer__input');
    input.value = text;
    input.listeners.input();
    await settle();
    find(step(i), 'pr-signer__result').click();
  };
  await pick(0, '李美玲');
  await pick(1, '王大同');
  find(step(3), 'pr-signer__change').click();
  await pick(3, '王小明');
  await popup.confirm();
  await settle();
  const live = t.env.currentRecord;
  assert.deepStrictEqual(
    S.map((f) => (live[f].value[0] || {}).code || ''),
    ['b01', 'a02', ''],
  );
  assert.strictEqual(live[COUNT].value, '2人');
  assert.strictEqual(live[S[0]].disabled, true);
  assert.deepStrictEqual(
    Array.from(live['手動會計承辦人'].value, (u) => u.code),
    ['a01'],
  );
  assert.strictEqual(live['手動會計承辦人'].disabled, true);
  const entry = t.env.spaces[t.C.SPACES.MANUAL_SIGNERS].children[0];
  assert.strictEqual(find(entry, 'pr-signer-entry__btn').textContent, '更改簽核人');
  assert.deepStrictEqual(routeOf(entry), ['申請人 申請人甲', '第 1 關 李美玲', '第 2 關 王大同', '會計 王小明']);
  assert.strictEqual(find(entry, 'pr-signer-entry__summary'), undefined);
  assert.strictEqual(findAll(entry, 'is-next').length, 0, '表單上的路線不閃呼吸燈、也不加「可不填」');
});

check('視窗開著時取消了手動 → 按完成也不寫回；視窗已開時再按按鈕不會開第二個', async () => {
  const t = setup();
  t.env.currentRecord = recordOf({ signers: [U('a01')] });
  const first = t.M.open();
  assert.strictEqual(await t.M.open(), null, '已開著就不再開');
  t.env.currentRecord['手動設定簽核流程'].value = [];
  await settle();
  await t.popups[0].confirm();
  assert.strictEqual(await first, null);
  assert.strictEqual(t.env.setCalls.length, 0);
  assert.strictEqual(t.popups.length, 1);
});

check('視窗按取消：一位簽核人都沒有 → 請簽核人員程式取消勾選（PR_MANUAL_MODE.exitManualMode）；原本就有人 → 維持手動', async () => {
  const t = setup();
  let exits = 0;
  t.env.window.PR_MANUAL_MODE = { exitManualMode: () => (exits += 1) };
  t.env.currentRecord = recordOf({ signers: [] });
  const empty = t.M.open();
  await settle();
  (await (async () => {
    const input = find(findAll(t.popups[0].opts.html, 'pr-signer__step')[0], 'pr-signer__input');
    input.value = '王小明';
    input.listeners.input();
    await settle();
    return findAll(t.popups[0].opts.html, 'pr-signer__result');
  })())[0].click(); // 視窗裡選了人但按取消，畫面上還是沒人
  t.popups[0].cancel();
  assert.strictEqual(await empty, null);
  assert.strictEqual(exits, 1);

  t.env.currentRecord = recordOf({ signers: [U('a01')] });
  const kept = t.M.open();
  await settle();
  t.popups[1].cancel();
  await kept;
  assert.strictEqual(exits, 1, '已經指定過簽核人，按取消只是不改');
});

check('enter(openNow)：進手動模式馬上開視窗；leave：清空三格與人數、收起按鈕', async () => {
  const t = setup();
  const r = recordOf({ signers: [] });
  t.env.currentRecord = r;
  t.M.enter(r, { openNow: true });
  await settle();
  assert.strictEqual(t.popups.length, 1);
  t.popups[0].cancel();

  const filled = recordOf({ manual: false, signers: [U('a01'), U('b01')] });
  filled[COUNT].value = '2人';
  t.M.leave(filled);
  S.forEach((f) => assert.strictEqual(filled[f].value.length, 0, f));
  assert.strictEqual(filled['手動會計承辦人'].value.length, 0, '手動會計承辦人也清掉');
  assert.strictEqual(filled[COUNT].value, '');
  assert.strictEqual(t.env.spaces[t.C.SPACES.MANUAL_SIGNERS].children.length, 0);
});

done();
