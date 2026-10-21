'use strict';

// 回歸測試：signing_personnel_manager_20260506.js 的 planSigningChain（純函式）
//   簽核流程主檔有值的欄位「全部」排進來，順序固定為
//   單位主管1 → 單位主管2 → 單位主管3 → 單位次長 → 單位次長1 → 單位部長_支店長；
//   費用所屬人本人那一層與以下，由 clearSigningFieldsByTitle 依職稱清掉（那段走 signing_owner_chain.test.cjs）。
// 直接用 Node 執行：node tests/signing_chain_plan.test.cjs
//
// 作法：從原始檔擷取 planSigningChain 本體隔離執行，對全部「有值／沒值」組合和獨立寫的參考算法逐一比對。

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
// 正規化行尾：repo 內 LF／CRLF 混用（git 亦會自動轉換），regex 擷取需先統一
const readSrc = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8').replace(/\r\n/g, '\n');
const signingSrc = readSrc('signing_personnel_manager_20260506.js');

// 與原始檔相同的欄位對應（APPROVAL_FIELDS 目前六格皆 enabled）
const MANAGER_FIELDS_MAPPING = [
  { apiField: '請購單位主管1', displayField: '單位主管1' },
  { apiField: '請購單位主管2', displayField: '單位主管2' },
  { apiField: '請購單位主管3', displayField: '單位主管3' },
  { apiField: '請購單位次長', displayField: '單位次長' },
  { apiField: '請購單位次長1', displayField: '單位次長1' },
  { apiField: '請購單位部長', displayField: '單位部長_支店長' },
];
const MANAGER_FIELDS_SPECIAL = [{ apiField: '請購單位部長', displayField: '單位部長_支店長' }];
const FULL_CHAIN = MANAGER_FIELDS_MAPPING.map((f) => f.displayField);

const extract = (re, label) => {
  const m = signingSrc.match(re);
  assert.ok(m, `找不到 ${label}，來源檔可能已改結構，請同步更新本測試`);
  return m[0];
};

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log('signing_chain_plan.test.cjs');

const fnSrc = extract(/  const planSigningChain = \(managerData, fieldsToUpdate\) => \{[\s\S]*?\n  \};/, 'planSigningChain');
const planSigningChain = new Function(`${fnSrc}\n  return planSigningChain;`)();

const U = (code) => [{ code, name: code }];
const API_FIELDS = MANAGER_FIELDS_MAPPING.map((f) => f.apiField);

// 六個欄位「有值／沒值」的 64 種組合；沒值的欄位輪流用三種「空」的表示法
const buildManagerData = (presence) => {
  const data = {};
  API_FIELDS.forEach((apiField, i) => {
    if (!presence[i]) {
      data[apiField] = i % 3 === 0 ? undefined : i % 3 === 1 ? { value: [] } : {};
      return;
    }
    data[apiField] = { value: U(`U${i}`) };
  });
  return data;
};
const presencePatterns = [];
for (let mask = 0; mask < 64; mask++) presencePatterns.push(API_FIELDS.map((_, i) => Boolean(mask & (1 << i))));

check('回傳 fieldHasValue 與 fieldsToShow 兩個鍵', () => {
  const r = planSigningChain({}, MANAGER_FIELDS_MAPPING);
  assert.deepStrictEqual(Object.keys(r).sort(), ['fieldHasValue', 'fieldsToShow']);
});

check('六格都有人：全部排進來，順序是 主管1→2→3→次長→次長1→部長', () => {
  const data = buildManagerData([true, true, true, true, true, true]);
  const { fieldsToShow } = planSigningChain(data, MANAGER_FIELDS_MAPPING);
  assert.deepStrictEqual(fieldsToShow, FULL_CHAIN);
});

check('全部沒值：不排任何人', () => {
  const { fieldsToShow, fieldHasValue } = planSigningChain({}, MANAGER_FIELDS_MAPPING);
  assert.deepStrictEqual(fieldsToShow, []);
  assert.ok(Object.values(fieldHasValue).every((v) => v === false));
});

check('部分欄位有值：只留有值的那幾格，不往上補也不只留一位', () => {
  const data = buildManagerData([true, false, true, true, false, true]);
  const { fieldsToShow } = planSigningChain(data, MANAGER_FIELDS_MAPPING);
  assert.deepStrictEqual(fieldsToShow, ['單位主管1', '單位主管3', '單位次長', '單位部長_支店長']);
});

check('六大簽核流程部門只看部長那一格', () => {
  const full = buildManagerData([true, true, true, true, true, true]);
  assert.deepStrictEqual(planSigningChain(full, MANAGER_FIELDS_SPECIAL).fieldsToShow, ['單位部長_支店長']);
  const noHead = buildManagerData([true, true, true, true, true, false]);
  assert.deepStrictEqual(planSigningChain(noHead, MANAGER_FIELDS_SPECIAL).fieldsToShow, []);
});

check('全矩陣：64 種有值組合 × 一般／特殊部門，與獨立參考算法逐一相同', () => {
  let cases = 0;
  [MANAGER_FIELDS_MAPPING, MANAGER_FIELDS_SPECIAL].forEach((mapping) => {
    presencePatterns.forEach((presence) => {
      const data = buildManagerData(presence);
      const expectedShow = mapping.filter(({ apiField }) => data[apiField]?.value?.length > 0).map((m) => m.displayField);
      const r = planSigningChain(data, mapping);
      assert.deepStrictEqual(r.fieldsToShow, expectedShow, `presence=${presence}`);
      mapping.forEach(({ apiField, displayField }) => {
        assert.strictEqual(r.fieldHasValue[displayField], Boolean(data[apiField]?.value?.length), `fieldHasValue ${displayField}`);
      });
      cases += 1;
    });
  });
  assert.strictEqual(cases, 128);
});

check('不看費用所屬人是誰：只收主管資料與欄位對應兩個參數（本人那層由職稱清除處理）', () => {
  assert.strictEqual(planSigningChain.length, 2);
  const data = buildManagerData([true, true, true, true, true, true]);
  data['請購單位主管2'] = { value: [{ code: 'ME', name: 'ME' }] };
  assert.deepStrictEqual(planSigningChain(data, MANAGER_FIELDS_MAPPING).fieldsToShow, FULL_CHAIN);
});

check('原始檔不再有「往上一階」、搬到主管3、存檔重排等舊機制', () => {
  [
    'ALLOWED_TYPES',
    'CHAIN_MODE',
    'planSlot3Relocation',
    'relocateSingleApproverToSlot3',
    'planSubmitChain',
    'applyChainForSubmit',
    'alignRight',
    'PR_SIGNING',
    'signingContextCache',
    'loadSigningContext',
    'getSigningContext',
    'prefetchSigningContext',
    'handleTypeChange',
    'withTimeout',
  ].forEach((name) => assert.ok(!signingSrc.includes(name), `不應再出現 ${name}`));
});

console.log(`\n${passed} assertions passed.`);
