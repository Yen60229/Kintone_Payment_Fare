# 發票登記 plug-in（發票號碼重複檢查）

存檔時把發票號碼登記到發票登記 App（`invoice_number` 值不可重複），已被其他單據登記的號碼擋下。
兩張單同時存同一張發票，kintone 只會讓一筆登記成功，另一張一定被擋。

**判斷重複只看發票登記 App**：請款單有記錄權限，一般人看不到別人的單，用使用者身分去查請款 App 查不準。
登記 App 只放發票號碼、App ID、記錄編號，所有人都看得到。多個請款 App 共用同一個登記 App，各自裝這個 plug-in 即可。

## 前提
- 每個請款 App 都有「發票號碼記錄」欄位，由 App 自己的變更事件寫成「 / A / B / 」。
- 發票登記 App（測試區 757「SYS-06-7_發票登記管理(Log)」）欄位：

| 欄位代碼 | 類型 | 設定 |
|---|---|---|
| `invoice_number` | 文字 | 必填、**值不可重複** |
| `app_id` | 數值 | 登記的請款 App |
| `request_record_number` | 文字 | 該 App 的記錄編號；新增的單存檔成功前是空白 |
| `storage_key` | 文字 | 儲存鍵（每次開畫面換一個，認得是自己的登記；補登記的是 `backfill`） |
| `建立時間` | 建立時間 | 判斷「剛登記」 |
| `建立人` | 建立人 | 判斷「自己沒存成的登記」 |
| `original_invoice_number` | 文字 | 作廢後搬到這裡的原發票號碼（可重複，查歷史用） |
| `voided` | 下拉（是） | 作廢＝是 |
| `void_reason` | 下拉 | 單據作廢／改號或刪列／舊登記清除／單據刪除 |

- 權限：所有填單人對發票登記 App 要能**新增、編輯、檢視**（登記不刪除，不需要刪除權限）。不需要看得到其他請款單。

## 使用者看到的訊息
不說是哪個 App、哪張單（管理單位用登記 App 自己查）：
- 「發票號碼已使用過：A、B　※ 請確認後更換；有其他問題請洽管理單位詢問」
- 「發票號碼剛被其他單據登記，請再按一次儲存」（同時存檔被搶先）
- 「目前無法檢查發票號碼，請稍後再按一次儲存」（讀不到登記 App）

## 流程
App 自己的 JS 先跑、plug-in 後跑（已實測）。
1. **存檔**：`event.error` 已有值（App 自己的檢查擋下）或本單作廢 → 什麼都不做。否則查登記 App：
   - 沒登記、或是本單的（App＋記錄編號；新單用儲存鍵認）→ 登記。
   - 別張單的（不論 App、不論剛登記多久）→ 擋下「已使用過」。
   - 例外，作廢後換本單：自己建的、沒有記錄編號、超過設定分鐘數的登記（自己之前沒存成的單留下的，舊登記清除）；
     管理單位已把作廢改成「是」但號碼還沒換的（補換號碼，保留管理單位寫的原因）。
   - 新增時 kintone 回值重複、或作廢時版本號不符（被搶先）→ 擋下，請再按一次儲存。
2. **存檔成功**：新單回填記錄編號；本單不再用的號碼作廢（改號或刪列）；單據作廢＝本單登記全部作廢（單據作廢）。
   失敗會重試 2 次；仍失敗就記在瀏覽器（localStorage），下次打開新增／編輯／詳細頁再補回填。不影響存檔。
3. **刪除單據**（詳細頁、一覽表的刪除、手機詳細頁）：本單登記全部作廢（單據刪除）。失敗不擋刪除，只記在 console。
4. **詳細頁**：單據已作廢（例如用流程按鈕作廢）但還有登記 → 作廢（單據作廢）。沒作廢不打 API。

**登記不刪除、只作廢（留作紀錄）**：`invoice_number` 改成 `VOID-<登記記錄編號>`（值不可重複，號碼才釋放得出來），
原號碼搬到 `original_invoice_number`，`voided`＝是、`void_reason` 記原因；更新人／更新時間記下是誰、何時。
查某張發票的歷史：用 `original_invoice_number` 或 `invoice_number` 搜尋。

## 管理單位處理
- **使用者說號碼被擋但沒有重複**：在登記 App 搜尋該號碼，看 `app_id`＋`request_record_number` 是哪張單。
  確定那筆登記不該存在 → 把「作廢」改成「是」（原因可選），下次有人存這個號碼時程式會自動把號碼換成 `VOID-`。
- **沒有記錄編號的登記**：多半是存檔中斷留下的。同一個人超過設定分鐘數後再存會自動清掉；別人要用就請管理單位作廢。
- **一覽表「全部刪除」**不會觸發事件，登記不會作廢，請避免；要用的話，刪完再到登記 App 作廢那些登記。
- **REST API／CSV 匯入**不會經過 plug-in，匯入後請再跑一次補登記腳本。

## 舊單補登記（上線前跑一次）
上線前已存在的單沒有登記，plug-in 查不到。用 `scripts/backfill.cjs`（API token，不受記錄權限限制）：
```powershell
$env:KINTONE_BASE_URL = "https://xxx.cybozu.com"
$env:KINTONE_API_TOKEN = "<請款App token>,<登記App token>"   # 請款 App：記錄檢視；登記 App：記錄檢視＋新增
node scripts/backfill.cjs --app 749 --registry 757 --field 發票號碼記錄 --status-field 狀態 --void-status 表單作廢 --void-check 表單作廢
```
- 不加 `--apply` 只產生報表 `out/backfill_<App>_<時間>.csv`、不寫入；確認後同一行加 `--apply` 才登記。
- 同號碼只登記給記錄編號最小的那張；同 App 多張單用同一號碼、或已登記給別張單 → 列為「衝突」，請人工確認。
- 每個請款 App 各跑一次；重跑安全（已登記的略過）。token 只放環境變數，不要寫進檔案。

## 設定頁
| 項目 | 例（749） |
|---|---|
| 發票登記 App ID | 757 |
| 自己沒存成的登記，幾分鐘後可重用 | 10 |
| 本 App：發票號碼記錄欄位 | 發票號碼記錄 |
| 本 App：作廢判斷 | 狀態欄位＝狀態、作廢的狀態值＝表單作廢；核取方塊＝表單作廢 |

同一個 App 裝了多個 plug-in 時，把這個排在最後。

## 開發
```bash
npm install          # 第一次（安裝 @kintone/plugin-packer）
npm test             # 測試（749 專案的 npm test 也會跑）
npm run pack         # 打包 → dist/invoice-registry-plugin.zip
```
- `private.ppk` 是私鑰，決定 plug-in ID（`fkecnfdbagkngeehcgcgpnphceephfbp`）。**不進 git，請另外備份**；弄丟只能當新的 plug-in 重裝、重新設定。
- 改版時把 `src/manifest.json` 的 `version` 加一，再打包、到 kintone 系統管理 → plug-in 更新。
- 結構：`src/js/core.js`（核心邏輯，不碰畫面）、`src/js/desktop.js`（PC／手機事件）、`src/js/config.js`＋`src/html/config.html`＋`src/css/config.css`（設定頁）、`src/image/icon.png`、`scripts/backfill.cjs`（舊單補登記）。
