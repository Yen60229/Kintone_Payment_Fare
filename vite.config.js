import { defineConfig } from 'vite';

// 一次打包兩套（package.json 的 build：先 desktop 再 mobile）：
//   vite build --mode desktop → dist/payment_request_desktop.js（入口 src/index.js）
//   vite build --mode mobile  → dist/payment_request_mobile.js （入口 src/mobile.js）
// 只打包 JS。樣式（payment_request.css）放在專案最外層，
// 不經過打包、直接上傳（見 README 的上傳清單）。
const TARGETS = {
  desktop: { input: 'src/index.js', name: 'payment_request_desktop' },
  mobile: { input: 'src/mobile.js', name: 'payment_request_mobile' },
};

// 入口檔的 import '../模組.js?install'：先執行模組本身（只定義函式、不碰畫面），再呼叫它 export 的 install()（註冊事件）。
//   事件註冊順序＝入口檔的排列順序，不受模組之間互相 import 影響
//   （被別的模組 import 的檔會提早執行，但它的 install() 仍等輪到它那一行才呼叫）。
//   模組沒有 export install 的話，打包直接報錯。
const INSTALL_QUERY = '?install';
const INSTALL_PREFIX = '\0pr-install:';
const installEntries = () => ({
  name: 'pr-install-entries',
  enforce: 'pre',
  async resolveId(source, importer) {
    if (!source.endsWith(INSTALL_QUERY)) return null;
    const resolved = await this.resolve(source.slice(0, -INSTALL_QUERY.length), importer, { skipSelf: true });
    return resolved ? INSTALL_PREFIX + resolved.id : null;
  },
  load(id) {
    if (!id.startsWith(INSTALL_PREFIX)) return null;
    return `import { install } from ${JSON.stringify(id.slice(INSTALL_PREFIX.length))};\ninstall();\n`;
  },
});

export default defineConfig(({ mode }) => {
  const target = TARGETS[mode];
  if (!target) throw new Error(`未知的打包目標「${mode}」，請用 --mode desktop 或 --mode mobile（npm run build 會兩個都打）`);
  return {
    plugins: [installEntries()],
    build: {
      outDir: 'dist',
      // 先打的桌面版負責清空 dist，手機版接著輸出到同一個資料夾
      emptyOutDir: mode === 'desktop',
      // target: 'esnext' → 不降級轉譯語法。若不設定，Vite 預設會把程式碼裡的 ?.（optional chaining）
      // 轉成 var _a 暫存變數的舊寫法（怕舊瀏覽器不支援），但 kintone 客製化 JS 只會在現代瀏覽器執行，
      // 用不到這層相容性，故關閉，順便讓打包後的程式碼跟原始碼一樣全是 const/let，沒有 var。
      target: 'esnext',
      // 開啟 Source Map：讓瀏覽器報錯時，能精準指引到原本的 .js 檔案與正確行號（.map 不用上傳 kintone）
      sourcemap: true,
      rollupOptions: {
        input: target.input,
        output: {
          entryFileNames: `${target.name}.js`,
          format: 'iife',
        },
      },
      // 壓縮（terser）：上傳檔變小；報錯時靠上面的 Source Map 對回原始碼。
      // 要在 kintone 上直接看未壓縮的程式碼除錯：npm run build:debug（CLI 的 --minify false 蓋過這裡）
      minify: 'terser',
    },
  };
});
