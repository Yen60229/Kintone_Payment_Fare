// ESLint 設定（flat config）：只抓「會出錯」的問題，不管排版風格。
// 跑法：npm run lint（不在 npm test 裡）。不要用 --fix 大量改原始檔。
import js from '@eslint/js';
import globals from 'globals';

// kintone 自訂 JS 上傳後執行環境裡的全域（kintone 本身＋另外上傳的 CDN 函式庫）
const kintoneGlobals = {
  kintone: 'readonly',
  cybozu: 'readonly',
  garoon: 'readonly',
  Swal: 'readonly', // SweetAlert2
  PDFLib: 'readonly', // pdf-lib
  fontkit: 'readonly', // @pdf-lib/fontkit
  JSZip: 'readonly',
  XLSX: 'readonly', // SheetJS
  saveAs: 'readonly', // FileSaver
  jsPDF: 'readonly',
  html2canvas: 'readonly',
};

// 直接上傳原始檔到 kintone（不經打包）的檔：維持傳統 script（tests/build_targets 的 RAW_UPLOAD 同一份名單）
const RAW_UPLOAD = ['payment_request_config.js', '欄位標籤說明圖示.js', '交通費明細規則主檔檢查.js'];

const bugRules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
  // 下列是 recommended 裡偏風格、不是 bug 的規則，降為警告
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-useless-escape': 'warn',
  'no-prototype-builtins': 'off',
  'no-regex-spaces': 'off', // 測試裡用 regex 比對原始碼縮排，故意寫多個空白
  'no-control-regex': 'warn', // 清檔名等處故意比對控制字元
  'no-irregular-whitespace': ['error', { skipComments: true, skipStrings: true, skipTemplates: true, skipRegExps: true }],
  'no-useless-assignment': 'warn', // 寫了沒用到的值：可能是漏用，逐一看
  'preserve-caught-error': 'off', // ESLint 10 新增的風格規則
};

export default [
  // 原始檔裡已有一些 eslint-disable 註解（no-eval、no-await-in-loop 等，本設定沒開），不要報「多餘的 disable」
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  {
    ignores: [
      'dist/**',
      '**/node_modules/**',
      'plugins/*/dist/**',
      '.claude/**',
      'process_management/exports/**',
      'form_snapshots/**',
    ],
  },
  // 打包進 bundle 的模組（ES module；還沒遷移的 IIFE 檔用 module 解析也沒問題）
  {
    files: ['*.js'],
    ignores: ['vite.config.js', ...RAW_UPLOAD],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...kintoneGlobals },
    },
    rules: bugRules,
  },
  // 直接上傳原始檔、不經打包的檔（傳統 script，每支自己包 IIFE；不能 import／export）
  {
    files: [...RAW_UPLOAD, 'plugins/*/src/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, ...kintoneGlobals },
    },
    rules: bugRules,
  },
  // Vite 打包入口（ES module，import 根目錄的原始檔）
  {
    files: ['src/**/*.js', 'eslint.config.mjs', 'vite.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node, ...kintoneGlobals },
    },
    rules: bugRules,
  },
  // Node 端：測試、檢查工具、打包腳本
  {
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: bugRules,
  },
];
