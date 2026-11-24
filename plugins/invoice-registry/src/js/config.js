/*
 * 發票登記 plug-in：設定頁
 * 設定存成一個 JSON（config 鍵），格式見 core.js 的 parseConfig。
 */
(function (PLUGIN_ID) {
  'use strict';

  const Core = window.NXInvoiceRegistry;
  const $ = (id) => document.getElementById(id);
  const appId = kintone.app.getId();

  const FIELD_LABELS = {
    INVOICE: '發票號碼（值不可重複）',
    OWNER_APP: '請款單 App ID',
    OWNER_ID: '請款單記錄號碼',
    TOKEN: '儲存鍵',
    CREATED: '建立時間',
    ORIGINAL: '原發票號碼',
    VOIDED: '作廢（下拉：是）',
    VOID_REASON: '作廢原因（下拉）',
  };

  let saved = {};
  try {
    saved = JSON.parse(kintone.plugin.app.getConfig(PLUGIN_ID)?.config || '{}') || {};
  } catch (e) {
    saved = {};
  }

  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    Object.assign(node, props);
    children.forEach((c) => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return node;
  };

  /** 下拉選單：fields 為 [{ code, label }]，第一個選項為空白 */
  const fillSelect = (select, fields, value, blankText = '（不使用）') => {
    select.replaceChildren(el('option', { value: '', textContent: blankText }), ...fields.map((f) => el('option', { value: f.code, textContent: `${f.label}（${f.code}）` })));
    select.value = fields.some((f) => f.code === value) ? value : '';
  };

  // 發票登記 App 的欄位代碼
  const fieldInputs = {};
  Object.entries(Core.DEFAULT_REGISTRY_FIELDS).forEach(([key, def]) => {
    const input = el('input', { className: 'nx-ir__input', type: 'text', value: saved.fields?.[key] || def, id: `nx-ir-field-${key}` });
    fieldInputs[key] = input;
    $('nx-ir-fields').append(el('label', { className: 'nx-ir__label', htmlFor: input.id, textContent: FIELD_LABELS[key] }), input);
  });

  $('nx-ir-registry').value = saved.registryApp || '';
  $('nx-ir-ttl').value = saved.pendingTtlMinutes || '';
  $('nx-ir-self-void').value = (saved.self?.voidStatuses || []).join(', ');

  // 本 App 的欄位（從表單設定讀；設定頁看的是還沒部署的表單）
  kintone
    .api(kintone.api.url('/k/v1/preview/app/form/fields', true), 'GET', { app: appId })
    .then((resp) => {
      const all = Object.values(resp.properties || {});
      const pick = (types) => all.filter((f) => types.includes(f.type)).map((f) => ({ code: f.code, label: f.label }));
      fillSelect($('nx-ir-self-invoice'), pick(['SINGLE_LINE_TEXT', 'MULTI_LINE_TEXT']), saved.self?.invoiceField, '（請選擇）');
      fillSelect($('nx-ir-self-status'), pick(['STATUS', 'DROP_DOWN', 'RADIO_BUTTON', 'SINGLE_LINE_TEXT']), saved.self?.statusField);
      fillSelect($('nx-ir-self-voidcheck'), pick(['CHECK_BOX']), saved.self?.voidCheckField);
    })
    .catch((err) => {
      $('nx-ir-error').textContent = `讀不到本 App 的欄位：${err?.message || err}`;
    });

  const isId = (v) => /^\d+$/.test(v);

  $('nx-ir-save').addEventListener('click', () => {
    const errors = [];
    const registryApp = $('nx-ir-registry').value.trim();
    if (!isId(registryApp)) errors.push('發票登記 App ID 要填數字');
    const ttl = $('nx-ir-ttl').value.trim();
    if (ttl && !(Number(ttl) > 0)) errors.push('分鐘數要大於 0');
    const self = {
      invoiceField: $('nx-ir-self-invoice').value,
      statusField: $('nx-ir-self-status').value,
      voidStatuses: $('nx-ir-self-void').value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean),
      voidCheckField: $('nx-ir-self-voidcheck').value,
    };
    if (!self.invoiceField) errors.push('請選擇本 App 的發票號碼記錄欄位');
    const fields = {};
    Object.entries(fieldInputs).forEach(([key, input]) => {
      const v = input.value.trim();
      if (!v) errors.push(`發票登記 App 的「${FIELD_LABELS[key]}」欄位代碼必填`);
      fields[key] = v;
    });
    if (errors.length > 0) {
      $('nx-ir-error').textContent = errors.join('\n');
      return;
    }
    const token = $('nx-ir-ea-token').value.trim();
    const config = { registryApp, pendingTtlMinutes: ttl || String(Core.DEFAULT_TTL_MINUTES), fields, self, employeeAccountProxy: Boolean(token) || Boolean(saved.employeeAccountProxy) };
    const done = () => kintone.plugin.app.setConfig({ config: JSON.stringify(config) });
    if (!token) {
      done();
      return;
    }
    // 代理設定（Token 存在伺服器端）：檢視、新增、編輯各一筆，依序存完再存一般設定
    const origin = location.origin;
    const headers = { 'X-Cybozu-API-Token': token, 'Content-Type': 'application/json' };
    const rules = [
      [`${origin}/k/v1/records.json`, 'GET'],
      [`${origin}/k/v1/record.json`, 'POST'],
      [`${origin}/k/v1/record.json`, 'PUT'],
    ];
    const next = (i) => {
      if (i >= rules.length) {
        done();
        return;
      }
      kintone.plugin.app.setProxyConfig(rules[i][0], rules[i][1], headers, {}, () => next(i + 1));
    };
    next(0);
  });

  $('nx-ir-cancel').addEventListener('click', () => {
    window.location.href = `../../${appId}/plugin/`;
  });
})(kintone.$PLUGIN_ID);
