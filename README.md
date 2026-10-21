# 交通費請款單（kintone App 749）

kintone **交通費請款單（測試區 App 749）** 的自訂 JavaScript 原始碼。
本專案由「請款單 App 723」的 repo 複製而來，已刪除 723 其他類型（請購、庶務、出差、交際費、一般、集團公司、船公司）與分攤表的程式，
並改接 749 的欄位代碼。現況、已拍板的設計與待決事項見 [`docs/749_現況與待決事項.md`](docs/749_現況與待決事項.md)。

---

## 這個 App 在做什麼

員工填寫交通費明細（子表格「交通費請款單」），程式依 **費用所屬人／費用所屬人部門** 自動帶入簽核人員與會計單位，
存檔時檢查費用歸屬代碼與發票號碼重複，並計算預計付款日；列表頁可批次下載附件、批次列印 PDF、轉出 SAP 檔。

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
- `npm test`：21 支測試（共 317 項斷言）。
- `bash tests/syntax.test.sh`：對根目錄所有 `*.js` 跑 `node --check`（目前 21 檔）。
- `npm run scan`：統計剩餘的 App ID／狀態／選項／欄位代碼硬編碼（目前 11 處）。

### 檢查流程管理設定
```bash
npm run check:process
```
- 沒給參數時，檢查 `process_management/exports/` 裡 revision 最大的 `749_rev*.json`。
- 會跑三項：結構檢查、把所有合法假資料從「報銷人填單」走到會計、每個狀態的按鈕。
- 從 kintone 下載新版流程設定後，放進 `process_management/exports/` 再跑一次。
- 目前 749 rev 1791 本身有已知問題，所以會回傳結束代碼 1（見 docs 待決事項）。

### 打包
```bash
npm run build
```
- Vite 從 `src/index.js` 依序讀入所有模組，輸出 `dist/payment_request_bundle.min.js`（＋ `.map`）。

---

## 部署注意事項（kintone 後台）

1. **載入順序的單一事實來源是 [`src/index.js`](src/index.js)**。打包後的 bundle 已把順序固化，上傳單一 bundle 即可。
   若改成後台逐檔上傳，務必照 `src/index.js` 的順序排，而且 `payment_request_config.js` 一定排第一。
2. bundle 依賴 SweetAlert2（`Swal`）；PDF 依賴 PDFLib 與 fontkit，ZIP 依賴 JSZip，SAP 轉檔依賴 SheetJS（`XLSX`）。這些外部函式庫要在 kintone 後台先載入。
3. `APPS.PAYMENT` 用 `kintone.app.getId()` 動態取得，同一份 bundle 可上傳到測試區或正式區。
