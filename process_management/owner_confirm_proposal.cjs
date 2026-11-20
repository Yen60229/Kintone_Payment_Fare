'use strict';

// 由 749 流程管理匯出檔產生「費用所屬人確認中」的提案流程（只產生檔案，不會改 kintone；後台照提案檔手動改）。
//   node process_management/owner_confirm_proposal.cjs <來源匯出檔> <輸出檔>
//
// 改法（設計見 docs/749_現況與待決事項.md）：
//   1. 新增狀態「費用所屬人確認中」（作業者＝費用所屬人）、「費用所屬人駁回」（作業者＝申請人）
//   2. 草稿（未送出）原本所有往前送的動作，條件後面加「and 費用所屬人確認 not in ("需要")」
//   3. 草稿新增「提交費用所屬人確認」（條件：費用所屬人確認 in ("需要")）
//   4. 費用所屬人確認中：照原條件複製一份草稿往前送的動作，另加駁回、作廢
//   5. 費用所屬人駁回：再申請回草稿、作廢

const fs = require('fs');

const DRAFT = '草稿（未送出）';
const CONFIRM = '費用所屬人確認中';
const REJECT = '費用所屬人駁回';
const VOID = '表單作廢';
const FLAG_FIELD = '費用所屬人確認';
const FLAG_NEED = `${FLAG_FIELD} in ("需要")`;
const FLAG_SKIP = `${FLAG_FIELD} not in ("需要")`;
const VOID_COND = '表單作廢 in ("作廢")';

const fieldAssignee = (code) => ({ type: 'ONE', entities: [{ entity: { type: 'FIELD_ENTITY', code }, includeSubs: false }] });

const action = (name, from, to, filterCond, type) => ({ name, from, to, filterCond, type, ...(type === 'SECONDARY' ? { executableUser: { entities: [] } } : {}) });
const pair = (name, from, to, cond = '') => [action(name, from, to, cond, 'PRIMARY'), action(name, from, to, cond, 'SECONDARY')];

/**
 * @param {Object} source 流程管理設定（GET /k/v1/app/status.json 格式）
 * @returns {Object} 新的設定（不改 source）
 */
const buildProposal = (source) => {
  const proc = JSON.parse(JSON.stringify(source));
  if (proc.states[CONFIRM]) throw new Error(`來源已經有「${CONFIRM}」`);
  const nextIndex = Math.max(...Object.values(proc.states).map((s) => Number(s.index))) + 1;
  proc.states[CONFIRM] = { name: CONFIRM, instructions: '', index: String(nextIndex), assignee: fieldAssignee('費用所屬人') };
  proc.states[REJECT] = { name: REJECT, instructions: '', index: String(nextIndex + 1), assignee: fieldAssignee('申請人') };

  const forward = [];
  const actions = proc.actions.map((a) => {
    if (a.from !== DRAFT || a.to === VOID) return a;
    forward.push({ ...a, from: CONFIRM });
    return { ...a, filterCond: a.filterCond ? `${a.filterCond} and ${FLAG_SKIP}` : FLAG_SKIP };
  });
  const block = [
    ...pair('提交費用所屬人確認', DRAFT, CONFIRM, FLAG_NEED),
    ...forward,
    ...pair('駁回', CONFIRM, REJECT),
    action('作廢', CONFIRM, VOID, VOID_COND, 'SECONDARY'),
    ...pair('再申請', REJECT, DRAFT),
    action('作廢', REJECT, VOID, VOID_COND, 'SECONDARY'),
  ];
  const lastDraft = actions.reduce((last, a, i) => (a.from === DRAFT ? i : last), -1);
  proc.actions = [...actions.slice(0, lastDraft + 1), ...block, ...actions.slice(lastDraft + 1)];
  return proc;
};

if (require.main === module) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) {
    console.error('用法：node process_management/owner_confirm_proposal.cjs <來源匯出檔> <輸出檔>');
    process.exit(1);
  }
  const before = JSON.parse(fs.readFileSync(src, 'utf8'));
  const after = buildProposal(before);
  fs.writeFileSync(out, `${JSON.stringify(after, null, 2)}\n`, 'utf8');
  console.log(`狀態 ${Object.keys(after.states).length} 個、動作 ${after.actions.length} 條（原本 ${before.actions.length} 條）→ ${out}`);
}

module.exports = { buildProposal, CONFIRM, REJECT, FLAG_FIELD };
