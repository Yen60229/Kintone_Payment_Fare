'use strict';

// 測試共用：在 vm 沙箱（或本程序的全域）執行 ES module 原始檔（import／export）。
//   esbuild 把「單一檔」轉成 CommonJS（不打包）；檔裡相對路徑的 import 由本檔的 require 載入，
//   同一個沙箱裡每支檔只執行一次、共用同一份模組狀態（和 Vite 打包後一樣）。
//   模組只定義函式；要註冊事件得另外呼叫它 export 的 install()（入口檔的 import '…?install' 也是這樣做）。
//   傳統 script（IIFE、不 import／export）不經過這裡，照舊 vm.runInContext。
//
//   const load = createModuleLoader(sandbox);   // sandbox＝vm.createContext 過的物件；null＝本程序全域
//   const M = load('使用者主檔快取.js');          // 回傳 exports
//   M.install?.();

const path = require('path');
const fs = require('fs');
const vm = require('vm');
// Vite 的相依套件（npm 會裝在最外層 node_modules），不另外列在 package.json
const esbuild = require('esbuild');

const rootDir = path.join(__dirname, '..', '..');

/** 原始碼是不是 ES module（行首有 import／export；import( 動態載入不算） */
const isEsm = (src) => /^[ \t]*(?:import[ \t]*['"{*\w]|export[ \t])/m.test(src);

/** 專案內路徑一律用「相對 rootDir、正斜線」當快取鍵 */
const normalize = (file) => path.posix.normalize(String(file).replace(/\\/g, '/').replace(/\?install$/, ''));

const resolveSpec = (from, spec) => {
  if (!spec.startsWith('.')) throw new Error(`${from}：測試載入器只支援相對路徑的 import（${spec}）`);
  return path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
};

const compile = (file) =>
  esbuild.transformSync(fs.readFileSync(path.join(rootDir, file), 'utf8'), {
    format: 'cjs',
    loader: 'js',
    target: 'es2022',
    sourcefile: file,
  }).code;

/**
 * @param {Object|null} context vm.createContext 過的沙箱；null＝本程序的全域（vm.runInThisContext）
 * @returns {(file: string) => Object} 載入專案根目錄相對路徑的一支 ES module，回傳 exports
 */
const createModuleLoader = (context) => {
  const cache = new Map();
  const run = (code, filename) => (context ? vm.runInContext(code, context, { filename }) : vm.runInThisContext(code, { filename }));
  const load = (file) => {
    const key = normalize(file);
    if (cache.has(key)) return cache.get(key).exports;
    const module = { exports: {} };
    cache.set(key, module);
    const fn = run(`(function (exports, require, module) {${compile(key)}\n})`, key);
    fn(module.exports, (spec) => load(resolveSpec(key, spec)), module);
    return module.exports;
  };
  return load;
};

const loaders = new WeakMap();
let globalLoader = null;
/**
 * 載入一支 ES module 並呼叫 install()（和入口檔的 import '…?install' 一樣），回傳 exports。
 * 同一個沙箱（或本程序全域）共用同一份模組快取。
 * @param {Object|null} context vm.createContext 過的沙箱；null＝本程序全域（測試用 global.window／global.kintone 的）
 * @param {string} file 專案根目錄相對路徑
 * @param {{ install?: boolean }} [opts] install: false 只載入不註冊
 */
const loadInto = (context, file, { install = true } = {}) => {
  let load;
  if (context) {
    if (!loaders.has(context)) loaders.set(context, createModuleLoader(context));
    load = loaders.get(context);
  } else {
    globalLoader = globalLoader || createModuleLoader(null);
    load = globalLoader;
  }
  const exports = load(file);
  if (install && typeof exports.install === 'function') exports.install();
  return exports;
};

module.exports = { createModuleLoader, loadInto, isEsm, normalize };
