import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    // target: 'esnext' → 不降級轉譯語法。若不設定，Vite 預設會把程式碼裡的 ?.（optional chaining）
    // 轉成 var _a 暫存變數的舊寫法（怕舊瀏覽器不支援），但 kintone 客製化 JS 只會在現代瀏覽器執行，
    // 用不到這層相容性，故關閉，順便讓打包後的程式碼跟原始碼一樣全是 const/let，沒有 var。
    target: 'esnext',
    emptyOutDir: true,
    cssCodeSplit: false,
    // 1. 開啟 Source Map：讓瀏覽器報錯時，能精準指引到原本的 .js 檔案與正確行號！
    sourcemap: true,
    rollupOptions: {
      input: 'src/index.js',
      output: {
        entryFileNames: 'payment_request_bundle.min.js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith('.css')) {
            return 'payment_request_bundle.min.css';
          }
          return assetInfo.name || 'asset';
        },
        format: 'iife',
      },
    },
    // 2. 若在開發/測試除錯階段，可將 minify 設為 false (不壓縮一成一行)，保持漂亮換行排版！
    // 待正式上線穩定後再改回 'terser' 即可。
    minify: false,
  },
});
