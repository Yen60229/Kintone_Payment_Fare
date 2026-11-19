// =========================================================================
// kintone 交通費請款單 手機版入口檔 (src/mobile.js)
// 輸出
//   dist/payment_request_mobile.js   → kintone「JavaScript 自訂（手機）」
// 樣式不經過打包：專案最外層的 payment_request.css 直接上傳到「CSS 自訂（手機）」（和 PC 同一個檔）。
//
// 模組是桌面版入口（src/index.js）的子集，順序必須和桌面版一致（tests/build_targets.test.cjs 會檢查）。
// 只收新增／編輯／詳細畫面的表單行為；以下桌面版專用，手機版不載入：
//   帳號權限設定（靠桌面版 DOM 調整欄位，模組本身也註明不套用手機版）、
//   檔案批次（列表頁批次下載／PDF）、批次整理資料（列表頁 SAP 轉檔）、
//   print.show（列印頁）、請款單作廢_style／file_reader／轉至其他會計單位按鈕（桌面版 DOM）、
//   詳細頁欄位寬度自動（桌面版 DOM）、coding_tools（列表頁管理員按鈕）
// =========================================================================

// ⓪ 標記手機版（必須在 config 之前）────────────────────────────────────────
import './mobile_target.js';

// ① Config 常數檔 ────────────────────────────────────────────────────────
import '../payment_request_config.js';

// 「儲存中，請稍候…」提示：排在所有有存檔程式的模組前面（理由同桌面版）
import '../存檔等待提示.js?install';

// ② 表單行為 ────────────────────────────────────────────────────────────
import '../payment_request_main.js?install';
import '../公司卡付款來源.js?install';
import '../payment_request_submit.js';
import '../費用歸屬部門限制.js?install';
import '../signing_personnel_manager.js';
import '../部長上一階主管.js?install';
import '../使用者主檔快取.js?install';
import '../手動簽核人設定.js';
import '../申請人部門帶入.js?install';
import '../交通費明細規則.js?install';
import '../預計付款日.js?install';
import '../受款人填寫設定.js?install';
import '../流程自動推進.js?install';
import '../作廢防呆.js?install';
import '../發票號碼寫入獨立欄位檢查.js?install';
import '../開發人員用群組欄位.js?install';
