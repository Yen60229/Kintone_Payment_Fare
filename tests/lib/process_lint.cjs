'use strict';

// 流程管理設定的結構檢查（lint）。只看設定本身有沒有寫錯，不模擬走流程（走流程是 process_exhaustive.cjs）。
// 設定格式同 kintone GET /k/v1/app/status.json（states、actions）。
// 用法：const problems = lintProcess(processJson, config); // 回傳中文問題清單，空陣列＝沒問題
//
// 檢查項目：
//   1. 動作的起點、終點都是存在的狀態
//   2. 每個狀態都走得到（從 index 最小的狀態開始）
//   3. 非終點狀態至少有一個出口
//   4. 作業者設定成欄位時（狀態的作業者、動作的可執行者），欄位代碼必須是已知的欄位；
//      作業者設成群組時，群組代碼必須是 ACCOUNTING.MAP 裡的會計群組
//   5. 動作條件看得懂（看不懂的寫法直接報出來，模擬器不會把它當成通過）、用到的欄位是已知欄位、
//      條件的值要在我們自己管的範圍內、群組／組織類型標記是已知的類型、THIS_YEAR() 只用在日期欄位
//   6. 駁回狀態都有「再申請」回到草稿（未送出）

const sim = require('./process_sim.cjs');

// 流程管理用得到、但設定檔 FIELDS 裡沒有登記的欄位（簽核人員程式直接寫字面值）。
const EXTRA_FIELD_CODES = Object.freeze([
  '單位主管1',
  '單位主管2',
  '單位主管3',
  '單位次長',
  '單位次長1',
  '單位部長_支店長',
  '部門主管簽核人數',
  '部門次長簽核人數',
  '建立人', // kintone 內建欄位「記錄建立者」，報銷人填單的作業者
]);

// 終點狀態：不需要出口
const TERMINAL_STATES = Object.freeze(['請款流程結束', '表單作廢']);

// 部門內主管人數欄位的選項（簽核人員程式寫入的值）
const MANAGER_COUNT_VALUES = Object.freeze(['', '0人', '1人', '2人', '3人']);
const DEPUTY_COUNT_VALUES = Object.freeze(['', '0人', '1人', '2人']);

// 條件裡「 GROUP」「 ORGANIZATION」「 USER」這種類型標記允許的類型
const ENTITY_TYPES = Object.freeze(['GROUP', 'ORGANIZATION', 'USER']);

/** 把設定檔 FIELDS 裡所有字串值（含子表格的 CODE／COLS）收集起來 */
const collectFieldCodes = (config) => {
  const codes = new Set(EXTRA_FIELD_CODES);
  const visit = (node) => {
    if (typeof node === 'string') codes.add(node);
    else if (node && typeof node === 'object') Object.values(node).forEach(visit);
  };
  visit(config.FIELDS);
  codes.add(config.VOID_FIELD);
  return codes;
};

const actionLabel = (a) => `${a.from} →「${a.name}」→ ${a.to}`;

/**
 * @param {Object} proc  流程管理設定
 * @param {Object} config  PR_CONFIG
 * @returns {string[]} 問題清單（空陣列＝沒問題）
 */
const lintProcess = (proc, config) => {
  const problems = [];
  const states = proc.states || {};
  const actions = proc.actions || [];
  const stateNames = new Set(Object.keys(states));
  const knownFields = collectFieldCodes(config);
  const F = config.FIELDS;
  const accountingGroups = Object.values(config.ACCOUNTING.MAP);
  const dateFields = new Set([F.VOUCHER_DATE, F.PAYMENT_DATE, F.EXPECTED_PAY_DATE]);

  // 1. 動作的起點、終點必須是存在的狀態
  actions.forEach((a) => {
    if (!stateNames.has(a.from)) problems.push(`動作「${a.name}」的起點狀態「${a.from}」不存在（${actionLabel(a)}）`);
    if (!stateNames.has(a.to)) problems.push(`動作「${a.name}」的終點狀態「${a.to}」不存在（${actionLabel(a)}）`);
  });

  // 2. 每個狀態都走得到：從 index 最小的狀態（報銷人填單）出發
  const byIndex = Object.values(states).sort((x, y) => Number(x.index) - Number(y.index));
  if (byIndex.length === 0) {
    problems.push('流程裡沒有任何狀態');
  } else {
    const initial = byIndex[0].name;
    const reached = new Set([initial]);
    const queue = [initial];
    while (queue.length > 0) {
      const from = queue.shift();
      actions.forEach((a) => {
        if (a.from === from && stateNames.has(a.to) && !reached.has(a.to)) {
          reached.add(a.to);
          queue.push(a.to);
        }
      });
    }
    stateNames.forEach((name) => {
      if (!reached.has(name)) problems.push(`狀態「${name}」從起點「${initial}」走不到（沒有動作通往它）`);
    });
  }

  // 3. 非終點狀態至少有一個出口
  stateNames.forEach((name) => {
    if (TERMINAL_STATES.includes(name)) return;
    if (!actions.some((a) => a.from === name)) problems.push(`狀態「${name}」沒有任何出口動作（單子到這裡會卡死）`);
  });

  // 4. 作業者：欄位要是已知欄位、群組要是會計群組
  Object.values(states).forEach((st) => {
    (st.assignee?.entities || []).forEach(({ entity }) => {
      if (entity.type === 'FIELD_ENTITY' && !knownFields.has(entity.code)) {
        problems.push(`狀態「${st.name}」的作業者欄位「${entity.code}」不是已知的欄位代碼（設定檔 FIELDS 與簽核欄位都沒有這個代碼）`);
      }
      if (entity.type === 'GROUP' && !accountingGroups.includes(entity.code)) {
        problems.push(`狀態「${st.name}」的作業者群組「${entity.code}」不在 ACCOUNTING.MAP 的會計群組內`);
      }
    });
  });
  actions.forEach((a) => {
    (a.executableUser?.entities || []).forEach(({ entity }) => {
      if (entity.type === 'FIELD_ENTITY' && !knownFields.has(entity.code)) {
        problems.push(`動作 ${actionLabel(a)} 的可執行者欄位「${entity.code}」不是已知的欄位代碼`);
      }
    });
  });

  // 5. 動作條件：看得懂、欄位要是已知欄位、值要在我們自己管的範圍內
  const domains = {
    [F.ACCOUNTING_UNIT]: { label: 'ACCOUNTING.MAP', values: accountingGroups },
    [F.MANUAL_FLOW]: { label: 'OPTIONS.MANUAL_FLOW', values: Object.values(config.OPTIONS.MANUAL_FLOW) },
    [config.VOID_FIELD]: { label: 'ACTIONS.VOID', values: [config.ACTIONS.VOID] },
    部門主管簽核人數: { label: '部門主管簽核人數的選項', values: MANAGER_COUNT_VALUES },
    部門次長簽核人數: { label: '部門次長簽核人數的選項', values: DEPUTY_COUNT_VALUES },
  };
  actions.forEach((a) => {
    let parts;
    try {
      parts = sim.parseCond(a.filterCond);
    } catch (e) {
      problems.push(`動作 ${actionLabel(a)} 的條件看不懂（模擬器不支援這種寫法，不能當作通過）：${e.message}`);
      return;
    }
    parts.forEach(({ field, op, values, entities }) => {
      if (!knownFields.has(field)) problems.push(`動作 ${actionLabel(a)} 的條件用到未知欄位「${field}」`);
      if (op === 'thisYear' && !dateFields.has(field)) {
        problems.push(`動作 ${actionLabel(a)} 的「${field}」用了 THIS_YEAR()，但它不是已知的日期欄位`);
      }
      entities.forEach(({ type, code }) => {
        if (type && !ENTITY_TYPES.includes(type)) problems.push(`動作 ${actionLabel(a)} 的「${field}」條件裡，「${code}」前面的類型標記「${type}」不認識`);
      });
      const domain = domains[field];
      if (domain) {
        values.forEach((v) => {
          if (!domain.values.includes(v)) problems.push(`動作 ${actionLabel(a)} 的「${field}」條件值「${v}」不在 ${domain.label} 的範圍內`);
        });
      }
    });
  });

  // 6. 駁回狀態都有「再申請」回到草稿（未送出）
  const start = config.STATUS.APPLY_START;
  stateNames.forEach((name) => {
    if (!name.endsWith('駁回')) return;
    if (!actions.some((a) => a.from === name && a.name === '再申請' && a.to === start)) {
      problems.push(`駁回狀態「${name}」沒有「再申請」動作回到「${start}」`);
    }
  });

  return problems;
};

module.exports = { lintProcess, collectFieldCodes, EXTRA_FIELD_CODES, TERMINAL_STATES, ENTITY_TYPES };
