import { defineConfig } from 'vite';

// 一次打包兩套（package.json 的 build：先 desktop 再 mobile）：
//   vite build --mode desktop → dist/payment_request_desktop.js ＋ .css（入口 src/index.js）
//   vite build --mode mobile  → dist/payment_request_mobile.js  ＋ .css（入口 src/mobile.js）
// JS 與 CSS 分開輸出：模組裡 import 的 styles/*.css 會抽成獨立的 CSS 檔，不會塞進 JS。
const TARGETS = {
  desktop: { input: 'src/index.js', name: 'payment_request_desktop' },
  mobile: { input: 'src/mobile.js', name: 'payment_request_mobile' },
};

export default defineConfig(({ mode }) => {
  const target = TARGETS[mode];
  if (!target) throw new Error(`未知的打包目標「${mode}」，請用 --mode desktop 或 --mode mobile（npm run build 會兩個都打）`);
  return {
    build: {
      outDir: 'dist',
      // 先打的桌面版負責清空 dist，手機版接著輸出到同一個資料夾
      emptyOutDir: mode === 'desktop',
      // target: 'esnext' → 不降級轉譯語法。若不設定，Vite 預設會把程式碼裡的 ?.（optional chaining）
      // 轉成 var _a 暫存變數的舊寫法（怕舊瀏覽器不支援），但 kintone 客製化 JS 只會在現代瀏覽器執行，
      // 用不到這層相容性，故關閉，順便讓打包後的程式碼跟原始碼一樣全是 const/let，沒有 var。
      target: 'esnext',
      cssCodeSplit: false,
      // 開啟 Source Map：讓瀏覽器報錯時，能精準指引到原本的 .js 檔案與正確行號（.map 不用上傳 kintone）
      sourcemap: true,
      rollupOptions: {
        input: target.input,
        output: {
          entryFileNames: `${target.name}.js`,
          assetFileNames: (assetInfo) => {
            if (assetInfo.name && assetInfo.name.endsWith('.css')) return `${target.name}.css`;
            return assetInfo.name || 'asset';
          },
          format: 'iife',
        },
      },
      // 開發／測試除錯階段不壓縮，保持原本排版；正式上線穩定後可改回 'terser'
      minify: false,
    },
  };
});
