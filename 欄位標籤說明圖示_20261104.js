(() => {
  'use strict';

  // =============================================================================
  // 欄位標籤說明圖示 —— 上傳到 規則主檔 App（APPS.TRAFFIC_RULE_MASTER），不進請款單的 bundle
  //
  // 規則主檔的欄位標籤帶括號說明，例如「固定賣方統編（交通工具用；有填就自動帶入並鎖住）」，
  // 列表表頭、記錄畫面的欄名都很長。本檔把結尾括號裡的文字拿掉，欄名只留括號前的文字，
  // 旁邊放一個小問號，滑鼠移上去（或鍵盤 focus）才顯示括號裡的說明。
  // 請款單的「金額（含稅）」等括號是正式標籤，不要把本檔上傳到請款單 App。
  //
  // 【上傳順序】規則主檔的 JavaScript（PC）：config -> 交通費明細規則主檔檢查 -> 本檔；CSS（PC）：payment_request.css。
  //
  // 【tooltip 做法】問號的 data-pr-hint 屬性 + CSS ::after（content: attr(data-pr-hint)），
  //   樣式全在 payment_request.css（.pr-label-hint*）。不另設 title（會出現兩個 tooltip）。
  //   表頭／欄位容器可能 overflow:hidden 會切到 tooltip，所以替標籤往上最多 HOST_DEPTH 層祖先加
  //   .pr-label-hint-host（CSS 設 overflow: visible）。
  // 【DOM class 是 kintone 內部的】LIST_LABEL_SELECTOR／RECORD_LABEL_SELECTOR 不是公開 API，
  //   kintone 改版可能失效；找不到元素就什麼都不做（不丟錯、不影響其他功能）。
  // =============================================================================

  /** 列表表頭的欄名元素（kintone 內部 class，改版可能失效） */
  const LIST_LABEL_SELECTOR = '.recordlist-header-label-gaia';
  /** 記錄畫面（詳細、新增、編輯）的欄位標籤元素（kintone 內部 class，改版可能失效） */
  const RECORD_LABEL_SELECTOR = '.control-label-text-gaia';
  const DONE_CLASS = 'pr-label-hint-done';
  const ICON_CLASS = 'pr-label-hint';
  const HOST_CLASS = 'pr-label-hint-host';
  const HOST_DEPTH = 3;
  const EVENTS = [
    { type: 'app.record.index.show', selector: LIST_LABEL_SELECTOR },
    { type: 'app.record.detail.show', selector: RECORD_LABEL_SELECTOR },
    { type: 'app.record.create.show', selector: RECORD_LABEL_SELECTOR },
    { type: 'app.record.edit.show', selector: RECORD_LABEL_SELECTOR },
  ];

  const OPEN = '(（';
  const CLOSE = ')）';

  /**
   * 拆欄位標籤。標籤結尾是括號（全形、半形、混用都可以）時：
   * title＝第一個左括號前的文字，hint＝最外層括號內的文字；
   * 括號不在結尾、沒有括號、括號沒成對、title 或 hint 是空的 → hint 為空字串、title 維持原文。
   * @param {string} text
   * @returns {{ title: string, hint: string }}
   */
  const splitLabel = (text) => {
    const raw = text === undefined || text === null ? '' : String(text);
    const s = raw.trim();
    const none = { title: raw, hint: '' };
    if (!s || !CLOSE.includes(s[s.length - 1])) return none;
    const start = [...s].findIndex((ch) => OPEN.includes(ch));
    if (start < 0) return none;
    let depth = 0;
    for (let i = start; i < s.length; i += 1) {
      if (OPEN.includes(s[i])) depth += 1;
      else if (CLOSE.includes(s[i])) depth -= 1;
      if (depth === 0) {
        if (i !== s.length - 1) return none; // 最外層括號在結尾之前就關了 → 括號不在結尾
        const title = s.slice(0, start).trim();
        const hint = s.slice(start + 1, i).trim();
        return title && hint ? { title, hint } : none;
      }
    }
    return none; // 括號沒成對
  };

  /**
   * 處理 root 底下符合 selector 的標籤元素；已處理過的（有 DONE_CLASS）跳過，可重複執行。
   * 只處理沒有子元素的標籤（避免弄掉 kintone 放在裡面的排序圖示等）；必填的 * 是另外的元素，不受影響。
   * @param {{ querySelectorAll: Function }} root
   * @param {string} selector
   * @param {{ createElement: Function }} doc
   * @returns {number} 這次加了幾個問號
   */
  const decorate = (root, selector, doc) => {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;
    let count = 0;
    Array.from(root.querySelectorAll(selector) || []).forEach((label) => {
      if (label.classList.contains(DONE_CLASS)) return;
      if (label.children && label.children.length > 0) return;
      const { title, hint } = splitLabel(label.textContent);
      if (!hint) return;

      const icon = doc.createElement('span');
      icon.className = ICON_CLASS;
      icon.textContent = '?';
      icon.setAttribute('data-pr-hint', hint);
      icon.setAttribute('aria-label', hint);
      icon.setAttribute('role', 'img');
      icon.setAttribute('tabindex', '0');
      // 列表表頭點欄名會排序、標籤點了會 focus 欄位：點問號不要傳出去
      icon.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
      });

      label.textContent = title;
      label.classList.add(DONE_CLASS);
      label.appendChild(icon);
      let host = label.parentElement;
      for (let i = 0; i < HOST_DEPTH && host; i += 1) {
        host.classList.add(HOST_CLASS);
        host = host.parentElement;
      }
      count += 1;
    });
    return count;
  };

  window.PR_LABEL_HINTS = { splitLabel, decorate, LIST_LABEL_SELECTOR, RECORD_LABEL_SELECTOR };

  const KT = window.PR_KT;
  if (!KT || typeof KT.on !== 'function') {
    console.error('欄位標籤說明圖示：找不到 PR_KT，請確認 payment_request_config.js 排在本檔前面');
    return;
  }
  EVENTS.forEach(({ type, selector }) => {
    KT.on(type, (event) => {
      try {
        decorate(document, selector, document);
      } catch (e) {
        console.warn('欄位標籤說明圖示失敗（不影響使用）', e);
      }
      return event;
    });
  });
})();
