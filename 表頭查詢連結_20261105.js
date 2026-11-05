(() => {
  'use strict';

  // =============================================================================
  // 交通費明細表頭的說明文件連結（桌面版的新增、編輯、詳細畫面；列印頁和手機版不加）
  //
  // 表頭文字在 kintone 表單上，子表格表頭放不了連結，所以由程式把文字換成連結。
  // 連結清單在 config 的 TRAFFIC_TABLE_LAYOUT.HEADER_LINKS，另開新分頁。
  // 只包住表頭裡的文字，不動必填的 *；文字本身不變，main 靠表頭文字找欄位的邏輯不受影響。
  //
  // 【DOM class 是 kintone 內部的】HEADER_SELECTOR 不是公開 API，kintone 改版可能失效；
  //   找不到元素就什麼都不做（不丟錯、不影響其他功能）。
  // 【畫面可能還沒畫好】show 事件當下找不到要加的表頭時，隔一小段時間再試，最多 MAX_RETRY 次。
  // =============================================================================

  const HEADER_SELECTOR = 'thead th.subtable-label-gaia';
  const DONE_CLASS = 'pr-header-links-done';
  const LINK_CLASS = 'pr-header-link';
  const RETRY_MS = 500;
  const MAX_RETRY = 4;
  const TEXT_NODE = 3;

  /** 表頭格的文字（去掉必填的 *） */
  const headerLabel = (th) => String(th?.textContent || '').replace(/\*/g, '').trim();

  /**
   * 把表頭文字切成一般文字與連結（純函式）。連結文字依 links 的順序往後找，找不到的略過。
   * @param {string} text
   * @param {Array<{ text: string, url: string, title?: string }>} links
   * @returns {Array<{ text: string, url?: string, title?: string }>}
   */
  const splitByLinks = (text, links) => {
    const segments = [];
    let rest = text;
    links.forEach((link) => {
      const at = rest.indexOf(link.text);
      if (at < 0) return;
      if (at > 0) segments.push({ text: rest.slice(0, at) });
      segments.push({ text: link.text, url: link.url, title: link.title });
      rest = rest.slice(at + link.text.length);
    });
    if (rest) segments.push({ text: rest });
    return segments;
  };

  /** 在 node 底下找內容等於 label 的文字節點；沒有 → null */
  const findTextNode = (node, label) => {
    if (node.nodeType === TEXT_NODE) return node.nodeValue.trim() === label ? node : null;
    for (const child of Array.from(node.childNodes || [])) {
      const found = findTextNode(child, label);
      if (found) return found;
    }
    return null;
  };

  /** 建一個另開新分頁的連結 */
  const createLink = (segment, doc) => {
    const a = doc.createElement('a');
    a.className = LINK_CLASS;
    a.textContent = segment.text;
    a.setAttribute('href', segment.url);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    if (segment.title) a.setAttribute('title', segment.title);
    return a;
  };

  /**
   * 把一格表頭的文字換成連結。
   * @param {Element} th
   * @param {string} label 表頭文字
   * @param {Array} links
   * @param {Document} doc
   * @returns {boolean} 有沒有換
   */
  const linkHeader = (th, label, links, doc) => {
    const textNode = findTextNode(th, label);
    if (!textNode) return false;
    const parent = textNode.parentNode;
    splitByLinks(textNode.nodeValue, links).forEach((segment) => {
      const node = segment.url ? createLink(segment, doc) : doc.createTextNode(segment.text);
      parent.insertBefore(node, textNode);
    });
    parent.removeChild(textNode);
    th.classList.add(DONE_CLASS);
    return true;
  };

  /**
   * 處理畫面上的表頭；已處理過的跳過，可重複執行。
   * @param {Document} doc
   * @param {{ COLUMNS: Array, HEADER_LINKS: Object }} layout
   * @returns {number} 畫面上有設定連結的表頭數（含已處理過的）
   */
  const decorateHeaders = (doc, layout) => {
    const linksByLabel = new Map(
      layout.COLUMNS.filter((column) => layout.HEADER_LINKS[column.code]).map((column) => [column.label, layout.HEADER_LINKS[column.code]]),
    );
    let matched = 0;
    Array.from(doc.querySelectorAll(HEADER_SELECTOR)).forEach((th) => {
      const label = headerLabel(th);
      const links = linksByLabel.get(label);
      if (!links) return;
      matched += 1;
      if (!th.classList.contains(DONE_CLASS)) linkHeader(th, label, links, doc);
    });
    return matched;
  };

  const KT = window.PR_KT;
  const layout = window.PR_CONFIG.TRAFFIC_TABLE_LAYOUT;

  /** 找不到表頭就稍後再試；一切失敗都不影響表單 */
  const tryDecorate = (retriesLeft) => {
    try {
      if (decorateHeaders(document, layout) > 0 || retriesLeft <= 0) return;
      setTimeout(() => tryDecorate(retriesLeft - 1), RETRY_MS);
    } catch (e) {
      console.warn('交通費明細表頭連結失敗（不影響使用）', e);
    }
  };

  KT.on(['app.record.create.show', 'app.record.edit.show', 'app.record.detail.show'], (event) => {
    tryDecorate(MAX_RETRY);
    return event;
  });

  window.PR_TABLE_HEADER_LINKS = Object.freeze({ splitByLinks, decorateHeaders, HEADER_SELECTOR });
})();
