// 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
const KT = window.PR_KT;

const F = window.PR_CONFIG.FIELDS;
const EA = window.PR_CONFIG.REF_FIELDS.EMPLOYEE_ACCOUNT;
const BUTTON_ID = 'same-applicant-btn';
const PICK_BUTTON_ID = 'pick-employee-btn';

/** 提示視窗：全域 SweetAlert（寬度自動）；載不到 SweetAlert 才退回瀏覽器的 alert */
function notify(text, icon) {
  if (typeof Swal === 'undefined') {
    alert(text);
    return;
  }
  Swal.fire({ icon, text, width: 'auto', confirmButtonText: '好', customClass: { htmlContainer: 'pr-notice-text' } });
}

// 取得申請人資訊：fullName 為「員工代碼 中文姓名」（受款人＝申請人，723 是「員工姓名」欄位）
function getApplicantInfo(record) {
  const applicant = record[F.APPLICANT]?.value?.[0];

  if (!applicant) {
    return { error: '請先填寫申請人' };
  }

  const applicantCode = applicant.code || '';
  const applicantName = applicant.name || '';

  // 提取括號內的中文姓名
  const nameMatch = applicantName.match(/\((.+?)\)/);
  const chineseName = nameMatch ? nameMatch[1] : applicantName;

  return {
    code: applicantCode,
    name: chineseName,
    fullName: `${applicantCode} ${chineseName}`.trim(),
  };
}

// 建立按鈕元素
function createSameApplicantButton() {
  const button = document.createElement('button');
  button.id = BUTTON_ID;
  button.textContent = '同申請人';
  button.type = 'button';
  // 樣式（含滑鼠懸停效果）在 payment_request.css
  button.className = 'pr-same-applicant-btn';

  // 按鈕點擊事件
  button.addEventListener('click', function () {
    // 取得當前記錄
    const record = KT.record().get().record;
    const applicantInfo = getApplicantInfo(record);

    if (applicantInfo.error) {
      // 顯示錯誤訊息
      notify(applicantInfo.error, 'warning');
      return;
    }

    // 將 fullName 寫入受款人欄位
    record[F.PAYEE].value = applicantInfo.fullName;

    // 更新記錄
    KT.record().set({ record: record });

    showSuccess(button, '✓ 已複製');
  });

  return button;
}

// 目前顯示中的提示（兩顆按鈕共用一個位置，新的出現時舊的拿掉）
let currentMsg = null;

/**
 * 在整排按鈕最右邊（「選擇員工」右邊；沒有這顆就放在被按的按鈕右邊）顯示綠色小字
 * （例：✓ 已複製、✓ 已選擇），2 秒後移除（淡出動畫在 payment_request.css 的 .pr-copied-msg）。
 * 連按或兩顆輪流按都只留最新的一個。
 */
function showSuccess(clicked, msgText) {
  const anchor = document.getElementById(PICK_BUTTON_ID) || clicked;
  if (currentMsg) currentMsg.remove();
  const successMsg = document.createElement('span');
  successMsg.textContent = ` ${msgText}`;
  successMsg.className = 'pr-copied-msg';
  // 緊接在該按鈕右邊（沒有 after 就放到同一列最後）
  if (typeof anchor.after === 'function') anchor.after(successMsg);
  else if (anchor.parentNode) anchor.parentNode.appendChild(successMsg);
  currentMsg = successMsg;
  setTimeout(() => {
    successMsg.remove();
    if (currentMsg === successMsg) currentMsg = null;
  }, 2000);
}

// ── 選人視窗（「選擇員工」按鈕、受款人明細員工代墊列共用）──────────────────────
//   2026-11-23 起名單改讀員工匯款帳號主檔（APPS.EMPLOYEE_ACCOUNT），沒有 kintone 帳號的同仁也查得到。
//   查不到＝該同仁尚未建立匯款帳號：視窗內可直接新增一筆（員工編號＋中文姓名），新增後選它；
//   通知承辦人建立匯款資料靠該 App 的 kintone 記錄通知（新增記錄時通知），程式不另外發。
//   點一位就把「員工編號 中文姓名」寫進受款人；抓不到清單時提示改用手動輸入。樣式在 payment_request.css 的 .pr-emp-*。

const MAX_LIST = 50; // 視窗一次最多列幾位，再多請使用者多打幾個字
const ACCOUNT_PAGE = 500; // 主檔一次讀幾筆（REST 上限 500）

const text = (value) => String(value ?? '').trim();

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** 名稱取中文姓名：有括號（半形或全形）取括號內，否則整個名稱 */
const chineseNameOf = (name) => {
  const m = /\((.+?)\)/.exec(String(name ?? '')) || /（(.+?)）/.exec(String(name ?? ''));
  return text(m ? m[1] : name);
};

/** 受款人文字：「員工編號 中文姓名」 */
const toPayeeText = (user) => `${text(user?.code)} ${chineseNameOf(user?.name)}`.trim();

/** 主檔記錄 → { code, name, payee }：只留有員工編號的，依員工編號排序（同編號只留第一筆） */
const normalizeAccounts = (records) => {
  const seen = new Set();
  return (records || [])
    .map((r) => ({ code: text(r?.[EA.CODE]?.value), name: text(r?.[EA.NAME]?.value) }))
    .filter((u) => u.code !== '' && !seen.has(u.code) && seen.add(u.code))
    .map((u) => ({ ...u, payee: toPayeeText(u) }))
    .sort((a, b) => a.code.localeCompare(b.code));
};

/** 關鍵字搜尋：以空白分段，每段都要出現在「代碼 名稱」裡（不分大小寫）；空關鍵字回傳全部 */
const filterUsers = (users, keyword) => {
  const tokens = text(keyword).toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return users;
  return users.filter((u) => {
    const hay = `${u.code} ${u.name} ${u.payee}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
};

/** 清單 HTML（每位一顆按鈕，data-index 對應 list 的位置）；超過 MAX_LIST 只列前面，提示多打幾個字；查不到給「新增員工帳號」 */
const buildListHtml = (list) => {
  if (list.length === 0) {
    return (
      '<p class="pr-emp-empty">找不到符合的人員：該同仁可能尚未建立匯款帳號。</p>' +
      '<button type="button" class="pr-emp-create">＋ 新增員工帳號</button>'
    );
  }
  const items = list
    .slice(0, MAX_LIST)
    .map(
      (u, i) =>
        `<button type="button" class="pr-emp-item" data-index="${i}"><span class="pr-emp-code">${escapeHtml(u.code)}</span><span class="pr-emp-name">${escapeHtml(chineseNameOf(u.name))}</span></button>`,
    )
    .join('');
  const more = list.length > MAX_LIST ? `<p class="pr-emp-more">還有 ${list.length - MAX_LIST} 位沒有列出，請輸入更多關鍵字</p>` : '';
  return items + more;
};

/** 搜尋關鍵字拆成新增表單的預設值：第一組 5 碼數字當員工編號，其餘文字當姓名 */
const splitKeyword = (keyword) => {
  const s = text(keyword);
  const m = /\d{5}/.exec(s);
  return { code: m ? m[0] : '', name: text(s.replace(/\d+/g, ' ').replace(/\s+/g, ' ')) };
};

/** 新增帳號旁的說明（選人視窗、存檔時的確認視窗共用） */
const CREATE_NOTE = '新增匯款帳號，需要3個工作天（不含假日）';

/** 新增員工帳號表單 HTML */
const buildCreateFormHtml = ({ code, name }) =>
  '<div class="pr-emp-create-form">' +
  '<p class="pr-emp-msg">新增後會通知承辦人建立匯款帳號資料。</p>' +
  `<label class="pr-emp-field">員工編號（5 碼）<input type="text" class="pr-emp-new-code" inputmode="numeric" maxlength="5" value="${escapeHtml(code)}"></label>` +
  `<label class="pr-emp-field">中文姓名<input type="text" class="pr-emp-new-name" value="${escapeHtml(name)}"></label>` +
  '<p class="pr-emp-error pr-emp-create-error"></p>' +
  '<div class="pr-emp-create-actions">' +
  '<button type="button" class="pr-emp-create-submit">新增並選擇</button>' +
  `<span class="pr-emp-create-note">${CREATE_NOTE}</span>` +
  '</div>' +
  '</div>';

/** 新增前檢查：員工編號 5 碼數字、姓名必填、編號不能已存在；回傳錯誤訊息（沒問題回空字串） */
const validateNewAccount = ({ code, name }, accounts) => {
  if (!/^\d{5}$/.test(text(code))) return '員工編號請輸入 5 碼數字';
  if (text(name) === '') return '請輸入中文姓名';
  const dup = (accounts || []).find((u) => u.code === text(code));
  if (dup) return `員工編號 ${dup.code} 已存在（${dup.name}），請直接搜尋選擇`;
  return '';
};

/** REST 呼叫：測試時注入 api(path, method, params) */
const defaultApi = (path, method, params) => {
  // 主檔只有 Administrator 能新增、編輯、檢視：有裝發票登記 plug-in 並設定 Token 時走它的代理（2026-11-24），否則用登入者自己的權限
  const proxy = window.NX_EMPLOYEE_ACCOUNT_API;
  return typeof proxy === 'function' ? proxy(path, method, params) : kintone.api(kintone.api.url(path, true), method, params);
};

/** 讀主檔全部記錄（依 $id 遞增翻頁，每次 ACCOUNT_PAGE 筆），回傳 normalizeAccounts 的結果 */
const fetchAccounts = async (api = defaultApi) => {
  const all = [];
  let lastId = 0;
  for (;;) {
    const resp = await api('/k/v1/records', 'GET', {
      app: window.PR_CONFIG.APPS.EMPLOYEE_ACCOUNT,
      fields: ['$id', EA.CODE, EA.NAME],
      query: `$id > ${lastId} order by $id asc limit ${ACCOUNT_PAGE}`,
    });
    const records = resp?.records || [];
    all.push(...records);
    if (records.length < ACCOUNT_PAGE) break;
    lastId = Number(records[records.length - 1].$id.value);
  }
  return normalizeAccounts(all);
};

/** 在主檔新增一筆（員工編號＋中文姓名），回傳 { code, name, payee }；已讀過名單就併進去（選人視窗馬上查得到） */
const createAccount = async ({ code, name }, api = defaultApi) => {
  const account = { code: text(code), name: text(name) };
  await api('/k/v1/record', 'POST', {
    app: window.PR_CONFIG.APPS.EMPLOYEE_ACCOUNT,
    record: { [EA.CODE]: { value: account.code }, [EA.NAME]: { value: account.name } },
  });
  const created = { ...account, payee: toPayeeText(account) };
  if (accountsPromise) {
    await accountsPromise
      .then((list) => {
        if (list.some((u) => u.code === created.code)) return;
        list.push(created);
        list.sort((a, b) => a.code.localeCompare(b.code));
      })
      .catch(() => {});
  }
  return created;
};

/**
 * 存檔檢查用：這些員工編號哪些在主檔查不到（尚未建立匯款帳號）。只查這幾個編號，不讀整份名單。
 * @param {string[]} codes 5 碼員工編號（重複、空白自動略過）
 * @returns {Promise<string[]>} 查不到的編號（依傳入順序）
 */
const findMissingAccounts = async (codes, api = defaultApi) => {
  const unique = [...new Set((codes || []).map(text).filter((c) => /^\d{5}$/.test(c)))];
  if (unique.length === 0) return [];
  const resp = await api('/k/v1/records', 'GET', {
    app: window.PR_CONFIG.APPS.EMPLOYEE_ACCOUNT,
    fields: [EA.CODE],
    query: `${EA.CODE} in (${unique.map((c) => `"${c}"`).join(', ')}) limit 500`,
  });
  const found = new Set((resp?.records || []).map((r) => text(r?.[EA.CODE]?.value)));
  return unique.filter((c) => !found.has(c));
};

/** 新增失敗的訊息：沒權限另外說明 */
const createErrorText = (err) => {
  const code = err?.code || '';
  if (/^(CB_NO|GAIA_NO)/.test(code)) return '新增失敗：沒有新增員工帳號的權限，請洽管理員。';
  const detail = err?.message || '';
  return `新增失敗${detail ? `：${detail}` : '，請稍後再試。'}`;
};

// 名單同一頁面只抓一次；失敗就清掉，下次開視窗再試；新增成功會併進同一份名單
let accountsPromise = null;
const loadUsers = () => {
  if (!accountsPromise) {
    accountsPromise = fetchAccounts().catch((err) => {
      accountsPromise = null;
      throw err;
    });
  }
  return accountsPromise;
};

/**
 * 選人視窗。
 * @param {{ title: string, keyword?: string, onPick: (payee: string) => void }} options
 * @returns {boolean} 有沒有開出視窗（沒有 SweetAlert 回 false，維持手動輸入）
 */
const openUserPicker = ({ title, keyword = '', onPick }) => {
  if (typeof Swal === 'undefined' || typeof Swal.fire !== 'function') return false;
  let shownList = [];
  const pick = (user) => {
    onPick(user.payee);
    Swal.close();
  };
  Swal.fire({
    title,
    html:
      `<input type="text" class="pr-emp-search" placeholder="輸入員工編號或姓名搜尋" value="${escapeHtml(keyword)}">` +
      '<div class="pr-emp-list"><p class="pr-emp-msg">讀取人員清單中…</p></div>',
    showConfirmButton: false,
    showCancelButton: true,
    cancelButtonText: '取消',
    customClass: { popup: 'pr-emp-picker' },
    didOpen: (popup) => {
      const input = popup.querySelector('.pr-emp-search');
      const listEl = popup.querySelector('.pr-emp-list');
      let users = null;
      let creating = false;
      const render = () => {
        if (!users) return;
        shownList = filterUsers(users, input.value);
        listEl.innerHTML = buildListHtml(shownList);
      };
      const submitCreate = () => {
        if (creating) return;
        const form = { code: text(listEl.querySelector('.pr-emp-new-code')?.value), name: text(listEl.querySelector('.pr-emp-new-name')?.value) };
        const errorEl = listEl.querySelector('.pr-emp-create-error');
        const error = validateNewAccount(form, users);
        if (error) {
          if (errorEl) errorEl.textContent = error;
          return;
        }
        creating = true;
        if (errorEl) errorEl.textContent = '新增中…';
        createAccount(form)
          .then((account) => {
            // createAccount 已併進名單（users 就是同一份）
            pick(account);
            notify(`已新增員工帳號：${account.payee}\n系統會通知承辦人建立匯款帳號資料。`, 'success');
          })
          .catch((err) => {
            console.error('[受款人填寫設定] 新增員工帳號失敗:', err);
            if (errorEl) errorEl.textContent = createErrorText(err);
          })
          .finally(() => {
            creating = false;
          });
      };
      input.addEventListener('input', render);
      input.addEventListener('keydown', (e) => {
        // Enter：剛好只剩一位就直接選
        if (e.key === 'Enter' && shownList.length === 1) pick(shownList[0]);
      });
      listEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.pr-emp-item');
        if (btn) {
          const user = shownList[Number(btn.dataset.index)];
          if (user) pick(user);
        } else if (e.target.closest('.pr-emp-create')) {
          listEl.innerHTML = buildCreateFormHtml(splitKeyword(input.value));
        } else if (e.target.closest('.pr-emp-create-submit')) {
          submitCreate();
        }
      });
      input.focus();
      loadUsers()
        .then((list) => {
          users = list;
          render();
        })
        .catch((err) => {
          console.error('[受款人填寫設定] 讀取人員清單失敗:', err);
          listEl.innerHTML = '<p class="pr-emp-error">無法讀取人員清單，請稍後再試或聯絡系統管理員</p>';
        });
    },
  });
  return true;
};

/**
 * 「選擇員工」按鈕（2026-11-12）：跳出人員清單，點一位就把「員工編號 中文姓名」寫進受款人。
 * 受款人已經是「5 碼員工編號＋姓名」就用員工編號當搜尋關鍵字，否則用目前的文字。
 */
function createPickEmployeeButton() {
  const button = document.createElement('button');
  button.id = PICK_BUTTON_ID;
  button.textContent = '選擇員工';
  button.type = 'button';
  // 樣式在 payment_request.css
  button.className = 'pr-pick-employee-btn';
  button.addEventListener('click', function () {
    const current = text(KT.record().get().record[F.PAYEE]?.value);
    const keyword = /^\d{5}/.test(current) ? current.slice(0, 5) : current;
    const opened = openUserPicker({
      title: '選擇受款人（員工）',
      keyword,
      onPick: (payee) => {
        const record = KT.record().get().record;
        if (!record[F.PAYEE]) return;
        record[F.PAYEE].value = payee;
        KT.record().set({ record: record });
        showSuccess(button, '✓ 已選擇');
      },
    });
    if (!opened) notify('無法開啟人員清單，請重新整理頁面後再試', 'warning');
  });
  return button;
}

// 在編輯和新增頁面顯示「同申請人」「選擇員工」兩顆按鈕（已掛過就不重複掛）
function handleShow(event) {
  const spaceElement = KT.record().getSpaceElement(window.PR_CONFIG.SPACES.APPLY_BUTTON);
  if (spaceElement && !document.getElementById(BUTTON_ID)) {
    spaceElement.appendChild(createSameApplicantButton());
    spaceElement.appendChild(createPickEmployeeButton());
  }
  return event;
}

export {
  getApplicantInfo,
  handleShow,
  findMissingAccounts,
  chineseNameOf,
  toPayeeText,
  normalizeAccounts,
  filterUsers,
  buildListHtml,
  buildCreateFormHtml,
  splitKeyword,
  validateNewAccount,
  fetchAccounts,
  createAccount,
  createErrorText,
  openUserPicker,
  escapeHtml,
  CREATE_NOTE,
  MAX_LIST,
};

/** 入口檔 import '…?install' 時呼叫：註冊事件（載入時只定義函式） */
// 受款人欄位已在表單鎖住、只能用按鈕填；2026-11-23 起新增時不再自動帶申請人
export const install = () => {
  KT.on(['app.record.create.show', 'app.record.edit.show'], handleShow);
};
