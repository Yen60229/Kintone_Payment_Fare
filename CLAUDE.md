# 專案規範與模型分工
- 複雜重構與架構決策：請交由 Fable 5 在 Plan 階段進行反覆論證與邊界檢查。
- 代碼實作與寫檔：交由 Sonnet 執行，務必加上對應的測試單元。

## 每次改動後必跑
```bash
npm test && bash tests/syntax.test.sh && npm run scan
```
目前基準：**27 支測試／445 項斷言**、語法檢查 **24 檔**、硬編碼掃描 **11 處**。
掃描數字若無故上升，多半是**註解裡寫了 App ID 數字**（規則 1 刻意連註解一起掃）——
註解請改引用常數名（如 `APPS.APPROVAL_FLOW`），不要寫 App 的數字。
新增測試檔要同時加進 `package.json` 的 `test` 腳本。
從 kintone 下載新版流程管理設定後，放進 `process_management/exports/`（檔名 `749_rev<revision>.json`），
跑 `npm run check:process` 檢查（結構＋全部假資料走一遍＋每個狀態的按鈕）。

## 文件職責（改動後要同步的地方）
| 文件 | 角色 | 何時更新 |
|---|---|---|
| `README.md` | 入口、部署、測試指令 | 模組增減、部署方式或指令變動 |
| [`docs/749_現況與待決事項.md`](docs/749_現況與待決事項.md) | **唯一現況、設計拍板與待辦來源** | 每次程式改動；拍板或完成待辦時更新 |
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
`coding_tools.js`、`SetFieldWidth_4_20251206.js`（只有 PC，排在 bundle 後面）——不要把它們加回 `src/index.js`。
新模組要上線才加進 `src/index.js`，並決定要不要進手機版：進就加進 `src/mobile.js`，不進就加進
`tests/build_targets.test.cjs` 的 `DESKTOP_ONLY`。
- 事件與畫面 API 一律走 `window.PR_KT`（`KT.on`、`KT.record()`、`KT.app()`），寫桌面版事件名稱即可，手機版自動轉換；
  不要直接寫 `kintone.events.on`／`kintone.app.*`。
- 樣式只寫在 `payment_request.css`，JS 只加 `pr-` 開頭的 class；不要在 JS 注入 `<style>` 或寫 `cssText`／HTML `style` 屬性，
  也不要另開第二個 CSS 檔。
