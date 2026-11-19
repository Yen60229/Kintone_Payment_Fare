# 快速執行原則（每次需求都先照這裡做）
目標：使用者提需求 → 直接動手改 → 跑一次檢查 → 短回覆。不要多繞路。

1. **直接做，不先問**：需求有模糊處就選最合理的做法，在回覆裡用一句話說明假設；只有會改到簽核／權限／存檔邏輯且有兩種以上合理做法時才問。
2. **不開代理人、不進 Plan 模式**：一律主對話自己改。只有使用者明說「開代理人」「先規劃」才用。
3. **精準讀檔**：先用 Grep 找到函式／class 位置，只讀需要的區段；不要整個讀大檔，改完不要重讀確認。
4. **不查 kintone MCP**：欄位代碼一律先看 `payment_request_config.js` 的 `FIELDS`；config 裡沒有的欄位、或使用者說 749 表單有改，才用 MCP 查。
5. **檢查只在最後跑一次**（見下表），不要每改一處就跑。失敗才修、修完再跑一次。
6. **建置只在使用者說「上傳」「build」「打包」時跑** `npm run build`。
7. **不 commit、不 push**，除非使用者要求。
8. **回覆精簡**：改了哪些檔（附連結）＋檢查結果，2～4 行即可；不要重述需求、不要貼大段程式碼。

## 改動分級
| 等級 | 範圍（例） | 驗證 | 文件 |
|---|---|---|---|
| 小 | 同一個函式內幾行：改 CSS、改文字、調條件、接續剛做完的功能 | 只跑 `npm test` | 不用更新 |
| 中 | 新增函式或事件、動到 2 個以上檔案 | 補對應測試，跑完整三道檢查 | 現況文件加一行 |
| 大 | 新模組、改載入順序、動簽核／權限／存檔流程 | 補測試，跑完整三道檢查 | 同步 docs/749_現況與待決事項.md |

- 拿不準大小時一律當**小**處理；測試失敗再升級。
- 使用者說「直接改」→ 當小改動處理。
- 使用者說「不用測試」→ 連 `npm test` 都省略，但要在回覆中說明沒驗證。
- 現況文件的數字只在中、大改動或測試數有變時更新。

## 改動後要跑的檢查
小改動只跑 `npm test`；中、大改動跑全部三道：
```bash
npm test && bash tests/syntax.test.sh && npm run scan
```
目前基準：**36 支測試／748 項斷言**、語法檢查 **31 檔**、硬編碼掃描 **12 處**。
掃描數字若無故上升，多半是**註解裡寫了 App ID 數字**（規則 1 刻意連註解一起掃）——
註解請改引用常數名（如 `APPS.APPROVAL_FLOW`），不要寫 App 的數字。
測試檔命名 `tests/*.test.cjs`（plug-in 為 `plugins/*/tests/*.test.cjs`），`scripts/run-tests.cjs` 會自動找到，不用改 `package.json`。
只跑部分：`npm test -- 關鍵字`（路徑含關鍵字的檔）；加 `--verbose` 印每支完整輸出。
`npm run lint`（ESLint，只抓 bug）不在 `npm test` 裡；中、大改動後順手跑一次，維持 0 錯誤 0 警告，不要用 `--fix`。
從 kintone 下載新版流程管理設定後，放進 `process_management/exports/`（檔名 `749_rev<revision>.json`），
跑 `npm run check:process` 檢查（結構＋全部假資料走一遍＋每個狀態的按鈕）。

## 文件職責（改動後要同步的地方）
| 文件 | 角色 | 何時更新 |
|---|---|---|
| `README.md` | 入口、部署、測試指令 | 模組增減、部署方式或指令變動 |
| [`docs/749_現況與待決事項.md`](docs/749_現況與待決事項.md) | **唯一現況、設計拍板與待辦來源** | 中、大改動；拍板或完成待辦時更新（小改動不用） |
| `payment_request_config.js` | 欄位代碼、App ID、狀態與選項值的單一事實來源 | 749 表單或流程管理變動時 |

子表格「交通費請款單」的欄位（順序、標籤、型別）改了 → 用 kintone MCP 重讀（`kintone-get-form-layout`＋`kintone-get-form-fields`），
更新 `form_snapshots/749_rev<revision>_traffic_table.json` 與 config 的 `TRAFFIC_TABLE_LAYOUT`（`config.test` 會比對兩者）。

## kintone 環境
開發與驗證都在**測試區 App 749**（交通費請款單）。正式區 App 尚未建立。
`APPS.PAYMENT` 用 `kintone.app.getId()` 動態取得。改欄位前先用 kintone MCP 查 749 的欄位（`kintone-get-form-fields`），再改 config 的 `FIELDS`。

## 建置
`src/index.js` 是**載入順序的單一事實來源**（桌面版）；`src/mobile.js` 是手機版，模組是它的子集、順序一致。
`npm run build` 只打包 JS：產出 `dist/payment_request_desktop.js` 與 `dist/payment_request_mobile.js`，上傳清單見 README。
**不打包、放專案最外層直接上傳**：`payment_request.css`（全部樣式只有這一個檔，PC／手機同一份）、
`交通費明細規則主檔檢查_20261104.js`（**上傳到 App 752 規則主檔**，前面只放 `payment_request_config.js` 原始檔；
讀請款單設定用 `APPS.TRAFFIC_PAYMENT`，不能用 `APPS.PAYMENT`）——不要把它們加回 `src/index.js`。
新模組要上線才加進 `src/index.js`，並決定要不要進手機版：進就加進 `src/mobile.js`，不進就加進
`tests/build_targets.test.cjs` 的 `DESKTOP_ONLY`。
- 事件與畫面 API 一律走 `window.PR_KT`（`KT.on`、`KT.record()`、`KT.app()`），寫桌面版事件名稱即可，手機版自動轉換；
  不要直接寫 `kintone.events.on`／`kintone.app.*`。
- 樣式只寫在 `payment_request.css`，JS 只加 `pr-` 開頭的 class；不要在 JS 注入 `<style>` 或寫 `cssText`／HTML `style` 屬性，
  也不要另開第二個 CSS 檔。
