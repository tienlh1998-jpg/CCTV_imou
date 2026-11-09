/* =========================================================================
   CCTV Vision Hub v2.0 — view Cài đặt (admin)
   Quyền: admin. Viewer vào trực tiếp sẽ thấy thông báo không đủ quyền.
   Chỉ dùng API/component của core; mọi nội dung động dùng textContent.
   ========================================================================= */
(function () {
  'use strict';

  if (!window.CCTV || !window.CCTV.views) { return; }

  var dom = CCTV.dom;
  var el = dom.el;
  var clear = dom.clear;
  var svg = CCTV.icons.svg;
  var fmt = CCTV.fmt;
  var ui = CCTV.ui;

  var TABS = [
    { id: 'account', label: 'Tài khoản & phiên', icon: 'user', testId: 'settings-tab-account' },
    { id: 'scan', label: 'Quét mạng', icon: 'scanner', testId: 'settings-tab-scan' },
    { id: 'storage', label: 'Lưu trữ & Video', icon: 'hard-drive', testId: 'settings-tab-storage' },
    { id: 'telegram', label: 'Telegram', icon: 'bell', testId: 'settings-tab-telegram' },
    { id: 'system', label: 'Hệ thống', icon: 'server', testId: 'settings-tab-system' },
    { id: 'about', label: 'Giới thiệu', icon: 'info', testId: 'settings-tab-about' }
  ];

  var TAB_BY_ID = {};
  TABS.forEach(function (tab) { TAB_BY_ID[tab.id] = tab; });

  var OPERATIONAL_DEFAULTS = {
    scan_timeout: 2.5,
    deep_scan: true,
    telegram_schedule_enabled: true,
    telegram_schedule_start: '18:00',
    telegram_schedule_end: '07:00',
    telegram_cooldown_seconds: 60,
    telegram_ai_filter_human: true,
    telegram_storage_alerts: true,
    telegram_storage_check_interval: 30,
    alarm_startup_grace_seconds: 15
  };

  var ctxRef = null;
  var bannerHost = null;
  var bodyHost = null;
  var headerRefs = null;
  var tabsCtrl = null;
  var panels = {};
  var activeTab = 'account';
  var fieldHandles = {};
  var secretRefs = {};
  var vlanRefs = null;
  var armedRefs = null;
  var adminNewRef = null;
  var viewData = emptyViewData();
  var draft = null;
  var baseline = null;
  var dirty = false;
  var destroyed = false;
  var loading = false;
  var saving = false;
  var detectingVlans = false;
  var mountToken = 0;

  function emptyViewData() {
    return {
      settings: {},
      secrets: {},
      secretsManagedExternally: false,
      schemaVersion: null,
      health: null,
      status: null,
      alarmStatus: null,
      me: null,
      cameras: [],
      vlans: [],
      vlansScannedAt: null,
      lastUpdatedAt: null
    };
  }

  /* ------------------------------ Utilities ----------------------------- */

  function str(value) {
    return value === undefined || value === null ? '' : String(value);
  }

  function isObj(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function numOr(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }

  function clone(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (err) {
      return value;
    }
  }

  function appendAll(node, children) {
    (children || []).forEach(function (child) {
      if (child !== null && child !== undefined && child !== false) {
        node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
      }
    });
    return node;
  }

  function isAborted(err) {
    return !err || err.code === 'ABORTED' || err.name === 'AbortError';
  }

  function isStale(token) {
    return destroyed || token !== mountToken;
  }

  function errorText(err) {
    if (!err) { return 'Đã xảy ra lỗi.'; }
    var message = err.message || 'Đã xảy ra lỗi.';
    if (err.status === 429 && err.retryAfterSeconds) {
      message += ' Thử lại sau ' + err.retryAfterSeconds + ' giây.';
    }
    return message;
  }

  function toast(message, options) {
    var target = (ctxRef && ctxRef.toast) || ui.toast;
    if (typeof target === 'function') {
      target(message, options || {});
    }
  }

  function notifyError(err) {
    if (isAborted(err) || (err && err.status === 401)) { return; }
    toast(errorText(err), { type: 'error', duration: 8000 });
  }

  function isTestMode() {
    if (viewData.health && viewData.health.mode === 'test') { return true; }
    return !!(viewData.status && viewData.status.app && viewData.status.app.mode === 'test');
  }

  function appVersion() {
    if (viewData.health && viewData.health.app_version) { return String(viewData.health.app_version); }
    if (viewData.status && viewData.status.app && viewData.status.app.version) {
      return String(viewData.status.app.version);
    }
    var info = CCTV.auth.info();
    return info && info.appVersion ? String(info.appVersion) : '—';
  }

  function apiVersion() {
    if (viewData.health && viewData.health.api_version) { return String(viewData.health.api_version); }
    if (viewData.status && viewData.status.app && viewData.status.app.api_version) {
      return String(viewData.status.app.api_version);
    }
    var info = CCTV.auth.info();
    return info && info.apiVersion ? String(info.apiVersion) : '—';
  }

  function versionLabel(value) {
    return value === '—' || value === '' ? '—' : 'v' + value;
  }

  function platformLabel(value) {
    var platform = str(value);
    if (!platform) { return '—'; }
    var lower = platform.toLowerCase();
    if (lower === 'nt' || lower.indexOf('win') === 0) { return 'Windows'; }
    if (lower === 'posix') { return 'Linux/Unix'; }
    if (lower.indexOf('linux') === 0) { return 'Linux'; }
    if (lower === 'darwin' || lower.indexOf('mac') === 0) { return 'macOS'; }
    return platform;
  }

  function ffmpegInfo() {
    if (viewData.health && isObj(viewData.health.ffmpeg)) { return viewData.health.ffmpeg; }
    if (viewData.status && viewData.status.health && isObj(viewData.status.health.ffmpeg)) {
      return viewData.status.health.ffmpeg;
    }
    return null;
  }

  function isInt(value) {
    var n = Number(value);
    return isFinite(n) && Math.floor(n) === n;
  }

  function timePattern(value) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
  }

  function sessionRemaining(expiresAt) {
    if (!expiresAt) { return '—'; }
    var time = new Date(String(expiresAt)).getTime();
    if (!isFinite(time)) { return '—'; }
    var seconds = Math.floor((time - Date.now()) / 1000);
    if (seconds <= 0) { return 'Đã hết hạn'; }
    return fmt.duration(seconds);
  }

  function warningTone(severity) {
    if (severity === 'critical') { return 'danger'; }
    if (severity === 'warning') { return 'warning'; }
    return 'info';
  }

  function diskFreeBytes() {
    var status = viewData.status;
    if (!status) { return null; }
    var candidates = [];
    if (isObj(status.storage)) {
      candidates.push(status.storage.disk_free_bytes, status.storage.disk_free);
      if (isObj(status.storage.disk)) {
        candidates.push(status.storage.disk.free_bytes, status.storage.disk.free);
      }
    }
    candidates.push(status.disk_free_bytes, status.disk_free);
    if (isObj(status.runtime)) {
      candidates.push(status.runtime.disk_free_bytes, status.runtime.disk_free);
    }
    for (var i = 0; i < candidates.length; i += 1) {
      var raw = candidates[i];
      if (raw === undefined || raw === null || raw === '') { continue; }
      var n = Number(raw);
      if (isFinite(n) && n >= 0) { return n; }
    }
    return null;
  }

  function listenerCount() {
    var status = viewData.alarmStatus;
    if (!status) { return null; }
    if (status.listeners_count !== undefined && status.listeners_count !== null) {
      return numOr(status.listeners_count, 0);
    }
    if (Array.isArray(status.active_listeners)) { return status.active_listeners.length; }
    return null;
  }

  function secretBadge(flag) {
    if (flag === true) { return ui.badge('Đã đặt', { tone: 'success' }); }
    if (flag === false) { return ui.badge('Chưa đặt', { tone: 'neutral' }); }
    return ui.badge('Chưa rõ', { tone: 'neutral' });
  }

  function viewerEnabled() {
    if (viewData.me && typeof viewData.me.viewer_login_enabled === 'boolean') {
      return viewData.me.viewer_login_enabled;
    }
    if (viewData.status && viewData.status.config &&
        typeof viewData.status.config.viewer_login_enabled === 'boolean') {
      return viewData.status.config.viewer_login_enabled;
    }
    var info = CCTV.auth.info();
    return info ? info.viewerLoginEnabled !== false : false;
  }

  function mustChangePassword() {
    if (viewData.me && viewData.me.must_change_password === true) { return true; }
    var info = CCTV.auth.info();
    if (info && info.firstRun) { return true; }
    if (viewData.status && viewData.status.config && viewData.status.config.using_bootstrap_password) {
      return true;
    }
    var warnings = viewData.status && Array.isArray(viewData.status.warnings)
      ? viewData.status.warnings : [];
    for (var i = 0; i < warnings.length; i += 1) {
      if (warnings[i] && warnings[i].code === 'BOOTSTRAP_PASSWORD') { return true; }
    }
    return false;
  }

  /* --------------------------- Draft & dirty ---------------------------- */

  function resetDraft(settings) {
    var s = isObj(settings) ? settings : {};
    var armed = Array.isArray(s.telegram_armed_cameras)
      ? s.telegram_armed_cameras.map(function (item) { return str(item); })
      : [];
    var allCameras = armed.length === 0 || armed.indexOf('*') !== -1;
    draft = {
      default_subnet: str(s.default_subnet),
      last_subnets: str(s.last_subnets),
      scan_timeout: s.scan_timeout === undefined || s.scan_timeout === null ? 2.5 : s.scan_timeout,
      deep_scan: s.deep_scan !== false,
      selected_vlans: Array.isArray(s.selected_vlans)
        ? s.selected_vlans.filter(function (item) { return typeof item === 'string'; }).slice(0, 20)
        : [],
      company_vlans: Array.isArray(s.company_vlans)
        ? s.company_vlans.filter(isObj).map(function (item) {
          return {
            vlan: str(item.vlan),
            subnet: str(item.subnet),
            label: str(item.label)
          };
        }).slice(0, 64)
        : [],
      recordings_dir: str(s.recordings_dir),
      snapshots_dir: str(s.snapshots_dir),
      auto_reboot_on_ip_change: s.auto_reboot_on_ip_change === true,
      telegram_enabled: s.telegram_enabled === true,
      telegram_schedule_enabled: s.telegram_schedule_enabled !== false,
      telegram_schedule_start: str(s.telegram_schedule_start) || '18:00',
      telegram_schedule_end: str(s.telegram_schedule_end) || '07:00',
      telegram_cooldown_seconds: s.telegram_cooldown_seconds === undefined || s.telegram_cooldown_seconds === null
        ? 60 : s.telegram_cooldown_seconds,
      telegram_ai_filter_human: s.telegram_ai_filter_human !== false,
      telegram_storage_alerts: s.telegram_storage_alerts !== false,
      telegram_storage_check_interval: s.telegram_storage_check_interval === undefined ||
        s.telegram_storage_check_interval === null ? 30 : s.telegram_storage_check_interval,
      telegram_armed_cameras: allCameras ? [] : armed.filter(function (ip) { return ip !== '*'; }),
      use_all_cameras: allCameras,
      alarm_startup_grace_seconds: s.alarm_startup_grace_seconds === undefined ||
        s.alarm_startup_grace_seconds === null ? 15 : s.alarm_startup_grace_seconds
    };
    baseline = clone(draft);
  }

  function sameValue(a, b) {
    if (a === b) { return true; }
    if (typeof a === 'number' || typeof b === 'number') {
      var na = Number(a);
      var nb = Number(b);
      if (isFinite(na) && isFinite(nb)) { return na === nb; }
    }
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch (err) {
      return false;
    }
  }

  function draftChanged(key) {
    if (!baseline) { return true; }
    return !sameValue(draft[key], baseline[key]);
  }

  function effectiveArmed(source) {
    if (!source) { return []; }
    if (source.use_all_cameras) { return []; }
    return Array.isArray(source.telegram_armed_cameras)
      ? source.telegram_armed_cameras.slice() : [];
  }

  function armedChanged() {
    if (!baseline) { return true; }
    if (!!draft.use_all_cameras !== !!baseline.use_all_cameras) { return true; }
    return !sameValue(effectiveArmed(draft), effectiveArmed(baseline));
  }

  function normalizedVlans(list) {
    return (Array.isArray(list) ? list : []).filter(function (item) {
      return isObj(item) && str(item.subnet).trim();
    }).map(function (item) {
      return {
        vlan: str(item.vlan).slice(0, 16),
        subnet: str(item.subnet).trim(),
        label: str(item.label).slice(0, 64)
      };
    }).slice(0, 64);
  }

  function markDirty() {
    dirty = true;
    updateDirtyUi();
  }

  function updateDirtyUi() {
    if (!headerRefs || destroyed) { return; }
    var canEdit = !!draft && !loading && !saving;
    if (headerRefs.saveBtn) {
      headerRefs.saveBtn.disabled = !canEdit || !dirty;
    }
    if (headerRefs.undoBtn) {
      headerRefs.undoBtn.disabled = !canEdit || !dirty;
    }
    if (headerRefs.dirtyBadge) {
      headerRefs.dirtyBadge.hidden = !dirty;
    }
    if (headerRefs.lastUpdated) {
      headerRefs.lastUpdated.textContent = viewData.lastUpdatedAt
        ? 'Cập nhật ' + fmt.time(viewData.lastUpdatedAt)
        : 'Chưa tải';
    }
  }

  function undoDraft() {
    if (!draft || !baseline || destroyed) { return; }
    draft = clone(baseline);
    dirty = false;
    renderAll();
    updateDirtyUi();
    toast('Đã hoàn tác thay đổi chưa lưu.', { type: 'info' });
  }

  /* ------------------------------ Field UI ------------------------------ */

  function makeCard(options) {
    options = options || {};
    var section = el('section', {
      class: 'c-card',
      attrs: options.testId ? { 'data-testid': options.testId } : null
    });
    if (options.title) {
      var header = el('div', { class: 'c-card__header' });
      var info = el('div');
      var title = el('h2', { class: 'c-card__title' });
      if (options.icon) { title.appendChild(svg(options.icon, { size: 16 })); }
      title.appendChild(el('span', { text: String(options.title) }));
      info.appendChild(title);
      if (options.subtitle) {
        info.appendChild(el('div', { class: 'c-card__subtitle', text: String(options.subtitle) }));
      }
      header.appendChild(info);
      if (options.actions && options.actions.length) {
        var actions = el('div', { class: 'c-card__actions' });
        appendAll(actions, options.actions);
        header.appendChild(actions);
      }
      section.appendChild(header);
    }
    var body = el('div', { class: 'c-card__body c-stack' });
    appendAll(body, options.body || []);
    section.appendChild(body);
    var footer = null;
    if (options.footer && options.footer.length) {
      footer = el('div', { class: 'c-card__footer' });
      appendAll(footer, options.footer);
      section.appendChild(footer);
    }
    return { el: section, body: body, footer: footer };
  }

  function kvRow(dl, label, value) {
    dl.appendChild(el('dt', { text: String(label) }));
    var dd = el('dd');
    if (value instanceof Node) {
      dd.appendChild(value);
    } else {
      dd.textContent = value === undefined || value === null || value === '' ? '—' : String(value);
    }
    dl.appendChild(dd);
  }

  function kvGrid() {
    return el('dl', { class: 'c-kv' });
  }

  function note(text) {
    return el('p', { class: 'c-muted-block', text: String(text) });
  }

  function fieldLabel(text) {
    return el('div', { class: 'c-field__label', text: String(text) });
  }

  function errorSlot(key, tab) {
    var node = el('div', { class: 'c-field__error', attrs: { role: 'alert' } });
    node.hidden = true;
    fieldHandles[key] = {
      handle: {
        setError: function (message) {
          node.hidden = false;
          node.textContent = String(message || 'Giá trị không hợp lệ.');
        },
        clearError: function () {
          node.hidden = true;
          node.textContent = '';
        },
        focus: function () {
          if (node.scrollIntoView) { node.scrollIntoView({ block: 'center' }); }
        }
      },
      tab: tab
    };
    return node;
  }

  function registerField(key, tab, handle) {
    fieldHandles[key] = { handle: handle, tab: tab };
    if (!handle || !handle.input) { return; }
    handle.input.addEventListener('input', function () {
      draft[key] = handle.getValue();
      handle.clearError();
      markDirty();
    });
  }

  function registerSecretField(key, tab, handle) {
    secretRefs[key] = handle;
    fieldHandles[key] = { handle: handle, tab: tab };
    if (handle && handle.input) {
      handle.input.addEventListener('input', function () { markDirty(); });
    }
  }

  function createField(options, key, tab) {
    var handle = ui.field(options);
    if (key) { registerField(key, tab, handle); }
    return handle;
  }

  function createSwitch(options, key, tab) {
    var handle = ui.switch(options);
    if (key) {
      fieldHandles[key] = { handle: null, tab: tab };
      handle.input.addEventListener('change', function () {
        draft[key] = !!handle.isChecked();
        markDirty();
      });
    }
    return handle;
  }

  function clearAllErrors() {
    Object.keys(fieldHandles).forEach(function (key) {
      var meta = fieldHandles[key];
      if (meta && meta.handle && meta.handle.clearError) {
        try { meta.handle.clearError(); } catch (err) { /* bỏ qua */ }
      }
    });
  }

  function clearSecretInputs() {
    Object.keys(secretRefs).forEach(function (key) {
      if (secretRefs[key] && secretRefs[key].setValue) {
        try { secretRefs[key].setValue(''); } catch (err) { /* bỏ qua */ }
      }
    });
  }

  function setFieldError(key, message) {
    var meta = fieldHandles[key];
    if (meta && meta.handle && meta.handle.setError) {
      meta.handle.setError(message);
    }
  }

  function focusField(key) {
    var meta = fieldHandles[key];
    if (!meta) { return; }
    if (meta.tab && meta.tab !== activeTab) { switchTab(meta.tab); }
    if (meta.handle && meta.handle.focus) {
      try { meta.handle.focus(); } catch (err) { /* bỏ qua */ }
    }
  }

  function showServerFieldErrors(fields) {
    var firstKey = null;
    var unmapped = [];
    Object.keys(fields || {}).forEach(function (key) {
      var message = str(fields[key]);
      if (fieldHandles[key]) {
        setFieldError(key, message);
        if (!firstKey) { firstKey = key; }
      } else {
        unmapped.push(message);
      }
    });
    if (firstKey) { focusField(firstKey); }
    if (unmapped.length) {
      toast(unmapped[0], { type: 'error', duration: 8000 });
    }
  }

  function passwordStrength(value) {
    var text = str(value);
    var categories = 0;
    if (/[a-z]/.test(text)) { categories += 1; }
    if (/[A-Z]/.test(text)) { categories += 1; }
    if (/\d/.test(text)) { categories += 1; }
    if (/[^A-Za-z0-9]/.test(text)) { categories += 1; }
    var score = 0;
    if (text.length >= 10) { score += 1; }
    if (categories >= 2) { score += 1; }
    if (categories >= 3) { score += 1; }
    if (text.length >= 14) { score += 1; }
    if (!text) { return { label: 'Chưa nhập', tone: 'neutral' }; }
    if (score <= 1) { return { label: 'Yếu', tone: 'danger' }; }
    if (score <= 2) { return { label: 'Trung bình', tone: 'warning' }; }
    return { label: 'Mạnh', tone: 'success' };
  }

  function updateStrengthBadge(badge, value) {
    if (!badge) { return; }
    var strength = passwordStrength(value);
    badge.textContent = 'Độ mạnh: ' + strength.label;
    badge.setAttribute('data-tone', strength.tone);
  }

  /* ------------------------------- Data --------------------------------- */

  function applySettingsPayload(data) {
    if (data && isObj(data.settings)) {
      viewData.settings = data.settings;
      try { ctxRef.state.set('settings', data.settings); } catch (err) { /* bỏ qua */ }
    }
    if (data && data.schema_version !== undefined) {
      viewData.schemaVersion = data.schema_version;
    }
  }

  function optimisticSecrets(payload) {
    if (!viewData.secrets) { viewData.secrets = {}; }
    if (payload.telegram_bot_token) { viewData.secrets.telegram_bot_token_set = true; }
    if (payload.telegram_chat_id) { viewData.secrets.telegram_chat_id_set = true; }
    if (payload.clear_telegram_bot_token) { viewData.secrets.telegram_bot_token_set = false; }
    if (payload.clear_telegram_chat_id) { viewData.secrets.telegram_chat_id_set = false; }
    if (payload.default_password) { viewData.secrets.default_password_set = true; }
    if (payload.clear_default_password) { viewData.secrets.default_password_set = false; }
  }

  function reloadSettingsQuiet() {
    if (!ctxRef) { return Promise.resolve(null); }
    return ctxRef.api.get('/api/settings', { signal: ctxRef.signal, silent: true })
      .then(function (data) {
        if (destroyed || !data) { return null; }
        if (isObj(data.settings)) {
          viewData.settings = data.settings;
          try { ctxRef.state.set('settings', data.settings); } catch (err) { /* bỏ qua */ }
        }
        if (isObj(data.secrets)) { viewData.secrets = data.secrets; }
        if (typeof data.secrets_managed_externally === 'boolean') {
          viewData.secretsManagedExternally = data.secrets_managed_externally;
        }
        return data;
      })
      .catch(function (err) {
        if (isAborted(err)) { return null; }
        if (err && err.status === 401) { return null; }
        return null;
      });
  }

  function loadData(options) {
    options = options || {};
    var includeSettings = options.includeSettings !== false;
    var ctx = ctxRef;
    var token = mountToken;
    if (!ctx) { return Promise.reject(new Error('View chưa sẵn sàng.')); }

    var settingsPromise = includeSettings
      ? ctx.api.get('/api/settings', { signal: ctx.signal, silent: true })
      : Promise.resolve(null);
    var healthPromise = ctx.api.get('/api/health', {
      signal: ctx.signal, silent: true, timeoutMs: 15000
    }).catch(function () { return null; });
    var statusPromise = ctx.api.get('/api/system/status', {
      signal: ctx.signal, silent: true
    }).catch(function () { return null; });
    var alarmPromise = ctx.api.get('/api/alarm/status', {
      signal: ctx.signal, silent: true
    }).catch(function () { return null; });
    var mePromise = ctx.api.get('/api/auth/me', {
      signal: ctx.signal, silent: true, skipAuthRedirect: true, timeoutMs: 12000
    }).catch(function () { return null; });
    var camerasPromise = ctx.api.get('/api/managed/cameras', {
      signal: ctx.signal, silent: true
    }).catch(function () { return null; });

    return Promise.all([
      settingsPromise, healthPromise, statusPromise, alarmPromise, mePromise, camerasPromise
    ]).then(function (results) {
      if (isStale(token)) { return null; }
      var settingsData = results[0];
      if (settingsData) {
        if (isObj(settingsData.settings)) {
          viewData.settings = settingsData.settings;
          try { ctx.state.set('settings', settingsData.settings); } catch (err) { /* bỏ qua */ }
        }
        if (isObj(settingsData.secrets)) { viewData.secrets = settingsData.secrets; }
        if (typeof settingsData.secrets_managed_externally === 'boolean') {
          viewData.secretsManagedExternally = settingsData.secrets_managed_externally;
        }
        if (settingsData.schema_version !== undefined) {
          viewData.schemaVersion = settingsData.schema_version;
        }
      }
      viewData.health = results[1] || null;
      viewData.status = results[2] || null;
      viewData.alarmStatus = results[3] || null;
      viewData.me = results[4] || null;
      if (results[5] && Array.isArray(results[5].cameras)) {
        viewData.cameras = results[5].cameras;
        try { ctx.state.set('cameras', viewData.cameras); } catch (err) { /* bỏ qua */ }
      } else {
        var cached = ctx.state.get('cameras');
        viewData.cameras = Array.isArray(cached) ? cached : [];
      }
      if (includeSettings && !options.keepDraft) {
        resetDraft(viewData.settings);
        dirty = false;
      }
      viewData.lastUpdatedAt = Date.now();
      return viewData;
    });
  }

  /* ----------------------------- Shell / UI ----------------------------- */

  function buildHeader() {
    var lastUpdated = el('span', { class: 'u-muted u-tabular', text: 'Chưa tải' });
    var dirtyBadge = ui.badge('Chưa lưu', { tone: 'warning' });
    dirtyBadge.hidden = true;

    var refreshBtn = ui.button({
      label: 'Làm mới',
      icon: 'refresh',
      variant: 'secondary',
      size: 'sm',
      testId: 'settings-refresh',
      onClick: function () { refreshAll(refreshBtn); }
    });
    var undoBtn = ui.button({
      label: 'Hoàn tác',
      icon: 'rotate-ccw',
      variant: 'ghost',
      size: 'sm',
      disabled: true,
      testId: 'settings-undo',
      onClick: undoDraft
    });
    var saveBtn = ui.button({
      label: 'Lưu cấu hình',
      icon: 'check',
      variant: 'primary',
      size: 'sm',
      disabled: true,
      testId: 'settings-save',
      onClick: saveAll
    });

    headerRefs = {
      lastUpdated: lastUpdated,
      dirtyBadge: dirtyBadge,
      refreshBtn: refreshBtn,
      undoBtn: undoBtn,
      saveBtn: saveBtn
    };

    var header = ui.pageHeader({
      title: 'Cài đặt',
      subtitle: 'Tài khoản, quét mạng, lưu trữ, Telegram và chẩn đoán hệ thống',
      icon: 'settings',
      testId: 'settings-page-header',
      actions: [dirtyBadge, lastUpdated, refreshBtn, undoBtn, saveBtn]
    });
    return header;
  }

  function renderBanners() {
    if (!bannerHost) { return; }
    clear(bannerHost);

    if (mustChangePassword()) {
      bannerHost.appendChild(ui.banner({
        tone: 'danger',
        title: 'Cần đổi mật khẩu quản trị',
        message: 'Hệ thống đang dùng mật khẩu quản trị khởi tạo hoặc được đánh dấu cần đổi. '
          + 'Hãy đổi mật khẩu ngay và đăng nhập lại.',
        testId: 'settings-banner-password',
        actions: [ui.button({
          label: 'Đổi mật khẩu ngay',
          icon: 'key',
          variant: 'primary',
          size: 'sm',
          onClick: function () {
            switchTab('account');
            if (adminNewRef && adminNewRef.focus) { adminNewRef.focus(); }
          }
        })]
      }));
    }

    var ffmpeg = ffmpegInfo();
    if (ffmpeg && ffmpeg.available === false) {
      bannerHost.appendChild(ui.banner({
        tone: 'danger',
        title: 'Thiếu FFmpeg — video và snapshot không khả dụng',
        message: 'Máy chủ chưa tìm thấy FFmpeg. Cài FFmpeg và thêm vào PATH, hoặc đặt biến '
          + 'môi trường CCTV_FFMPEG_PATH, sau đó khởi động lại máy chủ.',
        testId: 'settings-banner-ffmpeg',
        actions: [ui.button({
          label: 'Xem chẩn đoán',
          icon: 'terminal',
          variant: 'secondary',
          size: 'sm',
          onClick: function () { switchTab('system'); }
        })]
      }));
    }

    if (viewData.status && Array.isArray(viewData.status.warnings)) {
      var storageWarning = null;
      viewData.status.warnings.forEach(function (warning) {
        if (warning && warning.code === 'STORAGE_UNWRITABLE') { storageWarning = warning; }
      });
      if (storageWarning) {
        bannerHost.appendChild(ui.banner({
          tone: 'danger',
          title: 'Thư mục lưu trữ không ghi được',
          message: storageWarning.message || 'Kiểm tra quyền ghi của thư mục ghi hình và snapshot.'
        }));
      }
    }

    if (isTestMode()) {
      bannerHost.appendChild(ui.banner({
        tone: 'info',
        title: 'Chế độ kiểm thử',
        message: 'Các thao tác camera, Telegram và mở thư mục bị chặn. Không dùng cấu hình này cho vận hành thật.',
        testId: 'settings-banner-test-mode'
      }));
    }

    if (viewData.secretsManagedExternally) {
      bannerHost.appendChild(ui.banner({
        tone: 'warning',
        title: 'Bí mật đang được quản lý bên ngoài',
        message: 'Máy chủ đang quản lý token Telegram và mật khẩu mặc định bằng file cấu hình ngoài. '
          + 'Các ô bí mật trong giao diện bị khoá.',
        testId: 'settings-banner-secrets-external'
      }));
    }

    bannerHost.hidden = bannerHost.children.length === 0;
  }

  function setActivePanel(id) {
    activeTab = TAB_BY_ID[id] ? id : 'account';
    Object.keys(panels).forEach(function (key) {
      panels[key].hidden = key !== activeTab;
    });
  }

  function switchTab(id) {
    if (!tabsCtrl || !TAB_BY_ID[id]) { setActivePanel(id); return; }
    if (activeTab === id) { setActivePanel(id); return; }
    tabsCtrl.setActive(id, false);
  }

  function renderAll() {
    if (!bodyHost || destroyed) { return; }
    if (tabsCtrl && tabsCtrl.destroy) {
      try { tabsCtrl.destroy(); } catch (err) { /* bỏ qua */ }
    }
    tabsCtrl = null;
    panels = {};
    fieldHandles = {};
    secretRefs = {};
    vlanRefs = null;
    armedRefs = null;
    adminNewRef = null;

    clear(bodyHost);

    var tabsCard = el('section', { class: 'c-card' });
    var tabsBody = el('div', { class: 'c-card__body c-card__body--flush' });
    tabsCtrl = ui.tabs({
      tabs: TABS.map(function (tab) {
        return { id: tab.id, label: tab.label, icon: tab.icon };
      }),
      active: activeTab,
      label: 'Mục cài đặt',
      testId: 'settings-tabs',
      panelId: function (id) { return 'settings-panel-' + id; },
      onChange: function (id) { setActivePanel(id); }
    });
    var tabButtons = tabsCtrl.el.querySelectorAll('[role="tab"]');
    TABS.forEach(function (tab, index) {
      if (tabButtons[index]) {
        tabButtons[index].setAttribute('data-testid', tab.testId);
      }
    });
    tabsBody.appendChild(tabsCtrl.el);
    tabsCard.appendChild(tabsBody);
    bodyHost.appendChild(tabsCard);

    var panelHost = el('div', { class: 'c-stack' });
    TABS.forEach(function (tab) {
      var panel = el('div', {
        class: 'c-stack',
        attrs: {
          role: 'tabpanel',
          id: tabsCtrl.getPanelId(tab.id),
          'aria-labelledby': tabsCtrl.getTabId(tab.id),
          tabindex: '0'
        }
      });
      buildPanel(tab.id, panel);
      panels[tab.id] = panel;
      panelHost.appendChild(panel);
    });
    bodyHost.appendChild(panelHost);
    setActivePanel(activeTab);
    renderBanners();
    updateDirtyUi();
  }

  function buildPanel(id, panel) {
    if (id === 'account') { buildAccountPanel(panel); return; }
    if (id === 'scan') { buildScanPanel(panel); return; }
    if (id === 'storage') { buildStoragePanel(panel); return; }
    if (id === 'telegram') { buildTelegramPanel(panel); return; }
    if (id === 'system') { buildSystemPanel(panel); return; }
    buildAboutPanel(panel);
  }

  /* --------------------------- Account panel ---------------------------- */

  function buildAccountPanel(panel) {
    var session = CCTV.auth.session() || {};
    var me = viewData.me || {};
    var status = viewData.status || {};
    var role = me.role || session.role || ctxRef.role || '—';
    var roleLabel = role === 'admin' ? 'Quản trị viên' : role === 'viewer' ? 'Người xem' : '—';
    var username = (me.user && me.user.username) || session.username || '—';
    var expiresAt = me.expires_at || session.expiresAt || null;
    var ttl = status.limits && status.limits.session_ttl_seconds;

    var logoutBtn = ui.button({
      label: 'Đăng xuất',
      icon: 'log-out',
      variant: 'danger',
      size: 'sm',
      testId: 'settings-logout',
      onClick: function () { requestLogout(logoutBtn); }
    });

    var sessionCard = makeCard({
      title: 'Phiên đăng nhập',
      subtitle: 'Thông tin phiên hiện tại và đăng xuất an toàn',
      icon: 'shield',
      actions: [logoutBtn],
      testId: 'settings-session-info'
    });
    var dl = kvGrid();
    kvRow(dl, 'Vai trò', ui.badge(roleLabel, { tone: role === 'admin' ? 'primary' : 'neutral' }));
    kvRow(dl, 'Tên đăng nhập', username);
    kvRow(dl, 'Hết hạn lúc', expiresAt ? fmt.dateTime(expiresAt) : '—');
    kvRow(dl, 'Thời gian còn lại', expiresAt ? sessionRemaining(expiresAt) : '—');
    kvRow(dl, 'Thời hạn phiên tối đa', ttl ? fmt.duration(ttl) : '—');
    kvRow(dl, 'Trạng thái', ui.statusPill('ok', { label: 'Đang hoạt động' }));
    sessionCard.body.appendChild(dl);
    sessionCard.body.appendChild(note(
      'Nhật ký kiểm toán được ghi phía máy chủ; giao diện không tải hay hiển thị nhật ký. '
      + 'Phiên đăng nhập dùng cookie HttpOnly, SameSite=Strict và được thu hồi khi đăng xuất.'
    ));
    panel.appendChild(sessionCard.el);

    /* Đổi mật khẩu quản trị */
    var adminCard = makeCard({
      title: 'Đổi mật khẩu quản trị',
      subtitle: 'Sau khi đổi, toàn bộ phiên sẽ bị thu hồi và bạn phải đăng nhập lại',
      icon: 'key',
      testId: 'settings-admin-password'
    });
    var adminStack = el('div', { class: 'c-stack c-stack--sm' });

    var currentField = ui.field({
      label: 'Mật khẩu quản trị hiện tại',
      type: 'password',
      autocomplete: 'current-password',
      required: true,
      maxlength: 128,
      testId: 'settings-admin-current'
    });
    var newField = ui.field({
      label: 'Mật khẩu mới',
      type: 'password',
      autocomplete: 'new-password',
      required: true,
      maxlength: 128,
      help: 'Tối thiểu 10 ký tự, tối đa 128 ký tự; không dùng mật khẩu phổ biến hoặc trùng mật khẩu hiện tại.',
      testId: 'settings-admin-new'
    });
    var confirmField = ui.field({
      label: 'Xác nhận mật khẩu mới',
      type: 'password',
      autocomplete: 'new-password',
      required: true,
      maxlength: 128,
      testId: 'settings-admin-confirm'
    });
    adminNewRef = newField;

    var strengthBadge = ui.badge('Độ mạnh: Chưa nhập', { tone: 'neutral' });
    var strengthRow = el('div', { class: 'c-row c-row--wrap' });
    strengthRow.appendChild(strengthBadge);
    strengthRow.appendChild(el('span', {
      class: 'u-muted',
      text: 'Mật khẩu mạnh nên có chữ hoa, chữ thường, số và ký tự đặc biệt.'
    }));
    newField.input.addEventListener('input', function () {
      updateStrengthBadge(strengthBadge, newField.getValue());
    });

    var adminSubmit = ui.button({
      label: 'Đổi mật khẩu quản trị',
      icon: 'lock',
      variant: 'primary',
      testId: 'settings-change-password',
      onClick: function () {
        submitAdminPassword(currentField, newField, confirmField, adminSubmit, strengthBadge);
      }
    });

    appendAll(adminStack, [currentField.el, newField.el, confirmField.el, strengthRow]);
    var adminActions = el('div', { class: 'c-row c-row--wrap' });
    adminActions.appendChild(adminSubmit);
    adminStack.appendChild(adminActions);
    adminCard.body.appendChild(adminStack);
    panel.appendChild(adminCard.el);

    /* Mật khẩu người xem */
    var enabled = viewerEnabled();
    var viewerCard = makeCard({
      title: 'Tài khoản người xem',
      subtitle: 'Chỉ xem: stream, snapshot, trạng thái và lịch sử cảnh báo',
      icon: 'users',
      testId: 'settings-viewer-account'
    });
    var viewerDl = kvGrid();
    kvRow(viewerDl, 'Đăng nhập người xem', ui.badge(
      enabled ? 'Đang bật' : 'Đang tắt',
      { tone: enabled ? 'success' : 'neutral' }
    ));
    kvRow(viewerDl, 'Quyền hạn', 'Chỉ đọc; không thay đổi cấu hình, camera hay cảnh báo');
    viewerCard.body.appendChild(viewerDl);

    var viewerStack = el('div', { class: 'c-stack c-stack--sm' });
    var viewerCurrent = ui.field({
      label: 'Mật khẩu quản trị hiện tại (xác thực lại)',
      type: 'password',
      autocomplete: 'current-password',
      required: true,
      maxlength: 128,
      testId: 'settings-viewer-current'
    });
    var viewerNew = ui.field({
      label: enabled ? 'Mật khẩu người xem mới' : 'Đặt mật khẩu người xem',
      type: 'password',
      autocomplete: 'new-password',
      required: true,
      maxlength: 128,
      help: 'Tối thiểu 10 ký tự, tối đa 128 ký tự; không dùng mật khẩu phổ biến.',
      testId: 'settings-viewer-new'
    });
    var viewerConfirm = ui.field({
      label: 'Xác nhận mật khẩu người xem',
      type: 'password',
      autocomplete: 'new-password',
      required: true,
      maxlength: 128,
      testId: 'settings-viewer-confirm'
    });

    var viewerSubmit = ui.button({
      label: enabled ? 'Đổi mật khẩu người xem' : 'Đặt mật khẩu người xem',
      icon: 'users',
      variant: 'primary',
      testId: 'settings-viewer-password',
      onClick: function () {
        submitViewerPassword(viewerCurrent, viewerNew, viewerConfirm, viewerSubmit, false);
      }
    });
    var viewerDisable = ui.button({
      label: 'Tắt đăng nhập người xem',
      icon: 'lock',
      variant: 'danger',
      disabled: !enabled,
      testId: 'settings-disable-viewer',
      onClick: function () {
        ctxRef.confirm({
          title: 'Tắt đăng nhập người xem?',
          message: 'Tài khoản người xem sẽ bị vô hiệu hoá. Toàn bộ phiên đăng nhập hiện tại sẽ bị thu hồi.',
          confirmLabel: 'Tắt đăng nhập',
          variant: 'danger'
        }).then(function (ok) {
          if (!ok || destroyed) { return; }
          submitViewerPassword(viewerCurrent, viewerNew, viewerConfirm, viewerDisable, true);
        });
      }
    });
    var viewerActions = el('div', { class: 'c-row c-row--wrap' });
    appendAll(viewerActions, [viewerSubmit, viewerDisable]);
    appendAll(viewerStack, [viewerCurrent.el, viewerNew.el, viewerConfirm.el, viewerActions]);
    viewerCard.body.appendChild(viewerStack);
    viewerCard.body.appendChild(note(
      'Đặt hoặc xoá mật khẩu người xem đều thu hồi mọi phiên đăng nhập, kể cả phiên quản trị hiện tại.'
    ));
    panel.appendChild(viewerCard.el);
  }

  function requestLogout(btn) {
    if (!ctxRef || destroyed) { return; }
    if (saving) {
      toast('Đang lưu cấu hình. Vui lòng chờ hoàn tất.', { type: 'warning' });
      return;
    }
    var token = mountToken;
    ctxRef.confirm({
      title: 'Đăng xuất?',
      message: 'Phiên hiện tại sẽ bị thu hồi trên máy chủ.',
      confirmLabel: 'Đăng xuất',
      variant: 'danger'
    }).then(function (ok) {
      if (!ok || isStale(token)) { return; }
      if (btn) { ui.busy(btn, true, 'Đang đăng xuất…'); }
      /* Dùng đúng luồng đăng xuất của shell để core thu hồi phiên và hiện login. */
      var shellLogout = document.getElementById('logout-btn');
      if (shellLogout && typeof shellLogout.click === 'function') {
        shellLogout.click();
        return;
      }
      CCTV.auth.logout().then(function () {
        if (isStale(token)) { return; }
        /* Fallback khi shell không có nút đăng xuất chuẩn. */
        window.location.reload();
      }).catch(function () {
        if (btn && !isStale(token)) { ui.busy(btn, false); }
      });
    });
  }

  function submitAdminPassword(currentField, newField, confirmField, btn, strengthBadge) {
    if (saving || loading || destroyed) { return; }
    currentField.clearError();
    newField.clearError();
    confirmField.clearError();
    var current = currentField.getValue();
    var next = newField.getValue();
    var confirm = confirmField.getValue();
    var trimmed = String(next || '').trim();
    var invalid = false;
    if (!current) {
      currentField.setError('Nhập mật khẩu quản trị hiện tại.');
      currentField.focus();
      invalid = true;
    }
    if (!invalid && trimmed.length < 10) {
      newField.setError('Mật khẩu mới phải có tối thiểu 10 ký tự.');
      newField.focus();
      invalid = true;
    }
    if (!invalid && next.length > 128) {
      newField.setError('Mật khẩu mới không được vượt quá 128 ký tự.');
      newField.focus();
      invalid = true;
    }
    if (!invalid && trimmed === String(current || '').trim()) {
      newField.setError('Mật khẩu mới không được trùng mật khẩu hiện tại.');
      newField.focus();
      invalid = true;
    }
    if (!invalid && next !== confirm) {
      confirmField.setError('Xác nhận mật khẩu không khớp.');
      confirmField.focus();
      invalid = true;
    }
    if (invalid) { return; }

    ui.busy(btn, true, 'Đang đổi…');
    if (strengthBadge) { updateStrengthBadge(strengthBadge, next); }
    CCTV.auth.changePassword({
      target: 'admin',
      currentPassword: current,
      newPassword: next
    }).catch(function (err) {
      if (destroyed || isAborted(err)) { return; }
      currentField.setValue('');
      newField.setValue('');
      confirmField.setValue('');
      if (err.status === 401 || err.code === 'INVALID_CREDENTIALS') {
        currentField.setError('Mật khẩu quản trị hiện tại không chính xác.');
        currentField.focus();
        return;
      }
      if (err.status === 400) {
        newField.setError(err.message || 'Mật khẩu mới không hợp lệ.');
        newField.focus();
        return;
      }
      notifyError(err);
    }).finally(function () {
      if (!destroyed) { ui.busy(btn, false); }
    });
  }

  function submitViewerPassword(currentField, newField, confirmField, btn, clearMode) {
    if (saving || loading || destroyed) { return; }
    currentField.clearError();
    newField.clearError();
    confirmField.clearError();
    var current = currentField.getValue();
    var next = newField.getValue();
    var confirm = confirmField.getValue();
    if (!current) {
      currentField.setError('Nhập mật khẩu quản trị hiện tại để xác thực lại.');
      currentField.focus();
      return;
    }
    if (!clearMode) {
      var trimmed = String(next || '').trim();
      if (trimmed.length < 10) {
        newField.setError('Mật khẩu người xem phải có tối thiểu 10 ký tự.');
        newField.focus();
        return;
      }
      if (next.length > 128) {
        newField.setError('Mật khẩu người xem không được vượt quá 128 ký tự.');
        newField.focus();
        return;
      }
      if (next !== confirm) {
        confirmField.setError('Xác nhận mật khẩu không khớp.');
        confirmField.focus();
        return;
      }
    }

    ui.busy(btn, true, clearMode ? 'Đang tắt…' : 'Đang đổi…');
    var params = {
      target: 'viewer',
      currentPassword: current
    };
    if (clearMode) {
      params.clearViewer = true;
    } else {
      params.newPassword = next;
    }
    CCTV.auth.changePassword(params).catch(function (err) {
      if (destroyed || isAborted(err)) { return; }
      currentField.setValue('');
      newField.setValue('');
      confirmField.setValue('');
      if (err.status === 401 || err.code === 'INVALID_CREDENTIALS') {
        currentField.setError('Mật khẩu quản trị hiện tại không chính xác.');
        currentField.focus();
        return;
      }
      if (err.status === 400 && !clearMode) {
        newField.setError(err.message || 'Mật khẩu người xem không hợp lệ.');
        newField.focus();
        return;
      }
      notifyError(err);
    }).finally(function () {
      if (!destroyed) { ui.busy(btn, false); }
    });
  }

  /* ----------------------------- Scan panel ----------------------------- */

  function buildScanPanel(panel) {
    var scanCard = makeCard({
      title: 'Tham số quét mạng',
      subtitle: 'Áp dụng cho màn Quét mạng và tác vụ thêm camera hàng loạt',
      icon: 'scanner',
      testId: 'settings-scan'
    });
    var stack = el('div', { class: 'c-stack c-stack--sm' });

    var subnetField = createField({
      label: 'Dải mạng mặc định',
      value: draft.default_subnet,
      placeholder: '192.168.1.0/24, 192.168.2.10-192.168.2.60',
      maxlength: 500,
      mono: true,
      help: 'CIDR, dải IP hoặc IP đơn, cách nhau dấu phẩy; tối đa 8 biểu thức, mỗi dải không quá 1024 host.',
      testId: 'settings-default-subnet'
    }, 'default_subnet', 'scan');

    var lastField = createField({
      label: 'Dải quét gần nhất',
      value: draft.last_subnets,
      placeholder: 'Dùng khi màn Quét mạng không nhập dải',
      maxlength: 500,
      mono: true,
      testId: 'settings-last-subnets'
    }, 'last_subnets', 'scan');

    var timeoutField = createField({
      label: 'Thời gian chờ mỗi thiết bị (giây)',
      type: 'number',
      value: draft.scan_timeout,
      min: 1,
      max: 10,
      step: 0.1,
      help: 'Từ 1 đến 10 giây.',
      testId: 'settings-scan-timeout'
    }, 'scan_timeout', 'scan');

    var deepSwitch = createSwitch({
      checked: draft.deep_scan,
      label: 'Quét sâu',
      description: 'Dò thêm thông tin model, firmware và dịch vụ của thiết bị.',
      testId: 'settings-deep-scan'
    }, 'deep_scan', 'scan');

    appendAll(stack, [subnetField.el, lastField.el]);
    var row = el('div', { class: 'c-grid c-grid--2' });
    row.appendChild(timeoutField.el);
    var switchWrap = el('div', { class: 'c-stack c-stack--sm' });
    switchWrap.appendChild(fieldLabel('Tùy chọn'));
    switchWrap.appendChild(deepSwitch.el);
    row.appendChild(switchWrap);
    stack.appendChild(row);
    scanCard.body.appendChild(stack);

    /* Cổng quét chỉ đọc */
    var ports = Array.isArray(viewData.settings.scan_ports) ? viewData.settings.scan_ports : [];
    var portsWrap = el('div', { class: 'c-stack c-stack--sm' });
    portsWrap.appendChild(fieldLabel('Cổng quét (chỉ đọc)'));
    if (ports.length) {
      var chips = el('div', { class: 'c-chip-row' });
      ports.forEach(function (port) {
        chips.appendChild(el('span', { class: 'c-chip', text: String(port) }));
      });
      portsWrap.appendChild(chips);
    } else {
      portsWrap.appendChild(note('Máy chủ không trả cấu hình cổng quét.'));
    }
    portsWrap.appendChild(el('p', {
      class: 'c-field__help',
      text: 'Do file cấu hình máy chủ quy định; không sửa được qua giao diện.'
    }));
    scanCard.body.appendChild(portsWrap);
    panel.appendChild(scanCard.el);

    /* VLAN */
    var detectBtn = ui.button({
      label: 'Dò VLAN',
      icon: 'network',
      variant: 'secondary',
      size: 'sm',
      testId: 'settings-detect-vlans',
      onClick: function () { detectVlans(detectBtn); }
    });
    var vlanStatus = el('span', { class: 'u-muted u-tabular' });
    var vlanCard = makeCard({
      title: 'VLAN và dải mạng',
      subtitle: 'Chọn VLAN dùng làm dải quét mặc định',
      icon: 'layers',
      actions: [detectBtn],
      testId: 'settings-vlan'
    });
    var vlanHead = el('div', { class: 'c-row c-row--between c-row--wrap' });
    vlanHead.appendChild(vlanStatus);
    vlanCard.body.appendChild(vlanHead);

    var selectedError = errorSlot('selected_vlans', 'scan');
    var companyError = errorSlot('company_vlans', 'scan');
    var vlanHost = el('div', { class: 'c-stack c-stack--sm' });
    vlanCard.body.appendChild(vlanHost);
    vlanCard.body.appendChild(selectedError);
    vlanCard.body.appendChild(companyError);

    vlanRefs = {
      host: vlanHost,
      status: vlanStatus
    };
    renderVlanSection();
    panel.appendChild(vlanCard.el);

    /* Mật khẩu camera mặc định */
    var defaultSet = viewData.secrets.default_password_set;
    var weakFlag = viewData.status && viewData.status.config &&
      typeof viewData.status.config.default_password_is_weak === 'boolean'
      ? viewData.status.config.default_password_is_weak : null;
    var defaultEvaluation;
    if (!defaultSet) {
      defaultEvaluation = ui.badge('Chưa đặt', { tone: 'warning' });
    } else if (weakFlag === true) {
      defaultEvaluation = ui.badge('Yếu', { tone: 'warning' });
    } else if (weakFlag === false) {
      defaultEvaluation = ui.badge('Đủ mạnh', { tone: 'success' });
    } else {
      defaultEvaluation = ui.badge('Chưa rõ', { tone: 'neutral' });
    }
    var defaultCard = makeCard({
      title: 'Mật khẩu camera mặc định',
      subtitle: 'Dùng khi thêm camera hàng loạt; giá trị đã lưu không hiển thị lại',
      icon: 'key',
      testId: 'settings-default-password-card'
    });
    var defaultDl = kvGrid();
    kvRow(defaultDl, 'Trạng thái', secretBadge(defaultSet));
    kvRow(defaultDl, 'Đánh giá', defaultEvaluation);
    defaultCard.body.appendChild(defaultDl);
    if (weakFlag === true) {
      defaultCard.body.appendChild(ui.banner({
        tone: 'warning',
        title: 'Mật khẩu camera mặc định chưa đủ mạnh',
        message: 'Hãy đặt mật khẩu mặc định mạnh tối thiểu 8 ký tự trước khi thêm camera hàng loạt.'
      }));
    }

    var defaultStack = el('div', { class: 'c-stack c-stack--sm' });
    var defaultField = ui.field({
      label: viewData.secrets.default_password_set ? 'Đặt mật khẩu camera mặc định mới' : 'Đặt mật khẩu camera mặc định',
      type: 'password',
      autocomplete: 'new-password',
      maxlength: 128,
      disabled: viewData.secretsManagedExternally,
      placeholder: viewData.secretsManagedExternally ? 'Đang quản lý bởi file cấu hình ngoài' : 'Để trống nếu giữ nguyên',
      help: 'Tối thiểu 8 ký tự, tối đa 128 ký tự. Giá trị không được trả lại qua API.',
      testId: 'settings-default-password'
    });
    registerSecretField('default_password', 'scan', defaultField);
    defaultStack.appendChild(defaultField.el);

    var clearDefaultBtn = ui.button({
      label: 'Xoá mật khẩu mặc định',
      icon: 'trash',
      variant: 'danger',
      size: 'sm',
      disabled: !viewData.secrets.default_password_set || viewData.secretsManagedExternally,
      testId: 'settings-clear-default-password',
      onClick: function () {
        clearSecretAction(clearDefaultBtn, {
          title: 'Xoá mật khẩu camera mặc định?',
          message: 'Thao tác này xoá mật khẩu mặc định đang lưu trên máy chủ. Các camera đã thêm không bị ảnh hưởng.',
          confirmLabel: 'Xoá mật khẩu',
          payload: { clear_default_password: true },
          successMessage: 'Đã xoá mật khẩu camera mặc định.'
        });
      }
    });
    var defaultActions = el('div', { class: 'c-row c-row--wrap' });
    defaultActions.appendChild(clearDefaultBtn);
    defaultStack.appendChild(defaultActions);
    defaultCard.body.appendChild(defaultStack);
    panel.appendChild(defaultCard.el);
  }

  function vlanLabel(item) {
    var label = str(item.label).trim();
    if (label) { return label.slice(0, 64); }
    var generated = 'VLAN ' + str(item.vlan);
    if (item.subnet) { generated += ' · ' + str(item.subnet); }
    return generated.slice(0, 64);
  }

  function mergedVlans() {
    var map = Object.create(null);
    var list = [];
    function add(item) {
      if (!item || typeof item !== 'object') { return; }
      var label = vlanLabel(item);
      if (!label || map[label]) { return; }
      map[label] = true;
      list.push({
        vlan: str(item.vlan),
        subnet: str(item.subnet),
        label: label,
        gateway: item.gateway === undefined || item.gateway === null ? '' : str(item.gateway),
        is_up: typeof item.is_up === 'boolean' ? item.is_up : null
      });
    }
    (draft.company_vlans || []).forEach(add);
    (viewData.vlans || []).forEach(add);
    (draft.selected_vlans || []).forEach(function (label) {
      add({ vlan: '', subnet: '', label: label, is_up: null });
    });
    return list;
  }

  function toggleSelectedVlan(label, checked) {
    var list = draft.selected_vlans.slice();
    var index = list.indexOf(label);
    if (checked) {
      if (index === -1) {
        if (list.length >= 20) {
          toast('Chỉ chọn tối đa 20 VLAN.', { type: 'warning' });
          renderVlanSection();
          return;
        }
        list.push(label);
      }
    } else if (index !== -1) {
      list.splice(index, 1);
    }
    draft.selected_vlans = list;
    var meta = fieldHandles.selected_vlans;
    if (meta && meta.handle && meta.handle.clearError) { meta.handle.clearError(); }
    markDirty();
    renderVlanSection();
  }

  function renderVlanSection() {
    if (!vlanRefs) { return; }
    var host = vlanRefs.host;
    clear(host);
    var items = mergedVlans();
    var selectedCount = draft.selected_vlans.length;
    var statusParts = [];
    if (viewData.vlansScannedAt) {
      statusParts.push('Dò lúc ' + fmt.dateTime(viewData.vlansScannedAt));
    }
    statusParts.push(items.length + ' VLAN đã biết');
    statusParts.push(selectedCount + ' VLAN được chọn');
    vlanRefs.status.textContent = statusParts.join(' · ');

    if (!items.length) {
      host.appendChild(ui.empty({
        icon: 'network',
        title: 'Chưa có dữ liệu VLAN',
        description: 'Bấm "Dò VLAN" để đọc danh sách VLAN từ máy chủ. Thao tác này không tự chạy khi mở màn hình.'
      }));
      return;
    }

    items.forEach(function (item) {
      var label = el('label', { class: 'c-check' });
      var box = el('input', { attrs: { type: 'checkbox' } });
      box.checked = draft.selected_vlans.indexOf(item.label) !== -1;
      box.addEventListener('change', function () {
        toggleSelectedVlan(item.label, box.checked);
      });
      label.appendChild(box);
      var text = el('span');
      text.appendChild(el('strong', { text: item.label }));
      var meta = [];
      if (item.vlan) { meta.push('VLAN ' + item.vlan); }
      if (item.subnet) { meta.push(item.subnet); }
      if (item.gateway) { meta.push('GW ' + item.gateway); }
      if (meta.length) {
        text.appendChild(el('span', { class: 'u-muted', text: ' · ' + meta.join(' · ') }));
      }
      label.appendChild(text);
      if (item.is_up === false) {
        label.appendChild(ui.badge('Không hoạt động', { tone: 'warning' }));
      }
      host.appendChild(label);
    });
  }

  function detectVlans(btn) {
    if (!ctxRef || detectingVlans || destroyed || loading || saving) { return; }
    var token = mountToken;
    detectingVlans = true;
    if (btn) { ui.busy(btn, true, 'Đang dò…'); }
    ctxRef.api.get('/api/scan/vlans', {
      signal: ctxRef.signal,
      silent: true,
      timeoutMs: 45000
    }).then(function (data) {
      if (isStale(token) || !data) { return; }
      var vlans = Array.isArray(data.vlans) ? data.vlans : [];
      viewData.vlans = vlans;
      viewData.vlansScannedAt = data.scanned_at || null;
      var merged = Array.isArray(draft.company_vlans) ? draft.company_vlans.slice() : [];
      var seen = Object.create(null);
      merged.forEach(function (item) {
        if (item && str(item.subnet).trim()) { seen[str(item.subnet).trim()] = true; }
      });
      vlans.forEach(function (item) {
        if (!isObj(item)) { return; }
        var subnet = str(item.subnet).trim();
        if (!subnet || seen[subnet]) { return; }
        seen[subnet] = true;
        merged.push({
          vlan: str(item.vlan).slice(0, 16),
          subnet: subnet,
          label: vlanLabel(item)
        });
      });
      draft.company_vlans = merged.slice(0, 64);
      markDirty();
      renderVlanSection();
      toast('Đã dò ' + vlans.length + ' VLAN.', { type: 'success' });
    }).catch(function (err) {
      if (isAborted(err) || isStale(token)) { return; }
      notifyError(err);
    }).finally(function () {
      if (isStale(token)) { return; }
      detectingVlans = false;
      if (btn) { ui.busy(btn, false); }
    });
  }

  /* ---------------------------- Storage panel --------------------------- */

  function buildStoragePanel(panel) {
    var health = viewData.health || {};
    var storageHealth = isObj(health.storage) ? health.storage : null;
    var recordsWritable = !!storageHealth && storageHealth.recordings_writable === true;
    var snapshotsWritable = !!storageHealth && storageHealth.snapshots_writable === true;

    var dirsCard = makeCard({
      title: 'Thư mục lưu trữ',
      subtitle: 'Đường dẫn tuyệt đối trên máy chủ; thay đổi được kiểm tra quyền ghi khi lưu',
      icon: 'hard-drive',
      testId: 'settings-storage'
    });
    var stack = el('div', { class: 'c-stack c-stack--sm' });
    var recField = createField({
      label: 'Thư mục ghi hình',
      value: draft.recordings_dir,
      placeholder: 'Ví dụ: D:\\CCTV\\recordings',
      maxlength: 500,
      mono: true,
      help: 'Để trống để dùng thư mục mặc định của máy chủ. Thư mục phải nằm trong dự án '
        + 'hoặc CCTV_ALLOWED_STORAGE_ROOTS và phải ghi được.',
      testId: 'settings-recordings-dir'
    }, 'recordings_dir', 'storage');
    var snapField = createField({
      label: 'Thư mục snapshot',
      value: draft.snapshots_dir,
      placeholder: 'Ví dụ: D:\\CCTV\\snapshots',
      maxlength: 500,
      mono: true,
      help: 'Snapshot cảnh báo được lưu tại đây.',
      testId: 'settings-snapshots-dir'
    }, 'snapshots_dir', 'storage');
    appendAll(stack, [recField.el, snapField.el]);

    var statusRow = el('div', { class: 'c-row c-row--wrap' });
    statusRow.appendChild(el('span', { class: 'u-muted', text: 'Ghi hình:' }));
    statusRow.appendChild(ui.badge(
      storageHealth ? (recordsWritable ? 'Ghi được' : 'Không ghi được') : 'Chưa rõ',
      { tone: storageHealth ? (recordsWritable ? 'success' : 'danger') : 'neutral' }
    ));
    statusRow.appendChild(el('span', { class: 'u-muted', text: 'Snapshot:' }));
    statusRow.appendChild(ui.badge(
      storageHealth ? (snapshotsWritable ? 'Ghi được' : 'Không ghi được') : 'Chưa rõ',
      { tone: storageHealth ? (snapshotsWritable ? 'success' : 'danger') : 'neutral' }
    ));
    stack.appendChild(statusRow);

    var autoSwitch = createSwitch({
      checked: draft.auto_reboot_on_ip_change,
      label: 'Tự khởi động lại camera sau khi đổi IP',
      description: 'Chỉ áp dụng cho tác vụ đổi IP hàng loạt. Camera sẽ khởi động lại để nhận cấu hình mới.',
      testId: 'settings-auto-reboot'
    }, 'auto_reboot_on_ip_change', 'storage');
    stack.appendChild(autoSwitch.el);
    dirsCard.body.appendChild(stack);

    var testMode = isTestMode();
    var openRec = ui.button({
      label: 'Mở thư mục ghi hình',
      icon: 'hard-drive',
      variant: 'secondary',
      size: 'sm',
      disabled: testMode,
      testId: 'settings-open-recordings',
      onClick: function () { openFolder('recordings', openRec); }
    });
    var openSnap = ui.button({
      label: 'Mở thư mục snapshot',
      icon: 'image',
      variant: 'secondary',
      size: 'sm',
      disabled: testMode,
      testId: 'settings-open-snapshots',
      onClick: function () { openFolder('snapshots', openSnap); }
    });
    var dirFooter = el('div', { class: 'c-row c-row--wrap' });
    appendAll(dirFooter, [openRec, openSnap]);
    if (testMode) {
      dirFooter.appendChild(el('span', {
        class: 'u-muted',
        text: 'Mở thư mục bị chặn trong chế độ kiểm thử.'
      }));
    }
    dirsCard.footer = el('div', { class: 'c-card__footer' });
    dirsCard.footer.appendChild(dirFooter);
    dirsCard.el.appendChild(dirsCard.footer);
    panel.appendChild(dirsCard.el);

    /* FFmpeg */
    var ffmpeg = ffmpegInfo();
    var runtime = viewData.status && viewData.status.runtime ? viewData.status.runtime : {};
    var ffCard = makeCard({
      title: 'FFmpeg và video',
      subtitle: 'Bắt buộc cho MJPEG, snapshot và ghi hình',
      icon: 'film',
      testId: 'settings-ffmpeg'
    });
    var ffDl = kvGrid();
    if (ffmpeg) {
      kvRow(ffDl, 'Trạng thái', ui.badge(
        ffmpeg.available ? 'Sẵn sàng' : 'Thiếu',
        { tone: ffmpeg.available ? 'success' : 'danger' }
      ));
      kvRow(ffDl, 'Phiên bản', ffmpeg.version || '—');
      kvRow(ffDl, 'Bộ mã hoá audio', ffmpeg.audio_available ? 'Có (MP3)' : 'Thiếu libmp3lame');
    } else {
      kvRow(ffDl, 'Trạng thái', ui.badge('Chưa rõ', { tone: 'neutral' }));
      kvRow(ffDl, 'Ghi chú', 'Không đọc được trạng thái FFmpeg từ máy chủ.');
    }
    if (runtime.ffmpeg_path) {
      kvRow(ffDl, 'Đường dẫn', el('span', { class: 'u-mono', text: String(runtime.ffmpeg_path) }));
    }
    ffCard.body.appendChild(ffDl);

    if (ffmpeg && ffmpeg.available === false) {
      ffCard.body.appendChild(ui.banner({
        tone: 'danger',
        title: 'FFmpeg chưa sẵn sàng',
        message: 'Video, snapshot và ghi hình sẽ trả lỗi FFMPEG_UNAVAILABLE.',
        testId: 'settings-storage-ffmpeg-banner'
      }));
      var steps = el('div', { class: 'c-stack c-stack--sm' });
      steps.appendChild(fieldLabel('Hướng dẫn cài đặt'));
      steps.appendChild(el('p', {
        class: 'c-muted-block',
        text: 'Windows: tải FFmpeg, giải nén, thêm thư mục bin vào PATH hoặc đặt CCTV_FFMPEG_PATH trỏ tới ffmpeg.exe, '
          + 'sau đó khởi động lại máy chủ.'
      }));
      steps.appendChild(el('p', {
        class: 'c-muted-block',
        text: 'Linux: cài gói ffmpeg bằng trình quản lý gói của hệ điều hành; kiểm tra bằng lệnh ffmpeg -version.'
      }));
      steps.appendChild(el('p', {
        class: 'c-muted-block',
        text: 'Sau khi cài, bấm "Làm mới" hoặc tải lại trang để kiểm tra lại trạng thái.'
      }));
      ffCard.body.appendChild(steps);
    } else if (ffmpeg && ffmpeg.available) {
      ffCard.body.appendChild(note(
        'FFmpeg đã sẵn sàng. Audio cần bộ mã hoá libmp3lame; nếu thiếu, chỉ audio bị chặn và trả lỗi tương ứng.'
      ));
    }
    panel.appendChild(ffCard.el);

    /* Giới hạn dịch vụ */
    var limits = (viewData.status && viewData.status.limits) || null;
    var limitsCard = makeCard({
      title: 'Giới hạn dịch vụ',
      subtitle: 'Giá trị do máy chủ quy định, chỉ đọc',
      icon: 'gauge',
      testId: 'settings-limits'
    });
    if (limits) {
      var limitDl = kvGrid();
      kvRow(limitDl, 'Luồng MJPEG tối đa', limits.max_mjpeg_streams || '—');
      kvRow(limitDl, 'Luồng MJPEG mỗi phiên', limits.max_mjpeg_per_session || '—');
      kvRow(limitDl, 'Luồng audio tối đa', limits.max_audio_streams || '—');
      kvRow(limitDl, 'Ghi hình đồng thời', limits.max_recordings || '—');
      kvRow(limitDl, 'Thời lượng ghi tối đa', limits.max_recording_seconds
        ? fmt.duration(limits.max_recording_seconds) : '—');
      kvRow(limitDl, 'Host quét tối đa', limits.max_scan_hosts || '—');
      kvRow(limitDl, 'Thời hạn phiên', limits.session_ttl_seconds
        ? fmt.duration(limits.session_ttl_seconds) : '—');
      limitsCard.body.appendChild(limitDl);
    } else {
      limitsCard.body.appendChild(ui.empty({
        icon: 'gauge',
        title: 'Chưa có dữ liệu giới hạn',
        description: 'Không đọc được /api/system/status. Bấm "Làm mới" để thử lại.'
      }));
    }
    panel.appendChild(limitsCard.el);
  }

  function openFolder(kind, btn) {
    if (!ctxRef || destroyed || loading || saving) { return; }
    if (btn) { ui.busy(btn, true, 'Đang mở…'); }
    ctxRef.api.post('/api/settings/open-folder', { folder: kind }, {
      signal: ctxRef.signal,
      silent: true
    }).then(function () {
      if (destroyed) { return; }
      toast(kind === 'recordings' ? 'Đã mở thư mục ghi hình.' : 'Đã mở thư mục snapshot.', {
        type: 'success'
      });
    }).catch(function (err) {
      if (isAborted(err) || destroyed) { return; }
      if (err && err.code === 'TEST_MODE_BLOCKED') {
        toast('Chế độ kiểm thử chặn mở thư mục.', { type: 'info' });
        return;
      }
      notifyError(err);
    }).finally(function () {
      if (btn && !destroyed) { ui.busy(btn, false); }
    });
  }

  /* --------------------------- Telegram panel --------------------------- */

  function buildTelegramPanel(panel) {
    var secrets = viewData.secrets || {};
    var managed = viewData.secretsManagedExternally;
    var testMode = isTestMode();

    var statusCard = makeCard({
      title: 'Trạng thái Telegram',
      subtitle: 'Kênh gửi cảnh báo an ninh và giám sát thẻ nhớ',
      icon: 'bell',
      testId: 'settings-telegram'
    });
    var statusDl = kvGrid();
    kvRow(statusDl, 'Bot Token', secretBadge(secrets.telegram_bot_token_set));
    kvRow(statusDl, 'Chat ID', secretBadge(secrets.telegram_chat_id_set));
    kvRow(statusDl, 'Bí mật bên ngoài', managed
      ? ui.badge('Đang quản lý ngoài', { tone: 'warning' })
      : ui.badge('Quản lý trong hệ thống', { tone: 'neutral' }));
    kvRow(statusDl, 'Chế độ', testMode
      ? ui.badge('Kiểm thử — không gửi', { tone: 'info' })
      : ui.badge('Vận hành', { tone: 'success' }));
    statusCard.body.appendChild(statusDl);

    var enabledSwitch = createSwitch({
      checked: draft.telegram_enabled,
      label: 'Bật gửi cảnh báo Telegram',
      description: 'Tắt để tạm dừng gửi nhưng vẫn giữ cấu hình và lịch sử.',
      testId: 'settings-telegram-enabled'
    }, 'telegram_enabled', 'telegram');
    statusCard.body.appendChild(enabledSwitch.el);

    var testBtn = ui.button({
      label: 'Gửi thử',
      icon: 'bell',
      variant: 'secondary',
      size: 'sm',
      disabled: testMode,
      testId: 'settings-test-telegram',
      onClick: function () { sendTelegramTest(testBtn); }
    });
    var testRow = el('div', { class: 'c-row c-row--wrap' });
    testRow.appendChild(testBtn);
    testRow.appendChild(el('span', {
      class: 'u-muted',
      text: testMode
        ? 'Chế độ kiểm thử không gửi tin nhắn ra ngoài.'
        : 'Gửi thử dùng cấu hình đã lưu. Hãy bấm "Lưu cấu hình" trước nếu vừa thay đổi token hoặc Chat ID.'
    }));
    statusCard.body.appendChild(testRow);
    panel.appendChild(statusCard.el);

    /* Kết nối */
    var connCard = makeCard({
      title: 'Kết nối Bot',
      subtitle: 'Token và Chat ID là bí mật ghi-only; máy chủ không trả lại giá trị đã lưu',
      icon: 'key',
      testId: 'settings-telegram-connection'
    });
    var connStack = el('div', { class: 'c-stack c-stack--sm' });
    var tokenField = ui.field({
      label: 'Bot Token',
      type: 'password',
      autocomplete: 'off',
      maxlength: 256,
      disabled: managed,
      placeholder: secrets.telegram_bot_token_set ? 'Đã lưu — để trống nếu giữ nguyên' : 'Nhập token từ BotFather',
      help: 'Để trống để giữ token hiện tại. Giá trị chỉ được gửi khi bấm Lưu cấu hình.',
      testId: 'settings-telegram-token'
    });
    var chatField = ui.field({
      label: 'Chat ID',
      type: 'text',
      autocomplete: 'off',
      maxlength: 64,
      disabled: managed,
      placeholder: secrets.telegram_chat_id_set ? 'Đã lưu — để trống nếu giữ nguyên' : 'Ví dụ: -1001234567890',
      help: 'ID nhóm hoặc người nhận. Để trống để giữ giá trị hiện tại.',
      testId: 'settings-telegram-chat'
    });
    registerSecretField('telegram_bot_token', 'telegram', tokenField);
    registerSecretField('telegram_chat_id', 'telegram', chatField);
    appendAll(connStack, [tokenField.el, chatField.el]);

    var clearTokenBtn = ui.button({
      label: 'Xoá token',
      icon: 'trash',
      variant: 'danger',
      size: 'sm',
      disabled: managed || !secrets.telegram_bot_token_set,
      testId: 'settings-clear-telegram-token',
      onClick: function () {
        clearSecretAction(clearTokenBtn, {
          title: 'Xoá Bot Token?',
          message: 'Cảnh báo Telegram sẽ dừng gửi cho đến khi bạn nhập token mới.',
          confirmLabel: 'Xoá token',
          payload: { clear_telegram_bot_token: true },
          successMessage: 'Đã xoá Bot Token.'
        });
      }
    });
    var clearChatBtn = ui.button({
      label: 'Xoá Chat ID',
      icon: 'trash',
      variant: 'danger',
      size: 'sm',
      disabled: managed || !secrets.telegram_chat_id_set,
      testId: 'settings-clear-telegram-chat',
      onClick: function () {
        clearSecretAction(clearChatBtn, {
          title: 'Xoá Chat ID?',
          message: 'Cảnh báo Telegram sẽ dừng gửi cho đến khi bạn nhập Chat ID mới.',
          confirmLabel: 'Xoá Chat ID',
          payload: { clear_telegram_chat_id: true },
          successMessage: 'Đã xoá Chat ID.'
        });
      }
    });
    var clearRow = el('div', { class: 'c-row c-row--wrap' });
    appendAll(clearRow, [clearTokenBtn, clearChatBtn]);
    connStack.appendChild(clearRow);
    connCard.body.appendChild(connStack);
    connCard.body.appendChild(note(
      'Máy chủ xác thực TLS khi gọi Telegram. Với chứng chỉ nội bộ, cấu hình CCTV_CA_BUNDLE trên máy chủ; '
      + 'không tắt xác thực chứng chỉ.'
    ));
    panel.appendChild(connCard.el);

    /* Lịch gửi */
    var scheduleCard = makeCard({
      title: 'Lịch gửi và chống trùng',
      subtitle: 'Áp dụng cho cảnh báo tự động',
      icon: 'clock',
      testId: 'settings-telegram-schedule'
    });
    var scheduleStack = el('div', { class: 'c-stack c-stack--sm' });
    var scheduleSwitch = createSwitch({
      checked: draft.telegram_schedule_enabled,
      label: 'Chỉ gửi trong khung giờ',
      description: 'Ngoài khung giờ, cảnh báo được ghi lịch sử nhưng không gửi Telegram.',
      testId: 'settings-telegram-schedule-enabled'
    }, 'telegram_schedule_enabled', 'telegram');
    scheduleStack.appendChild(scheduleSwitch.el);

    var timeGrid = el('div', { class: 'c-grid c-grid--2' });
    var startField = createField({
      label: 'Bắt đầu',
      type: 'time',
      value: draft.telegram_schedule_start,
      required: true,
      testId: 'settings-telegram-start'
    }, 'telegram_schedule_start', 'telegram');
    var endField = createField({
      label: 'Kết thúc',
      type: 'time',
      value: draft.telegram_schedule_end,
      required: true,
      testId: 'settings-telegram-end'
    }, 'telegram_schedule_end', 'telegram');
    timeGrid.appendChild(startField.el);
    timeGrid.appendChild(endField.el);
    scheduleStack.appendChild(timeGrid);

    var cooldownField = createField({
      label: 'Chống trùng (giây)',
      type: 'number',
      value: draft.telegram_cooldown_seconds,
      min: 10,
      max: 3600,
      step: 1,
      help: 'Từ 10 đến 3600 giây giữa hai cảnh báo cùng camera.',
      testId: 'settings-telegram-cooldown'
    }, 'telegram_cooldown_seconds', 'telegram');
    scheduleStack.appendChild(cooldownField.el);

    var humanSwitch = createSwitch({
      checked: draft.telegram_ai_filter_human,
      label: 'Chỉ cảnh báo khi có người',
      description: 'Bộ lọc phía camera chỉ gửi sự kiện có người, giảm cảnh báo giả.',
      testId: 'settings-telegram-human'
    }, 'telegram_ai_filter_human', 'telegram');
    scheduleStack.appendChild(humanSwitch.el);
    scheduleCard.body.appendChild(scheduleStack);
    panel.appendChild(scheduleCard.el);

    /* Thẻ nhớ */
    var storageCard = makeCard({
      title: 'Giám sát thẻ nhớ',
      subtitle: 'Cảnh báo khi thẻ nhớ đầy, lỗi hoặc không ghi được',
      icon: 'sd-card',
      testId: 'settings-telegram-storage'
    });
    var storageStack = el('div', { class: 'c-stack c-stack--sm' });
    var storageSwitch = createSwitch({
      checked: draft.telegram_storage_alerts,
      label: 'Gửi cảnh báo thẻ nhớ',
      description: 'Tắt để dừng cảnh báo sức khoẻ thẻ nhớ.',
      testId: 'settings-telegram-storage-alerts'
    }, 'telegram_storage_alerts', 'telegram');
    var intervalField = createField({
      label: 'Chu kỳ kiểm tra (phút)',
      type: 'number',
      value: draft.telegram_storage_check_interval,
      min: 5,
      max: 1440,
      step: 1,
      help: 'Từ 5 đến 1440 phút.',
      testId: 'settings-telegram-storage-interval'
    }, 'telegram_storage_check_interval', 'telegram');
    appendAll(storageStack, [storageSwitch.el, intervalField.el]);
    storageCard.body.appendChild(storageStack);
    panel.appendChild(storageCard.el);

    /* Camera nhận cảnh báo */
    var armedCard = makeCard({
      title: 'Camera gửi cảnh báo',
      subtitle: 'Giới hạn danh sách camera được gửi Telegram',
      icon: 'cameras',
      testId: 'settings-telegram-cameras'
    });
    var armedStack = el('div', { class: 'c-stack c-stack--sm' });
    var allSwitch = ui.switch({
      checked: draft.use_all_cameras,
      label: 'Áp dụng cho tất cả camera',
      description: 'Khi tắt, chỉ các camera được chọn mới gửi cảnh báo.',
      testId: 'settings-telegram-all-cameras',
      onChange: function (checked) {
        draft.use_all_cameras = !!checked;
        if (checked) { draft.telegram_armed_cameras = []; }
        markDirty();
        renderArmedList();
      }
    });
    armedStack.appendChild(allSwitch.el);
    var armedHost = el('div', { class: 'c-stack c-stack--sm' });
    var armedError = errorSlot('telegram_armed_cameras', 'telegram');
    armedStack.appendChild(armedHost);
    armedStack.appendChild(armedError);
    armedCard.body.appendChild(armedStack);
    armedRefs = { host: armedHost };
    renderArmedList();
    panel.appendChild(armedCard.el);
  }

  function renderArmedList() {
    if (!armedRefs) { return; }
    var host = armedRefs.host;
    clear(host);
    if (draft.use_all_cameras) {
      host.appendChild(el('div', {
        class: 'c-row c-row--wrap',
        children: [
          ui.badge('Tất cả camera', { tone: 'success' }),
          el('span', {
            class: 'u-muted',
            text: viewData.cameras.length + ' camera trong danh sách quản lý sẽ gửi cảnh báo.'
          })
        ]
      }));
      return;
    }

    var selected = draft.telegram_armed_cameras.slice();
    var known = Object.create(null);
    var cameras = Array.isArray(viewData.cameras) ? viewData.cameras : [];
    cameras.forEach(function (camera) {
      if (!camera || !camera.ip) { return; }
      var ip = str(camera.ip);
      known[ip] = true;
      host.appendChild(cameraCheckbox(camera.name || ip, ip, camera.status, selected));
    });
    selected.forEach(function (ip) {
      if (!known[ip]) {
        host.appendChild(cameraCheckbox('Camera không còn trong danh sách quản lý', ip, 'unknown', selected));
      }
    });
    if (!cameras.length && !selected.length) {
      host.appendChild(ui.empty({
        icon: 'camera',
        title: 'Chưa có camera',
        description: 'Thêm camera ở màn Camera để chọn danh sách gửi cảnh báo.'
      }));
    }
  }

  function cameraCheckbox(name, ip, statusValue, selected) {
    var label = el('label', { class: 'c-check' });
    var box = el('input', { attrs: { type: 'checkbox' } });
    box.checked = selected.indexOf(ip) !== -1;
    box.addEventListener('change', function () {
      var list = draft.telegram_armed_cameras.slice();
      var index = list.indexOf(ip);
      if (box.checked && index === -1) { list.push(ip); }
      if (!box.checked && index !== -1) { list.splice(index, 1); }
      draft.telegram_armed_cameras = list;
      var meta = fieldHandles.telegram_armed_cameras;
      if (meta && meta.handle && meta.handle.clearError) { meta.handle.clearError(); }
      markDirty();
    });
    label.appendChild(box);
    var text = el('span');
    text.appendChild(el('strong', { text: String(name) }));
    text.appendChild(el('span', { class: 'u-mono u-muted', text: ' · ' + String(ip) }));
    label.appendChild(text);
    if (statusValue) {
      var statusInfo = fmt.status(statusValue);
      label.appendChild(ui.badge(statusInfo.label, { tone: statusInfo.tone }));
    }
    return label;
  }

  function sendTelegramTest(btn) {
    if (!ctxRef || destroyed || loading || saving) { return; }
    if (isTestMode()) {
      toast('Chế độ kiểm thử không gửi Telegram.', { type: 'info' });
      return;
    }
    var token = secretRefs.telegram_bot_token ? secretRefs.telegram_bot_token.getValue().trim() : '';
    var chat = secretRefs.telegram_chat_id ? secretRefs.telegram_chat_id.getValue().trim() : '';
    if (token || chat) {
      toast('Có thay đổi Telegram chưa lưu. Hãy bấm "Lưu cấu hình" trước khi gửi thử.', {
        type: 'warning',
        duration: 7000
      });
      return;
    }
    var secrets = viewData.secrets || {};
    if (!secrets.telegram_bot_token_set || !secrets.telegram_chat_id_set) {
      toast('Chưa cấu hình đủ Bot Token và Chat ID.', { type: 'warning' });
      return;
    }
    if (btn) { ui.busy(btn, true, 'Đang gửi…'); }
    ctxRef.api.post('/api/alarm/test', {}, {
      signal: ctxRef.signal,
      silent: true,
      timeoutMs: 30000
    }).then(function () {
      if (destroyed) { return; }
      toast('Đã gửi tin nhắn thử Telegram.', { type: 'success' });
    }).catch(function (err) {
      if (isAborted(err) || destroyed) { return; }
      if (err && err.code === 'TEST_MODE_BLOCKED') {
        toast('Chế độ kiểm thử chặn gửi Telegram.', { type: 'info' });
        return;
      }
      if (err && err.code === 'TELEGRAM_NOT_CONFIGURED') {
        toast('Chưa cấu hình Telegram trên máy chủ.', { type: 'warning' });
        return;
      }
      notifyError(err);
    }).finally(function () {
      if (btn && !destroyed) { ui.busy(btn, false); }
    });
  }

  function clearSecretAction(btn, options) {
    if (!ctxRef || destroyed || loading || saving) { return; }
    var token = mountToken;
    ctxRef.confirm({
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel || 'Xoá',
      variant: 'danger'
    }).then(function (ok) {
      if (!ok || destroyed) { return; }
      if (btn) { ui.busy(btn, true, 'Đang xoá…'); }
      ctxRef.api.post('/api/settings', options.payload, {
        signal: ctxRef.signal,
        silent: true
      }).then(function (data) {
        applySettingsPayload(data);
        optimisticSecrets(options.payload);
        return reloadSettingsQuiet();
      }).then(function () {
        if (isStale(token)) { return; }
        renderAll();
        toast(options.successMessage, { type: 'success' });
      }).catch(function (err) {
        if (isAborted(err) || isStale(token)) { return; }
        handleSettingsError(err);
      }).finally(function () {
        if (!isStale(token)) { ui.busy(btn, false); }
      });
    });
  }

  /* ----------------------------- System panel --------------------------- */

  function buildSystemPanel(panel) {
    var health = viewData.health || {};
    var status = viewData.status || {};
    var runtime = status.runtime || {};
    var alarm = viewData.alarmStatus || {};
    var alarmHealth = health.alarm || {};
    var ffmpeg = ffmpegInfo();
    var healthStatus = health.status || (status.health && status.health.status) || null;
    var tls = health.tls === true || (health.tls === undefined && status.health && status.health.tls);

    var refreshBtn = ui.button({
      label: 'Làm mới chẩn đoán',
      icon: 'refresh',
      variant: 'secondary',
      size: 'sm',
      testId: 'settings-refresh-system',
      onClick: function () { refreshDiagnostics(refreshBtn); }
    });
    var diagCard = makeCard({
      title: 'Chẩn đoán hệ thống',
      subtitle: 'Phiên bản, dịch vụ nền, mạng và tài nguyên',
      icon: 'activity',
      actions: [refreshBtn],
      testId: 'settings-diagnostics'
    });
    var dl = kvGrid();
    kvRow(dl, 'Phiên bản ứng dụng', versionLabel(appVersion()));
    kvRow(dl, 'API', versionLabel(apiVersion()));
    kvRow(dl, 'Schema cấu hình', viewData.schemaVersion === null ? '—' : String(viewData.schemaVersion));
    kvRow(dl, 'Python', runtime.python_version || '—');
    kvRow(dl, 'Nền tảng', platformLabel(runtime.platform));
    kvRow(dl, 'Uptime', health.uptime_seconds
      ? fmt.duration(health.uptime_seconds)
      : (status.app && status.app.uptime_seconds ? fmt.duration(status.app.uptime_seconds) : '—'));
    kvRow(dl, 'Trạng thái', healthStatus === 'ok'
      ? ui.statusPill('ok', { label: 'Bình thường' })
      : (healthStatus ? ui.badge('Suy giảm', { tone: 'warning' })
        : ui.statusPill('unknown', { label: 'Không rõ' })));
    kvRow(dl, 'TLS', tls ? ui.badge('Đang bật HTTPS', { tone: 'success' }) : ui.badge('HTTP trong LAN', { tone: 'warning' }));
    kvRow(dl, 'Chế độ', isTestMode() ? 'Kiểm thử' : 'Vận hành');

    var lanUrl = status.net && status.net.lan_url ? String(status.net.lan_url) : window.location.origin;
    var urlRow = el('span', { class: 'c-row c-row--wrap' });
    urlRow.appendChild(el('span', { class: 'u-mono', text: lanUrl }));
    urlRow.appendChild(ui.button({
      label: 'Sao chép',
      icon: 'copy',
      variant: 'ghost',
      size: 'sm',
      testId: 'settings-copy-lan',
      onClick: function () { ui.copy(lanUrl, { label: 'địa chỉ LAN' }); }
    }));
    kvRow(dl, 'Địa chỉ LAN', urlRow);
    kvRow(dl, 'IP LAN', Array.isArray(status.net && status.net.lan_ips) && status.net.lan_ips.length
      ? status.net.lan_ips.join(', ') : '—');

    var listeners = listenerCount();
    kvRow(dl, 'Listener cảnh báo', listeners === null ? '—' : (listeners + ' camera'));
    kvRow(dl, 'Chế độ gác', alarm.armed === true
      ? ui.badge('Đang gác', { tone: 'success' })
      : (alarm.armed === false ? ui.badge('Tắt gác', { tone: 'neutral' }) : '—'));
    var grace = alarm.startup_grace_remaining_seconds;
    if (grace === undefined || grace === null) {
      grace = alarmHealth.grace_remaining_seconds;
    }
    if (grace !== undefined && grace !== null && Number(grace) > 0) {
      kvRow(dl, 'Chờ khởi động cảnh báo', fmt.duration(grace) + ' còn lại');
    }
    kvRow(dl, 'FFmpeg', ffmpeg
      ? (ffmpeg.available
        ? ui.badge('Sẵn sàng' + (ffmpeg.version ? ' · ' + ffmpeg.version : ''), { tone: 'success' })
        : ui.badge('Thiếu', { tone: 'danger' }))
      : '—');
    if (runtime.ffmpeg_path) {
      kvRow(dl, 'Đường dẫn FFmpeg', el('span', { class: 'u-mono', text: String(runtime.ffmpeg_path) }));
    }
    var free = diskFreeBytes();
    kvRow(dl, 'Dung lượng trống', free === null
      ? el('span', { class: 'u-muted', text: 'Máy chủ chưa cung cấp số liệu dung lượng ổ đĩa' })
      : fmt.bytes(free));
    diagCard.body.appendChild(dl);

    if (health.storage) {
      var storageRow = el('div', { class: 'c-row c-row--wrap' });
      storageRow.appendChild(el('span', { class: 'u-muted', text: 'Thư mục ghi hình:' }));
      storageRow.appendChild(ui.badge(health.storage.recordings_writable !== false ? 'Ghi được' : 'Không ghi được', {
        tone: health.storage.recordings_writable !== false ? 'success' : 'danger'
      }));
      storageRow.appendChild(el('span', { class: 'u-muted', text: 'Snapshot:' }));
      storageRow.appendChild(ui.badge(health.storage.snapshots_writable !== false ? 'Ghi được' : 'Không ghi được', {
        tone: health.storage.snapshots_writable !== false ? 'success' : 'danger'
      }));
      diagCard.body.appendChild(storageRow);
    }

    var warnings = Array.isArray(status.warnings) ? status.warnings : [];
    if (warnings.length) {
      var warnWrap = el('div', { class: 'c-banner-list' });
      warnings.forEach(function (warning) {
        if (!warning) { return; }
        warnWrap.appendChild(ui.banner({
          tone: warningTone(warning.severity),
          title: warning.code || 'Cảnh báo hệ thống',
          message: warning.message || ''
        }));
      });
      diagCard.body.appendChild(warnWrap);
    }
    panel.appendChild(diagCard.el);

    /* Vận hành cảnh báo */
    var opCard = makeCard({
      title: 'Vận hành cảnh báo',
      subtitle: 'Thời gian chờ sau khởi động để tránh cảnh báo giả',
      icon: 'clock',
      testId: 'settings-alarm-operation'
    });
    var graceField = createField({
      label: 'Chờ sau khởi động (giây)',
      type: 'number',
      value: draft.alarm_startup_grace_seconds,
      min: 0,
      max: 600,
      step: 1,
      help: 'Từ 0 đến 600 giây. Trong thời gian này AlarmManager không gửi cảnh báo.',
      testId: 'settings-alarm-grace'
    }, 'alarm_startup_grace_seconds', 'system');
    opCard.body.appendChild(graceField.el);
    opCard.body.appendChild(note(
      'Giá trị này áp dụng cho lần khởi động tiếp theo của dịch vụ cảnh báo. '
      + 'Đặt 0 chỉ khi đã kiểm tra kỹ để tránh cảnh báo giả.'
    ));
    panel.appendChild(opCard.el);

    /* PWA / APK */
    var pwaCard = makeCard({
      title: 'Ứng dụng PWA và APK',
      subtitle: 'Cài CCTV Vision Hub trên thiết bị nội bộ',
      icon: 'smartphone',
      testId: 'settings-pwa-apk'
    });
    var installBtn = ui.button({
      label: 'Cài đặt PWA',
      icon: 'install',
      variant: 'primary',
      size: 'sm',
      testId: 'settings-install-pwa',
      onClick: function () {
        var triggered = triggerShellAction('menu-pwa');
        if (!triggered) {
          toast('Dùng menu trình duyệt để cài ứng dụng. Xem hướng dẫn ở tab Giới thiệu.', { type: 'info' });
          switchTab('about');
        }
      }
    });
    var apkBtn = ui.button({
      label: 'Tải APK nội bộ',
      icon: 'download',
      variant: 'secondary',
      size: 'sm',
      testId: 'settings-download-apk',
      onClick: function () { downloadApk(apkBtn); }
    });
    var guideBtn = ui.button({
      label: 'Xem hướng dẫn',
      icon: 'info',
      variant: 'ghost',
      size: 'sm',
      testId: 'settings-pwa-guide',
      onClick: function () {
        switchTab('about');
        if (panels.about && panels.about.focus) { panels.about.focus(); }
      }
    });
    var pwaRow = el('div', { class: 'c-row c-row--wrap' });
    appendAll(pwaRow, [installBtn, apkBtn, guideBtn]);
    pwaCard.body.appendChild(pwaRow);
    pwaCard.body.appendChild(note(
      'APK nội bộ được ký debug, chỉ dùng để cài trực tiếp trên thiết bị Android nội bộ; không phát hành qua cửa hàng ứng dụng.'
    ));
    panel.appendChild(pwaCard.el);

    /* Vùng nguy hiểm */
    var dangerCard = makeCard({
      title: 'Khôi phục cấu hình vận hành',
      subtitle: 'Chỉ đặt lại tham số quét, lịch gửi, chống trùng và chờ khởi động',
      icon: 'alert-triangle',
      testId: 'settings-danger-zone'
    });
    dangerCard.body.appendChild(note(
      'Không xoá mật khẩu quản trị, mật khẩu người xem, token Telegram, thư mục lưu trữ, '
      + 'dải mạng mặc định hay danh sách camera gửi cảnh báo.'
    ));
    var resetBtn = ui.button({
      label: 'Khôi phục mặc định vận hành',
      icon: 'rotate-ccw',
      variant: 'danger',
      size: 'sm',
      testId: 'settings-reset-defaults',
      onClick: function () { resetOperationalDefaults(resetBtn); }
    });
    var resetRow = el('div', { class: 'c-row c-row--wrap' });
    resetRow.appendChild(resetBtn);
    dangerCard.body.appendChild(resetRow);
    panel.appendChild(dangerCard.el);
  }

  function rebuildPanels(ids) {
    if (!panels || !bodyHost) { return; }
    ids.forEach(function (id) {
      if (!panels[id]) { return; }
      Object.keys(fieldHandles).forEach(function (key) {
        if (fieldHandles[key] && fieldHandles[key].tab === id) { delete fieldHandles[key]; }
      });
      clear(panels[id]);
      buildPanel(id, panels[id]);
    });
    renderBanners();
    updateDirtyUi();
  }

  function refreshDiagnostics(btn) {
    if (!ctxRef || loading || saving || destroyed) { return; }
    var token = mountToken;
    if (btn) { ui.busy(btn, true, 'Đang tải…'); }
    setLoading(true);
    loadData({ includeSettings: false, keepDraft: true })
      .then(function () {
        if (isStale(token)) { return; }
        rebuildPanels(['system', 'storage']);
        toast('Đã cập nhật chẩn đoán.', { type: 'success' });
      })
      .catch(function (err) {
        if (isStale(token) || isAborted(err)) { return; }
        notifyError(err);
      })
      .finally(function () {
        if (isStale(token)) { return; }
        setLoading(false);
        if (btn) { ui.busy(btn, false); }
      });
  }

  function triggerShellAction(id) {
    var node = document.getElementById(id);
    if (node && typeof node.click === 'function') {
      node.click();
      return true;
    }
    return false;
  }

  function downloadApk(btn) {
    if (!ctxRef || destroyed) { return; }
    if (btn) { ui.busy(btn, true, 'Đang tải…'); }
    ctxRef.api.getBlob('/download/app.apk', {
      signal: ctxRef.signal,
      silent: true,
      timeoutMs: 120000
    }).then(function (result) {
      if (destroyed || !result) { return; }
      var filename = result.filename || ('CCTV-VisionHub-v' + appVersion() + '.apk');
      ui.downloadBlob(result.blob, filename);
      toast('Đã bắt đầu tải APK.', { type: 'success' });
    }).catch(function (err) {
      if (isAborted(err) || destroyed) { return; }
      if (err && (err.code === 'APK_NOT_AVAILABLE' || err.status === 404)) {
        toast('APK nội bộ chưa có. Dùng bản PWA hoặc liên hệ quản trị viên.', { type: 'info' });
        return;
      }
      notifyError(err);
    }).finally(function () {
      if (btn && !destroyed) { ui.busy(btn, false); }
    });
  }

  function resetOperationalDefaults(btn) {
    if (!ctxRef || destroyed || loading || saving) { return; }
    var token = mountToken;
    ctxRef.confirm({
      title: 'Khôi phục cấu hình vận hành mặc định?',
      message: 'Các tham số quét, lịch gửi Telegram, chống trùng và thời gian chờ khởi động sẽ trở về mặc định. '
        + 'Mật khẩu, token, thư mục lưu trữ và danh sách camera không bị thay đổi.',
      confirmLabel: 'Khôi phục',
      requireText: 'RESET',
      requireTextLabel: 'Gõ RESET để xác nhận',
      variant: 'danger'
    }).then(function (ok) {
      if (!ok || destroyed) { return; }
      if (btn) { ui.busy(btn, true, 'Đang khôi phục…'); }
      ctxRef.api.post('/api/settings', OPERATIONAL_DEFAULTS, {
        signal: ctxRef.signal,
        silent: true
      }).then(function (data) {
        applySettingsPayload(data);
        return reloadSettingsQuiet();
      }).then(function () {
        if (isStale(token)) { return; }
        resetDraft(viewData.settings);
        dirty = false;
        renderAll();
        toast('Đã khôi phục cấu hình vận hành mặc định.', { type: 'success' });
      }).catch(function (err) {
        if (isAborted(err) || isStale(token)) { return; }
        handleSettingsError(err);
      }).finally(function () {
        if (!isStale(token)) { ui.busy(btn, false); }
      });
    });
  }

  /* ----------------------------- About panel ---------------------------- */

  function buildAboutPanel(panel) {
    var aboutCard = makeCard({
      title: 'CCTV Vision Hub',
      subtitle: 'Trung tâm vận hành camera và cảnh báo an ninh nội bộ',
      icon: 'logo',
      testId: 'settings-about'
    });
    aboutCard.body.appendChild(note(
      'Ứng dụng quản lý camera Dahua/Imou/Hikvision/ONVIF, xem trực tiếp qua MJPEG, điều khiển PTZ, '
      + 'quản lý NVR và thẻ nhớ, gửi cảnh báo Telegram, hỗ trợ PWA và APK nội bộ.'
    ));
    var aboutDl = kvGrid();
    kvRow(aboutDl, 'Phiên bản', versionLabel(appVersion()));
    kvRow(aboutDl, 'API', versionLabel(apiVersion()));
    kvRow(aboutDl, 'Vai trò', ctxRef.role === 'admin' ? 'Quản trị viên' : 'Người xem');
    kvRow(aboutDl, 'Chế độ', isTestMode() ? 'Kiểm thử' : 'Vận hành');
    aboutCard.body.appendChild(aboutDl);

    var features = [
      'Quét mạng Dahua/Imou, ONVIF và Hikvision SADP; lọc model và xuất CSV.',
      'Quản lý camera/NVR, nhóm, arm/disarm, kiểm tra kết nối và đồng bộ sức khoẻ.',
      'Xem trực tiếp MJPEG, audio, snapshot, ghi hình, PTZ/preset và grid 2x2/3x3.',
      'Chi tiết camera, đổi tên, privacy, tracking, siren và quản lý thẻ nhớ.',
      'Cảnh báo Telegram có lịch gác, chống trùng, lọc người và watchdog thẻ nhớ.',
      'Phân quyền admin/viewer, phiên an toàn, CSRF và giới hạn đăng nhập.'
    ];
    var featureList = el('div', { class: 'c-stack c-stack--sm' });
    features.forEach(function (text) {
      var row = el('div', { class: 'c-row' });
      row.appendChild(svg('check-circle', { size: 16 }));
      row.appendChild(el('span', { text: text }));
      featureList.appendChild(row);
    });
    aboutCard.body.appendChild(featureList);
    panel.appendChild(aboutCard.el);

    var installCard = makeCard({
      title: 'Hướng dẫn PWA và APK',
      subtitle: 'Cài ứng dụng trên thiết bị nội bộ',
      icon: 'install',
      testId: 'settings-about-install'
    });
    var guide = el('div', { class: 'c-stack c-stack--sm' });
    guide.appendChild(el('h3', { text: 'Cài PWA' }));
    guide.appendChild(el('p', {
      class: 'c-muted-block',
      text: 'Desktop Chrome/Edge: mở menu trình duyệt, chọn "Cài đặt ứng dụng" hoặc biểu tượng cài trên thanh địa chỉ.'
    }));
    guide.appendChild(el('p', {
      class: 'c-muted-block',
      text: 'Android Chrome: menu trình duyệt, chọn "Thêm vào màn hình chính". iOS Safari: nút Chia sẻ, '
        + 'chọn "Thêm vào màn hình chính".'
    }));
    guide.appendChild(el('h3', { text: 'Cài APK nội bộ' }));
    guide.appendChild(el('p', {
      class: 'c-muted-block',
      text: 'Tải APK ở tab Hệ thống. APK được ký debug cho môi trường nội bộ; cần bật cài đặt từ nguồn '
        + 'không xác định trên thiết bị Android. Không dùng APK này để phát hành công khai.'
    }));
    guide.appendChild(el('p', {
      class: 'c-muted-block',
      text: 'Nếu APK chưa có, máy chủ trả APK_NOT_AVAILABLE. Khi đó hãy dùng PWA hoặc liên hệ quản trị viên.'
    }));
    installCard.body.appendChild(guide);
    panel.appendChild(installCard.el);

    var securityCard = makeCard({
      title: 'Bảo mật và phiên',
      subtitle: 'Nguyên tắc vận hành an toàn',
      icon: 'shield',
      testId: 'settings-about-security'
    });
    var securityList = el('div', { class: 'c-stack c-stack--sm' });
    [
      'Mọi API (trừ health và các API xác thực công khai) đều yêu cầu phiên hợp lệ; thao tác thay đổi trạng thái do máy chủ kiểm tra quyền admin.',
      'Mật khẩu được hash bằng scrypt; giao diện không nhận lại hash hay mật khẩu đã lưu.',
      'Cookie phiên là HttpOnly, SameSite=Strict và có Secure khi chạy HTTPS.',
      'Mọi yêu cầu thay đổi trạng thái cần CSRF token; đăng nhập bị giới hạn số lần thử.',
      'Mật khẩu camera không được đưa vào URL, bộ nhớ cục bộ của trình duyệt hay nội dung hiển thị.'
    ].forEach(function (text) {
      var row = el('div', { class: 'c-row' });
      row.appendChild(svg('shield', { size: 16 }));
      row.appendChild(el('span', { text: text }));
      securityList.appendChild(row);
    });
    securityCard.body.appendChild(securityList);
    panel.appendChild(securityCard.el);
  }

  /* ------------------------------ Save flow ----------------------------- */

  function buildPayload() {
    var payload = {};
    var baselineValue = baseline || {};

    if (draftChanged('default_subnet')) {
      payload.default_subnet = String(draft.default_subnet || '').trim();
    }
    if (draftChanged('last_subnets')) {
      payload.last_subnets = String(draft.last_subnets || '').trim();
    }
    if (draftChanged('scan_timeout')) {
      payload.scan_timeout = Number(draft.scan_timeout);
    }
    if (draftChanged('deep_scan')) {
      payload.deep_scan = !!draft.deep_scan;
    }
    if (draftChanged('selected_vlans')) {
      payload.selected_vlans = draft.selected_vlans.slice(0, 20).map(function (item) {
        return String(item).slice(0, 64);
      });
    }
    if (draftChanged('company_vlans')) {
      payload.company_vlans = normalizedVlans(draft.company_vlans);
    }
    if (draftChanged('auto_reboot_on_ip_change')) {
      payload.auto_reboot_on_ip_change = !!draft.auto_reboot_on_ip_change;
    }
    if (draftChanged('telegram_enabled')) {
      payload.telegram_enabled = !!draft.telegram_enabled;
    }
    if (draftChanged('telegram_schedule_enabled')) {
      payload.telegram_schedule_enabled = !!draft.telegram_schedule_enabled;
    }
    if (draftChanged('telegram_schedule_start')) {
      payload.telegram_schedule_start = String(draft.telegram_schedule_start || '');
    }
    if (draftChanged('telegram_schedule_end')) {
      payload.telegram_schedule_end = String(draft.telegram_schedule_end || '');
    }
    if (draftChanged('telegram_cooldown_seconds')) {
      payload.telegram_cooldown_seconds = Number(draft.telegram_cooldown_seconds);
    }
    if (draftChanged('telegram_ai_filter_human')) {
      payload.telegram_ai_filter_human = !!draft.telegram_ai_filter_human;
    }
    if (draftChanged('telegram_storage_alerts')) {
      payload.telegram_storage_alerts = !!draft.telegram_storage_alerts;
    }
    if (draftChanged('telegram_storage_check_interval')) {
      payload.telegram_storage_check_interval = Number(draft.telegram_storage_check_interval);
    }
    if (armedChanged()) {
      payload.telegram_armed_cameras = effectiveArmed(draft).slice(0, 256);
    }
    if (draftChanged('alarm_startup_grace_seconds')) {
      payload.alarm_startup_grace_seconds = Number(draft.alarm_startup_grace_seconds);
    }

    var recordings = String(draft.recordings_dir || '').trim();
    var snapshots = String(draft.snapshots_dir || '').trim();
    var baselineRecordings = String(baselineValue.recordings_dir || '').trim();
    var baselineSnapshots = String(baselineValue.snapshots_dir || '').trim();
    if (recordings !== baselineRecordings && recordings) {
      payload.recordings_dir = recordings;
    }
    if (snapshots !== baselineSnapshots && snapshots) {
      payload.snapshots_dir = snapshots;
    }

    if (!viewData.secretsManagedExternally) {
      var token = secretRefs.telegram_bot_token
        ? String(secretRefs.telegram_bot_token.getValue() || '') : '';
      var chat = secretRefs.telegram_chat_id
        ? String(secretRefs.telegram_chat_id.getValue() || '') : '';
      var defaultPassword = secretRefs.default_password
        ? String(secretRefs.default_password.getValue() || '') : '';
      if (token.trim()) { payload.telegram_bot_token = token.trim(); }
      if (chat.trim()) { payload.telegram_chat_id = chat.trim(); }
      if (defaultPassword.trim()) { payload.default_password = defaultPassword; }
    }
    return payload;
  }

  function validateDraft() {
    clearAllErrors();
    var firstKey = null;
    function add(key, message) {
      setFieldError(key, message);
      if (!firstKey) { firstKey = key; }
    }

    if (draftChanged('scan_timeout')) {
      var timeout = Number(draft.scan_timeout);
      if (!isFinite(timeout) || timeout < 1 || timeout > 10) {
        add('scan_timeout', 'Thời gian chờ phải trong khoảng 1 đến 10 giây.');
      }
    }
    if (draftChanged('default_subnet')) {
      var subnetText = String(draft.default_subnet || '').trim();
      if (subnetText.length > 500) {
        add('default_subnet', 'Dải mạng tối đa 500 ký tự.');
      } else if (subnetText && subnetText.split(',').length > 8) {
        add('default_subnet', 'Chỉ được nhập tối đa 8 biểu thức mạng.');
      }
    }
    if (draftChanged('last_subnets')) {
      var lastText = String(draft.last_subnets || '').trim();
      if (lastText.length > 500) {
        add('last_subnets', 'Dải quét gần nhất tối đa 500 ký tự.');
      } else if (lastText && lastText.split(',').length > 8) {
        add('last_subnets', 'Chỉ được nhập tối đa 8 biểu thức mạng.');
      }
    }

    var recDir = String(draft.recordings_dir || '').trim();
    var snapDir = String(draft.snapshots_dir || '').trim();
    var baselineRecordings = baseline ? String(baseline.recordings_dir || '').trim() : '';
    var baselineSnapshots = baseline ? String(baseline.snapshots_dir || '').trim() : '';
    if (recDir !== baselineRecordings) {
      if (baselineRecordings && !recDir) {
        add('recordings_dir', 'Không thể xoá thư mục đã cấu hình; nhập thư mục khác.');
      } else if (recDir.length > 500) {
        add('recordings_dir', 'Đường dẫn tối đa 500 ký tự.');
      }
    }
    if (snapDir !== baselineSnapshots) {
      if (baselineSnapshots && !snapDir) {
        add('snapshots_dir', 'Không thể xoá thư mục đã cấu hình; nhập thư mục khác.');
      } else if (snapDir.length > 500) {
        add('snapshots_dir', 'Đường dẫn tối đa 500 ký tự.');
      }
    }

    if (draftChanged('telegram_schedule_start') && !timePattern(draft.telegram_schedule_start)) {
      add('telegram_schedule_start', 'Giờ bắt đầu phải có định dạng HH:MM.');
    }
    if (draftChanged('telegram_schedule_end') && !timePattern(draft.telegram_schedule_end)) {
      add('telegram_schedule_end', 'Giờ kết thúc phải có định dạng HH:MM.');
    }
    if (draftChanged('telegram_cooldown_seconds')) {
      var cooldown = Number(draft.telegram_cooldown_seconds);
      if (!isInt(cooldown) || cooldown < 10 || cooldown > 3600) {
        add('telegram_cooldown_seconds', 'Chống trùng phải là số nguyên từ 10 đến 3600 giây.');
      }
    }
    if (draftChanged('telegram_storage_check_interval')) {
      var interval = Number(draft.telegram_storage_check_interval);
      if (!isInt(interval) || interval < 5 || interval > 1440) {
        add('telegram_storage_check_interval', 'Chu kỳ kiểm tra phải là số nguyên từ 5 đến 1440 phút.');
      }
    }
    if (draftChanged('alarm_startup_grace_seconds')) {
      var grace = Number(draft.alarm_startup_grace_seconds);
      if (!isInt(grace) || grace < 0 || grace > 600) {
        add('alarm_startup_grace_seconds', 'Thời gian chờ phải là số nguyên từ 0 đến 600 giây.');
      }
    }

    if (draftChanged('selected_vlans')) {
      if (draft.selected_vlans.length > 20) {
        add('selected_vlans', 'Chỉ được chọn tối đa 20 VLAN.');
      } else {
        for (var i = 0; i < draft.selected_vlans.length; i += 1) {
          if (String(draft.selected_vlans[i]).length > 64) {
            add('selected_vlans', 'Tên VLAN tối đa 64 ký tự.');
            break;
          }
        }
      }
    }
    if (draftChanged('company_vlans') && draft.company_vlans.length > 64) {
      add('company_vlans', 'Chỉ được lưu tối đa 64 VLAN.');
    }

    if (armedChanged()) {
      if (!draft.use_all_cameras) {
        if (!draft.telegram_armed_cameras.length) {
          add('telegram_armed_cameras', 'Chọn ít nhất một camera hoặc bật "Áp dụng cho tất cả camera".');
        } else if (draft.telegram_armed_cameras.length > 256) {
          add('telegram_armed_cameras', 'Danh sách camera tối đa 256 phần tử.');
        } else {
          for (var j = 0; j < draft.telegram_armed_cameras.length; j += 1) {
            var ip = String(draft.telegram_armed_cameras[j]);
            var parts = ip.split('.');
            var valid = parts.length === 4 && parts.every(function (part) {
              return /^\d{1,3}$/.test(part) && Number(part) <= 255;
            });
            if (!valid) {
              add('telegram_armed_cameras', 'Danh sách camera chứa IP không hợp lệ.');
              break;
            }
          }
        }
      }
    }

    if (secretRefs.default_password) {
      var defaultPassword = String(secretRefs.default_password.getValue() || '');
      if (defaultPassword.trim() && (defaultPassword.length < 8 || defaultPassword.length > 128)) {
        add('default_password', 'Mật khẩu camera mặc định phải có 8 đến 128 ký tự.');
      }
    }
    if (secretRefs.telegram_bot_token) {
      var token = String(secretRefs.telegram_bot_token.getValue() || '').trim();
      if (token.length > 256) { add('telegram_bot_token', 'Bot Token tối đa 256 ký tự.'); }
    }
    if (secretRefs.telegram_chat_id) {
      var chat = String(secretRefs.telegram_chat_id.getValue() || '').trim();
      if (chat.length > 64) { add('telegram_chat_id', 'Chat ID tối đa 64 ký tự.'); }
    }

    if (firstKey) {
      focusField(firstKey);
      return false;
    }
    return true;
  }

  function handleSettingsError(err) {
    if (!err || isAborted(err) || err.status === 401) { return; }
    if (err.code === 'SECRETS_MANAGED_EXTERNALLY') {
      viewData.secretsManagedExternally = true;
      renderAll();
    }
    var fields = err.details && isObj(err.details.fields) ? err.details.fields : null;
    if (fields) {
      showServerFieldErrors(fields);
      toast('Máy chủ báo dữ liệu chưa hợp lệ. Kiểm tra các trường được đánh dấu.', {
        type: 'warning',
        duration: 7000
      });
      return;
    }
    toast(errorText(err), { type: 'error', duration: 8000 });
  }

  function saveAll() {
    if (!ctxRef || !draft || loading || saving || destroyed) { return; }
    var token = mountToken;
    clearAllErrors();
    if (!validateDraft()) {
      toast('Vui lòng kiểm tra các trường được đánh dấu.', { type: 'warning' });
      return;
    }
    var payload = buildPayload();
    var btn = headerRefs && headerRefs.saveBtn ? headerRefs.saveBtn : null;
    saving = true;
    if (btn) { ui.busy(btn, true, 'Đang lưu…'); }
    updateDirtyUi();
    ctxRef.api.post('/api/settings', payload, {
      signal: ctxRef.signal,
      silent: true,
      timeoutMs: 45000
    }).then(function (data) {
      applySettingsPayload(data);
      optimisticSecrets(payload);
      return reloadSettingsQuiet();
    }).then(function () {
      if (isStale(token) || ctxRef.signal.aborted) { return; }
      resetDraft(viewData.settings);
      dirty = false;
      renderAll();
      toast('Đã lưu cài đặt.', { type: 'success' });
    }).catch(function (err) {
      if (isAborted(err) || isStale(token)) { return; }
      handleSettingsError(err);
    }).finally(function () {
      if (isStale(token)) { return; }
      saving = false;
      clearSecretInputs();
      if (btn) { ui.busy(btn, false); }
      updateDirtyUi();
    });
  }

  /* ----------------------------- Load shell ----------------------------- */

  function setLoading(value) {
    loading = !!value;
    if (bodyHost) {
      bodyHost.setAttribute('aria-busy', loading ? 'true' : 'false');
    }
    if (headerRefs && headerRefs.refreshBtn) {
      headerRefs.refreshBtn.disabled = loading;
    }
    updateDirtyUi();
  }

  function skeletonBody() {
    var card = makeCard({
      title: 'Đang tải cài đặt',
      icon: 'loader',
      body: [ui.skeleton({ variant: 'text', rows: 8 })]
    });
    return card.el;
  }

  function startInitialLoad() {
    if (!bodyHost || destroyed) { return; }
    var token = mountToken;
    clear(bodyHost);
    bodyHost.appendChild(skeletonBody());
    setLoading(true);
    loadData({ includeSettings: true, keepDraft: false }).then(function () {
      if (isStale(token)) { return; }
      renderAll();
    }).catch(function (err) {
      if (isStale(token) || isAborted(err)) { return; }
      renderLoadError(err);
    }).finally(function () {
      if (!isStale(token)) { setLoading(false); }
    });
  }

  function renderLoadError(err) {
    if (!bodyHost) { return; }
    clear(bodyHost);
    if (err && err.status === 403) {
      bodyHost.appendChild(ui.empty({
        icon: 'lock',
        title: 'Không đủ quyền',
        description: 'Màn hình Cài đặt chỉ dành cho quản trị viên.',
        action: ui.button({
          label: 'Về tổng quan',
          icon: 'dashboard',
          variant: 'primary',
          onClick: function () { ctxRef.router.go('dashboard'); }
        })
      }));
      return;
    }
    bodyHost.appendChild(ui.errorPanel({
      title: 'Không tải được cài đặt',
      message: err && err.message ? err.message : 'Máy chủ không trả cấu hình.',
      code: err && err.code ? err.code : null,
      requestId: err && err.requestId ? err.requestId : null,
      retry: function () { startInitialLoad(); }
    }));
  }

  function refreshAll(btn) {
    if (!ctxRef || loading || saving || destroyed) { return; }
    var token = mountToken;
    var includeSettings = !dirty;
    if (btn) { ui.busy(btn, true, 'Đang làm mới…'); }
    setLoading(true);
    loadData({ includeSettings: includeSettings, keepDraft: !includeSettings }).then(function () {
      if (isStale(token)) { return; }
      if (includeSettings) {
        renderAll();
      } else {
        rebuildPanels(['system', 'storage']);
        toast('Đã làm mới chẩn đoán. Thay đổi chưa lưu được giữ nguyên.', { type: 'info' });
      }
    }).catch(function (err) {
      if (isStale(token) || isAborted(err)) { return; }
      notifyError(err);
    }).finally(function () {
      if (isStale(token)) { return; }
      setLoading(false);
      if (btn) { ui.busy(btn, false); }
    });
  }

  /* ------------------------------- Lifecycle ---------------------------- */

  function renderDenied(container) {
    var root = el('div', { class: 'c-stack' });
    root.appendChild(ui.pageHeader({
      title: 'Cài đặt',
      subtitle: 'Màn hình chỉ dành cho quản trị viên',
      icon: 'settings'
    }));
    root.appendChild(ui.empty({
      icon: 'lock',
      title: 'Không đủ quyền truy cập',
      description: 'Tài khoản người xem không thể xem hoặc thay đổi cấu hình hệ thống.',
      action: ui.button({
        label: 'Về tổng quan',
        icon: 'dashboard',
        variant: 'primary',
        onClick: function () { CCTV.router.go('dashboard'); }
      })
    }));
    container.appendChild(root);
  }

  function render(container, ctx) {
    mountToken += 1;
    destroyed = false;
    ctxRef = ctx;
    activeTab = 'account';
    viewData = emptyViewData();
    draft = null;
    baseline = null;
    dirty = false;
    loading = false;
    saving = false;
    detectingVlans = false;
    fieldHandles = {};
    secretRefs = {};
    vlanRefs = null;
    armedRefs = null;
    adminNewRef = null;

    clear(container);
    if (!ctx || !ctx.isAdmin) {
      renderDenied(container);
      return;
    }

    var root = el('div', {
      class: 'c-stack',
      attrs: { 'data-testid': 'settings-page', 'data-admin-only': '1' }
    });
    root.appendChild(buildHeader());
    bannerHost = el('div', { class: 'c-banner-list' });
    bannerHost.hidden = true;
    root.appendChild(bannerHost);
    bodyHost = el('div', { class: 'c-stack' });
    root.appendChild(bodyHost);
    container.appendChild(root);

    startInitialLoad();
  }

  function destroy() {
    mountToken += 1;
    destroyed = true;
    if (tabsCtrl && tabsCtrl.destroy) {
      try { tabsCtrl.destroy(); } catch (err) { /* bỏ qua */ }
    }
    tabsCtrl = null;
    panels = {};
    fieldHandles = {};
    secretRefs = {};
    headerRefs = null;
    vlanRefs = null;
    armedRefs = null;
    adminNewRef = null;
    bannerHost = null;
    bodyHost = null;
    ctxRef = null;
    draft = null;
    baseline = null;
    dirty = false;
    loading = false;
    saving = false;
    detectingVlans = false;
  }

  CCTV.views.register('settings', {
    title: 'Cài đặt',
    icon: 'settings',
    roles: ['admin'],
    order: 70,
    render: render,
    destroy: destroy
  });
})();
