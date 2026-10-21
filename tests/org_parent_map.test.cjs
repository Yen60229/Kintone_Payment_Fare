'use strict';

// 回歸測試：signing_personnel_manager_20260506.js 的 processOrgName
//   「所／中心 → 上層部」的對應來自 C.SIGNING.ORG_PARENT_MAP（單一事實來源在 config）。
//   本測試鎖住：對應表內容、補前綴的比對條件（含裸名不對稱）、聯海縮寫規則、
//   以及依職稱改寫簽核流程名稱的各條規則。
// 直接用 Node 執行：node tests/org_parent_map.test.cjs
//
// 作法：從原始檔擷取 processOrgName 本體隔離執行。

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
// 正規化行尾：repo 內 LF／CRLF 混用（git 亦會自動轉換），regex 擷取需先統一
const readSrc = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8').replace(/\r\n/g, '\n');
const signingSrc = readSrc('signing_personnel_manager_20260506.js');
const configSrc = readSrc('payment_request_config.js');

// 載入 config 取得 ORG_PARENT_MAP 實際值
global.window = {};
global.kintone = { app: { getId: () => 749 }, getLoginUser: () => ({ code: 'x' }) };
// eslint-disable-next-line no-eval
eval(configSrc);
const C = global.window.PR_CONFIG;

const extract = (re, label) => {
  const m = signingSrc.match(re);
  assert.ok(m, `找不到 ${label}，來源檔可能已改結構，請同步更新本測試`);
  return m[0];
};

const fnSrc = extract(/function processOrgName\(orgName, org, title\) \{[\s\S]*?\n  \}/, 'processOrgName');

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log('org_parent_map.test.cjs');

// 注入 processOrgName 依賴的模組層常數（和原始檔的定義方式相同）
const processOrgName = new Function(`
  const C = arguments[0];
  const ORG_PARENT_ENTRIES = Object.entries(C.SIGNING.ORG_PARENT_MAP);
  const ORG_SEP = C.SIGNING.ORG_NAME_SEPARATOR;
  const SUBUNIT_REQUIRED_CHILDREN = ['桃園機場營業所', '新竹營業所'];
  ${fnSrc}
  return processOrgName;
`)(C);

check('帶子單位的「所」會補上層部門前綴', () => {
  assert.strictEqual(processOrgName('桃園機場營業所-作業課', '', ''), '航空貨物部-桃園機場營業所-作業課');
  assert.strictEqual(processOrgName('新竹營業所-業務課', '', ''), '航空貨物部-新竹營業所-業務課');
});

check("新竹營業所-Sales Team 的特例：補前綴後再把 'Sales ' 改寫為 '營業'", () => {
  assert.strictEqual(processOrgName('新竹營業所-Sales Team', '', ''), '航空貨物部-新竹營業所-營業Team');
});

check('裸名的不對稱行為必須維持（桃園機場營業所／新竹營業所 不補前綴）', () => {
  // 簽核流程主檔是否存在裸名的簽核流程名稱無法查證，若哪天要「修正」成一律補前綴，
  // 必須是有意識的決定並同步更新本斷言。
  assert.strictEqual(processOrgName('桃園機場營業所', '', ''), '桃園機場營業所');
  assert.strictEqual(processOrgName('新竹營業所', '', ''), '新竹營業所');
});

check('裸名的「中心」則要補前綴（與上一條相反）', () => {
  assert.strictEqual(processOrgName('併裝中心', '', ''), '事業本部-併裝中心');
  assert.strictEqual(processOrgName('事業企劃室', '', ''), '事業企劃室');
});

check('聯海通運股份有限公司 → 聯海（縮寫規則，不套 ORG_PARENT_MAP）', () => {
  assert.strictEqual(processOrgName('聯海通運股份有限公司', '', ''), '聯海');
  assert.strictEqual(processOrgName('聯海通運股份有限公司', '', '').includes('-'), false);
});

check('未列於 ORG_PARENT_MAP 的組織一律原樣返回（含空字串）', () => {
  ['航空貨物部-台北營業課', '海運貨物部-台北營業課', '總務部-總務課', '物流部-桃園NEXT1倉庫', '高雄營業部-台南營業所', '汽車貨運部', '事業本部', '安全品質推動部', ''].forEach(
    (name) => {
      assert.strictEqual(processOrgName(name, '', ''), name);
    },
  );
});

check('職稱與組織都有值才套用「依職稱改寫簽核流程名稱」的規則；只給一邊不套', () => {
  assert.strictEqual(processOrgName('物流部', '物流部', ''), '物流部');
  assert.strictEqual(processOrgName('物流部', '', '次長'), '物流部');
  assert.strictEqual(processOrgName('物流部', '物流部', '次長'), '物流部次長級');
});

check('依職稱改寫：各部次長級、部長合併名稱', () => {
  const cases = [
    ['物流部-桃園NEXT1倉庫', '物流部-桃園NEXT1倉庫', '次長', '物流部次長級'],
    ['航空貨物部', '航空貨物部', '次長', '航空貨物部次長(所長)級'],
    ['桃園機場營業所', '桃園機場營業所', '所長', '航空貨物部次長(所長)級'],
    ['新竹營業所', '新竹營業所', '次長', '航空貨物部次長(所長)級'],
    ['海運貨物部', '海運貨物部', '次長', '海運貨物部次長級'],
    ['總務部', '總務部', '次長', '總務部次長級'],
    ['汽車貨運部', '汽車貨運部', '部長', '物流部長/汽車貨運部長'],
    ['物流部', '物流部', '部長', '物流部長/汽車貨運部長'],
    ['海運貨物部', '海運貨物部', '部長', '海運貨物部長/航空貨物部長'],
    ['航空貨物部', '航空貨物部', '部長', '海運貨物部長/航空貨物部長'],
    ['安全品質推動部', '安全品質推動部', '部長', '安全品質推動部長/營業戰略部長/總務部長/事業本部長'],
    ['營業戰略部', '營業戰略部', '部長', '安全品質推動部長/營業戰略部長/總務部長/事業本部長'],
    ['總務部', '總務部', '部長', '安全品質推動部長/營業戰略部長/總務部長/事業本部長'],
    ['事業本部', '事業本部', '部長', '安全品質推動部長/營業戰略部長/總務部長/事業本部長'],
    ['事業本部', '事業本部', '次長', '台中營業部長/高雄營業部長/事業本部次長(中心長)級'],
    ['台中營業部', '台中營業部', '部長', '台中營業部長/高雄營業部長/事業本部次長(中心長)級'],
    ['高雄營業部', '高雄營業部', '部長', '台中營業部長/高雄營業部長/事業本部次長(中心長)級'],
    ['安全品質推動部', '安全品質推動部', '次長', '安全品質推動部次長級'],
    ['高雄營業部', '高雄營業部', '次長', '高雄營業部次長級'],
    ['台中營業部', '台中營業部', '次長', '台中營業部次長級'],
  ];
  cases.forEach(([orgName, org, title, expected]) => {
    assert.strictEqual(processOrgName(orgName, org, title), expected, `${orgName} / ${title}`);
  });
});

check('同一個部門、職稱是課長／課員時不改寫（沿用補前綴後的名稱）', () => {
  assert.strictEqual(processOrgName('總務部-總務課', '總務部-總務課', '課長'), '總務部-總務課');
  assert.strictEqual(processOrgName('新竹營業所-業務課', '新竹營業所-業務課', '課員'), '航空貨物部-新竹營業所-業務課');
});

// ── 結構斷言：確認確實改接 config，沒有留下寫死的部門名稱 ──────────────────
check('signing 的 processOrgName 讀 C.SIGNING.ORG_PARENT_MAP／ORG_NAME_SEPARATOR，不再寫死上層部門名稱', () => {
  assert.ok(/ORG_PARENT_ENTRIES = Object\.entries\(C\.SIGNING\.ORG_PARENT_MAP\)/.test(signingSrc), 'signing 應從 config 取得 ORG_PARENT_MAP');
  assert.ok(/ORG_SEP = C\.SIGNING\.ORG_NAME_SEPARATOR/.test(signingSrc), 'signing 應從 config 取得分隔字元');
  assert.ok(!/ENT_SIGN/.test(signingSrc), '不應再引用 ENT_SIGN');
  assert.ok(!/modifiedOrgName = `航空貨物部-\$\{orgName\}`/.test(signingSrc), '不應再有寫死的「航空貨物部-${orgName}」');
  assert.ok(!/modifiedOrgName = `事業本部-\$\{orgName\}`/.test(signingSrc), '不應再有寫死的「事業本部-${orgName}」');
});

check('config 的 SIGNING：ORG_PARENT_MAP 共 3 筆、分隔字元 "-"、聯海縮寫不在對應表內', () => {
  assert.deepStrictEqual(C.SIGNING.ORG_PARENT_MAP, {
    桃園機場營業所: '航空貨物部',
    新竹營業所: '航空貨物部',
    併裝中心: '事業本部',
  });
  assert.strictEqual(C.SIGNING.ORG_NAME_SEPARATOR, '-');
  assert.ok(!Object.keys(C.SIGNING.ORG_PARENT_MAP).includes('聯海通運股份有限公司'));
});

console.log(`\n${passed} assertions passed.`);
