'use strict';

// 流程管理模擬器：讀 kintone 流程管理設定（GET /k/v1/app/status.json 的格式），
// 依假資料判斷每個狀態會出現哪些按鈕、按下去會到哪一關。只給測試用。
//
// 條件字串只支援流程管理實際用到的寫法，其他寫法一律丟錯（lint 會報「條件看不懂」），不會靜默當成通過：
//   欄位 in ("a", "b")、欄位 not in ("a", "b")、欄位 = THIS_YEAR()，用 and 串起來。
//
// 使用者／群組／組織欄位的條件，kintone 匯出時長這樣：  單位部長_支店長 in (" GROUP", "部長")
//   括號裡開頭帶空白的字串（" GROUP"、" ORGANIZATION"）是「類型標記」，後面跟著的字串是該類型的代碼。
//   模擬器的約定（這是約定，不是向 kintone 驗證過的行為）：
//     - 假資料裡，這類欄位有人時填「條件裡那個群組／組織的代碼」，沒人時填 ''
//       例：單位部長_支店長 有人 → '部長'（人屬於群組「部長」）；會計單位承辦人 → 組織代碼
//     - 比對時只比代碼，類型標記記在 entities 裡讓檢查程式看得到
// 欄位 = THIS_YEAR()：日期欄位的值落在「今年」才成立（假資料填 'YYYY-MM-DD'，空白不成立）。
//   所以傳票日期填了去年（或明年）的日期時，這個條件不成立；今年由 year 參數決定（預設執行當下的年份）。

/** 目前的年份（THIS_YEAR() 的比對基準） */
const currentYear = () => new Date().getFullYear();

/**
 * 把 in (...) 裡的字串拆開。
 * @returns {{values: string[], entities: {type: string, code: string}[]}}
 *   values：代碼（不含類型標記）；entities：每個代碼前面最近的類型標記（沒有標記時 type 是 ''）
 */
const parseList = (inner) => {
  const values = [];
  const entities = [];
  let type = '';
  [...inner.matchAll(/"((?:[^"\\]|\\.)*)"/g)].forEach((m) => {
    const text = m[1];
    if (text.startsWith(' ')) {
      type = text.trim();
      return;
    }
    values.push(text);
    entities.push({ type, code: text });
  });
  return { values, entities };
};

/**
 * 把條件字串拆成一條一條的判斷。回傳 [{field, op, values, entities}]
 * @param {string} cond
 */
const parseCond = (cond) => {
  const text = String(cond || '').trim();
  if (!text) return [];
  const parts = [];
  const re = /\s*([^\s=]+)\s+(not in|in)\s+\(((?:"(?:[^"\\]|\\.)*"\s*,?\s*)*)\)\s*(?:and\s+|$)|\s*([^\s=]+)\s*=\s*THIS_YEAR\(\)\s*(?:and\s+|$)/gy;
  let m;
  let consumed = 0;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '') break;
    consumed = re.lastIndex;
    if (m[4]) parts.push({ field: m[4], op: 'thisYear', values: [], entities: [] });
    else parts.push({ field: m[1], op: m[2], ...parseList(m[3]) });
  }
  if (consumed !== text.length) throw new Error(`看不懂的條件：${text}（停在第 ${consumed} 個字）`);
  return parts;
};

const valuesOf = (record, field) => {
  const v = record[field];
  if (v === undefined || v === null) return [''];
  if (Array.isArray(v)) return v.length > 0 ? v.map(String) : [''];
  return [String(v)];
};

/** 這筆假資料符不符合條件 */
const matches = (cond, record, year = currentYear()) =>
  parseCond(cond).every(({ field, op, values }) => {
    if (op === 'thisYear') return valuesOf(record, field).some((v) => v.startsWith(`${year}-`));
    const hit = valuesOf(record, field).some((v) => values.includes(v));
    return op === 'in' ? hit : !hit;
  });

/**
 * 某個狀態下，作業者（PRIMARY）看得到哪些按鈕。
 * @param {Object} process  流程管理設定
 * @param {string} state
 * @param {Object} record
 * @param {{excludeNames?: string[], year?: number}} [opts]
 */
const enabledActions = (process, state, record, opts = {}) => {
  const exclude = new Set(opts.excludeNames || []);
  return process.actions.filter((a) => a.type === 'PRIMARY' && a.from === state && !exclude.has(a.name) && matches(a.filterCond, record, opts.year));
};

/**
 * 從某個狀態開始一路往下按「送出」，直到進入 stopWhen 為真的狀態。
 * 每一關都必須剛好只有一顆送出按鈕（駁回、作廢、轉至其他會計不算），否則丟錯。
 * @returns {string[]} 經過的狀態（含起點與終點）
 */
const walk = (process, startState, record, { stopWhen, excludeNames = ['駁回', '作廢'], maxSteps = 20 }) => {
  const path = [startState];
  let state = startState;
  for (let i = 0; i < maxSteps; i++) {
    if (stopWhen(state)) return path;
    const acts = enabledActions(process, state, record, { excludeNames });
    if (acts.length !== 1) {
      const desc = acts.map((a) => `${a.name}→${a.to}`).join('、') || '（沒有按鈕）';
      throw new Error(`「${state}」應該剛好一顆送出按鈕，實際：${desc}；經過 ${path.join(' → ')}`);
    }
    state = acts[0].to;
    path.push(state);
  }
  throw new Error(`走了 ${maxSteps} 步還沒結束：${path.join(' → ')}`);
};

/**
 * 某個狀態的作業者設定：
 *   type        作業者的處理方式（ONE／ANY／ALL）
 *   fieldCodes  作業者是「表單欄位」的欄位代碼（FIELD_ENTITY）
 *   hasFixed    有沒有固定的人／群組／組織（USER／GROUP／ORGANIZATION，一定算有人）
 *   empty       完全沒設定作業者
 * @param {Object} process
 * @param {string} state
 */
const assigneeFields = (process, state) => {
  const assignee = process.states[state]?.assignee || { type: '', entities: [] };
  const entities = assignee.entities || [];
  return {
    type: assignee.type,
    fieldCodes: entities.filter((e) => e.entity.type === 'FIELD_ENTITY').map((e) => e.entity.code),
    hasFixed: entities.some((e) => e.entity.type !== 'FIELD_ENTITY'),
    empty: entities.length === 0,
  };
};

module.exports = { currentYear, parseCond, matches, enabledActions, walk, assigneeFields };
