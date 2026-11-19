(() => {
  'use strict';

  // =============================================================================
  // 部長的上一階主管改由群組決定（2026-11-16，取代 部長簽核帶入_20261029.js）
  //
  //   費用所屬人在「費用所屬人部門」的職稱＋部門名稱對到 C.DIRECTOR_UPLINE.RULES →
  //   讀那個群組的成員（扣掉費用所屬人本人）放進單位部長_支店長，其餘簽核格清空，
  //   部門主管簽核人數＝0人、部門次長簽核人數＝0人（流程管理：主管、次長都 0 人且部長格有人＝直接到部長確認）。
  //   對不到的人照原本簽核流程主檔（APPS.APPROVAL_FLOW）的排法，本程式不動。
  //
  //   畫面：簽核人員程式（signing_personnel_manager）排人時先問 groupOf()，對到就呼叫 loadMembers()／writeSlots()，不查簽核流程主檔。
  //   存檔：payment_request_submit 呼叫 apply()，再算一次寫進 record；群組扣掉本人後沒人或查不到 → 回錯誤訊息擋存檔。
  //   手動設定簽核流程、表單作廢不處理；送出後（不在可編輯狀態）不重算。
  // =============================================================================

  const C = window.PR_CONFIG;
  const F = C.FIELDS;
  const CFG = C.DIRECTOR_UPLINE;
  const COUNT = CFG.COUNT_FIELDS;
  const ORG_API = '/v1/user/organizations.json';
  const GROUP_API = '/v1/group/users.json';

  // ── 純函式 ──────────────────────────────────────────────────────────────

  /** 部門名稱＋職稱 → 群組代碼；對不到回 null */
  const groupOf = (orgName, title) => C.directorUplineGroupOf(orgName, title);

  /** 這個狀態還能重算（新增畫面沒有狀態欄位值，一律可以） */
  const isEditableStatus = (status) => !status || CFG.EDITABLE_STATUSES.includes(status) || String(status).endsWith(CFG.REJECT_SUFFIX);

  /** 群組成員扣掉本人、去重 */
  const membersExcept = (members, ownerCode) => {
    const seen = new Set([ownerCode]);
    return (members || []).filter((u) => u?.code && !seen.has(u.code) && seen.add(u.code)).map((u) => ({ code: u.code, name: u.name }));
  };

  /** 兩組使用者是否相同（只看代碼、不看順序） */
  const sameUsers = (a, b) => {
    const key = (list) => (list || []).map((u) => u?.code).filter(Boolean).sort().join(',');
    return key(a) === key(b);
  };

  /**
   * 把上一階主管寫進 record：SLOT＝users、CLEAR_FIELDS 清空、主管與次長人數都 0人。
   * 只動 record 裡有的欄位；回傳有沒有改到值。
   */
  const writeSlots = (record, users) => {
    let changed = false;
    const setUsers = (code, list) => {
      if (!record?.[code]) return;
      if (sameUsers(record[code].value, list) && (record[code].value || []).length === list.length) return;
      record[code].value = list;
      changed = true;
    };
    const setCount = (code, n) => {
      if (!record?.[code]) return;
      const value = `${n}人`;
      if (record[code].value === value) return;
      record[code].value = value;
      changed = true;
    };
    setUsers(CFG.SLOT, users);
    CFG.CLEAR_FIELDS.forEach((code) => setUsers(code, []));
    setCount(COUNT.MANAGER, 0);
    setCount(COUNT.DEPUTY, 0);
    return changed;
  };

  /** 錯誤訊息（存檔擋下、畫面提示共用） */
  const emptyMessage = (orgName, group) =>
    `費用所屬人是「${orgName}」部長，上一階主管群組「${group}」裡沒有可簽核的人（扣掉本人）`;

  // ── 查資料 ──────────────────────────────────────────────────────────────

  /** 費用所屬人在費用所屬人部門（組織代碼比對）的部門名稱與職稱；不是他的部門回 null */
  const fetchOwnerOrgTitle = async (ownerCode, orgCode) => {
    const resp = await kintone.api(kintone.api.url(ORG_API, true), 'GET', { code: ownerCode });
    const hit = (resp.organizationTitles || []).find((o) => o.organization?.code === orgCode);
    return hit ? { orgName: hit.organization.name, title: hit.title?.name || '' } : null;
  };

  // 群組成員：同一頁面記住，查失敗就清掉下次再查
  const memberCache = new Map();

  /** 群組成員（分頁抓完）[{code,name}] */
  const loadMembers = (groupCode) => {
    if (!memberCache.has(groupCode)) {
      const task = (async () => {
        const users = [];
        for (let page = 0; page < CFG.GROUP_MAX_PAGES; page++) {
          // eslint-disable-next-line no-await-in-loop
          const resp = await kintone.api(kintone.api.url(GROUP_API, true), 'GET', {
            code: groupCode,
            size: CFG.GROUP_PAGE_SIZE,
            offset: page * CFG.GROUP_PAGE_SIZE,
          });
          const list = resp.users || [];
          users.push(...list.map((u) => ({ code: u.code, name: u.name })));
          if (list.length < CFG.GROUP_PAGE_SIZE) break;
        }
        return users;
      })();
      memberCache.set(groupCode, task);
      task.catch(() => memberCache.delete(groupCode));
    }
    return memberCache.get(groupCode);
  };

  /**
   * 算出這張單的上一階主管。
   * @returns {Promise<{ skip: string }|{ group: string, orgName: string, users: Array }>}
   */
  const resolve = async (record) => {
    if (record?.[F.MANUAL_FLOW]?.value?.length > 0) return { skip: 'manual' };
    const owner = record?.[F.EXPENSE_OWNER]?.value?.[0];
    const ownerOrg = record?.[F.EXPENSE_OWNER_ORG]?.value?.[0];
    if (!owner?.code || !ownerOrg?.code) return { skip: 'no-owner' };
    // 部門名稱不在對照表 → 不用查職稱（其他人存檔不多打 API）
    if (!CFG.RULES.some((r) => r.org === ownerOrg.name)) return { skip: 'not-listed' };
    const info = await fetchOwnerOrgTitle(owner.code, ownerOrg.code);
    if (!info) return { skip: 'org-mismatch' };
    const group = groupOf(info.orgName, info.title);
    if (!group) return { skip: 'not-listed' };
    const users = membersExcept(await loadMembers(group), owner.code);
    return { group, orgName: info.orgName, users };
  };

  // ── 存檔 ────────────────────────────────────────────────────────────────

  /**
   * 存檔時呼叫：算好就寫進 record（值沒變不寫）。沒人可簽或查不到回錯誤訊息擋存檔。
   * @param {Object} record event.record
   * @returns {Promise<string[]>}
   */
  const apply = async (record) => {
    if (record?.[C.VOID_FIELD]?.value?.length > 0) return [];
    if (!isEditableStatus(record?.[F.STATUS_FIELD]?.value)) return [];
    try {
      const result = await resolve(record);
      if (result.skip) return [];
      if (result.users.length === 0) {
        return [`${emptyMessage(result.orgName, result.group)}\n※ 請管理員到 kintone 群組「${result.group}」加入簽核人；急件可改勾「${F.MANUAL_FLOW}」`];
      }
      if (writeSlots(record, result.users)) {
        console.log(`[部長上一階主管] ${result.orgName} 部長 → 群組 ${result.group}：`, result.users.map((u) => u.code));
      }
      return [];
    } catch (err) {
      console.error('[部長上一階主管] 帶入上一階主管失敗:', err);
      return [`費用所屬人是部長，**無法帶入「${CFG.SLOT}」**\n※ ${err?.message || '讀不到群組成員，請稍後再試'}；仍無法存檔請聯絡系統管理員`];
    }
  };

  window.PR_DIRECTOR_UPLINE = Object.freeze({
    groupOf,
    isEditableStatus,
    membersExcept,
    sameUsers,
    writeSlots,
    emptyMessage,
    loadMembers,
    resolve,
    apply,
    /** 測試用：清掉群組成員快取 */
    _reset: () => memberCache.clear(),
  });
})();
