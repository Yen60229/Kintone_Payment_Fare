(function () {
  'use strict';

  // =============================================================================
  // 手動簽核人設定
  //
  //   勾「手動設定簽核流程」後由申請人自己指定 1～3 位簽核人（MANUAL_SIGNERS.FIELDS），
  //   照順序簽，簽完送「單位會計處理中」給手動會計承辦人（MANUAL_SIGNERS.ACCOUNTING_FIELD；原本的會計單位承辦人照舊自動帶入、不動）。只限「費用歸屬不限部門」群組（COST_SCOPE.EXEMPT_GROUP）的申請人。
  //
  //   - 「簽核流程」群組裡的空白欄位（SPACES.MANUAL_SIGNERS）放「設定簽核人」按鈕，點了開視窗（SweetAlert）選人；
  //     三個簽核人與手動會計承辦人鎖住，只能從視窗改，排法規則才不會被繞過。
  //   - 視窗：簽核人每一位一格，第 4 格是會計承辦人（預設帶會計對應主檔的人，可換）；打姓名或帳號就列出符合的人；
  //     第 1 位必填，前一位沒填下一格不能填，同一個人不能排兩次、申請人不能簽自己的單。
  //     人員名單第一次開視窗時才抓（/v1/users.json）。
  //   - 存檔（payment_request_submit 呼叫 validate）：同上規則再檢查一次，並把實際人數寫進 COUNT_FIELD，
  //     流程管理靠它決定第 1 關之後送到哪。
  //   勾選／取消勾選的處理在 signing_personnel_manager（它決定進不進手動模式），這裡只管人員與視窗。
  //   視窗按取消、而且一位簽核人都沒指定 → 請 signing_personnel_manager（PR_MANUAL_MODE.exitManualMode）取消勾選、改回自動排人。
  // =============================================================================

  const KT = window.PR_KT;
  const C = window.PR_CONFIG;
  const F = C.FIELDS;
  const CFG = C.MANUAL_SIGNERS;
  const SPACE_ID = C.SPACES.MANUAL_SIGNERS;
  const ORDINALS = ['第 1 位', '第 2 位', '第 3 位'];
  const ACCOUNTING_SLOT = 3; // 視窗第 4 格：手動會計承辦人（MANUAL_SIGNERS.ACCOUNTING_FIELD）

  // ── 純函式 ──────────────────────────────────────────────────────────────

  const isManual = (record) => record?.[F.MANUAL_FLOW]?.value?.length > 0;
  const isVoid = (record) => record?.[C.VOID_FIELD]?.value?.length > 0;
  const isEditableStatus = (status) => !status || CFG.EDITABLE_STATUSES.includes(status) || String(status).endsWith(CFG.REJECT_SUFFIX);
  const toUser = (u) => (u ? { code: u.code, name: u.name || u.code } : null);

  /** 三格目前的人（每格取第一個，沒填是 null） */
  const signersOf = (record) => CFG.FIELDS.map((field) => toUser(record?.[field]?.value?.[0]));

  /** 依實際填的人數寫 COUNT_FIELD 的值：'1人'～'3人'，沒填是空白 */
  const countValueOf = (signers) => {
    const n = signers.filter(Boolean).length;
    return n > 0 ? `${n}${CFG.COUNT_UNIT}` : '';
  };

  /**
   * 排法規則（視窗與存檔共用）。訊息格式同 payment_request_submit：▸ 開頭＝項目、※ 開頭＝提示。
   * @param {Array<Array<{code,name}>>} slots 三格各自的人（USER_SELECT 可以選多人，所以每格是陣列）
   * @param {string} applicantCode
   * @returns {string[]}
   */
  const checkSigners = (slots, applicantCode) => {
    const errors = [];
    const firsts = slots.map((list) => (list && list.length > 0 ? list[0] : null));

    slots.forEach((list, i) => {
      if (list && list.length > 1) errors.push(`${ORDINALS[i]}簽核人只能選 1 個人（現在有 ${list.length} 位）`);
    });

    if (!firsts[0]) errors.push('還沒指定簽核人\n※ 至少要有第 1 位，請按「簽核流程」裡的「設定簽核人」');

    const lastFilled = firsts.reduce((last, u, i) => (u ? i : last), -1);
    const gaps = firsts.map((u, i) => (!u && i < lastFilled ? i : -1)).filter((i) => i > 0);
    if (gaps.length > 0) {
      errors.push(`${gaps.map((i) => ORDINALS[i]).join('、')}空著，後面卻有人\n※ 簽核會照順序走，請把後面的人往前補`);
    }

    const seen = new Map();
    firsts.forEach((u, i) => {
      if (!u) return;
      if (!seen.has(u.code)) seen.set(u.code, { user: u, at: [] });
      seen.get(u.code).at.push(i);
    });
    seen.forEach(({ user, at }) => {
      if (at.length > 1) errors.push(`${user.name} 排了 ${at.length} 次（${at.map((i) => ORDINALS[i]).join('、')}）\n※ 同一個人簽一次就好`);
    });

    firsts.forEach((u, i) => {
      if (u && applicantCode && u.code === applicantCode) errors.push(`申請人不能簽自己的單\n▸${ORDINALS[i]}：${u.name}\n※ 請換成其他人`);
    });
    return errors;
  };

  /**
   * 把選好的人寫進 record（三格＋人數）。
   * @param {Object} record
   * @param {Array<{code,name}|null>} picked
   */
  const writeSigners = (record, picked) => {
    CFG.FIELDS.forEach((field, i) => {
      if (record[field]) record[field].value = picked[i] ? [toUser(picked[i])] : [];
    });
    if (record[CFG.COUNT_FIELD]) record[CFG.COUNT_FIELD].value = countValueOf(picked);
  };

  /**
   * 存檔檢查：手動模式才檢查；作廢單不檢查。人數欄位在可編輯的狀態依實際人數重寫（值沒變不寫）。
   * @param {Object} record
   * @returns {Promise<string[]>}
   */
  const validate = async (record) => {
    if (!isManual(record) || isVoid(record)) return [];
    const scope = window.PR_COST_SCOPE;
    const applicantCode = scope ? scope.applicantCodeOf(record) : record[F.APPLICANT]?.value?.[0]?.code;

    if (scope && !(await scope.ensureExempt(applicantCode))) {
      return [`只有「${C.COST_SCOPE.EXEMPT_GROUP}」的同仁可以手動設定簽核流程\n※ 請取消勾選「手動設定簽核流程」，改由系統自動排簽核人員`];
    }

    const errors = checkSigners(
      CFG.FIELDS.map((field) => record[field]?.value || []),
      applicantCode,
    );
    if (!C.isAdmin() && !(record[CFG.ACCOUNTING_FIELD]?.value?.length > 0)) {
      errors.push('還沒指定會計承辦人\n※ 請按「設定簽核人」，在最後一格「會計承辦人」選人');
    }

    const countField = record[CFG.COUNT_FIELD];
    const count = countValueOf(signersOf(record));
    if (countField && countField.value !== count && isEditableStatus(record[F.STATUS_FIELD]?.value)) countField.value = count;
    return errors;
  };

  // ── 人員名單（/v1/users.json，第一次開視窗才抓，抓過就留著）────────────────

  let usersPromise = null;

  const fetchAllUsers = async () => {
    const all = [];
    for (let offset = 0; ; offset += CFG.USER_PAGE_SIZE) {
      const resp = await kintone.api(kintone.api.url('/v1/users.json', true), 'GET', { offset, size: CFG.USER_PAGE_SIZE });
      const page = resp.users || [];
      all.push(...page.filter((u) => u.valid !== false).map((u) => ({ code: u.code, name: u.name || u.code })));
      if (page.length < CFG.USER_PAGE_SIZE) return all;
    }
  };

  const loadUsers = () => {
    if (!usersPromise) {
      usersPromise = fetchAllUsers().catch((err) => {
        usersPromise = null; // 下次開視窗再試
        throw err;
      });
    }
    return usersPromise;
  };

  /** 依關鍵字找人：姓名或帳號包含就算，姓名開頭符合的排前面 */
  const searchUsers = (users, keyword, limit = 8) => {
    const q = String(keyword || '').trim().toLowerCase();
    if (!q) return [];
    const hits = users.filter((u) => u.name.toLowerCase().includes(q) || u.code.toLowerCase().includes(q));
    const rank = (u) => (u.name.toLowerCase().startsWith(q) || u.code.toLowerCase().startsWith(q) ? 0 : 1);
    return hits.sort((a, b) => rank(a) - rank(b)).slice(0, limit);
  };

  // ── 最近選過的人（這台電腦的 localStorage；讀寫失敗就當沒有）──────────────────

  const readRecent = () => {
    try {
      const list = JSON.parse(window.localStorage.getItem(CFG.RECENT_KEY) || '[]');
      return Array.isArray(list) ? list.filter((u) => u && u.code).slice(0, CFG.RECENT_MAX) : [];
    } catch (e) {
      return [];
    }
  };

  const rememberRecent = (picked) => {
    try {
      const merged = [...picked.filter(Boolean), ...readRecent()];
      const unique = merged.filter((u, i) => merged.findIndex((x) => x.code === u.code) === i).slice(0, CFG.RECENT_MAX);
      window.localStorage.setItem(CFG.RECENT_KEY, JSON.stringify(unique.map(toUser)));
    } catch (e) {
      // 私密視窗或封鎖網站資料時寫不進去，不影響選人
    }
  };

  // ── 視窗（SweetAlert）──────────────────────────────────────────────────────

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const button = (className, text, onClick) => {
    const node = el('button', className, text);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  };

  const namesOf = (list) => list.map((u) => u.name).join('、');

  /**
   * 簽核路線：申請人 → 第 1～3 關 → 會計入帳。視窗上方的預覽與表單上按鈕旁的路線共用。
   * 最多 5 站（申請人＋3 位簽核人＋會計），每站一顆圓燈、名字寫在燈旁邊且完整顯示（名字再長也不截斷）；
   * 必填卻沒指定的站寫「尚未指定」。
   * live（視窗用）：直向排列，下一個要填的那一站的燈亮呼吸燈（is-next）；簽核人不到 3 位時多一站「可不填」提醒還能加。
   * @param {{ applicant: {code,name}|null, signers: Array<{code,name}|null>, staff: Array<{code,name}>, live?: boolean }} p
   */
  const routeList = ({ applicant, signers, staff, live = false }) => {
    const list = el('ol', `pr-route${live ? ' pr-route--column' : ''}`);
    list.setAttribute('aria-label', '簽核路線');
    const filled = signers.filter(Boolean);
    const stop = (kind, label, name, { optional = false, next = false } = {}) => {
      const empty = !name && !optional;
      const cls = ['pr-route__stop', `pr-route__stop--${kind}`, empty ? 'is-empty' : '', optional ? 'is-optional' : '', next ? 'is-next' : ''];
      const item = el('li', cls.filter(Boolean).join(' '));
      const shown = name || (optional ? '可不填' : '尚未指定');
      item.appendChild(el('span', 'pr-route__dot'));
      const text = el('span', 'pr-route__text');
      text.appendChild(el('span', 'pr-route__label', label));
      text.appendChild(el('span', 'pr-route__name', shown));
      item.appendChild(text);
      list.appendChild(item);
    };
    if (applicant) stop('start', '申請人', applicant.name);
    filled.forEach((u, i) => stop('signer', `第 ${i + 1} 關`, u.name));
    if (filled.length === 0) stop('signer', '第 1 關', '', { next: live });
    else if (live && filled.length < 3) stop('signer', `第 ${filled.length + 1} 關`, '', { optional: true, next: true });
    stop('end', '會計', staff.length > 0 ? namesOf(staff) : '', { next: live && filled.length === 3 && staff.length === 0 });
    return list;
  };

  let dialogOpen = false;
  let activeDialog = null; // 開著的視窗；會計承辦人比視窗晚帶入時，用它補進第 4 格

  /**
   * 開「指定簽核人」視窗（SweetAlert，內容與按鈕樣式在 payment_request.css 的 .pr-signer*）。
   * 前三格是簽核人（依序簽），第 4 格（ACCOUNTING_SLOT）是手動會計承辦人（簽完送「單位會計處理中」由他入帳）。
   * @param {{ initial: Array<{code,name}|null>, applicant: {code,name}|null, accounting: Array<{code,name}>, accountingRequired?: boolean }} p
   * @returns {Promise<{ signers: Array<{code,name}|null>, accounting: Array<{code,name}> }|null>} 按確定回傳選好的人；取消／Esc 回傳 null
   */
  const openDialog = ({ initial, applicant, accounting, accountingRequired = true }) => {
    const swal = window.Swal;
    if (!swal?.fire) {
      console.error('[手動簽核人] 找不到 SweetAlert，無法開指定簽核人視窗');
      return Promise.resolve(null);
    }
    dialogOpen = true;
    const picked = [0, 1, 2].map((i) => toUser(initial?.[i]));
    let staff = (accounting || []).map(toUser).filter(Boolean);
    // 舊資料可能有空格：先往前補齊，畫面才不會出現「第 2 位空著、第 3 位有人」
    const compact = () => {
      const list = picked.filter(Boolean);
      picked.splice(0, 3, ...[0, 1, 2].map((i) => list[i] || null));
    };
    compact();

    const root = el('div', 'pr-signer');
    root.appendChild(el('p', 'pr-signer__lead', '送出後依序給下面的人簽核，最後交給會計承辦人入帳。'));
    const preview = el('div', 'pr-signer__route');
    root.appendChild(preview);
    const steps = el('ol', 'pr-signer__steps');
    root.appendChild(steps);

    const isEmpty = (slot) => (slot === ACCOUNTING_SLOT ? staff.length === 0 : !picked[slot]);
    const isLocked = (slot) => slot > 0 && slot < ACCOUNTING_SLOT && !picked[slot - 1];
    /** 下一個要填的格子（沒有就 -1） */
    const nextEmpty = () => [0, 1, 2, ACCOUNTING_SLOT].find((slot) => isEmpty(slot) && !isLocked(slot)) ?? -1;

    /** 這個人為什麼不能當簽核人（申請人本人、已經排在別格）；可以選回傳空字串。會計承辦人不限。 */
    const blockedReason = (user, slot) => {
      if (slot === ACCOUNTING_SLOT) return '';
      if (applicant && user.code === applicant.code) return '申請人本人';
      const at = picked.findIndex((u, i) => i !== slot && u && u.code === user.code);
      return at >= 0 ? `已排在${ORDINALS[at]}` : '';
    };

    const clearMessage = () => swal.resetValidationMessage?.();

    const choose = (slot, user) => {
      if (slot === ACCOUNTING_SLOT) staff = [toUser(user)];
      else picked[slot] = toUser(user);
      clearMessage();
      render(nextEmpty());
    };

    const remove = (slot) => {
      if (slot === ACCOUNTING_SLOT) staff = [];
      else {
        picked[slot] = null;
        compact();
      }
      clearMessage();
      render(slot === ACCOUNTING_SLOT ? slot : picked.findIndex((u) => !u));
    };

    /** 搜尋框底下的清單：有關鍵字列符合的人，沒關鍵字列最近選過的人 */
    const fillResults = (list, slot, keyword, state) => {
      const rows = [];
      const addHeading = (text) => rows.push(el('li', 'pr-signer__results-note', text));
      state.options = [];

      if (state.loading) addHeading('正在讀取人員名單…');
      else if (state.failed) addHeading('讀不到人員名單，請關掉視窗再開一次');
      else {
        const users = keyword ? searchUsers(state.users, keyword) : readRecent();
        if (!keyword && users.length > 0) addHeading('最近選過');
        if (keyword && users.length === 0) addHeading(`找不到「${keyword}」，換個關鍵字試試`);
        users.forEach((user) => {
          const reason = blockedReason(user, slot);
          const row = el('li', reason ? 'pr-signer__result is-blocked' : 'pr-signer__result');
          row.appendChild(el('span', 'pr-signer__result-name', user.name));
          row.appendChild(el('span', 'pr-signer__result-code', reason || user.code));
          if (!reason) {
            row.addEventListener('mousedown', (e) => e.preventDefault()); // 點選時搜尋框不要先失焦
            row.addEventListener('click', () => choose(slot, user));
            state.options.push({ row, user });
          }
          rows.push(row);
        });
      }
      list.replaceChildren(...rows);
      state.active = -1;
    };

    const highlight = (state, index) => {
      state.options.forEach((o, i) => {
        o.row.className = i === index ? 'pr-signer__result is-active' : 'pr-signer__result';
      });
      state.active = index;
    };

    const searchBox = (slot, label) => {
      const wrap = el('div', 'pr-signer__search');
      const input = el('input', 'pr-signer__input');
      input.type = 'text';
      input.value = '';
      input.placeholder = '輸入姓名或帳號搜尋';
      input.setAttribute('aria-label', label);
      const list = el('ul', 'pr-signer__results');
      const state = { users: [], loading: true, failed: false, options: [], active: -1 };
      const refresh = () => fillResults(list, slot, input.value.trim(), state);

      loadUsers().then(
        (users) => {
          state.users = users;
          state.loading = false;
          refresh();
        },
        (err) => {
          console.error('[手動簽核人] 讀取人員名單失敗:', err);
          state.loading = false;
          state.failed = true;
          refresh();
        },
      );

      input.addEventListener('input', refresh);
      input.addEventListener('focus', refresh);
      input.addEventListener('keydown', (e) => {
        const n = state.options.length;
        switch (e.key) {
          case 'ArrowDown':
            if (n === 0) break;
            e.preventDefault();
            highlight(state, (state.active + 1) % n);
            break;
          case 'ArrowUp':
            if (n === 0) break;
            e.preventDefault();
            highlight(state, (state.active - 1 + n) % n);
            break;
          case 'Enter': {
            e.preventDefault();
            const option = state.options[state.active >= 0 ? state.active : 0];
            if (option && input.value.trim()) choose(slot, option.user);
            break;
          }
        }
      });
      wrap.appendChild(input);
      wrap.appendChild(list);
      return { wrap, input };
    };

    /** 一格：序號＋標題＋（選好的人｜搜尋框｜鎖住的提示） */
    const step = ({ slot, no, title, tag, hint, users, locked, lockedText, extraClass, focusSlot, onFocus }) => {
      const filled = users.length > 0;
      const item = el('li', `pr-signer__step${extraClass ? ` ${extraClass}` : ''}${filled ? ' is-filled' : ''}${locked ? ' is-locked' : ''}`);
      item.appendChild(el('span', 'pr-signer__no', no));
      const body = el('div', 'pr-signer__body');
      const label = el('div', 'pr-signer__label', title);
      label.appendChild(el('span', `pr-signer__tag${tag === '必填' ? ' is-required' : ''}`, tag));
      body.appendChild(label);
      if (hint) body.appendChild(el('p', 'pr-signer__hint', hint));

      if (filled) {
        const chosen = el('div', 'pr-signer__chosen');
        chosen.appendChild(el('span', 'pr-signer__name', namesOf(users)));
        chosen.appendChild(el('span', 'pr-signer__code', users.map((u) => u.code).join('、')));
        chosen.appendChild(button('pr-signer__change', '換人', () => remove(slot)));
        body.appendChild(chosen);
      } else if (locked) {
        body.appendChild(el('p', 'pr-signer__locked', lockedText));
      } else {
        const { wrap, input } = searchBox(slot, title);
        body.appendChild(wrap);
        if (slot === focusSlot) onFocus(input);
      }
      item.appendChild(body);
      return item;
    };

    /** 重畫四格；focusSlot 那格如果是搜尋框就把游標放進去 */
    const render = (focusSlot) => {
      let focusTarget = null;
      const onFocus = (input) => {
        focusTarget = input;
      };
      const items = picked.map((user, slot) =>
        step({
          slot,
          no: String(slot + 1),
          title: `${ORDINALS[slot]}簽核人`,
          tag: slot === 0 ? '必填' : '可不填',
          users: user ? [user] : [],
          locked: isLocked(slot),
          lockedText: `先選好${ORDINALS[slot - 1]}，才能排這一位`,
          focusSlot,
          onFocus,
        }),
      );
      items.push(
        step({
          slot: ACCOUNTING_SLOT,
          no: '會計',
          title: '會計承辦人',
          tag: accountingRequired ? '必填' : '可不填',
          hint: '簽核人都簽完後，送到「單位會計處理中」由他入帳',
          users: staff,
          extraClass: 'pr-signer__step--accounting',
          focusSlot,
          onFocus,
        }),
      );
      steps.replaceChildren(...items);
      const heading = el('div', 'pr-signer__route-title', '簽核會經過');
      preview.replaceChildren(heading, routeList({ applicant, signers: picked, staff, live: true }));
      if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
    };

    const preConfirm = () => {
      const errors = checkSigners(
        picked.map((u) => (u ? [u] : [])),
        applicant?.code,
      );
      if (accountingRequired && staff.length === 0) errors.push('請指定會計承辦人');
      if (errors.length > 0) {
        swal.showValidationMessage(errors[0].split('\n')[0]);
        return false;
      }
      rememberRecent([...picked, ...staff]);
      return { signers: picked.slice(), accounting: staff.slice() };
    };

    activeDialog = {
      /** 會計承辦人晚到（自動帶入）：第 4 格還空著才補上 */
      offerAccounting: (list) => {
        const users = (list || []).map(toUser).filter(Boolean);
        if (staff.length > 0 || users.length === 0) return;
        staff = users;
        render(-1);
      },
    };
    render(-1);

    const finish = () => {
      dialogOpen = false;
      activeDialog = null;
    };
    return swal
      .fire({
        title: '指定簽核人',
        html: root,
        showCancelButton: true,
        confirmButtonText: '完成',
        cancelButtonText: '取消',
        reverseButtons: true,
        focusConfirm: false,
        allowOutsideClick: false,
        buttonsStyling: false,
        customClass: {
          popup: 'pr-signer-popup',
          title: 'pr-signer-popup__title',
          htmlContainer: 'pr-signer-popup__body',
          actions: 'pr-signer-popup__actions',
          confirmButton: 'pr-signer-btn pr-signer-btn--primary',
          cancelButton: 'pr-signer-btn pr-signer-btn--ghost',
          validationMessage: 'pr-signer-popup__message',
        },
        didOpen: () => render(nextEmpty()),
        preConfirm,
      })
      .then(
        (result) => {
          finish();
          return result?.isConfirmed ? result.value : null;
        },
        (err) => {
          finish();
          throw err;
        },
      );
  };

  // ── 畫面 ────────────────────────────────────────────────────────────────

  /** 三格、手動會計承辦人與人數欄位的顯示：手動模式顯示（鎖住，只能從視窗改）；人數欄位一律不顯示 */
  const applyDisplay = (record, { detail = false } = {}) => {
    const manual = isManual(record);
    [...CFG.FIELDS, CFG.ACCOUNTING_FIELD].forEach((field) => {
      if (!record[field]) return;
      record[field].disabled = true;
      const hasValue = record[field].value?.length > 0;
      KT.record().setFieldShown(field, manual && (!detail || hasValue));
    });
    if (record[CFG.COUNT_FIELD]) {
      record[CFG.COUNT_FIELD].disabled = true;
      KT.record().setFieldShown(CFG.COUNT_FIELD, false);
    }
  };

  /** 「設定簽核人」按鈕：手動模式、可以改簽核人的狀態才出現；旁邊列出簽核順序 */
  const renderButton = (record) => {
    const space = KT.record().getSpaceElement?.(SPACE_ID);
    if (!space) return;
    const show = isManual(record) && isEditableStatus(record[F.STATUS_FIELD]?.value);
    if (!show) {
      space.replaceChildren();
      return;
    }
    const filled = signersOf(record).filter(Boolean);
    const staff = (record[CFG.ACCOUNTING_FIELD]?.value || []).map(toUser).filter(Boolean);
    const wrap = el('div', 'pr-signer-entry');
    wrap.appendChild(button('pr-signer-entry__btn', filled.length > 0 ? '更改簽核人' : '設定簽核人', () => open()));
    if (filled.length > 0) {
      const applicant = toUser(record[F.APPLICANT]?.value?.[0]);
      wrap.appendChild(routeList({ applicant, signers: filled, staff }));
    } else {
      wrap.appendChild(el('span', 'pr-signer-entry__summary', '還沒指定簽核人'));
    }
    space.replaceChildren(wrap);
  };

  /** 讀畫面上的資料開視窗，按確定後寫回三格、人數與會計承辦人（change 事件不能等非同步，所以用 get()/set()） */
  const open = () => {
    if (dialogOpen) return Promise.resolve(null);
    const { record } = KT.record().get();
    const applicant = toUser(record[F.APPLICANT]?.value?.[0]);
    return openDialog({
      initial: signersOf(record),
      applicant,
      accounting: record[CFG.ACCOUNTING_FIELD]?.value || [],
      accountingRequired: !C.isAdmin(),
    }).then((result) => {
      if (!result) {
        // 按取消而且一位簽核人都沒指定：手動設定沒有意義，取消勾選、改回系統自動排人
        const { record: now } = KT.record().get();
        if (isManual(now) && !signersOf(now).some(Boolean)) window.PR_MANUAL_MODE?.exitManualMode();
        return null;
      }
      const current = KT.record().get();
      if (!isManual(current.record)) return null; // 視窗開著時取消了手動
      writeSigners(current.record, result.signers);
      CFG.FIELDS.forEach((field) => {
        if (current.record[field]) current.record[field].disabled = true;
      });
      const staffField = current.record[CFG.ACCOUNTING_FIELD];
      if (staffField) {
        staffField.value = result.accounting.map(toUser);
        staffField.disabled = true;
      }
      KT.record().set(current);
      renderButton(current.record);
      return result;
    });
  };

  /** 進入手動模式（signing_personnel_manager 勾選時呼叫）：顯示三格與按鈕；openNow＝true 時馬上開視窗 */
  const enter = (record, { openNow = false } = {}) => {
    applyDisplay(record);
    renderButton(record);
    if (openNow) Promise.resolve().then(open);
  };

  /** 離開手動模式（改回自動）：清空三格、手動會計承辦人與人數，收起按鈕 */
  const leave = (record) => {
    writeSigners(record, [null, null, null]);
    if (record[CFG.ACCOUNTING_FIELD]) record[CFG.ACCOUNTING_FIELD].value = [];
    applyDisplay(record);
    renderButton(record);
  };

  // ── 事件 ───────────────────────────────────────────────────────────────

  KT.on(['app.record.create.show', 'app.record.edit.show'], (event) => {
    applyDisplay(event.record);
    renderButton(event.record);
    if (isManual(event.record) && isEditableStatus(event.record[F.STATUS_FIELD]?.value)) {
      loadUsers().catch(() => {}); // 先在背景抓名單，開視窗就不用等
    }
    return event;
  });

  KT.on('app.record.detail.show', (event) => {
    applyDisplay(event.record, { detail: true });
    return event;
  });

  window.PR_MANUAL_SIGNERS = Object.freeze({
    isEditableStatus,
    signersOf,
    countValueOf,
    checkSigners,
    writeSigners,
    searchUsers,
    validate,
    openDialog,
    open,
    /** 會計承辦人自動帶入後呼叫（signing_personnel_manager）：開著的視窗第 4 格還空著就補上，按鈕旁的順序也重畫 */
    offerAccounting: (list) => {
      activeDialog?.offerAccounting(list);
      renderButton(KT.record().get().record);
    },
    enter,
    leave,
    /** 測試用：清掉人員名單快取 */
    _reset: () => {
      usersPromise = null;
      dialogOpen = false;
      activeDialog = null;
    },
  });
})();
