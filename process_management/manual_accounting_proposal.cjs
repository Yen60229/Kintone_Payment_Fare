'use strict';

// 由流程管理匯出檔產生「手動設定簽核流程簽完走自動的會計分流」的提案流程（只產生檔案，不會改 kintone；後台照提案檔手動改）。
//   node process_management/manual_accounting_proposal.cjs <來源匯出檔> <輸出檔>
//
// 改法（設計見 docs/749_現況與待決事項.md）：
//   1. 送到「單位會計處理中」（作業者＝手動會計承辦人）的動作：
//      - 簽核人確認中[1～3] 送會計的動作 → 拆成六條，各送「單位會計處理中(…)」，條件加「會計單位 in (" GROUP", "ACC_…")」
//        （會計單位 → 狀態的對應從流程本身讀：作業者是該群組的「單位會計處理中(…)」）
//      - 其他狀態送「單位會計處理中」的（條件要求手動簽核人數 0人，程式寫不出來、永遠走不到）→ 刪掉
//   2. 刪掉「單位會計處理中」狀態與它自己的動作（入帳完成、駁回、作廢）
//   3. 狀態 index 重新編號（照原順序、補掉空號）
// 程式端：手動模式也帶會計單位（signing_personnel_manager.fillAccounting），所以手動的單一定走得到某個會計狀態。

const fs = require('fs');

const MANUAL_ACCOUNTING = '單位會計處理中';
const REGIONAL_PREFIX = `${MANUAL_ACCOUNTING}(`;
const SIGNER_PREFIX = '簽核人確認中[';
const UNIT_FIELD = '會計單位';

const unitCond = (group) => `${UNIT_FIELD} in (" GROUP", "${group}")`;

/** 會計單位群組 → 會計狀態，照流程裡狀態的 index 排序 */
const regionalStates = (proc) =>
  Object.values(proc.states)
    .filter((st) => st.name.startsWith(REGIONAL_PREFIX))
    .sort((a, b) => Number(a.index) - Number(b.index))
    .flatMap((st) =>
      (st.assignee?.entities || []).filter(({ entity }) => entity.type === 'GROUP').map(({ entity }) => ({ group: entity.code, state: st.name })),
    );

/**
 * @param {Object} source 流程管理設定（GET /k/v1/app/status.json 格式）
 * @returns {Object} 新的設定（不改 source）
 */
const buildProposal = (source) => {
  const proc = JSON.parse(JSON.stringify(source));
  if (!proc.states[MANUAL_ACCOUNTING]) throw new Error(`來源沒有「${MANUAL_ACCOUNTING}」狀態，不用改`);
  const regions = regionalStates(proc);
  if (regions.length === 0) throw new Error(`來源沒有「${REGIONAL_PREFIX}…)」狀態`);

  proc.actions = proc.actions.flatMap((a) => {
    if (a.from === MANUAL_ACCOUNTING) return [];
    if (a.to !== MANUAL_ACCOUNTING) return [a];
    if (!a.from.startsWith(SIGNER_PREFIX)) return [];
    return regions.map(({ group, state }) => ({
      ...a,
      to: state,
      filterCond: a.filterCond ? `${a.filterCond} and ${unitCond(group)}` : unitCond(group),
    }));
  });

  delete proc.states[MANUAL_ACCOUNTING];
  Object.values(proc.states)
    .sort((a, b) => Number(a.index) - Number(b.index))
    .forEach((st, i) => {
      st.index = String(i);
    });
  return proc;
};

if (require.main === module) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) {
    console.error('用法：node process_management/manual_accounting_proposal.cjs <來源匯出檔> <輸出檔>');
    process.exit(1);
  }
  const before = JSON.parse(fs.readFileSync(src, 'utf8'));
  const after = buildProposal(before);
  fs.writeFileSync(out, `${JSON.stringify(after, null, 2)}\n`, 'utf8');
  console.log(`狀態 ${Object.keys(after.states).length} 個（原本 ${Object.keys(before.states).length}）、動作 ${after.actions.length} 條（原本 ${before.actions.length} 條）→ ${out}`);
}

module.exports = { buildProposal, MANUAL_ACCOUNTING };
