'use strict';

// 測試共用：簽核人員（signing_personnel_manager.js）import 的其他模組，預設換成「沒載入時」的替身。
//   以前這些模組靠 window.PR_* 互相找，測試沒載入就等於不存在（程式用 ?. 略過）；
//   改成 import 後一定會載入，所以這裡給行為等同「不存在」的替身，測試中途要換就 deps.set／deps.reset。
//
//   const deps = stubSigningDeps(null);                         // 本程序全域（loadInto(null, …)）
//   const deps = stubSigningDeps(sandbox, { real: ['部長上一階主管.js'] });  // 這支用真的
//   deps.set('MANUAL_SIGNERS', { enter: … }); …; deps.reset('MANUAL_SIGNERS');
// 要在載入 signing_personnel_manager.js 之前呼叫。submit 的見 stubSubmitDeps。

const { stubInto, swappable } = require('./esm_loader.cjs');

/** 每支模組 → 簽核人員用到的 export 與「不存在」時的等價行為 */
const ABSENT = {
  'payment_request_main.js': { COMPANY_NAME: { apply() {} } },
  '費用歸屬部門限制.js': {
    // 沒載入時：不檢查排除群組（等同在群組內、不擋手動）
    COST_SCOPE: { applicantCodeOf: () => '', ensureExempt: () => Promise.resolve(true), isExempt: () => true, validate: () => Promise.resolve([]) },
  },
  '部長上一階主管.js': { DIRECTOR_UPLINE: { groupOf: () => null } },
  '手動簽核人設定.js': { MANUAL_SIGNERS: { signersOf: () => [], enter() {}, leave() {}, offerAccounting() {} } },
};

/**
 * @param {Object|null} context vm 沙箱；null＝本程序全域
 * @param {{ real?: string[] }} [opts] 這些檔用真的模組（不換替身）
 * @returns {{ set: Function, reset: Function }}
 */
const stubSigningDeps = (context, { real = [] } = {}) => {
  const files = Object.keys(ABSENT).filter((f) => !real.includes(f));
  const defaults = Object.assign({}, ...files.map((f) => ABSENT[f]));
  const swap = swappable(defaults);
  files.forEach((f) => stubInto(context, f, Object.fromEntries(Object.keys(ABSENT[f]).map((name) => [name, swap.exports[name]]))));
  return { set: swap.set, reset: swap.reset };
};

const none = () => Promise.resolve([]);
/** submit 存檔時呼叫的其他模組 → 「沒載入」時的等價行為（那項檢查略過） */
const SUBMIT_ABSENT = {
  '交通費明細規則.js': { TRAFFIC_RULES: { normalize() {}, validate: () => [] } },
  '費用歸屬部門限制.js': { COST_SCOPE: { validate: none } },
  'signing_personnel_manager.js': { SIGNING_CHAIN: { applyOnSave: none, applyAccountingOnSave: none } },
  '部長上一階主管.js': { DIRECTOR_UPLINE: { apply: none } },
  '手動簽核人設定.js': { MANUAL_SIGNERS: { validate: none } },
};

/**
 * payment_request_submit.js 存檔時呼叫的其他模組，換成「沒載入時」的替身（以前沒載入就略過那項檢查）。
 * 要在載入 submit（與 real 列的模組）之前呼叫；main（費用歸屬代碼快取）不換。
 * @param {Object|null} context
 * @param {{ real?: string[] }} [opts] 這些檔用真的模組
 */
const stubSubmitDeps = (context, { real = [] } = {}) => {
  Object.keys(SUBMIT_ABSENT)
    .filter((f) => !real.includes(f))
    .forEach((f) => stubInto(context, f, SUBMIT_ABSENT[f]));
};

module.exports = { stubSigningDeps, stubSubmitDeps };
