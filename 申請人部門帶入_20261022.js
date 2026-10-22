(() => {
  'use strict';

  // =============================================================================
  // 申請人部門依申請人帶入（2026-10-22）
  //
  //   申請人部門一律鎖住（main 的 show 事件），只能依申請人帶入：
  //     - 新增畫面：目前的部門就是申請人的單位 → 不動；不是（例如複製別人的單）或空白 → 重新帶入
  //     - 改申請人（只有管理員能改）→ 查新申請人的單位帶入
  //   只有一個單位直接帶；兩個以上跳視窗選（主要單位預選）。目前的部門不是這個人的單位時一定要選、不給取消。
  //   查單位與選單位視窗共用簽核人員程式的 PR_ORG_PICKER（和費用所屬人部門同一套）。
  // =============================================================================

  const F = window.PR_CONFIG.FIELDS;

  // 連續改申請人時，只讓最後一次的查詢結果寫回畫面
  let applicantSeq = 0;

  /**
   * 依申請人帶入申請人部門。change／show 事件不可等 API，查詢與寫回放在 .then() 裡用 get()/set()。
   * @param {Object} event
   * @param {{ keepIfValid?: boolean }} [opts] keepIfValid：目前的部門就是申請人的單位時不動（新增畫面用）
   * @returns {Object} event
   */
  const syncApplicantOrg = (event, { keepIfValid = false } = {}) => {
    const record = event.record;
    if (!record[F.APPLICANT_ORG]) return event;
    const applicant = record[F.APPLICANT]?.value?.[0];
    const seq = ++applicantSeq;

    // 申請人清空 → 部門跟著清空
    if (!applicant?.code) {
      record[F.APPLICANT_ORG].value = [];
      return event;
    }

    const picker = window.PR_ORG_PICKER;
    if (!picker) return event;

    picker
      .fetchUserOrgs(applicant.code)
      .then(async (orgs) => {
        if (seq !== applicantSeq) return;
        if (orgs.length === 0) {
          picker.warnNoOrg('申請人');
          return;
        }
        const currentCode = kintone.app.record.get().record[F.APPLICANT_ORG]?.value?.[0]?.code;
        const currentValid = orgs.some((o) => o.organization.code === currentCode);
        if (keepIfValid && currentValid) return;

        const picked = await picker.pickOrg(orgs, applicant.name || applicant.code, {
          subject: '申請人',
          keepable: currentValid,
          isCurrent: () => seq === applicantSeq,
        });
        if (!picked || seq !== applicantSeq) return;

        const current = kintone.app.record.get();
        current.record[F.APPLICANT_ORG].value = [{ code: picked.organization.code, name: picked.organization.name }];
        current.record[F.APPLICANT_ORG].disabled = true;
        kintone.app.record.set(current);
      })
      .catch((err) => console.error('[申請人部門] 帶入申請人部門失敗:', err));
    return event;
  };

  kintone.events.on('app.record.create.show', (event) => syncApplicantOrg(event, { keepIfValid: true }));
  kintone.events.on([`app.record.create.change.${F.APPLICANT}`, `app.record.edit.change.${F.APPLICANT}`], (event) => syncApplicantOrg(event));

  window.PR_APPLICANT_ORG = Object.freeze({ syncApplicantOrg });
})();
