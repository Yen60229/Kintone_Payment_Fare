# 交通費請款單（kintone App 749）

kintone **交通費請款單（測試區 App 749）** 的自訂 JavaScript 原始碼。
本專案由「請款單 App 723」的 repo 複製而來，已刪除 723 其他類型（請購、庶務、出差、交際費、一般、集團公司、船公司）與分攤表的程式，
並改接 749 的欄位代碼。現況、已拍板的設計與待決事項見 [`docs/749_現況與待決事項.md`](docs/749_現況與待決事項.md)。

給使用者看的說明（`docs/使用說明/`）：[新增表單的預設內容](docs/使用說明/1_新增表單的預設內容.md)、[簽核流程](docs/使用說明/2_簽核流程.md)、[欄位功能與防呆](docs/使用說明/3_欄位功能與防呆.md)。
程式行為改了（預設值、簽核規則、防呆）要同步更新這三份。

---

## 這個 App 在做什麼

員工填寫交通費明細（子表格「交通費請款單」），申請人部門、費用所屬人部門依人員自動帶入（鎖住不能手改），
程式依 **費用所屬人／費用所屬人部門** 自動帶入簽核人員與會計單位，
存檔時檢查費用歸屬代碼、掛帳單位是否在費用所屬人部內、申請人與費用所屬人是否同部門、發票號碼重複，並計算預計付款日；費用所屬人是部長時依費用歸屬帶入單位部長；
明細自動算稅額、高鐵帶入賣方統編與格式、計程車要求紙本憑證與理由；列表頁可批次下載附件、批次列印 PDF、轉出 SAP 檔。

| 用途 | App（常數名，App ID 見 `payment_request_config.js` 的 `APPS`） |
|---|---|
| 簽核流程主檔 | `APPS.APPROVAL_FLOW` |
| 會計單位／承辦人對應 | `APPS.ACCOUNTING_MAP` |
| 費用歸屬代碼 | `APPS.COST_CENTER` |
| 帳號權限設定（欄位顯隱／可編輯／必填） | `APPS.PERMISSION` |
| 行事曆（預計付款日） | `APPS.HOLIDAY_CALENDAR` |
| SAP 轉檔欄位對應 | `APPS.SAP_MAPPING` |
| PDF 字型 | `APPS.PDF_FONT` |

---

## 測試與檢查

### 每次改動後必跑
```bash
npm test && bash tests/syntax.test.sh && npm run scan
```
- `npm test`：28 支測試（共 492 項斷言）。
- `bash tests/syntax.test.sh`：對根目錄所有 `*.js` 跑 `node --check`（目前 25 檔）。
- `npm run scan`：統計剩餘的 App ID／狀態／選項／欄位代碼硬編碼（目前 11 處）。

### 檢查流程管理設定
```bash
npm run check:process
```
- 沒給參數時，檢查 `process_management/exports/` 裡 revision 最大的 `749_rev*.json`。
- 會跑三項：結構檢查、把所有合法假資料從「報銷人填單」走到會計、每個狀態的按鈕。
- 從 kintone 下載新版流程設定後，放進 `process_management/exports/` 再跑一次。
- 目前 749 rev 1795 本身有已知問題，所以會回傳結束代碼 1（見 docs 待決事項）。

### 打包
```bash
npm run build
```
一次打包桌面版與手機版，**只打包 JS**，輸出到 `dist/`：

| 檔案 | 入口 | 內容 |
|---|---|---|
| `payment_request_desktop.js` | [`src/index.js`](src/index.js) | 桌面版模組（coding_tools、SetFieldWidth 除外） |
| `payment_request_mobile.js` | [`src/mobile.js`](src/mobile.js) | 新增／編輯／詳細畫面的表單行為（桌面版的子集） |

以下放在**專案最外層、不經過打包**，直接上傳原始檔：

| 檔案 | 內容 |
|---|---|
| [`payment_request.css`](payment_request.css) | **全部樣式只有這一個檔**，PC 和手機都上傳同一份 |
| [`coding_tools.js`](coding_tools.js) | 列表頁「JS 自定義設定」「流程管理」按鈕（只有 PC） |
| [`SetFieldWidth_4_20251206.js`](SetFieldWidth_4_20251206.js) | 欄位依內容自動調寬（只有 PC） |

- 只打一套：`npm run build:desktop`、`npm run build:mobile`（`build:mobile` 不會清空 `dist/`）。
- `.map` 是除錯用，不用上傳。
- 樣式一律寫在 `payment_request.css`，JS 裡不注入 `<style>`、不寫 `cssText`／HTML `style` 屬性，只加 `pr-` 開頭的 class（`tests/build_targets.test.cjs` 會檢查）；
  只有執行時才算得出來的值（欄寬、顯示／隱藏、進度條）留在 JS。

---

## 上傳到 kintone（App 設定 →「JavaScript／CSS 自訂」）

每個區塊都是**由上往下載入**，外部函式庫要排在我們的檔案前面。外部函式庫沿用請款單 723 後台現在用的那幾份（同網址、同版本）。

| 區塊 | 依序上傳 |
|---|---|
| JavaScript（PC） | ① SweetAlert2 ② PDFLib ③ fontkit ④ JSZip ⑤ SheetJS（`XLSX`）⑥ `dist/payment_request_desktop.js` ⑦ `coding_tools.js` ⑧ `SetFieldWidth_4_20251206.js` |
| CSS（PC） | ① SweetAlert2 的 CSS（若用的是 `sweetalert2.all.min.js` 已內含，可省略）② `payment_request.css` |
| JavaScript（手機） | ① SweetAlert2 ② `dist/payment_request_mobile.js` |
| CSS（手機） | ① SweetAlert2 的 CSS（同上）② `payment_request.css`（和 PC 同一個檔） |

- ⑦⑧ 要排在 ⑥ 後面：這兩支用到 bundle 裡的 `window.PR_CONFIG`。
- PDFLib／fontkit／JSZip／SheetJS 只有列表頁批次下載、PDF、SAP 轉檔用，手機版沒有這些功能，不用上傳。
- 換版時把舊的 `payment_request_bundle.min.js`、`payment_request_desktop.css`／`payment_request_mobile.css` 從後台刪掉（舊 bundle 和新的同時存在會重複註冊事件）。

### 手機版有／沒有的功能
- **有**：說明文字、欄位鎖定、申請人部門／費用所屬人部門帶入、簽核人員與會計單位（含部長的單位部長帶入）、交通費明細規則、存檔驗證（費用歸屬、發票重複、掛帳單位限部內、手動簽核）、
  預計付款日、受款人「同申請人」、建單後自動推進流程、作廢確認、「儲存中」提示。
- **沒有**（桌面版專用，見 `src/mobile.js` 開頭）：帳號權限設定（欄位顯示／可編輯／必填規則）、列表頁批次下載／PDF／SAP 轉檔、列印頁、附件預覽、費用歸屬中文名稱提示、欄寬調整。

### 其他
1. **載入順序的單一事實來源是 [`src/index.js`](src/index.js)**（手機版 [`src/mobile.js`](src/mobile.js) 是它的子集，順序一致）。打包後已把順序固化，上傳打包好的檔即可；不打包的兩支照上表排在 bundle 後面。
2. 模組一律寫桌面版的事件名稱，透過 `window.PR_KT`（`payment_request_config.js`）註冊與取用 kintone API；手機版打包時自動換成 `mobile.*` 事件與 `kintone.mobile.app.record`。
3. `APPS.PAYMENT` 用 `PR_KT.app().getId()` 動態取得，同一份檔可上傳到測試區或正式區。
