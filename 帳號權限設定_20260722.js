/**
 * 帳號權限設定（APPS.PERMISSION）
 *
 * 從「帳號權限設定 App（APPS.PERMISSION）」讀取本表單的規則，
 * 依「登入者帳號 / 所屬組織」與「目前流程狀態」，
 * 決定哪些欄位可見、可編輯、必填，並在儲存時驗證必填欄位。
 * 依「誰在操作 / 現在是哪個流程步驟」設定欄位權限（角色基準）
 *
 * ⚠️ 部署 / 環境注意：
 *   - SETTINGS_APP_ID = PR_CONFIG.APPS.PERMISSION：權限設定 App。內每筆記錄以 APP_ID 欄位對應「表單 App」，
 *   - DEBUG = true：會輸出 [KDEBUG] console；正式環境請改為 false。
 *   - 本模組僅綁桌面版事件，未含 mobile.*；行動版不套用此權限控管。
 * ============================================================
 */
(function () {
  ('use strict');

  /* =========================================================
   * 一、基本設定
   * ========================================================= */

  const SETTINGS_APP_ID = window.PR_CONFIG.APPS.PERMISSION;
  const APP_ID_FIELD = 'APP_ID';
  const STATUS_FIELD = window.PR_CONFIG.FIELDS.STATUS_FIELD;
  const DEBUG = false;

  const RULE_TYPE = {
    ACCOUNT: 'ACCOUNT',
    ORG: 'ORG',
  };

  const ENABLE_ON = '使用中';
  const SHOW = '顯示';
  const HIDE = '隱藏';
  const EDIT = '編輯';
  const REQUIRED = '必填';

  const EVENTS_SHOW = [
    'app.record.create.show',
    'app.record.edit.show',
    'app.record.detail.show',
    'app.record.print.show',
    'app.record.index.edit.show'
  ];

  const EVENTS_SUBMIT = ['app.record.create.submit', 'app.record.edit.submit'];

  /* =========================================================
   * 二、權限設定 App 欄位代碼設定
   * ========================================================= */

  const ACCOUNT_RULE = {
    table: ['帳號權限設定'],
    target: ['帳號權限'],
    fieldType: ['帳號欄位屬性'],
    fields: ['帳號欄位設定', '欄位設定'],
    coverValues: ['帳號欄位涵蓋值'],
    show: ['帳號顯示選項', '顯示選項'],
    perm: ['帳號權限選項', '權限選項'],
    required: ['帳號欄位必填'],
    status: ['帳號狀態設定', '狀態設定'],
    enable: ['帳號使用狀況', '使用狀況'],
  };

  const ORG_RULE = {
    table: ['組織權限設定'],
    target: ['組織權限'],
    fieldType: ['組織欄位型態'],
    fields: ['組織欄位設定', '欄位設定'],
    coverValues: ['組織欄位涵蓋值'],
    show: ['組織顯示選項', '顯示選項'],
    perm: ['組織權限選項', '權限選項'],
    required: ['組織欄位必填'],
    status: ['組織狀態設定', '狀態設定'],
    enable: ['組織使用狀況', '使用狀況'],
  };

  /* =========================================================
   * 三、欄位型態與自動行為
   * ========================================================= */

  const FIELD_KIND = {
    NUMBER: '數值欄位',
    RELATED: '相關記錄清單欄位',
    SPACER: '空白欄元素',
    GROUP: '群組欄位',
    TABLE: '表格欄位',
  };

  const FIELD_ACTION = {
    NONE: 'NONE',
    SKIP: 'SKIP',
  };

  const FIELD_TYPE_BEHAVIOR = {
    [FIELD_KIND.NUMBER]: FIELD_ACTION.NONE,
    [FIELD_KIND.RELATED]: FIELD_ACTION.NONE,
    [FIELD_KIND.SPACER]: FIELD_ACTION.SKIP,
    [FIELD_KIND.GROUP]: FIELD_ACTION.SKIP,
    [FIELD_KIND.TABLE]: FIELD_ACTION.SKIP,
  };

  const MATCH_RESULT = {
    MATCH: 'MATCH',
    NO_MATCH: 'NO_MATCH',
    EMPTY: 'EMPTY',
  };

  const toStr = (value) => String(value || '').trim();
  const toArr = (value) => (Array.isArray(value) ? value : []);

  const log = (...args) => {
    if (DEBUG) console.log('[KDEBUG]', ...args);
  };

  const warn = (...args) => {
    if (DEBUG) console.warn('[KDEBUG]', ...args);
  };

  // parseArr 結果記憶化：同一份權限設定字串可能在「欄位型態蒐集」與「規則套用」兩階段重複解析，
  // 以原字串為鍵快取凍結陣列（呼叫端僅讀取，不可變動）。權限設定字串為有限集合，快取不會無限成長。
  const _parseArrCache = new Map();
  const parseArr = (text) => {
    const raw = toStr(text);
    if (!raw) return [];
    if (_parseArrCache.has(raw)) return _parseArrCache.get(raw);

    const result = Object.freeze(
      raw
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .replace(/["']/g, '')
        .split(/\r?\n|,|，|;|；|、/g)
        .map((item) => toStr(item))
        .filter(Boolean),
    );
    _parseArrCache.set(raw, result);
    return result;
  };

  const pickField = (row, candidateCodes) => {
    for (const code of candidateCodes) {
      if (row && row[code] !== undefined) {
        return row[code];
      }
    }
    return undefined;
  };

  const getCheckboxValues = (field) => toArr(field?.value);

  const normalizeTargetValues = (items) =>
    toArr(items)
      .flatMap((item) => {
        if (typeof item === 'string' || typeof item === 'number') {
          return [toStr(item)];
        }

        return [
          item?.code,
          item?.name,
          item?.displayName,
          item?.value,
          item?.organization?.code,
          item?.organization?.name,
          item?.user?.code,
          item?.user?.name,
          item?.user?.displayName,
        ].map(toStr);
      })
      .filter(Boolean);

  // 檢查 values 是否有任一元素落在預建的集合內。
  // accountSet / orgSet 於登入者上下文建立時一次建好，避免在逐行規則迴圈中重複建立 Set 物件。
  const someInSet = (values, set) =>
    toArr(values)
      .map(toStr)
      .filter(Boolean)
      .some((value) => set.has(value));

  const getUserCodes = (field) => {
    const raw = toArr(field?.value);
    const codes = normalizeTargetValues(raw);
    log('getUserCodes', { raw, codes });
    return codes;
  };

  const getOrgCodes = (field) => {
    const raw = toArr(field?.value);
    const codes = normalizeTargetValues(raw);
    log('getOrgCodes', { raw, codes });
    return codes;
  };

  const normalizeRecordFieldValue = (field) => {
    if (!field) return [];

    const value = field.value;

    switch (true) {
      case Array.isArray(value):
        return normalizeTargetValues(value);
      case value && typeof value === 'object':
        return normalizeTargetValues([value]);
      default:
        return [toStr(value)].filter(Boolean);
    }
  };

  const isEnabled = (field) => toStr(field?.value) === ENABLE_ON;

  const isStatusMatch = (settingText, currentStatus) => {
    const list = parseArr(settingText);
    if (list.length === 0) return true;
    return !!currentStatus && list.includes(currentStatus);
  };

  const isEmptyValue = (value) => {
    switch (true) {
      case value === null:
      case value === undefined:
        return true;
      case typeof value === 'string' && value.trim() === '':
        return true;
      case Array.isArray(value) && value.length === 0:
        return true;
      default:
        return false;
    }
  };

  const hasShowFlag = (options) => options.includes(SHOW);
  const hasHideFlag = (options) => options.includes(HIDE);
  const hasEditFlag = (options) => options.includes(EDIT);
  const hasRequiredFlag = (options) => options.includes(REQUIRED);

  // 權限設定快取：查詢條件（APP_ID = 當前 App）在整個頁面生命週期固定，
  // 同一張單從 show 至 submit 之間不會變動，以 Promise 快取省略重複 API 呼叫（失敗則清除以便重試）。
  // ⚠️ 管理員在權限設定 App 變更權限規則後，使用者需「重新整理頁面」才會生效。
  let _settingsPromise = null;
  const fetchSettings = async () => {
    const currentAppId = kintone.app.getId();

    const response = await kintone.api(
      kintone.api.url('/k/v1/records.json', true),
      'GET',
      {
        app: SETTINGS_APP_ID,
        query: `${APP_ID_FIELD} = "${currentAppId}"`,
      },
    );

    log('permission settings query result', {
      currentAppId,
      settingsCount: toArr(response.records).length,
      records: response.records,
    });

    return toArr(response.records);
  };

  const getSettings = () => {
    if (_settingsPromise) return _settingsPromise;
    _settingsPromise = fetchSettings().catch((error) => {
      _settingsPromise = null; // 失敗不快取，下次重試
      throw error;
    });
    return _settingsPromise;
  };

  // 登入者上下文：頁面整個工作階段不會變動，以 Promise 快取永久重用（失敗則清除以便重試）。
  // accountSet / orgSet 於此處一次建立，供 matchTarget 在逐行規則迴圈中直接查詢，免去重複建立 Set 物件。
  let _loginContextPromise = null;
  const fetchLoginContext = async () => {
    const loginUser = kintone.getLoginUser();
    const userCode = toStr(loginUser?.code);
    const userName = toStr(loginUser?.name);

    let organizations = [];
    try {
      organizations = await kintone.user.getOrganizations(userCode);
    } catch (error) {
      organizations = [];
      warn('getOrganizations fail', error);
    }

    const orgCodes = [];
    const orgNames = [];

    organizations.forEach((org) => {
      const code = toStr(org?.code || org?.organization?.code);
      const name = toStr(org?.name || org?.organization?.name);

      if (code) orgCodes.push(code);
      if (name) orgNames.push(name);
    });

    const accountSet = new Set([userCode, userName].map(toStr).filter(Boolean));
    const orgSet = new Set(
      [...orgCodes, ...orgNames].map(toStr).filter(Boolean),
    );

    log('loginContext', {
      userCode,
      userName,
      orgCodes,
      orgNames,
      organizations,
    });

    return { userCode, userName, orgCodes, orgNames, accountSet, orgSet };
  };

  const getLoginContext = () => {
    if (_loginContextPromise) return _loginContextPromise;
    _loginContextPromise = fetchLoginContext().catch((error) => {
      _loginContextPromise = null; // 失敗不快取，下次重試
      throw error;
    });
    return _loginContextPromise;
  };

  const getRuleConfig = (type) => {
    switch (type) {
      case RULE_TYPE.ACCOUNT:
        return {
          ...ACCOUNT_RULE,
          targetGetter: getUserCodes,
        };
      case RULE_TYPE.ORG:
        return {
          ...ORG_RULE,
          targetGetter: getOrgCodes,
        };
      default:
        return null;
    }
  };

  const matchTarget = (type, targets, loginContext) => {
    if (targets.length === 0) {
      return MATCH_RESULT.EMPTY;
    }

    switch (type) {
      case RULE_TYPE.ACCOUNT: {
        const matched = someInSet(targets, loginContext.accountSet);
        return matched ? MATCH_RESULT.MATCH : MATCH_RESULT.NO_MATCH;
      }

      case RULE_TYPE.ORG: {
        const matched = someInSet(targets, loginContext.orgSet);
        return matched ? MATCH_RESULT.MATCH : MATCH_RESULT.NO_MATCH;
      }

      default:
        return MATCH_RESULT.NO_MATCH;
    }
  };

  const matchCoverValues = (field, coverValuesText) => {
    const coverValues = parseArr(coverValuesText);

    if (coverValues.length === 0) {
      return MATCH_RESULT.EMPTY;
    }

    const localValues = normalizeRecordFieldValue(field);
    const matched = localValues.some((value) => coverValues.includes(value));

    log('matchCoverValues', {
      coverValues,
      localValues,
      matched,
    });

    return matched ? MATCH_RESULT.MATCH : MATCH_RESULT.NO_MATCH;
  };

  const createFieldState = () => ({
    visible: false,
    editable: false,
    required: false,

    matchedByAccount: false,
    matchedByOrg: false,

    accountVisibleSet: false,
    accountEditableSet: false,
    accountRequiredSet: false,

    orgVisibleSet: false,
    orgEditableSet: false,
    orgRequiredSet: false,
  });

  const ensureFieldState = (map, fieldCode) => {
    if (!map[fieldCode]) {
      map[fieldCode] = createFieldState();
    }
    return map[fieldCode];
  };

  const collectConfiguredFieldMeta = (settings) => {
    const fieldMetaMap = {};

    [RULE_TYPE.ACCOUNT, RULE_TYPE.ORG].forEach((ruleType) => {
      const config = getRuleConfig(ruleType);

      settings.forEach((record, recordIndex) => {
        const tableField = pickField(record, config.table);
        const rows = toArr(tableField?.value);

        log(`collect meta ${ruleType}`, {
          recordIndex,
          tableCandidates: config.table,
          rowCount: rows.length,
        });

        rows.forEach((rowItem, rowIndex) => {
          const row = rowItem?.value || {};
          const rawFields = pickField(row, config.fields)?.value;
          const fieldCodes = parseArr(rawFields);
          const configuredType = toStr(pickField(row, config.fieldType)?.value);

          log(`collect meta row ${ruleType} [${recordIndex}:${rowIndex}]`, {
            rawFields,
            fieldCodes,
            configuredType,
            rowKeys: Object.keys(row),
          });

          fieldCodes.forEach((fieldCode) => {
            const code = toStr(fieldCode);
            if (code) {
              fieldMetaMap[code] = { code, configuredType };
            }
          });
        });
      });
    });

    log('fieldMetaMap', fieldMetaMap);
    return fieldMetaMap;
  };

  const initControlMap = (fieldMetaMap) => {
    const map = {};
    Object.keys(fieldMetaMap).forEach((fieldCode) => {
      map[fieldCode] = createFieldState();
    });
    return map;
  };

  const getFieldBehaviorByConfiguredType = (configuredType) => {
    return FIELD_TYPE_BEHAVIOR[configuredType] || FIELD_ACTION.NONE;
  };

  const getFieldBehavior = (configuredType) => {
    const configuredBehavior = getFieldBehaviorByConfiguredType(configuredType);

    switch (configuredBehavior) {
      case FIELD_ACTION.SKIP:
        return configuredBehavior;
      default:
        return FIELD_ACTION.NONE;
    }
  };

  const isRelatedFieldType = (configuredType) => {
    return toStr(configuredType) === FIELD_KIND.RELATED;
  };

  const cssEscape = (value) => {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, '\\$&');
  };

  const setRelatedFieldShown = (fieldCode, shown) => {
    try {
      kintone.app.record.setFieldShown(fieldCode, shown);
    } catch (error) {
      warn(`setFieldShown related failed: ${fieldCode}`, error);
    }

    const applyDomShown = () => {
      try {
        const fieldElement = kintone.app.record.getFieldElement(fieldCode);
        if (fieldElement) {
          fieldElement.style.display = shown ? '' : 'none';
          return;
        }

        const escapedCode = cssEscape(fieldCode);
        const domElement = document.querySelector(
          `[data-field-code="${escapedCode}"]`,
        );
        if (domElement) {
          domElement.style.display = shown ? '' : 'none';
        }
      } catch (error) {
        warn(`related DOM shown failed: ${fieldCode}`, error);
      }
    };

    applyDomShown();
    setTimeout(applyDomShown, 100);
    setTimeout(applyDomShown, 500);
  };

  const applyMatchedRule = (
    control,
    showOptions,
    permissionOptions,
    requiredOptions,
    coverMatchResult,
    source,
  ) => {
    const showFlag = hasShowFlag(showOptions);
    const hideFlag = hasHideFlag(showOptions);
    const editFlag = hasEditFlag(permissionOptions);
    const requiredFlag = hasRequiredFlag(requiredOptions);

    log('applyMatchedRule', {
      source,
      showOptions,
      permissionOptions,
      requiredOptions,
      coverMatchResult,
      showFlag,
      hideFlag,
      editFlag,
      requiredFlag,
      before: { ...control },
    });

    switch (source) {
      case RULE_TYPE.ACCOUNT:
        control.matchedByAccount = true;

        if (showFlag) {
          control.visible = true;
          control.accountVisibleSet = true;
        } else if (hideFlag && !control.orgVisibleSet) {
          control.visible = false;
          control.accountVisibleSet = true;
        }

        control.editable = !!editFlag;
        control.accountEditableSet = true;

        if (
          coverMatchResult === MATCH_RESULT.MATCH ||
          coverMatchResult === MATCH_RESULT.EMPTY
        ) {
          control.required = !!requiredFlag;
          control.accountRequiredSet = true;
        }
        break;

      case RULE_TYPE.ORG:
        control.matchedByOrg = true;

        if (showFlag) {
          control.visible = true;
          control.orgVisibleSet = true;
        } else if (hideFlag && !control.accountVisibleSet) {
          control.visible = false;
          control.orgVisibleSet = true;
        }

        if (!control.accountEditableSet) {
          control.editable = !!editFlag;
          control.orgEditableSet = true;
        }

        if (
          !control.accountRequiredSet &&
          (coverMatchResult === MATCH_RESULT.MATCH ||
            coverMatchResult === MATCH_RESULT.EMPTY)
        ) {
          control.required = !!requiredFlag;
          control.orgRequiredSet = true;
        }
        break;
    }

    log('applyMatchedRule result', {
      source,
      after: { ...control },
    });
  };

  const shouldApplyRule = (ruleType, matchResult) => {
    switch (ruleType) {
      case RULE_TYPE.ACCOUNT:
        return matchResult === MATCH_RESULT.MATCH;
      case RULE_TYPE.ORG:
        return (
          matchResult === MATCH_RESULT.MATCH ||
          matchResult === MATCH_RESULT.EMPTY
        );
      default:
        return false;
    }
  };

  const processRules = (
    ruleType,
    settings,
    loginContext,
    currentStatus,
    record,
    controlMap,
  ) => {
    const config = getRuleConfig(ruleType);

    settings.forEach((recordItem) => {
      const tableField = pickField(recordItem, config.table);
      const rows = toArr(tableField?.value);

      rows.forEach((rowItem) => {
        const row = rowItem?.value || {};

        const enableField = pickField(row, config.enable);
        const statusField = pickField(row, config.status);
        const targetField = pickField(row, config.target);
        const fieldsField = pickField(row, config.fields);
        const coverField = pickField(row, config.coverValues);
        const showField = pickField(row, config.show);
        const permField = pickField(row, config.perm);
        const requiredField = pickField(row, config.required);

        const enabled = isEnabled(enableField);
        const statusMatched = isStatusMatch(statusField?.value, currentStatus);
        const targets = config.targetGetter(targetField);
        const matchResult = matchTarget(ruleType, targets, loginContext);
        const fieldCodes = parseArr(fieldsField?.value);
        const coverValuesText = coverField?.value;
        const showOptions = getCheckboxValues(showField);
        const permissionOptions = getCheckboxValues(permField);
        const requiredOptions = getCheckboxValues(requiredField);
        const runnable =
          enabled && statusMatched && shouldApplyRule(ruleType, matchResult);

        log('rule runnable', {
          ruleType,
          enabled,
          currentStatus,
          statusSetting: statusField?.value,
          statusMatched,
          targets,
          matchResult,
          runnable,
        });

        if (!runnable) return;

        fieldCodes.forEach((fieldCode) => {
          const code = toStr(fieldCode);
          if (!code) return;

          const localField = record?.[code];
          const coverMatchResult = matchCoverValues(
            localField,
            coverValuesText,
          );

          const control = ensureFieldState(controlMap, code);
          applyMatchedRule(
            control,
            showOptions,
            permissionOptions,
            requiredOptions,
            coverMatchResult,
            ruleType,
          );
        });
      });
    });
  };

  const applyUI = (event, controlMap, fieldMetaMap) => {
    const record = event.record;
    const eventType = event.type;

    Object.keys(controlMap).forEach((fieldCode) => {
      const control = controlMap[fieldCode];
      const meta = fieldMetaMap[fieldCode];
      const field = record?.[fieldCode];
      const behavior = getFieldBehavior(meta?.configuredType);

      if (behavior === FIELD_ACTION.SKIP) return;

      if (isRelatedFieldType(meta?.configuredType)) {
        setRelatedFieldShown(fieldCode, !!control.visible);
        return;
      }

      try {
        kintone.app.record.setFieldShown(fieldCode, !!control.visible);
      } catch (error) {
        warn(`setFieldShown failed: ${fieldCode}`, error);
      }

      // detail.show 與 print.show 為唯讀頁面，不設 disabled；其餘（create/edit 的 show）皆套用
      const isReadOnlyView = eventType === 'app.record.detail.show' || eventType === 'app.record.print.show';
      if (!isReadOnlyView) {
        if (field) {
          field.disabled = !control.editable;
        }
        // 同時掃描並支援子表格內的明細欄位 disabled 控制
        Object.keys(record).forEach((key) => {
          if (record[key]?.type === 'SUBTABLE' && Array.isArray(record[key].value)) {
            record[key].value.forEach((row) => {
              if (row.value && row.value[fieldCode]) {
                row.value[fieldCode].disabled = !control.editable;
              }
            });
          }
        });
      }
    });

    return event;
  };

  const validateRequiredFields = (event, controlMap) => {
    const record = event.record;
    const missing = [];

    Object.keys(controlMap).forEach((fieldCode) => {
      const control = controlMap[fieldCode];
      const field = record?.[fieldCode];

      if (control.required) {
        if (field) {
          field.error = null;
          if (isEmptyValue(field.value)) {
            field.error = '此欄位為必填';
            missing.push(fieldCode);
          }
        }
        // 同時支援子表格內明細欄位的必填驗證與高亮
        Object.keys(record).forEach((key) => {
          if (record[key]?.type === 'SUBTABLE' && Array.isArray(record[key].value)) {
            record[key].value.forEach((row, rowIndex) => {
              if (row.value && row.value[fieldCode]) {
                row.value[fieldCode].error = null;
                if (isEmptyValue(row.value[fieldCode].value)) {
                  row.value[fieldCode].error = '此欄位為必填';
                  const label = `${fieldCode}(第${rowIndex + 1}列)`;
                  if (!missing.includes(label)) missing.push(label);
                }
              }
            });
          }
        });
      }
    });

    if (missing.length > 0) {
      event.error = '尚有必填欄位未填寫';
    }

    return event;
  };

  const buildPermissionContext = async () => {
    const [settings, loginContext] = await Promise.all([
      getSettings(),
      getLoginContext(),
    ]);

    const fieldMetaMap = collectConfiguredFieldMeta(settings);
    const controlMap = initControlMap(fieldMetaMap);

    return { settings, loginContext, fieldMetaMap, controlMap };
  };

  // onShow / onSubmit 共用前置：建立權限上下文並依「帳號 → 組織」順序跑完兩類規則，
  // 回傳彙整後的 controlMap / fieldMetaMap，交由各事件做最後一步（套 UI / 驗必填）。
  const resolvePermissions = async (event) => {
    const record = event.record;
    const currentStatus = toStr(record?.[STATUS_FIELD]?.value);

    const { settings, loginContext, fieldMetaMap, controlMap } =
      await buildPermissionContext();

    processRules(
      RULE_TYPE.ACCOUNT,
      settings,
      loginContext,
      currentStatus,
      record,
      controlMap,
    );

    processRules(
      RULE_TYPE.ORG,
      settings,
      loginContext,
      currentStatus,
      record,
      controlMap,
    );

    return { controlMap, fieldMetaMap };
  };

  const onShow = async (event) => {
    const { controlMap, fieldMetaMap } = await resolvePermissions(event);
    return applyUI(event, controlMap, fieldMetaMap);
  };

  const onSubmit = async (event) => {
    const { controlMap } = await resolvePermissions(event);
    return validateRequiredFields(event, controlMap);
  };

  kintone.events.on(EVENTS_SHOW, onShow);
  kintone.events.on(EVENTS_SUBMIT, onSubmit);
})();
