'use strict';

// 流程管理設定的「全部走一遍」檢查：
//   enumerateRecords(config)  列出我們的程式「真的寫得出來」的每一種假資料（條件欄位的所有合法組合）
//   checkAll(process, config) 每一筆都從草稿（未送出）一路按「送出」走到會計，並在每一關檢查：
//     - 每一關剛好一顆送出按鈕（不會兩顆、不會卡住）
//     - 這一關的作業者找得到人（欄位型作業者至少有一個欄位有值）
//     - 最後停在對的會計狀態（依「會計單位」；手動設定簽核流程的停在「單位會計處理中」）
//
// 「合法組合」的規則，和簽核人員程式實際會寫的值一致（只列程式寫得出來的；寫不出來的不列，否則會誤報）：
//   1. 簽核人排「完整鏈」：主管、次長各自靠右對齊（主管 1 人放單位主管3、2 人放主管2＋主管3…；
//      次長 1 人放單位次長1、2 人放單位次長＋單位次長1），主管 0～3 人、次長 0～2 人
//      簽核順序固定是 主管 → 次長 → 部長 → 會計，從費用所屬人上面那一層開始。簽核流程主檔一定有部長，
//      部長格只有在「費用所屬人就是部長」時才會清空，這時下面的主管、次長也一定是空的；
//      所以「無部長」只會是 主管 0 人／次長 0 人，不會有「有主管或次長、卻沒有部長」的單
//   2. 勾手動設定簽核流程時：
//        - 手動設定簽核流程的 change 處理會把「會計單位」清空，所以手動的單會計單位一律是空的，
//          最後停在「單位會計處理中」；因此手動的單每種簽核人形狀只列一次，不分會計單位
//        - 會計單位承辦人一定有填；流程條件看的是承辦人所屬的組織（MANUAL_ACCOUNTING_ORGS 兩家公司各列一次）
//        - 簽核人是使用者自己挑的，主管 0～3 人、次長 0～2 人、有無部長都可以
//   3. 自動排人的單，會計單位是 ACCOUNTING.MAP 六個群組之一
//
// 簽核人的位置一律靠右對齊；使用者手動亂填（例如只填單位主管1）不在列舉範圍內。

const sim = require('./process_sim.cjs');

const MANAGER_COUNTS = Object.freeze([0, 1, 2, 3]);
const DEPUTY_COUNTS = Object.freeze([0, 1, 2]);
const MANAGER_SLOTS = Object.freeze({ 1: ['單位主管3'], 2: ['單位主管2', '單位主管3'], 3: ['單位主管1', '單位主管2', '單位主管3'] });
const DEPUTY_SLOTS = Object.freeze({ 1: ['單位次長1'], 2: ['單位次長', '單位次長1'] });
const MANAGER_FIELD_CODES = Object.freeze(['單位主管1', '單位主管2', '單位主管3']);
const DEPUTY_FIELD_CODES = Object.freeze(['單位次長', '單位次長1']);
const SIGNING_FIELDS = Object.freeze([...MANAGER_FIELD_CODES, ...DEPUTY_FIELD_CODES]);

// 流程管理上，「單位部長_支店長」有值時，條件比的是群組「部長」（process_sim.cjs 的假資料約定）
const HEAD_FIELD = '單位部長_支店長';
const HEAD_GROUP = '部長';
const MANAGER_COUNT_FIELD = '部門主管簽核人數';
const DEPUTY_COUNT_FIELD = '部門次長簽核人數';
const CREATOR_FIELD = '建立人';
// 手動設定簽核流程的單，流程條件要求「會計單位承辦人」屬於某個組織（process_sim.cjs 的假資料約定：
// 使用者欄位有組織條件時，假資料填組織代碼）。公司名稱有兩家（NX臺灣國際物流、聯海通運），
// 兩家的會計承辦人所屬的組織都要走一遍。
const MANUAL_ACCOUNTING_ORGS = Object.freeze(['NX臺灣國際物流', '聯海通運股份有限公司']);
const FAKE_USER = Object.freeze(['U']);

/**
 * 簽核人的形狀：有人的簽核欄位、有沒有部長。人數從有人的格子數出來（和簽核人員程式的人數欄位一樣）。
 * @param {string[]} slots  有人的簽核欄位代碼（主管1～3、次長、次長1）
 * @param {boolean} hasHead  單位部長_支店長有沒有人
 */
const makeShape = (slots, hasHead) => {
  const managers = slots.filter((code) => MANAGER_FIELD_CODES.includes(code)).length;
  const deputies = slots.filter((code) => DEPUTY_FIELD_CODES.includes(code)).length;
  return {
    key: `${slots.join(',')}|${hasHead}`,
    slots,
    hasHead,
    managers,
    deputies,
    label: [`主管${managers}人`, `次長${deputies}人`, hasHead ? '有部長' : '無部長'].join('／'),
  };
};

/** 主管 0～3 人、次長 0～2 人靠右對齊，部長有無都可以（手動設定簽核流程：簽核人是使用者自己挑的） */
const fullShapes = () => {
  const shapes = [];
  for (const managers of MANAGER_COUNTS) {
    for (const deputies of DEPUTY_COUNTS) {
      for (const hasHead of [false, true]) {
        shapes.push(makeShape([...(MANAGER_SLOTS[managers] || []), ...(DEPUTY_SLOTS[deputies] || [])], hasHead));
      }
    }
  }
  return shapes;
};

/** 自動排人：一定有部長；只有費用所屬人就是部長時才沒有部長，這時主管、次長也都是 0 人 */
const autoShapes = () => fullShapes().filter((shape) => shape.hasHead || (shape.managers === 0 && shape.deputies === 0));

/**
 * 組出一筆給流程模擬器用的假資料（欄位值的約定見 process_sim.cjs）。
 * @param {Object} config  PR_CONFIG
 * @param {Object} o
 * @param {boolean} o.manual  有沒有勾手動設定簽核流程
 * @param {string} o.accounting  會計單位群組代碼（手動的單是空字串）
 * @param {number} o.managers  部門主管簽核人數
 * @param {number} o.deputies  部門次長簽核人數
 * @param {boolean} o.hasHead  單位部長_支店長有沒有人
 * @param {Object<string,Array>} [o.slotValues]  主管1～3、次長、次長1 各格的人（沒列的就是空的）
 * @param {string} [o.staffOrg]  手動的單，會計單位承辦人所屬的組織（預設第一個，見 MANUAL_ACCOUNTING_ORGS）
 */
const makeProcessRecord = (config, { manual, accounting, managers, deputies, hasHead, slotValues = {}, staffOrg = MANUAL_ACCOUNTING_ORGS[0] }) => {
  const F = config.FIELDS;
  const record = {
    [F.ACCOUNTING_UNIT]: accounting,
    [F.MANUAL_FLOW]: manual ? config.OPTIONS.MANUAL_FLOW.ON : '',
    [MANAGER_COUNT_FIELD]: `${managers}人`,
    [DEPUTY_COUNT_FIELD]: `${deputies}人`,
    [HEAD_FIELD]: hasHead ? HEAD_GROUP : '',
    [F.ACCOUNTING_STAFF]: manual ? staffOrg : '',
    [F.APPLICANT]: FAKE_USER,
    [CREATOR_FIELD]: FAKE_USER,
  };
  SIGNING_FIELDS.forEach((code) => {
    record[code] = slotValues[code] || [];
  });
  return record;
};

/**
 * 每一種合法的假資料。每筆是 { id, record }，id 是給人看的描述。
 * @param {Object} config  PR_CONFIG
 */
function* enumerateRecords(config) {
  const accountingGroups = Object.values(config.ACCOUNTING.MAP);

  for (const manual of [false, true]) {
    // 手動的單會計單位是空的，只列一次，但會計單位承辦人每個組織各列一次；自動的單每個會計單位各列一次
    const accounts = manual ? [''] : accountingGroups;
    const staffOrgs = manual ? MANUAL_ACCOUNTING_ORGS : [undefined];
    for (const shape of manual ? fullShapes() : autoShapes()) {
      for (const acc of accounts) {
        for (const staffOrg of staffOrgs) {
          const slotValues = {};
          shape.slots.forEach((code) => (slotValues[code] = FAKE_USER));
          const record = makeProcessRecord(config, {
            manual,
            accounting: acc,
            managers: shape.managers,
            deputies: shape.deputies,
            hasHead: shape.hasHead,
            slotValues,
            staffOrg,
          });
          const id = [manual ? '手動' : '自動', shape.label, manual ? `會計單位=（清空）／承辦人組織=${staffOrg}` : acc].join('／');
          yield { id, record };
        }
      }
    }
  }
}

const isFilled = (value) => (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && String(value) !== '');
const isAccountingState = (state) => state.startsWith('單位會計處理中');

/**
 * 會計單位群組 → 會計狀態名稱，從流程本身讀：名稱是「單位會計處理中(…)」、作業者是群組的狀態。
 * @returns {Object<string,string>}
 */
const accountingStateByGroup = (proc) => {
  const map = {};
  Object.values(proc.states).forEach((st) => {
    if (!st.name.startsWith('單位會計處理中(')) return;
    (st.assignee?.entities || []).forEach(({ entity }) => {
      if (entity.type === 'GROUP') map[entity.code] = st.name;
    });
  });
  return map;
};

/**
 * 這個狀態的作業者找不找得到人？回傳說明問題的文字，沒問題回傳 ''。
 *   欄位型作業者：只要列的欄位裡有一個有值就算。
 *   固定的人／群組／組織一律算有人。
 */
const assigneeProblem = (proc, state, record) => {
  const who = sim.assigneeFields(proc, state);
  if (who.empty) return `「${state}」沒有設定作業者`;
  if (who.hasFixed) return '';
  if (who.fieldCodes.some((code) => isFilled(record[code]))) return '';
  return `「${state}」的作業者欄位（${who.fieldCodes.join('、')}）在這筆資料裡都是空的，沒有人可以簽`;
};

/**
 * 一筆假資料從草稿（未送出）走到會計，回報這筆的所有問題（沒問題＝空陣列）。
 *   每一關剛好一顆送出按鈕、作業者找得到人、最後停在對的會計狀態。
 * @param {Object} proc  流程管理設定
 * @param {Object} config  PR_CONFIG
 * @param {Object} record  假資料
 * @param {Object<string,string>} accountingStates  accountingStateByGroup(proc)
 * @returns {{path: string[], problems: string[]}}  path：走過的狀態（走不通時是空陣列）
 */
const walkAndCheck = (proc, config, record, accountingStates) => {
  const F = config.FIELDS;
  const problems = [];
  let path;
  try {
    path = sim.walk(proc, config.STATUS.APPLY_START, record, { stopWhen: isAccountingState });
  } catch (e) {
    return { path: [], problems: [e.message] };
  }

  path.forEach((state) => {
    const problem = assigneeProblem(proc, state, record);
    if (problem) problems.push(problem);
  });

  const last = path[path.length - 1];
  const manual = isFilled(record[F.MANUAL_FLOW]);
  const expected = manual ? '單位會計處理中' : accountingStates[record[F.ACCOUNTING_UNIT]];
  if (!expected) problems.push(`會計單位「${record[F.ACCOUNTING_UNIT]}」找不到對應的會計狀態（流程裡沒有作業者是這個群組的「單位會計處理中(…)」）`);
  else if (last !== expected) problems.push(`最後停在「${last}」，應該是「${expected}」；經過 ${path.join(' → ')}`);
  return { path, problems };
};

/**
 * 每一筆合法假資料從草稿（未送出）走到會計，回報所有問題。
 * @param {Object} proc  流程管理設定
 * @param {Object} config  PR_CONFIG
 * @param {{mapRecord?: function(Object): Object}} [opts]  mapRecord：測試用，改寫每筆假資料（驗證檢查真的抓得到問題）
 * @returns {{total:number, failures:{id:string, record:Object, message:string}[]}}
 */
const checkAll = (proc, config, opts = {}) => {
  const accountingStates = accountingStateByGroup(proc);
  const failures = [];
  let total = 0;

  for (const { id, record: original } of enumerateRecords(config)) {
    total += 1;
    const record = opts.mapRecord ? opts.mapRecord({ ...original }) : original;
    walkAndCheck(proc, config, record, accountingStates).problems.forEach((message) => failures.push({ id, record, message }));
  }

  return { total, failures };
};

module.exports = {
  enumerateRecords,
  MANUAL_ACCOUNTING_ORGS,
  MANAGER_COUNT_FIELD,
  DEPUTY_COUNT_FIELD,
  HEAD_FIELD,
  HEAD_GROUP,
  makeProcessRecord,
  walkAndCheck,
  checkAll,
  accountingStateByGroup,
  isFilled,
  SIGNING_FIELDS,
};
