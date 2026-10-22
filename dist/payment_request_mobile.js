(function () {
  'use strict';

  // 手機版打包的第一個模組：告訴共用設定檔（payment_request_config.js）這是手機版，
  // PR_KT 會改註冊 mobile.* 事件、改用 kintone.mobile.app.record。必須排在 config 之前。
  window.PR_BUILD_TARGET = 'mobile';

  (() => {

    // =============================================================================
    // 交通費請款單（測試區 App 749）共用設定檔 —— 單一事實來源
    //
    // 【載入順序】此檔必須排在 kintone「JavaScript 自訂」清單的「最上面」，
    //   其餘檔案才能透過 window.PR_CONFIG 取用。
    // =============================================================================

    // ── 桌面版／手機版共用的 kintone 入口（window.PR_KT）────────────────────────
    //   手機版打包（src/mobile.js）在載入本檔前先設 window.PR_BUILD_TARGET = 'mobile'；桌面版不設。
    //   模組一律寫桌面版的事件名稱，API 走 PR_KT：
    //     PR_KT.on('app.record.create.show', fn) → 手機版改註冊 'mobile.app.record.create.show'；
    //       處理程式拿到的 event.type 仍是去掉「mobile.」的名稱，模組裡比對 event.type 不用分兩套。
    //       手機版沒有的事件（列印、列表直接編輯／刪除）略過不註冊。
    //     PR_KT.record()／PR_KT.app() → 手機版是 kintone.mobile.app.record／kintone.mobile.app。
    //   呼叫當下才取 kintone 物件（測試替身換掉 kintone 也照樣生效）。
    const IS_MOBILE = window.PR_BUILD_TARGET === 'mobile';
    const MOBILE_UNSUPPORTED_EVENT = /^app\.record\.(print\.show|index\.edit\.|index\.delete\.)/;

    /** 手機版：處理程式執行期間把 event.type 換成桌面版名稱，結束（含 Promise 結束）後換回來 */
    const withDesktopType = (handler) => (event) => {
      const mobileType = event.type;
      const restore = () => {
        event.type = mobileType;
      };
      event.type = String(mobileType).replace(/^mobile\./, '');
      let result;
      try {
        result = handler(event);
      } catch (err) {
        restore();
        throw err;
      }
      if (result && typeof result.then === 'function') {
        return result.then(
          (value) => {
            restore();
            return value;
          },
          (err) => {
            restore();
            throw err;
          },
        );
      }
      restore();
      return result;
    };

    const PR_KT = Object.freeze({
      IS_MOBILE,
      /** 註冊事件（寫桌面版名稱）；桌面版原封不動交給 kintone.events.on */
      on: (types, handler) => {
        const list = [].concat(types);
        if (!IS_MOBILE) return kintone.events.on(types, handler);
        const mobileTypes = list.filter((t) => !MOBILE_UNSUPPORTED_EVENT.test(t)).map((t) => `mobile.${t}`);
        if (mobileTypes.length === 0) return undefined;
        return kintone.events.on(mobileTypes, withDesktopType(handler));
      },
      /** kintone.app.record（手機版 kintone.mobile.app.record） */
      record: () => (IS_MOBILE ? kintone.mobile.app.record : kintone.app.record),
      /** kintone.app（手機版 kintone.mobile.app） */
      app: () => (IS_MOBILE ? kintone.mobile.app : kintone.app),
    });
    window.PR_KT = PR_KT;

    // ── App ID 對照 ─────────────────────────────────────────────────────────────
    const APPS = Object.freeze({
      PAYMENT: PR_KT.app().getId(), // 本 App（交通費請款單），動態取得
      COST_CENTER: 661, // 費用歸屬代碼（CostCenter）
      ACCOUNTING_MAP: 433, // 申請單位 → 會計單位／承辦人 對應
      APPROVAL_FLOW: 139, // 簽核流程主檔
      SAP_MAPPING: 623, // SAP 轉檔欄位對應
      PDF_FONT: 488, // PDF 產生用字型
      PERMISSION: 673, // 帳號權限設定（欄位顯隱／可編輯／必填規則）
      HOLIDAY_CALENDAR: 620, // 行事曆（國定假日、週末、補行上班日），預計付款日用
    });

    // ── 會計單位（kintone 群組）───────────────────────────────────────────────
    //   會計單位一律依費用所屬人部門查會計對應主檔（APPS.ACCOUNTING_MAP）帶入；
    //   這裡列出全部會計群組，給流程管理檢查（process_management）比對用。
    const ACCOUNTING = Object.freeze({
      MAP: Object.freeze({ TPE: 'ACC_TPE', TPE海運: 'ACC_TPE海運', CKS: 'ACC_CKS', KHH: 'ACC_KHH', TEPZ: 'ACC_TEPZ', NEXT: 'ACC_NEXT' }),
    });

    // ── 簽核人員程式（signing_personnel_manager）──────────────────────────────
    //   依「費用所屬人／費用所屬人部門」到簽核流程主檔（APPS.APPROVAL_FLOW）查主管。
    const SIGNING = Object.freeze({
      // 組織名稱的分隔字元。例：總務部-總務課
      ORG_NAME_SEPARATOR: '-',
      // 「所／中心」→ 上層「部」的對應，組出要去簽核流程主檔查的名稱。
      //   ⚠️ 不含「聯海通運股份有限公司 → 聯海」——那是簽核流程名稱的縮寫規則，
      //      不是組織隸屬關係，兩者語意不同不可混用。
      ORG_PARENT_MAP: Object.freeze({
        桃園機場營業所: '航空貨物部',
        新竹營業所: '航空貨物部',
        併裝中心: '事業本部',
      }),
    });

    // ── 預計付款日 ─────────────────────────────────────────────────────────────
    //   會計需要 LEAD_WORKDAYS 個工作日作業，之後的第一個付款日（每月 PAY_DAYS 與月底）付款，付款日遇假日往後順延。
    //   起算日＝請款日期（不含當天）。工作日依行事曆 App（APPS.HOLIDAY_CALENDAR）：
    //   有記錄就看「是否假日」（是＝放假、否＝補行上班），沒有記錄的日子才看星期（週六日放假）。
    //   存檔時由程式寫入、使用者不可改。
    const EXPECTED_PAY_DATE = Object.freeze({
      LEAD_WORKDAYS: 5,
      PAY_DAYS: Object.freeze([10, 20]), // 另加每月月底
      // 一次向行事曆查多少天（付款日最晚約落在起算日後 5 個工作日＋一個付款週期＋連假，60 天綽綽有餘）
      LOOKAHEAD_DAYS: 60,
      NOTE: '員工代墊款項支付日期為每月10、20、月底，遇假日順延',
    });

    // ── 對照主檔欄位代碼（別的 App 的欄位，與本表單 FIELDS 分開）─────────────
    const REF_FIELDS = Object.freeze({
      COST_CENTER: Object.freeze({
        CODE: 'CostCenter',
        NAME: '中文名稱',
        IN_USE: '使用狀況', // 值 '使用中'；query 篩選用
        // ORGANIZATION_SELECT（單選），值一律為「部」層級。掛帳單位限部內（COST_SCOPE）靠它判斷代碼屬於哪個部門
        DEPT: '所屬部門',
      }),
      ACCOUNTING_MAP: Object.freeze({
        APPLY_UNIT: '申請單位', // 查詢鍵
        ACCOUNTING_UNIT: '請款會計單位',
        ACCOUNTING_STAFF: '請款會計人員',
        PERMISSION_USER: '權限開放人員',
      }),
      // 行事曆（APPS.HOLIDAY_CALENDAR）：只記「不是一般平日」的日子——週末、國定假日、補假（是）與補行上班日（否）；
      //   一般平日沒有記錄。每週一定有週末記錄，所以超過 7 天沒有任何記錄＝那段還沒建檔。
      HOLIDAY_CALENDAR: Object.freeze({
        DATE: 'date',
        IS_HOLIDAY: 'isHoliday', // 文字欄，值 '是'／'否'
        HOLIDAY_VALUE: '是',
        WORKDAY_VALUE: '否', // 補行上班日
      }),
    });

    // ── 其他共用常數 ───────────────────────────────────────────────────────────
    const ADMIN_USERS = Object.freeze(['24136', '24136T', '24145', '24145T']);
    const SUPER_ADMIN = '24136'; // 唯一開發者本人；比 ADMIN_USERS 更窄的權限（僅限「JS 自定義設定」按鈕），刻意不與四人白名單混用
    const SEP = ' / '; // 發票號碼記錄的分隔字元
    const VOID_FIELD = '表單作廢'; // 欄位代碼（與 STATUS.VOID 字串相同但語意不同，見下）

    // ── 空白欄位 ID（kintone getSpaceElement 用）單一事實來源 ───────────────────
    const SPACES = Object.freeze({
      NOTI_1: 'Space_Noti_1',
      NOTI_2: 'Space_Noti_2',
      NOTI_3: 'Space_Noti_3',
      APPLY_BUTTON: 'apply_button', // 「同申請人」受款人按鈕
      EXPECTED_PAY_DATE_NOTE: 'Space_Expected_Pay_Date', // 預計付款日旁的說明文字
    });

    // ── 欄位代碼註冊表：邏輯名 → kintone 欄位代碼（單一事實來源）───────────────
    //   主表欄位平鋪；子表格用 { CODE, COLS } 巢狀。改欄位代碼時只改此處。
    const FIELDS = Object.freeze({
      APPLICANT: '申請人', // USER_SELECT；填單的人，預設登入者
      APPLICANT_ORG: '申請人部門', // ORGANIZATION_SELECT；標籤「申請部門」
      EXPENSE_OWNER: '費用所屬人', // USER_SELECT；簽核人員依此人排
      EXPENSE_OWNER_ORG: '費用所屬人部門', // ORGANIZATION_SELECT；簽核流程、會計單位、公司名稱依此部門
      PAYMENT_DATE: '請款日期',
      PAY_METHOD: '付款方式',
      PAYEE: '受款人',
      COMPANY_NAME: '公司名稱',
      ACCOUNTING_UNIT: '會計單位',
      ACCOUNTING_STAFF: '會計單位承辦人',
      INVOICE_AGG: '發票號碼記錄',
      VOUCHER_NO: '傳票編號', // 標籤「申請單號（Application Number）」
      VOUCHER_DATE: '傳票日期', // 標籤「過帳日期（Posting Date）」
      ATTACHMENT: '附件',
      PAPER_RECEIPT: '是否有紙本憑證',
      REASON: '理由', // 主表 MULTI_LINE_TEXT；標籤「理由（計程車）」
      RECORD_NO: '交通費請款單號', // RECORD_NUMBER；批次下載／PDF 產生時用來標示記錄
      DEV_ONLY_DATA: '帶入的資料_開發人員用', // 僅 ADMIN_USERS 可見的除錯用群組欄位
      SIGN_FLOW_GROUP: '簽核流程', // 簽核流程群組欄位
      MANUAL_FLOW: '手動設定簽核流程',
      PERMISSION_STAFF: '權限開放人員',
      EXPECTED_PAY_DATE: '預計付款日', // DATE；存檔時依請款日期與行事曆計算（EXPECTED_PAY_DATE）
      STATUS_FIELD: '狀態', // 流程狀態欄位代碼（與 STATUS.* 的「狀態值」不同）
      // 【刻意不收】表單作廢：既有 VOID_FIELD 已是該欄位代碼的單一事實來源

      TRAFFIC_TABLE: Object.freeze({
        CODE: '交通費請款單',
        COLS: Object.freeze({
          DATE: '憑證日期',
          VEHICLE: '交通工具',
          VISIT_CUSTOMER: '拜訪客戶',
          ROUTE: '起訖點',
          AMOUNT: '金額',
          EXPENSE: '費用歸屬',
          NOTE: '備註',
          RECEIPT_TYPE: '憑證種類',
          INVOICE_NO: '發票號碼', // 標籤「發票號碼／票號」
          SELLER_TAX_ID: '賣方統編',
          FORMAT: '格式',
          TAX: '稅額',
        }),
      }),
      SIGN_TABLE: Object.freeze({
        CODE: '簽核記錄',
        COLS: Object.freeze({
          DATETIME: '日期與時間',
          ACTION: '動作',
          SIGNER: '簽核人員',
        }),
      }),
    });

    // ── 交通費明細子表格的版面（詳細頁／列印頁的欄寬用，payment_request_main 的 layoutTrafficTable）────
    //   來源：kintone MCP 讀 749 表單 rev 1798（form_snapshots/749_rev1798_traffic_table.json，測試會比對）。
    //   COLUMNS 依畫面上的欄位順序；label＝表頭文字（用來找出畫面上是哪一欄），type／unit 決定顯示文字怎麼算。
    //   表單改了子表格欄位（順序、標籤、型別）→ 用 MCP 重讀、更新快照與這裡。
    const TRAFFIC_TABLE_LAYOUT = Object.freeze({
      COLUMNS: Object.freeze(
        [
          { code: FIELDS.TRAFFIC_TABLE.COLS.DATE, label: '憑證日期', type: 'DATE' },
          { code: FIELDS.TRAFFIC_TABLE.COLS.VEHICLE, label: '交通工具', type: 'DROP_DOWN' },
          { code: FIELDS.TRAFFIC_TABLE.COLS.RECEIPT_TYPE, label: '憑證種類', type: 'DROP_DOWN' },
          { code: FIELDS.TRAFFIC_TABLE.COLS.ROUTE, label: '起訖點', type: 'SINGLE_LINE_TEXT' },
          { code: FIELDS.TRAFFIC_TABLE.COLS.VISIT_CUSTOMER, label: '拜訪客戶（目的）', type: 'SINGLE_LINE_TEXT' },
          { code: FIELDS.TRAFFIC_TABLE.COLS.AMOUNT, label: '金額（含稅）', type: 'NUMBER', unit: '元' },
          { code: FIELDS.TRAFFIC_TABLE.COLS.EXPENSE, label: '費用歸屬', type: 'SINGLE_LINE_TEXT' },
          { code: FIELDS.TRAFFIC_TABLE.COLS.INVOICE_NO, label: '發票號碼／票號', type: 'SINGLE_LINE_TEXT' },
          { code: FIELDS.TRAFFIC_TABLE.COLS.SELLER_TAX_ID, label: '賣方統編', type: 'SINGLE_LINE_TEXT' },
          { code: FIELDS.TRAFFIC_TABLE.COLS.FORMAT, label: '格式', type: 'SINGLE_LINE_TEXT' },
          { code: FIELDS.TRAFFIC_TABLE.COLS.TAX, label: '稅額', type: 'NUMBER', unit: '元' },
          { code: FIELDS.TRAFFIC_TABLE.COLS.NOTE, label: '備註', type: 'SINGLE_LINE_TEXT' },
        ].map(Object.freeze),
      ),
      // 欄寬＝文字單位數（中文 2、英數 1）× PX_PER_UNIT ＋ PADDING_PX，限制在 MIN～MAX；表頭文字也算進去
      WIDTH: Object.freeze({ PX_PER_UNIT: 8, PADDING_PX: 32, MIN_PX: 64, MAX_PX: 320 }),
    });

    // ── 流程狀態字串註冊表（query 內拼字錯誤會「靜默查不到」，故一併收斂）──────
    //   注意：STATUS.VOID 是「流程狀態值」，VOID_FIELD 是「欄位代碼」，
    //   兩者字串相同（'表單作廢'）但語意不同，刻意分開兩個常數，不可互換使用。
    const STATUS = Object.freeze({
      VOID: '表單作廢',
      REIMBURSEMENT_FILL: '報銷人填單',
      APPLY_START: '申請開始',
    });

    // ── 流程動作名稱註冊表（kintone 流程管理「按鈕上的字」）──────────────────────
    //   注意：ACTIONS.* 是「動作名稱」，STATUS.* 是「狀態值」，兩者在 kintone 是不同東西——
    //   `/k/v1/record/status` API 吃的是動作名稱，不是目標狀態名稱。
    const ACTIONS = Object.freeze({
      VOID: '作廢',
      APPLY_START: '點擊流程開始',
    });

    // ── 建單後自動推進流程設定（流程自動推進_20260810.js 用）───────────────────
    //   【要改狀態／動作名稱改這裡】三個字串必須與 kintone 流程管理後台一字不差
    //   （含全形括號、底線、空白），任一不符：API 回 400、單子留在原狀態。
    const AUTO_ADVANCE = Object.freeze({
      ENABLED: true, // 總開關：設 false 即完全停用（事件仍註冊，但不打任何 API）
      FROM_STATUS: STATUS.REIMBURSEMENT_FILL, // ① 建單後的初始狀態（推進前）＝「報銷人填單」
      TO_STATUS: STATUS.APPLY_START, // ② 推進後應到達的狀態＝「申請開始」
      ACTION_NAME: ACTIONS.APPLY_START, // ③ 要執行的動作名稱（不是狀態，見 ACTIONS 註解）
      // 是否連同 assignee（作業者）一起送出。
      //   後台該動作的下一關若有「多位候選作業者」→ 必須送，否則 API 會要求指定作業者；
      //   若下一關是「自動指定／單一人選」→ 送了反而可能被判定為非法作業者而 400。
      SEND_ASSIGNEE: true,
      COMPENSATE_ON_DETAIL: true, // 建單後跳頁導致推進中斷時，於詳細頁自動補推一次
      CREATE_MAX_RETRIES: 2, // 建單當下的重試次數（頁面即將跳轉，不宜久候）
      COMPENSATE_MAX_RETRIES: 3, // 詳細頁補償的重試次數
      TIMEOUT_MS: 12000, // 單次 PUT 的逾時上限
      GUARD_PREFIX: 'pr_auto_advance_', // 防迴圈守衛的 sessionStorage key 前綴
    });

    // ── 欄位選項字串註冊表（Checkbox / Radio / Dropdown 選項值單一事實來源）──────
    const OPTIONS = Object.freeze({
      MANUAL_FLOW: Object.freeze({ ON: '手動設定簽核流程' }),
      // 子表格「交通工具」
      VEHICLE: Object.freeze({ HSR: '高鐵', TAXI: '計程車' }),
      // 子表格「憑證種類」
      RECEIPT_TYPE: Object.freeze({ HSR_TICKET: '高鐵票', INVOICE: '發票' }),
      // 主表「是否有紙本憑證」
      PAPER_RECEIPT: Object.freeze({ YES: '是' }),
    });

    // ── 共用工具 ───────────────────────────────────────────────────────────────

    const isAdmin = (code) => ADMIN_USERS.includes(code || kintone.getLoginUser().code);

    // ── 交通費明細規則（交通費明細規則_20261022.js 用）────────────────────────
    const TRAFFIC_RULES = Object.freeze({
      // 交通工具選高鐵 → 賣方統編、格式固定寫入
      HSR_SELLER_TAX_ID: '00000000',
      HSR_FORMAT: '22',
      // 金額含稅；稅額＝金額 ÷ (1＋稅率) × 稅率，四捨五入到個位數
      TAX_RATE_PERCENT: 5,
      // 這些憑證種類才開放填發票號碼（存檔時必填、不可重複）
      INVOICE_RECEIPT_TYPES: Object.freeze([OPTIONS.RECEIPT_TYPE.HSR_TICKET, OPTIONS.RECEIPT_TYPE.INVOICE]),
      // 有計程車時「理由」動態必填：畫面上找標籤文字以此開頭的欄位加紅色 *
      REASON_LABEL_PREFIX: '理由',
    });

    // ── 掛帳單位限部內（費用歸屬部門限制_20261022.js 用）──────────────────────
    //   費用歸屬代碼的「所屬部門」（REF_FIELDS.COST_CENTER.DEPT）必須是費用所屬人部門往上爬到的那個部。
    //   申請人在 EXEMPT_GROUP 群組內 → 不受限制，且新增時自動切成手動設定簽核流程（簽核人員自選）。
    const COST_SCOPE = Object.freeze({
      EXEMPT_GROUP: '費用歸屬不限部門', // kintone 群組（角色）；比對群組代碼或名稱
      ORG_TREE: Object.freeze({
        CACHE_KEY: 'pr749_org_parents_v1', // localStorage：組織代碼 → 上一層組織代碼
        CACHE_TTL_MS: 6 * 60 * 60 * 1000, // 6 小時過期重抓
        PAGE_SIZE: 100, // 組織 API 單次最多 100 筆
        MAX_PAGES: 20,
        MAX_DEPTH: 20, // 往上爬最多 20 層，防組織資料有迴圈
      }),
    });

    window.PR_CONFIG = Object.freeze({
      APPS,
      ACCOUNTING,
      SIGNING,
      EXPECTED_PAY_DATE,
      REF_FIELDS,
      ADMIN_USERS,
      SUPER_ADMIN,
      SEP,
      VOID_FIELD,
      SPACES,
      FIELDS,
      TRAFFIC_TABLE_LAYOUT,
      STATUS,
      ACTIONS,
      AUTO_ADVANCE,
      OPTIONS,
      TRAFFIC_RULES,
      COST_SCOPE,
      isAdmin,
    });
  })();

  (() => {

    // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
    const KT = window.PR_KT;

    // 按下儲存後，各模組要查好幾支 API（驗證、簽核人員、預計付款日…），畫面會靜止 1〜3 秒。
    // 這段期間顯示「儲存中，請稍候…」，避免使用者以為沒按到而重複按、或以為當掉。
    //
    // 何時關掉：
    //   - 存檔被擋下（event.error 有值）→ 最後一個存檔程式關掉
    //   - 其他程式跳出錯誤視窗 → SweetAlert 同一時間只有一個視窗，會直接取代本提示
    //   - 存檔成功 → 換到詳細頁時關掉（存檔成功後的回寫、流程推進期間都還顯示著）
    //   - 保險：超過 SAFETY_CLOSE_MS 還開著就自動關；使用者也可以按 Esc 或點外面關掉
    //     （萬一有程式讓 kintone 中途停止存檔、收尾程式沒被執行，畫面也不會被一直擋住；關掉提示不影響存檔本身）
    // 只關「自己開的」提示（用 POPUP_CLASS 辨識），不會誤關別的程式的視窗。

    const POPUP_CLASS = 'pr-saving-popup';
    const SAFETY_CLOSE_MS = 15000;
    const SUBMIT_EVENTS = ['app.record.create.submit', 'app.record.edit.submit'];
    const LEAVE_EVENTS = ['app.record.detail.show', 'app.record.create.show', 'app.record.edit.show', 'app.record.index.show'];

    let safetyTimer = null;

    const getSwal = () => (typeof window.Swal?.fire === 'function' ? window.Swal : null);

    const isOurPopupOpen = () => {
      const swal = getSwal();
      return !!swal?.isVisible?.() && !!swal.getPopup?.()?.classList.contains(POPUP_CLASS);
    };

    const closeSaving = () => {
      if (safetyTimer) {
        clearTimeout(safetyTimer);
        safetyTimer = null;
      }
      if (isOurPopupOpen()) getSwal().close();
    };

    const openSaving = () => {
      const swal = getSwal();
      if (!swal) return;
      swal.fire({
        title: '儲存中，請稍候…',
        text: '正在檢查資料與簽核流程，完成後會自動跳轉',
        allowOutsideClick: true,
        allowEscapeKey: true,
        showConfirmButton: false,
        customClass: { popup: POPUP_CLASS },
        didOpen: () => swal.showLoading(),
      });
      if (safetyTimer) clearTimeout(safetyTimer);
      safetyTimer = setTimeout(closeSaving, SAFETY_CLOSE_MS);
    };

    // 第一個存檔程式：本檔在 src/index.js 排在共用設定檔之後、其他模組之前，所以最先執行
    const onSubmitStart = (event) => {
      openSaving();
      return event;
    };

    // 最後一個存檔程式：存檔被擋下時關掉提示（kintone 會在畫面上方顯示 event.error）
    const onSubmitEnd = (event) => {
      if (event.error) closeSaving();
      return event;
    };

    const onLeave = (event) => {
      closeSaving();
      return event;
    };

    KT.on(SUBMIT_EVENTS, onSubmitStart);
    KT.on(LEAVE_EVENTS, onLeave);
    // kintone 依註冊順序執行同一個事件的處理程式。所有模組都在載入時同步註冊，
    // 所以延到下一輪再註冊，這個處理程式就會排在所有存檔程式的最後面。
    setTimeout(() => KT.on(SUBMIT_EVENTS, onSubmitEnd), 0);

    window.PR_SAVING_HINT = Object.freeze({ onSubmitStart, onSubmitEnd, onLeave, closeSaving, POPUP_CLASS, SAFETY_CLOSE_MS });
  })();

  (function () {

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
      // 申請人、受款人：只有管理員可改（費用所屬人開放所有人改）
      [F.APPLICANT, F.PAYEE].forEach((field) => {
        if (record[field]) record[field].disabled = !C.isAdmin();
      });
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

  (function () {

    // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
    const KT = window.PR_KT;

    // =========================================================================
    // SECTION 1: 頂層常數與設定 (Config & Constants)
    // =========================================================================

    const CURRENT_YEAR = new Date().getFullYear();

    // PR_CONFIG 全域物件別名
    const C = window.PR_CONFIG;
    const F = window.PR_CONFIG.FIELDS;
    const REF_CC = C.REF_FIELDS.COST_CENTER; // 費用歸屬主檔自己的欄位代碼
    const APPS = window.PR_CONFIG.APPS;
    const STATUS = window.PR_CONFIG.STATUS;

    const TRAFFIC = F.TRAFFIC_TABLE;

    // 關聯 App 配置
    const COST_CENTER_APP_ID = APPS.COST_CENTER;

    // =========================================================================
    // SECTION 2: API 存取與資料輔助函數 (API & Helper Functions)
    // =========================================================================

    /**
     * 發票號碼重複檢查的 REST 存取統一入口
     */
    const invoiceCheckApi = (path, method, body, appId) => {
      if (window.NXSdaApi && typeof window.NXSdaApi.call === 'function') {
        return window.NXSdaApi.call(path, method, body, appId);
      }
      return kintone.api(kintone.api.url(path, true), method, body);
    };

    /**
     * 從費用歸屬主檔動態取得「使用中」的費用歸屬代碼集合
     * @returns {Promise<Set<string>>}
     */
    const fetchValidCostCenters = async () => {
      const validSet = new Set();
      const params = {
        app: COST_CENTER_APP_ID,
        fields: [REF_CC.CODE],
        query: `${REF_CC.IN_USE} in ("使用中")`,
        size: 500,
      };

      const cursor = await kintone.api(kintone.api.url('/k/v1/records/cursor', true), 'POST', params);

      let hasNext = true;
      while (hasNext) {
        const resp = await kintone.api(kintone.api.url('/k/v1/records/cursor', true), 'GET', { id: cursor.id });
        resp.records.forEach((r) => {
          const code = r[REF_CC.CODE]?.value?.trim();
          if (code) validSet.add(code);
        });
        hasNext = resp.next;
      }

      return validSet;
    };

    /**
     * 取「使用中」的費用歸屬代碼。
     * 主程式開畫面時已經載入同一份主檔，優先共用它的快取（存檔時少兩次 API 往返）；
     * 主程式沒載入時才自己查。
     * @returns {Promise<Set<string>>}
     */
    const getValidCostCenters = async () => {
      const shared = window.PR_COST_CENTER;
      if (typeof shared?.ensureLoaded === 'function' && typeof shared.getValidCodes === 'function') {
        await shared.ensureLoaded();
        return shared.getValidCodes();
      }
      return fetchValidCostCenters();
    };

    // 發票重複查詢一次最多取回的對方單數
    const INVOICE_DUP_LIMIT = 100;

    const escKintoneStr = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    /**
     * 發票號碼重複檢查。回傳要顯示給使用者的錯誤訊息陣列。
     * 查本 App「發票號碼記錄」欄位（每張發票以分隔字元包住存放），排除已作廢的單與自己。
     * @param {Object} record
     * @returns {Promise<string[]>}
     */
    const checkInvoiceDuplicate = async (record) => {
      const SEP = C.SEP;
      const APP_ID = APPS.PAYMENT;

      // 發票號碼記錄的格式是「 / A / B / 」（頭尾也有分隔字元），不能先 trim 再切，否則頭尾的 / 會黏在發票號碼上
      const agg = record[F.INVOICE_AGG]?.value || '';
      if (!agg.trim()) return [];

      const invoices = agg
        .split(SEP)
        .map((s) => s.trim())
        .filter(Boolean);
      const invoiceOr = invoices.map((v) => `${F.INVOICE_AGG} like "${escKintoneStr(`${SEP}${v}${SEP}`)}"`).join(' or ');

      const thisId = record.$id?.value;
      const excludeSelf = thisId ? ` and $id != ${thisId}` : '';

      // 一併取回對方的單號與發票號碼記錄，才能告訴使用者是哪幾個號碼、撞到哪幾張單
      const query = `${F.STATUS_FIELD} not in ("${STATUS.VOID}") and (${invoiceOr})${excludeSelf} limit ${INVOICE_DUP_LIMIT}`;

      const resp = await invoiceCheckApi(
        '/k/v1/records.json',
        'GET',
        { app: APP_ID, query, fields: ['$id', F.RECORD_NO, F.INVOICE_AGG] },
        APP_ID,
      );
      const hits = resp.records || [];
      if (hits.length === 0) return [];

      // 比對本單每個號碼出現在對方哪幾張單（同一號碼撞到多張單，單號用「、」併在同一個標籤）
      const lines = [];
      invoices.forEach((no) => {
        const nos = [];
        hits.forEach((r) => {
          const theirs = (r[F.INVOICE_AGG]?.value || '').split(SEP).map((x) => x.trim());
          const recNo = r[F.RECORD_NO]?.value;
          if (theirs.includes(no) && recNo && !nos.includes(recNo)) nos.push(recNo);
        });
        if (nos.length > 0) lines.push(`▸${no}（${F.RECORD_NO} ${nos.join('、')}）`);
      });

      // 比對不出明細（例如對方欄位讀不到）就退回原本那句話
      if (lines.length === 0) return ['發票號碼重複：已存在相同發票號碼，請更換後再儲存。'];
      return [`發票號碼重複：以下發票號碼已在其他單據出現，請更換後再儲存。\n${lines.join('\n')}`];
    };

    /**
     * 驗證費用歸屬代碼是否有效
     */
    const isValidCode = (code, validSet) => {
      if (!validSet || validSet.size === 0) {
        return false;
      }
      return validSet.has(code);
    };

    // =========================================================================
    // SECTION 3: 核心表單驗證邏輯 (Business Logic & Validation Rules)
    // =========================================================================

    /**
     * 驗證表單必填欄位
     * @param {Object} record
     * @param {Set<string>|null} validCostCenterSet 「使用中」費用歸屬代碼；null＝取不到主檔，只檢查有沒有填、不檢查存不存在
     * @returns {string[]}
     */
    const validateForm = (record, validCostCenterSet) => {
      const errors = [];

      const companyName = record[F.COMPANY_NAME]?.value || '';
      const paymentWay = record[F.PAY_METHOD]?.value || [];

      if (companyName.length === 0) {
        errors.push('需填寫公司名稱欄位');
      }
      if (paymentWay.length === 0) {
        errors.push('需選擇一種付款方式');
      }
      if (paymentWay.length > 1) {
        errors.push('限選一種付款方式');
      }

      const tableData = record[TRAFFIC.CODE];

      if (!tableData || !tableData.value) {
        console.error(`❌ 表格 ${TRAFFIC.CODE} 不存在或沒有 value 屬性`);
        errors.push(`找不到 ${TRAFFIC.CODE} 表格資料`);
      } else {
        const rows = tableData.value;

        if (!Array.isArray(rows)) {
          console.error(`❌ ${TRAFFIC.CODE} 的 value 不是陣列格式`);
          errors.push(`${TRAFFIC.CODE} 資料格式不正確`);
        } else {
          try {
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.value) continue;

              const costValue = row.value[TRAFFIC.COLS.EXPENSE]?.value;

              if (!costValue || costValue.trim() === '') {
                errors.push(`第 ${i + 1} 行請確實填寫費用歸屬`);
                continue;
              }

              const trimmedCode = costValue.trim();

              if (validCostCenterSet && !isValidCode(trimmedCode, validCostCenterSet)) {
                errors.push(`第 ${i + 1} 行的 ${trimmedCode} 不屬於${CURRENT_YEAR}年最新分攤表，請重新填寫`);
              }
            }
          } catch (costCheckError) {
            console.error('❌ 檢查費用歸屬代碼時發生問題:', costCheckError);
            errors.push('檢查費用歸屬代碼時發生問題');
          }
        }
      }

      return errors;
    };

    // =========================================================================
    // SECTION 4: Kintone 事件監聽註冊 (Submit Event Handlers)
    // =========================================================================

    // ── 驗證失敗視窗（字放大、逐條編號、每條一張卡片，年長同仁也看得清楚）──
    //   樣式在 payment_request.css（.pr-validation-*、.pr-v-*）（不經過打包，直接上傳）

    const escapeValidationText = (text) =>
      String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

    /**
     * 一行錯誤文字的重點標示（先跳脫再加標籤）：
     *   **重點** → 黃底紅字；「欄位名」→ 藍色粗體；第 N 行 → 深色小標籤，一眼看出是哪一列。
     * 舊的錯誤訊息沒有 ** 也會自動標出「」與第 N 行。
     */
    const formatValidationInline = (text) =>
      escapeValidationText(text)
        .replace(/\*\*(.+?)\*\*/g, '<mark class="pr-hl">$1</mark>')
        .replace(/「(.+?)」/g, '<b class="pr-field">「$1」</b>')
        .replace(/第 ?(\d+) ?行/g, '<span class="pr-row">第 $1 行</span>');

    // 「AJM1（物流部）」→ 代號大字、括號內小字；不是這種格式就整段當代號
    const formatValidationChip = (text) => {
      const m = /^(.+?)（(.+)）$/.exec(text);
      if (!m) return `<span class="pr-v-chip"><span class="pr-v-chip-code">${escapeValidationText(text)}</span></span>`;
      return `<span class="pr-v-chip"><span class="pr-v-chip-code">${escapeValidationText(m[1])}</span><span class="pr-v-chip-note">${escapeValidationText(m[2])}</span></span>`;
    };

    /**
     * 一條錯誤的內容。錯誤文字可以分行（\n）：
     *   第一行＝結論（大字粗體）；「▸」開頭＝有問題的項目，排成一排紅框標籤；「※」開頭＝怎麼辦（底部提示）；其餘＝說明（灰色小字）。
     * @param {string} err
     * @returns {string} HTML
     */
    const renderValidationError = (err) => {
      const [head, ...rest] = String(err ?? '').split('\n');
      const parts = [`<div class="pr-v-head">${formatValidationInline(head)}</div>`];
      let chips = [];
      const flushChips = () => {
        if (chips.length > 0) parts.push(`<div class="pr-v-chips">${chips.join('')}</div>`);
        chips = [];
      };
      rest.forEach((line) => {
        const t = line.trim();
        if (t.startsWith('▸')) {
          chips.push(formatValidationChip(t.slice(1).trim()));
          return;
        }
        flushChips();
        if (t.startsWith('※')) parts.push(`<div class="pr-v-hint"><span class="pr-v-hint-tag">提示</span>${formatValidationInline(t.slice(1).trim())}</div>`);
        else if (t) parts.push(`<div class="pr-v-detail">${formatValidationInline(t)}</div>`);
      });
      flushChips();
      return parts.join('');
    };

    /**
     * 組驗證失敗視窗的內容：每條錯誤一張卡片、前面有編號，內容依 renderValidationError 標出重點。
     * @param {string[]} errors
     * @returns {string} HTML
     */
    const buildValidationHtml = (errors) => {
      const items = errors
        .map(
          (err, i) =>
            `<li class="pr-validation-item"><span class="pr-validation-no">${i + 1}</span><div class="pr-validation-text">${renderValidationError(err)}</div></li>`,
        )
        .join('');
      return `<p class="pr-validation-lead">請修正以下 ${errors.length} 個問題後，再按一次儲存：</p><ol class="pr-validation-list">${items}</ol>`;
    };

    const showValidationErrors = (title, errors) => {
      Swal.fire({
        icon: 'error',
        title,
        html: buildValidationHtml(errors),
        confirmButtonText: '我知道了',
        confirmButtonColor: '#d33',
        customClass: { popup: 'pr-validation-popup' },
      });
    };

    KT.on(['app.record.create.submit', 'app.record.edit.submit'], async (event) => {
      if (event.record[C.VOID_FIELD]?.value?.length > 0) {
        return event;
      }

      try {
        const record = event.record;
        const allErrors = [];

        // 交通費明細：重算稅額、高鐵固定值、發票號碼記錄（發票重複檢查要讀整理後的記錄欄位，所以排最前）
        const trafficRules = window.PR_TRAFFIC_RULES;
        if (trafficRules) trafficRules.normalize(record);

        // 需要查 API 的檢查互不相依，一次同時送出，縮短按下儲存後的等待
        const costCentersTask = getValidCostCenters()
          .then((set) => ({ set }))
          .catch((loadErr) => {
            console.error('❌ 載入費用歸屬代碼失敗:', loadErr);
            return { set: null, error: '無法取得最新費用歸屬代碼，請稍後再試或聯絡系統管理員' };
          });
        const invoiceTask = checkInvoiceDuplicate(record).catch((e) => {
          console.error('發票號碼檢查失敗:', e);
          return ['發票號碼檢查失敗：請稍後再試或聯絡系統管理員'];
        });
        const scope = window.PR_COST_SCOPE;
        const scopeTask = scope
          ? scope.validate(record).catch((e) => {
              console.error('掛帳單位檢查失敗:', e);
              return ['掛帳單位檢查失敗：請稍後再試或聯絡系統管理員'];
            })
          : Promise.resolve([]);
        const [costCenters, invoiceErrors, scopeErrors] = await Promise.all([costCentersTask, invoiceTask, scopeTask]);

        if (costCenters.error) allErrors.push(costCenters.error);
        else console.log(`✅ 已載入 ${costCenters.set.size} 筆合法費用歸屬代碼`);

        // 1. 表單基本驗證
        allErrors.push(...validateForm(record, costCenters.set));

        // 2. 交通費明細（發票號碼必填／本單重複、計程車的紙本憑證與理由）
        if (trafficRules) allErrors.push(...trafficRules.validate(record));

        // 3. 發票號碼跨單重複（上面已同時查好）
        allErrors.push(...invoiceErrors);

        // 4. 掛帳單位限費用所屬人部內、不可跨部門（排除群組的申請人不檢查）
        allErrors.push(...scopeErrors);

        if (allErrors.length > 0) {
          event.error = '儲存失敗';
          showValidationErrors('表單驗證失敗', allErrors);
        }
        return event;
      } catch (generalError) {
        console.error('Submit 事件發生未預期錯誤:', generalError);
        event.error = '處理過程中發生錯誤，請稍後再試一次';
        Swal.fire({
          icon: 'error',
          title: '系統錯誤',
          text: '處理過程中發生錯誤，請稍後再試',
          confirmButtonText: '確定',
        });
        return event;
      }
    });
  })();

  (() => {

    // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
    const KT = window.PR_KT;

    // =============================================================================
    // 掛帳單位（費用歸屬）限費用所屬人部內
    //
    //   (1) 每一列費用歸屬代碼的「所屬部門」（費用歸屬主檔 REF_FIELDS.COST_CENTER.DEPT）
    //       必須包含費用所屬人部門沿組織樹往上爬到的那個部。
    //       同一代碼可在主檔建多筆、各屬不同部門（例如總公司代碼由好幾個部共用）→ 任一個部符合就算部內
    //   (2) 不能跨部門：所有列的代碼要有共同的部
    //   (3) 申請人在 COST_SCOPE.EXEMPT_GROUP 群組內 → 不受 (1)(2) 限制
    //   (4) 同上的人新增單時，自動切成「手動設定簽核流程」，簽核人員自選（signing_personnel_manager 接手）
    //
    //   create.show／edit.show 時先查申請人在不在排除群組，結果存在模組變數（isExempt() 直接讀）；
    //   存檔驗證由 payment_request_submit 呼叫 validate()，錯誤一起顯示。
    // =============================================================================

    const C = window.PR_CONFIG;
    const F = C.FIELDS;
    const SCOPE = C.COST_SCOPE;
    const TREE = SCOPE.ORG_TREE;
    const TRAFFIC = F.TRAFFIC_TABLE;

    // ── 申請人是否在排除群組 ─────────────────────────────────────────────────

    // 目前畫面上申請人的判斷結果：{ code, exempt }；切換申請人或換頁就重查
    let exemptState = null;
    let exemptPromise = null;

    const applicantCodeOf = (record) => record?.[F.APPLICANT]?.value?.[0]?.code || kintone.getLoginUser().code;

    /** 群組清單裡有沒有排除群組（代碼或名稱相同都算） */
    const inExemptGroup = (groups) => (groups || []).some((g) => g.code === SCOPE.EXEMPT_GROUP || g.name === SCOPE.EXEMPT_GROUP);

    /**
     * 查使用者是否在排除群組，結果存起來。查不到（API 失敗）當作「不在」——寧可多擋，不可漏擋。
     * @param {string} userCode
     * @returns {Promise<boolean>}
     */
    const ensureExempt = (userCode) => {
      if (exemptState && exemptState.code === userCode) return Promise.resolve(exemptState.exempt);
      if (exemptPromise && exemptPromise.code === userCode) return exemptPromise.promise;
      const promise = kintone
        .api(kintone.api.url('/v1/user/groups.json', true), 'GET', { code: userCode })
        .then((resp) => inExemptGroup(resp.groups))
        .catch((err) => {
          console.error('[費用歸屬部門限制] 查詢群組失敗，當作不在排除名單:', err);
          return false;
        })
        .then((exempt) => {
          exemptState = { code: userCode, exempt };
          exemptPromise = null;
          return exempt;
        });
      exemptPromise = { code: userCode, promise };
      return promise;
    };

    /** 目前申請人是否在排除群組（create.show／edit.show 算好的結果；還沒算好回 false） */
    const isExempt = () => Boolean(exemptState?.exempt);

    // ── 組織樹：組織代碼 → 上一層組織代碼 ────────────────────────────────────

    let orgParentsMemory = null;
    let orgParentsPromise = null;

    const readCache = () => {
      try {
        const raw = localStorage.getItem(TREE.CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed.ts || Date.now() - parsed.ts > TREE.CACHE_TTL_MS) return null;
        return parsed.data;
      } catch (e) {
        return null; // localStorage 不能用（隱私模式等）就當沒有快取
      }
    };

    const writeCache = (data) => {
      try {
        localStorage.setItem(TREE.CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
      } catch (e) {
        // 存不進去只是下次要重抓
      }
    };

    /**
     * 全公司組織表。先看記憶體、再看 localStorage，都沒有才分頁呼叫組織 API。
     * @returns {Promise<Object<string,string|null>>}
     */
    const loadOrgParents = () => {
      if (orgParentsMemory) return Promise.resolve(orgParentsMemory);
      const cached = readCache();
      if (cached) {
        orgParentsMemory = cached;
        return Promise.resolve(cached);
      }
      if (!orgParentsPromise) {
        orgParentsPromise = (async () => {
          const parentOf = {};
          for (let page = 0; page < TREE.MAX_PAGES; page++) {
            const resp = await kintone.api(kintone.api.url('/v1/organizations.json', true), 'GET', { size: TREE.PAGE_SIZE, offset: page * TREE.PAGE_SIZE });
            const orgs = resp.organizations || [];
            orgs.forEach((org) => {
              parentOf[org.code] = org.parentCode || null;
            });
            if (orgs.length < TREE.PAGE_SIZE) break;
          }
          orgParentsMemory = parentOf;
          writeCache(parentOf);
          return parentOf;
        })().finally(() => {
          orgParentsPromise = null;
        });
      }
      return orgParentsPromise;
    };

    /**
     * 沿組織樹往上爬，爬到的第一個「費用歸屬主檔裡出現過的所屬部門」就是答案（含自己）。
     * 爬到頂都沒有（例如該部門沒有自己的費用歸屬代碼）就回組織自己的代碼。
     * @param {string} orgCode
     * @param {Object<string,string|null>} parentOf
     * @param {Set<string>} deptSet
     * @returns {string}
     */
    const resolveDeptOfOrg = (orgCode, parentOf, deptSet) => {
      let current = orgCode;
      for (let depth = 0; depth < TREE.MAX_DEPTH && current; depth++) {
        if (deptSet.has(current)) return current;
        current = parentOf[current] || null;
      }
      return orgCode;
    };

    /**
     * 判斷規則（純函式）。
     * @param {Object} p
     * @param {string[]} p.codes 每一列的費用歸屬代碼（依列順序；空白的列給空字串）
     * @param {Object<string,string[]>} p.deptsOfCode 代號（大寫）→ 所屬部門組織代碼陣列（同代號可屬多個部門）
     * @param {string} p.ownerDept 費用所屬人部門往上爬到的部（組織代碼）
     * @param {Object<string,string>} [p.orgNames] 組織代碼 → 名稱（訊息用）
     * @returns {string[]} 錯誤訊息
     */
    const checkScope = ({ codes, deptsOfCode, ownerDept, orgNames = {} }) => {
      const errors = [];
      const nameOf = (code) => orgNames[code] || code;
      const deptsOf = (code) => deptsOfCode[code] || [];
      const filled = codes.map((code, i) => ({ code: String(code || '').trim().toUpperCase(), line: i + 1 })).filter((x) => x.code);

      const missing = filled.filter((x) => deptsOf(x.code).length === 0);
      if (missing.length > 0) {
        errors.push(`以下費用歸屬在主檔沒有設定所屬部門，無法判斷是否為部內掛帳\n${[...new Set(missing.map((x) => `▸${x.code}`))].join('\n')}\n※ 請聯絡管理員補齊費用歸屬主檔的「所屬部門」`);
      }

      // 跨部門：所有列的代碼找不到一個共同的部（共用代碼屬於好幾個部，只要有交集就不算跨部門）
      const resolved = filled.filter((x) => deptsOf(x.code).length > 0);
      const common = resolved.reduce((acc, x) => acc.filter((d) => deptsOf(x.code).includes(d)), resolved.length > 0 ? deptsOf(resolved[0].code) : []);
      if (resolved.length > 1 && common.length === 0) {
        const depts = [...new Set(resolved.flatMap((x) => deptsOf(x.code)))];
        errors.push(`掛帳單位**不能跨部門**：本單的費用歸屬分屬 ${depts.map(nameOf).join('、')}`);
      }

      const foreign = resolved.filter((x) => !deptsOf(x.code).includes(ownerDept));
      if (foreign.length > 0) {
        errors.push(
          `掛帳單位**只能是費用所屬人的部內**（${nameOf(ownerDept)}）\n${foreign.map((x) => `▸第 ${x.line} 行 ${x.code}（${deptsOf(x.code).map(nameOf).join('、')}）`).join('\n')}\n※ 請改填部內的費用歸屬，或改選費用所屬人`,
        );
      }
      return errors;
    };

    /**
     * 存檔驗證。排除群組內的申請人直接通過；費用所屬人部門沒填也略過（簽核排不出來，另有必填擋）。
     * @param {Object} record
     * @returns {Promise<string[]>}
     */
    const validate = async (record) => {
      const exempt = await ensureExempt(applicantCodeOf(record));
      if (exempt) return [];

      const ownerOrg = record[F.EXPENSE_OWNER_ORG]?.value?.[0];
      if (!ownerOrg?.code) return [];

      const rows = record[TRAFFIC.CODE]?.value || [];
      const codes = rows.map((row) => row?.value?.[TRAFFIC.COLS.EXPENSE]?.value || '');
      if (!codes.some((c) => String(c).trim())) return [];

      const cc = window.PR_COST_CENTER;
      let deptsOfCode;
      let parentOf;
      try {
        await cc.ensureLoaded();
        deptsOfCode = cc.getDeptsOfCode();
        parentOf = await loadOrgParents();
      } catch (err) {
        console.error('[費用歸屬部門限制] 載入主檔或組織資料失敗:', err);
        return ['無法取得費用歸屬主檔或組織資料，無法檢查掛帳單位，請稍後再試或聯絡系統管理員'];
      }

      // 主檔裡沒有（或不是使用中）的代碼，payment_request_submit 已經會報錯，這裡略過不重複報
      const known = new Set([...(cc.getValidCodes() || [])].map((c) => String(c).trim().toUpperCase()));
      const knownCodes = codes.map((c) => (known.has(String(c).trim().toUpperCase()) ? c : ''));

      const ownerDept = resolveDeptOfOrg(ownerOrg.code, parentOf, new Set(Object.values(deptsOfCode).flat()));
      return checkScope({ codes: knownCodes, deptsOfCode, ownerDept, orgNames: { ...(cc.getDeptNames?.() || {}), [ownerOrg.code]: ownerOrg.name } });
    };

    // ── 事件 ───────────────────────────────────────────────────────────────

    // 開畫面就先算好申請人是否在排除群組（存檔時直接用），組織樹也先在背景抓
    KT.on(['app.record.create.show', 'app.record.edit.show'], (event) => {
      ensureExempt(applicantCodeOf(event.record));
      loadOrgParents().catch((err) => console.warn('[費用歸屬部門限制] 預先載入組織樹失敗，存檔時再試:', err));
      return event;
    });

    // 申請人改了（只有管理員能改）→ 重查
    KT.on([`app.record.create.change.${F.APPLICANT}`, `app.record.edit.change.${F.APPLICANT}`], (event) => {
      ensureExempt(applicantCodeOf(event.record));
      return event;
    });

    window.PR_COST_SCOPE = Object.freeze({
      ensureExempt,
      isExempt,
      applicantCodeOf,
      inExemptGroup,
      resolveDeptOfOrg,
      checkScope,
      validate,
      loadOrgParents,
      /** 測試用：清掉記憶體裡的快取，模擬重新開頁 */
      _reset: () => {
        exemptState = null;
        exemptPromise = null;
        orgParentsMemory = null;
        orgParentsPromise = null;
      },
    });
  })();

  (function () {

    // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
    const KT = window.PR_KT;

    // =============================================================================
    // 簽核人員自動帶入
    //
    //   依「費用所屬人／費用所屬人部門」到簽核流程主檔（APPS.APPROVAL_FLOW）查主管，
    //   把有值的欄位全部排進來（單位主管1〜3 → 單位次長 → 單位次長1 → 單位部長_支店長），
    //   再依費用所屬人在該部門的職稱，清掉他自己那一層與以下。
    //   同時依費用所屬人部門到會計對應主檔（APPS.ACCOUNTING_MAP）帶入會計單位與承辦人。
    //
    //   事件：
    //     - 費用所屬人部門變更（新增畫面開啟時也跑一次）→ 重排簽核人員
    //     - 費用所屬人變更 → 查他的所屬單位、帶入費用所屬人部門，再重排
    //     - 勾選「手動設定簽核流程」→ 由使用者自己填人數與人員，存檔時驗證
    // =============================================================================

    // =========================
    // 常數定義區塊
    // =========================

    // PR_CONFIG 全域物件別名
    const C = window.PR_CONFIG;
    const F = window.PR_CONFIG.FIELDS;
    const APPS = window.PR_CONFIG.APPS;
    const OPT = window.PR_CONFIG.OPTIONS;

    // 簽核欄位設定 - 可依需求調整使用哪些欄位
    const APPROVAL_FIELDS = {
      單位主管1: { enabled: true },
      單位主管2: { enabled: true },
      單位主管3: { enabled: true },
      單位次長: { enabled: true },
      單位次長1: { enabled: true },
      單位部長_支店長: { enabled: true },
      事業本部長: { enabled: false },
      總務部長: { enabled: false },
      總經理: { enabled: false },
    };

    // 取得啟用的欄位名稱陣列
    const getEnabledFields = () => {
      return Object.keys(APPROVAL_FIELDS).filter((field) => APPROVAL_FIELDS[field].enabled);
    };

    // 簽核人數欄位（只有簽核流程用，不在請款單主表 FIELDS 範圍）
    const COUNT_FIELDS = { manager: '部門主管簽核人數', deputy: '部門次長簽核人數' };

    // 簽核相關欄位
    const MANAGER_FIELDS = ['單位主管1', '單位主管2', '單位主管3'].filter((field) => APPROVAL_FIELDS[field]?.enabled);
    const DEPUTY_FIELDS = ['單位次長', '單位次長1'].filter((field) => APPROVAL_FIELDS[field]?.enabled);

    const SIGNING_FIELDS_TO_HIDE = [...getEnabledFields(), COUNT_FIELDS.manager, COUNT_FIELDS.deputy];

    // 特殊部門（六大簽核流程）
    const SPECIAL_DEPARTMENTS = [
      '總務部',
      '高雄營業部',
      '台中營業部',
      '航空貨物部',
      '桃園機場營業所',
      '新竹營業所',
      '海運貨物部',
      '物流部',
      '物流部-桃園NEXT1倉庫',
    ];

    // 需要檢查部長的部門
    const DIRECTOR_CHECK_DEPARTMENTS = ['汽車貨運部', '營業戰略部', '事業本部'];

    // 簽核流程主檔（APPS.APPROVAL_FLOW）的欄位 ↔ 請款單上的簽核欄位
    const MANAGER_FIELDS_MAPPING = [
      { apiField: '請購單位主管1', displayField: '單位主管1' },
      { apiField: '請購單位主管2', displayField: '單位主管2' },
      { apiField: '請購單位主管3', displayField: '單位主管3' },
      { apiField: '請購單位次長', displayField: '單位次長' },
      { apiField: '請購單位次長1', displayField: '單位次長1' },
      { apiField: '請購單位部長', displayField: '單位部長_支店長' },
    ].filter((item) => APPROVAL_FIELDS[item.displayField]?.enabled);

    // 特殊部門只需要部長欄位
    const MANAGER_FIELDS_SPECIAL = [{ apiField: '請購單位部長', displayField: '單位部長_支店長' }].filter(
      (item) => APPROVAL_FIELDS[item.displayField]?.enabled,
    );

    // API 路徑
    const USER_API = '/v1/user/organizations.json';

    // 會計對應主檔（APPS.ACCOUNTING_MAP）自己的欄位代碼；其中 PERMISSION_USER 與請款單主表的
    // FIELDS.PERMISSION_STAFF 字串相同但分屬不同 App，讀主檔走 ACC、寫請款單走 F，不可代用。
    const ACC = C.REF_FIELDS.ACCOUNTING_MAP;

    // 「所／中心」→ 上層「部」對應（單一事實來源在 config）
    const ORG_PARENT_ENTRIES = Object.entries(C.SIGNING.ORG_PARENT_MAP);
    const ORG_SEP = C.SIGNING.ORG_NAME_SEPARATOR;
    // 這兩者在 kintone 底下還有子單位，只在「帶子單位」時才補上層部門前綴（見 processOrgName 註解）
    const SUBUNIT_REQUIRED_CHILDREN = ['桃園機場營業所', '新竹營業所'];

    // =========================
    // 手動簽核流程相關常數
    // =========================

    // 手動模式欄位配置
    const MANUAL_MODE_CONFIG = {
      // 核取方塊欄位名稱
      checkbox: F.MANUAL_FLOW,

      // A類：人數欄位
      countFields: COUNT_FIELDS,

      // B類：主管欄位
      managerFields: [
        { field: '單位主管1', order: 1 },
        { field: '單位主管2', order: 2 },
        { field: '單位主管3', order: 3 },
      ],
      deputyFields: [
        { field: '單位次長', order: 1 },
        { field: '單位次長1', order: 2 },
      ],

      // C類：固定顯示欄位（必填）
      fixedFields: ['單位部長_支店長', F.ACCOUNTING_STAFF],
    };

    // 人數對應主管欄位
    const MANUAL_DISPLAY_RULES = {
      manager: {
        '0人': [],
        '1人': ['單位主管3'],
        '2人': ['單位主管2', '單位主管3'],
        '3人': ['單位主管1', '單位主管2', '單位主管3'],
      },
      deputy: {
        '0人': [],
        '1人': ['單位次長1'],
        '2人': ['單位次長', '單位次長1'],
      },
    };

    // =========================
    // 工具函數區塊
    // =========================

    /**
     * 更新簽核人數
     * @param {Object} record - Kintone record 物件
     * @param {string} field - 欄位名稱
     * @param {number} count - 人數
     */
    function updateSigningCount(record, field, count) {
      record[field].value = `${count}人`;
      KT.record().setFieldShown(field, count > 0);
    }

    /**
     * 找出選擇的組織在 orgs 中的索引
     * @param {Array} orgs - 組織陣列
     * @param {string} selectedOrgName - 選擇的組織名稱
     * @returns {number} 索引值，找不到回傳 -1
     */
    function getMatchedOrgIndex(orgs, selectedOrgName) {
      return orgs.findIndex((org) => org.organization.name === selectedOrgName);
    }

    /**
     * 取得使用者職位資料
     * @param {string} userApi - API 路徑
     * @param {Object} params - 查詢參數
     * @param {Function} callback - 回調函數
     */
    function fetchTitleData(userApi, params, callback) {
      kintone
        .api(kintone.api.url(userApi, true), 'GET', params)
        .then((resp) => {
          const orgs = resp.organizationTitles;
          const titleCount = orgs.length;
          callback(null, { orgs, titleCount });
        })
        .catch((error) => {
          callback(error, null);
        });
    }

    /**
     * 處理組織名稱（包含六大主管簽核流程）
     * @param {string} orgName - 原始組織名稱
     * @param {string} org - 組織名稱
     * @param {string} title - 職位名稱
     * @returns {string} 處理後的組織名稱
     */
    function processOrgName(orgName, org, title) {
      let modifiedOrgName = orgName;

      // 「所／中心」→ 上層「部」的補前綴處理，對應內容來自 C.SIGNING.ORG_PARENT_MAP。
      //
      // ⚠️ 比對條件有意不對稱：
      //    桃園機場營業所／新竹營業所 → 只有帶子單位（例：新竹營業所-Sales Team）時才補前綴，
      //                                裸名不補；
      //    併裝中心                   → 裸名即補。
      //    簽核流程主檔（APPS.APPROVAL_FLOW）是否存在裸名的簽核流程名稱無法查證，
      //    故維持現況，不一律補前綴，以免簽核流程查詢失效。
      ORG_PARENT_ENTRIES.forEach(([child, parent]) => {
        const matched = SUBUNIT_REQUIRED_CHILDREN.includes(child) ? orgName.startsWith(`${child}${ORG_SEP}`) : orgName === child;
        if (matched) {
          modifiedOrgName = `${parent}${ORG_SEP}${orgName}`;
        }
      });

      // 新竹營業所-Sales Team 的特例：補完前綴後再把 'Sales ' 改寫為 '營業'
      if (modifiedOrgName === '航空貨物部-新竹營業所-Sales Team') {
        modifiedOrgName = `${modifiedOrgName.replace('Sales ', '營業')}`;
      }

      // 聯海通運股份有限公司 → 聯海：這是簽核流程主檔（APPS.APPROVAL_FLOW）「簽核流程名稱」
      // 的縮寫規則，不是組織隸屬關係，故刻意不放進 ORG_PARENT_MAP。
      if (orgName === '聯海通運股份有限公司') {
        modifiedOrgName = '聯海';
      }

      // 簽核名稱處理邏輯
      if (org && title) {
        // 1. 物流部次長級
        if ((org === '物流部-桃園NEXT1倉庫' || org === '物流部') && title === '次長') {
          modifiedOrgName = '物流部次長級';
        }
        // 2. 航空貨物部次長(所長)級
        else if (
          (org === '航空貨物部' && title === '次長') ||
          ((org === '桃園機場營業所' || org === '新竹營業所') && (title === '所長' || title === '次長'))
        ) {
          modifiedOrgName = '航空貨物部次長(所長)級';
        }
        // 3. 海運貨物部次長級
        else if (org === '海運貨物部' && title === '次長') {
          modifiedOrgName = '海運貨物部次長級';
        }
        // 4. 總務部次長級
        else if (org === '總務部' && title === '次長') {
          modifiedOrgName = '總務部次長級';
        }
        // 5. 物流部長/汽車貨運部長
        else if ((org === '物流部' || org === '汽車貨運部') && title === '部長') {
          modifiedOrgName = '物流部長/汽車貨運部長';
        }

        // 6. 海運貨物部長/航空貨物部長
        else if ((org === '海運貨物部' || org === '航空貨物部') && title === '部長') {
          modifiedOrgName = '海運貨物部長/航空貨物部長';
        }
        // 7. 安全品質推動部長/營業戰略部長/總務部長/事業本部長
        else if (
          (org === '安全品質推動部' && title === '部長') ||
          ((org === '營業戰略部' || org === '總務部' || org === '事業本部') && title === '部長')
        ) {
          modifiedOrgName = '安全品質推動部長/營業戰略部長/總務部長/事業本部長';
        }
        //8. 台中營業部/高雄營業部/事業本部次長(中心長)級
        else if ((org === '事業本部' && title === '次長') || ((org === '台中營業部' || org === '高雄營業部') && title === '部長')) {
          modifiedOrgName = '台中營業部長/高雄營業部長/事業本部次長(中心長)級';
        }

        //9. 安全品質推動部次長級
        else if (org === '安全品質推動部' && title === '次長') {
          modifiedOrgName = '安全品質推動部次長級';

          //10. 高雄營業部次長級
        } else if (org === '高雄營業部' && title === '次長') {
          modifiedOrgName = '高雄營業部次長級';
        }

        //11. 台中營業部次長級
        else if (org === '台中營業部' && title === '次長') {
          modifiedOrgName = '台中營業部次長級';
        }
      }

      return modifiedOrgName;
    }

    /**
     * 決定「要排哪幾位主管」——只做判斷，不碰 kintone、不改 record。
     *
     * 簽核流程主檔有值的欄位全部保留，由低層級到高層級：
     *   單位主管1 → 單位主管2 → 單位主管3 → 單位次長 → 單位次長1 → 單位部長_支店長
     * 費用所屬人本人那一層與以下，之後由 clearSigningFieldsByTitle 依職稱清掉。
     *
     * @param {Object} managerData - 簽核流程主檔回傳的那筆記錄
     * @param {Array}  fieldsToUpdate - MANAGER_FIELDS_MAPPING 或 MANAGER_FIELDS_SPECIAL
     * @returns {{ fieldHasValue: Object, fieldsToShow: string[] }}
     */
    const planSigningChain = (managerData, fieldsToUpdate) => {
      const fieldHasValue = {};
      fieldsToUpdate.forEach(({ apiField, displayField }) => {
        fieldHasValue[displayField] = managerData[apiField]?.value?.length > 0;
      });

      const fieldsToShow = fieldsToUpdate.map(({ displayField }) => displayField).filter((displayField) => fieldHasValue[displayField]);

      return { fieldHasValue, fieldsToShow };
    };

    /**
     * 設定簽核人員欄位
     *
     * 簽核層級結構：
     *   A1: 單位主管1
     *   A2: 單位主管2
     *   A3: 單位主管3
     *   B:  單位次長
     *   C:  單位次長1
     *   D:  單位部長_支店長
     *
     * 決定「要排哪幾位主管」的判斷本身是純函式 planSigningChain，
     * 本函式只負責把結果寫進 record 並設定顯示狀態。
     *
     * @param {Object} managerData - 主管資料（來源 API 回傳）
     * @param {Object} record - Kintone record 物件
     * @param {boolean} isSpecialDepartment - 是否為特殊部門（六大簽核流程）
     * @returns {Object} 更新後的 record
     */
    function updateSigningFields(managerData, record, isSpecialDepartment) {
      const fieldsToUpdate = isSpecialDepartment ? MANAGER_FIELDS_SPECIAL : MANAGER_FIELDS_MAPPING;

      const { fieldHasValue, fieldsToShow } = planSigningChain(managerData, fieldsToUpdate);

      fieldsToUpdate.forEach(({ apiField, displayField }) => {
        const shouldShow = fieldsToShow.includes(displayField);
        const users = fieldHasValue[displayField] ? managerData[apiField].value : [];

        if (shouldShow && users.length > 0) {
          // 顯示欄位並設定值
          record[displayField] = {
            value: users.map((user) => ({
              code: user.code,
              name: user.name,
            })),
            type: 'USER_SELECT',
            disabled: true,
          };
          KT.record().setFieldShown(displayField, true);
        } else {
          // 隱藏欄位並清空值
          record[displayField] = {
            value: [],
            type: 'USER_SELECT',
            disabled: true,
          };
          KT.record().setFieldShown(displayField, false);
        }
      });

      return record;
    }

    /**
     * 根據費用所屬人職位清空對應簽核欄位
     * @param {Object} updateRecord - 更新的 record 物件
     * @param {string} title - 職位名稱
     * @param {string} userCode - 費用所屬人的使用者代碼
     */
    function clearSigningFieldsByTitle(updateRecord, title, userCode) {
      switch (title) {
        case '課長':
          console.log('開始處理課長身份');
          console.log('使用者 code:', userCode);

          let matchedLevel = -1; // 用來記錄匹配到的主管層級

          // 先找出使用者是哪一個層級的主管
          for (let i = 1; i <= 3; i++) {
            const managerField = `單位主管${i}`;
            if (APPROVAL_FIELDS[managerField]?.enabled && updateRecord.record[managerField].value?.some((user) => user.code === userCode)) {
              matchedLevel = i;
              console.log(`找到匹配的主管層級: ${matchedLevel}`);
              break;
            }
          }

          // 如果找到匹配的層級，清空該層級及以下層級的主管欄位
          if (matchedLevel > 0) {
            let clearedCount = 0; // 記錄清空的主管數量

            // 清空所有較低層級的主管欄位（包含當前層級）
            for (let i = 1; i <= matchedLevel; i++) {
              const managerField = `單位主管${i}`;

              if (APPROVAL_FIELDS[managerField]?.enabled && updateRecord.record[managerField].value.length > 0) {
                clearedCount++;
              }

              // 清空欄位值
              if (APPROVAL_FIELDS[managerField]?.enabled) {
                updateRecord.record[managerField] = {
                  value: [],
                  type: 'USER_SELECT',
                  disabled: true,
                };

                // 隱藏欄位
                KT.record().setFieldShown(managerField, false);
              }
            }

            // 更新主管簽核人數
            const currentCount = parseInt(updateRecord.record[COUNT_FIELDS.manager].value.charAt(0));
            console.log('當前主管人數:', currentCount);

            if (!isNaN(currentCount) && currentCount > 0) {
              const newCount = Math.max(0, currentCount - clearedCount);
              updateSigningCount(updateRecord.record, COUNT_FIELDS.manager, newCount);
              console.log('更新後主管人數:', newCount);
            }
          }
          break;

        case '次長':
        case '室長':
          console.log('開始處理次長/室長身份');
          // 課長欄位清空與隱藏
          MANAGER_FIELDS.forEach((field) => {
            updateRecord.record[field] = {
              value: [],
              type: 'USER_SELECT',
              disabled: true,
            };
            KT.record().setFieldShown(field, false);
          });
          updateSigningCount(updateRecord.record, COUNT_FIELDS.manager, 0);

          // 處理次長欄位 - 採用階層式邏輯
          let matchedDeputyLevel = -1;

          // 檢查是單位次長還是單位次長1
          DEPUTY_FIELDS.forEach((field, index) => {
            if (updateRecord.record[field].value?.some((user) => user.code === userCode)) {
              matchedDeputyLevel = index;
              console.log(`找到匹配的次長層級: ${field}`);
            }
          });

          // 如果找到匹配的層級，清空該層級及以下層級的次長欄位
          if (matchedDeputyLevel >= 0) {
            let clearedDeputyCount = 0;

            // 清空所有較低層級的次長欄位（包含當前層級）
            for (let i = 0; i <= matchedDeputyLevel; i++) {
              const field = DEPUTY_FIELDS[i];

              if (updateRecord.record[field].value.length > 0) {
                clearedDeputyCount++;
              }

              // 清空欄位值
              updateRecord.record[field] = {
                value: [],
                type: 'USER_SELECT',
                disabled: true,
              };

              KT.record().setFieldShown(field, false);
            }

            // 更新次長簽核人數
            const currentDeputyCount = parseInt(updateRecord.record[COUNT_FIELDS.deputy].value);
            console.log('目前次長人數:', currentDeputyCount);

            if (!isNaN(currentDeputyCount) && currentDeputyCount > 0) {
              const newCount = Math.max(0, currentDeputyCount - clearedDeputyCount);
              updateSigningCount(updateRecord.record, COUNT_FIELDS.deputy, newCount);
              console.log('更新後次長人數:', newCount);
            }
          }
          break;

        case '部長':
        case '支店長':
          [...MANAGER_FIELDS, ...DEPUTY_FIELDS].forEach((field) => {
            updateRecord.record[field] = {
              value: [],
              type: 'USER_SELECT',
              disabled: true,
            };
            KT.record().setFieldShown(field, false);
          });
          // 設定簽核人數為 0
          updateSigningCount(updateRecord.record, COUNT_FIELDS.manager, 0);
          updateSigningCount(updateRecord.record, COUNT_FIELDS.deputy, 0);
          break;
      }

      KT.record().set(updateRecord);
    }

    /**
     * 依費用所屬人在所選部門的職稱，算出查簽核流程主檔要用的資料。
     * @param {string} orgName  請款單上選的費用所屬人部門名稱
     * @param {Array} orgs  /v1/user/organizations.json 的 organizationTitles
     * @param {number} matchedIndex  orgName 在 orgs 裡的位置
     */
    const classifyOwner = (orgName, orgs, matchedIndex) => {
      const org = orgs[matchedIndex];
      // 沒有職稱（title 是 null）→ 不清任何一層，簽核流程主檔有值的欄位全部排上
      const title = org.title?.name || '';
      const orgNameOfTitle = org.organization.name;
      return {
        title,
        modifiedOrgName: processOrgName(orgName, orgNameOfTitle, title),
        // 未更動之前的名稱來觀察是否為六大簽核流程
        isSpecialDepartment: SPECIAL_DEPARTMENTS.includes(orgName) || (DIRECTOR_CHECK_DEPARTMENTS.includes(orgName) && orgs[0]?.title?.name === '部長'),
        // 台中支店長／營業戰略部長／總務部長／事業本部長：不帶入課／次／部長流程
        isSpecificDirector:
          (orgNameOfTitle === '台中營業部' && title === '支店長') ||
          ((orgNameOfTitle === '營業戰略部' || orgNameOfTitle === '總務部' || orgNameOfTitle === '事業本部') && title === '部長'),
      };
    };

    /**
     * 取得會計單位並設定
     * @param {string} orgName - 費用所屬人部門名稱
     */
    function setAccountingUnit(orgName) {
      const params_acc = {
        app: APPS.ACCOUNTING_MAP,
        fields: [ACC.APPLY_UNIT, ACC.ACCOUNTING_UNIT, ACC.ACCOUNTING_STAFF, ACC.PERMISSION_USER],
        query: `${ACC.APPLY_UNIT} in ("${orgName}")`,
      };

      // 呼叫 API 取得會計單位帶入簽核流程
      kintone.api(
        kintone.api.url('/k/v1/records', true),
        'GET',
        params_acc,
        function (resp) {
          if (!resp.records || resp.records.length === 0) {
            alert('找不到對應的會計單位，請確認費用所屬人部門');
            return;
          }

          const AccountData = resp.records[0];
          const updateRecord = KT.record().get();
          // 手動設定簽核流程時，會計單位要維持空白（流程管理靠它分辨「送會計」與「送單位會計處理中」）。
          // API 回來時使用者可能剛勾選手動，所以看寫入當下的畫面資料，不看呼叫當時的狀態。
          const isManual = isManualSigningMode(updateRecord.record);
          const has_account = AccountData[ACC.ACCOUNTING_UNIT]?.value?.length > 0;
          const has_account_member = AccountData[ACC.ACCOUNTING_STAFF]?.value?.length > 0;
          const has_permission_user = AccountData[ACC.PERMISSION_USER]?.value?.length > 0;

          if (!isManual) {
            updateRecord.record[F.ACCOUNTING_UNIT] = {
              value: has_account
                ? [
                    {
                      code: AccountData[ACC.ACCOUNTING_UNIT].value,
                      name: AccountData[ACC.ACCOUNTING_UNIT].value,
                    },
                  ]
                : [],
              type: 'GROUP_SELECT',
              disabled: true,
            };
          }

          updateRecord.record[F.ACCOUNTING_STAFF] = {
            value: has_account_member
              ? AccountData[ACC.ACCOUNTING_STAFF].value.map((member) => ({
                  code: member.code || member,
                  name: member.name || member,
                }))
              : [],
            type: 'USER_SELECT',
          };

          // 左側是請款單主表的欄位（F），右側是會計對應主檔的欄位（ACC）——同名但不同 App
          updateRecord.record[F.PERMISSION_STAFF] = {
            value: has_permission_user
              ? AccountData[ACC.PERMISSION_USER].value.map((user) => ({
                  code: user.code || user,
                  name: user.name || user,
                }))
              : [],
            type: 'USER_SELECT',
          };

          KT.record().setFieldShown(F.ACCOUNTING_UNIT, has_account && !isManual);
          KT.record().set(updateRecord);
        },
        function (error) {
          console.error('API錯誤:', error);
          alert('取得會計單位資料時發生錯誤');
        },
      );
    }

    // =========================
    // 主要處理函數
    // =========================

    /**
     * 處理費用所屬人部門變更時的簽核人員設定
     * @param {Object} event - Kintone event 物件
     * @returns {Object} event 物件
     */
    function handleExpenseOwnerOrgChange(event) {
      const record = event.record;
      const selectedOrg = record[F.EXPENSE_OWNER_ORG].value;

      // 手動設定簽核流程：簽核人員由使用者自選，不重排、不清空；只帶入會計單位承辦人與權限開放人員
      if (isManualSigningMode(record)) {
        if (selectedOrg?.length > 0) setAccountingUnit(selectedOrg[0].name);
        return event;
      }

      // 先隱藏所有簽核相關欄位
      SIGNING_FIELDS_TO_HIDE.forEach((field) => {
        KT.record().setFieldShown(field, false);
      });

      // 如果沒有選擇費用所屬人部門，清空所有簽核欄位
      if (!selectedOrg || selectedOrg.length === 0) {
        getEnabledFields().forEach((field) => {
          record[field].value = [];
        });
        record[F.ACCOUNTING_UNIT].value = [];

        return event;
      }

      record[COUNT_FIELDS.manager].disabled = true;
      record[COUNT_FIELDS.deputy].disabled = true;

      // 取得組織名稱
      const orgName = selectedOrg[0].name;

      // 設定會計單位
      setAccountingUnit(orgName);

      const ownerCode = record[F.EXPENSE_OWNER]?.value?.[0]?.code;
      if (!ownerCode) return event;

      // 取得費用所屬人在各部門的職位資料
      fetchTitleData(USER_API, { code: ownerCode }, (error, result) => {
        if (error) {
          console.error('Error:', error);
          return;
        }

        const { orgs } = result;

        // 取得匹配的組織索引
        const matchedIndex = getMatchedOrgIndex(orgs, orgName);

        // 費用所屬人部門鎖住、只依費用所屬人帶入；不一致（例如複製別人的單）由 handleExpenseOwnerChange 重新帶入部門後再排
        if (matchedIndex === -1) {
          console.warn(`[簽核人員] 費用所屬人部門「${orgName}」不是費用所屬人的所屬單位，等重新帶入部門後再排簽核人員`);
          return;
        }

        // 使用匹配到的索引取得正確的組織和職位資料
        const owner = classifyOwner(orgName, orgs, matchedIndex);
        const { title, modifiedOrgName, isSpecialDepartment, isSpecificDirector } = owner;
        console.log(`modifiedOrgName為${modifiedOrgName}`);

        // 動態建立欄位陣列
        const enabledApiFields = MANAGER_FIELDS_MAPPING.map((field) => field.apiField);
        const specialApiFields = MANAGER_FIELDS_SPECIAL.map((field) => field.apiField);

        const params = {
          app: APPS.APPROVAL_FLOW,
          fields: isSpecialDepartment ? ['簽核流程名稱', ...specialApiFields] : ['簽核流程名稱', ...enabledApiFields],
          query: `簽核流程名稱 = "${modifiedOrgName}"`,
        };

        // 呼叫 API 取得簽核主管資料、身份確認
        kintone.api(
          kintone.api.url('/k/v1/records', true),
          'GET',
          params,
          function (resp) {
            const updateRecord = KT.record().get();

            // API 回來前使用者可能已勾選手動設定簽核流程，那就不蓋掉他自選的人
            if (isManualSigningMode(updateRecord.record)) return;

            console.log('title為', title);

            // 如果是台中支店長/營業戰略部長/總務部長/事業本部長，不用後續的設定
            if (isSpecificDirector) {
              // 隱藏其餘欄位
              SIGNING_FIELDS_TO_HIDE.forEach((field) => {
                KT.record().setFieldShown(field, false);
              });
              KT.record().set(updateRecord);
              console.log('台中支店長/營業戰略部長/總務部長/事業本部長，不帶入課/次/部長流程');
              return;
            }

            if (!resp.records || resp.records.length === 0) {
              console.log('此費用所屬人部門沒有設定簽核流程');
              return;
            }

            const managerData = resp.records[0];

            updateRecord.record = updateSigningFields(managerData, updateRecord.record, isSpecialDepartment);
            KT.record().set(updateRecord);

            // 計算主管人數
            let managerCount = 0;
            MANAGER_FIELDS.forEach((field) => {
              if (updateRecord.record[field]?.value?.length > 0) managerCount++;
            });

            // 計算次長人數
            let deputyCount = 0;
            DEPUTY_FIELDS.forEach((field) => {
              if (updateRecord.record[field]?.value?.length > 0) deputyCount++;
            });

            console.log(`managerCount = ${managerCount}, deputyCount = ${deputyCount}`);

            // 設定簽核人數
            updateSigningCount(updateRecord.record, COUNT_FIELDS.manager, managerCount);
            updateSigningCount(updateRecord.record, COUNT_FIELDS.deputy, deputyCount);

            KT.record().set(updateRecord);

            // 六大簽核流程不需再運行下方程式
            if (isSpecialDepartment) return;

            // 費用所屬人職位設定 - 單職位與雙職位過濾重複簽核的人員
            clearSigningFieldsByTitle(updateRecord, title, ownerCode);
          },
          function (error) {
            console.error('API錯誤:', error);
            alert('取得主管資料時發生錯誤');
          },
        );
      });

      return event;
    }

    // =========================
    // 手動簽核流程相關函數
    // =========================

    /**
     * 初始化手動簽核模式
     * @param {Object} record - Kintone record 物件
     * @returns {Object} 更新後的 record
     */
    function initManualSigningMode(record) {
      console.log('=== 初始化手動簽核模式 ===');

      // A類：人數欄位啟用
      record[MANUAL_MODE_CONFIG.countFields.manager].disabled = false;
      record[MANUAL_MODE_CONFIG.countFields.deputy].disabled = false;
      record[MANUAL_MODE_CONFIG.countFields.manager].value = '0人';
      record[MANUAL_MODE_CONFIG.countFields.deputy].value = '0人';

      KT.record().setFieldShown(MANUAL_MODE_CONFIG.countFields.manager, true);
      KT.record().setFieldShown(MANUAL_MODE_CONFIG.countFields.deputy, true);

      // B類：主管欄位先全部隱藏
      MANUAL_MODE_CONFIG.managerFields.forEach(({ field }) => {
        record[field].value = [];
        record[field].disabled = false;
        KT.record().setFieldShown(field, false);
      });

      MANUAL_MODE_CONFIG.deputyFields.forEach(({ field }) => {
        record[field].value = [];
        record[field].disabled = false;
        KT.record().setFieldShown(field, false);
      });

      // C類：固定欄位顯示
      MANUAL_MODE_CONFIG.fixedFields.forEach((field) => {
        record[field].disabled = false;
        KT.record().setFieldShown(field, true);
      });

      console.log('手動簽核模式初始化完成');
      return record;
    }

    /**
     * 根據主管人數動態顯示欄位
     * @param {string} count - 人數選擇（"0人", "1人", "2人", "3人"）
     * @param {Object} record - Kintone record 物件
     */
    function handleManagerCountChangeForManual(count, record) {
      console.log(`=== 處理主管人數變更: ${count} ===`);

      const fieldsToShow = MANUAL_DISPLAY_RULES.manager[count] || [];

      MANUAL_MODE_CONFIG.managerFields.forEach(({ field }) => {
        const shouldShow = fieldsToShow.includes(field);

        if (shouldShow) {
          record[field].disabled = false;
          KT.record().setFieldShown(field, true);

          console.log(`顯示欄位: ${field}`);
        } else {
          record[field].value = [];
          record[field].disabled = false;
          KT.record().setFieldShown(field, false);

          console.log(`隱藏欄位: ${field}`);
        }
      });
    }

    /**
     * 根據次長人數動態顯示欄位
     * @param {string} count - 人數選擇（"0人", "1人", "2人"）
     * @param {Object} record - Kintone record 物件
     */
    function handleDeputyCountChangeForManual(count, record) {
      console.log(`=== 處理次長人數變更: ${count} ===`);

      const fieldsToShow = MANUAL_DISPLAY_RULES.deputy[count] || [];

      MANUAL_MODE_CONFIG.deputyFields.forEach(({ field }) => {
        const shouldShow = fieldsToShow.includes(field);

        if (shouldShow) {
          record[field].disabled = false;
          KT.record().setFieldShown(field, true);

          console.log(`顯示欄位: ${field}`);
        } else {
          record[field].value = [];
          record[field].disabled = false;
          KT.record().setFieldShown(field, false);

          console.log(`隱藏欄位: ${field}`);
        }
      });
    }

    /**
     * 驗證手動簽核流程
     * @param {Object} record - Kintone record 物件
     * @returns {Object} { isValid: boolean, errors: string[] }
     */
    function validateManualSigningFlow(record) {
      console.log('=== 開始驗證手動簽核流程 ===');

      const errors = [];

      // 1. 驗證主管人數與實際填寫是否一致
      const managerCountStr = record[MANUAL_MODE_CONFIG.countFields.manager].value;
      if (managerCountStr) {
        const declaredCount = parseInt(managerCountStr.charAt(0));
        let actualCount = 0;

        MANUAL_MODE_CONFIG.managerFields.forEach(({ field }) => {
          if (record[field].value && record[field].value.length > 0) {
            actualCount++;
          }
        });

        if (declaredCount !== actualCount) {
          errors.push(`❌ 部門主管簽核人數選擇 ${declaredCount}人，但實際填寫 ${actualCount} 位，請補齊或調整人數`);
        }

        console.log(`主管人數驗證: 宣告=${declaredCount}, 實際=${actualCount}`);
      }

      // 2. 驗證次長人數與實際填寫是否一致
      const deputyCountStr = record[MANUAL_MODE_CONFIG.countFields.deputy].value;
      if (deputyCountStr) {
        const declaredCount = parseInt(deputyCountStr.charAt(0));
        let actualCount = 0;

        MANUAL_MODE_CONFIG.deputyFields.forEach(({ field }) => {
          if (record[field].value && record[field].value.length > 0) {
            actualCount++;
          }
        });

        if (declaredCount !== actualCount) {
          errors.push(`❌ 部門次長簽核人數選擇 ${declaredCount}人，但實際填寫 ${actualCount} 位，請補齊或調整人數`);
        }

        console.log(`次長人數驗證: 宣告=${declaredCount}, 實際=${actualCount}`);
      }

      // 3. 驗證 C類固定欄位必填(管理員略過)
      if (!C.isAdmin()) {
        MANUAL_MODE_CONFIG.fixedFields.forEach((field) => {
          const value = record[field].value;
          const isEmpty = !value || value.length === 0;

          if (isEmpty) {
            const fieldLabel = field === '單位部長_支店長' ? '單位部長/支店長' : '會計單位承辦人';
            errors.push(`❌ 請填寫「${fieldLabel}」欄位`);
          }

          console.log(`${field} 必填驗證: ${isEmpty ? '未填寫' : '已填寫'}`);
        });
      }

      // 4. 驗證是否有選擇人數但未填寫
      if (managerCountStr && parseInt(managerCountStr.charAt(0)) > 0) {
        const hasAnyManager = MANUAL_MODE_CONFIG.managerFields.some(({ field }) => record[field].value && record[field].value.length > 0);
        if (!hasAnyManager) {
          errors.push(`❌ 已選擇部門主管簽核人數，但未填寫任何主管人員`);
        }
      }

      if (deputyCountStr && parseInt(deputyCountStr.charAt(0)) > 0) {
        const hasAnyDeputy = MANUAL_MODE_CONFIG.deputyFields.some(({ field }) => record[field].value && record[field].value.length > 0);
        if (!hasAnyDeputy) {
          errors.push(`❌ 已選擇部門次長簽核人數，但未填寫任何次長人員`);
        }
      }

      const isValid = errors.length === 0;
      console.log(`驗證結果: ${isValid ? '通過' : '失敗'}`);
      if (!isValid) {
        console.log('錯誤列表:', errors);
      }

      return { isValid, errors };
    }

    /**
     * 檢查是否為手動模式
     * @param {Object} record - Kintone record 物件
     * @returns {boolean}
     */
    function isManualSigningMode(record) {
      return record[MANUAL_MODE_CONFIG.checkbox] && record[MANUAL_MODE_CONFIG.checkbox].value && record[MANUAL_MODE_CONFIG.checkbox].value.length > 0;
    }

    // =========================
    // 事件註冊
    // =========================

    // 費用所屬人部門變更時的事件
    KT.on([`app.record.create.change.${F.EXPENSE_OWNER_ORG}`, `app.record.edit.change.${F.EXPENSE_OWNER_ORG}`], handleExpenseOwnerOrgChange);

    /**
     * 申請人在「費用歸屬不限部門」群組（COST_SCOPE.EXEMPT_GROUP）→ 簽核人員自選：勾上手動設定簽核流程。
     * @param {Object} record
     */
    function enterManualModeForExempt(record) {
      record[F.MANUAL_FLOW].value = [OPT.MANUAL_FLOW.ON];
      record[F.ACCOUNTING_UNIT].value = [];
      KT.record().setFieldShown(F.ACCOUNTING_UNIT, false);
      if (typeof KT.record().setGroupFieldOpen === 'function') KT.record().setGroupFieldOpen(F.SIGN_FLOW_GROUP, true);
      initManualSigningMode(record);
    }

    /**
     * 新增畫面：先確認申請人是否在排除群組（PR_COST_SCOPE），在的話切手動模式，再帶入費用所屬人部門與簽核人員／會計單位。
     */
    function handleCreateShow(event) {
      const scope = window.PR_COST_SCOPE;
      if (!scope) return syncOwnerOrgOnCreate(event);
      return scope.ensureExempt(scope.applicantCodeOf(event.record)).then((exempt) => {
        if (exempt && !isManualSigningMode(event.record)) enterManualModeForExempt(event.record);
        return syncOwnerOrgOnCreate(event);
      });
    }

    /**
     * 新增畫面：費用所屬人部門一律依費用所屬人（部門鎖住，不能手選）。
     *   - 沒有費用所屬人 → 部門清空、簽核欄位清空
     *   - 部門有值 → 先照它排簽核人員；同時查費用所屬人的單位，部門不是他的單位（例如複製別人的單）就重新帶入
     *   - 部門空白 → 簽核欄位清空，查單位帶入部門（同改費用所屬人）
     * 查單位是非同步的，帶入部門後 handleExpenseOwnerChange 會再重排簽核人員，兩者不會互相覆蓋。
     */
    function syncOwnerOrgOnCreate(event) {
      const record = event.record;
      const hasOwner = record[F.EXPENSE_OWNER]?.value?.length > 0;
      if (!hasOwner) return clearOwnerOrg(event);
      handleExpenseOwnerOrgChange(event);
      handleExpenseOwnerChange(event, { keepIfValid: true });
      return event;
    }

    /** 沒有費用所屬人 → 部門跟著清空（部門只依費用所屬人帶入），公司名稱重算、簽核欄位清空 */
    function clearOwnerOrg(event) {
      const orgField = event.record[F.EXPENSE_OWNER_ORG];
      if (orgField?.value?.length > 0) {
        orgField.value = [];
        window.PR_COMPANY_NAME?.apply(event.record);
      }
      return handleExpenseOwnerOrgChange(event);
    }

    KT.on('app.record.create.show', handleCreateShow);

    // ── 改費用所屬人後帶入費用所屬人部門並重排簽核人員（所有人適用）──

    /**
     * 費用所屬人的所屬單位 → 選單選項。主要單位排第一並預先選好，職稱附在後面方便辨認身分。
     * @param {Array} orgs  /v1/user/organizations.json 的 organizationTitles
     * @returns {{ options: Object<string,string>, defaultIndex: string }}
     */
    const buildOwnerOrgOptions = (orgs) => {
      const options = {};
      orgs.forEach((o, i) => {
        const title = o.title?.name ? `（${o.title.name}）` : '';
        options[String(i)] = `${o.organization.name}${title}${o.organization.primary ? '　★主要單位' : ''}`;
      });
      const primaryIndex = orgs.findIndex((o) => o.organization.primary === true);
      return { options, defaultIndex: String(primaryIndex >= 0 ? primaryIndex : 0) };
    };

    // 選單位的視窗一次只開一個（申請人、費用所屬人同時要選時排隊，SweetAlert 開第二個會把第一個關掉）
    let orgDialogQueue = Promise.resolve();

    /**
     * 決定要帶入哪個單位：只有一個就直接用；多個跳視窗讓使用者選。按取消回傳 null。
     * 部門欄位鎖住、只能依人員帶入，所以目前的部門不是這個人的單位時（keepable＝false）不給取消，一定要選。
     * @param {Array} orgs  /v1/user/organizations.json 的 organizationTitles
     * @param {string} userName
     * @param {{ subject?: string, hint?: string, keepable?: boolean, isCurrent?: Function }} [opts]
     *   subject：「費用所屬人」或「申請人」；isCurrent：排隊輪到時再確認這次查詢還算數（使用者已改人就不開視窗）
     * @returns {Promise<Object|null>} organizationTitles 的其中一筆
     */
    const pickOrg = (orgs, userName, { subject = '費用所屬人', hint = '', keepable = true, isCurrent = () => true } = {}) => {
      if (orgs.length <= 1) return Promise.resolve(orgs[0] || null);
      const { options, defaultIndex } = buildOwnerOrgOptions(orgs);
      if (typeof Swal === 'undefined') return Promise.resolve(orgs[Number(defaultIndex)]);
      const open = async () => {
        if (!isCurrent()) return null;
        const result = await Swal.fire({
          title: `請選擇${subject}部門`,
          text: `${userName} 有 ${orgs.length} 個所屬單位${hint ? `，${hint}` : '。'}`,
          input: 'radio',
          inputOptions: options,
          inputValue: defaultIndex,
          showCancelButton: keepable,
          confirmButtonText: '帶入',
          cancelButtonText: '取消（保留原本的部門）',
          allowOutsideClick: false,
          allowEscapeKey: keepable,
        });
        if (!result.isConfirmed) return null;
        return orgs[Number(result.value)] || null;
      };
      const picked = orgDialogQueue.then(open, open);
      orgDialogQueue = picked.catch(() => null);
      return picked;
    };

    /** 查使用者的所屬單位（organizationTitles） */
    const fetchUserOrgs = (userCode) => kintone.api(kintone.api.url(USER_API, true), 'GET', { code: userCode }).then((resp) => resp.organizationTitles || []);

    /** 人員沒有任何所屬單位時的提醒 */
    const warnNoOrg = (subject) => {
      const title = `此${subject}沒有所屬單位`;
      const text = `請改選其他${subject}，或請管理員到 kintone 設定他的所屬組織。`;
      if (typeof Swal !== 'undefined') Swal.fire({ icon: 'warning', title, text });
      else alert(`${title}\n${text}`);
    };

    // 申請人部門（申請人部門帶入_20261022.js）共用同一套查單位與選單位視窗
    window.PR_ORG_PICKER = Object.freeze({ fetchUserOrgs, pickOrg, warnNoOrg });

    // 連續改費用所屬人時，只讓最後一次的查詢結果寫回畫面
    let expenseOwnerChangeSeq = 0;

    /**
     * 改費用所屬人：查他的所屬單位 → 帶入費用所屬人部門 → 依新的人與部門重排簽核人員。
     * change 事件不可 async，查詢與寫回放在 .then() 裡用 get()/set()。
     * 費用所屬人部門由程式寫入不一定會觸發 change，所以寫完直接呼叫 handleExpenseOwnerOrgChange 重排；
     * 部門沒變（同部門換人）也要重排，因為簽核人員的職稱清除會因人而異。
     * @param {Object} event
     * @param {{ keepIfValid?: boolean }} [opts] keepIfValid：目前的部門就是這個人的單位時不動（新增畫面用）
     */
    function handleExpenseOwnerChange(event, { keepIfValid = false } = {}) {
      const owner = event.record[F.EXPENSE_OWNER]?.value?.[0];
      const seq = ++expenseOwnerChangeSeq;
      if (!owner?.code) return clearOwnerOrg(event);

      fetchUserOrgs(owner.code)
        .then(async (orgs) => {
          if (seq !== expenseOwnerChangeSeq) return;
          if (orgs.length === 0) {
            warnNoOrg('費用所屬人');
            return;
          }
          const currentCode = KT.record().get().record[F.EXPENSE_OWNER_ORG]?.value?.[0]?.code;
          const currentValid = orgs.some((o) => o.organization.code === currentCode);
          if (keepIfValid && currentValid) return;

          const picked = await pickOrg(orgs, owner.name || owner.code, {
            subject: '費用所屬人',
            hint: '簽核人員會依選的部門排。',
            keepable: currentValid,
            isCurrent: () => seq === expenseOwnerChangeSeq,
          });
          if (!picked || seq !== expenseOwnerChangeSeq) return;

          const current = KT.record().get();
          current.record[F.EXPENSE_OWNER_ORG].value = [{ code: picked.organization.code, name: picked.organization.name }];
          current.record[F.EXPENSE_OWNER_ORG].disabled = true;
          // 程式寫入部門不會觸發 change 事件，公司名稱要在這裡跟著重算（推導規則在 main）
          window.PR_COMPANY_NAME?.apply(current.record);
          KT.record().set(current);
          handleExpenseOwnerOrgChange({ record: KT.record().get().record });
        })
        .catch((err) => console.error('[簽核人員] 改費用所屬人後帶入費用所屬人部門失敗:', err));
      return event;
    }

    KT.on([`app.record.create.change.${F.EXPENSE_OWNER}`, `app.record.edit.change.${F.EXPENSE_OWNER}`], handleExpenseOwnerChange);

    // 表單編輯時，有顯示的繼續顯示，隱藏的繼續隱藏
    KT.on(['app.record.edit.show', 'app.record.detail.show'], (event) => {
      const record = event.record;

      // 處理簽核欄位的顯示邏輯
      getEnabledFields().forEach((field) => {
        const hasValue = record[field]?.value?.length > 0;
        KT.record().setFieldShown(field, hasValue);
      });

      // 處理其他一般欄位的顯示邏輯
      const fieldList = [COUNT_FIELDS.manager, COUNT_FIELDS.deputy, ...getEnabledFields()];

      // USER_SELECT disabled
      fieldList.forEach((field) => {
        if (record[field]) {
          record[field].disabled = true;
        }
      });

      // 手動設定簽核流程時不顯示會計單位
      KT.record().setFieldShown(F.ACCOUNTING_UNIT, record[F.MANUAL_FLOW]?.value?.length < 1);

      return event;
    });

    // 手動設定簽核流程勾選變更
    KT.on([`app.record.create.change.${F.MANUAL_FLOW}`, `app.record.edit.change.${F.MANUAL_FLOW}`], function (event) {
      const record = event.record;
      const isManual = isManualSigningMode(record);

      if (isManual) {
        // 啟用手動模式
        record[F.ACCOUNTING_UNIT].value = [];
        KT.record().setFieldShown(F.ACCOUNTING_UNIT, false);

        KT.record().setGroupFieldOpen(F.SIGN_FLOW_GROUP, true);
        event.record = initManualSigningMode(record);
      } else {
        // 取消手動模式 - 需要確認
        const userConfirmed = confirm(
          '⚠️ 切換回自動模式會清除已填寫的內容，確定要繼續嗎？\n\n' + '按「確定」將重新載入自動簽核流程\n' + '按「取消」將維持手動模式',
        );

        if (userConfirmed) {
          handleExpenseOwnerOrgChange(event);
        } else {
          // 使用者取消，重新勾選 checkbox
          record[MANUAL_MODE_CONFIG.checkbox].value = [OPT.MANUAL_FLOW.ON];
          event.record = record;
        }
      }

      return event;
    });

    // 部門主管簽核人數變更
    KT.on(
      [`app.record.create.change.${COUNT_FIELDS.manager}`, `app.record.edit.change.${COUNT_FIELDS.manager}`],
      function (event) {
        const record = event.record;

        // 只在手動模式下處理
        if (!isManualSigningMode(record)) {
          return event;
        }

        const count = record[MANUAL_MODE_CONFIG.countFields.manager].value;

        handleManagerCountChangeForManual(count, record);
        event.record = record;

        return event;
      },
    );

    // 部門次長簽核人數變更
    KT.on(
      [`app.record.create.change.${COUNT_FIELDS.deputy}`, `app.record.edit.change.${COUNT_FIELDS.deputy}`],
      function (event) {
        const record = event.record;

        // 只在手動模式下處理
        if (!isManualSigningMode(record)) {
          return event;
        }

        const count = record[MANUAL_MODE_CONFIG.countFields.deputy].value;

        handleDeputyCountChangeForManual(count, record);
        event.record = record;

        return event;
      },
    );

    // 編輯/詳細頁面顯示（手動模式支援）
    KT.on(['app.record.edit.show', 'app.record.detail.show'], function (event) {
      const record = event.record;

      if (isManualSigningMode(record)) {
        // A類欄位：啟用編輯（僅編輯模式）
        if (event.type === 'app.record.edit.show') {
          record[MANUAL_MODE_CONFIG.countFields.manager].disabled = false;
          record[MANUAL_MODE_CONFIG.countFields.deputy].disabled = false;
        }

        // B類欄位：根據目前人數顯示對應欄位並啟用
        const managerCount = record[MANUAL_MODE_CONFIG.countFields.manager].value;
        const deputyCount = record[MANUAL_MODE_CONFIG.countFields.deputy].value;

        if (managerCount) {
          handleManagerCountChangeForManual(managerCount, record);
        }

        if (deputyCount) {
          handleDeputyCountChangeForManual(deputyCount, record);
        }

        // C類欄位：顯示並啟用（僅編輯模式）
        if (event.type === 'app.record.edit.show') {
          MANUAL_MODE_CONFIG.fixedFields.forEach((field) => {
            record[field].disabled = false;
            KT.record().setFieldShown(field, true);
          });
        }
      }

      return event;
    });

    // 儲存時檢查手動簽核流程的欄位值是否符合規定
    KT.on(['app.record.create.submit', 'app.record.edit.submit'], (event) => {
      const record = event.record;
      // VOID_FIELD 是 checkbox 欄位代碼，與 STATUS.VOID 流程狀態字串語意不同
      if (record[C.VOID_FIELD]?.value?.length > 0) {
        return event;
      }
      if (isManualSigningMode(record)) {
        const validation = validateManualSigningFlow(record);

        if (!validation.isValid) {
          const errorMessage = '⚠️ 簽核流程驗證失敗：\n\n' + validation.errors.join('\n\n') + '\n\n請修正後再送出。';

          event.error = errorMessage;
          return event;
        }
      }

      return event;
    });
  })();

  (() => {

    // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
    const KT = window.PR_KT;

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
          const currentCode = KT.record().get().record[F.APPLICANT_ORG]?.value?.[0]?.code;
          const currentValid = orgs.some((o) => o.organization.code === currentCode);
          if (keepIfValid && currentValid) return;

          const picked = await picker.pickOrg(orgs, applicant.name || applicant.code, {
            subject: '申請人',
            keepable: currentValid,
            isCurrent: () => seq === applicantSeq,
          });
          if (!picked || seq !== applicantSeq) return;

          const current = KT.record().get();
          current.record[F.APPLICANT_ORG].value = [{ code: picked.organization.code, name: picked.organization.name }];
          current.record[F.APPLICANT_ORG].disabled = true;
          KT.record().set(current);
        })
        .catch((err) => console.error('[申請人部門] 帶入申請人部門失敗:', err));
      return event;
    };

    KT.on('app.record.create.show', (event) => syncApplicantOrg(event, { keepIfValid: true }));
    KT.on([`app.record.create.change.${F.APPLICANT}`, `app.record.edit.change.${F.APPLICANT}`], (event) => syncApplicantOrg(event));

    window.PR_APPLICANT_ORG = Object.freeze({ syncApplicantOrg });
  })();

  (() => {

    // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
    const KT = window.PR_KT;

    // =============================================================================
    // 交通費明細規則（子表格「交通費請款單」與「是否有紙本憑證」「理由」）
    //
    //   1. 交通工具＝高鐵 → 賣方統編寫 TRAFFIC_RULES.HSR_SELLER_TAX_ID、格式寫 HSR_FORMAT，並鎖住
    //   2. 金額變更 → 稅額＝金額 ÷ 1.05 × 0.05，四捨五入到個位數（金額本身含稅），稅額鎖住
    //   3. 憑證種類＝高鐵票／發票 → 開放發票號碼；其他種類鎖住並清空。存檔時必填、表單內不可重複，
    //      並重算「發票號碼記錄」（跨單重複由 payment_request_submit 查記錄欄位，不用迴圈讀表格）
    //   4. 有任何一列是計程車 → 是否有紙本憑證自動選「是」，理由動態必填（標籤加紅色 *）
    //
    //   存檔驗證的錯誤由 payment_request_submit 統一顯示（呼叫 normalize／validate），這裡不另跳視窗。
    // =============================================================================

    const C = window.PR_CONFIG;
    const F = C.FIELDS;
    const OPT = C.OPTIONS;
    const RULES = C.TRAFFIC_RULES;
    const TRAFFIC = F.TRAFFIC_TABLE;
    const COLS = TRAFFIC.COLS;

    const REQUIRED_MARK_ID = 'pr-reason-required-mark';

    // ── 純函式（只動 record，不碰畫面）────────────────────────────────────────

    /**
     * 含稅金額 → 稅額（字串，四捨五入到個位數）。金額空白或不是數字 → 空字串。
     * 用整數運算（金額 × 5 ÷ 105）避免 1.05 的浮點誤差；負數（退款）照絕對值算再補回正負號。
     * @param {string|number} amount
     * @returns {string}
     */
    const calcTax = (amount) => {
      if (amount === '' || amount === null || amount === undefined) return '';
      const n = Number(amount);
      if (!Number.isFinite(n)) return '';
      const rate = RULES.TAX_RATE_PERCENT;
      const tax = Math.round((Math.abs(n) * rate) / (100 + rate));
      return String(n < 0 && tax !== 0 ? -tax : tax);
    };

    const isInvoiceReceipt = (row) => RULES.INVOICE_RECEIPT_TYPES.includes(row.value[COLS.RECEIPT_TYPE]?.value);
    const isHsr = (row) => row.value[COLS.VEHICLE]?.value === OPT.VEHICLE.HSR;
    const getRows = (record) => (Array.isArray(record[TRAFFIC.CODE]?.value) ? record[TRAFFIC.CODE].value.filter((r) => r?.value) : []);

    /** 是否有任何一列交通工具是計程車 */
    const hasTaxi = (record) => getRows(record).some((row) => row.value[COLS.VEHICLE]?.value === OPT.VEHICLE.TAXI);

    /**
     * 套用一列的規則（寫值與鎖定）。
     * @param {Object} row 子表格的一列
     * @param {boolean} unlock true＝變更事件：條件不成立時解除鎖定；false＝開畫面：只加鎖不解鎖（不蓋掉帳號權限設定的鎖定）
     */
    const applyRowRules = (row, unlock) => {
      const v = row.value;
      const setLock = (code, locked) => {
        if (!v[code]) return;
        if (locked) v[code].disabled = true;
        else if (unlock) v[code].disabled = false;
      };

      // 1. 高鐵
      if (isHsr(row)) {
        if (v[COLS.SELLER_TAX_ID]) v[COLS.SELLER_TAX_ID].value = RULES.HSR_SELLER_TAX_ID;
        if (v[COLS.FORMAT]) v[COLS.FORMAT].value = RULES.HSR_FORMAT;
      }
      setLock(COLS.SELLER_TAX_ID, isHsr(row));
      setLock(COLS.FORMAT, isHsr(row));

      // 2. 稅額
      if (v[COLS.TAX] && v[COLS.AMOUNT]) v[COLS.TAX].value = calcTax(v[COLS.AMOUNT].value);
      setLock(COLS.TAX, true);

      // 3. 發票號碼
      if (v[COLS.INVOICE_NO]) {
        if (!isInvoiceReceipt(row)) v[COLS.INVOICE_NO].value = '';
        setLock(COLS.INVOICE_NO, !isInvoiceReceipt(row));
      }
    };

    /**
     * 套用整張單的規則：每一列＋計程車 → 是否有紙本憑證選「是」。
     * @param {Object} record
     * @param {boolean} unlock 見 applyRowRules
     * @returns {Object} record
     */
    const applyRecordRules = (record, unlock) => {
      getRows(record).forEach((row) => applyRowRules(row, unlock));
      if (hasTaxi(record) && record[F.PAPER_RECEIPT]) record[F.PAPER_RECEIPT].value = OPT.PAPER_RECEIPT.YES;
      return record;
    };

    /**
     * 存檔前整理：重算稅額、高鐵固定值、清掉不該有的發票號碼，並重算「發票號碼記錄」。
     * 程式寫入的值不會觸發 change 事件，所以存檔時一律再算一次，以這裡為準。
     * @param {Object} record
     * @returns {Object} record
     */
    const normalize = (record) => {
      applyRecordRules(record, false);
      getRows(record).forEach((row) => {
        if (row.value[COLS.INVOICE_NO]?.value) row.value[COLS.INVOICE_NO].value = row.value[COLS.INVOICE_NO].value.trim();
      });
      const agg = window.PR_INVOICE_AGG;
      if (record[F.INVOICE_AGG] && typeof agg?.buildInvoiceAgg === 'function') record[F.INVOICE_AGG].value = agg.buildInvoiceAgg(record);
      return record;
    };

    /**
     * 存檔驗證（先呼叫 normalize）。回傳錯誤訊息陣列，格式配合 payment_request_submit 的錯誤視窗。
     * @param {Object} record
     * @returns {string[]}
     */
    const validate = (record) => {
      const errors = [];
      const rows = getRows(record);

      // 發票號碼：高鐵票／發票必填、表單內不可重複
      const seen = {};
      rows.forEach((row, i) => {
        if (!isInvoiceReceipt(row)) return;
        const no = (row.value[COLS.INVOICE_NO]?.value || '').trim();
        if (!no) {
          errors.push(`第 ${i + 1} 行憑證種類是「${row.value[COLS.RECEIPT_TYPE].value}」，**請填寫「${COLS.INVOICE_NO}」**`);
          return;
        }
        (seen[no] = seen[no] || []).push(i + 1);
      });
      Object.keys(seen)
        .filter((no) => seen[no].length > 1)
        .forEach((no) => {
          errors.push(`「${COLS.INVOICE_NO}」**${no}** 在本單重複填寫（第 ${seen[no].join('、')} 行）\n※ 同一張發票只能填一次`);
        });

      // 計程車：是否有紙本憑證要選「是」、理由必填
      if (hasTaxi(record)) {
        if (record[F.PAPER_RECEIPT] && record[F.PAPER_RECEIPT].value !== OPT.PAPER_RECEIPT.YES) {
          errors.push(`有搭乘${OPT.VEHICLE.TAXI}，「${F.PAPER_RECEIPT}」**必須選「${OPT.PAPER_RECEIPT.YES}」**`);
        }
        if (!(record[F.REASON]?.value || '').trim()) {
          errors.push(`有搭乘${OPT.VEHICLE.TAXI}，**請填寫「${F.REASON}」**`);
        }
      }
      return errors;
    };

    // ── 畫面：理由動態必填的紅色 * ────────────────────────────────────────────

    /**
     * 有計程車就在「理由」標籤後面加紅色 *，沒有就拿掉。
     * kintone 沒有切換必填的 API，只能找標籤文字以 REASON_LABEL_PREFIX 開頭的欄位；找不到就略過（存檔驗證仍會擋）。
     */
    const updateReasonRequiredMark = (required) => {
      try {
        const existing = document.getElementById(REQUIRED_MARK_ID);
        if (!required) {
          if (existing) existing.remove();
          return;
        }
        if (existing) return;
        const label = Array.from(document.querySelectorAll('.control-label-text-gaia')).find((el) =>
          (el.textContent || '').trim().startsWith(RULES.REASON_LABEL_PREFIX),
        );
        if (!label) return;
        const mark = document.createElement('span');
        mark.id = REQUIRED_MARK_ID;
        // 樣式在 payment_request.css 的 .pr-required-mark
        mark.className = 'kintone-field-required pr-required-mark';
        mark.textContent = '*';
        label.appendChild(mark);
      } catch (e) {
        console.warn('[交通費明細規則] 理由必填標示失敗', e);
      }
    };

    // ── 事件 ───────────────────────────────────────────────────────────────

    KT.on(['app.record.create.show', 'app.record.edit.show'], (event) => {
      applyRecordRules(event.record, false);
      updateReasonRequiredMark(hasTaxi(event.record));
      return event;
    });

    const changeEvents = [TRAFFIC.CODE, COLS.VEHICLE, COLS.AMOUNT, COLS.RECEIPT_TYPE].flatMap((code) => [
      `app.record.create.change.${code}`,
      `app.record.edit.change.${code}`,
    ]);

    KT.on(changeEvents, (event) => {
      applyRecordRules(event.record, true);
      // 憑證種類改掉會清空發票號碼，發票號碼記錄要跟著重算（程式寫入不會觸發發票號碼的 change）
      const agg = window.PR_INVOICE_AGG;
      if (event.record[F.INVOICE_AGG] && typeof agg?.buildInvoiceAgg === 'function') {
        event.record[F.INVOICE_AGG].value = agg.buildInvoiceAgg(event.record);
      }
      updateReasonRequiredMark(hasTaxi(event.record));
      return event;
    });

    window.PR_TRAFFIC_RULES = Object.freeze({ calcTax, hasTaxi, applyRowRules, applyRecordRules, normalize, validate, updateReasonRequiredMark });
  })();

  (() => {

    // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
    const KT = window.PR_KT;

    // =============================================================================
    // 預計付款日（2026-10-20）
    //   會計需要 5 個工作日作業，之後的第一個付款日（每月 10 號、20 號、月底）付款，付款日遇假日往後順延。
    //   起算日＝請款日期（不含當天）。工作日看行事曆 App（APPS.HOLIDAY_CALENDAR）：
    //     有記錄 → 看「是否假日」（是＝放假、否＝補行上班）；沒有記錄 → 週六日放假、其餘上班。
    //   存檔時寫入「預計付款日」，畫面上一律鎖住。規則見設定檔 EXPECTED_PAY_DATE。
    // =============================================================================

    const C = window.PR_CONFIG;
    const F = C.FIELDS;
    const CFG = C.EXPECTED_PAY_DATE;
    const CAL = C.REF_FIELDS.HOLIDAY_CALENDAR;

    // ── 日期工具（一律用 UTC 運算，避免時區、日光節約讓日期跑掉）──────────────
    const parseDate = (str) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
      return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
    };
    const formatDate = (d) => d.toISOString().slice(0, 10);
    const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
    const lastDayOfMonth = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

    /**
     * 這天上不上班。
     * @param {Date} d
     * @param {Object<string,boolean>} holidayOf  'YYYY-MM-DD' → true（放假）／false（補行上班）；沒有的日子看星期
     * @returns {boolean}
     */
    const isWorkday = (d, holidayOf) => {
      const key = formatDate(d);
      if (Object.prototype.hasOwnProperty.call(holidayOf, key)) return !holidayOf[key];
      const dow = d.getUTCDay();
      return dow !== 0 && dow !== 6;
    };

    /**
     * 某天當天或之後的第一個付款日（每月 PAY_DAYS 與月底）。
     * @param {Date} d
     * @param {number[]} payDays
     * @returns {Date}
     */
    const nextPayDayOnOrAfter = (d, payDays) => {
      let year = d.getUTCFullYear();
      let month = d.getUTCMonth();
      for (let i = 0; i < 2; i++) {
        const last = lastDayOfMonth(year, month);
        const days = [...new Set([...payDays.filter((n) => n < last), last])].sort((a, b) => a - b);
        for (const day of days) {
          const candidate = new Date(Date.UTC(year, month, day));
          if (candidate >= d) return candidate;
        }
        month += 1;
        if (month > 11) {
          month = 0;
          year += 1;
        }
      }
      return d; // 走不到這裡：當月找不到，下個月的第一個付款日一定在之後
    };

    /**
     * 算預計付款日（純函式）。
     * @param {string} requestDate 請款日期 'YYYY-MM-DD'
     * @param {Object<string,boolean>} holidayOf 見 isWorkday
     * @param {{leadWorkdays?:number, payDays?:number[]}} [opts]
     * @returns {string} 'YYYY-MM-DD'；請款日期不是合法日期時回空字串
     */
    const calcExpectedPayDate = (requestDate, holidayOf = {}, opts = {}) => {
      const start = parseDate(requestDate);
      if (!start) return '';
      const leadWorkdays = opts.leadWorkdays ?? CFG.LEAD_WORKDAYS;
      const payDays = opts.payDays ?? CFG.PAY_DAYS;

      // ① 起算日隔天開始數，第 N 個工作日＝會計作業完成日
      let ready = start;
      for (let counted = 0; counted < leadWorkdays; ) {
        ready = addDays(ready, 1);
        if (isWorkday(ready, holidayOf)) counted += 1;
      }

      // ② 完成日當天或之後的第一個付款日，③ 遇假日往後順延到上班日
      let payDate = nextPayDayOnOrAfter(ready, payDays);
      while (!isWorkday(payDate, holidayOf)) payDate = addDays(payDate, 1);
      return formatDate(payDate);
    };

    /**
     * 向行事曆查「請款日期之後 LOOKAHEAD_DAYS 天」的假日與補班日。
     * @param {string} requestDate
     * @param {Function} [api] 預設 kintone.api，測試時注入
     * @returns {Promise<Object<string,boolean>>}
     */
    const fetchHolidayMap = async (requestDate, api = kintone.api) => {
      const start = parseDate(requestDate);
      if (!start) return {};
      const end = addDays(start, CFG.LOOKAHEAD_DAYS);
      const resp = await api(kintone.api.url('/k/v1/records', true), 'GET', {
        app: C.APPS.HOLIDAY_CALENDAR,
        query: `${CAL.DATE} > "${formatDate(start)}" and ${CAL.DATE} <= "${formatDate(end)}" order by ${CAL.DATE} asc limit 500`,
        fields: [CAL.DATE, CAL.IS_HOLIDAY],
      });
      const holidayOf = {};
      let lastDate = formatDate(start);
      (resp.records || []).forEach((r) => {
        const date = r[CAL.DATE]?.value;
        const flag = r[CAL.IS_HOLIDAY]?.value;
        if (!date) return;
        if (date > lastDate) lastDate = date;
        if (flag === CAL.HOLIDAY_VALUE) holidayOf[date] = true;
        else if (flag === CAL.WORKDAY_VALUE) holidayOf[date] = false;
      });
      // 行事曆每週都有週末記錄；查詢區間尾端超過 7 天沒記錄＝那段還沒建檔（例如下一年度），只能靠星期判斷
      if (addDays(parseDate(lastDate), 7) < end) {
        console.warn(`[預計付款日] 行事曆 ${lastDate} 之後沒有資料，之後的國定假日不會排除，請補建行事曆`);
      }
      return holidayOf;
    };

    /**
     * 按下儲存時寫入預計付款日。
     * 行事曆查不到（權限、網路）時不擋存檔，改用「只看週末」的算法，並在 Console 留警告。
     */
    const handleSubmit = async (event) => {
      if (event.error) return event;
      const record = event.record;
      if (!record[F.EXPECTED_PAY_DATE]) return event; // 表單還沒建這個欄位
      const requestDate = record[F.PAYMENT_DATE]?.value;
      let holidayOf = {};
      try {
        holidayOf = await fetchHolidayMap(requestDate);
      } catch (err) {
        console.warn('[預計付款日] 查詢行事曆失敗，改用只排除週末的算法：', err);
      }
      record[F.EXPECTED_PAY_DATE].value = calcExpectedPayDate(requestDate, holidayOf) || null;
      return event;
    };

    KT.on(['app.record.create.submit', 'app.record.edit.submit'], handleSubmit);

    /**
     * 畫面：預計付款日鎖住，並在旁邊的空白欄位顯示付款說明。
     */
    const handleShow = (event) => {
      const record = event.record;
      const field = record[F.EXPECTED_PAY_DATE];
      if (!field) return event;
      if (event.type !== 'app.record.detail.show' && event.type !== 'app.record.print.show') field.disabled = true;
      const space = KT.record().getSpaceElement(C.SPACES.EXPECTED_PAY_DATE_NOTE);
      if (space) {
        space.textContent = `※ ${CFG.NOTE}`;
        space.classList.add('pr-expected-pay-note'); // 樣式在 payment_request.css
      }
      return event;
    };

    KT.on(['app.record.create.show', 'app.record.edit.show', 'app.record.detail.show', 'app.record.print.show'], handleShow);

    window.PR_EXPECTED_PAY_DATE = Object.freeze({ calcExpectedPayDate, isWorkday, nextPayDayOnOrAfter, fetchHolidayMap, handleSubmit, handleShow });
  })();

  (() => {

    // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
    const KT = window.PR_KT;

    const F = window.PR_CONFIG.FIELDS;
    const BUTTON_ID = 'same-applicant-btn';

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
          alert(applicantInfo.error);
          return;
        }

        // 將 fullName 寫入受款人欄位
        record[F.PAYEE].value = applicantInfo.fullName;

        // 更新記錄
        KT.record().set({ record: record });

        // 顯示成功訊息（淡出動畫在 payment_request.css 的 .pr-copied-msg）
        const successMsg = document.createElement('span');
        successMsg.textContent = ' ✓ 已複製';
        successMsg.className = 'pr-copied-msg';

        button.parentNode.appendChild(successMsg);
        setTimeout(() => {
          successMsg.remove();
        }, 2000);
      });

      return button;
    }

    // 在編輯和新增頁面顯示按鈕（已掛過就不重複掛）
    function handleShow(event) {
      const spaceElement = KT.record().getSpaceElement(window.PR_CONFIG.SPACES.APPLY_BUTTON);
      if (spaceElement && !document.getElementById(BUTTON_ID)) {
        spaceElement.appendChild(createSameApplicantButton());
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

    window.PR_PAYEE = Object.freeze({ getApplicantInfo, handleShow, autoFillPayee });
  })();

  (function () {

    // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
    const KT = window.PR_KT;

    // =============================================================================
    // 建單後自動推進流程狀態
    //
    // 移植來源：「內部往來請求表」App 的 `src/重構更新版/13_main_20260622.js`
    //   之 `_advanceToApplying()` 與其草稿補償機制 `_compensateDraftIfNeeded()`。
    //
    // 【解決什麼問題】kintone 新增記錄後，狀態會停在流程的第一個狀態，使用者必須再回到
    //   詳細頁手動按一次動作按鈕才會進到下一關。本模組在 create.submit.success 代打一次
    //   `/k/v1/record/status`，讓單子存檔後直接落在下一個狀態。
    //
    // 【要改狀態／動作名稱看這裡】本檔不放任何設定值，一律取自
    //   `payment_request_config.js` 的 `AUTO_ADVANCE`（單一事實來源）。
    //   前後狀態 ①FROM_STATUS ②TO_STATUS 接 STATUS 註冊表、③ACTION_NAME 接 ACTIONS 註冊表，
    //   改 config 一處即全專案同步。
    // =============================================================================

    const C = window.PR_CONFIG;
    const F = C.FIELDS;
    const CONFIG = C.AUTO_ADVANCE;

    // ── 共用工具 ───────────────────────────────────────────────────────────────

    // VOID_FIELD 是「表單作廢」核取方塊欄位代碼，與 STATUS.VOID 狀態值語意不同（見 config 註解）
    const isVoided = (record) => (record?.[C.VOID_FIELD]?.value?.length || 0) > 0;

    const getStatus = (record) => record?.[F.STATUS_FIELD]?.value || '';

    // 逾時包裝：kintone.api 若因網路／後台問題「既不 resolve 也不 reject」，
    // 會把整個 submit.success 卡住（畫面永久轉圈）。以此把「無回應」轉成明確的 reject。
    const withTimeout = (promise, ms, label) =>
      Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}逾時（超過 ${ms / 1000} 秒未回應）`)), ms)),
      ]);

    /**
     * 組出 /k/v1/record/status 的 request body
     * @param {string|number} recordId 記錄 ID
     * @param {string} assigneeCode 作業者帳號 code
     * @returns {Object} PUT body
     */
    const buildStatusBody = (recordId, assigneeCode) => {
      const body = {
        app: C.APPS.PAYMENT,
        id: String(recordId),
        action: CONFIG.ACTION_NAME,
      };
      if (CONFIG.SEND_ASSIGNEE && assigneeCode) {
        body.assignee = assigneeCode;
      }
      return body;
    };

    // ── 流程推進 ───────────────────────────────────────────────────────────────

    /**
     * 將記錄從 FROM_STATUS 推進至 TO_STATUS（失敗時指數退避重試）
     * @param {string|number} recordId 記錄 ID
     * @param {string} assigneeCode 作業者帳號 code（通常為建立者＝登入者）
     * @param {Object} opts
     * @param {number} opts.maxRetries 最多重試次數
     * @param {boolean} opts.silent 失敗時是否靜默不彈窗
     * @returns {Promise<boolean>} 成功回傳 true，失敗回傳 false
     */
    async function advanceStatus(recordId, assigneeCode, { maxRetries = 3, silent = false } = {}) {
      const body = buildStatusBody(recordId, assigneeCode);
      let lastErr;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await withTimeout(kintone.api(kintone.api.url('/k/v1/record/status', true), 'PUT', body), CONFIG.TIMEOUT_MS, '流程推進');
          return true;
        } catch (err) {
          lastErr = err;
          console.warn(`[流程自動推進] 推進失敗，第 ${attempt}/${maxRetries} 次：`, err);
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, 800 * attempt)); // 指數退避
          }
        }
      }

      console.error('[流程自動推進] 已耗盡重試次數：', lastErr);
      if (!silent && typeof Swal !== 'undefined') {
        await Swal.fire({
          icon: 'error',
          title: '流程推進失敗',
          text: (lastErr && lastErr.message) || String(lastErr),
          confirmButtonText: '確定',
        });
      }
      return false;
    }

    // ── 詳細頁補償 ─────────────────────────────────────────────────────────────

    // sessionStorage 安全存取（無痕／停用時退回 module 變數，至少在本次 page load 內有效）
    const _guardFallback = new Set();
    const guardGet = (key) => {
      try {
        return sessionStorage.getItem(key) === '1';
      } catch (e) {
        return _guardFallback.has(key);
      }
    };
    const guardSet = (key) => {
      try {
        sessionStorage.setItem(key, '1');
      } catch (e) {
        _guardFallback.add(key);
      }
    };
    const guardClear = (key) => {
      try {
        sessionStorage.removeItem(key);
      } catch (e) {
        _guardFallback.delete(key);
      }
    };

    /**
     * 判斷這筆記錄是否該在詳細頁自動補推一次（純函式，供測試）
     * 僅限本人（申請人或建立人）觸發，避免他人瀏覽時誤打 API。
     * @param {Object} record kintone 記錄物件
     * @param {string} loginCode 登入者帳號 code
     * @returns {boolean}
     */
    const shouldCompensate = (record, loginCode) => {
      if (!CONFIG.ENABLED || !CONFIG.COMPENSATE_ON_DETAIL) return false;
      if (!record || isVoided(record)) return false;
      if (getStatus(record) !== CONFIG.FROM_STATUS) return false;

      const recordId = String(record.$id?.value || '');
      if (!recordId || recordId === '0') return false;
      if (!loginCode) return false;

      const applicantCode = record[F.APPLICANT]?.value?.[0]?.code;
      // '建立人' 為 kintone 內建欄位，非本表單自訂欄位，故不進 PR_CONFIG.FIELDS
      const creatorCode = record['建立人']?.value?.code;

      return loginCode === applicantCode || loginCode === creatorCode;
    };

    /**
     * 詳細頁補償：處理 create.submit.success 因頁面跳轉導致請求被中斷的情況
     * @param {Object} record kintone 記錄物件
     */
    async function compensateIfNeeded(record) {
      const loginCode = kintone.getLoginUser()?.code || '';
      if (!shouldCompensate(record, loginCode)) return;

      const recordId = String(record.$id.value);
      const creatorCode = record['建立人']?.value?.code || loginCode;

      // ⚠️ 防無限 reload：每筆記錄每個分頁 session 僅自動補償一次。
      //   若上次已嘗試過、reload 後狀態仍停在 FROM_STATUS（推進成功但狀態未前進），
      //   此處直接跳出，不再 reload、不再打 API，避免迴圈把 session 打掛導致登出。
      const guardKey = `${CONFIG.GUARD_PREFIX}${recordId}`;
      if (guardGet(guardKey)) {
        console.warn('[流程自動推進] 已嘗試過補償，跳過以避免重載迴圈。請確認流程管理設定或聯繫管理員。');
        if (typeof Swal !== 'undefined') {
          Swal.fire({ icon: 'warning', title: `此單仍停在「${CONFIG.FROM_STATUS}」，請手動執行「${CONFIG.ACTION_NAME}」`, timer: 4000, showConfirmButton: false });
        }
        return;
      }

      if (typeof Swal !== 'undefined') {
        Swal.fire({ icon: 'info', title: '流程處理中…', timer: 3000, showConfirmButton: false });
      }

      // 先設旗標：即使本次推進「成功但狀態未變」，reload 後也不會再次進入（迴圈最多一圈）
      guardSet(guardKey);

      const ok = await advanceStatus(recordId, creatorCode, { maxRetries: CONFIG.COMPENSATE_MAX_RETRIES, silent: false });

      if (ok) {
        window.location.reload();
      } else {
        // 失敗本來就不 reload（無迴圈風險）；清除旗標，讓使用者下次開啟可重試
        guardClear(guardKey);
      }
    }

    // ── 事件註冊 ───────────────────────────────────────────────────────────────

    // 新建單後自動推進。
    // silent = true：建單後頁面立即跳轉，請求可能被中斷；失敗時靜默，補償交由 detail.show 接手。
    KT.on('app.record.create.submit.success', async (event) => {
      if (!CONFIG.ENABLED || isVoided(event.record)) return event;

      const creatorCode = kintone.getLoginUser()?.code || '';
      await advanceStatus(event.recordId, creatorCode, { maxRetries: CONFIG.CREATE_MAX_RETRIES, silent: true });

      return event;
    });

    // SHOW handler 禁止 async（kintone 不等 Promise），須透過 setTimeout 脫離同步流程後再呼叫
    KT.on('app.record.detail.show', (event) => {
      setTimeout(() => compensateIfNeeded(event.record), 0);
      return event;
    });
  })();

  (function () {

    // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
    const KT = window.PR_KT;

    const CONFIG = {
      ACTION_NAME: window.PR_CONFIG.ACTIONS.VOID,
      TARGET_STATE: window.PR_CONFIG.STATUS.VOID,
      CONFIRM_TEXT: '作廢',
    };

    function getSafeValue(obj) {
      if (!obj) return '';
      if (typeof obj === 'string') return obj;
      if (typeof obj.value !== 'undefined') return obj.value;
      if (typeof obj.name !== 'undefined') return obj.name;
      return '';
    }

    function isVoidAction(event) {
      const actionName = getSafeValue(event.action);
      const nextStatus = getSafeValue(event.nextStatus);
      return actionName === CONFIG.ACTION_NAME || nextStatus === CONFIG.TARGET_STATE;
    }

    KT.on('app.record.detail.process.proceed', function (event) {
      if (!isVoidAction(event)) {
        return event;
      }

      const recordId = event.record.$id ? event.record.$id.value : '';
      const currentStatus = getSafeValue(event.status);
      const nextStatus = getSafeValue(event.nextStatus) || CONFIG.TARGET_STATE;
      const actionName = getSafeValue(event.action) || CONFIG.ACTION_NAME;

      if (typeof Swal === 'undefined') {
        const input = window.prompt(
          `您即將執行「${actionName}」。\n` +
            `目前狀態：${currentStatus}\n` +
            `變更後狀態：${nextStatus}\n` +
            `記錄號碼：${recordId}\n\n` +
            `請輸入「${CONFIG.CONFIRM_TEXT}」以確認：`,
        );
        return input === CONFIG.CONFIRM_TEXT ? event : false;
      }

      return Swal.fire({
        icon: 'warning',
        title: '請確認是否真的要作廢',
        html:
          // 樣式在 payment_request.css（.pr-void-*）
          '<div class="pr-void-confirm">' +
          '<div>您即將執行 <b class="pr-void-action">「' +
          actionName +
          '」</b>。</div>' +
          '<div>目前狀態：<b>' +
          currentStatus +
          '</b></div>' +
          '<div>變更後狀態：<b class="pr-void-next">' +
          nextStatus +
          '</b></div>' +
          '<div>記錄號碼：<b>' +
          recordId +
          '</b></div>' +
          '<br>' +
          '<div>若確認要繼續，請在下方輸入：<b>' +
          CONFIG.CONFIRM_TEXT +
          '</b></div>' +
          '</div>',
        input: 'text',
        inputPlaceholder: '請輸入「作廢」',
        showCancelButton: true,
        confirmButtonText: '送出',
        cancelButtonText: '取消',
        confirmButtonColor: '#d4380d',
        reverseButtons: true,
        focusCancel: true,
        preConfirm: function (value) {
          if (value !== CONFIG.CONFIRM_TEXT) {
            Swal.showValidationMessage('請正確輸入「' + CONFIG.CONFIRM_TEXT + '」才能繼續');
            return false;
          }
          return true;
        },
      }).then(function (result) {
        if (result.isConfirmed) {
          return event;
        }
        return false;
      });
    });
  })();

  (() => {

    // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
    const KT = window.PR_KT;

    const F = window.PR_CONFIG.FIELDS;
    const TABLE_CODE = F.TRAFFIC_TABLE.CODE;
    const INVOICE_CODE = F.TRAFFIC_TABLE.COLS.INVOICE_NO;
    const INVOICE_AGG_CODE = F.INVOICE_AGG;
    const SEP = window.PR_CONFIG.SEP;

    // 從交通費子表格取得發票清單
    function getInvoiceList(record) {
      const rows = record[TABLE_CODE]?.value || [];
      return rows.map((r) => (r.value?.[INVOICE_CODE]?.value || '').trim()).filter((v) => v.length > 0);
    }

    // 彙整發票號碼（去重）：頭尾也加分隔字元，方便用「包含」搜尋單一號碼
    function buildInvoiceAgg(record) {
      const unique = [...new Set(getInvoiceList(record))];
      return unique.length ? `${SEP}${unique.join(SEP)}${SEP}` : '';
    }

    const allEvents = [
      `app.record.create.change.${TABLE_CODE}`,
      `app.record.edit.change.${TABLE_CODE}`,
      `app.record.create.change.${INVOICE_CODE}`,
      `app.record.edit.change.${INVOICE_CODE}`,
    ];

    KT.on(allEvents, (event) => {
      event.record[INVOICE_AGG_CODE].value = buildInvoiceAgg(event.record);
      return event;
    });

    window.PR_INVOICE_AGG = Object.freeze({ buildInvoiceAgg });
  })();

  (() => {

    // 「帶入的資料_開發人員用」群組欄位只給 ADMIN_USERS 看
    // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
    const KT = window.PR_KT;
    const C = window.PR_CONFIG;

    KT.on(['app.record.create.show', 'app.record.edit.show', 'app.record.detail.show'], (event) => {
      KT.record().setFieldShown(C.FIELDS.DEV_ONLY_DATA, C.ADMIN_USERS.includes(kintone.getLoginUser().code));
      return event;
    });
  })();

})();
//# sourceMappingURL=payment_request_mobile.js.map
