'use strict';

// 回歸測試：簽核流程主檔（APPS.APPROVAL_FLOW）怎麼查
//   - 一般單位：用費用所屬人部門的組織代碼查「簽核所屬單位」（組織欄位），改組織名稱不用改程式
//   - 依職稱改查的合併流程（特殊簽核流程，例如「物流部次長級」）：specialFlowName 回傳名稱，用「簽核流程名稱」查
//   - 原本拼名稱用的補前綴（ORG_PARENT_MAP）、Sales Team、聯海縮寫都已刪除
// 直接用 Node 執行：node tests/signing_flow_lookup.test.cjs
//
// 作法：從原始檔擷取 specialFlowName 本體隔離執行；查詢字串走 signing_owner_chain.test.cjs 的整段流程。

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
// 正規化行尾：repo 內 LF／CRLF 混用（git 亦會自動轉換），regex 擷取需先統一
const readSrc = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8').replace(/\r\n/g, '\n');
const signingSrc = readSrc('signing_personnel_manager_20260506.js');

const extract = (re, label) => {
  const m = signingSrc.match(re);
  assert.ok(m, `找不到 ${label}，來源檔可能已改結構，請同步更新本測試`);
  return m[0];
};

const fnSrc = extract(/function specialFlowName\(org, title\) \{[\s\S]*?\n  \}/, 'specialFlowName');
const specialFlowName = new Function(`${fnSrc}\n  return specialFlowName;`)();

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log('signing_flow_lookup.test.cjs');

check('依職稱改查的合併流程：各部次長級、部長合併名稱', () => {
  const cases = [
    ['物流部-桃園NEXT1倉庫', '次長', '物流部次長級'],
    ['物流部', '次長', '物流部次長級'],
    ['航空貨物部', '次長', '航空貨物部次長(所長)級'],
    ['桃園機場營業所', '所長', '航空貨物部次長(所長)級'],
    ['新竹營業所', '次長', '航空貨物部次長(所長)級'],
    ['海運貨物部', '次長', '海運貨物部次長級'],
    ['總務部', '次長', '總務部次長級'],
    ['汽車貨運部', '部長', '物流部長/汽車貨運部長'],
    ['物流部', '部長', '物流部長/汽車貨運部長'],
    ['海運貨物部', '部長', '海運貨物部長/航空貨物部長'],
    ['航空貨物部', '部長', '海運貨物部長/航空貨物部長'],
    ['安全品質推動部', '部長', '安全品質推動部長/營業戰略部長/總務部長/事業本部長'],
    ['營業戰略部', '部長', '安全品質推動部長/營業戰略部長/總務部長/事業本部長'],
    ['總務部', '部長', '安全品質推動部長/營業戰略部長/總務部長/事業本部長'],
    ['事業本部', '部長', '安全品質推動部長/營業戰略部長/總務部長/事業本部長'],
    ['事業本部', '次長', '台中營業部長/高雄營業部長/事業本部次長(中心長)級'],
    ['台中營業部', '部長', '台中營業部長/高雄營業部長/事業本部次長(中心長)級'],
    ['高雄營業部', '部長', '台中營業部長/高雄營業部長/事業本部次長(中心長)級'],
    ['安全品質推動部', '次長', '安全品質推動部次長級'],
    ['高雄營業部', '次長', '高雄營業部次長級'],
    ['台中營業部', '次長', '台中營業部次長級'],
  ];
  cases.forEach(([org, title, expected]) => assert.strictEqual(specialFlowName(org, title), expected, `${org} / ${title}`));
});

check('不是特殊簽核流程 → 回傳空字串（改用組織代碼查）：一般單位、課長課員、沒有職稱', () => {
  [
    ['總務部-總務課', '課長'],
    ['桃園機場營業所-作業課', '課員'],
    ['新竹營業所-Sales Team', '課員'],
    ['聯海通運股份有限公司', '次長'],
    ['併裝中心', '中心長'],
    ['物流部', ''],
    ['', '次長'],
  ].forEach(([org, title]) => assert.strictEqual(specialFlowName(org, title), '', `${org} / ${title}`));
});

check('查詢字串：特殊流程查「簽核流程名稱」；其他查「簽核所屬單位 in (組織代碼)」且限使用中，欄位代碼都從 REF_FIELDS.APPROVAL_FLOW 取', () => {
  assert.ok(signingSrc.includes('const AF = C.REF_FIELDS.APPROVAL_FLOW;'));
  assert.ok(signingSrc.includes('`${AF.FLOW_NAME} = "${flowName}"`'));
  assert.ok(signingSrc.includes('`${AF.ORG} in ("${org.organization.code}") and ${AF.IN_USE} in ("${AF.IN_USE_VALUE}")`'));
  assert.ok(!signingSrc.includes("'簽核流程名稱'"), '欄位代碼不寫死');
});

check('拼名稱用的舊規則都已刪除：補前綴（ORG_PARENT_MAP）、Sales Team 改寫、聯海縮寫、processOrgName', () => {
  ['ORG_PARENT_MAP', 'ORG_PARENT_ENTRIES', 'ORG_SEP', 'SUBUNIT_REQUIRED_CHILDREN', 'processOrgName', 'modifiedOrgName', "'Sales '", "'聯海'"].forEach((s) => {
    assert.ok(!signingSrc.includes(s), `不應再有 ${s}`);
  });
});

console.log(`\n${passed} assertions passed.`);
