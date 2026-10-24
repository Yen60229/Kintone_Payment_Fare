'use strict';

// 測試：流程管理設定的檢查工具（tests/lib/process_*.cjs、process_management/check_process.cjs、load_config.cjs）
//   1. 載入設定檔：kintone.app.getId() 回 749，欄位代碼從 FIELDS 取
//   2. 模擬器怎麼解讀條件：in／not in、群組與組織的類型標記、THIS_YEAR()；看不懂的寫法會明確報錯，不會靜默通過
//   3. 749 目前的流程（process_management/exports/749_rev1799.json）：
//        結構檢查 0 個問題；走一遍與按鈕檢查有「已知的問題清單」（見下方 KNOWN_*），
//        測試斷言的就是這份清單——之後使用者把流程改好、清單變了，測試會失敗提醒更新
//   4. 修好的複本（只補 749 現況缺的條件）：全部通過，證明已知問題的成因就是下面講的那幾個條件
//   5. 故意弄壞修好的複本，確認檢查抓得到（改作業者欄位、終點狀態不存在、拿掉唯一出口、複製一顆一樣的送出按鈕…）
//   6. 假資料涵蓋範圍
//   7. check_process.cjs 命令列：沒給參數時檢查 exports 裡 revision 最大的 749 流程檔
// 單獨執行：node tests/process_checks.test.cjs

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sim = require('./lib/process_sim.cjs');
const { lintProcess } = require('./lib/process_lint.cjs');
const { checkAll, enumerateRecords, MANUAL_ACCOUNTING_ORGS, MANAGER_COUNT_FIELD, DEPUTY_COUNT_FIELD, HEAD_FIELD } = require('./lib/process_exhaustive.cjs');
const { checkButtons } = require('./lib/process_buttons.cjs');
const { loadConfig, APP_ID } = require('../process_management/load_config.cjs');
const { latestExport, groupKey } = require('../process_management/check_process.cjs');

const ROOT = path.join(__dirname, '..');
const EXPORTS_DIR = path.join(ROOT, 'process_management', 'exports');
const CONFIG = loadConfig();
const F = CONFIG.FIELDS;
const EXPORT_CURRENT = JSON.parse(fs.readFileSync(path.join(EXPORTS_DIR, '749_rev1799.json'), 'utf8'));

const clone = (obj) => JSON.parse(JSON.stringify(obj));

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const hasProblem = (problems, ...words) => problems.some((p) => words.every((w) => p.includes(w)));

// ── 749 revision 1799（與 1798 相同） 已知的問題（流程本身的設定，不是檢查工具的錯；要由使用者決定怎麼改）─────────────
//   成因 A：自動排人的單、有部長（單位部長_支店長 有人）時，
//           「申請單位主管3確認中」「申請單位次長1確認中」同時出現「提交單位部長確認」和「提交單位會計入帳」兩顆按鈕。
//           因為這兩關的「提交單位會計入帳」只看「會計單位」，沒有像「草稿（未送出）」那樣加 單位部長_支店長 not in (部長)。
//   成因 B：「申請單位主管3確認中」同時出現「提交單位次長1確認／提交單位次長確認」和「提交單位會計入帳」兩顆按鈕：
//           這關的「提交單位會計入帳」沒有限制 部門次長簽核人數 為 0 人。
//   （rev 1795 的成因 C「聯海通運的手動單在主管3卡住」已在 rev 1798 補上承辦人組織條件，不再列）
const KNOWN_WALK_PROBLEMS = Object.freeze({
  '「申請單位主管3確認中」應該剛好一顆送出按鈕，實際：提交單位次長1確認→申請單位次長1確認中、提交單位會計入帳→單位會計處理中(…)': 36,
  '「申請單位主管3確認中」應該剛好一顆送出按鈕，實際：提交單位次長確認→申請單位次長確認中、提交單位會計入帳→單位會計處理中(…)': 36,
  '「申請單位主管3確認中」應該剛好一顆送出按鈕，實際：提交單位部長確認→申請單位部長確認中、提交單位會計入帳→單位會計處理中(…)': 18,
  '「申請單位次長1確認中」應該剛好一顆送出按鈕，實際：提交單位部長確認→申請單位部長確認中、提交單位會計入帳→單位會計處理中(…)': 12,
});
const KNOWN_BUTTON_PROBLEMS = Object.freeze({
  '「申請單位次長1確認中」出現兩顆以上的送出按鈕（共 2 顆）：提交單位部長確認→申請單位部長確認中、提交單位會計入帳→單位會計處理中(…)': 48,
  '「申請單位主管3確認中」出現兩顆以上的送出按鈕（共 2 顆）：提交單位次長1確認→申請單位次長1確認中、提交單位會計入帳→單位會計處理中(…)': 36,
  '「申請單位主管3確認中」出現兩顆以上的送出按鈕（共 2 顆）：提交單位次長確認→申請單位次長確認中、提交單位會計入帳→單位會計處理中(…)': 36,
  '「申請單位主管3確認中」出現兩顆以上的送出按鈕（共 2 顆）：提交單位部長確認→申請單位部長確認中、提交單位會計入帳→單位會計處理中(…)': 18,
});

/** 失敗清單併成「類別 → 筆數」 */
const tally = (failures) => {
  const counts = {};
  failures.forEach((f) => {
    const key = groupKey(f.message);
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
};

// ── 修好的複本：只補上面兩個成因缺的條件，其他完全不動 ───────────────────────
const HEAD_NOT = ` and ${HEAD_FIELD} not in (" GROUP", "部長")`;
const DEPUTY_ZERO = ` and ${DEPUTY_COUNT_FIELD} in ("0人", "")`;
const S = Object.freeze({
  START: CONFIG.STATUS.APPLY_START,
  MANAGER3: '申請單位主管3確認中',
  DEPUTY: '申請單位次長確認中',
  DEPUTY1: '申請單位次長1確認中',
  HEAD: '申請單位部長確認中',
  MANUAL_ACC: '單位會計處理中',
  ACC_TPE: '單位會計處理中(台北)',
  ACC_KHH: '單位會計處理中(高雄)',
  REJECT_HEAD: '申請單位部長駁回',
  VOID: CONFIG.STATUS.VOID,
});
const isGroupAccounting = (a) => a.type === 'PRIMARY' && a.name === '提交單位會計入帳' && a.to.startsWith('單位會計處理中(');
const repair = (proc) => {
  const fixed = clone(proc);
  fixed.actions.forEach((a) => {
    if (isGroupAccounting(a) && [S.MANAGER3, S.DEPUTY, S.DEPUTY1].includes(a.from)) a.filterCond += HEAD_NOT;
    if (isGroupAccounting(a) && a.from === S.MANAGER3) a.filterCond += DEPUTY_ZERO;
  });
  return fixed;
};
const FIXED = repair(EXPORT_CURRENT);

console.log('process_checks.test.cjs');

// ── 1. 載入設定檔 ────────────────────────────────────────────────────────

check('loadConfig：kintone.app.getId() 回 749，APPS.PAYMENT 就是 749，欄位代碼從 FIELDS 取得到，不依賴已移除的設定', () => {
  assert.strictEqual(APP_ID, 749);
  assert.strictEqual(CONFIG.APPS.PAYMENT, 749);
  assert.strictEqual(F.APPLICANT, '申請人');
  assert.strictEqual(F.VOUCHER_DATE, '傳票日期');
  assert.strictEqual(F.ACCOUNTING_UNIT, '會計單位');
  assert.strictEqual(F.MANUAL_FLOW, '手動設定簽核流程');
  assert.deepStrictEqual(Object.values(CONFIG.ACCOUNTING.MAP).sort(), ['ACC_CKS', 'ACC_KHH', 'ACC_NEXT', 'ACC_TEPZ', 'ACC_TPE', 'ACC_TPE海運']);
  // 檢查工具不能依賴已移除的設定（類型、交際費簽核判定、主管3 搬移…）
  ['TYPE', 'TYPES', 'ENT_SIGN', 'AUTO_CHAIN_TYPES', 'SLOT3_RELOCATION'].forEach((key) => assert.strictEqual(CONFIG[key], undefined, key));
  ['TYPE', 'OVERAGE_SIGN', 'CROSS_DEPT_SIGN', 'GA_DIRECTOR', 'PRESIDENT', 'EMPLOYEE_NAME'].forEach((key) => assert.strictEqual(F[key], undefined, key));
});

// ── 2. 模擬器怎麼解讀條件 ────────────────────────────────────────────────

check('模擬器解讀：群組、組織的類型標記（開頭帶空白的字串）只當類型，後面的字串才是代碼', () => {
  const [head] = sim.parseCond(`${HEAD_FIELD} in (" GROUP", "部長")`);
  assert.deepStrictEqual(head, { field: HEAD_FIELD, op: 'in', values: ['部長'], entities: [{ type: 'GROUP', code: '部長' }] });
  const parts = sim.parseCond(`手動設定簽核流程 in ("手動設定簽核流程") and 會計單位承辦人 in (" ORGANIZATION", "NX臺灣國際物流") and ${HEAD_FIELD} not in (" GROUP", "部長")`);
  assert.deepStrictEqual(
    parts.map((p) => [p.field, p.op, p.values]),
    [
      ['手動設定簽核流程', 'in', ['手動設定簽核流程']],
      ['會計單位承辦人', 'in', ['NX臺灣國際物流']],
      [HEAD_FIELD, 'not in', ['部長']],
    ]
  );
  assert.deepStrictEqual(parts[1].entities, [{ type: 'ORGANIZATION', code: 'NX臺灣國際物流' }]);
  assert.deepStrictEqual(parts[0].entities, [{ type: '', code: '手動設定簽核流程' }]);
});

check('模擬器解讀：單位部長_支店長 in (部長群組)——欄位有人（假資料填群組代碼）才成立，沒人不成立；not in 反過來', () => {
  const cond = `${HEAD_FIELD} in (" GROUP", "部長")`;
  assert.strictEqual(sim.matches(cond, { [HEAD_FIELD]: '部長' }), true);
  assert.strictEqual(sim.matches(cond, { [HEAD_FIELD]: '' }), false);
  assert.strictEqual(sim.matches(cond, {}), false);
  const not = `${HEAD_FIELD} not in (" GROUP", "部長")`;
  assert.strictEqual(sim.matches(not, { [HEAD_FIELD]: '部長' }), false);
  assert.strictEqual(sim.matches(not, { [HEAD_FIELD]: '' }), true);
  // 空字串也是合法的選項值：部門次長簽核人數 in ("0人", "") 對空白成立
  assert.strictEqual(sim.matches('部門次長簽核人數 in ("0人", "")', { 部門次長簽核人數: '' }), true);
  assert.strictEqual(sim.matches('部門次長簽核人數 in ("0人", "")', { 部門次長簽核人數: '1人' }), false);
});

check('模擬器解讀：傳票日期 = THIS_YEAR() 要是「今年」的日期才成立（空白、去年、明年都不成立）', () => {
  const cond = `${F.VOUCHER_DATE} = THIS_YEAR()`;
  assert.deepStrictEqual(sim.parseCond(cond), [{ field: F.VOUCHER_DATE, op: 'thisYear', values: [], entities: [] }]);
  assert.strictEqual(sim.matches(cond, { [F.VOUCHER_DATE]: '2026-03-01' }, 2026), true);
  assert.strictEqual(sim.matches(cond, { [F.VOUCHER_DATE]: '2025-12-31' }, 2026), false);
  assert.strictEqual(sim.matches(cond, { [F.VOUCHER_DATE]: '2027-01-01' }, 2026), false);
  assert.strictEqual(sim.matches(cond, { [F.VOUCHER_DATE]: '' }, 2026), false);
  assert.strictEqual(sim.matches(cond, {}, 2026), false);
  assert.strictEqual(sim.matches(cond, { [F.VOUCHER_DATE]: `${sim.currentYear()}-01-01` }), true);
});

check('模擬器解讀：不支援的寫法（>、or、其他函式）直接丟錯，不會靜默當成通過；lint 與按鈕檢查都會把它報出來', () => {
  ['傳票日期 > "2020-01-01"', '傳票日期 <= TODAY()', '會計單位 in ("ACC_TPE") or 手動設定簽核流程 in ("手動設定簽核流程")', '部門主管簽核人數 like "1"'].forEach((cond) => {
    assert.throws(() => sim.parseCond(cond), /看不懂的條件/, cond);
    assert.throws(() => sim.matches(cond, {}), /看不懂的條件/, cond);
  });
  const broken = clone(FIXED);
  broken.actions.find((a) => a.from === S.ACC_TPE && a.name === '入帳完成').filterCond = `${F.VOUCHER_DATE} <= TODAY()`;
  assert.ok(hasProblem(lintProcess(broken, CONFIG), '條件看不懂', '不能當作通過', '入帳完成'));
  const buttons = checkButtons(broken, CONFIG).failures.map((f) => f.message);
  assert.ok(hasProblem(buttons, `「${S.ACC_TPE}」`, '判斷不了', '看不懂的條件'), buttons.join('\n'));
  assert.deepStrictEqual(checkAll(broken, CONFIG).failures, [], '走一遍只走到會計狀態為止，不碰入帳完成');
});

// ── 3. 749 目前的流程 ────────────────────────────────────────────────────

check('749 revision 1799：結構檢查 0 個問題（24 個狀態、122 條動作、作業者欄位與條件欄位都是已知欄位，條件模擬器都看得懂）', () => {
  assert.strictEqual(EXPORT_CURRENT.revision, '1799');
  assert.strictEqual(Object.keys(EXPORT_CURRENT.states).length, 24);
  assert.strictEqual(EXPORT_CURRENT.actions.length, 122);
  assert.deepStrictEqual(lintProcess(EXPORT_CURRENT, CONFIG), []);
  const conds = EXPORT_CURRENT.actions.map((a) => a.filterCond).filter(Boolean);
  assert.ok(conds.some((c) => c.includes('THIS_YEAR()')));
  assert.ok(conds.some((c) => c.includes('" GROUP"')));
  assert.ok(conds.some((c) => c.includes('" ORGANIZATION"')));
  conds.forEach((c) => assert.doesNotThrow(() => sim.parseCond(c), c));
});

check('749 revision 1799：config 的 STATUS 都是流程裡真的有的狀態（「點擊流程開始」後是「草稿（未送出）」，與其他 App 一致）', () => {
  Object.values(CONFIG.STATUS).forEach((name) => assert.ok(EXPORT_CURRENT.states[name], `流程裡沒有狀態「${name}」`));
  assert.strictEqual(EXPORT_CURRENT.states['申請開始'], undefined);
  const start = EXPORT_CURRENT.actions.find((a) => a.name === CONFIG.ACTIONS.APPLY_START);
  assert.deepStrictEqual([start.from, start.to], [CONFIG.STATUS.REIMBURSEMENT_FILL, CONFIG.STATUS.APPLY_START]);
  assert.strictEqual(CONFIG.AUTO_ADVANCE.TO_STATUS, '草稿（未送出）');
});

check('⚠️ 749 全部走一遍：目前已知的問題清單（流程本身的設定問題，要使用者決定；清單變了就代表流程改過，請更新 KNOWN_WALK_PROBLEMS）', () => {
  const { total, failures } = checkAll(EXPORT_CURRENT, CONFIG);
  assert.strictEqual(total, 192);
  assert.deepStrictEqual(tally(failures), KNOWN_WALK_PROBLEMS);
  // 問題只出在「有簽核人的單」：沒有簽核人（主管 0 人、次長 0 人、無部長）的單全都走得通
  failures.forEach((f) => assert.ok(!f.id.includes('主管0人／次長0人／無部長'), f.id));
  // rev 1798 起聯海通運的手動單不再卡住：沒有任何一筆是「沒有按鈕」
  assert.ok(failures.every((f) => !f.message.includes('沒有按鈕')), '沒有卡住的單');
  console.log(`      （${total} 種假資料，${failures.length} 筆已知問題）`);
});

check('⚠️ 749 每個狀態的按鈕：目前已知的問題清單（同上，清單變了請更新 KNOWN_BUTTON_PROBLEMS）；其餘狀態都走得到', () => {
  const result = checkButtons(EXPORT_CURRENT, CONFIG);
  assert.strictEqual(result.total, 192);
  assert.deepStrictEqual(tally(result.failures), KNOWN_BUTTON_PROBLEMS);
  assert.deepStrictEqual(result.unreached, []);
  assert.deepStrictEqual([...result.expected].sort(), [CONFIG.STATUS.REIMBURSEMENT_FILL, S.VOID].sort());
  // 會計狀態（含傳票日期的檢查）沒有任何問題：入帳完成有被傳票日期擋住，今年的日期填了就剛好一顆
  assert.ok(result.failures.every((f) => !f.message.startsWith('「單位會計處理中')), '會計狀態的按鈕沒有問題');
  [S.MANAGER3, S.DEPUTY1, S.HEAD, S.REJECT_HEAD, '單位會計駁回', S.MANUAL_ACC, S.ACC_TPE, S.ACC_KHH, '請款流程結束'].forEach((state) => {
    assert.ok(result.reached.has(state), `沒走到「${state}」`);
  });
});

check('749 的 THIS_YEAR() 條件：傳票日期填去年的日期時，七個會計狀態都沒有「入帳完成」（跨年入帳會卡住，列在 notes 讓使用者知道）', () => {
  const { notes } = checkButtons(EXPORT_CURRENT, CONFIG, { year: 2026 });
  assert.strictEqual(notes.length, 7);
  assert.ok(notes.every((n) => n.includes('2025-12-31') && n.includes('入帳完成') && n.includes('THIS_YEAR()')));
  ['單位會計處理中(台北)', '單位會計處理中(台北海運)', '單位會計處理中(桃園&新竹)', '單位會計處理中(台中)', '單位會計處理中(物流)', '單位會計處理中(高雄)', '「單位會計處理中」'].forEach((name) => {
    assert.ok(notes.some((n) => n.includes(name)), name);
  });
  // 年份跟著基準年走
  assert.ok(checkButtons(EXPORT_CURRENT, CONFIG, { year: 2030 }).notes.every((n) => n.includes('2029-12-31')));
});

check('749 沒有條件永遠不成立的動作（rev 1798 拿掉「申請單位次長確認中 → 提交單位會計入帳」六條，該關只剩送次長1與駁回）', () => {
  const { unusedActions } = checkButtons(EXPORT_CURRENT, CONFIG);
  assert.deepStrictEqual(unusedActions, []);
  const fromDeputy = EXPORT_CURRENT.actions.filter((a) => a.from === S.DEPUTY).map((a) => `${a.name}→${a.to}`);
  assert.deepStrictEqual(fromDeputy, [`提交單位次長1確認→${S.DEPUTY1}`, '駁回→申請單位次長駁回']);
});

// 程式會把主檔有值的簽核人全部排上（§2.3），流程每條可走的路線都要經過每一位有人的關卡，不能跳過
const SLOT_STATES = Object.freeze({
  單位主管1: '申請單位主管1確認中',
  單位主管2: '申請單位主管2確認中',
  單位主管3: S.MANAGER3,
  單位次長: S.DEPUTY,
  單位次長1: S.DEPUTY1,
  [HEAD_FIELD]: S.HEAD,
});
/** 每筆假資料展開所有送出按鈕（有兩顆就兩條路都走），回報「走得到會計卻跳過有人的關卡」的路線 */
const skippedApprovers = (proc) => {
  const skips = [];
  for (const { id, record } of enumerateRecords(CONFIG)) {
    const need = Object.keys(SLOT_STATES).filter((f) => (Array.isArray(record[f]) ? record[f].length > 0 : record[f] != null && String(record[f]) !== '')).map((f) => SLOT_STATES[f]);
    const dfs = (state, route) => {
      if (state.startsWith('單位會計處理中') || route.length > 20) {
        const missed = need.filter((s) => !route.includes(s));
        if (missed.length) skips.push({ id, route, missed });
        return;
      }
      sim.enabledActions(proc, state, record)
        .filter((a) => a.type === 'PRIMARY' && !['駁回', '作廢'].includes(a.name))
        .forEach((a) => dfs(a.to, route.concat(a.to)));
    };
    dfs(S.START, [S.START]);
  }
  return skips;
};

check('⚠️ 749 簽核人會被跳過：有次長或部長時，主管3／次長1 可以直接按「提交單位會計入帳」略過後面的人（102 筆假資料；流程補條件前的已知問題）', () => {
  const skips = skippedApprovers(EXPORT_CURRENT);
  assert.strictEqual(new Set(skips.map((s) => s.id)).size, 102);
  // 被跳過的只會是次長、次長1、部長，而且都是從主管3 或次長1 直接送會計
  skips.forEach((s) => {
    assert.ok(s.missed.every((m) => [S.DEPUTY, S.DEPUTY1, S.HEAD].includes(m)), `${s.id}：${s.missed}`);
    assert.ok([S.MANAGER3, S.DEPUTY1].includes(s.route[s.route.length - 2]), `${s.id}：${s.route.join('→')}`);
  });
});

// ── 4. 修好的複本全部通過 ────────────────────────────────────────────────

check('修好的複本：每筆假資料的每條路線都經過所有排上的簽核人，沒有人被跳過', () => {
  assert.deepStrictEqual(skippedApprovers(FIXED).map((s) => `${s.id}：${s.route.join('→')}`), []);
});

check('修好的複本（補 部長 not in、次長 0 人兩處條件）：結構、走一遍、按鈕全部 0 個問題——已知問題的成因就是這兩處', () => {
  assert.notDeepStrictEqual(FIXED.actions, EXPORT_CURRENT.actions);
  assert.deepStrictEqual(lintProcess(FIXED, CONFIG), []);
  assert.deepStrictEqual(checkAll(FIXED, CONFIG).failures.map((f) => `${f.id}：${f.message}`), []);
  const buttons = checkButtons(FIXED, CONFIG);
  assert.deepStrictEqual(buttons.failures.map((f) => `${f.id}：${f.message}`), []);
  assert.deepStrictEqual(buttons.unreached, []);
});

// ── 5. 故意弄壞：結構檢查要抓得到（以修好的複本為底，所以出現的問題都是弄壞造成的）──────

check('結構檢查抓得到：作業者欄位寫成不認識的代碼、作業者群組不是會計群組、可執行者欄位不認識', () => {
  const broken = clone(FIXED);
  broken.states[S.HEAD].assignee.entities[0].entity.code = '部長群組';
  broken.states[S.ACC_TPE].assignee.entities[0].entity.code = 'ACC_亂寫';
  broken.actions.find((a) => a.type === 'SECONDARY' && a.from === S.ACC_TPE && a.name === '作廢').executableUser.entities[0].entity.code = '亂寫的欄位';
  const problems = lintProcess(broken, CONFIG);
  assert.ok(hasProblem(problems, S.HEAD, '部長群組', '作業者欄位'), problems.join('\n'));
  assert.ok(hasProblem(problems, S.ACC_TPE, 'ACC_亂寫', 'ACCOUNTING.MAP'), problems.join('\n'));
  assert.ok(hasProblem(problems, '可執行者欄位', '亂寫的欄位'), problems.join('\n'));
});

check('結構檢查抓得到：動作的終點狀態不存在、起點狀態不存在', () => {
  const broken = clone(FIXED);
  broken.actions.find((a) => a.type === 'PRIMARY' && a.to === S.HEAD).to = '不存在的狀態';
  broken.actions.find((a) => a.type === 'PRIMARY' && a.from === S.DEPUTY1).from = '另一個不存在的狀態';
  const problems = lintProcess(broken, CONFIG);
  assert.ok(hasProblem(problems, '終點狀態', '不存在的狀態'), problems.join('\n'));
  assert.ok(hasProblem(problems, '起點狀態', '另一個不存在的狀態'), problems.join('\n'));
});

check('結構檢查抓得到：條件用到不認識的欄位、條件值不在我們管的範圍內、類型標記不認識、THIS_YEAR() 用在非日期欄位', () => {
  const broken = clone(FIXED);
  const [a, b, c, d] = broken.actions.filter((x) => x.type === 'PRIMARY' && x.from === S.START);
  a.filterCond = `${a.filterCond} and 亂寫的欄位 in ("x")`;
  b.filterCond = b.filterCond.replace('"2人"', '"9人"');
  c.filterCond = `${c.filterCond} and ${HEAD_FIELD} in (" ROBOT", "部長")`;
  d.filterCond = `${d.filterCond} and ${F.APPLICANT} = THIS_YEAR()`;
  const acc = broken.actions.find((x) => x.type === 'PRIMARY' && x.from === S.START && x.to === S.ACC_TPE);
  acc.filterCond = acc.filterCond.replace('"ACC_TPE"', '"ACC_亂寫"');
  const problems = lintProcess(broken, CONFIG);
  assert.ok(hasProblem(problems, '未知欄位', '亂寫的欄位'), problems.join('\n'));
  assert.ok(hasProblem(problems, '9人', '部門主管簽核人數的選項'), problems.join('\n'));
  assert.ok(hasProblem(problems, '類型標記', 'ROBOT'), problems.join('\n'));
  assert.ok(hasProblem(problems, F.APPLICANT, 'THIS_YEAR()', '日期欄位'), problems.join('\n'));
  assert.ok(hasProblem(problems, 'ACC_亂寫', 'ACCOUNTING.MAP'), problems.join('\n'));
});

check('結構檢查抓得到：走不到的狀態、沒有出口的狀態、駁回沒有再申請', () => {
  const broken = clone(FIXED);
  broken.states['孤島狀態'] = { name: '孤島狀態', index: '99', assignee: { type: 'ONE', entities: [] } };
  broken.actions = broken.actions.filter((a) => a.from !== S.REJECT_HEAD);
  const problems = lintProcess(broken, CONFIG);
  assert.ok(hasProblem(problems, '孤島狀態', '走不到'), problems.join('\n'));
  assert.ok(hasProblem(problems, '孤島狀態', '沒有任何出口'), problems.join('\n'));
  assert.ok(hasProblem(problems, S.REJECT_HEAD, '再申請'), problems.join('\n'));
  assert.ok(hasProblem(problems, S.REJECT_HEAD, '沒有任何出口'), problems.join('\n'));
});

// ── 故意弄壞：全部走一遍要抓得到 ─────────────────────────────────────────

/** 改壞的流程（或改壞的假資料）走一遍之後的問題；修好的複本本身是 0 個，所以這裡出現的都是改壞造成的 */
const failuresOf = (mutated, opts) => checkAll(mutated, CONFIG, opts).failures;

check('走流程抓得到：拿掉「提交單位主管3確認」這個唯一出口 → 主管 1 人的單卡在草稿（未送出）（沒有按鈕）', () => {
  const broken = clone(FIXED);
  broken.actions = broken.actions.filter((a) => !(a.from === S.START && a.name === '提交單位主管3確認'));
  const added = failuresOf(broken);
  assert.ok(added.length > 0, '拿掉出口後應該有新的問題');
  assert.ok(added.every((f) => f.message.includes(`「${S.START}」`) && f.message.includes('沒有按鈕')), added[0].message);
  assert.ok(added.every((f) => f.record[MANAGER_COUNT_FIELD] === '1人'), '只有主管 1 人的單受影響');
});

check('走流程抓得到：複製一顆條件一樣的送出按鈕 → 同一關出現兩顆按鈕', () => {
  const broken = clone(FIXED);
  broken.actions.push(clone(broken.actions.find((a) => a.type === 'PRIMARY' && a.from === S.START && a.name === '提交單位主管3確認')));
  const added = failuresOf(broken);
  assert.ok(added.length > 0);
  assert.ok(added.every((f) => f.message.includes('應該剛好一顆送出按鈕')), added[0].message);
  const two = '提交單位主管3確認→申請單位主管3確認中、提交單位主管3確認→申請單位主管3確認中';
  assert.ok(added.some((f) => f.message.includes(two)), added[0].message);
});

check('走流程抓得到：主管 3 確認中的作業者欄位是空的（單子到那一關沒有人可以簽）', () => {
  const added = failuresOf(FIXED, {
    mapRecord: (record) => {
      record['單位主管3'] = [];
      return record;
    },
  });
  assert.ok(added.length > 0);
  assert.ok(added.every((f) => f.message.includes(S.MANAGER3) && f.message.includes('沒有人可以簽')), added[0].message);
  assert.ok(added.every((f) => f.record[MANAGER_COUNT_FIELD] !== '0人'), '主管 0 人的單不經過這一關');
});

check('走流程抓得到：部長確認中的作業者欄位寫成群組代碼（它不是欄位代碼）→ 所有要部長簽的單都沒有人簽，lint 也報得出來', () => {
  const broken = clone(FIXED);
  broken.states[S.HEAD].assignee.entities[0].entity.code = '部長群組';
  const added = failuresOf(broken);
  assert.ok(added.length > 0);
  assert.ok(added.every((f) => f.message.includes(S.HEAD) && f.message.includes('部長群組')), added[0].message);
  assert.ok(hasProblem(lintProcess(broken, CONFIG), S.HEAD, '部長群組'));
});

check('走流程抓得到：送會計送錯地方（台北的單送到高雄）；會計單位的群組找不到對應的會計狀態', () => {
  const broken = clone(FIXED);
  broken.actions.find((a) => a.type === 'PRIMARY' && a.from === S.START && a.to === S.ACC_TPE).to = S.ACC_KHH;
  const added = failuresOf(broken);
  assert.ok(added.some((f) => f.message.includes(`最後停在「${S.ACC_KHH}」，應該是「${S.ACC_TPE}」`)), added.map((f) => f.message).join('\n'));
  // 台北會計狀態的作業者改成固定的人，就不再是 ACC_TPE 群組的狀態
  const noState = clone(FIXED);
  noState.states[S.ACC_TPE].assignee.entities = [{ entity: { type: 'USER', code: '24136' }, includeSubs: false }];
  assert.ok(failuresOf(noState).some((f) => f.message.includes('找不到對應的會計狀態') && f.message.includes('ACC_TPE')));
});

check('走流程抓得到：手動設定簽核流程的單，拿掉承辦人組織條件裡的聯海通運 → 該公司的手動單沒有按鈕', () => {
  const broken = clone(FIXED);
  const action = broken.actions.find((a) => a.type === 'PRIMARY' && a.from === S.MANAGER3 && a.to === S.MANUAL_ACC);
  action.filterCond = action.filterCond.replace(', " ORGANIZATION", "聯海通運股份有限公司"', '');
  const added = failuresOf(broken);
  assert.strictEqual(added.length, 3);
  assert.ok(added.every((f) => f.id.includes('聯海通運股份有限公司') && f.message.includes('沒有按鈕')), added[0].message);
});

// ── 每個狀態的按鈕：故意弄壞 ─────────────────────────────────────────────

/** 改壞的流程，每個狀態的按鈕檢查之後的問題（修好的複本本身是 0 個） */
const buttonProblems = (mutated) => checkButtons(mutated, CONFIG).failures.map((f) => f.message);
const hasMessage = (messages, ...words) => messages.some((m) => words.every((w) => m.includes(w)));

check('按鈕檢查抓得到：部長確認中多一顆一樣的送出按鈕 → 兩顆', () => {
  const broken = clone(FIXED);
  broken.actions.push(clone(broken.actions.find((a) => a.type === 'PRIMARY' && a.from === S.HEAD && a.to === S.ACC_TPE)));
  const messages = buttonProblems(broken);
  assert.ok(hasMessage(messages, `「${S.HEAD}」`, '兩顆'), messages.join('\n'));
  assert.ok(messages.every((m) => m.includes(`「${S.HEAD}」`)), '只有部長確認中會出問題');
});

check('按鈕檢查抓得到：部長駁回拿掉再申請 → 沒有送出按鈕', () => {
  const broken = clone(FIXED);
  broken.actions = broken.actions.filter((a) => !(a.from === S.REJECT_HEAD && a.name === '再申請'));
  const messages = buttonProblems(broken);
  assert.ok(hasMessage(messages, `「${S.REJECT_HEAD}」`, '沒有送出按鈕'), messages.join('\n'));
  assert.ok(messages.every((m) => m.includes(`「${S.REJECT_HEAD}」`)), '只有部長駁回會出問題');
});

check('按鈕檢查抓得到：單位會計處理中(台北) 多一顆沒有條件的非「轉至」按鈕 → 兩顆；傳票日期空白時也會被抓到', () => {
  const broken = clone(FIXED);
  broken.actions.push({ name: '多餘的送出', from: S.ACC_TPE, to: '請款流程結束', filterCond: '', type: 'PRIMARY' });
  const messages = buttonProblems(broken);
  assert.ok(hasMessage(messages, `「${S.ACC_TPE}」`, '兩顆'), messages.join('\n'));
  assert.ok(hasMessage(messages, `「${S.ACC_TPE}」`, '傳票日期還沒填'), messages.join('\n'));
});

check('按鈕檢查抓得到：單位會計處理中(高雄) 拿掉入帳完成 → 傳票日期已填卻沒有按鈕；傳票日期空白時沒有是正常的，不會誤報', () => {
  const broken = clone(FIXED);
  broken.actions = broken.actions.filter((a) => !(a.from === S.ACC_KHH && a.name === '入帳完成'));
  const messages = buttonProblems(broken);
  assert.ok(hasMessage(messages, `「${S.ACC_KHH}」`, '傳票日期已填', '沒有', '入帳完成'), messages.join('\n'));
  assert.ok(messages.every((m) => m.includes(`「${S.ACC_KHH}」`)));
});

check('按鈕檢查抓得到：入帳完成的傳票日期條件被拿掉 → 傳票日期空白也出現送出按鈕（沒有被擋住）', () => {
  const broken = clone(FIXED);
  broken.actions.find((a) => a.from === S.MANUAL_ACC && a.name === '入帳完成').filterCond = '';
  const messages = buttonProblems(broken);
  assert.ok(hasMessage(messages, `「${S.MANUAL_ACC}」`, '傳票日期還沒填', '入帳完成沒有被傳票日期擋住'), messages.join('\n'));
});

check('按鈕檢查：會計狀態的「轉至…」不算送出按鈕（傳票日期空白時只有駁回、轉至，不會誤報沒有送出按鈕）', () => {
  assert.ok(FIXED.actions.filter((a) => a.type === 'PRIMARY' && a.from === S.ACC_TPE && a.name.startsWith('轉至')).length >= 2);
  assert.deepStrictEqual(buttonProblems(FIXED), []);
});

// ── 6. 假資料涵蓋範圍 ────────────────────────────────────────────────────

check('假資料涵蓋夠廣：六個會計單位、主管 0～3 人、次長 0～2 人、有無部長、手動與否、兩家公司的承辦人組織；id 不重複', () => {
  const entries = [...enumerateRecords(CONFIG)];
  const records = entries.map((e) => e.record);
  assert.strictEqual(records.length, 192);
  assert.strictEqual(new Set(entries.map((e) => e.id)).size, entries.length, 'id 不能重複');
  const distinct = (field, list = records) => new Set(list.map((r) => r[field]));
  const manual = records.filter((r) => r[F.MANUAL_FLOW]);
  const auto = records.filter((r) => !r[F.MANUAL_FLOW]);
  assert.strictEqual(manual.length, 4 * 3 * 2 * MANUAL_ACCOUNTING_ORGS.length);
  assert.strictEqual(auto.length, 4 * 3 * 2 * 6);
  assert.deepStrictEqual(distinct(F.ACCOUNTING_UNIT, auto), new Set(Object.values(CONFIG.ACCOUNTING.MAP)));
  assert.deepStrictEqual(distinct(MANAGER_COUNT_FIELD), new Set(['0人', '1人', '2人', '3人']));
  assert.deepStrictEqual(distinct(DEPUTY_COUNT_FIELD), new Set(['0人', '1人', '2人']));
  assert.deepStrictEqual(distinct(HEAD_FIELD), new Set(['', '部長']));
  assert.deepStrictEqual(distinct(F.ACCOUNTING_STAFF, manual), new Set(MANUAL_ACCOUNTING_ORGS));
  assert.deepStrictEqual(MANUAL_ACCOUNTING_ORGS, ['NX臺灣國際物流', '聯海通運股份有限公司']);
});

check('假資料規則：手動的單會計單位是空的、會計單位承辦人有填；自動的單一定有會計單位、承辦人沒填；申請人與建立人都有人', () => {
  for (const { id, record } of enumerateRecords(CONFIG)) {
    if (record[F.MANUAL_FLOW]) {
      assert.strictEqual(record[F.MANUAL_FLOW], CONFIG.OPTIONS.MANUAL_FLOW.ON, id);
      assert.strictEqual(record[F.ACCOUNTING_UNIT], '', id);
      assert.ok(record[F.ACCOUNTING_STAFF], id);
    } else {
      assert.ok(record[F.ACCOUNTING_UNIT], id);
      assert.strictEqual(record[F.ACCOUNTING_STAFF], '', id);
    }
    assert.ok(record[F.APPLICANT].length > 0 && record['建立人'].length > 0, id);
  }
});

check('假資料規則：簽核人靠右對齊，人數欄位等於有人的格子數（主管 1 人放單位主管3、次長 1 人放單位次長1）', () => {
  const filled = (r, codes) => codes.filter((c) => r[c].length > 0);
  for (const { id, record: r } of enumerateRecords(CONFIG)) {
    const managers = filled(r, ['單位主管1', '單位主管2', '單位主管3']);
    const deputies = filled(r, ['單位次長', '單位次長1']);
    assert.strictEqual(r[MANAGER_COUNT_FIELD], `${managers.length}人`, id);
    assert.strictEqual(r[DEPUTY_COUNT_FIELD], `${deputies.length}人`, id);
    assert.deepStrictEqual(managers, ['單位主管1', '單位主管2', '單位主管3'].slice(3 - managers.length), id);
    assert.deepStrictEqual(deputies, ['單位次長', '單位次長1'].slice(2 - deputies.length), id);
  }
});

// ── 7. 命令列 ────────────────────────────────────────────────────────────

const runCli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'process_management', 'check_process.cjs'), ...args], { encoding: 'utf8' });

check('latestExport：挑 revision 最大的 749_rev*.json（不是字串排序，也不挑別的 App 或別的檔名）；沒有檔案時報錯', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exports-'));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'exports-empty-'));
  try {
    ['749_rev99.json', '749_rev1791.json', '749_rev2000.json', '723_rev9999.json', '749_rev3000.txt', 'notes.json'].forEach((n) => fs.writeFileSync(path.join(dir, n), '{}'));
    assert.strictEqual(path.basename(latestExport(dir)), '749_rev2000.json');
    assert.strictEqual(latestExport(), latestExport(EXPORTS_DIR));
    assert.throws(() => latestExport(empty), /沒有 749_rev/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

check('命令列：沒給參數時檢查 exports 裡 revision 最大的 749 流程檔；749 目前有已知問題，結束代碼 1、輸出「未通過」', () => {
  const run = runCli();
  assert.strictEqual(run.status, 1, run.stdout + run.stderr);
  assert.ok(run.stdout.includes(`${path.basename(latestExport())}（revision 1799）`), run.stdout);
  assert.ok(run.stdout.includes('[1] 結構檢查：沒有問題'));
  assert.ok(run.stdout.includes('102 筆'));
  assert.ok(run.stdout.includes('未通過'));
  assert.ok(run.stdout.includes('傳票日期填了去年'), '跨年入帳的注意事項有印出來');
});

check('命令列：修好的複本通過（結束代碼 0、輸出「通過」）；讀不到的檔案與不是流程管理設定的檔案報錯、結束代碼 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-'));
  try {
    const good = path.join(dir, '749_rev9999.json');
    fs.writeFileSync(good, JSON.stringify({ ...FIXED, revision: '9999' }));
    const ok = runCli(good);
    assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
    assert.ok(ok.stdout.includes('revision 9999') && /\n通過\n/.test(ok.stdout), ok.stdout);
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ hello: 1 }));
    const notProc = runCli(bad);
    assert.strictEqual(notProc.status, 1);
    assert.ok(notProc.stderr.includes('不是流程管理設定'), notProc.stderr);
    const missing = runCli(path.join(dir, 'nope.json'));
    assert.strictEqual(missing.status, 1);
    assert.ok(missing.stderr.includes('讀不到流程管理設定'), missing.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} assertions passed.`);
