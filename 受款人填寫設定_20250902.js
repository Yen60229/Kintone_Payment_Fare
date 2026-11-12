(() => {
  'use strict';

  // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
  const KT = window.PR_KT;

  const F = window.PR_CONFIG.FIELDS;
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

  // ── 選人視窗（「選擇員工」按鈕用；2026-11-12，和 723 交際費受款人明細員工代墊同一種）──────
  //   kintone 使用者清單：cybozu.com 共通 API /v1/users.json（每次 100 筆分頁，同一頁面只抓一次），停用的帳號不列。
  //   點一位就把「員工編號 中文姓名」寫進受款人；抓不到清單時提示改用手動輸入。樣式在 payment_request.css 的 .pr-emp-*。

  const USERS_API = '/v1/users.json';
  const PAGE_SIZE = 100; // /v1/users.json 一次最多 100 筆
  const MAX_LIST = 50; // 視窗一次最多列幾位，再多請使用者多打幾個字

  const text = (value) => String(value ?? '').trim();

  const escapeHtml = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  /** 使用者名稱取中文姓名：有括號（半形或全形）取括號內，否則整個名稱 */
  const chineseNameOf = (name) => {
    const m = /\((.+?)\)/.exec(String(name ?? '')) || /（(.+?)）/.exec(String(name ?? ''));
    return text(m ? m[1] : name);
  };

  /** 受款人文字：「員工編號 中文姓名」 */
  const toPayeeText = (user) => `${text(user?.code)} ${chineseNameOf(user?.name)}`.trim();

  /** 只留啟用中、有代碼的帳號，依員工編號排序 */
  const normalizeUsers = (users) =>
    (users || [])
      .filter((u) => u && u.valid !== false && text(u.code) !== '')
      .map((u) => ({ code: text(u.code), name: String(u.name ?? ''), payee: toPayeeText(u) }))
      .sort((a, b) => a.code.localeCompare(b.code));

  /** 關鍵字搜尋：以空白分段，每段都要出現在「代碼 名稱」裡（不分大小寫）；空關鍵字回傳全部 */
  const filterUsers = (users, keyword) => {
    const tokens = text(keyword).toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return users;
    return users.filter((u) => {
      const hay = `${u.code} ${u.name} ${u.payee}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  };

  /** 清單 HTML（每位一顆按鈕，data-index 對應 list 的位置）；超過 MAX_LIST 只列前面，提示多打幾個字 */
  const buildListHtml = (list) => {
    if (list.length === 0) return '<p class="pr-emp-empty">找不到符合的人員，請換個關鍵字</p>';
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

  /**
   * 抓全部使用者（分頁到不足一頁為止）。
   * @param {Function} [api] 預設 kintone.api，測試時注入
   */
  const fetchAllUsers = async (api = kintone.api) => {
    const all = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      // eslint-disable-next-line no-await-in-loop
      const resp = await api(kintone.api.url(USERS_API, true), 'GET', { offset, size: PAGE_SIZE });
      const users = resp?.users || [];
      all.push(...users);
      if (users.length < PAGE_SIZE) break;
    }
    return normalizeUsers(all);
  };

  // 同一頁面只抓一次；失敗就清掉，下次開視窗再試
  let usersPromise = null;
  const loadUsers = () => {
    if (!usersPromise) {
      usersPromise = fetchAllUsers().catch((err) => {
        usersPromise = null;
        throw err;
      });
    }
    return usersPromise;
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
      cancelButtonText: '取消（自己輸入）',
      customClass: { popup: 'pr-emp-picker' },
      didOpen: (popup) => {
        const input = popup.querySelector('.pr-emp-search');
        const listEl = popup.querySelector('.pr-emp-list');
        let users = null;
        const render = () => {
          if (!users) return;
          shownList = filterUsers(users, input.value);
          listEl.innerHTML = buildListHtml(shownList);
        };
        input.addEventListener('input', render);
        input.addEventListener('keydown', (e) => {
          // Enter：剛好只剩一位就直接選
          if (e.key === 'Enter' && shownList.length === 1) pick(shownList[0]);
        });
        listEl.addEventListener('click', (e) => {
          const btn = e.target.closest('.pr-emp-item');
          if (!btn) return;
          const user = shownList[Number(btn.dataset.index)];
          if (user) pick(user);
        });
        input.focus();
        loadUsers()
          .then((list) => {
            users = list;
            render();
          })
          .catch((err) => {
            console.error('[受款人填寫設定] 讀取人員清單失敗:', err);
            listEl.innerHTML =
              '<p class="pr-emp-error">無法讀取人員清單，請按「取消」後直接在受款人欄輸入「5 碼員工編號＋中文姓名」，例：00546 王小明</p>';
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
      if (!opened) notify('無法開啟人員清單，請直接在受款人欄輸入「5 碼員工編號＋中文姓名」', 'warning');
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

  // 新增時受款人空白且申請人有值 → 自動帶入（沒填申請人就不動、不跳 alert；已有值不覆蓋）
  function autoFillPayee(event) {
    const record = event.record;
    if (!record[F.PAYEE] || String(record[F.PAYEE].value || '').trim()) return event;
    const info = getApplicantInfo(record);
    if (!info.error) record[F.PAYEE].value = info.fullName;
    return event;
  }

  KT.on('app.record.create.show', (event) => handleShow(autoFillPayee(event)));
  KT.on('app.record.edit.show', handleShow);

  window.PR_PAYEE = Object.freeze({
    getApplicantInfo,
    handleShow,
    autoFillPayee,
    chineseNameOf,
    toPayeeText,
    normalizeUsers,
    filterUsers,
    buildListHtml,
    fetchAllUsers,
    openUserPicker,
    MAX_LIST,
  });
})();
