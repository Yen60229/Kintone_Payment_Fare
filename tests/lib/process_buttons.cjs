'use strict';

// 流程管理設定的「每個狀態的按鈕」檢查：
//   process_exhaustive.cjs 只沿著「送出」那條路走到會計；這裡對每一種合法假資料，
//   從申請開始把「所有作業者按鈕」（含駁回、再申請、轉至其他會計、入帳完成）都按過一遍（廣度優先），
//   在每一個走得到的狀態檢查按鈕長得對不對：
//     1. 非終點狀態（終點：請款流程結束、表單作廢）至少要有一顆「送出」按鈕，單子才不會卡住
//        送出按鈕＝名稱不含「駁回」、也不是「作廢」的作業者按鈕（再申請、提交…、入帳完成都算）
//     2. 送出按鈕最多一顆，不會讓作業者不知道按哪一顆
//     3. 單位會計處理中…（會計狀態）是例外，分兩種情況評估：
//          - 「轉至…」按鈕（轉至其他會計單位）是刻意設計的多顆按鈕
//            （見 轉至其他會計單位按鈕處理_20250723.js，畫面上會把它們移到右邊），
//            所以不算在「送出按鈕」裡，會計狀態只算「不是駁回／作廢／轉至」的按鈕
//          - 「入帳完成」要等會計人員填了傳票日期才會出現（條件：傳票日期 = THIS_YEAR()），
//            所以每一筆資料的會計狀態要評估兩次：
//              a. 傳票日期空白：還沒有入帳完成，只有駁回、轉至是正常的，不算「沒有送出按鈕」
//                 （單子是在等會計人員填傳票日期）；反過來，這時如果出現送出按鈕，代表入帳完成沒有被傳票日期擋住
//              b. 傳票日期已填（今年）：剛好要出現一顆「入帳完成」，而且不能再有別的送出按鈕
//              c. 傳票日期填了去年：條件是 傳票日期 = THIS_YEAR()，所以不會出現「入帳完成」。
//                 這不算失敗（是流程設計的結果），但會列在 notes 讓使用者知道跨年入帳會卡住
//   另外回報「沒有任何一筆資料走得到」的狀態、「沒有任何一筆資料按得到」的動作（都是資訊用，不算失敗）。
//   預期走不到的狀態不會列入：
//     - 報銷人填單：建單後的初始狀態，在申請開始之前
//     - 表單作廢：只有「作廢」能到，而作廢是只有管理者能按的動作（SECONDARY），不是作業者按鈕

const sim = require('./process_sim.cjs');
const { enumerateRecords, isFilled } = require('./process_exhaustive.cjs');

const TERMINAL_STATES = Object.freeze(['請款流程結束', '表單作廢']);
const ACCOUNTING_PREFIX = '單位會計處理中';
const BUTTON_FINISH = '入帳完成';
const BUTTON_TRANSFER_PREFIX = '轉至';
const BUTTON_REJECT_WORD = '駁回';
const BUTTON_VOID = '作廢';
const voucherThisYear = (year) => `${year}-06-15`; // 條件 傳票日期 = THIS_YEAR()：要是今年的日期
const voucherLastYear = (year) => `${year - 1}-12-31`;

const isAccountingState = (state) => state.startsWith(ACCOUNTING_PREFIX);
const isRejectOrVoid = (a) => a.name.includes(BUTTON_REJECT_WORD) || a.name === BUTTON_VOID;
const isTransfer = (a) => a.name.startsWith(BUTTON_TRANSFER_PREFIX);

const describe = (list) => (list.length > 0 ? list.map((a) => `${a.name}→${a.to}`).join('、') : '（沒有）');

/**
 * 預期走不到的狀態：報銷人填單（初始狀態）、表單作廢（只有 SECONDARY 的作廢能到）。
 * @param {Object} config  PR_CONFIG
 * @returns {string[]}
 */
const expectedUnreached = (config) => [config.STATUS.REIMBURSEMENT_FILL, config.STATUS.VOID];

/**
 * 這個狀態在這筆資料下，按鈕有沒有問題，回傳問題文字陣列（沒問題＝空陣列）。
 * 訊息裡不放這筆資料的內容，同一類問題才併得成一組。
 * @param {Object} proc
 * @param {string} state
 * @param {Object} record  已經決定好傳票日期有沒有填的假資料
 * @param {string} voucherField  傳票日期的欄位代碼
 * @param {number} year  THIS_YEAR() 的基準年
 */
const stateProblems = (proc, state, record, voucherField, year) => {
  const buttons = sim.enabledActions(proc, state, record, { year });
  const submits = buttons.filter((a) => !isRejectOrVoid(a));

  if (!isAccountingState(state)) {
    if (submits.length === 0) return [`「${state}」沒有送出按鈕（目前的按鈕：${describe(buttons)}）`];
    if (submits.length > 1) return [`「${state}」出現兩顆以上的送出按鈕（共 ${submits.length} 顆）：${describe(submits)}`];
    return [];
  }

  // 會計狀態：「轉至…」不算送出按鈕
  const real = submits.filter((a) => !isTransfer(a));
  if (!isFilled(record[voucherField])) {
    if (real.length > 0) return [`「${state}」傳票日期還沒填，卻出現送出按鈕（${describe(real)}），入帳完成沒有被傳票日期擋住`];
    return [];
  }
  const finish = real.filter((a) => a.name === BUTTON_FINISH);
  if (finish.length === 0) return [`「${state}」傳票日期已填，卻沒有「${BUTTON_FINISH}」按鈕（目前的按鈕：${describe(buttons)}）`];
  if (real.length > 1) return [`「${state}」傳票日期已填，出現兩顆以上的送出按鈕（共 ${real.length} 顆）：${describe(real)}`];
  return [];
};

/**
 * 會計狀態、傳票日期填了去年：回報有沒有「入帳完成」。條件是 傳票日期 = THIS_YEAR()，去年的日期不成立，
 * 所以通常沒有——這是流程設計的結果，不算失敗，只回傳說明文字讓使用者知道。
 */
const lastYearNote = (proc, state, record, voucherField, year) => {
  const buttons = sim.enabledActions(proc, state, { ...record, [voucherField]: voucherLastYear(year) }, { year });
  if (buttons.some((a) => a.name === BUTTON_FINISH)) return '';
  return `「${state}」傳票日期填了去年的日期（${voucherLastYear(year)}）時沒有「${BUTTON_FINISH}」按鈕（條件是 ${voucherField} = THIS_YEAR()，要今年的日期才成立；跨年入帳會卡在這一關）`;
};

/**
 * 一筆假資料：從申請開始，每個狀態的所有作業者按鈕都按過一遍（廣度優先），檢查每個走得到的狀態。
 * @param {Object} proc
 * @param {Object} config  PR_CONFIG
 * @param {Object} record
 * @param {number} [year]  THIS_YEAR() 的基準年（預設今年）
 * @returns {{reached: Set<string>, fired: Set<Object>, problems: string[], notes: string[]}}  fired：按得到的動作
 */
const exploreRecord = (proc, config, record, year = sim.currentYear()) => {
  const voucherField = config.FIELDS.VOUCHER_DATE;
  const start = config.STATUS.APPLY_START;
  const reached = new Set([start]);
  const fired = new Set();
  const problems = [];
  const notes = [];
  const queue = [start];

  while (queue.length > 0) {
    const state = queue.shift();
    if (TERMINAL_STATES.includes(state)) continue;
    // 會計狀態分「傳票日期空白」「已填（今年）」兩種各評估一次，另外看「填去年」的情況；
    // 其他狀態傳票日期不影響按鈕，評估一次
    const variants = isAccountingState(state)
      ? [{ ...record, [voucherField]: '' }, { ...record, [voucherField]: voucherThisYear(year) }]
      : [record];
    try {
      variants.forEach((variant) => {
        stateProblems(proc, state, variant, voucherField, year).forEach((p) => problems.push(p));
        sim.enabledActions(proc, state, variant, { year }).forEach((a) => {
          fired.add(a);
          if (reached.has(a.to)) return;
          reached.add(a.to);
          queue.push(a.to);
        });
      });
      if (isAccountingState(state)) {
        const note = lastYearNote(proc, state, record, voucherField, year);
        if (note) notes.push(note);
      }
    } catch (e) {
      // 條件看不懂（模擬器不支援的寫法）：明確報成問題，不當作通過
      problems.push(`「${state}」的按鈕判斷不了：${e.message}`);
    }
  }
  return { reached, fired, problems, notes };
};

/**
 * 每一種合法假資料，每個狀態的按鈕都檢查一遍。
 * @param {Object} proc  流程管理設定
 * @param {Object} config  PR_CONFIG
 * @param {{year?: number}} [opts]
 * @returns {{total:number, failures:{id:string, record:Object, message:string}[], reached:Set<string>, unreached:string[], expected:string[], unusedActions:string[], notes:string[]}}
 *   unreached：沒有任何一筆資料走得到、而且不在預期名單內的狀態（資訊用）；expected：預期走不到的狀態（流程裡有的）；
 *   unusedActions：沒有任何一筆資料按得到的作業者動作（條件永遠不成立，資訊用；起點是預期走不到的狀態的不算）；notes：不算失敗、但使用者該知道的事（已去重）
 */
const checkButtons = (proc, config, opts = {}) => {
  const year = opts.year ?? sim.currentYear();
  const failures = [];
  const reached = new Set();
  const fired = new Set();
  const notes = new Set();
  let total = 0;

  for (const { id, record } of enumerateRecords(config)) {
    total += 1;
    const result = exploreRecord(proc, config, record, year);
    result.reached.forEach((s) => reached.add(s));
    result.fired.forEach((a) => fired.add(a));
    result.notes.forEach((n) => notes.add(n));
    result.problems.forEach((message) => failures.push({ id, record, message }));
  }

  const expectedList = expectedUnreached(config);
  const never = Object.keys(proc.states).filter((s) => !reached.has(s));
  return {
    total,
    failures,
    reached,
    unreached: never.filter((s) => !expectedList.includes(s)),
    expected: never.filter((s) => expectedList.includes(s)),
    unusedActions: proc.actions.filter((a) => a.type === 'PRIMARY' && !expectedList.includes(a.from) && !fired.has(a)).map((a) => `${a.from} →「${a.name}」→ ${a.to}（條件：${a.filterCond || '無'}）`),
    notes: [...notes],
  };
};

module.exports = { checkButtons, exploreRecord, expectedUnreached };
