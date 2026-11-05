(function () {
  'use strict';

  // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
  const KT = window.PR_KT;

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

  // 頁面說明文案（空白欄位 Space_Noti_1／2／3）；樣式在 payment_request.css（.pr-noti*）
  const INSTRUCTIONS = {
    付款方式: `<span class="pr-noti">&ensp;※ 付款方式：</span><span class="pr-noti-red">皆以電匯為主，除特殊情況才可使用現金</span>`,
    付款原則: `<span class="pr-noti">&ensp;※ 付款原則：一般帳款２個月，特殊期限請標註日期</span>`,
    交通費說明: `<span class="pr-noti">&ensp;※ 交通費請款：搭乘計程車請說明理由</span>`,
    受款人員工: `<span class="pr-noti pr-noti-payee">&ensp;※ 受款人為員工 ➡︎ 員工編號＋中文姓名</span>`,
  };

  const NOTIFICATIONS = Object.freeze({
    [SPACES.NOTI_1]: '',
    [SPACES.NOTI_2]: [INSTRUCTIONS.付款方式, INSTRUCTIONS.付款原則, INSTRUCTIONS.交通費說明].join('<br>'),
    [SPACES.NOTI_3]: INSTRUCTIONS.受款人員工,
  });

  // 模組層級變數/快取（費用歸屬主檔，一次載入）
  let NAME_OF_CODE = {}; // 代號（大寫）→ 中文名稱，畫面提示用
  let VALID_COST_CENTER_CODES = new Set(); // 「使用中」代碼（原始大小寫），給存檔驗證共用
  let DEPT_OF_CODE = {}; // 代號（大寫）→ 所屬部門的組織代碼陣列（同代號可屬多個部門，例如總公司代碼），掛帳單位限部內用
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
      const el = KT.record().getSpaceElement(spaceId);
      if (el) el.innerHTML = html;
    });
  };

  // 費用歸屬中文名稱（綠字）／代碼不存在（紅字）提示的樣式在 payment_request.css（.department-hint／.department-error）

  const clearCostFieldHints = () => {
    document.querySelectorAll('.department-hint, .department-error').forEach((hint) => hint.remove());
  };

  /**
   * 在畫面上值等於 costValue 的費用歸屬輸入框下方，掛上中文名稱（綠字）或「代碼不存在」（紅字）
   */
  function findAndUpdateAllCostFields(costValue, departmentName, isError = false) {
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

  // ── 詳細頁／列印頁：交通費明細子表格的欄寬（資料驅動）─────────────────────
  //   欄位順序、表頭文字、型別來自 config 的 TRAFFIC_TABLE_LAYOUT（kintone MCP 讀 749 表單，form_snapshots/ 有快照），
  //   值來自 event.record，不再從畫面上抓文字猜：
  //     整欄都沒有值 → 藏起來；有值 → 依最長的顯示文字（和表頭文字）算寬度。
  //     只設 width／min-width、不設 max-width：內容再長也只會把欄撐開，不會被鎖窄而溢出蓋到隔壁欄。
  //   畫面上靠「表頭文字」找出是哪一欄，對不到的欄不動；表頭對不上的子表格（簽核記錄）整張不動。
  //
  // 【換頁太快會畸形的防護】（2026-10-22）
  //   處理是延遲 1 秒才做（等畫面畫好）。使用者在這之前就按「編輯」，舊的計時器會在編輯畫面上跑，
  //   把格子鎖成詳細頁的寬度，組織／人員選擇器縮不進去就溢出蓋到隔壁欄（表格畸形）。
  //   三道防護：① 每次 show 畫面序號 +1，計時器到時序號不同就不做；② 表格裡有輸入框（編輯畫面）就不處理；
  //   ③ 被調過的格子都做記號，進新增／編輯畫面時把記號格子的寬度、隱藏還原。
  const TABLE_LAYOUT = C.TRAFFIC_TABLE_LAYOUT;
  const TABLE_DELAY_MS = 1000;
  const AUTO_WIDTH_ATTR = 'data-pr-auto-width';
  let tableViewSeq = 0;

  /** 文字的寬度單位：中文與全形符號 2、其餘 1 */
  const textUnits = (text) => {
    let units = 0;
    for (const char of String(text || '')) units += /[⺀-鿿　-〿＀-￯]/.test(char) ? 2 : 1;
    return units;
  };

  /**
   * 一格在詳細頁上顯示的文字（空字串＝沒有值）。數值 0 當作沒有值；數值加千分位與單位。
   * @param {Object} cell 子表格一列裡的欄位 { value }
   * @param {{ type: string, unit?: string }} column
   * @returns {string}
   */
  const displayText = (cell, column) => {
    const value = cell?.value;
    if (value === null || value === undefined) return '';
    if (column.type === 'NUMBER') {
      const n = Number(value);
      if (value === '' || !Number.isFinite(n) || n === 0) return '';
      return `${n.toLocaleString('en-US')}${column.unit || ''}`;
    }
    return String(value).trim();
  };

  /**
   * 依記錄的值決定每一欄要藏起來還是多寬（純函式）。
   * @param {Array} rows 子表格的列（record[子表格].value）
   * @returns {Array<{ code: string, label: string, hidden: boolean, width: string|null }>}
   */
  const planTrafficTable = (rows) => {
    const { PX_PER_UNIT, PADDING_PX, MIN_PX, MAX_PX } = TABLE_LAYOUT.WIDTH;
    return TABLE_LAYOUT.COLUMNS.map((column) => {
      const texts = (rows || []).map((row) => displayText(row?.value?.[column.code], column)).filter(Boolean);
      if (texts.length === 0) return { code: column.code, label: column.label, hidden: true, width: null };
      const units = Math.max(textUnits(column.label), ...texts.map(textUnits));
      const px = Math.min(Math.max(units * PX_PER_UNIT + PADDING_PX, MIN_PX), MAX_PX);
      return { code: column.code, label: column.label, hidden: false, width: `${px}px` };
    });
  };

  /** 表頭格的文字（去掉必填的 *） */
  const headerLabel = (th) => String(th?.textContent || '').replace(/\*/g, '').trim();

  /** 把格子設成指定寬度（width＝null 就藏起來），並做記號以便還原 */
  const markCell = (cell, width) => {
    if (width === null) cell.style.display = 'none';
    else {
      cell.style.width = width;
      cell.style.minWidth = width;
    }
    cell.setAttribute(AUTO_WIDTH_ATTR, '1');
  };

  /** 還原所有被調過的格子 */
  const resetAutoTableWidths = () => {
    document.querySelectorAll(`[${AUTO_WIDTH_ATTR}]`).forEach((cell) => {
      cell.style.width = '';
      cell.style.minWidth = '';
      cell.style.maxWidth = '';
      cell.style.display = '';
      cell.removeAttribute(AUTO_WIDTH_ATTR);
    });
  };

  /**
   * 把計畫套到畫面上的一張子表格。表頭對不上交通費明細（例如簽核記錄）或已是編輯畫面就不動。
   * @param {Element} container 子表格外框
   * @param {Array} plan planTrafficTable 的結果
   * @returns {boolean} 有沒有套用
   */
  const applyTablePlan = (container, plan) => {
    // 表格裡有輸入框＝編輯／新增畫面，不處理
    if (container.querySelector('input, select, textarea')) return false;
    const headers = Array.from(container.querySelectorAll('thead th.subtable-label-gaia'));
    const planByLabel = new Map(plan.map((p) => [p.label, p]));
    const matched = headers.map((th) => planByLabel.get(headerLabel(th)) || null);
    // 一半以上的表頭對得上才算交通費明細
    if (matched.filter(Boolean).length * 2 < headers.length || headers.length === 0) return false;

    const rows = Array.from(container.querySelectorAll('tbody tr'));
    matched.forEach((p, index) => {
      if (!p) return;
      const width = p.hidden ? null : p.width;
      markCell(headers[index], width);
      rows.forEach((row) => {
        const td = row.querySelectorAll('td')[index];
        if (td) markCell(td, width);
      });
    });
    return true;
  };

  /**
   * 詳細頁／列印頁：等畫面畫好後，依記錄的值調整交通費明細子表格的欄寬。
   * @param {Object} record event.record
   * @param {number} seq 呼叫當下的畫面序號；到時已換畫面就不做
   */
  const layoutTrafficTable = (record, seq) => {
    setTimeout(() => {
      if (seq !== tableViewSeq) return;
      const plan = planTrafficTable(record[TRAFFIC.CODE]?.value);
      document.querySelectorAll('.subtable-row-gaia[class*="subtable-row-"]').forEach((container) => {
        try {
          applyTablePlan(container, plan);
        } catch (err) {
          console.warn('[交通費明細欄寬] 調整失敗，維持原樣', err);
        }
      });
    }, TABLE_DELAY_MS);
  };

  window.PR_TABLE_LAYOUT = Object.freeze({ textUnits, displayText, planTrafficTable, applyTablePlan });

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
   *   NAME_OF_CODE             代號 → 中文名稱（畫面提示用）
   *   VALID_COST_CENTER_CODES  「使用中」代碼集合（存檔驗證用）
   *   DEPT_OF_CODE             代號 → 所屬部門組織代碼陣列（掛帳單位限部內用；同代號多筆記錄各屬不同部門時全部保留）
   */
  const loadCostCenterMaps = () => {
    if (_costCenterLoadPromise) return _costCenterLoadPromise;

    _costCenterLoadPromise = (async () => {
      const CC = C.REF_FIELDS.COST_CENTER;
      const params = {
        app: COST_CENTER_APP_ID,
        fields: [CC.CODE, CC.NAME, CC.DEPT],
        query: `${CC.IN_USE} in ("使用中")`,
        size: 500,
      };

      const cursor = await kintone.api(kintone.api.url('/k/v1/records/cursor', true), 'POST', params);

      const nameMap = {};
      const deptMap = {};
      const deptNames = {};
      const validCodes = new Set(); // 原始大小寫，給存檔驗證用（和 submit 自己查時的比對方式一致）
      const nameConflicts = {};

      let hasNext = true;
      while (hasNext) {
        const resp = await kintone.api(kintone.api.url('/k/v1/records/cursor', true), 'GET', { id: cursor.id });
        resp.records.forEach((r) => {
          const rawCode = r[CC.CODE]?.value?.trim();
          if (!rawCode) return;
          validCodes.add(rawCode);
          const code = rawCode.toUpperCase();
          const name = r[CC.NAME]?.value?.trim();
          // 同代號可建多筆記錄、各屬不同部門（例如總公司代碼由好幾個部共用），所屬部門全部收進來
          (r[CC.DEPT]?.value || []).forEach((dept) => {
            if (!dept?.code) return;
            const depts = (deptMap[code] = deptMap[code] || []);
            if (!depts.includes(dept.code)) depts.push(dept.code);
            deptNames[dept.code] = dept.name || dept.code;
          });
          // 同代號可建多筆記錄：中文名稱保留第一筆非空值，值不同就點名代號提醒管理者
          if (name) {
            if (!nameMap[code]) nameMap[code] = name;
            else if (nameMap[code] !== name) (nameConflicts[code] = nameConflicts[code] || new Set()).add(name);
          }
        });
        hasNext = resp.next;
      }

      NAME_OF_CODE = nameMap;
      VALID_COST_CENTER_CODES = validCodes;
      DEPT_OF_CODE = deptMap;
      DEPT_NAMES = deptNames;

      console.log(`✅ 已載入 ${validCodes.size} 筆費用歸屬代碼`);

      Object.keys(nameConflicts).forEach((code) => {
        console.warn(`⚠️ [費用歸屬] 代號「${code}」在費用歸屬主檔的多筆記錄中有不同的名稱，已採用第一筆「${nameMap[code]}」；請回主檔統一`, [...nameConflicts[code]]);
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
    /** 代號（大寫）→ 所屬部門組織代碼陣列（呼叫前需先 await ensureLoaded()） */
    getDeptsOfCode: () => DEPT_OF_CODE,
    /** 所屬部門組織代碼 → 名稱 */
    getDeptNames: () => DEPT_NAMES,
  });

  /**
   * 當費用歸屬主檔載入完成後，自動更新當前畫面上所有費用歸屬欄位的中文提示
   */
  function refreshAllCostCenterHints() {
    try {
      const record = KT.record().get()?.record;
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
    // 申請人：只有管理員可改（費用所屬人、受款人開放所有人改，受款人可手 key）
    if (record[F.APPLICANT]) record[F.APPLICANT].disabled = !C.isAdmin();
    // 申請人部門、費用所屬人部門：一律鎖住（含管理員），只能依申請人／費用所屬人帶入
    //   （申請人部門帶入_20261022.js、signing_personnel_manager 的改費用所屬人流程）
    [F.APPLICANT_ORG, F.EXPENSE_OWNER_ORG].forEach((field) => {
      if (record[field]) record[field].disabled = true;
    });

    KT.record().setFieldShown(F.ACCOUNTING_STAFF, C.isAdmin());
    KT.record().setFieldShown(F.PERMISSION_STAFF, C.isAdmin());
    updateSpaceNotifications();
    loadCostCenterMaps().catch(() => {});

    // 換畫面：還沒執行的子表格欄寬處理一律作廢（見 layoutTrafficTable 上方說明）
    const seq = ++tableViewSeq;

    switch (event.type) {
      case 'app.record.print.show':
        layoutTrafficTable(record, seq);
        break;

      case 'app.record.create.show':
        resetAutoTableWidths();
        window.PR_COMPANY_NAME.apply(record);
        rebindCancelButton();
        break;

      case 'app.record.edit.show':
        resetAutoTableWidths();
        if (record[F.COMPANY_NAME]) record[F.COMPANY_NAME].disabled = true;
        break;

      case 'app.record.detail.show': {
        const status = record[F.STATUS_FIELD]?.value;
        if (status !== STATUS.REIMBURSEMENT_FILL && status !== STATUS.APPLY_START) {
          layoutTrafficTable(record, seq);
        }
        KT.record().setFieldShown(F.MANUAL_FLOW, record[F.MANUAL_FLOW]?.value?.length > 0);
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
  KT.on(['app.record.create.show', 'app.record.edit.show', 'app.record.detail.show', 'app.record.print.show'], (event) => {
    return handleMainShowEditEvents(event);
  });

  // 列表直接編輯：不會跑新增／編輯畫面的程式（部門帶入、簽核排人、存檔驗證、稅額重算），
  //   所以 C.INLINE_EDIT.EDITABLE 以外的欄位一律鎖住；EDITABLE 的欄位不動，交給帳號權限設定 App 的規則
  //   （帳號權限設定模組先載入、先套用，這裡最後執行，程式管的欄位以這裡為準）。
  //   手機版沒有列表直接編輯，PR_KT 會略過這個事件。
  const INLINE_INPUT_KINDS = new Set([
    'SINGLE_LINE_TEXT', 'MULTI_LINE_TEXT', 'RICH_TEXT', 'NUMBER', 'DATE', 'TIME', 'DATETIME', 'LINK',
    'DROP_DOWN', 'RADIO_BUTTON', 'CHECK_BOX', 'MULTI_SELECT', 'USER_SELECT', 'ORGANIZATION_SELECT', 'GROUP_SELECT',
  ]);
  const lockInlineEdit = (event) => {
    const editable = new Set(C.INLINE_EDIT.EDITABLE);
    Object.entries(event.record || {}).forEach(([code, field]) => {
      if (editable.has(code) || !field || !INLINE_INPUT_KINDS.has(field.type)) return;
      field.disabled = true;
    });
    return event;
  };
  KT.on('app.record.index.edit.show', lockInlineEdit);

  // -------------------------------------------------------------------------
  // 4.2 欄位變更事件 (.change)
  // -------------------------------------------------------------------------

  // 費用所屬人部門變更 → 重算公司名稱
  KT.on([`app.record.create.change.${F.EXPENSE_OWNER_ORG}`, `app.record.edit.change.${F.EXPENSE_OWNER_ORG}`], (event) => {
    window.PR_COMPANY_NAME.apply(event.record);
    return event;
  });

  // 費用歸屬變更 → 轉大寫、顯示中文名稱／代碼不存在提示
  //   會計單位一律依費用所屬人部門，由 signing_personnel_manager 查會計對應主檔帶入，這裡不動
  KT.on([`app.record.create.change.${TRAFFIC.COLS.EXPENSE}`, `app.record.edit.change.${TRAFFIC.COLS.EXPENSE}`], (event) => {
    loadCostCenterMaps().catch(() => {});
    try {
      const rows = event.record[TRAFFIC.CODE]?.value || [];

      clearCostFieldHints();
      rows.forEach((row) => {
        const cell = row?.value?.[TRAFFIC.COLS.EXPENSE];
        const costValue = cell?.value?.trim().toUpperCase();
        if (!costValue) return;
        cell.value = costValue;
        showCostCenterHint(costValue);
      });

      return event;
    } catch (error) {
      console.error('Error in cost allocation:', error);
      event.error = '費用歸屬處理發生錯誤';
      return event;
    }
  });
})();
