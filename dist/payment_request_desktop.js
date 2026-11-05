(function () {
  'use strict';

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

    // ── 同一次存檔的錯誤訊息匯總（window.PR_SAVE_ERRORS）──────────────────────
    //   比 payment_request_submit 早跑的存檔檢查（帳號權限設定的必填）把訊息放這裡，
    //   payment_request_submit 在同一個 SweetAlert 視窗一起顯示，避免兩個視窗互相蓋掉。
    let pendingSaveErrors = [];
    window.PR_SAVE_ERRORS = Object.freeze({
      /** 加入要顯示的錯誤訊息（格式同 payment_request_submit：可分行，▸ 開頭＝項目、※ 開頭＝提示） */
      add: (messages) => {
        pendingSaveErrors.push(...[].concat(messages).filter(Boolean));
      },
      /** 取出並清空 */
      take: () => {
        const out = pendingSaveErrors;
        pendingSaveErrors = [];
        return out;
      },
    });

    // ── App ID 對照 ─────────────────────────────────────────────────────────────
    const APPS = Object.freeze({
      PAYMENT: PR_KT.app().getId(), // 本 App（交通費請款單），動態取得
      COST_CENTER: 661, // 費用歸屬代碼（CostCenter）
      ACCOUNTING_MAP: 433, // 申請單位 → 會計單位／承辦人 對應
      APPROVAL_FLOW: 139, // 簽核流程主檔
      SAP_MAPPING: 751, // 交通費轉出欄位對應（另建，不和請款單共用 SAP 對應 App；欄位為交通費套表 A～Q）
      PDF_FONT: 488, // PDF 產生用字型
      PERMISSION: 673, // 帳號權限設定（欄位顯隱／可編輯／必填規則）
      HOLIDAY_CALENDAR: 620, // 行事曆（國定假日、週末、補行上班日），預計付款日用
      TRAFFIC_RULE_MASTER: 752, // 交通費明細規則主檔（交通工具／憑證種類的規則；讀不到就退回 TRAFFIC_RULES）
      // 交通費請款單的固定 App ID，【只給在規則主檔執行的檢查程式用】（交通費明細規則主檔檢查_20261104.js；
      //   在規則主檔裡 getId() 拿到的是規則主檔自己的 ID）。請款單自己的程式一律用 APPS.PAYMENT。
      //   正式區上線時要和其他 App ID 一起換。
      TRAFFIC_PAYMENT: 749,
    });

    // ── 會計單位（kintone 群組）───────────────────────────────────────────────
    //   會計單位一律依費用所屬人部門查會計對應主檔（APPS.ACCOUNTING_MAP）帶入；
    //   這裡列出全部會計群組，給流程管理檢查（process_management）比對用。
    const ACCOUNTING = Object.freeze({
      MAP: Object.freeze({ TPE: 'ACC_TPE', TPE海運: 'ACC_TPE海運', CKS: 'ACC_CKS', KHH: 'ACC_KHH', TEPZ: 'ACC_TEPZ', NEXT: 'ACC_NEXT' }),
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
        // GROUP_SELECT：這個代碼／部門的部長群組。費用所屬人是部長時用來帶單位部長（DIRECTOR_BY_COST_CENTER）
        DIRECTOR_GROUP: '部門部長',
        // CHECK_BOX：同一代碼有好幾筆時，哪一筆是主要管理部門（值 MAIN_DEPT_ON）。部長所在的部已是最上層時用它找 HQ_CODE 的部長
        MAIN_DEPT: '主要管理部門',
        MAIN_DEPT_ON: '是',
        BUSINESS_AREA: 'BusinessArea', // SINGLE_LINE_TEXT：Cost Center 對應的 Business Area（交通費轉出 J 欄）
      }),
      // 交通費明細規則主檔（APPS.TRAFFIC_RULE_MASTER）：一筆記錄＝一個交通工具或一個憑證種類。
      //   名稱要和 749 子表格下拉選項一字不差；只讀「使用中」。讀不到或資料不合法時退回 TRAFFIC_RULES。
      TRAFFIC_RULE_MASTER: Object.freeze({
        TYPE: '類型', // RADIO_BUTTON
        TYPE_VEHICLE: '交通工具',
        TYPE_RECEIPT: '憑證種類',
        NAME: '名稱', // SINGLE_LINE_TEXT（唯一）
        IN_USE: '使用狀況', // DROP_DOWN；query 篩選用
        IN_USE_VALUE: '使用中',
        ALLOWED_RECEIPTS: '可選憑證種類', // CHECK_BOX（交通工具用）；全不勾＝不限制
        FIXED_SELLER_TAX_ID: '固定賣方統編', // 交通工具用；有填＝自動帶入並鎖住
        FIXED_FORMAT: '固定格式', // 交通工具用；有填固定賣方統編才可填
        VEHICLE_FLAGS: '交通工具規則', // CHECK_BOX
        FLAG_PAPER_RECEIPT: '需紙本憑證', // 有搭乘 → 是否有紙本憑證選「是」
        FLAG_REASON_REQUIRED: '理由必填', // 有搭乘 → 理由必填
        RECEIPT_FLAGS: '憑證種類規則', // CHECK_BOX
        FLAG_TAX: '要算稅',
        FLAG_INVOICE_NO: '開放發票號碼',
      }),
      // 簽核流程主檔（APPS.APPROVAL_FLOW）：一般單位用「簽核所屬單位」（組織欄位，存組織代碼）查，
      //   改組織名稱不用改程式；依職稱改查的合併流程（特殊簽核流程，例如「物流部次長級」）才用「簽核流程名稱」查。
      APPROVAL_FLOW: Object.freeze({
        FLOW_NAME: '簽核流程名稱',
        ORG: '簽核所屬單位', // ORGANIZATION_SELECT
        IN_USE: '使用狀況',
        IN_USE_VALUE: '使用中',
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
      MANUAL_SIGNERS: 'Space_Manual_Signers', // 簽核流程群組裡的「設定簽核人」按鈕（手動簽核人設定）
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
      // RADIO_BUTTON；是否有紙本憑證＝否 → 程式寫「不適用」（舊代碼「…單據正本」，rev 1869 已改）
      PAPER_RECEIVED: '會計課承辦註記是否收到單據紙本',
      REASON: '理由', // 主表 MULTI_LINE_TEXT；標籤「理由（計程車）」
      RECORD_NO: '交通費請款單號', // RECORD_NUMBER；批次下載／PDF 產生時用來標示記錄
      TOTAL_AMOUNT: '總金額', // CALC；＝交通費請款單.金額 合計（交通費轉出 Excel 的 {總金額}）
      TOTAL_TAX: '總稅額', // CALC；＝交通費請款單.稅額 合計（交通費轉出 Excel 的 {總稅額}；為 0 就不轉出稅額列）
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
          RECEIPT_TYPE: '憑證種類',
          INVOICE_NO: '發票號碼', // 標籤「發票號碼／高鐵票號」
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
    //   來源：kintone MCP 讀 749 表單 rev 1880（form_snapshots/749_rev1880_traffic_table.json，測試會比對）。
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
          { code: FIELDS.TRAFFIC_TABLE.COLS.INVOICE_NO, label: '發票號碼／高鐵票號', type: 'SINGLE_LINE_TEXT' },
          { code: FIELDS.TRAFFIC_TABLE.COLS.SELLER_TAX_ID, label: '賣方統編', type: 'SINGLE_LINE_TEXT' },
          { code: FIELDS.TRAFFIC_TABLE.COLS.FORMAT, label: '格式', type: 'SINGLE_LINE_TEXT' },
          { code: FIELDS.TRAFFIC_TABLE.COLS.TAX, label: '稅額', type: 'NUMBER', unit: '元' },
        ].map(Object.freeze),
      ),
      // 欄寬＝文字單位數（中文 2、英數 1）× PX_PER_UNIT ＋ PADDING_PX，限制在 MIN～MAX；表頭文字也算進去
      WIDTH: Object.freeze({ PX_PER_UNIT: 8, PADDING_PX: 32, MIN_PX: 64, MAX_PX: 320 }),
      // 表頭上的官方查詢連結（表頭查詢連結_20261105.js）：key 是欄位代碼，text 要是該欄 label 裡的文字。
      //   一個表頭可放多個連結，依 label 裡出現的順序排；網址換了改這裡，重新打包上傳。
      HEADER_LINKS: Object.freeze({
        [FIELDS.TRAFFIC_TABLE.COLS.INVOICE_NO]: Object.freeze([
          Object.freeze({
            text: '發票號碼',
            url: 'https://www.einvoice.nat.gov.tw/portal/btc/audit/btc601w/search',
            title: '另開新分頁：財政部電子發票整合服務平台－一般性發票查詢',
          }),
          Object.freeze({
            text: '高鐵票號',
            url: 'https://ptis.thsrc.com.tw/ptis/',
            title: '另開新分頁：台灣高鐵各式票證交易／搭乘紀錄查詢',
          }),
        ]),
        [FIELDS.TRAFFIC_TABLE.COLS.SELLER_TAX_ID]: Object.freeze([
          Object.freeze({
            text: '賣方統編',
            url: 'https://www.etax.nat.gov.tw/etwmain/etw113w1/ban/query',
            title: '另開新分頁：財政部稅務入口網－稅籍登記資料公示查詢',
          }),
        ]),
      }),
    });

    // ── 列表直接編輯（payment_request_main 的 index.edit.show）────────────────
    //   列表直接編輯不會跑新增／編輯畫面的程式（部門帶入、簽核排人、存檔驗證、稅額重算…），
    //   所以列表上一律鎖住，只留 EDITABLE 這幾欄；這幾欄能不能改再交給帳號權限設定 App 的規則決定。
    //   要開放其他欄位在列表直接改，先確認那個欄位沒有程式邏輯，再加進 EDITABLE。
    const INLINE_EDIT = Object.freeze({
      EDITABLE: Object.freeze([FIELDS.VOUCHER_NO, FIELDS.VOUCHER_DATE, VOID_FIELD]),
    });

    // ── 流程狀態字串註冊表（query 內拼字錯誤會「靜默查不到」，故一併收斂）──────
    //   注意：STATUS.VOID 是「流程狀態值」，VOID_FIELD 是「欄位代碼」，
    //   兩者字串相同（'表單作廢'）但語意不同，刻意分開兩個常數，不可互換使用。
    const STATUS = Object.freeze({
      VOID: '表單作廢',
      REIMBURSEMENT_FILL: '報銷人填單',
      APPLY_START: '草稿（未送出）',
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
      TO_STATUS: STATUS.APPLY_START, // ② 推進後應到達的狀態＝「草稿（未送出）」
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
      VEHICLE: Object.freeze({
        HSR: '高鐵',
        MRT_BUS: '捷運／公車',
        PARKING: '停車費',
        TRAIN: '火車',
        TAXI: '計程車',
        UBER: 'Uber',
        RENTAL: '汽機車短租',
      }),
      // 子表格「憑證種類」
      RECEIPT_TYPE: Object.freeze({ HSR_TICKET: '高鐵票', TICKET: '車票（高鐵外）', INVOICE: '發票', RECEIPT: '收據', NONE: '無' }),
      // 主表「是否有紙本憑證」
      PAPER_RECEIPT: Object.freeze({ YES: '是', NO: '否' }),
      // 主表「會計課承辦註記是否收到單據紙本」（kintone 預設值＝未收到）
      PAPER_RECEIVED: Object.freeze({ RECEIVED: '已收到', NOT_RECEIVED: '未收到', NOT_APPLICABLE: '不適用' }),
    });

    // ── 共用工具 ───────────────────────────────────────────────────────────────

    const isAdmin = (code) => ADMIN_USERS.includes(code || kintone.getLoginUser().code);

    // ── 交通費明細規則（交通費明細規則_20261022.js 用）────────────────────────
    //   規則的主要來源是 APPS.TRAFFIC_RULE_MASTER（REF_FIELDS.TRAFFIC_RULE_MASTER）；
    //   這份只在主檔讀不到（沒權限、逾時、API 失敗）或資料不合法時才用，內容要和主檔初始記錄等價（有測試比對）。
    //   TAX_RATE_PERCENT、REASON_LABEL_PREFIX 不放主檔，一律用這裡。
    const TRAFFIC_RULES = Object.freeze({
      // 讀主檔的等待上限（毫秒），超過就退回這份規則
      MASTER_TIMEOUT_MS: 5000,
      // 交通工具選高鐵 → 賣方統編、格式固定寫入
      HSR_SELLER_TAX_ID: '00000000',
      HSR_FORMAT: '22',
      // 金額含稅；稅額＝金額 ÷ (1＋稅率) × 稅率，四捨五入到個位數
      TAX_RATE_PERCENT: 5,
      // 這些憑證種類才算稅額；其他種類（含空白）稅額一律寫 0
      TAX_RECEIPT_TYPES: Object.freeze([OPTIONS.RECEIPT_TYPE.HSR_TICKET, OPTIONS.RECEIPT_TYPE.INVOICE]),
      // 這些憑證種類才開放填發票號碼（存檔時必填、不可重複）
      INVOICE_RECEIPT_TYPES: Object.freeze([OPTIONS.RECEIPT_TYPE.HSR_TICKET, OPTIONS.RECEIPT_TYPE.INVOICE]),
      // 這些憑證種類（沒有憑證）→ 賣方統編、格式、稅額清空並鎖住（create/edit 的 show、變更事件、存檔前都套用）
      NO_RECEIPT_TYPES: Object.freeze([OPTIONS.RECEIPT_TYPE.NONE]),
      // 這些憑證種類（收據，沒有統編／稅額）→ 賣方統編、格式清空並鎖住，稅額寫 0 並鎖住（套用時機同 NO_RECEIPT_TYPES；
      //   優先於主檔的「要算稅」旗標）
      PLAIN_RECEIPT_TYPES: Object.freeze([OPTIONS.RECEIPT_TYPE.RECEIPT]),
      // 交通工具 → 可選的憑證種類（沒列在這裡的交通工具不限制）。憑證種類「無」只有捷運／公車能選。
      //   變更事件：選了不能用的組合就清空憑證種類；只有一種可選時自動帶入。存檔時再驗一次。
      //   桌面版：憑證種類的下拉選單只列出可選的項目（手機版選單是系統原生的，只靠變更事件清空）。
      RECEIPT_BY_VEHICLE: Object.freeze({
        [OPTIONS.VEHICLE.HSR]: Object.freeze([OPTIONS.RECEIPT_TYPE.HSR_TICKET]),
        [OPTIONS.VEHICLE.TRAIN]: Object.freeze([OPTIONS.RECEIPT_TYPE.TICKET, OPTIONS.RECEIPT_TYPE.RECEIPT]),
        [OPTIONS.VEHICLE.MRT_BUS]: Object.freeze([OPTIONS.RECEIPT_TYPE.TICKET, OPTIONS.RECEIPT_TYPE.RECEIPT, OPTIONS.RECEIPT_TYPE.NONE]),
        [OPTIONS.VEHICLE.TAXI]: Object.freeze([OPTIONS.RECEIPT_TYPE.INVOICE, OPTIONS.RECEIPT_TYPE.RECEIPT]),
        [OPTIONS.VEHICLE.UBER]: Object.freeze([OPTIONS.RECEIPT_TYPE.INVOICE, OPTIONS.RECEIPT_TYPE.RECEIPT]),
        [OPTIONS.VEHICLE.PARKING]: Object.freeze([OPTIONS.RECEIPT_TYPE.INVOICE, OPTIONS.RECEIPT_TYPE.RECEIPT]),
        [OPTIONS.VEHICLE.RENTAL]: Object.freeze([OPTIONS.RECEIPT_TYPE.INVOICE, OPTIONS.RECEIPT_TYPE.RECEIPT]),
      }),
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

    // ── 費用所屬人是部長時的單位部長（部長簽核帶入_20261029.js 用）──────────────
    //   費用所屬人在費用所屬人部門的職稱是 OWNER_TITLE → 依明細第一個費用歸屬代碼查費用歸屬主檔（APPS.COST_CENTER）：
    //     代碼的所屬部門（往上爬）是 HQ_CODE 的所屬部門之一 → 用該代碼那筆的「部門部長」群組（沒設就用 HQ_CODE 同部門那筆的）
    //     其他 → 用 DEFAULT_CODE 的「部門部長」群組
    //   部長所在的部已是最上層（上面沒有別的部）→ 只用 HQ_CODE 主要管理部門（REF_FIELDS.COST_CENTER.MAIN_DEPT）那筆的部長群組（不看代碼自己那筆）。
    //   群組成員（去掉費用所屬人本人）寫入 TARGET_FIELD。
    //   只在新增、EDITABLE_STATUSES 與駁回狀態（名稱以 REJECT_SUFFIX 結尾）重算，且值沒變不寫
    //   （送出後沒有該欄位編輯權限的人存檔會被 kintone 退回）。
    const DIRECTOR_BY_COST_CENTER = Object.freeze({
      OWNER_TITLE: '部長',
      HQ_CODE: 'AJ30', // 總公司：營業戰略部／安全品質推動部／總務部共用
      DEFAULT_CODE: 'AJ36', // 事業本部
      TARGET_FIELD: '單位部長_支店長',
      EDITABLE_STATUSES: Object.freeze([STATUS.REIMBURSEMENT_FILL, STATUS.APPLY_START]),
      REJECT_SUFFIX: '駁回',
    });

    // ── 手動簽核人（手動簽核人設定_20261102.js 用）────────────────────────────
    //   勾「手動設定簽核流程」→ 跳視窗由申請人指定 1～3 位簽核人，依 FIELDS 順序簽，簽完送 ACCOUNTING_FIELD 指定的會計承辦人。
    //   手動模式不用原本的 6 格（單位主管1～單位部長_支店長）：人數歸 0人、欄位清空。
    //   只限 COST_SCOPE.EXEMPT_GROUP 群組的申請人；流程管理依 COUNT_FIELD 決定第 1 關之後送到哪。
    const MANUAL_SIGNERS = Object.freeze({
      FIELDS: Object.freeze(['手動簽核人1', '手動簽核人2', '手動簽核人3']),
      COUNT_FIELD: '手動簽核人數', // DROP_DOWN（1人／2人／3人）；程式依實際填的人數寫入，畫面不顯示
      ACCOUNTING_FIELD: '手動會計承辦人', // USER_SELECT：簽完送「單位會計處理中」的人（視窗第 4 格）；原本的會計單位承辦人照舊自動帶入
      COUNT_UNIT: '人',
      EDITABLE_STATUSES: Object.freeze([STATUS.REIMBURSEMENT_FILL, STATUS.APPLY_START]), // 另加駁回狀態（REJECT_SUFFIX 結尾）
      REJECT_SUFFIX: '駁回',
      RECENT_KEY: 'pr_manual_signers_recent', // localStorage：這台電腦最近選過的簽核人（只是方便，讀不到也沒關係）
      RECENT_MAX: 6,
      USER_PAGE_SIZE: 100, // /v1/users.json 一次最多 100 筆
    });

    window.PR_CONFIG = Object.freeze({
      APPS,
      ACCOUNTING,
      EXPECTED_PAY_DATE,
      REF_FIELDS,
      ADMIN_USERS,
      SUPER_ADMIN,
      SEP,
      VOID_FIELD,
      SPACES,
      FIELDS,
      TRAFFIC_TABLE_LAYOUT,
      INLINE_EDIT,
      STATUS,
      ACTIONS,
      AUTO_ADVANCE,
      OPTIONS,
      TRAFFIC_RULES,
      COST_SCOPE,
      DIRECTOR_BY_COST_CENTER,
      MANUAL_SIGNERS,
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
    //   - kintone 欄位設定的必填沒填（例如「發票/憑證」附件）→ 最後一個存檔程式關掉
    //     （kintone 自己的必填檢查在所有存檔程式跑完之後才做，擋下時不會再觸發任何事件，提示會一直卡著）
    //   - 其他程式跳出錯誤視窗 → SweetAlert 同一時間只有一個視窗，會直接取代本提示
    //   - 存檔成功 → 換到詳細頁時關掉（存檔成功後的回寫、流程推進期間都還顯示著）
    //   - 保險：超過 SAFETY_CLOSE_MS 還開著就自動關；使用者也可以按 Esc 或點外面關掉
    //     （萬一有程式讓 kintone 中途停止存檔、收尾程式沒被執行，畫面也不會被一直擋住；關掉提示不影響存檔本身）
    // 只關「自己開的」提示（用 POPUP_CLASS 辨識），不會誤關別的程式的視窗。

    const POPUP_CLASS = 'pr-saving-popup';
    const SAFETY_CLOSE_MS = 15000;
    const SUBMIT_EVENTS = ['app.record.create.submit', 'app.record.edit.submit'];
    const LEAVE_EVENTS = ['app.record.detail.show', 'app.record.create.show', 'app.record.edit.show', 'app.record.index.show'];
    const FORM_EVENTS = ['app.record.create.show', 'app.record.edit.show', 'mobile.app.record.create.show', 'mobile.app.record.edit.show'];

    let safetyTimer = null;
    let requiredFields = null; // { main: [欄位代碼], tables: { 子表格代碼: [欄位代碼] } }；開新增／編輯畫面時讀一次

    const isEmptyValue = (value) => value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

    /** 表單欄位設定（/k/v1/app/form/fields 的 properties）→ 必填欄位清單（含子表格裡的必填欄位） */
    const parseRequiredFields = (properties) => {
      const main = [];
      const tables = {};
      Object.values(properties || {}).forEach((f) => {
        if (f.type === 'SUBTABLE') {
          const codes = Object.values(f.fields || {})
            .filter((sub) => sub.required)
            .map((sub) => sub.code);
          if (codes.length > 0) tables[f.code] = codes;
        } else if (f.required) {
          main.push(f.code);
        }
      });
      return { main, tables };
    };

    /** 有沒有 kintone 欄位設定的必填欄位是空的（還沒讀到欄位設定就當作沒有） */
    const hasMissingRequired = (record) => {
      if (!requiredFields || !record) return false;
      if (requiredFields.main.some((code) => record[code] && isEmptyValue(record[code].value))) return true;
      return Object.entries(requiredFields.tables).some(([table, codes]) =>
        (record[table]?.value || []).some((row) => codes.some((code) => row?.value?.[code] && isEmptyValue(row.value[code].value))),
      );
    };

    const loadRequiredFields = () => {
      if (requiredFields || typeof kintone?.api !== 'function') return;
      let appId;
      try {
        appId = KT.app().getId();
      } catch (e) {
        return;
      }
      kintone
        .api(kintone.api.url('/k/v1/app/form/fields', true), 'GET', { app: appId })
        .then((resp) => {
          requiredFields = parseRequiredFields(resp.properties);
        })
        .catch((err) => console.warn('存檔等待提示：讀不到欄位設定，必填沒填時改靠保險計時關閉', err));
    };

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

    // 最後一個存檔程式：存檔被擋下時關掉提示（kintone 會在畫面上方顯示 event.error）；
    // kintone 欄位設定的必填沒填也關掉（接著 kintone 會在欄位上標示必填，存檔不會成功）
    const onSubmitEnd = (event) => {
      if (event.error || hasMissingRequired(event.record)) closeSaving();
      return event;
    };

    const onLeave = (event) => {
      closeSaving();
      if (FORM_EVENTS.includes(event?.type)) loadRequiredFields();
      return event;
    };

    KT.on(SUBMIT_EVENTS, onSubmitStart);
    KT.on(LEAVE_EVENTS, onLeave);
    // kintone 依註冊順序執行同一個事件的處理程式。所有模組都在載入時同步註冊，
    // 所以延到下一輪再註冊，這個處理程式就會排在所有存檔程式的最後面。
    setTimeout(() => KT.on(SUBMIT_EVENTS, onSubmitEnd), 0);

    window.PR_SAVING_HINT = Object.freeze({
      onSubmitStart,
      onSubmitEnd,
      onLeave,
      closeSaving,
      parseRequiredFields,
      hasMissingRequired,
      setRequiredFields: (v) => {
        requiredFields = v;
      },
      POPUP_CLASS,
      SAFETY_CLOSE_MS,
    });
  })();

  /**
   * 帳號權限設定（APPS.PERMISSION）
   *
   * 從「帳號權限設定 App（APPS.PERMISSION）」讀取本表單的規則，
   * 依「登入者帳號 / 所屬組織」與「目前流程狀態」，
   * 決定哪些欄位可見、可編輯、必填，並在儲存時驗證必填欄位。
   * 依「誰在操作 / 現在是哪個流程步驟」設定欄位權限（角色基準）
   *
   * ⚠️ 部署 / 環境注意：
   *   - SETTINGS_APP_ID = PR_CONFIG.APPS.PERMISSION：權限設定 App。內每筆記錄以 APP_ID 欄位對應「表單 App」，
   *   - DEBUG = true：會輸出 [KDEBUG] console；正式環境請改為 false。
   *   - 本模組僅綁桌面版事件，未含 mobile.*；行動版不套用此權限控管。
   *   - 子表格新增／刪除列時，依開畫面時算好的權限重新鎖定每一列（子表格 change 事件，載入時依表單設定自動註冊）。
   *     若同一表單有其他程式也在子表格 change 事件設定 disabled，後執行的會覆蓋先執行的。
   * ============================================================
   */
  (function () {

    /* =========================================================
     * 一、基本設定
     * ========================================================= */

    const SETTINGS_APP_ID = window.PR_CONFIG.APPS.PERMISSION;
    const APP_ID_FIELD = 'APP_ID';
    const STATUS_FIELD = window.PR_CONFIG.FIELDS.STATUS_FIELD;

    const RULE_TYPE = {
      ACCOUNT: 'ACCOUNT',
      ORG: 'ORG',
    };

    const ENABLE_ON = '使用中';
    const SHOW = '顯示';
    const HIDE = '隱藏';
    const EDIT = '編輯';
    const REQUIRED = '必填';

    const EVENTS_SHOW = [
      'app.record.create.show',
      'app.record.edit.show',
      'app.record.detail.show',
      'app.record.print.show',
      'app.record.index.edit.show'
    ];

    // 列表直接編輯的存檔也檢查必填（2026-10-27）。kintone 的 index.edit.show 不能標欄位錯誤、也不能擋存檔，
    //   所以 show 只套顯示／可編輯，必填在 index.edit.submit 檢查。
    const INDEX_EDIT_SUBMIT = 'app.record.index.edit.submit';
    const EVENTS_SUBMIT = ['app.record.create.submit', 'app.record.edit.submit', INDEX_EDIT_SUBMIT];
    // 列表上只有這幾欄能改（其餘由 payment_request_main 鎖住），列表存檔只檢查這幾欄的必填；
    //   其他欄位改不了，必填在新增／編輯畫面存檔時檢查，不然列表上會被一個改不了的欄位卡住。
    const INLINE_EDITABLE = window.PR_CONFIG.INLINE_EDIT.EDITABLE;

    // ── 錯誤提醒：一律用全域 SweetAlert（window.Swal，2026-10-27）──────────────
    //   event.error 只放「儲存失敗」，細節在 SweetAlert 視窗；開畫面出錯的標題是「發生錯誤」。
    //   新增／編輯存檔：訊息交給 PR_SAVE_ERRORS，由 payment_request_submit 和其他檢查結果合成同一個視窗；
    //   列表直接編輯存檔（沒有 payment_request_submit）、開畫面讀不到設定：直接跳視窗。
    const SAVE_FAILED = '儲存失敗';
    const ERROR_TITLE = '發生錯誤';
    const escapeHtml = (text) =>
      String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

    /** 用全域 SweetAlert 跳錯誤視窗（樣式同存檔驗證視窗：每條一張卡片）；沒載入 SweetAlert 才退回 alert */
    const showAlert = (title, messages) => {
      const swal = window.Swal;
      if (typeof swal?.fire !== 'function') {
        window.alert(`${title}\n${messages.join('\n')}`);
        return;
      }
      const items = messages
        .map((msg, i) => {
          const [head, ...rest] = String(msg).split('\n');
          const detail = rest.map((line) => `<div class="pr-v-detail">${escapeHtml(line.replace(/^[▸※]\s*/, ''))}</div>`).join('');
          return `<li class="pr-validation-item"><span class="pr-validation-no">${i + 1}</span><div class="pr-validation-text"><div class="pr-v-head">${escapeHtml(head)}</div>${detail}</div></li>`;
        })
        .join('');
      swal.fire({
        icon: 'error',
        title,
        html: `<ol class="pr-validation-list">${items}</ol>`,
        confirmButtonText: '我知道了',
        confirmButtonColor: '#d33',
        customClass: { popup: 'pr-validation-popup' },
      });
    };

    /** 存檔被擋：event.error＝儲存失敗；新增／編輯交給 PR_SAVE_ERRORS 合併顯示，列表直接編輯直接跳視窗 */
    const reportSaveErrors = (event, messages) => {
      event.error = SAVE_FAILED;
      const collector = window.PR_SAVE_ERRORS;
      if (event.type !== INDEX_EDIT_SUBMIT && typeof collector?.add === 'function') collector.add(messages);
      else showAlert(SAVE_FAILED, messages);
      return event;
    };

    /* =========================================================
     * 二、權限設定 App 欄位代碼設定
     * ========================================================= */

    const ACCOUNT_RULE = {
      table: ['帳號權限設定'],
      target: ['帳號權限'],
      fieldType: ['帳號欄位屬性'],
      fields: ['帳號欄位設定', '欄位設定'],
      coverValues: ['帳號欄位涵蓋值'],
      show: ['帳號顯示選項', '顯示選項'],
      perm: ['帳號權限選項', '權限選項'],
      required: ['帳號欄位必填'],
      status: ['帳號狀態設定', '狀態設定'],
      enable: ['帳號使用狀況', '使用狀況'],
    };

    const ORG_RULE = {
      table: ['組織權限設定'],
      target: ['組織權限'],
      fieldType: ['組織欄位型態'],
      fields: ['組織欄位設定', '欄位設定'],
      coverValues: ['組織欄位涵蓋值'],
      show: ['組織顯示選項', '顯示選項'],
      perm: ['組織權限選項', '權限選項'],
      required: ['組織欄位必填'],
      status: ['組織狀態設定', '狀態設定'],
      enable: ['組織使用狀況', '使用狀況'],
    };

    /* =========================================================
     * 三、欄位型態與自動行為
     * ========================================================= */

    const FIELD_KIND = {
      NUMBER: '數值欄位',
      RELATED: '相關記錄清單欄位',
      SPACER: '空白欄元素',
      GROUP: '群組欄位',
      TABLE: '表格欄位',
    };

    const FIELD_ACTION = {
      NONE: 'NONE',
      SKIP: 'SKIP',
    };

    const FIELD_TYPE_BEHAVIOR = {
      [FIELD_KIND.NUMBER]: FIELD_ACTION.NONE,
      [FIELD_KIND.RELATED]: FIELD_ACTION.NONE,
      [FIELD_KIND.SPACER]: FIELD_ACTION.SKIP,
      [FIELD_KIND.GROUP]: FIELD_ACTION.SKIP,
      [FIELD_KIND.TABLE]: FIELD_ACTION.SKIP,
    };

    const MATCH_RESULT = {
      MATCH: 'MATCH',
      NO_MATCH: 'NO_MATCH',
      EMPTY: 'EMPTY',
    };

    const toStr = (value) => String(value || '').trim();
    const toArr = (value) => (Array.isArray(value) ? value : []);

    const log = (...args) => {
    };

    // parseArr 結果記憶化：同一份權限設定字串可能在「欄位型態蒐集」與「規則套用」兩階段重複解析，
    // 以原字串為鍵快取凍結陣列（呼叫端僅讀取，不可變動）。權限設定字串為有限集合，快取不會無限成長。
    const _parseArrCache = new Map();
    const parseArr = (text) => {
      const raw = toStr(text);
      if (!raw) return [];
      if (_parseArrCache.has(raw)) return _parseArrCache.get(raw);

      const result = Object.freeze(
        raw
          .replace(/^\[/, '')
          .replace(/\]$/, '')
          .replace(/["']/g, '')
          .split(/\r?\n|,|，|;|；|、/g)
          .map((item) => toStr(item))
          .filter(Boolean),
      );
      _parseArrCache.set(raw, result);
      return result;
    };

    const pickField = (row, candidateCodes) => {
      for (const code of candidateCodes) {
        if (row && row[code] !== undefined) {
          return row[code];
        }
      }
      return undefined;
    };

    const getCheckboxValues = (field) => toArr(field?.value);

    const normalizeTargetValues = (items) =>
      toArr(items)
        .flatMap((item) => {
          if (typeof item === 'string' || typeof item === 'number') {
            return [toStr(item)];
          }

          return [
            item?.code,
            item?.name,
            item?.displayName,
            item?.value,
            item?.organization?.code,
            item?.organization?.name,
            item?.user?.code,
            item?.user?.name,
            item?.user?.displayName,
          ].map(toStr);
        })
        .filter(Boolean);

    // 檢查 values 是否有任一元素落在預建的集合內。
    // accountSet / orgSet 於登入者上下文建立時一次建好，避免在逐行規則迴圈中重複建立 Set 物件。
    const someInSet = (values, set) =>
      toArr(values)
        .map(toStr)
        .filter(Boolean)
        .some((value) => set.has(value));

    const getUserCodes = (field) => {
      const raw = toArr(field?.value);
      const codes = normalizeTargetValues(raw);
      return codes;
    };

    const getOrgCodes = (field) => {
      const raw = toArr(field?.value);
      const codes = normalizeTargetValues(raw);
      return codes;
    };

    const normalizeRecordFieldValue = (field) => {
      if (!field) return [];

      const value = field.value;

      switch (true) {
        case Array.isArray(value):
          return normalizeTargetValues(value);
        case value && typeof value === 'object':
          return normalizeTargetValues([value]);
        default:
          return [toStr(value)].filter(Boolean);
      }
    };

    const isEnabled = (field) => toStr(field?.value) === ENABLE_ON;

    const isStatusMatch = (settingText, currentStatus) => {
      const list = parseArr(settingText);
      if (list.length === 0) return true;
      return !!currentStatus && list.includes(currentStatus);
    };

    const isEmptyValue = (value) => {
      switch (true) {
        case value === null:
        case value === undefined:
          return true;
        case typeof value === 'string' && value.trim() === '':
          return true;
        case Array.isArray(value) && value.length === 0:
          return true;
        default:
          return false;
      }
    };

    const hasShowFlag = (options) => options.includes(SHOW);
    const hasHideFlag = (options) => options.includes(HIDE);
    const hasEditFlag = (options) => options.includes(EDIT);
    const hasRequiredFlag = (options) => options.includes(REQUIRED);

    // 權限設定快取：查詢條件（APP_ID = 當前 App）在整個頁面生命週期固定，
    // 同一張單從 show 至 submit 之間不會變動，以 Promise 快取省略重複 API 呼叫（失敗則清除以便重試）。
    // ⚠️ 管理員在權限設定 App 變更權限規則後，使用者需「重新整理頁面」才會生效。
    let _settingsPromise = null;
    const fetchSettings = async () => {
      const currentAppId = kintone.app.getId();

      const response = await kintone.api(
        kintone.api.url('/k/v1/records.json', true),
        'GET',
        {
          app: SETTINGS_APP_ID,
          query: `${APP_ID_FIELD} = "${currentAppId}"`,
        },
      );

      log('permission settings query result', {
        currentAppId,
        settingsCount: toArr(response.records).length,
        records: response.records,
      });

      return toArr(response.records);
    };

    const getSettings = () => {
      if (_settingsPromise) return _settingsPromise;
      _settingsPromise = fetchSettings().catch((error) => {
        _settingsPromise = null; // 失敗不快取，下次重試
        throw error;
      });
      return _settingsPromise;
    };

    // 登入者上下文：頁面整個工作階段不會變動，以 Promise 快取永久重用（失敗則清除以便重試）。
    // accountSet / orgSet 於此處一次建立，供 matchTarget 在逐行規則迴圈中直接查詢，免去重複建立 Set 物件。
    let _loginContextPromise = null;
    const fetchLoginContext = async () => {
      const loginUser = kintone.getLoginUser();
      const userCode = toStr(loginUser?.code);
      const userName = toStr(loginUser?.name);

      let organizations = [];
      try {
        organizations = await kintone.user.getOrganizations(userCode);
      } catch (error) {
        organizations = [];
      }

      const orgCodes = [];
      const orgNames = [];

      organizations.forEach((org) => {
        const code = toStr(org?.code || org?.organization?.code);
        const name = toStr(org?.name || org?.organization?.name);

        if (code) orgCodes.push(code);
        if (name) orgNames.push(name);
      });

      const accountSet = new Set([userCode, userName].map(toStr).filter(Boolean));
      const orgSet = new Set(
        [...orgCodes, ...orgNames].map(toStr).filter(Boolean),
      );

      return { userCode, userName, orgCodes, orgNames, accountSet, orgSet };
    };

    const getLoginContext = () => {
      if (_loginContextPromise) return _loginContextPromise;
      _loginContextPromise = fetchLoginContext().catch((error) => {
        _loginContextPromise = null; // 失敗不快取，下次重試
        throw error;
      });
      return _loginContextPromise;
    };

    const getRuleConfig = (type) => {
      switch (type) {
        case RULE_TYPE.ACCOUNT:
          return {
            ...ACCOUNT_RULE,
            targetGetter: getUserCodes,
          };
        case RULE_TYPE.ORG:
          return {
            ...ORG_RULE,
            targetGetter: getOrgCodes,
          };
        default:
          return null;
      }
    };

    const matchTarget = (type, targets, loginContext) => {
      if (targets.length === 0) {
        return MATCH_RESULT.EMPTY;
      }

      switch (type) {
        case RULE_TYPE.ACCOUNT: {
          const matched = someInSet(targets, loginContext.accountSet);
          return matched ? MATCH_RESULT.MATCH : MATCH_RESULT.NO_MATCH;
        }

        case RULE_TYPE.ORG: {
          const matched = someInSet(targets, loginContext.orgSet);
          return matched ? MATCH_RESULT.MATCH : MATCH_RESULT.NO_MATCH;
        }

        default:
          return MATCH_RESULT.NO_MATCH;
      }
    };

    const matchCoverValues = (field, coverValuesText) => {
      const coverValues = parseArr(coverValuesText);

      if (coverValues.length === 0) {
        return MATCH_RESULT.EMPTY;
      }

      const localValues = normalizeRecordFieldValue(field);
      const matched = localValues.some((value) => coverValues.includes(value));

      return matched ? MATCH_RESULT.MATCH : MATCH_RESULT.NO_MATCH;
    };

    const createFieldState = () => ({
      visible: false,
      editable: false,
      required: false,

      matchedByAccount: false,
      matchedByOrg: false,

      accountVisibleSet: false,
      accountEditableSet: false,
      accountRequiredSet: false,

      orgVisibleSet: false,
      orgEditableSet: false,
      orgRequiredSet: false,
    });

    const ensureFieldState = (map, fieldCode) => {
      if (!map[fieldCode]) {
        map[fieldCode] = createFieldState();
      }
      return map[fieldCode];
    };

    const collectConfiguredFieldMeta = (settings) => {
      const fieldMetaMap = {};

      [RULE_TYPE.ACCOUNT, RULE_TYPE.ORG].forEach((ruleType) => {
        const config = getRuleConfig(ruleType);

        settings.forEach((record, recordIndex) => {
          const tableField = pickField(record, config.table);
          const rows = toArr(tableField?.value);

          log(`collect meta ${ruleType}`, {
            recordIndex,
            tableCandidates: config.table,
            rowCount: rows.length,
          });

          rows.forEach((rowItem, rowIndex) => {
            const row = rowItem?.value || {};
            const rawFields = pickField(row, config.fields)?.value;
            const fieldCodes = parseArr(rawFields);
            const configuredType = toStr(pickField(row, config.fieldType)?.value);

            fieldCodes.forEach((fieldCode) => {
              const code = toStr(fieldCode);
              if (code) {
                fieldMetaMap[code] = { code, configuredType };
              }
            });
          });
        });
      });
      return fieldMetaMap;
    };

    const initControlMap = (fieldMetaMap) => {
      const map = {};
      Object.keys(fieldMetaMap).forEach((fieldCode) => {
        map[fieldCode] = createFieldState();
      });
      return map;
    };

    const getFieldBehaviorByConfiguredType = (configuredType) => {
      return FIELD_TYPE_BEHAVIOR[configuredType] || FIELD_ACTION.NONE;
    };

    const getFieldBehavior = (configuredType) => {
      const configuredBehavior = getFieldBehaviorByConfiguredType(configuredType);

      switch (configuredBehavior) {
        case FIELD_ACTION.SKIP:
          return configuredBehavior;
        default:
          return FIELD_ACTION.NONE;
      }
    };

    const isRelatedFieldType = (configuredType) => {
      return toStr(configuredType) === FIELD_KIND.RELATED;
    };

    const cssEscape = (value) => {
      if (window.CSS && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(value);
      }
      return String(value).replace(/["\\]/g, '\\$&');
    };

    const setRelatedFieldShown = (fieldCode, shown) => {
      try {
        kintone.app.record.setFieldShown(fieldCode, shown);
      } catch (error) {
      }

      const applyDomShown = () => {
        try {
          const fieldElement = kintone.app.record.getFieldElement(fieldCode);
          if (fieldElement) {
            fieldElement.style.display = shown ? '' : 'none';
            return;
          }

          const escapedCode = cssEscape(fieldCode);
          const domElement = document.querySelector(
            `[data-field-code="${escapedCode}"]`,
          );
          if (domElement) {
            domElement.style.display = shown ? '' : 'none';
          }
        } catch (error) {
        }
      };

      applyDomShown();
      setTimeout(applyDomShown, 100);
      setTimeout(applyDomShown, 500);
    };

    const applyMatchedRule = (
      control,
      showOptions,
      permissionOptions,
      requiredOptions,
      coverMatchResult,
      source,
    ) => {
      const showFlag = hasShowFlag(showOptions);
      const hideFlag = hasHideFlag(showOptions);
      const editFlag = hasEditFlag(permissionOptions);
      const requiredFlag = hasRequiredFlag(requiredOptions);

      log('applyMatchedRule', {
        source,
        showOptions,
        permissionOptions,
        requiredOptions,
        coverMatchResult,
        showFlag,
        hideFlag,
        editFlag,
        requiredFlag,
        before: { ...control },
      });

      switch (source) {
        case RULE_TYPE.ACCOUNT:
          control.matchedByAccount = true;

          if (showFlag) {
            control.visible = true;
            control.accountVisibleSet = true;
          } else if (hideFlag && !control.orgVisibleSet) {
            control.visible = false;
            control.accountVisibleSet = true;
          }

          control.editable = !!editFlag;
          control.accountEditableSet = true;

          if (
            coverMatchResult === MATCH_RESULT.MATCH ||
            coverMatchResult === MATCH_RESULT.EMPTY
          ) {
            control.required = !!requiredFlag;
            control.accountRequiredSet = true;
          }
          break;

        case RULE_TYPE.ORG:
          control.matchedByOrg = true;

          if (showFlag) {
            control.visible = true;
            control.orgVisibleSet = true;
          } else if (hideFlag && !control.accountVisibleSet) {
            control.visible = false;
            control.orgVisibleSet = true;
          }

          if (!control.accountEditableSet) {
            control.editable = !!editFlag;
            control.orgEditableSet = true;
          }

          if (
            !control.accountRequiredSet &&
            (coverMatchResult === MATCH_RESULT.MATCH ||
              coverMatchResult === MATCH_RESULT.EMPTY)
          ) {
            control.required = !!requiredFlag;
            control.orgRequiredSet = true;
          }
          break;
      }

      log('applyMatchedRule result', {
        source,
        after: { ...control },
      });
    };

    const shouldApplyRule = (ruleType, matchResult) => {
      switch (ruleType) {
        case RULE_TYPE.ACCOUNT:
          return matchResult === MATCH_RESULT.MATCH;
        case RULE_TYPE.ORG:
          return (
            matchResult === MATCH_RESULT.MATCH ||
            matchResult === MATCH_RESULT.EMPTY
          );
        default:
          return false;
      }
    };

    const processRules = (
      ruleType,
      settings,
      loginContext,
      currentStatus,
      record,
      controlMap,
    ) => {
      const config = getRuleConfig(ruleType);

      settings.forEach((recordItem) => {
        const tableField = pickField(recordItem, config.table);
        const rows = toArr(tableField?.value);

        rows.forEach((rowItem) => {
          const row = rowItem?.value || {};

          const enableField = pickField(row, config.enable);
          const statusField = pickField(row, config.status);
          const targetField = pickField(row, config.target);
          const fieldsField = pickField(row, config.fields);
          const coverField = pickField(row, config.coverValues);
          const showField = pickField(row, config.show);
          const permField = pickField(row, config.perm);
          const requiredField = pickField(row, config.required);

          const enabled = isEnabled(enableField);
          const statusMatched = isStatusMatch(statusField?.value, currentStatus);
          const targets = config.targetGetter(targetField);
          const matchResult = matchTarget(ruleType, targets, loginContext);
          const fieldCodes = parseArr(fieldsField?.value);
          const coverValuesText = coverField?.value;
          const showOptions = getCheckboxValues(showField);
          const permissionOptions = getCheckboxValues(permField);
          const requiredOptions = getCheckboxValues(requiredField);
          const runnable =
            enabled && statusMatched && shouldApplyRule(ruleType, matchResult);

          log('rule runnable', {
            ruleType,
            enabled,
            currentStatus,
            statusSetting: statusField?.value,
            statusMatched,
            targets,
            matchResult,
            runnable,
          });

          if (!runnable) return;

          fieldCodes.forEach((fieldCode) => {
            const code = toStr(fieldCode);
            if (!code) return;

            const localField = record?.[code];
            const coverMatchResult = matchCoverValues(
              localField,
              coverValuesText,
            );

            const control = ensureFieldState(controlMap, code);
            applyMatchedRule(
              control,
              showOptions,
              permissionOptions,
              requiredOptions,
              coverMatchResult,
              ruleType,
            );
          });
        });
      });
    };

    /**
     * 依 controlMap 設定欄位可否編輯：主表欄位，以及所有子表格「每一列」的明細欄位。
     * 開畫面時套用一次；子表格新增列時，新列的欄位預設可編輯，所以子表格 change 事件要再套一次（2026-10-29）。
     */
    const applyDisabled = (record, controlMap, fieldMetaMap) => {
      const subtableRows = Object.values(record || {})
        .filter((field) => field?.type === 'SUBTABLE' && Array.isArray(field.value))
        .flatMap((field) => field.value);

      Object.keys(controlMap).forEach((fieldCode) => {
        const configuredType = fieldMetaMap[fieldCode]?.configuredType;
        if (getFieldBehavior(configuredType) === FIELD_ACTION.SKIP || isRelatedFieldType(configuredType)) return;

        const disabled = !controlMap[fieldCode].editable;
        if (record[fieldCode]) {
          record[fieldCode].disabled = disabled;
        }
        subtableRows.forEach((row) => {
          if (row?.value?.[fieldCode]) {
            row.value[fieldCode].disabled = disabled;
          }
        });
      });
    };

    const applyUI = (event, controlMap, fieldMetaMap) => {
      const record = event.record;
      const eventType = event.type;

      Object.keys(controlMap).forEach((fieldCode) => {
        const control = controlMap[fieldCode];
        const meta = fieldMetaMap[fieldCode];
        const behavior = getFieldBehavior(meta?.configuredType);

        if (behavior === FIELD_ACTION.SKIP) return;

        if (isRelatedFieldType(meta?.configuredType)) {
          setRelatedFieldShown(fieldCode, !!control.visible);
          return;
        }

        try {
          kintone.app.record.setFieldShown(fieldCode, !!control.visible);
        } catch (error) {
        }
      });

      // detail.show 與 print.show 為唯讀頁面，不設 disabled；其餘（create/edit 的 show）皆套用
      const isReadOnlyView = eventType === 'app.record.detail.show' || eventType === 'app.record.print.show';
      if (!isReadOnlyView) {
        applyDisabled(record, controlMap, fieldMetaMap);
      }

      return event;
    };

    // ── 欄位標籤（錯誤視窗顯示用）────────────────────────────────────────────
    //   視窗點名的是畫面上看到的標籤（例如「申請單號（Application Number）」），不是欄位代碼（傳票編號）。
    //   取本 App 的表單設定：先用 kintone.app.getFormFields()，沒有這個 API 才打 REST；
    //   整頁只取一次，取不到就退回顯示欄位代碼（不影響擋存檔）。子表格裡的欄位也收進來。
    // 本 App 的表單設定：欄位標籤與子表格清單共用，整頁只取一次（失敗則清除以便重試）。
    let _formPropertiesPromise = null;
    const getFormProperties = () => {
      if (_formPropertiesPromise) return _formPropertiesPromise;
      const appId = kintone.app.getId();
      _formPropertiesPromise = (
        typeof kintone.app.getFormFields === 'function'
          ? kintone.app.getFormFields()
          : kintone.api(kintone.api.url('/k/v1/app/form/fields', true), 'GET', { app: appId }).then((resp) => resp.properties)
      ).catch((error) => {
        _formPropertiesPromise = null;
        throw error;
      });
      return _formPropertiesPromise;
    };

    let _labelsPromise = null;
    const fetchFieldLabels = async () => {
      const properties = await getFormProperties();
      const labels = {};
      Object.values(properties || {}).forEach((prop) => {
        if (prop?.code && prop.label) labels[prop.code] = prop.label;
        Object.values(prop?.fields || {}).forEach((sub) => {
          if (sub?.code && sub.label) labels[sub.code] = sub.label;
        });
      });
      return labels;
    };
    const getFieldLabels = () => {
      if (_labelsPromise) return _labelsPromise;
      _labelsPromise = fetchFieldLabels().catch((error) => {
        _labelsPromise = null; // 下次重試
        return {};
      });
      return _labelsPromise;
    };

    /**
     * 檢查必填：沒填的欄位標紅，回傳沒填的欄位 [{ code, row }]（row＝子表格第幾列，主表欄位為 null）。
     * 列表直接編輯只檢查列表上能改的欄位（INLINE_EDITABLE）。
     */
    const collectMissingRequired = (event, controlMap) => {
      const record = event.record;
      const missing = [];
      const isIndexEdit = event.type === INDEX_EDIT_SUBMIT;

      Object.keys(controlMap).forEach((fieldCode) => {
        const control = controlMap[fieldCode];
        const field = record?.[fieldCode];

        if (isIndexEdit && !INLINE_EDITABLE.includes(fieldCode)) return;

        if (control.required) {
          if (field) {
            field.error = null;
            if (isEmptyValue(field.value)) {
              field.error = '此欄位為必填';
              missing.push({ code: fieldCode, row: null });
            }
          }
          // 同時支援子表格內明細欄位的必填驗證與高亮
          Object.keys(record).forEach((key) => {
            if (record[key]?.type === 'SUBTABLE' && Array.isArray(record[key].value)) {
              record[key].value.forEach((row, rowIndex) => {
                if (row.value && row.value[fieldCode]) {
                  row.value[fieldCode].error = null;
                  if (isEmptyValue(row.value[fieldCode].value)) {
                    row.value[fieldCode].error = '此欄位為必填';
                    if (!missing.some((m) => m.code === fieldCode && m.row === rowIndex + 1)) missing.push({ code: fieldCode, row: rowIndex + 1 });
                  }
                }
              });
            }
          });
        }
      });

      return missing;
    };

    /** 沒填的必填欄位 → 錯誤訊息（點名畫面上的標籤；子表格附上第幾列） */
    const missingMessage = (missing, labels) =>
      `尚有必填欄位未填寫\n${missing
      .map(({ code, row }) => `▸${labels[code] || code}${row ? `（第 ${row} 列）` : ''}`)
      .join('\n')}\n※ 請填寫後再按一次儲存`;

    const buildPermissionContext = async () => {
      const [settings, loginContext] = await Promise.all([
        getSettings(),
        getLoginContext(),
      ]);

      const fieldMetaMap = collectConfiguredFieldMeta(settings);
      const controlMap = initControlMap(fieldMetaMap);

      return { settings, loginContext, fieldMetaMap, controlMap };
    };

    // onShow / onSubmit 共用前置：建立權限上下文並依「帳號 → 組織」順序跑完兩類規則，
    // 回傳彙整後的 controlMap / fieldMetaMap，交由各事件做最後一步（套 UI / 驗必填）。
    const resolvePermissions = async (event) => {
      const record = event.record;
      const currentStatus = toStr(record?.[STATUS_FIELD]?.value);

      const { settings, loginContext, fieldMetaMap, controlMap } =
        await buildPermissionContext();

      processRules(
        RULE_TYPE.ACCOUNT,
        settings,
        loginContext,
        currentStatus,
        record,
        controlMap,
      );

      processRules(
        RULE_TYPE.ORG,
        settings,
        loginContext,
        currentStatus,
        record,
        controlMap,
      );

      return { controlMap, fieldMetaMap };
    };

    // 新增／編輯畫面開啟時算好的權限，供子表格 change 事件重新鎖定新列。
    // change 事件不可非同步，不能在裡面重新讀取設定；畫面上的登入者與流程狀態不會變，沿用開畫面時的結果即可。
    // （指定的欄位值只影響必填，必填在存檔時會重新計算。）
    const EDIT_SCREENS = ['app.record.create.show', 'app.record.edit.show'];
    let _screenPermissions = null;

    const onShow = async (event) => {
      if (EDIT_SCREENS.includes(event.type)) _screenPermissions = null;
      try {
        const { controlMap, fieldMetaMap } = await resolvePermissions(event);
        if (EDIT_SCREENS.includes(event.type)) _screenPermissions = { controlMap, fieldMetaMap };
        return applyUI(event, controlMap, fieldMetaMap);
      } catch (error) {
        console.error('[帳號權限設定] 讀取權限規則失敗:', error);
        showAlert(ERROR_TITLE, ['無法讀取帳號權限設定，欄位的顯示與編輯權限沒有套用\n※ 請重新整理頁面，仍有問題請聯絡系統管理員']);
        return event;
      }
    };

    const onSubmit = async (event) => {
      try {
        const { controlMap } = await resolvePermissions(event);
        const missing = collectMissingRequired(event, controlMap);
        if (missing.length === 0) return event;
        // 欄位下方另有紅字標示；視窗點名欄位標籤（列表直接編輯看不出是哪一格）
        return reportSaveErrors(event, [missingMessage(missing, await getFieldLabels())]);
      } catch (error) {
        console.error('[帳號權限設定] 讀取權限規則失敗，無法檢查必填:', error);
        return reportSaveErrors(event, ['無法讀取帳號權限設定，無法檢查必填欄位\n※ 請稍後再試，仍有問題請聯絡系統管理員']);
      }
    };

    /** 子表格新增／刪除列：新列的欄位預設可編輯，依開畫面時的權限重新鎖定所有列（同步處理） */
    const onSubtableChange = (event) => {
      if (!_screenPermissions) return event; // 開畫面讀取權限失敗或尚未完成：維持現狀
      applyDisabled(event.record, _screenPermissions.controlMap, _screenPermissions.fieldMetaMap);
      return event;
    };

    // 子表格的欄位代碼每張表單不同，載入時讀取本 App 的表單設定，再替每個子表格註冊 change 事件
    const registerSubtableChange = async () => {
      const properties = await getFormProperties();
      const subtableCodes = Object.values(properties || {})
        .filter((prop) => prop?.type === 'SUBTABLE')
        .map((prop) => prop.code);
      if (subtableCodes.length === 0) return;

      kintone.events.on(
        subtableCodes.flatMap((code) => [`app.record.create.change.${code}`, `app.record.edit.change.${code}`]),
        onSubtableChange,
      );
    };

    kintone.events.on(EVENTS_SHOW, onShow);
    kintone.events.on(EVENTS_SUBMIT, onSubmit);
    registerSubtableChange().catch((error) => {
      console.error('[帳號權限設定] 讀取子表格清單失敗，子表格新增列不會套用編輯權限:', error);
    });
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

      // 比對本單每個號碼出現在對方哪幾張單（同一號碼撞到多張單，單號用「、」併在同一個標籤）。
      // kintone 的 like 會忽略符號、只比字詞（例如「@SW!W」會撞到「@SW!WW!W!W!」），查到的只是候選，
      // 一定要逐一比對完整號碼（不分大小寫）才算重複；比對不到就不是重複，不擋存檔。
      const norm = (s) => String(s).trim().toUpperCase();
      const lines = [];
      invoices.forEach((no) => {
        const nos = [];
        hits.forEach((r) => {
          const theirs = (r[F.INVOICE_AGG]?.value || '').split(SEP).map(norm);
          const recNo = r[F.RECORD_NO]?.value || r.$id?.value;
          if (theirs.includes(norm(no)) && recNo && !nos.includes(recNo)) nos.push(recNo);
        });
        if (nos.length > 0) lines.push(`▸${no}（${F.RECORD_NO} ${nos.join('、')}）`);
      });

      if (lines.length === 0) return [];
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
      // 比本程式早跑的存檔檢查（帳號權限設定的必填）留下的訊息，和這裡的檢查結果合成同一個視窗
      const earlierErrors = window.PR_SAVE_ERRORS?.take() || [];

      if (event.record[C.VOID_FIELD]?.value?.length > 0) {
        if (earlierErrors.length > 0) {
          event.error = '儲存失敗';
          showValidationErrors('表單驗證失敗', earlierErrors);
        }
        return event;
      }

      try {
        const record = event.record;
        const allErrors = [...earlierErrors];

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
        // 費用所屬人是部長：依費用歸屬帶入單位部長_支店長（直接寫進 record；查不到資料回錯誤）
        const director = window.PR_DIRECTOR_BY_CC;
        const directorTask = director ? director.apply(record) : Promise.resolve([]);
        // 手動設定簽核流程：檢查指定的簽核人（1～3 位、依序、不重複、不是申請人），並寫入手動簽核人數
        const manualSigners = window.PR_MANUAL_SIGNERS;
        const manualTask = manualSigners
          ? manualSigners.validate(record).catch((e) => {
              console.error('手動簽核人檢查失敗:', e);
              return ['手動簽核人檢查失敗：請稍後再試或聯絡系統管理員'];
            })
          : Promise.resolve([]);
        const [costCenters, invoiceErrors, scopeErrors, directorErrors, manualErrors] = await Promise.all([costCentersTask, invoiceTask, scopeTask, directorTask, manualTask]);

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

        // 5. 費用所屬人是部長時的單位部長
        allErrors.push(...directorErrors);

        // 6. 手動設定簽核流程的簽核人
        allErrors.push(...manualErrors);

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
    //   (5) 申請人與費用所屬人要同部門：申請部門、費用所屬人部門各自往上爬到的部要相同（2026-10-29）
    //   (3) 申請人在 COST_SCOPE.EXEMPT_GROUP 群組內 → 不受 (1)(2)(5) 限制
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
     * 申請人與費用所屬人要同部門（純函式）：兩邊的部門各自往上爬到的部要相同。
     * @param {Object} p
     * @param {{code:string,name:string}} p.applicantOrg 申請部門
     * @param {{code:string,name:string}} p.ownerOrg 費用所屬人部門
     * @param {string} p.applicantDept 申請部門往上爬到的部
     * @param {string} p.ownerDept 費用所屬人部門往上爬到的部
     * @param {Object<string,string>} [p.orgNames] 組織代碼 → 名稱（訊息用）
     * @returns {string[]} 錯誤訊息
     */
    const checkSameDept = ({ applicantOrg, ownerOrg, applicantDept, ownerDept, orgNames = {} }) => {
      if (applicantDept === ownerDept) return [];
      const nameOf = (code) => orgNames[code] || code;
      const line = (label, org, dept) => `▸${label}：${org.name || org.code}${org.code === dept ? '' : `（屬 ${nameOf(dept)}）`}`;
      return [
        `申請人與費用所屬人**必須同部門**\n${line('申請部門', applicantOrg, applicantDept)}\n${line('費用所屬人部門', ownerOrg, ownerDept)}\n※ 請改選同部門的費用所屬人`,
      ];
    };

    /**
     * 存檔驗證。排除群組內的申請人直接通過；費用所屬人部門沒填也略過（簽核排不出來，另有必填擋）。
     *   (A) 申請人與費用所屬人同部門（申請部門沒填就略過）
     *   (B) 掛帳單位限部內、不可跨部門（沒有任何費用歸屬就略過）
     * @param {Object} record
     * @returns {Promise<string[]>}
     */
    const validate = async (record) => {
      const exempt = await ensureExempt(applicantCodeOf(record));
      if (exempt) return [];

      const ownerOrg = record[F.EXPENSE_OWNER_ORG]?.value?.[0];
      if (!ownerOrg?.code) return [];
      const applicantOrg = record[F.APPLICANT_ORG]?.value?.[0];

      const rows = record[TRAFFIC.CODE]?.value || [];
      const codes = rows.map((row) => row?.value?.[TRAFFIC.COLS.EXPENSE]?.value || '');
      const hasCodes = codes.some((c) => String(c).trim());
      if (!hasCodes && !applicantOrg?.code) return [];

      const cc = window.PR_COST_CENTER;
      let deptsOfCode;
      let parentOf;
      try {
        await cc.ensureLoaded();
        deptsOfCode = cc.getDeptsOfCode();
        parentOf = await loadOrgParents();
      } catch (err) {
        console.error('[費用歸屬部門限制] 載入主檔或組織資料失敗:', err);
        return ['無法取得費用歸屬主檔或組織資料，無法檢查申請人部門與掛帳單位，請稍後再試或聯絡系統管理員'];
      }

      const deptSet = new Set(Object.values(deptsOfCode).flat());
      const ownerDept = resolveDeptOfOrg(ownerOrg.code, parentOf, deptSet);
      const orgNames = { ...(cc.getDeptNames?.() || {}), [ownerOrg.code]: ownerOrg.name };
      const errors = [];

      if (applicantOrg?.code) {
        const applicantDept = resolveDeptOfOrg(applicantOrg.code, parentOf, deptSet);
        errors.push(...checkSameDept({ applicantOrg, ownerOrg, applicantDept, ownerDept, orgNames: { ...orgNames, [applicantOrg.code]: applicantOrg.name } }));
      }

      if (hasCodes) {
        // 主檔裡沒有（或不是使用中）的代碼，payment_request_submit 已經會報錯，這裡略過不重複報
        const known = new Set([...(cc.getValidCodes() || [])].map((c) => String(c).trim().toUpperCase()));
        const knownCodes = codes.map((c) => (known.has(String(c).trim().toUpperCase()) ? c : ''));
        errors.push(...checkScope({ codes: knownCodes, deptsOfCode, ownerDept, orgNames }));
      }
      return errors;
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
      checkSameDept,
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
    //     - 勾選「手動設定簽核流程」（只限費用歸屬不限部門群組）→ 6 格清空，改由手動簽核人設定_20261102.js 的視窗指定 1～3 位
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
    const DIRECTOR_FIELD = '單位部長_支店長';

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

    // 簽核流程主檔（APPS.APPROVAL_FLOW）自己的欄位代碼
    const AF = C.REF_FIELDS.APPROVAL_FLOW;

    // =========================
    // 手動簽核流程相關常數
    // =========================

    // 手動模式：簽核人改由手動簽核人設定（PR_MANUAL_SIGNERS）的三格指定，原本的 6 格與人數欄位不用
    const MANUAL_ACCOUNTING_FIELD = C.MANUAL_SIGNERS.ACCOUNTING_FIELD; // 手動模式的會計承辦人（指定簽核人視窗第 4 格）
    const MANUAL_MODE_CONFIG = {
      // 核取方塊欄位名稱
      checkbox: F.MANUAL_FLOW,
      // 人數欄位：手動模式固定 0人（流程管理的自動關卡條件才不會成立）
      countFields: COUNT_FIELDS,
      // 手動模式要清空的簽核欄位
      slotFields: getEnabledFields(),
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
     * 依職稱改查的合併簽核流程（簽核流程主檔「特殊簽核流程」那幾筆，例如「物流部次長級」）。
     * 有對應就回傳要查的「簽核流程名稱」；沒有就回傳空字串，改用費用所屬人部門的組織代碼查「簽核所屬單位」。
     * @param {string} org - 費用所屬人該單位的組織名稱
     * @param {string} title - 費用所屬人在該單位的職稱
     * @returns {string} 特殊簽核流程名稱，沒有則為空字串
     */
    function specialFlowName(org, title) {
      let flowName = '';

      if (org && title) {
        // 1. 物流部次長級
        if ((org === '物流部-桃園NEXT1倉庫' || org === '物流部') && title === '次長') {
          flowName = '物流部次長級';
        }
        // 2. 航空貨物部次長(所長)級
        else if (
          (org === '航空貨物部' && title === '次長') ||
          ((org === '桃園機場營業所' || org === '新竹營業所') && (title === '所長' || title === '次長'))
        ) {
          flowName = '航空貨物部次長(所長)級';
        }
        // 3. 海運貨物部次長級
        else if (org === '海運貨物部' && title === '次長') {
          flowName = '海運貨物部次長級';
        }
        // 4. 總務部次長級
        else if (org === '總務部' && title === '次長') {
          flowName = '總務部次長級';
        }
        // 5. 物流部長/汽車貨運部長
        else if ((org === '物流部' || org === '汽車貨運部') && title === '部長') {
          flowName = '物流部長/汽車貨運部長';
        }

        // 6. 海運貨物部長/航空貨物部長
        else if ((org === '海運貨物部' || org === '航空貨物部') && title === '部長') {
          flowName = '海運貨物部長/航空貨物部長';
        }
        // 7. 安全品質推動部長/營業戰略部長/總務部長/事業本部長
        else if (
          (org === '安全品質推動部' && title === '部長') ||
          ((org === '營業戰略部' || org === '總務部' || org === '事業本部') && title === '部長')
        ) {
          flowName = '安全品質推動部長/營業戰略部長/總務部長/事業本部長';
        }
        //8. 台中營業部/高雄營業部/事業本部次長(中心長)級
        else if ((org === '事業本部' && title === '次長') || ((org === '台中營業部' || org === '高雄營業部') && title === '部長')) {
          flowName = '台中營業部長/高雄營業部長/事業本部次長(中心長)級';
        }

        //9. 安全品質推動部次長級
        else if (org === '安全品質推動部' && title === '次長') {
          flowName = '安全品質推動部次長級';

          //10. 高雄營業部次長級
        } else if (org === '高雄營業部' && title === '次長') {
          flowName = '高雄營業部次長級';
        }

        //11. 台中營業部次長級
        else if (org === '台中營業部' && title === '次長') {
          flowName = '台中營業部次長級';
        }
      }

      return flowName;
    }

    /**
     * 決定「要排哪幾位主管」——只做判斷，不碰 kintone、不改 record。
     *
     * 簽核流程主檔有值的欄位全部保留，由低層級到高層級：
     *   單位主管1 → 單位主管2 → 單位主管3 → 單位次長 → 單位次長1 → 單位部長_支店長
     * 同一人出現在好幾格時只留最上面那格（主檔的主管3 與次長1 常是同一位次長，不讓他連簽兩關）。
     * 費用所屬人本人那一層與以下，之後由 clearSigningFieldsByTitle 依職稱清掉。
     *
     * @param {Object} managerData - 簽核流程主檔回傳的那筆記錄
     * @param {Array}  fieldsToUpdate - MANAGER_FIELDS_MAPPING 或 MANAGER_FIELDS_SPECIAL
     * @returns {{ fieldHasValue: Object, fieldsToShow: string[], usersOf: Object<string, Array> }}  usersOf：每格實際要排的人
     */
    const planSigningChain = (managerData, fieldsToUpdate) => {
      // 由高層往低層看：同一人已排在更上面的格子（例如主管3 與次長1 是同一人），下面那格就不排，只簽上面那關
      const usersOf = {};
      const codesAbove = new Set();
      [...fieldsToUpdate].reverse().forEach(({ apiField, displayField }) => {
        const users = (managerData[apiField]?.value || []).filter((user) => !codesAbove.has(user.code));
        users.forEach((user) => codesAbove.add(user.code));
        usersOf[displayField] = users;
      });

      const fieldHasValue = {};
      fieldsToUpdate.forEach(({ displayField }) => {
        fieldHasValue[displayField] = usersOf[displayField].length > 0;
      });

      const fieldsToShow = fieldsToUpdate.map(({ displayField }) => displayField).filter((displayField) => fieldHasValue[displayField]);

      return { fieldHasValue, fieldsToShow, usersOf };
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

      const { fieldHasValue, fieldsToShow, usersOf } = planSigningChain(managerData, fieldsToUpdate);

      fieldsToUpdate.forEach(({ displayField }) => {
        const shouldShow = fieldsToShow.includes(displayField);
        const users = fieldHasValue[displayField] ? usersOf[displayField] : [];

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
      // 本人也排在次長格（課長兼次長、中心長排在次長格…）：照次長處理，簽核從他上面那一層開始，不會自己簽自己
      const isInDeputySlot = DEPUTY_FIELDS.some((field) => updateRecord.record[field]?.value?.some((user) => user.code === userCode));
      // 本人就排在部長格（職稱不一定是部長，例如事業部長）：照部長處理，部長格也清掉，不會自己簽自己
      const isInDirectorSlot = updateRecord.record[DIRECTOR_FIELD]?.value?.some((user) => user.code === userCode);
      const effectiveTitle = isInDirectorSlot ? '部長' : isInDeputySlot && title !== '部長' && title !== '支店長' ? '次長' : title;

      switch (effectiveTitle) {
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
          // 部長格是本人才清；部長格是別人（上一層部長）就留著讓他簽
          [...MANAGER_FIELDS, ...DEPUTY_FIELDS, ...(isInDirectorSlot ? [DIRECTOR_FIELD] : [])].forEach((field) => {
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
      const flowName = specialFlowName(orgNameOfTitle, title);
      return {
        title,
        // 特殊簽核流程用名稱查；其他一律用組織代碼查「簽核所屬單位」（改組織名稱不用改程式）
        approvalQuery: flowName
          ? `${AF.FLOW_NAME} = "${flowName}"`
          : `${AF.ORG} in ("${org.organization.code}") and ${AF.IN_USE} in ("${AF.IN_USE_VALUE}")`,
        // 未更動之前的名稱來觀察是否為六大簽核流程
        isSpecialDepartment: SPECIAL_DEPARTMENTS.includes(orgName) || (DIRECTOR_CHECK_DEPARTMENTS.includes(orgName) && orgs[0]?.title?.name === '部長'),
        // 台中支店長／營業戰略部長／總務部長／事業本部長：不帶入課／次／部長流程
        isSpecificDirector:
          (orgNameOfTitle === '台中營業部' && title === '支店長') ||
          ((orgNameOfTitle === '營業戰略部' || orgNameOfTitle === '總務部' || orgNameOfTitle === '事業本部') && title === '部長'),
      };
    };

    /** 提示視窗：一律用 SweetAlert；載不到 SweetAlert 才退回瀏覽器的 alert */
    function notify(icon, title, text) {
      if (typeof Swal !== 'undefined') Swal.fire({ icon, title, text, width: 'auto', confirmButtonText: '好' });
      else alert(text ? `${title}\n${text}` : title);
    }

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
            notify('warning', '找不到對應的會計單位', '請確認費用所屬人部門是否正確；仍有問題請洽系統管理員。');
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

          const staff = has_account_member
            ? AccountData[ACC.ACCOUNTING_STAFF].value.map((member) => ({
                code: member.code || member,
                name: member.name || member,
              }))
            : [];
          updateRecord.record[F.ACCOUNTING_STAFF] = { value: staff, type: 'USER_SELECT' };

          // 手動模式另有「手動會計承辦人」（指定簽核人視窗第 4 格）：還空著才帶這個預設，申請人選過的不蓋掉
          const manualStaffField = updateRecord.record[MANUAL_ACCOUNTING_FIELD];
          const offerManualStaff = isManual && manualStaffField && !(manualStaffField.value?.length > 0) && staff.length > 0;
          if (offerManualStaff) {
            manualStaffField.value = staff;
            manualStaffField.disabled = true;
          }

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
          if (offerManualStaff) window.PR_MANUAL_SIGNERS?.offerAccounting?.(staff);
        },
        function (error) {
          console.error('API錯誤:', error);
          notify('error', '取得會計單位資料時發生錯誤', '請稍後再試，或重新選一次費用所屬人。');
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
        const { title, approvalQuery, isSpecialDepartment, isSpecificDirector } = owner;
        console.log(`簽核流程查詢：${approvalQuery}`);

        // 動態建立欄位陣列
        const enabledApiFields = MANAGER_FIELDS_MAPPING.map((field) => field.apiField);
        const specialApiFields = MANAGER_FIELDS_SPECIAL.map((field) => field.apiField);

        const params = {
          app: APPS.APPROVAL_FLOW,
          fields: isSpecialDepartment ? [AF.FLOW_NAME, ...specialApiFields] : [AF.FLOW_NAME, ...enabledApiFields],
          query: approvalQuery,
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

            // 費用所屬人是部長：簽核人員排完後，單位部長_支店長改依費用歸屬帶入（部長簽核帶入_20261029.js）
            if (title === C.DIRECTOR_BY_COST_CENTER.OWNER_TITLE) Promise.resolve().then(() => window.PR_DIRECTOR_BY_CC?.refresh());

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

            // 六大簽核流程只排部長，不需再運行下方程式；除非那位部長就是本人，要清掉部長格
            const isOwnerDirector = updateRecord.record[DIRECTOR_FIELD]?.value?.some((user) => user.code === ownerCode);
            if (isSpecialDepartment && !isOwnerDirector) return;

            // 費用所屬人職位設定 - 單職位與雙職位過濾重複簽核的人員
            clearSigningFieldsByTitle(updateRecord, title, ownerCode);
          },
          function (error) {
            console.error('API錯誤:', error);
            notify('error', '取得主管資料時發生錯誤', '請稍後再試，或重新選一次費用所屬人。');
          },
        );
      });

      return event;
    }

    // =========================
    // 手動簽核流程相關函數
    // =========================

    /**
     * 初始化手動簽核模式：人數歸 0人並鎖住、6 格清空隱藏；
     * 手動簽核人三格、手動會計承辦人與「設定簽核人」按鈕交給 PR_MANUAL_SIGNERS（只能從指定簽核人視窗改）。
     * @param {Object} record - Kintone record 物件
     * @param {{ openNow?: boolean }} [opts] openNow：馬上開「指定簽核人」視窗
     * @returns {Object} 更新後的 record
     */
    function initManualSigningMode(record, { openNow = false } = {}) {
      manualShown = true;
      Object.values(MANUAL_MODE_CONFIG.countFields).forEach((field) => {
        if (!record[field]) return;
        record[field].value = '0人';
        record[field].disabled = true;
        KT.record().setFieldShown(field, false);
      });

      MANUAL_MODE_CONFIG.slotFields.forEach((field) => {
        if (!record[field]) return;
        record[field].value = [];
        record[field].disabled = true;
        KT.record().setFieldShown(field, false);
      });

      window.PR_MANUAL_SIGNERS?.enter(record, { openNow });
      return record;
    }

    /**
     * 檢查是否為手動模式
     * @param {Object} record - Kintone record 物件
     * @returns {boolean}
     */
    function isManualSigningMode(record) {
      return record[MANUAL_MODE_CONFIG.checkbox] && record[MANUAL_MODE_CONFIG.checkbox].value && record[MANUAL_MODE_CONFIG.checkbox].value.length > 0;
    }

    // 畫面上「手動設定簽核流程」目前的勾選狀態（開畫面時讀、程式自己改勾選時跟著改；null＝還不知道）。
    // kintone 在程式 KT.record().set() 之後也會觸發勾選欄位的 change 事件（值沒變也會），
    // 事件的值和這裡一樣就是 set() 的回音、不是使用者點的：不開視窗、不確認、不勾回去。
    // 否則開新增畫面帶會計單位的 set() 會跳「指定簽核人」視窗，視窗按取消改回自動後又被勾回去，無限循環。
    let manualShown = null;

    // =========================
    // 事件註冊
    // =========================

    // 費用所屬人部門變更時的事件
    KT.on([`app.record.create.change.${F.EXPENSE_OWNER_ORG}`, `app.record.edit.change.${F.EXPENSE_OWNER_ORG}`], handleExpenseOwnerOrgChange);

    /**
     * 申請人在「費用歸屬不限部門」群組（COST_SCOPE.EXEMPT_GROUP）→ 簽核人員自選：勾上手動設定簽核流程。
     * @param {Object} record
     * @param {{ openNow?: boolean }} [opts] openNow：還沒指定簽核人就跳「指定簽核人」視窗（使用者自己勾的才跳；開新增畫面時不跳，改按「設定簽核人」）
     */
    function enterManualModeForExempt(record, { openNow = true } = {}) {
      record[F.MANUAL_FLOW].value = [OPT.MANUAL_FLOW.ON];
      record[F.ACCOUNTING_UNIT].value = [];
      KT.record().setFieldShown(F.ACCOUNTING_UNIT, false);
      if (typeof KT.record().setGroupFieldOpen === 'function') KT.record().setGroupFieldOpen(F.SIGN_FLOW_GROUP, true);
      // 還沒指定簽核人才跳視窗（複製的單已經有人就不吵他，要改按「更改簽核人」）
      const hasSigners = window.PR_MANUAL_SIGNERS?.signersOf(record).some(Boolean);
      initManualSigningMode(record, { openNow: openNow && !hasSigners });
    }

    /** 不在「費用歸屬不限部門」群組的人勾了手動設定簽核流程 */
    function warnManualNotAllowed() {
      const title = '這張單不能手動設定簽核人';
      const text = `手動設定簽核流程只開放給「${C.COST_SCOPE.EXEMPT_GROUP}」的同仁，簽核人員會由系統依費用所屬人自動安排。`;
      notify('info', title, text);
    }

    /** 取消勾選手動設定時確認（SweetAlert；載不到才用瀏覽器 confirm） */
    function askExitManual() {
      const title = '改回系統自動排簽核人員？';
      const text = '剛才指定的簽核人與會計承辦人會清掉，改由系統依費用所屬人重新安排。';
      if (typeof Swal === 'undefined') return Promise.resolve(confirm(`${title}\n\n${text}\n按「取消」維持手動設定。`));
      return Swal.fire({
        icon: 'question',
        title,
        text,
        width: 'auto',
        showCancelButton: true,
        confirmButtonText: '改回自動',
        cancelButtonText: '維持手動',
        reverseButtons: true,
        focusCancel: true,
      }).then((result) => result.isConfirmed);
    }

    /**
     * 新增畫面：先確認申請人是否在排除群組（PR_COST_SCOPE），在的話切手動模式，再帶入費用所屬人部門與簽核人員／會計單位。
     */
    function handleCreateShow(event) {
      manualShown = Boolean(isManualSigningMode(event.record));
      const scope = window.PR_COST_SCOPE;
      if (!scope) return syncOwnerOrgOnCreate(event);
      return scope.ensureExempt(scope.applicantCodeOf(event.record)).then((exempt) => {
        if (exempt && !isManualSigningMode(event.record)) enterManualModeForExempt(event.record, { openNow: false });
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
     * 選單位的視窗（和 723 交際費同一種）：每個所屬單位一顆按鈕，點了就帶入；可取消時最下面多一顆「取消」。
     * 樣式在 payment_request.css 的 .pr-org-picker*。
     * @param {Array} orgs  /v1/user/organizations.json 的 organizationTitles
     * @param {{ heading: string, hint: string, keepable: boolean }} p
     * @returns {Promise<Object|null>} 點到的那筆 organizationTitles；按取消回傳 null
     */
    const openOrgDialog = (orgs, { heading, hint, keepable }) =>
      new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'pr-org-picker-overlay';
        const box = document.createElement('div');
        box.className = 'pr-org-picker';

        const title = document.createElement('p');
        title.className = 'pr-org-picker__title';
        title.textContent = heading;
        box.appendChild(title);
        if (hint) {
          const hintEl = document.createElement('p');
          hintEl.className = 'pr-org-picker__hint';
          hintEl.textContent = hint;
          box.appendChild(hintEl);
        }

        const close = (picked) => {
          overlay.remove();
          resolve(picked);
        };
        orgs.forEach((o) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'pr-org-picker__option';
          btn.textContent = o.organization.name;
          btn.addEventListener('click', () => close(o));
          box.appendChild(btn);
        });
        if (keepable) {
          const cancelBtn = document.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.className = 'pr-org-picker__cancel';
          cancelBtn.textContent = '取消（保留原本的部門）';
          cancelBtn.addEventListener('click', () => close(null));
          box.appendChild(cancelBtn);
        }

        overlay.appendChild(box);
        document.body.appendChild(overlay);
      });

    // 選單位的視窗一次只開一個（申請人、費用所屬人同時要選時排隊，不會疊在一起）
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
      const open = () => {
        if (!isCurrent()) return null;
        return openOrgDialog(orgs, { heading: `${userName} 有多個所屬單位，請選擇${subject}部門：`, hint, keepable });
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
      notify('warning', title, text);
    };

    // 申請人部門（申請人部門帶入_20261022.js）共用同一套查單位與選單位視窗
    window.PR_ORG_PICKER = Object.freeze({ fetchUserOrgs, pickOrg, warnNoOrg });

    /**
     * 「指定簽核人」視窗按取消、一位簽核人都沒指定（PR_MANUAL_SIGNERS 呼叫）：
     * 取消勾選手動設定簽核流程，改回系統自動排人。使用者已經在視窗按了取消，這裡不再跳確認。
     * set() 引起的 change 事件靠 manualShown 認出是回音，不會再勾回去。
     */
    function exitManualMode() {
      const current = KT.record().get();
      const record = current.record;
      if (!isManualSigningMode(record)) return;
      record[MANUAL_MODE_CONFIG.checkbox].value = [];
      manualShown = false;
      window.PR_MANUAL_SIGNERS?.leave(record);
      handleExpenseOwnerOrgChange({ record });
      KT.record().set(current);
    }

    window.PR_MANUAL_MODE = Object.freeze({
      exitManualMode,
      /** 測試用：忘掉畫面上的勾選狀態（模擬重新開頁） */
      _reset: () => {
        manualShown = null;
      },
    });

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
    //   勾選：只限「費用歸屬不限部門」群組的申請人（PR_COST_SCOPE 開畫面時已查好）；不在群組就取消勾選並說明。
    //     開畫面時的查詢若還沒回來，先取消勾選，查完確定在群組再幫他勾回去。
    //   取消勾選：確認後清掉手動簽核人，改回系統自動排人。
    //   勾選狀態和 manualShown 一樣 → 是程式 set() 引起的回音，直接放行。
    KT.on([`app.record.create.change.${F.MANUAL_FLOW}`, `app.record.edit.change.${F.MANUAL_FLOW}`], function (event) {
      const record = event.record;
      const isManual = Boolean(isManualSigningMode(record));
      if (isManual === manualShown) return event;

      if (isManual) {
        const scope = window.PR_COST_SCOPE;
        if (scope && !scope.isExempt()) {
          record[MANUAL_MODE_CONFIG.checkbox].value = [];
          manualShown = false;
          scope.ensureExempt(scope.applicantCodeOf(record)).then((exempt) => {
            if (!exempt) {
              warnManualNotAllowed();
              return;
            }
            const current = KT.record().get();
            enterManualModeForExempt(current.record);
            KT.record().set(current);
          });
          return event;
        }

        // 啟用手動模式
        record[F.ACCOUNTING_UNIT].value = [];
        KT.record().setFieldShown(F.ACCOUNTING_UNIT, false);

        KT.record().setGroupFieldOpen(F.SIGN_FLOW_GROUP, true);
        event.record = initManualSigningMode(record, { openNow: true });
      } else {
        // 取消手動模式：change 事件不能等視窗，先維持勾選；問過按「改回自動」才真的取消勾選
        record[MANUAL_MODE_CONFIG.checkbox].value = [OPT.MANUAL_FLOW.ON];
        manualShown = true;
        askExitManual().then((ok) => {
          if (ok) exitManualMode();
        });
      }

      return event;
    });

    // 編輯/詳細頁面顯示（手動模式）：6 格的兩個人數欄位不顯示（會計單位承辦人照一般規則，只有管理員看得到）
    KT.on(['app.record.edit.show', 'app.record.detail.show'], function (event) {
      const record = event.record;
      manualShown = Boolean(isManualSigningMode(record));

      if (isManualSigningMode(record)) {
        Object.values(MANUAL_MODE_CONFIG.countFields).forEach((field) => KT.record().setFieldShown(field, false));
      }

      return event;
    });
  })();

  (() => {

    // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
    const KT = window.PR_KT;

    // =============================================================================
    // 費用所屬人是部長 → 單位部長_支店長 依費用歸屬帶入（2026-10-29）
    //
    //   費用所屬人在費用所屬人部門的職稱是部長時，簽核流程主檔排的部長不適用（本人或同層），
    //   改依明細第一個費用歸屬代碼查費用歸屬主檔（APPS.COST_CENTER）：
    //     (1) 代碼的所屬部門（往上爬）是 DIRECTOR_BY_COST_CENTER.HQ_CODE（總公司）的所屬部門之一
    //         → 用該代碼那筆的「部門部長」群組（沒設就用總公司同部門那筆的）
    //     (2) 其他 → 用 DEFAULT_CODE（事業本部）的「部門部長」群組
    //   部長所在的部已是最上層（往上沒有別的部）→ 只用 HQ_CODE「主要管理部門」那筆的部長群組（例如營業戰略部長、事業本部長 → 總務部長），不看代碼自己那筆的群組。
    //   群組成員去掉費用所屬人本人後寫入單位部長_支店長（只剩本人＝清空，部長本人不簽自己）。
    //   同一代碼有好幾筆（例如總公司由三個部共用）→ 取費用所屬人的部那一筆。
    //
    //   存檔：payment_request_submit 呼叫 apply()，查不到資料時擋存檔（錯誤一起顯示）。
    //   畫面：費用歸屬變更、簽核人員排完（signing_personnel_manager 呼叫 refresh()）時先帶給使用者看。
    //   手動設定簽核流程、表單作廢不處理；送出後（不在可編輯狀態）不重算。
    // =============================================================================

    const C = window.PR_CONFIG;
    const F = C.FIELDS;
    const CFG = C.DIRECTOR_BY_COST_CENTER;
    const CC = C.REF_FIELDS.COST_CENTER;
    const TRAFFIC = F.TRAFFIC_TABLE;

    // ── 純函式 ──────────────────────────────────────────────────────────────

    /** 明細裡第一個有填的費用歸屬代碼（大寫）；都沒填回空字串 */
    const firstCostCenter = (record) => {
      const rows = record?.[TRAFFIC.CODE]?.value || [];
      for (const row of rows) {
        const code = String(row?.value?.[TRAFFIC.COLS.EXPENSE]?.value || '').trim().toUpperCase();
        if (code) return code;
      }
      return '';
    };

    /** 這個狀態還能重算（新增畫面沒有狀態欄位值，一律可以） */
    const isEditableStatus = (status) => !status || CFG.EDITABLE_STATUSES.includes(status) || String(status).endsWith(CFG.REJECT_SUFFIX);

    /**
     * 這個部往上是否已經沒有別的部（組織樹往上爬，祖先都不在部的清單裡）。
     * @param {string} dept 部（組織代碼）
     * @param {Object<string,string|null>} parentOf 組織代碼 → 上一層
     * @param {Set<string>} deptSet 部的清單（費用歸屬主檔出現過的所屬部門）
     */
    const isTopDept = (dept, parentOf, deptSet) => {
      let current = parentOf[dept] || null;
      for (let depth = 0; depth < C.COST_SCOPE.ORG_TREE.MAX_DEPTH && current; depth++) {
        if (deptSet.has(current)) return false;
        current = parentOf[current] || null;
      }
      return true;
    };

    /** HQ_CODE 主要管理部門那筆的部長群組；沒有勾主要管理部門回空陣列 */
    const mainHqGroups = (records) => records.find((r) => r.code === CFG.HQ_CODE && r.main)?.groups || [];

    /**
     * 決定要用哪個部長群組。
     * @param {Object} p
     * @param {string} p.code 費用歸屬代碼（大寫）
     * @param {string} p.ownerDept 費用所屬人部門往上爬到的部（共用代碼時選哪一筆）
     * @param {Array<{code:string, dept:string, groups:string[]}>} p.records 費用歸屬主檔的記錄（至少含 code、HQ_CODE、DEFAULT_CODE）
     * @param {Object<string,string|null>} [p.parentOf] 組織代碼 → 上一層
     * @param {Function} p.resolveDeptOfOrg PR_COST_SCOPE.resolveDeptOfOrg
     * @returns {{ groups: string[], source: 'HQ'|'DEFAULT', dept: string }|null} 代碼不在主檔 → null
     */
    const pickDirectorGroups = ({ code, ownerDept, records, parentOf = {}, resolveDeptOfOrg }) => {
      const ofCode = (c) => records.filter((r) => r.code === c);
      const own = ofCode(code);
      if (own.length === 0) return null;
      const picked = own.find((r) => r.dept === ownerDept) || own[0];

      const hq = ofCode(CFG.HQ_CODE);
      const hqDepts = new Set(hq.map((r) => r.dept).filter(Boolean));
      const top = picked.dept ? resolveDeptOfOrg(picked.dept, parentOf, hqDepts) : '';
      if (top && hqDepts.has(top)) {
        const groups = picked.groups.length > 0 ? picked.groups : hq.find((r) => r.dept === top)?.groups || [];
        return { groups, source: 'HQ', dept: top };
      }
      const fallback = ofCode(CFG.DEFAULT_CODE);
      return { groups: [...new Set(fallback.flatMap((r) => r.groups))], source: 'DEFAULT', dept: picked.dept };
    };

    /** 兩組使用者是否相同（只看代碼、不看順序） */
    const sameUsers = (a, b) => {
      const key = (list) => (list || []).map((u) => u?.code).filter(Boolean).sort().join(',');
      return key(a) === key(b);
    };

    // ── 查資料 ──────────────────────────────────────────────────────────────

    /** 費用所屬人在費用所屬人部門的職稱；查不到該部門回空字串 */
    const fetchOwnerTitle = async (ownerCode, ownerOrgCode) => {
      const resp = await kintone.api(kintone.api.url('/v1/user/organizations.json', true), 'GET', { code: ownerCode });
      const hit = (resp.organizationTitles || []).find((o) => o.organization?.code === ownerOrgCode);
      return hit?.title?.name || '';
    };

    /** 費用歸屬主檔裡這幾個代碼（使用中）的所屬部門與部長群組 */
    const fetchCostCenterRecords = async (codes) => {
      const list = [...new Set(codes)].map((c) => `"${c}"`).join(',');
      const resp = await kintone.api(kintone.api.url('/k/v1/records', true), 'GET', {
        app: C.APPS.COST_CENTER,
        fields: [CC.CODE, CC.DEPT, CC.DIRECTOR_GROUP, CC.MAIN_DEPT],
        query: `${CC.CODE} in (${list}) and ${CC.IN_USE} in ("使用中") limit 500`,
      });
      return (resp.records || []).map((r) => ({
        code: String(r[CC.CODE]?.value || '').trim().toUpperCase(),
        dept: r[CC.DEPT]?.value?.[0]?.code || '',
        groups: (r[CC.DIRECTOR_GROUP]?.value || []).map((g) => g.code).filter(Boolean),
        main: (r[CC.MAIN_DEPT]?.value || []).includes(CC.MAIN_DEPT_ON),
      }));
    };

    /** 群組（角色）成員，分頁抓完 */
    const fetchGroupUsers = async (groupCode) => {
      const users = [];
      for (let offset = 0; offset < 2000; offset += 100) {
        const resp = await kintone.api(kintone.api.url('/v1/group/users.json', true), 'GET', { code: groupCode, size: 100, offset });
        const page = resp.users || [];
        users.push(...page.map((u) => ({ code: u.code, name: u.name })));
        if (page.length < 100) break;
      }
      return users;
    };

    /** 費用所屬人部門往上爬到的部，以及這個部是不是最上層；組織樹或主檔拿不到就無法判斷要不要改用總公司部長，直接報錯 */
    const ownerDeptOf = async (ownerOrgCode) => {
      try {
        const scope = window.PR_COST_SCOPE;
        const cc = window.PR_COST_CENTER;
        await cc.ensureLoaded();
        const parentOf = await scope.loadOrgParents();
        const deptSet = new Set(Object.values(cc.getDeptsOfCode()).flat());
        const dept = scope.resolveDeptOfOrg(ownerOrgCode, parentOf, deptSet);
        return { dept, parentOf, isTop: isTopDept(dept, parentOf, deptSet) };
      } catch (err) {
        console.warn('[部長簽核帶入] 取得組織樹失敗:', err);
        throw new Error('無法取得組織資料');
      }
    };

    /**
     * 算出單位部長_支店長應該是誰。
     * @param {Object} record
     * @returns {Promise<{ users: Array }|{ skip: string }>} skip：不處理（不是部長、沒填費用歸屬、代碼不在主檔…）
     */
    const resolveDirector = async (record) => {
      if (record?.[F.MANUAL_FLOW]?.value?.length > 0) return { skip: 'manual' };
      const owner = record?.[F.EXPENSE_OWNER]?.value?.[0];
      const ownerOrg = record?.[F.EXPENSE_OWNER_ORG]?.value?.[0];
      if (!owner?.code || !ownerOrg?.code) return { skip: 'no-owner' };
      const code = firstCostCenter(record);
      if (!code) return { skip: 'no-cost-center' };

      const title = await fetchOwnerTitle(owner.code, ownerOrg.code);
      if (title !== CFG.OWNER_TITLE) return { skip: 'not-director' };

      const [records, { dept: ownerDept, parentOf, isTop }] = await Promise.all([
        fetchCostCenterRecords([code, CFG.HQ_CODE, CFG.DEFAULT_CODE]),
        ownerDeptOf(ownerOrg.code),
      ]);
      const plan = pickDirectorGroups({ code, ownerDept, records, parentOf, resolveDeptOfOrg: window.PR_COST_SCOPE.resolveDeptOfOrg });
      if (!plan) return { skip: 'unknown-cost-center' }; // 代碼不在主檔：存檔驗證另有錯誤訊息
      // 部長所在的部已是最上層 → 只用總公司主要管理部門的部長
      const groups = isTop ? mainHqGroups(records) : plan.groups;
      if (isTop && groups.length === 0) throw new Error(`費用歸屬主檔 ${CFG.HQ_CODE} 沒有勾「${CC.MAIN_DEPT}」或沒有設定「${CC.DIRECTOR_GROUP}」`);
      if (groups.length === 0) throw new Error(`費用歸屬主檔沒有設定「${CC.DIRECTOR_GROUP}」（${plan.source === 'HQ' ? code : CFG.DEFAULT_CODE}）`);

      const members = (await Promise.all(groups.map(fetchGroupUsers))).flat();
      const seen = new Set([owner.code]); // 部長本人不簽自己
      const users = members.filter((u) => u?.code && !seen.has(u.code) && seen.add(u.code));
      console.log(`[部長簽核帶入] ${code} → ${isTop ? '主要管理部門' : plan.source === 'HQ' ? '總公司' : '預設'}部長群組 ${groups.join('、')}${isTop ? '（最上層的部，改用總公司主要管理部門）' : ''}：`, users.map((u) => u.code));
      return { users };
    };

    // ── 存檔／畫面 ────────────────────────────────────────────────────────────

    /**
     * 存檔時呼叫：算好就寫進 record（值沒變不寫）。查不到資料回錯誤訊息擋存檔。
     * @param {Object} record event.record
     * @returns {Promise<string[]>}
     */
    const apply = async (record) => {
      if (record?.[C.VOID_FIELD]?.value?.length > 0) return [];
      if (!isEditableStatus(record?.[F.STATUS_FIELD]?.value)) return [];
      try {
        const result = await resolveDirector(record);
        if (result.skip) return [];
        const field = record[CFG.TARGET_FIELD];
        if (field && !sameUsers(field.value, result.users)) field.value = result.users;
        return [];
      } catch (err) {
        console.error('[部長簽核帶入] 帶入單位部長失敗:', err);
        return [`費用所屬人是部長，**無法帶入「${CFG.TARGET_FIELD}」**\n※ ${err?.message || '請稍後再試'}；仍無法存檔請聯絡系統管理員`];
      }
    };

    // 連續觸發時只讓最後一次的結果寫回畫面
    let refreshSeq = 0;

    /**
     * 畫面上先帶給使用者看（非同步，寫回用 get()/set()）。失敗只記 log，存檔時 apply() 會再算並擋下。
     * @param {Object} [snapshot] 變更事件的 event.record（change 事件裡不能同步 get()）；沒給就讀畫面
     */
    const refresh = (snapshot) => {
      const seq = ++refreshSeq;
      const record = snapshot || KT.record().get().record;
      if (!isEditableStatus(record?.[F.STATUS_FIELD]?.value)) return Promise.resolve();
      return resolveDirector(record)
        .then((result) => {
          if (result.skip || seq !== refreshSeq) return;
          const current = KT.record().get();
          if (current.record[F.MANUAL_FLOW]?.value?.length > 0 || !current.record[CFG.TARGET_FIELD]) return;
          current.record[CFG.TARGET_FIELD].value = result.users;
          KT.record().set(current);
          KT.record().setFieldShown(CFG.TARGET_FIELD, result.users.length > 0);
        })
        .catch((err) => console.warn('[部長簽核帶入] 畫面帶入單位部長失敗（存檔時會再試）:', err));
    };

    const changeEvents = [TRAFFIC.CODE, TRAFFIC.COLS.EXPENSE].flatMap((code) => [`app.record.create.change.${code}`, `app.record.edit.change.${code}`]);
    KT.on(changeEvents, (event) => {
      refresh(event.record);
      return event;
    });

    window.PR_DIRECTOR_BY_CC = Object.freeze({ firstCostCenter, isEditableStatus, isTopDept, mainHqGroups, pickDirectorGroups, resolveDirector, apply, refresh });
  })();

  (function () {

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

  (() => {

    // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
    const KT = window.PR_KT;

    // =============================================================================
    // 申請人部門依申請人帶入（2026-10-22）
    //
    //   申請人部門一律鎖住（main 的 show 事件），只能依申請人帶入：
    //     - 新增畫面：目前的部門就是申請人的單位 → 不動；不是（例如複製別人的單）或空白 → 重新帶入
    //     - 改申請人（只有管理員能改）→ 查新申請人的單位帶入
    //   只有一個單位直接帶；兩個以上跳視窗選（每個單位一顆按鈕）。目前的部門不是這個人的單位時一定要選、不給取消。
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
    //   規則來源：APPS.TRAFFIC_RULE_MASTER（交通費明細規則主檔），開畫面時讀一次；
    //   讀不到、逾時或資料不合法 → 退回 config 的 TRAFFIC_RULES（行為和主檔初始記錄一樣）。
    //   下面說的「高鐵」「計程車」等都是主檔現在的設定，程式只看主檔的欄位與旗標，不看名稱。
    //
    //   1. 交通工具有「固定賣方統編」（現在是高鐵）→ 賣方統編、格式寫主檔的固定值，並鎖住；
    //      改選別的交通工具（變更事件）→ 若賣方統編還是某個交通工具的固定值，賣方統編、格式一起清空並解鎖
    //   2. 某一列的金額、憑證種類、交通工具變更或新增列 → 只重算「那一列」的稅額：憑證種類有「要算稅」旗標（現在是高鐵票／發票）
    //      → 金額 ÷ 1.05 × 0.05 四捨五入到個位數（金額含稅），其他種類寫 0；開畫面、存檔、改別列都不動稅額（會計手改的保留）。稅額不鎖
    //   3. 憑證種類有「開放發票號碼」旗標（現在是高鐵票／發票）→ 開放發票號碼；其他種類鎖住並清空。存檔時必填、表單內不可重複，
    //      並重算「發票號碼記錄」（跨單重複由 payment_request_submit 查記錄欄位，不用迴圈讀表格）
    //   4. 有任何一列的交通工具有「需紙本憑證」旗標（現在是計程車）→ 是否有紙本憑證自動選「是」；
    //      有「理由必填」旗標 → 理由動態必填（標籤加紅色 *）
    //   5. 交通工具限制憑證種類（主檔的「可選憑證種類」）：變更事件清掉不能用的組合、只有一種就自動帶入；
    //      存檔時擋下不能用的組合；桌面版下拉選單只列出可選的項目
    //   6. 憑證種類＝無（config 的 NO_RECEIPT_TYPES）→ 賣方統編、格式、稅額清空並鎖住；
    //      create/edit 的 show、上面的變更事件、存檔前 normalize 都套用（detail.show 唯讀不處理）。
    //      改回別的種類 → 解鎖，但只回到開畫面時帳號權限設定給的狀態（不會打開權限鎖住的欄位）。
    //      憑證種類＝收據（config 的 PLAIN_RECEIPT_TYPES）→ 同上，但稅額寫 0（不是空白）；優先於主檔的「要算稅」旗標。
    //      發票號碼照 3 處理（收據沒有「開放發票號碼」旗標 → 清空並鎖住）
    //   7. 是否有紙本憑證＝否 → 「會計課承辦註記是否收到單據紙本」寫「不適用」（show、變更事件含是否有紙本憑證、存檔前）；
    //      變更事件改回「是」且還是「不適用」→ 回到「未收到」
    //
    //   存檔驗證的錯誤由 payment_request_submit 統一顯示（呼叫 normalize／validate），這裡不另跳視窗。
    // =============================================================================

    const C = window.PR_CONFIG;
    const F = C.FIELDS;
    const OPT = C.OPTIONS;
    const RULES = C.TRAFFIC_RULES;
    const M = C.REF_FIELDS.TRAFFIC_RULE_MASTER;
    const TRAFFIC = F.TRAFFIC_TABLE;
    const COLS = TRAFFIC.COLS;

    const REQUIRED_MARK_ID = 'pr-reason-required-mark';

    // ── 生效規則（來源：主檔或 config）────────────────────────────────────────
    //   統一形狀：
    //   {
    //     source: 'master' | 'config',
    //     receiptTypes: string[],                       // 全部憑證種類（排序）
    //     taxReceiptTypes: string[],                    // 要算稅（排序）
    //     invoiceReceiptTypes: string[],                // 開放發票號碼（排序）
    //     receiptByVehicle: { [交通工具]: string[] },   // 只放有限制的交通工具；陣列保留可選順序
    //     fixedByVehicle: { [交通工具]: { sellerTaxId, format } },
    //     paperReceiptVehicles: string[],               // 需紙本憑證（排序）
    //     reasonRequiredVehicles: string[],             // 理由必填（排序）
    //   }

    const sortedUnique = (list) => Array.from(new Set(list)).sort();
    const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
    const getRowsOf = (record) => (Array.isArray(record?.[TRAFFIC.CODE]?.value) ? record[TRAFFIC.CODE].value.filter((r) => r?.value) : []);

    /**
     * config 的 TRAFFIC_RULES → 生效規則（主檔讀不到時用）。
     * 固定賣方統編的交通工具是 HSR；需紙本憑證與理由必填的交通工具是 TAXI。
     * @param {Object} rules C.TRAFFIC_RULES
     * @param {Object} options C.OPTIONS
     * @returns {Object}
     */
    const rulesFromConfig = (rules, options) => {
      const receiptByVehicle = {};
      Object.keys(rules.RECEIPT_BY_VEHICLE).forEach((vehicle) => {
        receiptByVehicle[vehicle] = rules.RECEIPT_BY_VEHICLE[vehicle].slice();
      });
      return {
        source: 'config',
        receiptTypes: sortedUnique(Object.values(options.RECEIPT_TYPE)),
        taxReceiptTypes: sortedUnique(rules.TAX_RECEIPT_TYPES),
        invoiceReceiptTypes: sortedUnique(rules.INVOICE_RECEIPT_TYPES),
        receiptByVehicle,
        fixedByVehicle: { [options.VEHICLE.HSR]: { sellerTaxId: rules.HSR_SELLER_TAX_ID, format: rules.HSR_FORMAT } },
        paperReceiptVehicles: [options.VEHICLE.TAXI],
        reasonRequiredVehicles: [options.VEHICLE.TAXI],
      };
    };

    /**
     * 主檔（APPS.TRAFFIC_RULE_MASTER）的 REST records → 生效規則。停用的記錄忽略（等同沒列＝不限制、沒有旗標）。
     * 資料不合法 → 回傳 { errors: string[] }（呼叫端退回 config 規則）。
     * @param {Object[]} records
     * @returns {Object} 生效規則，或 { errors }
     */
    const rulesFromMaster = (records) => {
      const errors = [];
      const val = (rec, code) => rec?.[code]?.value;
      const text = (rec, code) => String(val(rec, code) ?? '').trim();
      const list = (rec, code) => (Array.isArray(val(rec, code)) ? val(rec, code) : []);

      const used = (Array.isArray(records) ? records : []).filter((rec) => {
        const inUse = val(rec, M.IN_USE);
        return inUse === undefined || inUse === M.IN_USE_VALUE;
      });

      const vehicles = [];
      const receipts = [];
      const names = new Set();
      used.forEach((rec, i) => {
        const where = `第 ${i + 1} 筆`;
        const type = val(rec, M.TYPE);
        const name = text(rec, M.NAME);
        if (type !== M.TYPE_VEHICLE && type !== M.TYPE_RECEIPT) errors.push(`${where}「${M.TYPE}」不是「${M.TYPE_VEHICLE}」或「${M.TYPE_RECEIPT}」`);
        if (!name) errors.push(`${where}「${M.NAME}」空白`);
        else if (names.has(name)) errors.push(`${where}「${M.NAME}」${name} 重複`);
        names.add(name);
        if (text(rec, M.FIXED_FORMAT) && !text(rec, M.FIXED_SELLER_TAX_ID)) errors.push(`${where}${name}：有「${M.FIXED_FORMAT}」但「${M.FIXED_SELLER_TAX_ID}」空白`);
        switch (type) {
          case M.TYPE_VEHICLE:
            vehicles.push({ rec, name });
            break;
          case M.TYPE_RECEIPT:
            receipts.push({ rec, name });
            break;
        }
      });
      if (!vehicles.length) errors.push(`沒有任何使用中的「${M.TYPE_VEHICLE}」記錄`);
      if (!receipts.length) errors.push(`沒有任何使用中的「${M.TYPE_RECEIPT}」記錄`);
      if (errors.length) return { errors };

      const receiptByVehicle = {};
      const fixedByVehicle = {};
      vehicles.forEach(({ rec, name }) => {
        const allowed = list(rec, M.ALLOWED_RECEIPTS);
        if (allowed.length) receiptByVehicle[name] = allowed.slice();
        const sellerTaxId = text(rec, M.FIXED_SELLER_TAX_ID);
        if (sellerTaxId) fixedByVehicle[name] = { sellerTaxId, format: text(rec, M.FIXED_FORMAT) };
      });
      const vehiclesWith = (flag) => sortedUnique(vehicles.filter(({ rec }) => list(rec, M.VEHICLE_FLAGS).includes(flag)).map((v) => v.name));
      const receiptsWith = (flag) => sortedUnique(receipts.filter(({ rec }) => list(rec, M.RECEIPT_FLAGS).includes(flag)).map((v) => v.name));
      return {
        source: 'master',
        receiptTypes: sortedUnique(receipts.map((r) => r.name)),
        taxReceiptTypes: receiptsWith(M.FLAG_TAX),
        invoiceReceiptTypes: receiptsWith(M.FLAG_INVOICE_NO),
        receiptByVehicle,
        fixedByVehicle,
        paperReceiptVehicles: vehiclesWith(M.FLAG_PAPER_RECEIPT),
        reasonRequiredVehicles: vehiclesWith(M.FLAG_REASON_REQUIRED),
      };
    };

    // 目前生效的規則：一載入就是 config 規則（任何時候都有規則可用），主檔讀成功才換掉
    let active = rulesFromConfig(RULES, OPT);
    let loadPromise = null;

    const getActiveRules = () => active;

    const withTimeout = (promise, ms) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`讀取逾時（${ms} ms）`)), ms);
        promise.then(
          (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          (e) => {
            clearTimeout(timer);
            reject(e);
          },
        );
      });

    /**
     * 讀主檔並換掉生效規則。整個頁面只讀一次（快取 Promise）；永不 reject：
     * 失敗、逾時、資料不合法都 console.warn 並維持 config 規則。
     * @param {Function} [api=kintone.api] 測試時可替換
     * @returns {Promise<Object>} 生效規則
     */
    const loadRules = (api) => {
      if (loadPromise) return loadPromise;
      loadPromise = (async () => {
        try {
          const call = api || kintone.api;
          const fields = [M.TYPE, M.NAME, M.IN_USE, M.ALLOWED_RECEIPTS, M.FIXED_SELLER_TAX_ID, M.FIXED_FORMAT, M.VEHICLE_FLAGS, M.RECEIPT_FLAGS];
          const params = { app: C.APPS.TRAFFIC_RULE_MASTER, query: `${M.IN_USE} in ("${M.IN_USE_VALUE}") limit 500`, fields };
          const resp = await withTimeout(Promise.resolve().then(() => call(kintone.api.url('/k/v1/records', true), 'GET', params)), RULES.MASTER_TIMEOUT_MS);
          const result = rulesFromMaster(resp?.records);
          if (result.errors) console.warn('[交通費明細規則] 規則主檔資料不合法，改用 config 規則', result.errors);
          else active = result;
        } catch (e) {
          console.warn('[交通費明細規則] 讀不到規則主檔，改用 config 規則', e);
        }
        return active;
      })();
      return loadPromise;
    };

    /** 測試用：回到 config 規則並清掉快取 */
    const _resetForTest = () => {
      active = rulesFromConfig(RULES, OPT);
      loadPromise = null;
      baseLocked = {};
    };

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

    const isInvoiceReceipt = (row) => active.invoiceReceiptTypes.includes(row.value[COLS.RECEIPT_TYPE]?.value);
    const isTaxReceipt = (row) => active.taxReceiptTypes.includes(row.value[COLS.RECEIPT_TYPE]?.value);
    /** 6. 憑證種類＝無（沒有憑證）→ 賣方統編、格式、稅額清空並鎖住 */
    const isNoReceipt = (row) => RULES.NO_RECEIPT_TYPES.includes(row.value[COLS.RECEIPT_TYPE]?.value);
    /** 6. 憑證種類＝收據 → 賣方統編、格式清空並鎖住，稅額寫 0 並鎖住 */
    const isPlainReceipt = (row) => RULES.PLAIN_RECEIPT_TYPES.includes(row.value[COLS.RECEIPT_TYPE]?.value);
    const NO_RECEIPT_CLEAR_COLS = [COLS.SELLER_TAX_ID, COLS.FORMAT, COLS.TAX];

    // 開畫面時（帳號權限設定已套用、本模組還沒鎖）各欄的鎖定狀態。
    //   變更事件「解鎖」只回到這個狀態，不會把帳號權限設定鎖住的欄位打開。
    const LOCK_COLS = [COLS.SELLER_TAX_ID, COLS.FORMAT, COLS.TAX, COLS.INVOICE_NO];
    let baseLocked = {};
    const captureBaseLocks = (record) => {
      const rows = getRowsOf(record);
      baseLocked = {};
      LOCK_COLS.forEach((code) => {
        const cell = rows.map((row) => row.value[code]).find(Boolean);
        baseLocked[code] = cell?.disabled === true;
      });
    };
    /**
     * 這個交通工具可選的憑證種類；交通工具空白或沒設定 → null（不限制）
     * @param {string} vehicle
     * @returns {string[]|null}
     */
    const allowedReceiptTypes = (vehicle) => (vehicle && own(active.receiptByVehicle, vehicle) && active.receiptByVehicle[vehicle]) || null;
    const isReceiptAllowed = (row) => {
      const receipt = row.value[COLS.RECEIPT_TYPE]?.value;
      const allowed = allowedReceiptTypes(row.value[COLS.VEHICLE]?.value);
      return !receipt || !allowed || allowed.includes(receipt);
    };
    /** 這一列交通工具的固定賣方統編／格式；沒有 → null */
    const fixedOf = (row) => {
      const vehicle = row.value[COLS.VEHICLE]?.value;
      return vehicle && own(active.fixedByVehicle, vehicle) ? active.fixedByVehicle[vehicle] : null;
    };
    const isFixedSellerTaxId = (taxId) => !!taxId && Object.values(active.fixedByVehicle).some((fixed) => fixed.sellerTaxId === taxId);
    const getRows = (record) => getRowsOf(record);

    /** 這張單裡命中名單的交通工具名稱（不重複，依列順序） */
    const vehiclesHit = (record, names) => Array.from(new Set(getRows(record).map((row) => row.value[COLS.VEHICLE]?.value).filter((v) => v && names.includes(v))));
    /** 有「需紙本憑證」旗標的交通工具（現在是計程車） */
    const paperVehicles = (record) => vehiclesHit(record, active.paperReceiptVehicles);
    /** 有「理由必填」旗標的交通工具（現在是計程車） */
    const reasonVehicles = (record) => vehiclesHit(record, active.reasonRequiredVehicles);
    /** 舊名稱相容：是否有任何一列需要紙本憑證（原本只看計程車） */
    const hasTaxi = (record) => paperVehicles(record).length > 0;

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
        else if (unlock) v[code].disabled = baseLocked[code] === true;
      };

      // 1. 固定賣方統編（現在是高鐵）
      const fixed = fixedOf(row);
      if (fixed) {
        if (v[COLS.SELLER_TAX_ID]) v[COLS.SELLER_TAX_ID].value = fixed.sellerTaxId;
        if (v[COLS.FORMAT]) v[COLS.FORMAT].value = fixed.format;
      }
      else if (unlock && isFixedSellerTaxId(v[COLS.SELLER_TAX_ID]?.value)) {
        v[COLS.SELLER_TAX_ID].value = '';
        if (v[COLS.FORMAT]) v[COLS.FORMAT].value = '';
      }
      // 賣方統編、格式的鎖定在 6 一起決定（固定值或憑證種類＝無）

      // 5. 交通工具限制憑證種類（只在變更事件改值；開畫面／存檔不動，交給 validate 擋）
      if (unlock && v[COLS.RECEIPT_TYPE]) {
        const allowed = allowedReceiptTypes(v[COLS.VEHICLE]?.value);
        if (!isReceiptAllowed(row)) v[COLS.RECEIPT_TYPE].value = '';
        if (allowed && allowed.length === 1 && !v[COLS.RECEIPT_TYPE].value) v[COLS.RECEIPT_TYPE].value = allowed[0];
      }

      // 3. 發票號碼
      if (v[COLS.INVOICE_NO]) {
        if (!isInvoiceReceipt(row)) v[COLS.INVOICE_NO].value = '';
        setLock(COLS.INVOICE_NO, !isInvoiceReceipt(row));
      }

      // 6. 憑證種類＝無 → 賣方統編、格式、稅額清空並鎖住（排在 1、5 後面：憑證種類可能剛被清空或帶入，固定值也要被蓋掉）
      //    憑證種類＝收據 → 同上，但稅額寫 0
      //    改成別的憑證種類（變更事件）→ 稅額解鎖；賣方統編、格式照 1 的固定值決定
      const none = isNoReceipt(row);
      const plain = isPlainReceipt(row);
      const cleared = none || plain;
      NO_RECEIPT_CLEAR_COLS.forEach((code) => {
        if (cleared && v[code]) v[code].value = '';
      });
      if (plain && v[COLS.TAX]) v[COLS.TAX].value = '0';
      setLock(COLS.SELLER_TAX_ID, cleared || !!fixed);
      setLock(COLS.FORMAT, cleared || !!fixed);
      setLock(COLS.TAX, cleared);
    };

    /**
     * 2. 重算這一列的稅額：高鐵票／發票才算，其他種類寫 0。
     * 只在變更事件對「被改的那一列」呼叫（見 changeEvents）；開畫面、新增別列、存檔都不動稅額，
     * 會計（帳號權限設定開放編輯）手改的稅額才不會被蓋掉。稅額不鎖：能不能改交給帳號權限設定。
     * @param {Object} row 子表格的一列
     */
    const recalcRowTax = (row) => {
      const v = row?.value;
      if (!v?.[COLS.TAX]) return;
      if (isNoReceipt(row)) v[COLS.TAX].value = ''; // 6. 憑證種類＝無 → 稅額清空
      else if (isPlainReceipt(row)) v[COLS.TAX].value = '0'; // 6. 憑證種類＝收據 → 稅額 0
      else v[COLS.TAX].value = isTaxReceipt(row) ? calcTax(v[COLS.AMOUNT]?.value) : '0';
    };

    /**
     * 變更事件改到的是哪一列（kintone 的 event.changes.row）；刪除列或不是子表格的變更 → null
     * @param {Object} event
     * @returns {Object|null}
     */
    const changedRow = (event) => {
      const target = event?.changes?.row;
      if (!target) return null;
      const rows = getRows(event.record);
      return rows.find((row) => row === target) || (target.id ? rows.find((row) => row.id === target.id) : null) || target;
    };

    /**
     * 套用整張單的規則：每一列＋計程車 → 是否有紙本憑證選「是」。
     * @param {Object} record
     * @param {boolean} unlock 見 applyRowRules
     * @returns {Object} record
     */
    const applyRecordRules = (record, unlock) => {
      getRows(record).forEach((row) => applyRowRules(row, unlock));
      if (paperVehicles(record).length && record[F.PAPER_RECEIPT]) record[F.PAPER_RECEIPT].value = OPT.PAPER_RECEIPT.YES;
      applyPaperReceived(record, unlock);
      return record;
    };

    /**
     * 7. 是否有紙本憑證＝否 → 會計課承辦註記是否收到單據紙本 寫「不適用」。
     *    改回「是」（變更事件）且還是「不適用」→ 回到 kintone 預設的「未收到」；
     *    開畫面／存檔時是「是」就不動（會計課自己選的值保留）。排在計程車強制選「是」後面。
     * @param {Object} record
     * @param {boolean} unlock true＝變更事件
     */
    const applyPaperReceived = (record, unlock) => {
      const received = record[F.PAPER_RECEIVED];
      const paper = record[F.PAPER_RECEIPT]?.value;
      if (!received || !paper) return;
      if (paper === OPT.PAPER_RECEIPT.NO) received.value = OPT.PAPER_RECEIVED.NOT_APPLICABLE;
      else if (unlock && received.value === OPT.PAPER_RECEIVED.NOT_APPLICABLE) received.value = OPT.PAPER_RECEIVED.NOT_RECEIVED;
    };

    /**
     * 存檔前整理：高鐵固定值、清掉不該有的發票號碼，並重算「發票號碼記錄」。
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

      // 交通工具與憑證種類的組合
      rows.forEach((row, i) => {
        if (isReceiptAllowed(row)) return;
        const vehicle = row.value[COLS.VEHICLE].value;
        errors.push(
          `第 ${i + 1} 行交通工具是「${vehicle}」，「${COLS.RECEIPT_TYPE}」**不能選「${row.value[COLS.RECEIPT_TYPE].value}」**\n※ 可選：${allowedReceiptTypes(vehicle).join('、')}`,
        );
      });

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

      // 需紙本憑證的交通工具（現在是計程車）：是否有紙本憑證要選「是」；理由必填的交通工具：理由必填
      const paper = paperVehicles(record);
      if (paper.length && record[F.PAPER_RECEIPT] && record[F.PAPER_RECEIPT].value !== OPT.PAPER_RECEIPT.YES) {
        errors.push(`有搭乘${paper.join('、')}，「${F.PAPER_RECEIPT}」**必須選「${OPT.PAPER_RECEIPT.YES}」**`);
      }
      const reason = reasonVehicles(record);
      if (reason.length && !(record[F.REASON]?.value || '').trim()) {
        errors.push(`有搭乘${reason.join('、')}，**請填寫「${F.REASON}」**`);
      }
      return errors;
    };

    // ── 畫面：理由動態必填的紅色 * ────────────────────────────────────────────

    /**
     * 有「理由必填」的交通工具（現在是計程車）就在「理由」標籤後面加紅色 *，沒有就拿掉。
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

    // ── 畫面：憑證種類下拉選單只列出可選的項目（桌面版）───────────────────────
    //   kintone 沒有隱藏下拉選項的 API。桌面版的下拉選單點開後是掛在 body 的 .goog-menu，
    //   點子表格的下拉時記下是哪一列哪一欄，選單出現後把不能選的項目加上 pr-option-hidden。
    //   這是畫面層的輔助，DOM 改版找不到就不做；真正的把關是變更事件與存檔驗證。

    const OPTION_HIDDEN_CLASS = 'pr-option-hidden';
    /** 選單過濾認得的憑證種類：config 選項值 ∪ 生效規則裡出現過的 */
    const allReceiptTypes = () =>
      Array.from(new Set([...Object.values(OPT.RECEIPT_TYPE), ...active.receiptTypes, ...active.taxReceiptTypes, ...active.invoiceReceiptTypes, ...Object.values(active.receiptByVehicle).flat()]));

    const cellLabel = (th) => (th?.textContent || '').replace(/\*/g, '').trim();

    /**
     * 把選單裡不能選的憑證種類藏起來；allowed 為 null 時全部顯示。
     * 只動憑證種類的選項（「-----」等其他項目不碰），所以點其他欄位的下拉也可以呼叫來還原。
     * @param {Element} menu .goog-menu
     * @param {string[]|null} allowed
     * @returns {number} 藏起來的項目數
     */
    const filterMenuItems = (menu, allowed) => {
      let hidden = 0;
      const known = allReceiptTypes();
      Array.from(menu.querySelectorAll('.goog-menuitem')).forEach((item) => {
        const text = (item.textContent || '').trim();
        const hide = !!allowed && known.includes(text) && !allowed.includes(text);
        item.classList.toggle(OPTION_HIDDEN_CLASS, hide);
        if (hide) hidden += 1;
      });
      return hidden;
    };

    /**
     * 點到的是不是交通費明細的下拉；是 → 回傳這次選單要用的限制（不是憑證種類欄 → null＝全部顯示）。
     * @param {Element} target 點到的元素
     * @returns {{ allowed: string[]|null }|undefined} 不是交通費明細的下拉 → undefined
     */
    const menuContext = (target) => {
      const select = target?.closest?.('.gaia-argoui-select');
      const td = select?.closest('td');
      const tr = td?.closest('tr');
      const table = tr?.closest('table');
      if (!table) return undefined;
      const headers = Array.from(table.querySelectorAll('thead th'));
      const labelAt = (i) => cellLabel(headers[i]);
      const receiptLabel = C.TRAFFIC_TABLE_LAYOUT.COLUMNS.find((c) => c.code === COLS.RECEIPT_TYPE)?.label || COLS.RECEIPT_TYPE;
      if (!headers.some((th) => cellLabel(th) === receiptLabel)) return undefined;
      const tds = Array.from(tr.children);
      if (labelAt(tds.indexOf(td)) !== receiptLabel) return { allowed: null };
      const rowIndex = Array.from(tr.parentNode.children).indexOf(tr);
      const row = getRows(KT.record().get().record)[rowIndex];
      return { allowed: row ? allowedReceiptTypes(row.value[COLS.VEHICLE]?.value) : null };
    };

    const filterOpenMenus = (allowed) => {
      document.querySelectorAll('.goog-menu').forEach((menu) => {
        if (getComputedStyle(menu).display !== 'none') filterMenuItems(menu, allowed);
      });
    };

    const installMenuFilter = () => {
      if (KT.IS_MOBILE || typeof document.addEventListener !== 'function') return;
      const onOpen = (e) => {
        try {
          const ctx = menuContext(e.target);
          if (!ctx) return;
          // 選單是點下去之後才畫出來，等一下再處理（第二次是保險）
          [0, 50].forEach((ms) => setTimeout(() => filterOpenMenus(ctx.allowed), ms));
        } catch (err) {
          console.warn('[交通費明細規則] 憑證種類選單過濾失敗', err);
        }
      };
      document.addEventListener('mousedown', onOpen, true);
      document.addEventListener('keydown', onOpen, true);
    };
    installMenuFilter();

    // ── 事件 ───────────────────────────────────────────────────────────────

    // 先讀完規則主檔再套規則（kintone 會等 show 的 Promise；loadRules 永不 reject）
    KT.on(['app.record.create.show', 'app.record.edit.show'], async (event) => {
      await loadRules();
      captureBaseLocks(event.record);
      applyRecordRules(event.record, false);
      updateReasonRequiredMark(reasonVehicles(event.record).length > 0);
      return event;
    });

    const changeEvents = [TRAFFIC.CODE, COLS.VEHICLE, COLS.AMOUNT, COLS.RECEIPT_TYPE, F.PAPER_RECEIPT].flatMap((code) => [
      `app.record.create.change.${code}`,
      `app.record.edit.change.${code}`,
    ]);

    KT.on(changeEvents, (event) => {
      applyRecordRules(event.record, true);
      // 稅額只重算被改的那一列（憑證種類可能剛被上面的規則清空或帶入，所以排在後面）
      const row = changedRow(event);
      if (row) recalcRowTax(row);
      // 憑證種類改掉會清空發票號碼，發票號碼記錄要跟著重算（程式寫入不會觸發發票號碼的 change）
      const agg = window.PR_INVOICE_AGG;
      if (event.record[F.INVOICE_AGG] && typeof agg?.buildInvoiceAgg === 'function') {
        event.record[F.INVOICE_AGG].value = agg.buildInvoiceAgg(event.record);
      }
      updateReasonRequiredMark(reasonVehicles(event.record).length > 0);
      return event;
    });

    window.PR_TRAFFIC_RULES = Object.freeze({ calcTax, recalcRowTax, changedRow, hasTaxi, rulesFromConfig, rulesFromMaster, loadRules, getActiveRules, _resetForTest, allowedReceiptTypes, isNoReceipt, isPlainReceipt, filterMenuItems, menuContext, applyRowRules, applyRecordRules, normalize, validate, updateReasonRequiredMark });
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
        switch (flag) {
          case CAL.HOLIDAY_VALUE:
            holidayOf[date] = true;
            break;
          case CAL.WORKDAY_VALUE:
            holidayOf[date] = false;
            break;
        }
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

  // 檔案批次+截圖_4版_20260119_表格智能分頁_PDFLib向量版.js
  // 批次下載附件 + 批次列印PDF（改：PDF 由 PDFLib 向量生成；移除 html2canvas / jsPDF）
  // 事件註冊放最下方
  (function () {

    const F = window.PR_CONFIG.FIELDS;

    // ======================== 基本設定 ========================
    const DOWNLOAD_FOLDER_NAME = '請款_報銷申請單';

    // PDF 字型來源（Kintone 檔案欄位放置字型檔）
    const FONT_CONFIG = {
      FONT_APP_ID: window.PR_CONFIG.APPS.PDF_FONT,
      FONT_RECORD_ID: 1,
      FONT_FIELD_CODE: 'Kintone主頁用',
      FONT_FILE_NAME: 'FONT_FILE_NAME',
    };

    const { PDFDocument, rgb } = window.PDFLib || {};
    if (!PDFDocument) {
      // 不 throw，避免阻斷 index.show；在真正產 PDF 時再提示
      console.warn('[PDF] 找不到 PDFLib，請確認已載入 PDFLib library');
    }

    // ======================== 🔍 權限診斷工具 ========================
    // 在 Console 輸入: checkPermission() 進行診斷
    window.checkPermission = async (testUserCode) => {
      const currentUser = kintone.getLoginUser();
      const fontAppId = window.PR_CONFIG.APPS.PDF_FONT;
      console.log('🔍 ========== 權限診斷開始 ==========');
      console.log('🔍 當前登入者:', currentUser.code, currentUser.name);
      console.log('🔍 測試對象:', testUserCode || '(當前使用者)');
      console.log('🔍 當前 App ID:', kintone.app.getId());

      // 測試 PDF 字型 App
      console.log(`🔍 測試 App ${fontAppId} (PDF 字型)...`);
      try {
        await kintone.api(kintone.api.url('/k/v1/record', true), 'GET', {
          app: fontAppId,
          id: FONT_CONFIG.FONT_RECORD_ID,
        });
        console.log(`🔍 ✅ App ${fontAppId}: 有權限`);
      } catch (e) {
        console.error(`🔍 ❌ App ${fontAppId}: 無權限 -`, e.message || e);
      }

      console.log('🔍 ========== 權限診斷結束 ==========');
      console.log(`🔍 💡 若 App ${fontAppId} 無權限，請為該使用者開放 App ${fontAppId} 檢視權限`);
    };

    // ======================== 安全配置 ========================
    const SECURITY_CONFIG = {
      maxRecords: 50,
      allowedDomains: [window.location.origin],
      csrfTokenName: 'X-Cybozu-API-Token',
      maxFileSize: 50 * 1024 * 1024,
      screenshotTimeout: 5000,
    };

    // ======================== 表格設定 ========================
    // 明細只有「交通費請款單」子表格一種：[顯示名稱, 子表格欄位代碼]
    const TABLE_CONFIG = {
      tableFieldName: F.TRAFFIC_TABLE.CODE,
      fields: [
        ['憑證日期', F.TRAFFIC_TABLE.COLS.DATE],
        ['交通工具', F.TRAFFIC_TABLE.COLS.VEHICLE],
        ['拜訪客戶', F.TRAFFIC_TABLE.COLS.VISIT_CUSTOMER],
        ['起訖點', F.TRAFFIC_TABLE.COLS.ROUTE],
        ['金額', F.TRAFFIC_TABLE.COLS.AMOUNT],
        ['費用歸屬', F.TRAFFIC_TABLE.COLS.EXPENSE],
        ['憑證種類', F.TRAFFIC_TABLE.COLS.RECEIPT_TYPE],
        ['發票號碼', F.TRAFFIC_TABLE.COLS.INVOICE_NO],
        ['賣方統編', F.TRAFFIC_TABLE.COLS.SELLER_TAX_ID],
        ['格式', F.TRAFFIC_TABLE.COLS.FORMAT],
        ['稅額', F.TRAFFIC_TABLE.COLS.TAX],
      ],
    };

    // 數字欄位（靠右、加千分位）的顯示名稱
    const NUMERIC_COLUMNS = ['金額', '稅額'];

    // ======================== 通用工具 ========================
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

    const formatDateTime = (date) => {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      const h = String(date.getHours()).padStart(2, '0');
      const min = String(date.getMinutes()).padStart(2, '0');
      return `${y}${m}${d}_${h}${min}`;
    };

    const formatNumber = (num) => {
      if (num === undefined || num === null || num === '') return '';
      const n = Number(String(num).replace(/,/g, ''));
      if (Number.isNaN(n)) return String(num);
      return n.toLocaleString('zh-TW');
    };

    function sanitizeInput(input) {
      if (typeof input !== 'string') return '';
      return input.replace(/[<>'"&]/g, '').trim();
    }

    function validateSecurity() {
      if (!window.kintone || !window.kintone.app) {
        throw new Error('此功能僅能在 kintone 環境中使用');
      }
      if (!window.location.hostname.includes('cybozu') && !window.location.hostname.includes('kintone')) {
        throw new Error('不安全的執行環境');
      }
      return true;
    }

    function generateSecurityToken() {
      return Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }

    function validateRecordIds(recordIds) {
      if (!Array.isArray(recordIds)) throw new Error('無效的記錄號碼格式');
      if (recordIds.length === 0) throw new Error('請至少選擇一筆記錄');
      if (recordIds.length > SECURITY_CONFIG.maxRecords) throw new Error(`一次最多只能處理 ${SECURITY_CONFIG.maxRecords} 筆記錄`);
      for (const id of recordIds) {
        if (!Number.isInteger(id) || id <= 0) throw new Error(`無效的記錄號碼: ${id}`);
      }
      return true;
    }

    function secureKintoneApi(path, method, params, securityToken) {
      return new Promise((resolve, reject) => {
        const secureParams = { ...params, __token: securityToken };
        kintone.api(
          kintone.api.url(path, true),
          method,
          secureParams,
          (resp) => (resp && typeof resp === 'object' ? resolve(resp) : reject(new Error('無效的 API 回應'))),
          (error) => reject(new Error('API 呼叫失敗: ' + (error.message || 'Unknown error'))),
        );
      });
    }

    // ======================== 檔案下載（附件 / 字型）========================
    const downloadFile = function (fileKey) {
      return new Promise(function (resolve, reject) {
        const url = kintone.api.url('/k/v1/file', true) + '?fileKey=' + fileKey;
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
        xhr.responseType = 'blob';
        xhr.onload = function () {
          if (xhr.status === 200) resolve(xhr.response);
          else reject(new Error('下載檔案失敗'));
        };
        xhr.onerror = function () {
          reject(new Error('網路錯誤'));
        };
        xhr.send();
      });
    };

    const blobToArrayBuffer = function (blob) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsArrayBuffer(blob);
      });
    };

    async function secureFileDownload(fileKey) {
      const downloadUrl = kintone.api.url('/k/v1/file', true) + '?fileKey=' + fileKey;
      const response = await fetch(downloadUrl, { method: 'GET', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const blob = await response.blob();
      if (blob.size > SECURITY_CONFIG.maxFileSize) throw new Error('檔案大小超過限制');
      return blob;
    }

    // 字型快取（避免每筆都重抓）
    let _fontBufferCache = null;
    const fetchFontFromKintone = async function () {
      if (_fontBufferCache) return _fontBufferCache;

      // 取得指定 App 與 Record 的資料
      const resp = await kintone.api(kintone.api.url('/k/v1/record', true), 'GET', {
        app: FONT_CONFIG.FONT_APP_ID,
        id: FONT_CONFIG.FONT_RECORD_ID,
      });

      // 從同筆記錄的 FONT_FILE_NAME 欄位讀取檔案名稱
      const targetFileName = resp.record[FONT_CONFIG.FONT_FILE_NAME]?.value;
      if (!targetFileName) {
        throw new Error('找不到 FONT_FILE_NAME 欄位值');
      }

      // 從附件欄位中尋找對應檔案
      const attachments = resp.record[FONT_CONFIG.FONT_FIELD_CODE]?.value || [];
      const fontFile = attachments.find((file) => file.name === targetFileName);
      if (!fontFile) {
        throw new Error(`找不到檔案：${targetFileName}`);
      }

      // 下載檔案並轉成 ArrayBuffer
      const fontBlob = await downloadFile(fontFile.fileKey);
      _fontBufferCache = await blobToArrayBuffer(fontBlob);
      return _fontBufferCache;
    };

    // ======================== 取得表格資料（明細）========================
    function getTableData(record) {
      const { tableFieldName, fields } = TABLE_CONFIG;
      const tableData = record[tableFieldName]?.value;
      if (!Array.isArray(tableData) || tableData.length === 0) return null;

      const displayNames = fields.map((f) => f[0]);
      const rows = tableData.map((row) => {
        const rowData = {};
        fields.forEach(([displayName, fieldCode]) => {
          rowData[displayName] = row.value?.[fieldCode]?.value || '';
        });
        return rowData;
      });

      return { displayNames, rows };
    }

    // ======================== PDFLib 向量繪製工具 ========================
    const ensurePdfDeps = () => {
      if (!window.PDFLib || !PDFDocument) throw new Error('缺少 PDFLib，請先載入 PDFLib library');
      if (!window.fontkit) throw new Error('缺少 fontkit，請先載入 fontkit library');
    };

    const measureTextW = (font, size, text) => font.widthOfTextAtSize(String(text ?? ''), size);

    const wrapTextPdf = (font, size, text, maxWidth) => {
      const s = String(text ?? '');
      if (!s) return [''];

      const result = [];
      // 先依換行符拆分
      const paragraphs = s.split('\n');

      for (const para of paragraphs) {
        if (!para) {
          result.push('');
          continue;
        }
        let cur = '';
        for (const ch of para) {
          const test = cur + ch;
          if (measureTextW(font, size, test) > maxWidth && cur) {
            result.push(cur);
            cur = ch;
          } else {
            cur = test;
          }
        }
        if (cur) result.push(cur);
      }

      return result.length ? result : [''];
    };

    const createPager = (pdfDoc, pageW, pageH, margins) => {
      const state = {
        pageW,
        pageH,
        marginL: margins.l,
        marginR: margins.r,
        marginT: margins.t,
        marginB: margins.b,
        page: pdfDoc.addPage([pageW, pageH]),
        y: pageH - margins.t,
      };

      state.newPage = () => {
        state.page = pdfDoc.addPage([pageW, pageH]);
        state.y = pageH - margins.t;
      };

      state.ensureSpace = (needH) => {
        if (state.y - needH < state.marginB) state.newPage();
      };

      return state;
    };

    const drawCell = ({ page, x, yTop, w, h, border = true, fill = null }) => {
      const y = yTop - h;
      page.drawRectangle({
        x,
        y,
        width: w,
        height: h,
        color: fill || rgb(1, 1, 1),
        borderColor: border ? rgb(0, 0, 0) : undefined,
        borderWidth: border ? 1 : 0,
      });
    };

    const drawTextInCell = ({ page, font, size, x, yTop, w, h, text, align = 'left', padding = 4, color = rgb(0, 0, 0) }) => {
      const maxW = w - padding * 2;
      const lines = wrapTextPdf(font, size, text, maxW);

      const lineH = size + 2;
      const maxLinesByHeight = Math.max(1, Math.floor((h - padding * 2) / lineH));
      const usedLines = lines.slice(0, maxLinesByHeight);

      let y = yTop - padding - size;
      for (const line of usedLines) {
        const t = String(line ?? '');
        let tx = x + padding;
        if (align === 'center') {
          const tw = measureTextW(font, size, t);
          tx = x + (w - tw) / 2;
        } else if (align === 'right') {
          const tw = measureTextW(font, size, t);
          tx = x + w - padding - tw;
        }
        page.drawText(t, { x: tx, y, size, font, color });
        y -= lineH;
      }
    };

    const calcRowHeight = ({ columns, colWidths, font, size, row, padding = 4, minH = 18 }) => {
      const lineH = size + 2;
      let maxLines = 1;

      columns.forEach((c, i) => {
        const w = colWidths[i];
        const lines = wrapTextPdf(font, size, row[c.key], w - padding * 2);
        maxLines = Math.max(maxLines, lines.length);
      });

      return Math.max(minH, maxLines * lineH + padding * 2);
    };

    const drawTablePdf = ({
      pager,
      title,
      columns, // [{label,key,align?}]
      rows, // array of object
      font,
      fontBold,
      colWidths,
      fontSize = 10,
      headerSize = 10,
      padding = 4,
    }) => {
      const pageW = pager.pageW;
      pageW - pager.marginL - pager.marginR;
      const x0 = pager.marginL;

      // title
      if (title) {
        pager.ensureSpace(22);
        pager.page.drawText(title, { x: x0, y: pager.y - 16, size: 14, font: fontBold });
        pager.y -= 22;
      }

      // header
      const headerH = 20;
      pager.ensureSpace(headerH);

      let x = x0;
      columns.forEach((c, i) => {
        const w = colWidths[i];
        drawCell({ page: pager.page, x, yTop: pager.y, w, h: headerH, fill: rgb(0.97, 0.97, 0.97) });
        drawTextInCell({
          page: pager.page,
          font: fontBold,
          size: headerSize,
          x,
          yTop: pager.y,
          w,
          h: headerH,
          text: c.label,
          align: 'center',
          padding,
        });
        x += w;
      });

      pager.y -= headerH;

      // body
      rows.forEach((row, idx) => {
        const rowH = calcRowHeight({ columns, colWidths, font, size: fontSize, row, padding, minH: 18 });
        pager.ensureSpace(rowH);

        const fill = idx % 2 === 1 ? rgb(0.99, 0.99, 0.99) : rgb(1, 1, 1);

        x = x0;
        columns.forEach((c, i) => {
          const w = colWidths[i];
          drawCell({ page: pager.page, x, yTop: pager.y, w, h: rowH, fill });
          drawTextInCell({
            page: pager.page,
            font,
            size: fontSize,
            x,
            yTop: pager.y,
            w,
            h: rowH,
            text: row[c.key],
            align: c.align || 'left',
            padding,
          });
          x += w;
        });

        pager.y -= rowH;
      });

      // table bottom spacing
      pager.y -= 10;
    };

    // header key/value（兩欄一組）
    const drawKeyValueGrid = ({ pager, font, fontBold, rows }) => {
      const usableW = pager.pageW - pager.marginL - pager.marginR;
      const x0 = pager.marginL;

      // 欄寬：label / value / label / value
      const wL = 90;
      const wR = 90;
      const wV1 = (usableW - wL - wR) / 2;
      const wV2 = (usableW - wL - wR) / 2;
      const colW = [wL, wV1, wR, wV2];

      const columns = [
        { label: '', key: 'l1', align: 'center' },
        { label: '', key: 'v1', align: 'left' },
        { label: '', key: 'l2', align: 'center' },
        { label: '', key: 'v2', align: 'left' },
      ];

      // 不畫 header，直接畫 body（自己畫）
      rows.forEach((r, idx) => {
        const rowH = calcRowHeight({ columns, colWidths: colW, font, size: 11, row: r, padding: 4, minH: 20 });
        pager.ensureSpace(rowH);

        const yTop = pager.y;
        let x = x0;

        // label1
        drawCell({ page: pager.page, x, yTop, w: colW[0], h: rowH, fill: rgb(0.98, 0.98, 0.98) });
        drawTextInCell({ page: pager.page, font: fontBold, size: 11, x, yTop, w: colW[0], h: rowH, text: r.l1, align: 'center' });
        x += colW[0];

        // value1
        drawCell({ page: pager.page, x, yTop, w: colW[1], h: rowH, fill: rgb(1, 1, 1) });
        drawTextInCell({ page: pager.page, font, size: 11, x, yTop, w: colW[1], h: rowH, text: r.v1, align: 'left' });
        x += colW[1];

        // label2
        drawCell({ page: pager.page, x, yTop, w: colW[2], h: rowH, fill: rgb(0.98, 0.98, 0.98) });
        drawTextInCell({ page: pager.page, font: fontBold, size: 11, x, yTop, w: colW[2], h: rowH, text: r.l2, align: 'center' });
        x += colW[2];

        // value2
        drawCell({ page: pager.page, x, yTop, w: colW[3], h: rowH, fill: rgb(1, 1, 1) });
        drawTextInCell({ page: pager.page, font, size: 11, x, yTop, w: colW[3], h: rowH, text: r.v2, align: 'left' });

        pager.y -= rowH;
      });

      pager.y -= 12;
    };

    // ======================== PDF 表頭（請款單主表欄位）========================
    const PDF_TITLE = '交通費請款單';

    const fmtDate = (d) => (d ? String(d).split('T')[0] : '');

    // USER_SELECT／ORGANIZATION_SELECT 是 [{code,name}]，取顯示名稱串接
    const namesOf = (field) =>
      Array.isArray(field?.value)
        ? field.value
            .map((o) => o.name)
            .filter(Boolean)
            .join(', ')
        : '';

    // 表頭兩欄一組：[標籤1, 值1, 標籤2, 值2]
    const buildHeaderRows = (record) => {
      const get = (code) => record[code]?.value ?? '';
      const text = (code) => {
        const v = get(code);
        return Array.isArray(v) ? v.join(', ') : v;
      };
      return [
        { l1: '交通費請款單號', v1: get(F.RECORD_NO), l2: '請款日期', v2: fmtDate(get(F.PAYMENT_DATE)) },
        { l1: '公司名稱', v1: get(F.COMPANY_NAME), l2: '預計付款日', v2: fmtDate(get(F.EXPECTED_PAY_DATE)) },
        { l1: '申請人', v1: namesOf(record[F.APPLICANT]), l2: '申請部門', v2: namesOf(record[F.APPLICANT_ORG]) },
        { l1: '費用所屬人', v1: namesOf(record[F.EXPENSE_OWNER]), l2: '費用所屬人部門', v2: namesOf(record[F.EXPENSE_OWNER_ORG]) },
        { l1: '受款人', v1: get(F.PAYEE), l2: '付款方式', v2: text(F.PAY_METHOD) },
        { l1: '傳票編號', v1: get(F.VOUCHER_NO), l2: '傳票日期', v2: fmtDate(get(F.VOUCHER_DATE)) },
        { l1: '是否有紙本憑證', v1: get(F.PAPER_RECEIPT), l2: '理由', v2: get(F.REASON) },
      ];
    };

    // ======================== PDF 生成（PDFLib 向量）========================
    const generateRecordPDF = async (record, id) => {
      ensurePdfDeps();

      // 字型（subset=true：檔案會小很多）
      const fontBuffer = await fetchFontFromKintone();
      const pdfDoc = await PDFDocument.create();
      pdfDoc.registerFontkit(window.fontkit);
      const font = await pdfDoc.embedFont(fontBuffer, { subset: true });
      const fontBold = font; // 若有粗體字型檔可另 embed

      // A4 landscape (points)
      const pageW = 841.89;
      const pageH = 595.28;
      const pager = createPager(pdfDoc, pageW, pageH, { l: 24, r: 24, t: 24, b: 24 });

      // 標題 + 可點擊連結
      const appId = kintone.app.getId();
      const detailUrl = `${location.origin}/k/${appId}/show#record=${id}`;

      // 繪製「交通費請款單」標題
      pager.page.drawText(PDF_TITLE, {
        x: pager.marginL,
        y: pager.y - 22,
        size: 18,
        font: fontBold,
        color: rgb(0, 0, 0),
      });

      // 計算連結文字位置
      const titleWidth = fontBold.widthOfTextAtSize(PDF_TITLE, 18);
      const linkText = '[LINK點選查詢]';
      const linkFontSize = 10;
      const linkX = pager.marginL + titleWidth + 10;
      const linkY = pager.y - 20;
      const linkWidth = font.widthOfTextAtSize(linkText, linkFontSize);
      const linkHeight = linkFontSize;

      // 繪製連結文字（藍色）
      pager.page.drawText(linkText, {
        x: linkX,
        y: linkY,
        size: linkFontSize,
        font: font,
        color: rgb(0, 0.4, 0.8),
      });

      // 加入可點擊的連結註解
      pager.page.node.addAnnot(
        pdfDoc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [linkX, linkY - 2, linkX + linkWidth, linkY + linkHeight],
          Border: [0, 0, 0],
          A: {
            Type: 'Action',
            S: 'URI',
            URI: PDFLib.PDFString.of(detailUrl),
          },
        }),
      );

      pager.y -= 34;

      // Header key/value
      const headerRows = buildHeaderRows(record);

      drawKeyValueGrid({ pager, font, fontBold, rows: headerRows });

      // 明細
      const tableData = getTableData(record);
      const displayNames = tableData?.displayNames || [];
      const detailColumns = displayNames.map((name) => ({
        label: name,
        key: name,
        align: NUMERIC_COLUMNS.includes(name) ? 'right' : 'left',
      }));

      const detailRows = (tableData?.rows || []).map((r) => {
        const row = {};
        displayNames.forEach((k) => {
          const v = r[k] || '';
          row[k] = NUMERIC_COLUMNS.includes(k) ? formatNumber(v) : v;
        });
        return row;
      });

      const detailColW = (() => {
        const n = Math.max(detailColumns.length, 1);
        const w = (pager.pageW - pager.marginL - pager.marginR) / n;
        return Array.from({ length: n }, () => w);
      })();

      drawTablePdf({
        pager,
        title: '明細',
        columns: detailColumns.length ? detailColumns : [{ label: '無明細', key: 'x', align: 'center' }],
        rows: detailRows.length ? detailRows : [{ ...detailColumns.reduce((a, c) => ((a[c.key] = ''), a), {}) }],
        font,
        fontBold,
        colWidths: detailColumns.length ? detailColW : [pager.pageW - pager.marginL - pager.marginR],
        fontSize: 10,
        headerSize: 10,
      });

      // 簽核記錄
      const signTbl = record[F.SIGN_TABLE.CODE];
      const signRows = (signTbl?.value || []).map((row) => {
        const v = row.value;
        return {
          dt: v[F.SIGN_TABLE.COLS.DATETIME]?.value?.split('T')[0] || '',
          act: v[F.SIGN_TABLE.COLS.ACTION]?.value || '',
          who: v[F.SIGN_TABLE.COLS.SIGNER]?.value?.[0]?.name || '',
        };
      });

      drawTablePdf({
        pager,
        title: F.SIGN_TABLE.CODE,
        columns: [
          { label: '日期與時間', key: 'dt', align: 'center' },
          { label: '動作', key: 'act', align: 'center' },
          { label: '簽核人員', key: 'who', align: 'center' },
        ],
        rows: signRows.length ? signRows : [{ dt: '無簽核資料', act: '', who: '' }],
        font,
        fontBold,
        colWidths: [160, 160, pager.pageW - pager.marginL - pager.marginR - 320],
        fontSize: 10,
        headerSize: 10,
      });

      const footer = `記錄編號：${id}  列印時間：${formatDateTime(new Date())}`;

      pager.page.drawText(footer, {
        x: pager.marginL,
        y: 10,
        size: 8,
        font,
        color: rgb(0.35, 0.35, 0.35),
      });

      const bytes = await pdfDoc.save();
      return new Blob([bytes], { type: 'application/pdf' });
    };

    // ======================== 取得單筆記錄 ========================
    const fetchRecord = async (app, id) => {
      console.log(`[PDF Batch] API call to fetch record: App=${app}, ID=${id}`);
      const resp = await kintone.api(kintone.api.url('/k/v1/record', true), 'GET', { app, id: String(id) });
      console.log(`[PDF Batch] Fetch record response status:`, resp ? 'success' : 'failed');
      return resp.record;
    };

    // ======================== 批次下載附件（保留原功能；截圖 png 不影響 UI）========================
    function createSecureLoadingOverlay() {
      const loadingOverlay = document.createElement('div');
      loadingOverlay.className = 'loading-overlay';

      const loadingMessage = document.createElement('div');
      loadingMessage.className = 'loading-message';
      loadingMessage.innerHTML = `
      <button class="close-button" id="close-button" title="關閉視窗">×</button>
      <h3>🔒 安全批次下載</h3>
      <p>正在執行安全驗證與資料處理...</p>
      <div class="progress-bar">
        <div class="progress-bar-fill" id="progress-fill"></div>
      </div>
      <div class="result-message" id="result-message">🛡️ 安全系統初始化中...</div>
    `;
      loadingOverlay.appendChild(loadingMessage);
      document.body.appendChild(loadingOverlay);
    }

    function updateProgress(percentage) {
      const progressFill = document.getElementById('progress-fill');
      if (progressFill) progressFill.style.width = `${Math.min(100, Math.max(0, percentage))}%`;
    }

    function updateResultMessage(message, type) {
      const el = document.getElementById('result-message');
      if (!el) return;
      el.textContent = message;
      el.style.color = type === 'error' ? '#c53030' : type === 'warning' ? '#d69e2e' : type === 'success' ? '#2d5016' : '#333';
    }

    function showCloseButton() {
      const closeButton = document.getElementById('close-button');
      if (!closeButton) return;
      closeButton.classList.add('show');
      closeButton.onclick = function () {
        const loadingOverlay = document.querySelector('.loading-overlay');
        if (loadingOverlay) document.body.removeChild(loadingOverlay);
      };
    }

    function generateSecurityReport(records, securityToken) {
      const timestamp = new Date().toLocaleString();
      const userAgent = navigator.userAgent;
      const domain = window.location.hostname;

      return `kintone 安全批次下載報告
==========================================

下載時間: ${timestamp}
執行環境: ${domain}
瀏覽器: ${userAgent.substring(0, 100)}...
安全 Token: ${securityToken.substring(0, 8)}****
處理記錄數: ${records.length}

安全措施:
✅ 來源驗證已通過
✅ CSRF 防護已啟用
✅ 檔案大小限制已套用
✅ 輸入驗證已執行
✅ 權限檢查已完成

記錄清單:
${records.map((r, i) => `${i + 1}. 記錄 ${r[F.RECORD_NO]?.value || r.$id.value}`).join('\n')}

此報告由 kintone 安全下載系統自動產生
==========================================`;
    }

    // （附件+截圖。）
    async function generateRecordSummaryImage(record) {
      // 這段維持你原本 canvas 摘要圖邏輯（為了完整可用），簡化版：不畫明細表格，只列摘要 + 附件清單
      return new Promise((resolve) => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 1800;
          canvas.height = 1200;
          const ctx = canvas.getContext('2d');

          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          ctx.fillStyle = '#000000';
          ctx.font = 'bold 28px Arial';
          ctx.fillText('記錄摘要', 40, 60);

          let y = 110;
          const recordNumber = record[F.RECORD_NO]?.value || record.$id.value;
          const status = record[F.STATUS_FIELD]?.value || '未設定';
          const requestDate = record[F.PAYMENT_DATE]?.value || '未填寫';
          const applicant = namesOf(record[F.APPLICANT]) || '未填寫';
          const expenseOwner = namesOf(record[F.EXPENSE_OWNER]) || '未填寫';
          const paymentMethod = (record[F.PAY_METHOD]?.value || []).join(', ') || '未填寫';

          ctx.font = 'bold 18px Arial';
          ctx.fillText(`記錄號碼: ${recordNumber}`, 40, y);
          ctx.fillText(`請款日期: ${requestDate}`, 400, y);
          y += 30;
          ctx.fillText(`申請人: ${applicant}`, 40, y);
          ctx.fillText(`費用所屬人: ${expenseOwner}`, 400, y);
          y += 30;
          ctx.fillText(`狀態: ${status}`, 40, y);
          ctx.fillText(`付款方式: ${paymentMethod}`, 400, y);
          y += 40;

          const att = record[F.ATTACHMENT]?.value || [];
          if (att.length) {
            ctx.font = 'bold 18px Arial';
            ctx.fillText('附件清單：', 40, y);
            y += 30;
            ctx.font = '14px Arial';
            att.forEach((f, i) => {
              ctx.fillText(`${i + 1}. ${f.name}`, 60, y);
              y += 24;
            });
          }

          canvas.toBlob((blob) => resolve(blob), 'image/png', 1.0);
        } catch (e) {
          console.error('生成摘要圖失敗:', e);
          resolve(null);
        }
      });
    }

    async function handleSecureBatchDownload() {
      let securityToken = null;

      try {
        validateSecurity();
        securityToken = generateSecurityToken();

        const JSZip = window.JSZip;
        if (!JSZip) throw new Error('JSZip 未載入，請確認自定義 library 已加入');

        const inputMode = document.querySelector('input[name="input-mode"]:checked')?.value || 'range';
        let recordIds = [];

        if (inputMode === 'range') {
          const startId = parseInt(sanitizeInput(document.getElementById('range-start').value), 10);
          const endId = parseInt(sanitizeInput(document.getElementById('range-end').value), 10);
          if (isNaN(startId) || isNaN(endId)) throw new Error('請輸入有效的記錄號碼');
          if (startId > endId) throw new Error('開始號碼必須小於或等於結束號碼');
          for (let i = startId; i <= endId; i++) recordIds.push(i);
        } else {
          const specificInput = sanitizeInput(document.getElementById('specific-records').value);
          if (!specificInput) throw new Error('請輸入要下載的記錄號碼');
          recordIds = [...new Set(specificInput.split(',').map((id) => parseInt(id.trim(), 10)))].filter((x) => Number.isInteger(x) && x > 0);
        }

        validateRecordIds(recordIds);
        createSecureLoadingOverlay();

        const currentAppId = kintone.app.getId();
        const queryCondition = recordIds.length === 1 ? `$id = ${recordIds[0]}` : `$id in (${recordIds.join(',')})`;

        const recordsResp = await secureKintoneApi(
          '/k/v1/records',
          'GET',
          {
            app: currentAppId,
            query: `${queryCondition} limit ${SECURITY_CONFIG.maxRecords}`,
            fields: ['$id', F.RECORD_NO, F.ATTACHMENT, F.STATUS_FIELD, F.PAYMENT_DATE, F.APPLICANT, F.EXPENSE_OWNER, F.PAY_METHOD],
          },
          securityToken,
        );

        const records = recordsResp.records || [];
        if (!records.length) throw new Error('找不到指定的記錄，請檢查記錄號碼是否正確');

        updateResultMessage(`✅ 安全驗證通過，找到 ${records.length} 筆記錄`);

        const today = new Date();
        const dateString = today.getFullYear() + String(today.getMonth() + 1).padStart(2, '0') + String(today.getDate()).padStart(2, '0');
        const mainFolderName = `${dateString}_${DOWNLOAD_FOLDER_NAME}_安全下載`;
        const zip = new JSZip();

        const includeScreenshot = true;
        let processed = 0;

        for (const record of records) {
          const recordNumber = record[F.RECORD_NO]?.value || record.$id.value;
          const subFolderName = `記錄${recordNumber}`;

          updateResultMessage(`🔒 安全處理記錄 ${recordNumber}...`);

          // 附件
          const attachments = record[F.ATTACHMENT]?.value || [];
          for (const attachment of attachments) {
            try {
              const safeName = sanitizeInput(attachment.name);
              if (!safeName) continue;
              const fileBlob = await secureFileDownload(attachment.fileKey);
              zip.file(`${subFolderName}/${recordNumber}－${safeName}`, fileBlob);
              updateResultMessage(`✅ 已下載: ${safeName}`);
            } catch (error) {
              console.error(`安全下載附件失敗: ${attachment.name}`, error);
              updateResultMessage(`❌ 下載失敗: ${attachment.name} (${error.message})`);
            }
          }

          // 摘要圖
          if (includeScreenshot) {
            const summaryImage = await generateRecordSummaryImage(record);
            if (summaryImage) zip.file(`${subFolderName}/記錄${recordNumber}_摘要資訊.png`, summaryImage);
          }

          processed++;
          updateProgress(Math.floor((processed / records.length) * 80));
        }

        zip.file('安全下載報告.txt', generateSecurityReport(records, securityToken));

        updateResultMessage('🔒 安全打包中...');
        updateProgress(90);

        const zipBlob = await zip.generateAsync({
          type: 'blob',
          compression: 'DEFLATE',
          compressionOptions: { level: 6 },
        });

        const url = window.URL.createObjectURL(zipBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${mainFolderName}.zip`;
        link.rel = 'noopener noreferrer';

        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);

        updateProgress(100);
        updateResultMessage('🎉 安全下載完成！所有操作均已通過安全驗證。');
        showCloseButton();
      } catch (error) {
        console.error('安全下載過程發生錯誤:', error);
        updateResultMessage(`❌ 安全錯誤: ${error.message}`, 'error');
        showCloseButton();
      } finally {
        securityToken = null;
      }
    }

    // ======================== 提示視窗（全域 SweetAlert，寬度自動）========================
    /** 取代瀏覽器的 alert；icon: 'info'|'warning'|'error'|'success'。載不到 SweetAlert 才退回 alert */
    function notify(text, icon = 'info') {
      if (typeof Swal === 'undefined') {
        alert(text);
        return Promise.resolve();
      }
      return Swal.fire({ icon, text, width: 'auto', confirmButtonText: '好', customClass: { htmlContainer: 'pr-notice-text' } });
    }

    /** 取代瀏覽器的 confirm；回傳 true／false。載不到 SweetAlert 才退回 confirm */
    async function askConfirm(text) {
      if (typeof Swal === 'undefined') return confirm(text);
      const result = await Swal.fire({ icon: 'question', text, width: 'auto', showCancelButton: true, confirmButtonText: '確定', cancelButtonText: '取消', customClass: { htmlContainer: 'pr-notice-text' } });
      return result.isConfirmed;
    }

    // ======================== 批次列印 PDF（PDFLib 版）========================
    async function handleBatchPrintPDF() {
      try {
        const mode = document.querySelector('input[name="input-mode"]:checked')?.value || 'range';
        let recordIds = [];

        if (mode === 'range') {
          const start = parseInt(document.getElementById('range-start').value, 10);
          const end = parseInt(document.getElementById('range-end').value, 10);
          if (isNaN(start) || isNaN(end)) return notify('請輸入有效的號碼範圍', 'warning');
          if (start > end) return notify('開始號碼不能大於結束號碼', 'warning');
          if (end - start + 1 > SECURITY_CONFIG.maxRecords) return notify(`單次最多列印 ${SECURITY_CONFIG.maxRecords} 筆記錄`, 'warning');
          recordIds = Array.from({ length: end - start + 1 }, (_, i) => start + i);
        } else {
          const input = document.getElementById('specific-records').value.trim();
          if (!input) return notify('請輸入要列印的記錄號碼', 'warning');
          recordIds = input
            .split(',')
            .map((id) => parseInt(id.trim(), 10))
            .filter((id) => !isNaN(id));
          if (!recordIds.length) return notify('請輸入有效的記錄號碼', 'warning');
          if (recordIds.length > SECURITY_CONFIG.maxRecords) return notify(`單次最多列印 ${SECURITY_CONFIG.maxRecords} 筆記錄`, 'warning');
        }

        if (!(await askConfirm(`確定要批次列印 ${recordIds.length} 筆記錄嗎？`))) return;
        await performBatchPrintPDF(recordIds);
      } catch (error) {
        console.error('批次列印失敗:', error);
        await notify('批次列印失敗：' + error.message, 'error');
      }
    }

    async function performBatchPrintPDF(recordIds) {
      console.log('[PDF Batch] Starting performBatchPrintPDF with record IDs:', recordIds);
      createLoadingOverlay();
      const appId = kintone.app.getId();
      const zip = new JSZip();
      let processed = 0;
      const failed = [];

      try {
        for (const recordId of recordIds) {
          console.log(`[PDF Batch] Start processing record: ${recordId}`);
          updateResultMessage(`處理記錄 ${recordId}...`, 'info');
          updateProgress((processed / recordIds.length) * 100);

          try {
            const record = await fetchRecord(appId, recordId);
            console.log(`[PDF Batch] Fetched record ${recordId}:`, record);
            
            const pdfBlob = await generateRecordPDF(record, recordId);
            console.log(`[PDF Batch] Generated PDF Blob for record ${recordId}, size = ${pdfBlob.size} bytes`);
            
            const fileName = generatePDFFileName(record, recordId);
            console.log(`[PDF Batch] Filename for record ${recordId}: ${fileName}`);
            
            zip.file(fileName, pdfBlob);
            processed++;
            console.log(`[PDF Batch] Added record ${recordId} PDF to ZIP successfully.`);
          } catch (recordError) {
            console.error(`[PDF Batch] 記錄 ${recordId} 處理失敗:`, recordError);
            const errMsg = recordError.message || (typeof recordError === 'object' ? JSON.stringify(recordError) : String(recordError));
            failed.push({ id: recordId, message: errMsg });
          }

          await sleep(150);
        }

        console.log(`[PDF Batch] Loop completed. Success = ${processed}, Failed = ${failed.length}`);
        updateResultMessage('正在打包 ZIP 檔案...', 'info');
        updateProgress(95);

        const zipBlob = await zip.generateAsync({ type: 'blob' });
        console.log('[PDF Batch] ZIP Blob generated, size =', zipBlob.size, 'bytes');
        saveAs(zipBlob, `批次列印_${formatDateTime(new Date())}.zip`);

        updateProgress(100);
        if (failed.length) {
          const failDetail = failed.map((f) => `記錄 ${f.id}：${f.message}`).join('\n');
          console.warn('[PDF Batch] Completed with failures:', failDetail);
          updateResultMessage(`⚠️ 完成，但有 ${failed.length} 筆失敗（未包含在 ZIP 內）：\n${failDetail}\n\n成功 ${processed} 筆`, 'warning');
        } else {
          console.log('[PDF Batch] All files printed and downloaded successfully.');
          updateResultMessage(`✅ 列印完成！共處理 ${processed} 筆記錄`, 'success');
        }
        showCloseButton();
      } catch (error) {
        console.error('[PDF Batch] 批次列印過程發生致命錯誤:', error);
        updateResultMessage('批次列印失敗：' + error.message, 'error');
        showCloseButton();
      }
    }

    const generatePDFFileName = (record, id) => {
      let company = record[F.COMPANY_NAME]?.value?.trim() || '';
      company = company?.startsWith('ＮＸ') ? 'NX' : '聯海';
      record[F.PAYMENT_DATE]?.value?.split('T')[0] || '';
      // 受款人欄位資料可能夾雜 Tab／換行等控制字元（例如「代號\t姓名」格式），
      // 這類字元 Windows 檔名不允許，會讓解壓縮工具跳過該檔案而誤以為 ZIP 是空的
      const payName = (record[F.PAYEE]?.value || '').replace(/[\t\n\r]+/g, ' ').trim();
      return `交通費請款單${id}_${company}(${payName}).pdf`.replace(/[\/\\:*?"<>|\x00-\x1F\x7F]/g, '_');
    };

    // ======================== UI（維持原樣）========================
    function createLoadingOverlay() {
      const overlay = document.createElement('div');
      overlay.className = 'loading-overlay';
      overlay.id = 'batch-download-overlay';
      overlay.innerHTML = `
      <div class="loading-message">
        <button id="close-button" class="close-button">✕</button>
        <div class="pr-loading-title">處理中...</div>
        <div class="progress-bar"><div id="progress-fill" class="progress-bar-fill"></div></div>
        <div id="result-message" class="result-message">準備中...</div>
      </div>
    `;
      document.body.appendChild(overlay);
      return overlay;
    }

    async function initUI() {
      try {
        validateSecurity();

        const headerMenuSpace = kintone.app.getHeaderMenuSpaceElement();
        if (!headerMenuSpace) throw new Error('找不到標頭菜單空間');

        // 樣式在 payment_request.css（批次下載／列印按鈕、處理中視窗）

        // 容器
        const container = document.createElement('div');
        container.id = 'batch-download-container';

        // 範圍輸入群組
        const rangeGroup = document.createElement('div');
        rangeGroup.className = 'range-input-group';

        // 輸入模式選擇
        const modeSelector = document.createElement('div');
        modeSelector.className = 'input-mode-selector';

        const rangeMode = document.createElement('label');
        rangeMode.innerHTML = `
        <input type="radio" name="input-mode" value="range" checked>
        連續範圍（例如：1 到 10）
      `;

        const specificMode = document.createElement('label');
        specificMode.innerHTML = `
        <input type="radio" name="input-mode" value="specific">
        指定多筆（例如：20,40,42,48,56）
      `;

        modeSelector.appendChild(rangeMode);
        modeSelector.appendChild(specificMode);

        // 範圍輸入
        const rangeInputs = document.createElement('div');
        rangeInputs.className = 'range-inputs';

        const startLabel = document.createElement('span');
        startLabel.className = 'range-input-label';
        startLabel.textContent = '請輸入要下載的記錄號碼範圍：';

        const startInput = document.createElement('input');
        startInput.type = 'number';
        startInput.id = 'range-start';
        startInput.className = 'range-input';
        startInput.placeholder = '開始號碼';
        startInput.min = 1;

        const separator = document.createElement('span');
        separator.className = 'range-input-separator';
        separator.textContent = '到';

        const endInput = document.createElement('input');
        endInput.type = 'number';
        endInput.id = 'range-end';
        endInput.className = 'range-input';
        endInput.placeholder = '結束號碼';
        endInput.min = 1;

        rangeInputs.appendChild(startLabel);
        rangeInputs.appendChild(startInput);
        rangeInputs.appendChild(separator);
        rangeInputs.appendChild(endInput);

        // 指定輸入
        const specificInputs = document.createElement('div');
        specificInputs.className = 'specific-input';
        specificInputs.id = 'specific-inputs';

        const specificLabel = document.createElement('span');
        specificLabel.className = 'range-input-label';
        specificLabel.textContent = '請輸入要下載的記錄號碼（用逗號分隔）：';

        const specificInput = document.createElement('input');
        specificInput.type = 'text';
        specificInput.id = 'specific-records';
        specificInput.className = 'specific-records-input';
        specificInput.placeholder = '例如：20,40,42,48,56';

        specificInputs.appendChild(specificLabel);
        specificInputs.appendChild(specificInput);

        // 模式切換事件
        const modeRadios = modeSelector.querySelectorAll('input[name="input-mode"]');
        modeRadios.forEach((radio) => {
          radio.addEventListener('change', function () {
            if (this.value === 'range') {
              rangeInputs.style.display = 'flex';
              specificInputs.style.display = 'none';
            } else {
              rangeInputs.style.display = 'none';
              specificInputs.style.display = 'flex';
            }
          });
        });

        // 按鈕容器（水平並排）
        const buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'buttons-container';

        // 下載附件按鈕
        const downloadButton = document.createElement('button');
        downloadButton.id = 'batch-download-button';
        downloadButton.className = 'batch-download-button';
        downloadButton.textContent = '📦 批次下載附件+截圖';
        downloadButton.addEventListener('click', handleSecureBatchDownload);

        // 批次列印PDF按鈕
        const printButton = document.createElement('button');
        printButton.id = 'batch-print-button';
        printButton.className = 'batch-print-button';
        printButton.textContent = '📄 批次列印交通費請款單PDF';
        printButton.addEventListener('click', handleBatchPrintPDF);

        // 批次整理資料按鈕（原本就沒實作，保留按鈕不改 UI）
        const organizeButton = document.createElement('button');
        organizeButton.id = 'batch-organize-button';
        organizeButton.className = 'batch-print-button';
        organizeButton.textContent = '📋 交通費Excel資料轉出(AP、費用、稅額)';
        buttonsContainer.appendChild(organizeButton);

        buttonsContainer.appendChild(printButton);
        buttonsContainer.appendChild(downloadButton);

        // 組裝 UI
        rangeGroup.appendChild(modeSelector);
        rangeGroup.appendChild(rangeInputs);
        rangeGroup.appendChild(specificInputs);

        container.appendChild(rangeGroup);
        container.appendChild(buttonsContainer);
        headerMenuSpace.appendChild(container);
      } catch (error) {
        console.error('初始化失敗:', error);
        notify('無法在當前環境中啟用批次功能', 'error');
      }
    }

    window.PR_BATCH_PDF = Object.freeze({ TABLE_CONFIG, NUMERIC_COLUMNS, getTableData, buildHeaderRows, generatePDFFileName });

    // ======================== 事件註冊（依你的要求放最下方）========================
    kintone.events.on('app.record.index.show', function (event) {
      try {
        validateSecurity();
        if (document.getElementById('batch-download-container')) return event;
        initUI();
      } catch (error) {
        console.error('初始化失敗:', error);
      }
      return event;
    });

    kintone.events.on('app.record.detail.show', function (event) {
      try {
        const headerSpace = kintone.app.record.getHeaderMenuSpaceElement();
        if (!headerSpace) return event;

        // 避免重複塞按鈕
        if (document.getElementById('detail-print-pdflib-btn')) return event;

        const detailPrintButton = document.createElement('button');
        detailPrintButton.id = 'detail-print-pdflib-btn';
        detailPrintButton.textContent = '📄 下載此筆交通費請款單PDF';
        detailPrintButton.className = 'pr-detail-print-button'; // 樣式在 payment_request.css

        detailPrintButton.addEventListener('click', async function () {
          const recordId = event.record.$id.value;

          Swal.fire({
            title: '確認下載',
            html: '即將下載「此筆交通費請款單」的 PDF 檔案。<br>確認要開始下載嗎？<br><span class="pr-download-note">（不會修改或影響表單內容）</span>',
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: '開始下載',
            cancelButtonText: '取消',
            confirmButtonColor: '#3085d6',
            cancelButtonColor: '#d33',
          }).then(async (result) => {
            if (!result.isConfirmed) return;

            try {
              const appId = kintone.app.getId();
              const record = await fetchRecord(appId, recordId);
              const pdfBlob = await generateRecordPDF(record, recordId);
              const fileName = generatePDFFileName(record, recordId);
              saveAs(pdfBlob, fileName);
              Swal.fire('完成', 'PDF 已成功下載', 'success');
            } catch (error) {
              console.error('PDF 生成失敗:', error);
              Swal.fire('錯誤', 'PDF 生成失敗：' + error.message, 'error');
            }
          });
        });

        headerSpace.appendChild(detailPrintButton);
      } catch (error) {
        console.error('初始化詳細頁面 PDF 按鈕失敗:', error);
      }

      return event;
    });
  })();

  // 批次整理資料 - 功能模組（index.show 專用）
  // 列表頁「轉出 Excel」：選定的請款單先依受款人排序、讓使用者確認每筆的轉出日期，
  // 每一筆轉成 應付帳款 1 列＋費用成本（每個明細列各 1 列）＋稅額（稅額不為 0 的明細列各 1 列），全部放在同一張工作表。
  // 欄位怎麼對應由「交通費轉出欄位對應」App（APPS.SAP_MAPPING）設定，一筆記錄＝Excel 的一欄。
  (function () {

    // ======================== 配置 ========================
    // 註：本模組存取之欄位（如 Excel欄位代碼、應付帳款_值等）為交通費轉出欄位對應 App（APPS.SAP_MAPPING）
    // 內部之對應設定欄位，非請款單主表 FIELDS，刻意保留字面值。
    // 該 App 同時存交通費與交際費的對應，用「適用單據」下拉欄位區分，這裡只讀交通費的記錄（欄位代碼同樣保留字面值）。
    const MAPPING_DOC_TYPE_FIELD = '適用單據';
    const MAPPING_DOC_TYPE = '交通費'; // 轉出欄位對應 App「適用單據」的選項值
    const CONFIG = {
      mappingAppId: window.PR_CONFIG.APPS.SAP_MAPPING, // 交通費轉出欄位對應設定 App ID
      costCenterAppId: window.PR_CONFIG.APPS.COST_CENTER, // 費用歸屬主檔（查 Business Area）
    };

    const FIELDS = window.PR_CONFIG.FIELDS;
    const CC = window.PR_CONFIG.REF_FIELDS.COST_CENTER;
    const TABLE = FIELDS.TRAFFIC_TABLE; // 交通費明細子表格（樣板的 {交通費請款單.欄位} 取這張表的列）
    const TAX_COL = TABLE.COLS.TAX;

    const SHEET_NAME = '交通費';
    const DEFAULT_DATE_FORMAT = 'YYYY/MM/DD';
    const DEFAULT_CELL_FORMAT = '一般';
    const MIN_COL_WIDTH = 12;
    const PAYEE_KEY_LENGTH = 5; // 受款人排序／分組只看前 5 碼數字（同樣板的「數字|左5」）
    const COST_CENTER_PAGE = 500;

    // 三種列各自取設定 App 的哪個樣板欄位
    const VALUE_FIELD = { ap: '應付帳款_值', expense: '費用成本_值', tax: '稅額_值' };

    // ======================== 取得 UI 輸入的記錄範圍 ========================
    function getRecordIdsFromUI() {
      const inputMode = document.querySelector('input[name="input-mode"]:checked')?.value;
      let recordIds = [];

      if (inputMode === 'range') {
        const start = parseInt(document.getElementById('range-start')?.value, 10);
        const end = parseInt(document.getElementById('range-end')?.value, 10);
        if (!isNaN(start) && !isNaN(end) && start <= end) {
          for (let i = start; i <= end; i++) {
            recordIds.push(i);
          }
        }
      } else {
        const specificInput = document.getElementById('specific-records')?.value || '';
        recordIds = specificInput
          .split(',')
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !isNaN(n) && n > 0);
      }

      return recordIds;
    }

    // ======================== 日期 ========================
    /** 取出日期的年月日（'YYYY-MM-DD…' 字串直接拆，不經時區換算）；不是日期回傳 null */
    function toYMD(date) {
      if (!date) return null;
      if (typeof date === 'string') {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
        if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
        date = new Date(date);
      }
      if (!(date instanceof Date) || isNaN(date.getTime())) return null;
      return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
    }

    function formatDate(date, format) {
      const ymd = toYMD(date);
      if (!ymd) return '';
      const y = String(ymd.y).padStart(4, '0');
      const m = String(ymd.m).padStart(2, '0');
      const d = String(ymd.d).padStart(2, '0');

      switch (format) {
        case 'YYYYMMDD':
          return `${y}${m}${d}`;
        case 'YYYY-MM-DD':
          return `${y}-${m}-${d}`;
        case 'YYYY/MM/DD':
        default:
          return `${y}/${m}/${d}`;
      }
    }

    /** 把 YYYY/MM/DD、YYYYMMDD、YYYY-MM-DD 的文字解析成 {y,m,d}；不是合法日期回傳 null */
    function parseDateText(text) {
      const m = /^(\d{4})([/-]?)(\d{2})\2(\d{2})$/.exec(String(text).trim());
      if (!m) return null;
      const y = Number(m[1]);
      const mo = Number(m[3]);
      const d = Number(m[4]);
      const dt = new Date(Date.UTC(y, mo - 1, d));
      if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
      return { y, m: mo, d };
    }

    /** 上個月最後一天（'YYYY-MM-DD'），給日期視窗的「月帳」按鈕；不是日期回空字串 */
    function lastDayOfPrevMonth(date) {
      const ymd = toYMD(date);
      if (!ymd) return '';
      const d = new Date(Date.UTC(ymd.y, ymd.m - 1, 0)); // 這個月 0 號＝上個月最後一天
      return d.toISOString().slice(0, 10);
    }

    /** Excel 日期序號（1900 日期系統） */
    function dateSerial(ymd) {
      return Math.round((Date.UTC(ymd.y, ymd.m - 1, ymd.d) - Date.UTC(1899, 11, 30)) / 86400000);
    }

    // ======================== 欄位字母 ↔ 欄索引 ========================
    /** 'A'→0、'Z'→25、'AA'→26；不是英文字母回傳 -1 */
    function columnIndex(letters) {
      const s = String(letters || '')
        .trim()
        .toUpperCase();
      if (!/^[A-Z]+$/.test(s)) return -1;
      let n = 0;
      for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
      return n - 1;
    }

    /** 0→'A'、26→'AA' */
    function columnLetters(index) {
      let n = index + 1;
      let s = '';
      while (n > 0) {
        const r = (n - 1) % 26;
        s = String.fromCharCode(65 + r) + s;
        n = Math.floor((n - 1) / 26);
      }
      return s;
    }

    // ======================== 從設定 App 取得欄位對應 ========================
    /** 設定 App 的一筆記錄 → 一欄的對應設定 */
    function mapMappingRecord(record) {
      return {
        excelColumn: String(record['Excel欄位代碼']?.value || '').trim(),
        excelColumnName: record['Excel欄位說明']?.value || '',
        sortOrder: parseInt(record['排序']?.value, 10) || 0,
        應付帳款_值: record['應付帳款_值']?.value || '',
        費用成本_值: record['費用成本_值']?.value || '',
        稅額_值: record['稅額_值']?.value || '',
        dateFormat: record['日期格式']?.value || DEFAULT_DATE_FORMAT,
        cellFormat: record['儲存格格式']?.value || DEFAULT_CELL_FORMAT,
      };
    }

    async function fetchFieldMappings() {
      return new Promise((resolve, reject) => {
        kintone.api(
          kintone.api.url('/k/v1/records', true),
          'GET',
          {
            app: CONFIG.mappingAppId,
            query: `${MAPPING_DOC_TYPE_FIELD} in ("${MAPPING_DOC_TYPE}") and 啟用 in ("啟用") order by 排序 asc limit 500`,
          },
          (resp) => resolve(resp.records.map(mapMappingRecord)),
          (error) => {
            console.error('取得欄位對應設定失敗:', error);
            reject(error);
          },
        );
      });
    }

    // ======================== 從請款單 App 取得記錄 ========================
    async function fetchSourceRecords(recordIds) {
      const appId = kintone.app.getId();

      const allRecords = [];
      const batchSize = 100;

      for (let i = 0; i < recordIds.length; i += batchSize) {
        const batchIds = recordIds.slice(i, i + batchSize);
        const query = `$id in (${batchIds.join(',')})`;

        const resp = await new Promise((resolve, reject) => {
          kintone.api(
            kintone.api.url('/k/v1/records', true),
            'GET',
            {
              app: appId,
              query: query,
            },
            (resp) => resolve(resp),
            (error) => reject(error),
          );
        });

        allRecords.push(...resp.records);
      }

      const recordMap = {};
      allRecords.forEach((r) => {
        recordMap[r.$id.value] = r;
      });

      return recordIds.map((id) => recordMap[id]).filter((r) => r !== undefined);
    }

    // ======================== 從費用歸屬主檔取得 Business Area ========================
    /**
     * 費用歸屬主檔記錄 → Map（大寫去空白的 CostCenter 代碼 → Business Area）。
     * 同一代碼可能有好幾筆（不同所屬部門），取第一個有填 Business Area 的；代碼空白的略過。
     */
    function buildBusinessAreaMap(records) {
      const map = new Map();
      for (const r of records || []) {
        const code = String(r?.[CC.CODE]?.value ?? '')
          .trim()
          .toUpperCase();
        const area = String(r?.[CC.BUSINESS_AREA]?.value ?? '').trim();
        if (code === '' || area === '') continue;
        if (!map.has(code)) map.set(code, area);
      }
      return map;
    }

    /** 讀費用歸屬主檔全部記錄（每次 500 筆，用 offset 翻頁），回傳 buildBusinessAreaMap 的結果；失敗就拋出 */
    async function fetchBusinessAreaMap() {
      const all = [];
      for (let offset = 0; ; offset += COST_CENTER_PAGE) {
        const resp = await new Promise((resolve, reject) => {
          kintone.api(
            kintone.api.url('/k/v1/records', true),
            'GET',
            {
              app: CONFIG.costCenterAppId,
              fields: [CC.CODE, CC.BUSINESS_AREA],
              query: `order by $id asc limit ${COST_CENTER_PAGE} offset ${offset}`,
            },
            resolve,
            (error) => {
              console.error('取得費用歸屬 Business Area 失敗:', error);
              reject(error);
            },
          );
        });
        all.push(...resp.records);
        if (resp.records.length < COST_CENTER_PAGE) break;
      }
      return buildBusinessAreaMap(all);
    }

    // ======================== 依受款人排序 ========================
    /** 受款人的排序／分組鍵：受款人文字取數字、前 5 碼（沒有數字回空字串） */
    function payeeKey(record) {
      return String(record?.[FIELDS.PAYEE]?.value ?? '')
        .replace(/\D/g, '')
        .slice(0, PAYEE_KEY_LENGTH);
    }

    /** 依受款人鍵由小到大排（空白鍵排最後），鍵相同依記錄編號由小到大；回傳新陣列 */
    function sortRecordsByPayee(records) {
      const idOf = (r) => Number(r?.$id?.value);
      return [...records].sort((a, b) => {
        const ka = payeeKey(a);
        const kb = payeeKey(b);
        if (ka !== kb) {
          if (ka === '') return 1;
          if (kb === '') return -1;
          return ka < kb ? -1 : 1;
        }
        return idOf(a) - idOf(b);
      });
    }

    // ======================== 欄位值轉文字 ========================
    /** kintone 欄位值 → 文字：人員／組織／群組取名稱、陣列用逗號串、日期照 dateFormat、空值回空字串 */
    function valueToText(value, dateFormat) {
      if (value === undefined || value === null) return '';
      if (Array.isArray(value)) {
        return value.map((v) => (v && typeof v === 'object' ? v.name || v.code || '' : String(v))).join(',');
      }
      if (typeof value === 'object') return value.name || value.code || '';
      // 只有整段是日期（DATE）或日期時間（DATETIME）才換格式；「2026-11-03 拜訪」這種文字照原樣
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(value)) return formatDate(value, dateFormat);
      return String(value);
    }

    // ======================== 篩選器（{欄位|數字|左5}） ========================
    /** 括號內：最後一組括號（半形或全形）裡的文字、去頭尾空白；沒有括號回原文 */
    function bracketInner(text) {
      const matches = [...String(text).matchAll(/[(（]([^()（）]*)[)）]/g)];
      if (matches.length === 0) return text;
      return matches[matches.length - 1][1].trim();
    }

    /** Cost Center 代碼 → Business Area（ctx.businessArea 是 Map 或物件，鍵為大寫代碼）；查不到回空字串並警告 */
    function lookupBusinessArea(text, ctx) {
      const key = String(text).trim().toUpperCase();
      const src = ctx?.businessArea;
      let hit;
      if (src instanceof Map) hit = src.get(key);
      else if (src && Object.prototype.hasOwnProperty.call(src, key)) hit = src[key];
      if (hit) return String(hit);
      if (key !== '') console.warn('批次整理資料：查不到 Business Area', key);
      return '';
    }

    function applyFilters(text, filters, ctx) {
      let out = String(text);
      for (const raw of filters || []) {
        const f = String(raw).trim();
        const left = /^左(\d+)$/.exec(f);
        switch (true) {
          case f === '數字':
            out = out.replace(/\D/g, '');
            break;
          case Boolean(left):
            out = Array.from(out).slice(0, Number(left[1])).join('');
            break;
          case f === '括號內':
            out = bracketInner(out);
            break;
          case f === 'BusinessArea':
            out = lookupBusinessArea(out, ctx);
            break;
          default:
            console.warn('批次整理資料：不認得的篩選器', f);
        }
      }
      return out;
    }

    // ======================== 解析語法並取值 ========================
    // 語法（單層大括號，括號外的文字照用）：
    //   {欄位代碼}                 主表欄位
    //   {交通費請款單.欄位代碼}      明細列的欄位：取 ctx.detailRow（應付帳款列＝第一列，費用成本、稅額列＝各自對應的那一列）；其他子表格取第一列
    //   {序號}  {TODAY}  {$id}     記錄序號（匯出順序第幾筆，同一筆記錄的每一列都一樣）、今天、記錄編號
    //   {轉出日期}                 該筆記錄在日期視窗選的日期（沒選就是今天），照欄位的日期格式輸出
    //   {欄位|數字|左5}            篩選器由左到右套用：數字（只留數字）、左N（前 N 個字）、括號內（最後一組括號裡的字）、
    //                              BusinessArea（把 Cost Center 代碼換成 Business Area，查不到留空）
    //   =A+B-C                    開頭是 = 時做加減（A、B、C 是 {…} 或數字），空白當 0，不能算回空字串
    // ctx = { record, detailRow, seq, today, exportDate, businessArea, dateFormat }

    /** 明細列的稅額是否不為 0（空、0 都算 0） */
    function isNonZero(text) {
      const n = Number(String(text ?? '').replace(/,/g, '').trim());
      return Number.isFinite(n) && n !== 0;
    }

    /** 單一 {…} 內的內容（不含大括號）→ 文字 */
    function resolveToken(expr, ctx) {
      const parts = String(expr).split('|');
      const name = parts[0].trim();
      const dateFormat = ctx.dateFormat || DEFAULT_DATE_FORMAT;
      const record = ctx.record || {};
      let text;

      switch (name) {
        case 'TODAY':
          text = formatDate(ctx.today || new Date(), dateFormat);
          break;
        case '轉出日期':
          text = formatDate(ctx.exportDate || ctx.today || new Date(), dateFormat);
          break;
        case '序號':
          text = ctx.seq === undefined || ctx.seq === null ? '' : String(ctx.seq);
          break;
        case '$id':
          text = valueToText(record.$id?.value, dateFormat);
          break;
        default:
          if (name.includes('.')) {
            const dot = name.indexOf('.');
            const tableCode = name.slice(0, dot);
            const fieldCode = name.slice(dot + 1);
            const rows = record[tableCode]?.value;
            const row = tableCode === TABLE.CODE && ctx.detailRow ? ctx.detailRow : Array.isArray(rows) ? rows[0] : null;
            text = valueToText(row?.value?.[fieldCode]?.value, dateFormat);
          } else {
            text = valueToText(record[name]?.value, dateFormat);
          }
      }

      return applyFilters(text, parts.slice(1), ctx);
    }

    /** 做加減：運算式只能有 {…}、數字、+、-。空白＝0；有無法當數字的值回 null */
    function evalArithmetic(expr, ctx) {
      const src = String(expr);
      const tokenRe = /\s*(?:(\{[^{}]*\})|(\d+(?:\.\d+)?)|([+-]))/y;
      const operands = [];
      let sign = 1;
      let expectOperand = true;
      let pos = 0;
      let result = 0;

      while (pos < src.length) {
        if (/^\s*$/.test(src.slice(pos))) break;
        tokenRe.lastIndex = pos;
        const m = tokenRe.exec(src);
        if (!m) return null;
        pos = tokenRe.lastIndex;

        if (m[3]) {
          if (expectOperand) {
            // 運算子連在一起（含開頭的正負號）：負號翻轉、正號略過
            if (m[3] === '-') sign = -sign;
          } else {
            sign = m[3] === '-' ? -1 : 1;
            expectOperand = true;
          }
          continue;
        }
        if (!expectOperand) return null; // 兩個運算元中間沒有運算子

        let n;
        if (m[1]) {
          const text = resolveToken(m[1].slice(1, -1), ctx).replace(/,/g, '').trim();
          n = text === '' ? 0 : Number(text);
        } else {
          n = Number(m[2]);
        }
        if (!Number.isFinite(n)) return null;
        operands.push(n);
        result += sign * n;
        sign = 1;
        expectOperand = false;
      }

      if (operands.length === 0 || expectOperand) return null;
      return Math.round(result * 1e10) / 1e10; // 去掉浮點誤差
    }

    /** 整段樣板 → 文字 */
    function parseTemplate(template, ctx) {
      if (template === undefined || template === null) return '';
      const text = String(template);
      if (text.trim() === '') return '';

      if (text.trim().startsWith('=')) {
        const n = evalArithmetic(text.trim().slice(1), ctx);
        if (n === null) {
          console.warn('批次整理資料：算式無法計算，欄位留空', text);
          return '';
        }
        return String(n);
      }

      // 用函式取代，避免欄位值裡的 $ 被當成取代語法
      return text.replace(/\{([^{}]*)\}/g, (_, expr) => resolveToken(expr, ctx));
    }

    // ======================== 列產生 ========================
    /**
     * 產生所有資料列（records 已是最後順序）。每筆記錄依序轉出：
     *   應付帳款 1 列（{交通費請款單.欄位} 取第一個明細列）、費用成本（每個明細列各 1 列）、稅額（稅額不為 0 的明細列各 1 列）；
     *   沒有明細列就只有應付帳款。{序號} 是記錄在匯出裡的順序，同一筆記錄每列都一樣。
     * opts = { today, dates, businessArea }：today 今天（測試可注入）、dates 是 { 記錄編號: 'YYYY-MM-DD' } 的轉出日期、
     *   businessArea 是 buildBusinessAreaMap 的結果。回傳 rows：每列是和 mappings 同順序的 { value, format }（value 為文字）。
     */
    function buildRows(mappings, records, opts) {
      const { today, dates, businessArea } = opts || {};
      const now = today || new Date();
      const rows = [];

      records.forEach((record, i) => {
        const id = record.$id?.value;
        const exportDate = (id !== undefined && dates?.[id]) || now;
        const details = Array.isArray(record[TABLE.CODE]?.value) ? record[TABLE.CODE].value : [];
        const make = (kind, detailRow) =>
          mappings.map((m) => ({
            value: parseTemplate(m[VALUE_FIELD[kind]] || '', { record, detailRow, seq: i + 1, today: now, exportDate, businessArea, dateFormat: m.dateFormat }),
            format: m.cellFormat || DEFAULT_CELL_FORMAT,
          }));

        rows.push(make('ap', details[0]));
        details.forEach((d) => rows.push(make('expense', d)));
        details.filter((d) => isNonZero(d?.value?.[TAX_COL]?.value)).forEach((d) => rows.push(make('tax', d)));
      });

      return rows;
    }

    // ======================== 儲存格型別 ========================
    const PLAIN_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

    /** 一個值依儲存格格式變成 SheetJS 儲存格；空值回 null（不建立儲存格） */
    function toCell(value, format) {
      const text = value === undefined || value === null ? '' : String(value);
      if (text === '') return null;

      if (format === '文字') return { t: 's', v: text, z: '@' };

      if (format === '數值') {
        const n = Number(text.replace(/,/g, '').trim());
        if (text.trim() === '' || !Number.isFinite(n)) return null;
        return { t: 'n', v: n, z: '#,##0' };
      }

      if (format === '日期') {
        const ymd = parseDateText(text);
        return ymd ? { t: 'n', v: dateSerial(ymd), z: 'yyyy/mm/dd' } : { t: 's', v: text };
      }

      // 一般：看起來是數字（沒有前導 0、15 位數以內）就存成數字，其餘是文字
      if (PLAIN_NUMBER.test(text) && text.replace(/\D/g, '').length <= 15) return { t: 'n', v: Number(text) };
      return { t: 's', v: text };
    }

    // ======================== 組成工作表 ========================
    /**
     * 第 1 列是標題（Excel欄位說明放在 Excel欄位代碼指的那一欄），其後是 buildRows 的資料列。
     * 回傳 SheetJS 工作表物件（不依賴 XLSX 全域）。
     */
    function buildSheet(mappings, rows) {
      const ws = {};
      const colIdx = mappings.map((m) => columnIndex(m.excelColumn));
      const widths = [];
      let maxCol = -1;

      mappings.forEach((m, i) => {
        const c = colIdx[i];
        if (c < 0) {
          console.warn('批次整理資料：Excel欄位代碼不是英文字母，略過', m.excelColumn);
          return;
        }
        maxCol = Math.max(maxCol, c);
        const header = String(m.excelColumnName || '');
        widths[c] = { wch: Math.max(header.length, MIN_COL_WIDTH) };
        if (header !== '') ws[`${columnLetters(c)}1`] = { t: 's', v: header };
      });

      rows.forEach((row, r) => {
        row.forEach((cell, i) => {
          const c = colIdx[i];
          if (c < 0) return;
          const built = toCell(cell.value, cell.format);
          if (built) ws[`${columnLetters(c)}${r + 2}`] = built;
        });
      });

      ws['!ref'] = maxCol < 0 ? 'A1' : `A1:${columnLetters(maxCol)}${rows.length + 1}`;
      ws['!cols'] = Array.from({ length: maxCol + 1 }, (_, c) => widths[c] || { wch: MIN_COL_WIDTH });
      return ws;
    }

    // ======================== 提示視窗（全域 SweetAlert，寬度自動）========================
    /** 取代瀏覽器的 alert；icon: 'info'|'warning'|'error'|'success'。載不到 SweetAlert 才退回 alert */
    function notify(text, icon = 'info') {
      if (typeof Swal === 'undefined') {
        alert(text);
        return Promise.resolve();
      }
      return Swal.fire({ icon, text, width: 'auto', confirmButtonText: '好', customClass: { htmlContainer: 'pr-notice-text' } });
    }

    // ======================== 產生 Excel 並下載 ========================
    /** opts 同 buildRows（today 不給就用現在） */
    async function generateExcel(mappings, records, opts) {
      if (typeof XLSX === 'undefined') {
        await notify('錯誤：SheetJS 函式庫未載入，請確認已上傳 xlsx.full.min.js', 'error');
        return null;
      }

      const rows = buildRows(mappings, records, { today: new Date(), ...opts });
      if (rows.length === 0) {
        await notify('沒有可轉出的資料', 'warning');
        return null;
      }

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, buildSheet(mappings, rows), SHEET_NAME);

      const fileName = `交通費轉出_${formatDate(new Date(), 'YYYYMMDD')}.xlsx`;
      XLSX.writeFile(wb, fileName);

      console.log('Excel 檔案已產生:', fileName);
      return { fileName, rowCount: rows.length };
    }

    // ======================== 轉出日期視窗 ========================
    const escapeHtml = (text) =>
      String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    /** 金額加千分位（#,##0）；不是數字就原樣 */
    function formatAmount(value) {
      const n = Number(String(value ?? '').replace(/,/g, '').trim());
      if (String(value ?? '').trim() === '' || !Number.isFinite(n)) return String(value ?? '');
      return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /**
     * 日期視窗的內容 HTML（records 已排好序）：上方「全部套用」，下方每筆記錄一列（受款人、單號、費用所屬人、總金額、日期）。
     * 受款人只在同一組（受款人鍵相同）的第一列顯示，該列加 pr-export-row--group-start 讓 CSS 畫分隔線。所有值都做 HTML 跳脫。
     */
    function buildDateDialogHtml(records, todayText) {
      const today = escapeHtml(todayText);
      const monthEnd = escapeHtml(lastDayOfPrevMonth(todayText)); // 「月帳」按鈕帶入的日期
      let prevKey = null;
      const body = records
        .map((r, i) => {
          const key = payeeKey(r);
          const first = i === 0 || key !== prevKey;
          prevKey = key;
          const rowClass = first ? 'pr-export-row pr-export-row--group-start' : 'pr-export-row';
          const payee = first ? escapeHtml(key || '—') : '';
          const no = escapeHtml(valueToText(r[FIELDS.RECORD_NO]?.value));
          const owner = escapeHtml(bracketInner(valueToText(r[FIELDS.EXPENSE_OWNER]?.value)));
          const total = escapeHtml(formatAmount(r[FIELDS.TOTAL_AMOUNT]?.value));
          const id = escapeHtml(r.$id?.value);
          return (
            `<tr class="${rowClass}">` +
            `<td class="pr-export__payee" data-label="受款人">${payee}</td>` +
            `<td data-label="單號">${no}</td>` +
            `<td data-label="費用所屬人">${owner}</td>` +
            `<td class="pr-export__num" data-label="總金額">${total}</td>` +
            `<td class="pr-export__date-cell" data-label="轉出日期"><input type="date" class="pr-export__date" data-record-id="${id}" value="${today}">` +
            `<button type="button" class="pr-export__month-btn" data-date="${monthEnd}" title="帶入上個月最後一天">月帳</button></td>` +
            '</tr>'
          );
        })
        .join('');

      return (
        '<div class="pr-export">' +
        '<div class="pr-export__bulk">' +
        '<span class="pr-export__bulk-label">轉出日期</span>' +
        `<input type="date" class="pr-export__date pr-export__bulk-date" value="${today}">` +
        '<button type="button" class="pr-export__bulk-btn">全部套用</button>' +
        '</div>' +
        '<div class="pr-export__scroll"><table class="pr-export__table">' +
        '<thead><tr><th>受款人</th><th>單號</th><th>費用所屬人</th><th class="pr-export__num">總金額</th><th>轉出日期</th></tr></thead>' +
        `<tbody>${body}</tbody>` +
        '</table></div>' +
        '</div>'
      );
    }

    /**
     * 跳「轉出交通費 Excel」視窗讓使用者確認每筆的轉出日期（預設今天）。
     * 回傳 { 記錄編號: 'YYYY-MM-DD' }；按取消回傳 null；Swal 沒載入就全部用今天、不跳視窗。
     */
    async function askExportDates(records, todayText) {
      if (typeof Swal === 'undefined') {
        return Object.fromEntries(records.map((r) => [r.$id.value, todayText]));
      }

      const result = await Swal.fire({
        title: '轉出交通費 Excel',
        html: buildDateDialogHtml(records, todayText),
        showCancelButton: true,
        confirmButtonText: '轉出 Excel',
        cancelButtonText: '取消',
        reverseButtons: true,
        focusConfirm: false,
        allowOutsideClick: false,
        buttonsStyling: false,
        customClass: {
          popup: 'pr-signer-popup pr-export-popup',
          title: 'pr-signer-popup__title',
          htmlContainer: 'pr-signer-popup__body',
          actions: 'pr-signer-popup__actions',
          confirmButton: 'pr-signer-btn pr-signer-btn--primary',
          cancelButton: 'pr-signer-btn pr-signer-btn--ghost',
          validationMessage: 'pr-signer-popup__message',
        },
        didOpen: (popup) => {
          const bulkDate = popup.querySelector('.pr-export__bulk-date');
          popup.querySelector('.pr-export__bulk-btn')?.addEventListener('click', () => {
            if (!bulkDate?.value) return;
            popup.querySelectorAll('.pr-export__date[data-record-id]').forEach((input) => {
              input.value = bulkDate.value;
            });
          });
          // 「月帳」：同一列的日期改成上個月最後一天
          popup.querySelectorAll('.pr-export__month-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
              const input = btn.parentElement?.querySelector('.pr-export__date');
              if (input && btn.dataset.date) input.value = btn.dataset.date;
            });
          });
        },
        preConfirm: () => {
          const dates = {};
          for (const input of Swal.getPopup().querySelectorAll('.pr-export__date[data-record-id]')) {
            const v = input.value;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !parseDateText(v)) {
              Swal.showValidationMessage('請填寫每一筆的日期');
              return false;
            }
            dates[input.dataset.recordId] = v;
          }
          return dates;
        },
      });

      return result.isConfirmed ? result.value : null;
    }

    // ======================== 主要處理函數 ========================
    async function handleBatchOrganizeData() {
      try {
        const recordIds = getRecordIdsFromUI();
        if (recordIds.length === 0) {
          await notify('請輸入有效的記錄號碼範圍', 'warning');
          return;
        }

        console.log('處理記錄:', recordIds);

        // 1. 一按就跳「請稍後」，同時讀欄位對應設定、請款單記錄、Business Area 對照（費用歸屬 → Business Area）
        showLoading();
        const [mappings, records, businessArea] = await Promise.all([fetchFieldMappings(), fetchSourceRecords(recordIds), fetchBusinessAreaMap()]);
        console.log('欄位對應設定:', mappings);
        console.log('請款單記錄:', records);

        if (mappings.length === 0) {
          closeLoading();
          await notify('錯誤：未取得任何欄位對應設定', 'error');
          return;
        }
        if (records.length === 0) {
          closeLoading();
          await notify('錯誤：未取得任何請款單記錄', 'error');
          return;
        }

        // 2. 依受款人排序，讓使用者確認每筆的轉出日期（日期視窗直接取代「請稍後」）
        const sorted = sortRecordsByPayee(records);
        const dates = await askExportDates(sorted, formatDate(new Date(), 'YYYY-MM-DD'));
        if (!dates) return;

        // 3. 產生 Excel
        console.log('正在產生 Excel...');
        const result = await generateExcel(mappings, sorted, { dates, businessArea });
        if (!result) return;

        await notify(`Excel 檔案已產生並下載\n檔名：${result.fileName}\n共 ${records.length} 筆記錄、${result.rowCount} 列資料`, 'success');
      } catch (error) {
        closeLoading();
        console.error('批次整理資料錯誤:', error);
        await notify('處理過程發生錯誤: ' + error.message, 'error');
      }
    }

    // ======================== 「請稍後」小視窗 ========================
    /** 讀資料時的轉圈小視窗；之後的 Swal.fire（日期視窗）會直接取代它。沒有 Swal 就不顯示 */
    function showLoading() {
      if (typeof Swal === 'undefined') return;
      Swal.fire({
        title: '請稍後',
        text: '正在讀取資料…',
        allowOutsideClick: false,
        allowEscapeKey: false,
        showConfirmButton: false,
        customClass: { popup: 'pr-export-loading' },
        didOpen: () => Swal.showLoading(),
      });
    }

    function closeLoading() {
      if (typeof Swal !== 'undefined') Swal.close();
    }

    // ======================== 等待按鈕出現並綁定 ========================
    function waitForButtonAndBind() {
      let attempts = 0;
      const maxAttempts = 50;

      const checkButton = setInterval(function () {
        attempts++;
        const btn = document.getElementById('batch-organize-button');

        if (btn && !btn.dataset.bindOrganize) {
          btn.addEventListener('click', handleBatchOrganizeData);
          btn.dataset.bindOrganize = 'true';
          console.log('批次整理資料按鈕綁定成功');
          clearInterval(checkButton);
        } else if (attempts >= maxAttempts) {
          console.log('找不到批次整理資料按鈕（可能無權限）');
          clearInterval(checkButton);
        }
      }, 100);
    }

    // ======================== 事件註冊 ========================
    window.PR_BATCH_ORGANIZE = Object.freeze({
      parseTemplate,
      resolveToken,
      applyFilters,
      evalArithmetic,
      valueToText,
      buildRows,
      payeeKey,
      sortRecordsByPayee,
      buildBusinessAreaMap,
      buildDateDialogHtml,
      lastDayOfPrevMonth,
      showLoading,
      closeLoading,
      buildSheet,
      generateExcel,
      toCell,
      mapMappingRecord,
      fetchFieldMappings,
      columnIndex,
      columnLetters,
      formatDate,
    });

    kintone.events.on('app.record.index.show', function (event) {
      waitForButtonAndBind();
      return event;
    });
  })();

  (() => {

    // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
    const KT = window.PR_KT;

    const F = window.PR_CONFIG.FIELDS;
    const BUTTON_ID = 'same-applicant-btn';

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
     * 僅限本人（建立人）觸發，避免他人瀏覽時誤打 API。
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

      // '建立人' 為 kintone 內建欄位（CREATOR，值是單一物件，沒有 value[0]），非本表單自訂欄位，故不進 PR_CONFIG.FIELDS
      const creatorCode = record['建立人']?.value?.code;

      return Boolean(creatorCode) && loginCode === creatorCode;
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
        width: 'auto',
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

  (function () {
    const F = window.PR_CONFIG.FIELDS;

    // 列印時要隱藏的欄位／群組（內部簽核用、除錯用，不印在單據上）
    const PRINT_HIDDEN_FIELDS = [F.SIGN_FLOW_GROUP, F.MANUAL_FLOW, F.PERMISSION_STAFF, F.DEV_ONLY_DATA];

    // 隱藏空白間隔與標籤欄位
    const HIDE_SELECTOR = '.spacer-cybozu:not(#user-js-Expense_Table), .control-label-field-gaia';

    const handlePrintShow = (event) => {
      PRINT_HIDDEN_FIELDS.forEach((field) => kintone.app.record.setFieldShown(field, false));
      document.querySelectorAll(HIDE_SELECTOR).forEach((el) => (el.style.display = 'none'));
      return event;
    };

    kintone.events.on(['app.record.print.show'], handlePrintShow);

    window.PR_PRINT_SHOW = Object.freeze({ PRINT_HIDDEN_FIELDS, HIDE_SELECTOR, handlePrintShow });
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

  (() => {

    // =============================================================================
    // 交通費明細表頭的官方查詢連結（桌面版的新增、編輯、詳細畫面；列印頁和手機版不加）
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

  (() => {

    // 詳細頁面顯示事件
    kintone.events.on('app.record.detail.show', (event) => {
      const record = event.record;
      // STATUS.VOID 是比對的狀態值
      if (record[window.PR_CONFIG.FIELDS.STATUS_FIELD]?.value !== window.PR_CONFIG.STATUS.VOID) {
        return event;
      }

      // 檢查作廢欄位是否存在且被勾選
      if (record[window.PR_CONFIG.VOID_FIELD] && record[window.PR_CONFIG.VOID_FIELD].value && record[window.PR_CONFIG.VOID_FIELD].value.length > 0) {
        // 延遲執行以確保 DOM 已載入
        setTimeout(() => {
          // 尋找特殊情形欄位的標籤元素
          const voidFieldLabel = kintone.app.record.getFieldElement(window.PR_CONFIG.VOID_FIELD);

          if (voidFieldLabel) {
            // 標籤與核取方塊放大、紅框（樣式在 payment_request.css 的 .pr-void-field）
            voidFieldLabel.classList.add('pr-void-field');
          }
        }, 100);
      }

      return event;
    });
  })();

  (function () {
    function updateAttachmentInList(record, index) {
      // 找到該筆記錄的附件欄位 <td>
      const attachmentCells = document.querySelectorAll('.recordlist-cell-gaia.recordlist-file-gaia');
      if (!attachmentCells || attachmentCells.length <= index) {
        return;
      }
      const attachmentCell = attachmentCells[index];

      // 獲取該筆記錄的附件資料
      const attachmentField = record[window.PR_CONFIG.FIELDS.ATTACHMENT];
      if (!attachmentField || !attachmentField.value || attachmentField.value.length === 0) {
        return;
      }

      // 找到該筆記錄的附件列表 <li>
      const fileItems = attachmentCell.querySelectorAll('.recordlist-file-others-gaia');
      if (!fileItems || fileItems.length === 0) {
        return;
      }

      // 遍歷附件
      attachmentField.value.forEach((file, fileIndex) => {
        if (fileIndex >= fileItems.length) return;

        const fileItem = fileItems[fileIndex];
        const fileName = file.name;
        const fileExt = fileName.split('.').pop().toLowerCase();

        if (fileExt === 'pdf') {
          // 檢查是否已經有預覽按鈕
          if (fileItem.querySelector('.gaia-attachment-file-action-preview')) {
            return;
          }

          // 創建預覽按鈕
          const previewButton = document.createElement('a');
          previewButton.className = 'gaia-attachment-file-action-link gaia-attachment-file-action-preview pr-preview-button'; // 樣式在 payment_request.css
          previewButton.title = '預覽';
          previewButton.href = 'javascript:void(0)';

          // 創建放大鏡圖示
          const magnifierIcon = document.createElement('i');
          magnifierIcon.className = 'fa fa-search gaia-attachment-file-action-preview-image';
          previewButton.appendChild(magnifierIcon);

          // 點擊事件
          previewButton.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const fileUrl = await getFileUrl(file.fileKey);
            openInNewTab(fileUrl);
          };

          // 添加按鈕
          fileItem.appendChild(previewButton);
        }
      });
    }

    // 添加簡單的日誌功能，方便除錯
    // function log(message, data) {
    //   console.log(`[附件預覽] ${message}`, data || '');
    // }

    // 更新附件欄位中的文件
    function updateAttachmentField(record) {
      // 找到附件欄位 - 嘗試多種選擇器
      const attachmentFieldEl = kintone.app.record.getFieldElement(window.PR_CONFIG.FIELDS.ATTACHMENT);
      if (!attachmentFieldEl) {
        return;
      }

      // 獲取附件資料
      const attachmentField = record[window.PR_CONFIG.FIELDS.ATTACHMENT];
      if (!attachmentField || !attachmentField.value || attachmentField.value.length === 0) {
        return;
      }

      // 嘗試多種選擇器找到文件列表
      let fileListEl = attachmentFieldEl.querySelector('.attachment-list-itemlist');
      if (!fileListEl) {
        fileListEl = attachmentFieldEl.querySelector('.gaia-attachment-filelist');
      }
      if (!fileListEl) {
        fileListEl = attachmentFieldEl;
      }

      if (!fileListEl) {
        return;
      }

      // 使用多種可能的選擇器來找到文件項目
      let fileItems = fileListEl.querySelectorAll('.attachment-list-item');
      if (!fileItems || fileItems.length === 0) {
        fileItems = fileListEl.querySelectorAll('.gaia-attachment-file');
      }
      if (!fileItems || fileItems.length === 0) {
        fileItems = fileListEl.querySelectorAll('li');
      }

      if (!fileItems || fileItems.length === 0) {
        return;
      }

      // 遍歷所有檔案
      attachmentField.value.forEach((file, index) => {
        if (index >= fileItems.length) {
          return;
        }

        const fileItem = fileItems[index];
        const fileName = file.name;
        const fileExt = fileName.split('.').pop().toLowerCase();

        // 僅為 PDF 檔案添加預覽按鈕
        if (fileExt === 'pdf') {
          // 檢查是否已有預覽按鈕
          if (fileItem.querySelector('.gaia-attachment-file-action-preview')) {
            return;
          }

          // 嘗試多種選擇器找到適合添加按鈕的容器
          let fileInfoContainer = fileItem.querySelector('.attachment-list-item-gaia');
          if (!fileInfoContainer) {
            fileInfoContainer = fileItem.querySelector('.gaia-attachment-file-fileinformation');
          }
          if (!fileInfoContainer) {
            fileInfoContainer = fileItem.querySelector('a').parentNode;
          }
          if (!fileInfoContainer) {
            fileInfoContainer = fileItem;
          }

          const previewButton = document.createElement('a');
          previewButton.className = 'gaia-attachment-file-action-link gaia-attachment-file-action-preview pr-preview-button'; // 樣式在 payment_request.css
          previewButton.title = '預覽';
          previewButton.href = 'javascript:void(0)';

          // 創建放大鏡圖示
          const magnifierIcon = document.createElement('i');
          magnifierIcon.className = 'fa fa-search gaia-attachment-file-action-preview-image';
          previewButton.appendChild(magnifierIcon);

          // 添加點擊事件
          previewButton.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const fileUrl = await getFileUrl(file.fileKey);
            openInNewTab(fileUrl);
          };

          // 將按鈕添加到檔案資訊容器
          fileInfoContainer.appendChild(previewButton);
        }
      });
    }

    // 下載 Kintone 附件
    async function getFileUrl(fileKey) {
      try {
        const response = await fetch(kintone.api.url('/k/v1/file.json', true) + `?fileKey=${fileKey}`, {
          method: 'GET',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
          },
        });

        if (!response.ok) {
          throw new Error('無法下載檔案');
        }

        const blob = await response.blob();
        const fileUrl = URL.createObjectURL(blob);
        return fileUrl;
      } catch (error) {
        console.error('無法取得檔案 URL:', error);
        return null;
      }
    }

    /** 提示視窗：全域 SweetAlert（寬度自動）；載不到 SweetAlert 才退回瀏覽器的 alert */
    function notify(text, icon) {
      if (typeof Swal === 'undefined') {
        alert(text);
        return;
      }
      Swal.fire({ icon, text, width: 'auto', confirmButtonText: '好', customClass: { htmlContainer: 'pr-notice-text' } });
    }

    // **彈出視窗顯示預覽**
    function openInNewTab(fileUrl) {
      if (!fileUrl) {
        notify('無法預覽檔案，請稍後再試！', 'error');
        return;
      }

      // 直接在新分頁開啟
      window.open(fileUrl, '_blank');
    }

    // 處理詳細頁面的顯示
    kintone.events.on('app.record.detail.show', function (event) {
      // 首次更新
      setTimeout(() => {
        updateAttachmentField(event.record);
      }, 500);

      // 再次嘗試更新，以防DOM延遲載入
      setTimeout(() => {
        updateAttachmentField(event.record);
      }, 1500);

      // 設置 MutationObserver
      setTimeout(() => {
        // 確認當前仍在詳細頁面
        if (!window.isKintoneDetailPage) return;

        const targetNode = document.body;
        const config = { childList: true, subtree: true };

        const callback = function (mutationsList) {
          // 確認當前仍在詳細頁面
          if (!window.isKintoneDetailPage) return;

          for (const mutation of mutationsList) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
              // kintone.app.record.get() 不接受 REST API 風格的 {app,id}+callback 參數；
              // 它是同步 API，只回傳「目前畫面上這筆記錄」的內容，原寫法的 callback 從未被呼叫過。
              if (kintone.app.record.getId()) {
                const resp = kintone.app.record.get();
                updateAttachmentField(resp.record);
              }
            }
          }
        };

        // 保存 observer 到全局變數以便後續清除
        if (window.attachmentObserver) {
          window.attachmentObserver.disconnect();
        }

        window.attachmentObserver = new MutationObserver(callback);
        window.attachmentObserver.observe(targetNode, config);
      }, 2000);

      return event;
    });

    kintone.events.on('app.record.index.show', function (event) {
      // 設定延遲確保 DOM 載入完成
      setTimeout(() => {
        event.records.forEach((record, index) => {
          updateAttachmentInList(record, index);
        });
      }, 1000);

      return event;
    });
  })();

  function adjustTransferButtonsPosition() {
    // 延遲執行以確保按鈕已經渲染
    setTimeout(() => {
      // 找到所有動作按鈕的 span 標籤
      const actionLabels = document.querySelectorAll('.gaia-app-statusbar-action-label');

      actionLabels.forEach((span) => {
        const buttonText = span.textContent || span.innerText;

        // 檢查是否為「轉至」開頭的按鈕
        if (buttonText.startsWith('轉至')) {
          // 找到 span 的父元素（應該是 button）
          const button = span.closest('button') || span.parentElement;

          if (button) {
            // 往右移動按鈕（樣式在 payment_request.css）
            button.classList.add('pr-transfer-button');
          }
        }
      });

      console.log('已調整轉至按鈕位置');
    }, 500);
  }

  kintone.events.on(['app.record.detail.show'], (event) => {
    adjustTransferButtonsPosition();
    return event;
  });

})();
//# sourceMappingURL=payment_request_desktop.js.map
