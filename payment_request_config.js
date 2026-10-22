(() => {
  'use strict';

  // =============================================================================
  // 交通費請款單（測試區 App 749）共用設定檔 —— 單一事實來源
  //
  // 【載入順序】此檔必須排在 kintone「JavaScript 自訂」清單的「最上面」，
  //   其餘檔案才能透過 window.PR_CONFIG 取用。
  // =============================================================================

  // ── App ID 對照 ─────────────────────────────────────────────────────────────
  const APPS = Object.freeze({
    PAYMENT: kintone.app.getId(), // 本 App（交通費請款單），動態取得
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
    STATUS,
    ACTIONS,
    AUTO_ADVANCE,
    OPTIONS,
    TRAFFIC_RULES,
    COST_SCOPE,
    isAdmin,
  });
})();
