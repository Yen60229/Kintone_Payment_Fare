// =========================================================================
// kintone 交通費請款單 桌面版入口檔 (src/index.js)
// 打包工具 Vite 會從此檔開始，依序讀入所有模組，輸出
//   dist/payment_request_desktop.js   → kintone「JavaScript 自訂（PC）」
// 手機版入口是 src/mobile.js（模組是本檔的子集，順序必須一致）。
//
// 不經過打包、放在專案最外層直接上傳的檔（上傳清單見 README）：
//   payment_request.css            全部樣式（PC、手機都上傳同一個檔）
//   coding_tools.js                列表頁「JS 自定義設定」「流程管理」按鈕（排在 bundle 後面）
//
// 兩種寫法（ES module 遷移中，逐支改）：
//   import '../x.js';          傳統 script（IIFE），載入時就註冊事件、掛 window.PR_*
//   import '../x.js?install';  ES module：載入時只定義函式，輪到這一行才呼叫它的 install() 註冊事件
//                              （vite.config.js 的 installEntries；註冊順序＝本檔排列順序，不受模組互相 import 影響）
//
// 依賴順序說明：
//   ①  Config 常數檔必須排最前（其他模組在執行時會存取 window.PR_CONFIG、window.PR_KT）
//   ②  依賴 Config 的模組
//   ③  無 Config 依賴的獨立工具檔，順序不影響
// =========================================================================

// ① Config 常數檔（必須排最前）────────────────────────────────────────────
import '../payment_request_config.js';

// 「儲存中，請稍候…」提示：必須排在所有有存檔程式的模組前面，按下儲存時才會第一個執行；
// 它自己會把「擋下時關掉提示」的程式延後註冊，排到所有存檔程式的最後面。
import '../存檔等待提示.js?install';

// ② 依賴 Config 的模組（帳號權限設定排最前）────────────────────────────────
import '../帳號權限設定.js?install';
import '../payment_request_main.js?install';
// 公司卡支付／受款人明細：存檔錯誤交給 PR_SAVE_ERRORS，要排在 submit 前面才會併進同一個錯誤視窗
import '../公司卡付款來源.js?install';
import '../payment_request_submit.js?install';
import '../費用歸屬部門限制.js?install';
import '../signing_personnel_manager.js?install';
// 費用所屬人是對照表裡的部長：上一階主管群組帶進單位主管3（C.DIRECTOR_UPLINE），由 submit 與簽核人員程式呼叫
import '../部長上一階主管.js';
// 使用者主檔快取（/v1/users.json 同一頁面只抓一次；手動簽核人與受款人 import 它，只提供函式）
import '../使用者主檔快取.js';
import '../手動簽核人設定.js?install';
// 申請人部門依申請人帶入：用簽核人員程式提供的 PR_ORG_PICKER，排在它後面
import '../申請人部門帶入.js?install';
import '../交通費明細規則.js?install';
import '../預計付款日.js?install';
import '../檔案批次.js?install';
import '../批次整理資料.js?install';
// 列表頁「🗂 批次動作 ▾」的批次填傳票／入帳完成；只有桌面版
import '../批次填傳票_入帳完成.js';
import '../受款人填寫設定.js?install';
import '../流程自動推進.js?install';
import '../作廢防呆.js?install';
import '../print.show顯示單據編號_請款單據編號.js?install';
import '../發票號碼寫入獨立欄位檢查.js?install';
import '../開發人員用群組欄位.js?install';
import '../表頭查詢連結.js?install';
// 欄位標籤結尾的括號說明收進「?」（2026-11-16 起請款單也用；同一支也單獨上傳到規則主檔）；只有桌面版
import '../欄位標籤說明圖示.js';
// 詳細頁主表欄位外框寬度改 auto（取代 SetFieldWidth）；只有桌面版
import '../詳細頁欄位寬度自動.js?install';
import '../請款單作廢_style.js?install';
// 列表頁「JS 自定義設定」「流程管理」按鈕（2026-11-12 起打包；排在檔案批次後面，要找它的下載按鈕）
import '../coding_tools.js?install';

// ③ 無 Config 依賴的獨立工具檔（順序不影響）──────────────────────────────
import '../file_reader.js?install';
import '../轉至其他會計單位按鈕處理.js?install';
