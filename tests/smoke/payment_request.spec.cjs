'use strict';

// 冒煙測試：打包後的桌面版 bundle 在瀏覽器裡跑得起來，主要流程走得通（不連真的 kintone）。
//   1. 載入 bundle：沒有例外、新增畫面的 show／submit 都有處理程式
//   2. 新增畫面 show：不丟例外、付款日期鎖住
//   3. 改費用歸屬：轉大寫、輸入框下方出現中文名稱
//   4. 存檔驗證失敗：event.error＝儲存失敗、跳出「表單驗證失敗」視窗列出問題，按「我知道了」關閉
//   5. 存檔資料正確：沒有 event.error、沒有錯誤視窗
// 欄位代碼、App 一律從 window.PR_CONFIG 取（不寫死），模組改檔名也不影響（只載入 dist bundle）。
// page.evaluate 裡的函式在瀏覽器執行，用得到 window／document：
/* global window, document */

const { test, expect } = require('@playwright/test');
const { openSmokePage } = require('./smoke_page.cjs');

const COST_CODE = 'AJ30';
const COST_NAME = '冒煙測試課';

/** 費用歸屬主檔（APPS.COST_CENTER）放一筆使用中的代碼 */
const seedCostCenter = (page) =>
  page.evaluate(
    ({ code, name }) => {
      const CC = window.PR_CONFIG.REF_FIELDS.COST_CENTER;
      window.__smoke.db.COST_CENTER = [
        { $id: { value: '1' }, [CC.CODE]: { value: code }, [CC.NAME]: { value: name }, [CC.DEPT]: { value: '' }, [CC.IN_USE]: { value: '使用中' } },
      ];
    },
    { code: COST_CODE, name: COST_NAME },
  );

/**
 * 在目前這筆記錄上改欄位後觸發事件（同一筆記錄跨事件沿用，像 kintone 的畫面）。
 * type 裡的 {EXPENSE} 換成子表格「費用歸屬」欄位代碼。patch：company／payMethod／expenses（每列費用歸屬代碼）
 */
const fire = (page, type, patch = {}) =>
  page.evaluate(
    async ({ type, patch }) => {
      const F = window.PR_CONFIG.FIELDS;
      const T = F.TRAFFIC_TABLE;
      const s = window.__smoke;
      const record = s.record || s.makeRecord({});
      if ('company' in patch) record[F.COMPANY_NAME] = { type: 'SINGLE_LINE_TEXT', value: patch.company };
      if ('payMethod' in patch) record[F.PAY_METHOD] = { type: 'CHECK_BOX', value: patch.payMethod };
      if ('expenses' in patch) {
        record[T.CODE] = {
          type: 'SUBTABLE',
          value: patch.expenses.map((code, i) => ({ id: String(i + 1), value: { [T.COLS.EXPENSE]: { type: 'SINGLE_LINE_TEXT', value: code } } })),
        };
      }
      const ev = await s.fire(type.replace('{EXPENSE}', T.COLS.EXPENSE), { record });
      return {
        error: ev.error ?? null,
        expenses: (ev.record[T.CODE]?.value || []).map((row) => row.value[T.COLS.EXPENSE].value),
        paymentDateDisabled: ev.record[F.PAYMENT_DATE]?.disabled === true,
      };
    },
    { type, patch },
  );

let pageErrors;
test.beforeEach(async ({ page }) => {
  pageErrors = await openSmokePage(page);
  await seedCostCenter(page);
});
test.afterEach(async ({ page }) => {
  const runtimeErrors = await page.evaluate(() => window.__smoke.errors);
  expect([...pageErrors, ...runtimeErrors]).toEqual([]);
});

test('bundle 載入：設定與事件都註冊好', async ({ page }) => {
  const info = await page.evaluate(() => ({
    config: typeof window.PR_CONFIG?.FIELDS,
    kt: typeof window.PR_KT?.on,
    show: window.__smoke.handlerCount('app.record.create.show'),
    submit: window.__smoke.handlerCount('app.record.create.submit'),
  }));
  expect(info.config).toBe('object');
  expect(info.kt).toBe('function');
  expect(info.show).toBeGreaterThan(0);
  expect(info.submit).toBeGreaterThan(0);
});

test('新增畫面 show：不丟例外、付款日期鎖住', async ({ page }) => {
  const show = await fire(page, 'app.record.create.show', { expenses: [COST_CODE] });
  expect(show.error).toBeNull();
  expect(show.paymentDateDisabled).toBe(true);
});

test('改費用歸屬：轉大寫並顯示中文名稱', async ({ page }) => {
  await fire(page, 'app.record.create.show', { expenses: [''] });
  // 子表格輸入框（main 依畫面上 input 的值找到要掛提示的格子）
  await page.evaluate((code) => {
    document.getElementById('smoke-record').innerHTML = `<table class="subtable-gaia"><tr><td><input type="text" value="${code}"></td></tr></table>`;
  }, COST_CODE.toLowerCase());
  const change = await fire(page, 'app.record.create.change.{EXPENSE}', { expenses: [COST_CODE.toLowerCase()] });
  expect(change.error).toBeNull();
  expect(change.expenses).toEqual([COST_CODE]);
  await expect(page.locator('#smoke-record td .department-hint')).toHaveText(COST_NAME);
});

test('存檔驗證失敗：跳出錯誤視窗列出問題', async ({ page }) => {
  await fire(page, 'app.record.create.show', { expenses: [''] });
  const submit = await fire(page, 'app.record.create.submit', { company: '', payMethod: [], expenses: ['ZZ99'] });
  expect(submit.error).toBe('儲存失敗');
  const popup = page.locator('.pr-validation-popup');
  await expect(popup).toBeVisible();
  await expect(popup.locator('.swal2-title')).toHaveText('表單驗證失敗');
  await expect(popup.locator('.pr-validation-item')).not.toHaveCount(0);
  await expect(popup).toContainText('付款方式');
  await expect(popup).toContainText('ZZ99');
  await popup.getByRole('button', { name: '我知道了' }).click();
  await expect(popup).toBeHidden();
});

test('存檔資料正確：沒有錯誤、不跳錯誤視窗', async ({ page }) => {
  await fire(page, 'app.record.create.show', { expenses: [COST_CODE] });
  const submit = await fire(page, 'app.record.create.submit', { payMethod: ['電匯'], expenses: [COST_CODE] });
  const shown = await page.evaluate(() => window.__smoke.swalCalls.filter((c) => c.icon === 'error').map((c) => `${c.title}: ${c.html || c.text}`));
  expect(shown).toEqual([]);
  expect(submit.error).toBeNull();
  await expect(page.locator('.pr-validation-popup')).toHaveCount(0);
});
