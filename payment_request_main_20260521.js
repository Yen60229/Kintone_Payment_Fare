(function () {
  'use strict';

  // =========================================================================
  // SECTION 1: 頂層常數與設定 (Config & Constants)
  // =========================================================================

  // PR_CONFIG 全域物件別名
  const C = window.PR_CONFIG;
  const F = window.PR_CONFIG.FIELDS;
  const APPS = window.PR_CONFIG.APPS;
  const STATUS = window.PR_CONFIG.STATUS;
  const SPACES = window.PR_CONFIG.SPACES;

  const TRAFFIC = F.TRAFFIC_TABLE;
  const COST_CENTER_APP_ID = APPS.COST_CENTER;

  // 公司名稱（下拉選項值）：費用所屬人部門代碼以「聯海」開頭 → 聯海通運，其餘 → ＮＸ臺灣國際物流
  const COMPANY_NAME_LIANHAI = '聯海通運';
  const COMPANY_NAME_NX = 'ＮＸ臺灣國際物流';
  const COMPANY_DEPT_PREFIX_LIANHAI = '聯海';

  // 頁面說明文案（空白欄位 Space_Noti_1／2／3）
  const INSTRUCTIONS = {
    付款方式: `<span style="font-size: 20px; color: #333; font-weight: bold;">&ensp;※ 付款方式：</span><span style="font-size: 20px; color: #ff0000ff; font-weight: bold;">皆以電匯為主，除特殊情況才可使用現金</span>`,
    付款原則: `<span style="font-size: 20px; color: #333; font-weight: bold;">&ensp;※ 付款原則：一般帳款２個月，特殊期限請標註日期</span>`,
    交通費說明: `<span style="font-size: 20px; color: #333; font-weight: bold;">&ensp;※ 交通費請款：搭乘計程車請說明理由</span>`,
    受款人員工: `<span style="font-size: 20px; color: #333; font-weight: bold;margin-top: 30px;display: inline-block;">&ensp;※ 受款人為員工 ➡︎ 員工編號＋中文姓名</span>`,
  };

  const NOTIFICATIONS = Object.freeze({
    [SPACES.NOTI_1]: '',
    [SPACES.NOTI_2]: [INSTRUCTIONS.付款方式, INSTRUCTIONS.付款原則, INSTRUCTIONS.交通費說明].join('<br>'),
    [SPACES.NOTI_3]: INSTRUCTIONS.受款人員工,
  });

  // 模組層級變數/快取（費用歸屬主檔，一次載入）
  let LOCATION_CODE_MAP = {}; // 代號（大寫）→ 據點，會計單位判定用
  let NAME_OF_CODE = {}; // 代號（大寫）→ 中文名稱，畫面提示用
  let VALID_COST_CENTER_CODES = new Set(); // 「使用中」代碼（原始大小寫），給存檔驗證共用
  let DEPT_OF_CODE = {}; // 代號（大寫）→ 所屬部門的組織代碼，掛帳單位限部內用
  let DEPT_NAMES = {}; // 所屬部門組織代碼 → 名稱（錯誤訊息用）
  let _costCenterLoadPromise = null;

  // =========================================================================
  // SECTION 2: UI 介面與 DOM 輔助函數 (UI & DOM Helpers)
  // =========================================================================

  /**
   * 更新空白欄位說明內容
   */
  const updateSpaceNotifications = () => {
    Object.entries(NOTIFICATIONS).forEach(([spaceId, html]) => {
      const el = kintone.app.record.getSpaceElement(spaceId);
      if (el) el.innerHTML = html;
    });
  };

  /**
   * 取得表格內欄位值
   */
  function getCellValue(dataCell) {
    const valueContent = dataCell.querySelector('.control-value-content-gaia');
    if (valueContent) return valueContent.textContent.trim();

    const dropdownValue = dataCell.querySelector('.control-value-gaia[class*="value-"]');
    if (dropdownValue) return dropdownValue.textContent.trim();

    const checkboxSpans = dataCell.querySelectorAll('.control-value-gaia .control-value-content-gaia');
    if (checkboxSpans.length > 0) {
      const values = Array.from(checkboxSpans).map((span) => span.textContent.trim());
      return values.filter((v) => v).join(', ');
    }

    const multilineDiv = dataCell.querySelector('.control-value-gaia > div');
    if (multilineDiv) return multilineDiv.textContent.trim();

    const controlValue = dataCell.querySelector('.control-value-gaia');
    if (controlValue) {
      const text = controlValue.textContent.trim();
      if (!text.includes('選擇') && !text.includes('清除') && !text.includes('Browse')) {
        return text;
      }
    }

    return '';
  }

  /**
   * 載入費用歸屬部門提示 CSS 樣式
   */
  function addDepartmentHintStyles() {
    if (document.getElementById('kintone-department-hint-style')) return;
    const style = document.createElement('style');
    style.id = 'kintone-department-hint-style';
    style.textContent = `
    .department-hint {
      color: #28a745 !important;
      font-size: 18px !important;
      margin-top: 2px !important;
      font-weight: bold !important;
      position: relative !important;
      z-index: 1000 !important;
      white-space: pre-line !important;
      text-align: center !important;
    }

    .department-error {
      color: #dc3545 !important;
      font-size: 12px !important;
      margin-top: 2px !important;
      font-weight: bold !important;
      position: relative !important;
      z-index: 1000 !important;
      text-align: center !important;
    }
  `;
    document.head.appendChild(style);
  }

  const clearCostFieldHints = () => {
    document.querySelectorAll('.department-hint, .department-error').forEach((hint) => hint.remove());
  };

  /**
   * 在畫面上值等於 costValue 的費用歸屬輸入框下方，掛上中文名稱（綠字）或「代碼不存在」（紅字）
   */
  function findAndUpdateAllCostFields(costValue, departmentName, isError = false) {
    addDepartmentHintStyles();
    setTimeout(() => {
      document.querySelectorAll('.subtable-gaia input[type="text"], table input[type="text"]').forEach((input) => {
        if (!input.value || input.value.toUpperCase() !== costValue.toUpperCase()) return;

        const targetContainer = input.closest('td') || input.closest('.field-inner-gaia') || input.closest('.field-gaia') || input.parentElement;
        if (!targetContainer) return;

        targetContainer.querySelectorAll('.department-hint, .department-error').forEach((hint) => hint.remove());

        const hintElement = document.createElement('div');
        hintElement.className = isError ? 'department-error' : 'department-hint';
        hintElement.textContent = isError ? `⚠ 代碼 "${costValue}" 不存在` : departmentName.replace(/\(/g, '\n(');
        try {
          targetContainer.appendChild(hintElement);
        } catch (error) {
          console.error('添加提示失敗:', error);
        }
      });
    }, 500);
  }

  /**
   * 依代號是否存在於費用歸屬主檔，掛上對應提示
   */
  const showCostCenterHint = (costValue) => {
    const name = NAME_OF_CODE[costValue];
    if (name) findAndUpdateAllCostFields(costValue, name, false);
    else findAndUpdateAllCostFields(costValue, '', true);
  };

  /**
   * 自動偵測並處理所有符合條件的表格顯示與欄寬
   */
  function autoProcessAllTables() {
    setTimeout(() => {
      const foundTables = [];
      const outerContainers = document.querySelectorAll('.subtable-row-gaia[class*="subtable-row-"]');

      outerContainers.forEach((container) => {
        const classList = Array.from(container.classList);
        const hasNumberCode = classList.some((cls) => /subtable-row-\d+/.test(cls));
        if (hasNumberCode) foundTables.push(container);
      });

      foundTables.forEach((tableContainer, index) => {
        const isVisible =
          tableContainer.offsetParent !== null &&
          getComputedStyle(tableContainer).display !== 'none' &&
          getComputedStyle(tableContainer).visibility !== 'hidden';

        if (!isVisible) return;

        const titleElement = tableContainer.querySelector('.subtable-row-label-text-gaia, .subtable-label-gaia, .control-label-text-gaia');
        if (titleElement) {
          const tableName = titleElement.textContent.trim();
          if (tableName === F.SIGN_TABLE.CODE) return;
        }

        let fieldCode = tableContainer.getAttribute('data-field-code');

        if (!fieldCode) {
          const parentWithFieldCode = tableContainer.closest('[data-field-code]');
          if (parentWithFieldCode) fieldCode = parentWithFieldCode.getAttribute('data-field-code');
        }

        if (!fieldCode) {
          const classList = Array.from(tableContainer.classList);
          const subtableClass = classList.find(
            (cls) => (cls.startsWith('subtable-') && cls !== 'subtable-gaia' && cls !== 'subtable-row-gaia') || cls.startsWith('subtable-row-'),
          );
          if (subtableClass) {
            fieldCode = subtableClass.startsWith('subtable-row-') ? subtableClass.replace('subtable-row-', '') : subtableClass.replace('subtable-', '');
          }
        }

        if (!fieldCode) fieldCode = `auto_table_${index}`;

        processTableByContainer(tableContainer, fieldCode);
      });
    }, 1000);
  }

  /**
   * 直接針對表格容器進行處理的函數
   */
  function processTableByContainer(tableContainer, fieldCode) {
    let headerCells = null;
    let dataRows = null;

    const table = tableContainer.querySelector('table');
    if (table) {
      headerCells = table.querySelectorAll('thead th.subtable-label-gaia');
      dataRows = table.querySelectorAll('tbody tr');
    }

    if (!headerCells || headerCells.length === 0) {
      headerCells = tableContainer.querySelectorAll('thead th.subtable-label-gaia');
      dataRows = tableContainer.querySelectorAll('tbody tr');
    }

    if (!headerCells || headerCells.length === 0) {
      const subtableContainers = tableContainer.querySelectorAll('.subtable-gaia, .subtable-row-gaia');
      for (const container of subtableContainers) {
        headerCells = container.querySelectorAll('thead th.subtable-label-gaia');
        dataRows = container.querySelectorAll('tbody tr');
        if (headerCells.length > 0) break;
      }
    }

    if (!headerCells || headerCells.length === 0) return;

    headerCells.forEach((headerCell, columnIndex) => {
      let maxLength = 0;
      let hasValue = false;

      dataRows.forEach((row) => {
        const dataCells = row.querySelectorAll('td');
        if (dataCells[columnIndex]) {
          const cellText = getCellValue(dataCells[columnIndex]);
          if (cellText !== '' && cellText !== '0' && cellText !== 'null' && cellText !== 'undefined') {
            hasValue = true;
            maxLength = Math.max(maxLength, cellText.length);
          }
        }
      });

      if (!hasValue) {
        headerCell.style.display = 'none';
        dataRows.forEach((row) => {
          const dataCells = row.querySelectorAll('td');
          if (dataCells[columnIndex]) dataCells[columnIndex].style.display = 'none';
        });
      } else {
        const width = maxLength * 12 + 40 + 'px';
        headerCell.style.width = width;
        headerCell.style.minWidth = width;
        headerCell.style.maxWidth = width;

        dataRows.forEach((row) => {
          const dataCells = row.querySelectorAll('td');
          if (dataCells[columnIndex]) {
            dataCells[columnIndex].style.width = width;
            dataCells[columnIndex].style.minWidth = width;
            dataCells[columnIndex].style.maxWidth = width;
          }
        });
      }
    });
  }

  /**
   * 重新綁定取消按鈕事件
   */
  function rebindCancelButton() {
    setTimeout(() => {
      const cancelButton = document.querySelector('.gaia-ui-actionmenu-cancel');
      if (cancelButton) {
        const newCancelButton = cancelButton.cloneNode(true);
        cancelButton.parentNode.replaceChild(newCancelButton, cancelButton);
        newCancelButton.addEventListener('click', function (e) {
          e.preventDefault();
          window.location.href = `/k/${APPS.PAYMENT}/`;
        });
      }
    }, 500);
  }

  // =========================================================================
  // SECTION 3: 業務邏輯、API 查詢與計算函數 (Business Logic & Calculations)
  // =========================================================================

  /**
   * 從費用歸屬代碼主檔（APPS.COST_CENTER）載入「使用中」的代碼，一次建好三份對照：
   *   LOCATION_CODE_MAP        代號 → 據點（會計單位判定用）
   *   NAME_OF_CODE             代號 → 中文名稱（畫面提示用）
   *   VALID_COST_CENTER_CODES  「使用中」代碼集合（存檔驗證用）
   *   DEPT_OF_CODE             代號 → 所屬部門組織代碼（掛帳單位限部內用）
   */
  const loadCostCenterMaps = () => {
    if (_costCenterLoadPromise) return _costCenterLoadPromise;

    _costCenterLoadPromise = (async () => {
      const CC = C.REF_FIELDS.COST_CENTER;
      const params = {
        app: COST_CENTER_APP_ID,
        fields: [CC.CODE, CC.LOCATION, CC.NAME, CC.DEPT],
        query: `${CC.IN_USE} in ("使用中")`,
        size: 500,
      };

      const cursor = await kintone.api(kintone.api.url('/k/v1/records/cursor', true), 'POST', params);

      const locMap = {};
      const nameMap = {};
      const deptMap = {};
      const deptNames = {};
      const validCodes = new Set(); // 原始大小寫，給存檔驗證用（和 submit 自己查時的比對方式一致）
      const fieldConflicts = { loc: {}, nm: {} };

      let hasNext = true;
      while (hasNext) {
        const resp = await kintone.api(kintone.api.url('/k/v1/records/cursor', true), 'GET', { id: cursor.id });
        resp.records.forEach((r) => {
          const rawCode = r[CC.CODE]?.value?.trim();
          if (!rawCode) return;
          validCodes.add(rawCode);
          const code = rawCode.toUpperCase();
          const loc = r[CC.LOCATION]?.value?.trim();
          const name = r[CC.NAME]?.value?.trim();
          const dept = r[CC.DEPT]?.value?.[0];
          if (dept?.code) {
            if (!deptMap[code]) deptMap[code] = dept.code;
            deptNames[dept.code] = dept.name || dept.code;
          }
          // 同代號可建多筆記錄：據點／中文名稱保留第一筆非空值，值不同就點名代號提醒管理者
          if (loc) {
            if (!locMap[code]) locMap[code] = loc;
            else if (locMap[code] !== loc) (fieldConflicts.loc[code] = fieldConflicts.loc[code] || new Set()).add(loc);
          }
          if (name) {
            if (!nameMap[code]) nameMap[code] = name;
            else if (nameMap[code] !== name) (fieldConflicts.nm[code] = fieldConflicts.nm[code] || new Set()).add(name);
          }
        });
        hasNext = resp.next;
      }

      LOCATION_CODE_MAP = locMap;
      NAME_OF_CODE = nameMap;
      VALID_COST_CENTER_CODES = validCodes;
      DEPT_OF_CODE = deptMap;
      DEPT_NAMES = deptNames;

      console.log(`✅ 已載入 ${validCodes.size} 筆費用歸屬代碼`);

      Object.keys(fieldConflicts).forEach((kind) => {
        Object.keys(fieldConflicts[kind]).forEach((code) => {
          const label = kind === 'loc' ? '據點' : '名稱';
          const first = kind === 'loc' ? locMap[code] : nameMap[code];
          console.warn(`⚠️ [費用歸屬] 代號「${code}」在費用歸屬主檔的多筆記錄中有不同的${label}，已採用第一筆「${first}」；請回主檔統一`, [...fieldConflicts[kind][code]]);
        });
      });

      refreshAllCostCenterHints();
    })().catch((err) => {
      console.error('❌ 載入費用歸屬代碼失敗:', err);
      _costCenterLoadPromise = null;
      throw err;
    });

    return _costCenterLoadPromise;
  };

  // 供存檔驗證（payment_request_submit）取用主檔快取的入口，省掉存檔時再查一次主檔。
  window.PR_COST_CENTER = Object.freeze({
    /** 確保主檔快取已載入；重複呼叫共用同一個 Promise */
    ensureLoaded: () => loadCostCenterMaps(),
    /** 「使用中」的費用歸屬代碼（原始大小寫）（呼叫前需先 await ensureLoaded()） */
    getValidCodes: () => VALID_COST_CENTER_CODES,
    /** 代號（大寫）→ 所屬部門組織代碼（呼叫前需先 await ensureLoaded()） */
    getDeptOfCode: () => DEPT_OF_CODE,
    /** 所屬部門組織代碼 → 名稱 */
    getDeptNames: () => DEPT_NAMES,
  });

  /**
   * 當費用歸屬主檔載入完成後，自動更新當前畫面上所有費用歸屬欄位的中文提示
   */
  function refreshAllCostCenterHints() {
    try {
      const record = kintone.app.record.get()?.record;
      if (!record) return;

      const rows = record[TRAFFIC.CODE]?.value;
      if (!Array.isArray(rows)) return;
      rows.forEach((row) => {
        const costValue = row?.value?.[TRAFFIC.COLS.EXPENSE]?.value?.trim()?.toUpperCase();
        if (costValue) showCostCenterHint(costValue);
      });
    } catch (e) {
      // 頁面未完全渲染完畢時靜默相容
    }
  }

  const getLocationForCode = (code) => LOCATION_CODE_MAP[code] || null;

  /**
   * 判斷費用歸屬據點
   * @param {string[]} costAllocations 各列費用歸屬代號（大寫）
   * @param {string} applicationUnit 費用所屬人部門名稱（桃園機場特殊代碼判斷用）
   * @returns {string} ACCOUNTING.MAP 的鍵
   */
  const determineAllocation = (costAllocations, applicationUnit) => {
    const SpecialCodes_1 = costAllocations.every((code) => C.ACCOUNTING.SPECIAL_CODES_AIRPORT.includes(code));
    if (SpecialCodes_1) {
      const unitString = String(applicationUnit || '');
      const hasTaoyuan = unitString.indexOf('桃園機場', 0) !== -1;
      return hasTaoyuan ? 'CKS' : 'TPE';
    }

    const SpecialCodes_2 = costAllocations.some((code) => C.ACCOUNTING.SPECIAL_CODES_MARINE.includes(code));
    if (SpecialCodes_2) {
      return 'TPE海運';
    }

    const locations = costAllocations.map((code) => getLocationForCode(code));
    const uniqueLocations = [...new Set(locations.filter((l) => l))];

    return uniqueLocations.length === 1 ? uniqueLocations[0] : 'TPE';
  };

  /**
   * 更新會計單位欄位
   */
  const updateAccountingDepartment = (record, allocation) => {
    const accCode = C.ACCOUNTING.MAP[allocation];
    if (accCode) {
      record[F.ACCOUNTING_UNIT] = {
        value: [
          {
            code: accCode,
            name: accCode,
          },
        ],
        type: 'GROUP_SELECT',
        disabled: true,
      };
    }
  };

  /**
   * 依費用所屬人部門推導公司名稱：部門代碼開頭為「聯海」→ 聯海通運；其餘（含尚未選擇）→ ＮＸ臺灣國際物流。
   * @param {Object} record
   * @returns {string}
   */
  const deriveCompanyNameByExpenseOwnerOrg = (record) => {
    const code = record[F.EXPENSE_OWNER_ORG]?.value?.[0]?.code || '';
    return code.startsWith(COMPANY_DEPT_PREFIX_LIANHAI) ? COMPANY_NAME_LIANHAI : COMPANY_NAME_NX;
  };

  // 費用所屬人部門是別的模組（簽核人員程式帶入部門時）也會改到的欄位，公司名稱跟著重算要共用同一份推導
  window.PR_COMPANY_NAME = Object.freeze({
    derive: deriveCompanyNameByExpenseOwnerOrg,
    /** 重算並寫回 record 的公司名稱，同時鎖住欄位 */
    apply: (record) => {
      if (!record[F.COMPANY_NAME]) return;
      record[F.COMPANY_NAME].value = deriveCompanyNameByExpenseOwnerOrg(record);
      record[F.COMPANY_NAME].disabled = true;
    },
  });

  /**
   * 主要顯示與編輯頁面處理
   */
  function handleMainShowEditEvents(event) {
    const record = event.record;

    // -------------------------------------------------------------------------
    // 欄位鎖定（kintone 不存 disabled 狀態，每次進畫面都要重套）
    // 傳票編號、傳票日期等依角色與關卡的鎖定，由「帳號權限設定 App」的模組控管。
    // 帳號權限設定模組先載入，這裡最後套用，以這裡為準。
    // -------------------------------------------------------------------------
    record[F.PAYMENT_DATE].disabled = true;
    // 申請人、申請人部門、受款人：只有管理員可改（費用所屬人、費用所屬人部門開放所有人改）
    [F.APPLICANT, F.APPLICANT_ORG, F.PAYEE].forEach((field) => {
      if (record[field]) record[field].disabled = !C.isAdmin();
    });

    kintone.app.record.setFieldShown(F.ACCOUNTING_STAFF, C.isAdmin());
    kintone.app.record.setFieldShown(F.PERMISSION_STAFF, C.isAdmin());
    updateSpaceNotifications();
    loadCostCenterMaps().catch(() => {});

    switch (event.type) {
      case 'app.record.print.show':
        autoProcessAllTables();
        break;

      case 'app.record.create.show':
        window.PR_COMPANY_NAME.apply(record);
        rebindCancelButton();
        break;

      case 'app.record.edit.show':
        if (record[F.COMPANY_NAME]) record[F.COMPANY_NAME].disabled = true;
        break;

      case 'app.record.detail.show': {
        const status = record[F.STATUS_FIELD]?.value;
        if (status !== STATUS.REIMBURSEMENT_FILL && status !== STATUS.APPLY_START) {
          autoProcessAllTables();
        }
        kintone.app.record.setFieldShown(F.MANUAL_FLOW, record[F.MANUAL_FLOW]?.value?.length > 0);
        break;
      }
    }

    return event;
  }

  // =========================================================================
  // SECTION 4: Kintone 事件監聽器集中區 (Event Handlers Registration)
  // =========================================================================

  // -------------------------------------------------------------------------
  // 4.1 頁面初始化/顯示事件 (.show)
  // -------------------------------------------------------------------------

  // 主要記錄顯示與編輯事件 (create/edit/detail/print)
  kintone.events.on(['app.record.create.show', 'app.record.edit.show', 'app.record.detail.show', 'app.record.print.show'], (event) => {
    return handleMainShowEditEvents(event);
  });

  // -------------------------------------------------------------------------
  // 4.2 欄位變更事件 (.change)
  // -------------------------------------------------------------------------

  // 費用所屬人部門變更 → 重算公司名稱
  kintone.events.on([`app.record.create.change.${F.EXPENSE_OWNER_ORG}`, `app.record.edit.change.${F.EXPENSE_OWNER_ORG}`], (event) => {
    window.PR_COMPANY_NAME.apply(event.record);
    return event;
  });

  // 費用歸屬變更 → 轉大寫、顯示中文名稱／代碼不存在提示，並依據點判斷會計單位
  kintone.events.on([`app.record.create.change.${TRAFFIC.COLS.EXPENSE}`, `app.record.edit.change.${TRAFFIC.COLS.EXPENSE}`], (event) => {
    loadCostCenterMaps().catch(() => {});
    try {
      const record = event.record;
      const rows = record[TRAFFIC.CODE]?.value || [];

      clearCostFieldHints();
      const costAllocations = rows.map((row) => {
        const cell = row?.value?.[TRAFFIC.COLS.EXPENSE];
        const costValue = cell?.value?.trim().toUpperCase();
        if (!costValue) return '';
        cell.value = costValue;
        showCostCenterHint(costValue);
        return costValue;
      });

      // 手動設定簽核流程時，會計單位由使用者自己選，不自動更動
      if (record[F.MANUAL_FLOW]?.value?.length > 0) return event;

      const applicationUnit = record[F.EXPENSE_OWNER_ORG]?.value?.[0]?.name || '';
      const allocation = determineAllocation(costAllocations, applicationUnit);
      updateAccountingDepartment(record, allocation);

      return event;
    } catch (error) {
      console.error('Error in cost allocation:', error);
      event.error = '費用歸屬處理發生錯誤';
      return event;
    }
  });
})();
