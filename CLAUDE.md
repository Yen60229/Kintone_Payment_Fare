# 專案規範與模型分工
- 複雜重構與架構決策：請交由 Fable 5 在 Plan 階段進行反覆論證與邊界檢查。
- 代碼實作與寫檔：交由 Sonnet 執行，務必加上對應的測試單元。

## 每次改動後必跑
```bash
npm test && bash tests/syntax.test.sh && npm run scan
```
目前基準：**25 支測試／397 項斷言**、語法檢查 **24 檔**、硬編碼掃描 **11 處**。
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

## kintone 環境
開發與驗證都在**測試區 App 749**（交通費請款單）。正式區 App 尚未建立。
`APPS.PAYMENT` 用 `kintone.app.getId()` 動態取得。改欄位前先用 kintone MCP 查 749 的欄位（`kintone-get-form-fields`），再改 config 的 `FIELDS`。

## 建置
`src/index.js` 是**載入順序的單一事實來源**；`npm run build` 產出 `dist/payment_request_bundle.min.js`。
新模組要上線才加進 `src/index.js`。
