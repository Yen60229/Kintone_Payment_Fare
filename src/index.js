// =========================================================================
// kintone 交通費請款單 桌面版入口檔 (src/index.js)
// 打包工具 Vite 會從此檔開始，依序讀入所有模組，輸出
//   dist/payment_request_desktop.js   → kintone「JavaScript 自訂（PC）」
//   dist/payment_request_desktop.css  → kintone「CSS 自訂（PC）」
// 手機版入口是 src/mobile.js（模組是本檔的子集，順序必須一致）。
//
// 依賴順序說明：
//   ①  Config 常數檔必須排最前（其他模組在執行時會存取 window.PR_CONFIG、window.PR_KT）
//   ②  依賴 Config 的模組
//   ③  無 Config 依賴的獨立工具檔，順序不影響
//   ④  樣式（打包成獨立的 CSS 檔，不會塞進 JS）
// =========================================================================

// ① Config 常數檔（必須排最前）────────────────────────────────────────────
import '../payment_request_config.js';

// 「儲存中，請稍候…」提示：必須排在所有有存檔程式的模組前面，按下儲存時才會第一個執行；
// 它自己會把「擋下時關掉提示」的程式延後註冊，排到所有存檔程式的最後面。
import '../存檔等待提示_20260923.js';

// ② 依賴 Config 的模組（帳號權限設定排最前）────────────────────────────────
import '../帳號權限設定_20260722.js';
import '../payment_request_main_20260521.js';
import '../payment_request_submit_20260506.js';
import '../費用歸屬部門限制_20261022.js';
import '../signing_personnel_manager_20260506.js';
// 申請人部門依申請人帶入：用簽核人員程式提供的 PR_ORG_PICKER，排在它後面
import '../申請人部門帶入_20261022.js';
import '../交通費明細規則_20261022.js';
import '../預計付款日_20261020.js';
import '../檔案批次_6版_PDFLib向量版_20260716.js';
import '../批次整理資料.js';
import '../受款人填寫設定_20250902.js';
import '../流程自動推進_20260810.js';
import '../作廢防呆_20260506.js';
import '../print.show顯示單據編號_請款單據編號.js';
import '../發票號碼寫入獨立欄位檢查.js';
import '../coding_tools.js';
import '../開發人員用群組欄位.js';
import '../請款單作廢_style_20260506.js';
import '../SetFieldWidth_4_20251206.js';

// ③ 無 Config 依賴的獨立工具檔（順序不影響）──────────────────────────────
import '../file_reader.js';
import '../轉至其他會計單位按鈕處理_20250723.js';

// ④ 樣式（共用＋桌面版專用）─────────────────────────────────────────────
import '../styles/common.css';
import '../styles/desktop.css';
