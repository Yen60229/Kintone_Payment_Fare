# ES module 遷移計畫（審查第 17 項）

> 第一階段（盤點＋試點）已完成，等使用者同意、且 `rename-files-dist` 併進 main 後才做第二階段。
> 全部遷移完成後，本檔的結論併進 [`749_現況與待決事項.md`](749_現況與待決事項.md) §2，本檔刪除。

## 1. 現況盤點

### 1.1 `window.PR_*` 全域（28 個）

| 全域 | 定義 | 程式裡的使用端（全部是「事件／呼叫當下」才讀，沒有載入時就讀的） | 測試直接讀 |
|---|---|---|---|
| `PR_CONFIG` `PR_KT` `PR_SAVE_ERRORS` `PR_ENV` | config | 幾乎全部；752 的規則主檔檢查、欄位標籤說明圖示 | 多 |
| `PR_BUILD_TARGET` | `src/mobile_target.js`（手機版，config 前） | config | build_targets |
| `PR_COST_CENTER` `PR_COMPANY_NAME` `PR_TABLE_LAYOUT` | main | submit、費用歸屬部門限制、簽核人員 | cost_center_load、cost_scope、main_events、company_name…；**tools/audit 自己塞替身** |
| `PR_SHOW_VALIDATION` | submit | 作廢防呆 | misc_modules |
| `PR_COST_SCOPE` | 費用歸屬部門限制 | submit、簽核人員、手動簽核人 | 4 支 |
| `PR_SIGNING_CHAIN` `PR_ORG_PICKER` `PR_MANUAL_MODE` | 簽核人員 | submit；申請人部門帶入；手動簽核人 | signing_*、primary_org、manual_signers |
| `PR_DIRECTOR_UPLINE` | 部長上一階主管 | submit、簽核人員 | director_upline、signing_owner_chain |
| `PR_USERS` | 使用者主檔快取 | 受款人、手動簽核人 | user_cache |
| `PR_MANUAL_SIGNERS` | 手動簽核人 | submit、簽核人員 | 4 支 |
| `PR_TRAFFIC_RULES` | 交通費明細規則 | submit | traffic_rules、traffic_rule_master |
| `PR_INVOICE_AGG` | 發票號碼寫入獨立欄位檢查 | 交通費明細規則 | invoice_agg |
| `PR_PAYEE` | 受款人 | 公司卡付款來源 | payee_fill、user_cache |
| `PR_BATCH_VOUCHER` | 批次填傳票 | 檔案批次（下拉選單） | batch_voucher_status |
| `PR_CARD_PAY` `PR_APPLICANT_ORG` `PR_EXPECTED_PAY_DATE` `PR_SAVING_HINT` `PR_PRINT_SHOW` `PR_TABLE_HEADER_LINKS` `PR_LABEL_HINTS` `PR_BATCH_PDF` `PR_BATCH_ORGANIZE` `PR_DETAIL_FIT_WIDTH` `PR_TRAFFIC_RULE_MASTER_CHECK` | 各自模組 | **沒有**（只給測試用） | 各自的測試 |

外部程式：invoice-registry plug-in **不讀** `PR_*`（自己 `kintone.events.on`）。

### 1.2 載入順序真正在意的地方
1. **config 第一**（手機版 `mobile_target` 更前面）：其他模組一載入就讀 `window.PR_CONFIG`／`PR_KT`。
2. **事件註冊順序＝執行順序**：kintone 依註冊順序跑同一事件的處理程式。例：公司卡付款來源要比 submit 早把錯誤放進 `PR_SAVE_ERRORS`；存檔等待提示要第一個。
3. **`setTimeout(0)`**（`存檔等待提示.js` 結尾）：「擋下時關掉提示」要排在**所有**存檔處理程式最後，包含 bundle 之後才載入的 plug-in（invoice-registry 有註冊 submit）。→ **保留**，不改成入口檔最後一行呼叫。
4. 模組之間互讀 `PR_*` 都在事件當下，所以「提供者排在使用者後面」（submit 讀後面的交通費明細規則、簽核人員讀後面的手動簽核人…）現在沒問題。

### 1.3 只能維持傳統 script 的檔（直接上傳原始檔）
- `payment_request_config.js`：App 752 排第一（也打包進 749 的 bundle）。
- `交通費明細規則主檔檢查.js`、`欄位標籤說明圖示.js`：752 單獨上傳。
→ 這三支不能 `import`／`export`，繼續掛 `window.PR_CONFIG`／`PR_KT`／`PR_SAVE_ERRORS`／`PR_ENV`／`PR_LABEL_HINTS`。
（之後若要連它們也改，可加第三套打包 `dist/rule_master_desktop.js` 給 752，屬於上傳方式變更，另外決定。）

## 2. 目標結構

- **模組＝ES module，只定義、不做事**：載入時只定義函式與常數（可讀 `window.PR_CONFIG`／`PR_KT`），
  **事件註冊、DOM、計時器、掛全域全部放在 `export const install = () => {…}`**。
- **入口檔照樣是一行一支、順序＝事件註冊順序**：`import '../x.js?install';`
  （`vite.config.js` 的 `installEntries`：先執行模組，輪到這一行才呼叫 `install()`）。
  為什麼不直接在模組最上層註冊：submit 要 `import` 後面的交通費明細規則，ES module 會先執行被 import 的檔，
  註冊順序就變了。`?install` 讓「模組互相 import」和「註冊順序」脫鉤。
- **模組之間改 `import { … } from './x.js'`**，拿掉 `window.PR_*`；循環依賴（簽核人員 ↔ 手動簽核人）在 ES module 可行，因為都是事件當下才用。
- **保留的全域**：只有 1.3 那幾個（config 提供的、752 會單獨用的）。其他 `PR_*` 全部刪除；`?.` 防呆（「模組沒載入」）改成直接呼叫。
- 兩套 bundle 不變：`dist/payment_request_desktop.js`、`dist/payment_request_mobile.js`；上傳方式不變。

## 3. 測試怎麼載入模組

- `tests/lib/esm_loader.cjs`：esbuild 把**單一檔**轉 CommonJS（不打包），在原本的 vm 沙箱裡執行；
  檔裡的相對 `import` 由同一個沙箱的模組快取載入（每支只執行一次、共用狀態，和打包後一樣）。
- `env.load(file)`：傳統 script 照舊；ES module → 載入＋`install()`，**回傳 exports**（測試改讀回傳值，不讀 `env.window.PR_X`）。
  `env.import(file)`：只載入、不 `install()`。
- 自己建沙箱的測試（build_targets、detail_fit_width…）用 `createModuleLoader(sandbox)`；用 `global` 的（payee_fill）傳 `null`。
- 第二階段要補：loader 加 `stubs` 選項（指定某支檔回傳替身 exports），取代 `tools/audit` 現在直接塞 `window.PR_COST_CENTER` 的做法。
- 新增檢查（build_targets）：入口 `?install` ⇔ 檔案是 ES module 且 export `install`；ES module 載入時不註冊事件、不碰 DOM／API／計時器；1.3 的檔維持傳統 script。

## 4. 試點結果（第一階段，已完成）

| 檔 | 類型 | 做法 |
|---|---|---|
| `開發人員用群組欄位.js` | 只有事件、PC＋手機 | 事件移進 `install()` |
| `詳細頁欄位寬度自動.js` | 只有桌面、全域只給測試 | 純函式 `export`，刪 `PR_DETAIL_FIT_WIDTH` |
| `使用者主檔快取.js` | 被兩支傳統 script 使用的函式庫 | `export { fetchAll, loadAll, PAGE_SIZE }`；**過渡橋**：`install()` 掛 `window.PR_USERS`，等受款人、手動簽核人改成 import 後刪 |

驗證：`npm test`、語法、掃描、lint、build 全過；另外把 HEAD 與試點的兩套 bundle 在沙箱執行，
**桌面 56／手機 38 個事件註冊，順序與處理程式內容完全相同**（只差 Rollup 把重名的 `KT` 改成 `KT$1`）。

## 5. 第二階段步驟（每步跑 `npm test && bash tests/syntax.test.sh && npm run scan && npm run lint && npm run build`，並做 bundle 對照）

0. rebase 到 main（`rename-files-dist` 併入後；試點三支若被改名，手動重做，檔很小）。把 bundle 對照腳本收進 `scripts/`。
1. **只給測試用全域的 11 支**（1.1 最後一列，`欄位標籤說明圖示`、`規則主檔檢查` 除外）：純函式 export、事件進 `install()`、測試改讀回傳值。
2. **沒有對外 API 的事件模組**：帳號權限設定、作廢防呆、流程自動推進、print.show、請款單作廢_style、coding_tools、file_reader、轉至其他會計單位、存檔等待提示（`setTimeout(0)` 原樣搬進 `install()`）。
3. **葉節點提供者**：發票號碼寫入獨立欄位檢查 → 交通費明細規則改 import；使用者主檔快取的使用端（受款人、手動簽核人）改 import 後拆掉過渡橋；批次填傳票 → 檔案批次。
4. **中層**：main（COST_CENTER／COMPANY_NAME／TABLE_LAYOUT）、費用歸屬部門限制、部長上一階主管、受款人 → 公司卡。tools/audit 改用 loader 的 `stubs`。
5. **核心**：簽核人員 ↔ 手動簽核人（循環）、submit（讀五個提供者）。`?.` 防呆改直接呼叫（行為相同：打包後一定都在）。
6. 收尾：入口檔只剩 `?install` 與 config；build_targets 改成「除了 1.3 全部是 ES module」；README／CLAUDE.md 建置章節、現況文件更新；本檔併入現況文件後刪除。

風險與對策：
- **註冊順序**：靠 `?install`＋每步 bundle 對照（事件名稱＋處理程式原始碼逐一比）。
- **大檔去掉 IIFE 會整檔縮排變動**：用 `git diff -w` 檢視；和其他分支（debug-log-switch 等）衝突在 rebase 時處理，所以本分支最後合併。
- **esbuild 沒列在 package.json**：它是 Vite 的相依套件，npm 會裝；若要明列，第二階段再加。
