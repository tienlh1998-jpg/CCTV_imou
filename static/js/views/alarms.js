/* =========================================================================
   CCTV Vision Hub v2.0 — view Cảnh báo
   Owner: C6. Chế độ gác, Telegram, watchdog thẻ nhớ và lịch sử cảnh báo.
   Chỉ dùng API/component của core; dữ liệu động render bằng DOM/textContent.
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

  var ctx = null;
  var refs = null;
  var destroyed = false;
  var cameras = [];
  var lastStatus = null;
  var settingsData = null;
  var secrets = null;
  var secretsManagedExternally = false;
  var tgFields = null;
  var tgFieldList = [];
  var cameraChecks = [];
  var stopStatusPoll = null;
  var openLayers = [];
  var refreshing = false;
  var pendingArm = false;
  var pendingWatchdog = false;
  var pendingSave = false;
  var pendingTest = false;
  var pendingClearHistory = false;
  var pendingSecretClear = false;
  var historyTable = null;
  var historyPager = null;
  var historyEmpty = null;
  var historyRows = [];
  var historyTotal = 0;
  var historyPage = 1;
  var historyPageSize = 10;
  var historySeq = 0;

  var HISTORY_STATUSES = [
    { value: '', label: 'Tất cả trạng thái' },
    { value: 'sent', label: 'Đã gửi' },
    { value: 'failed', label: 'Gửi lỗi' },
    { value: 'skipped', label: 'Bỏ qua' },
    { value: 'suppressed', label: 'Đã chặn' }
  ];

  /* ------------------------------ Helpers ------------------------------ */

  function isAdmin() {
    if (ctx && typeof ctx.isAdmin === 'boolean') { return ctx.isAdmin; }
    return CCTV.auth.isAdmin();
  }

  function findCamera(ip) {
    if (!ip) { return null; }
    for (var i = 0; i < cameras.length; i += 1) {
      if (cameras[i] && cameras[i].ip === ip) { return cameras[i]; }
    }
    return null;
  }

  function cameraLabel(ip) {
    var cam = findCamera(ip);
    if (!cam) { return ip || '—'; }
    return cam.name || cam.model || cam.ip || ip || '—';
  }

  function makeCard(options) {
    var card = el('section', {
      class: 'c-card',
      attrs: { 'data-testid': options.testId || null }
    });
    var header = el('div', { class: 'c-card__header' });
    var titleWrap = el('div');
    var title = el('div', { class: 'c-card__title' });
    if (options.icon) { title.appendChild(svg(options.icon, { size: 16 })); }
    title.appendChild(el('span', { text: options.title }));
    titleWrap.appendChild(title);
    if (options.subtitle) {
      titleWrap.appendChild(el('div', { class: 'c-card__subtitle', text: options.subtitle }));
    }
    header.appendChild(titleWrap);
    if (options.actions && options.actions.length) {
      var actions = el('div', { class: 'c-card__actions' });
      dom.append(actions, options.actions);
      header.appendChild(actions);
    }
    card.appendChild(header);
    var body = el('div', { class: 'c-card__body' });
    card.appendChild(body);
    return { el: card, header: header, body: body, title: title };
  }

  function makeKpi(options) {
    var card = ui.kpi({
      label: options.label,
      value: '—',
      hint: '\u00a0',
      icon: options.icon,
      tone: options.tone,
      testId: options.testId
    });
    return {
      el: card,
      value: card.querySelector('.c-kpi__value'),
      hint: card.querySelector('.c-kpi__hint')
    };
  }

  function setKpi(ref, value, hint) {
    if (!ref) { return; }
    if (ref.value) { ref.value.textContent = value === undefined || value === null ? '—' : String(value); }
    if (ref.hint) { ref.hint.textContent = hint || '\u00a0'; }
  }

  function formatCooldown(seconds) {
    var n = Number(seconds);
    if (!isFinite(n) || n <= 0) { return '—'; }
    if (n % 60 === 0) { return Math.round(n / 60) + ' phút'; }
    return Math.round(n) + ' giây';
  }

  function formatInterval(minutes) {
    var n = Number(minutes);
    if (!isFinite(n) || n <= 0) { return '—'; }
    return n + ' phút';
  }

  function scheduleRange(data) {
    if (!data || data.schedule_enabled === false) { return 'Không giới hạn giờ'; }
    return (data.schedule_start || '—') + ' – ' + (data.schedule_end || '—');
  }

  function errorText(err, fallback) {
    if (!err) { return fallback || 'Không rõ lỗi.'; }
    if (err.status === 401) { return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'; }
    if (err.status === 403) { return 'Bạn không có quyền thực hiện thao tác này.'; }
    if (err.code === 'TEST_MODE_BLOCKED') {
      return err.message || 'Chế độ kiểm thử đang bật nên thao tác này bị chặn.';
    }
    if (err.code === 'TELEGRAM_NOT_CONFIGURED') {
      return 'Telegram chưa được cấu hình. Hãy lưu Bot Token và Chat ID trước.';
    }
    if (err.code === 'TELEGRAM_DISABLED') {
      return 'Gửi Telegram đang bị tắt trên máy chủ.';
    }
    if (err.code === 'TELEGRAM_SEND_FAILED') {
      return 'Không gửi được tin nhắn Telegram. Kiểm tra token, chat ID và kết nối mạng.';
    }
    if (err.code === 'RATE_LIMITED') {
      var wait = err.retryAfterSeconds ? ' Thử lại sau ' + err.retryAfterSeconds + ' giây.' : '';
      return 'Thao tác quá nhanh.' + wait;
    }
    if (err.code === 'ABORTED') { return ''; }
    return err.message || fallback || 'Yêu cầu thất bại.';
  }

  function actionErrorText(err, fallback) {
    var message = errorText(err, fallback);
    if (!message) { return ''; }
    if (err && err.code && err.code !== 'ABORTED') {
      return message + ' (' + err.code + ')';
    }
    return message;
  }

  function markUpdated(failed) {
    if (refs && refs.updated) {
      refs.updated.textContent = (failed ? 'Lỗi cập nhật: ' : 'Cập nhật: ') + fmt.time(new Date());
    }
  }

  function trackLayer(handle) {
    if (handle) { openLayers.push(handle); }
    return handle;
  }

  function closeLayers() {
    openLayers.forEach(function (handle) {
      try { handle.close(); } catch (err) { /* bỏ qua */ }
    });
    openLayers = [];
  }

  function panelError(message, code, requestId, retry, title) {
    return ui.errorPanel({
      title: title || 'Đã xảy ra lỗi',
      message: message,
      code: code || null,
      requestId: requestId || null,
      retry: retry
    });
  }

  /* --------------------------- Page skeleton --------------------------- */

  function buildPage(container) {
    clear(container);
    var root = el('div', { class: 'c-stack view-alarms' });

    var updated = el('span', { class: 'u-muted u-tabular', text: 'Đang tải…' });
    var refreshBtn = ui.button({
      label: 'Làm mới',
      icon: 'refresh',
      variant: 'secondary',
      size: 'sm',
      testId: 'alarms-refresh',
      onClick: refreshAll
    });
    root.appendChild(ui.pageHeader({
      title: 'Cảnh báo',
      subtitle: 'Chế độ gác, Telegram, watchdog thẻ nhớ và lịch sử sự kiện',
      icon: 'alarms',
      actions: [updated, refreshBtn]
    }));

    var pageError = el('div', { hidden: true });
    root.appendChild(pageError);

    /* --------------------------- Status card --------------------------- */
    var statusCard = makeCard({
      title: 'Chế độ gác an ninh',
      subtitle: 'Trạng thái hệ thống, lịch gác và các camera đang lắng nghe',
      icon: 'shield',
      testId: 'alarms-status'
    });
    var statusError = el('div', { class: 'u-mb-16', hidden: true });
    statusCard.body.appendChild(statusError);

    var armRow = el('div', { class: 'c-row c-row--between c-row--wrap' });
    var armLeft = el('div');
    var armSwitch = null;
    if (isAdmin()) {
      armSwitch = ui.switch({
        checked: false,
        label: 'Chế độ gác an ninh',
        description: 'Bật để gửi cảnh báo theo cấu hình Telegram bên dưới.',
        disabled: true,
        testId: 'alarms-arm-switch',
        onChange: onArmToggle
      });
      armLeft.appendChild(armSwitch.el);
    } else {
      armLeft.appendChild(el('div', { class: 'c-switch__label', text: 'Trạng thái gác an ninh' }));
      armLeft.appendChild(el('div', {
        class: 'c-muted-block',
        text: 'Chỉ quản trị viên có thể thay đổi chế độ gác.'
      }));
    }
    var armRight = el('div', { class: 'c-row' });
    var armPill = el('span');
    armRight.appendChild(armPill);
    armRow.appendChild(armLeft);
    armRow.appendChild(armRight);
    statusCard.body.appendChild(armRow);

    var graceSlot = el('div', { class: 'u-mt-16' });
    statusCard.body.appendChild(graceSlot);

    var kpiGrid = el('div', { class: 'c-grid c-grid--kpi u-mt-16' });
    var kpiListeners = makeKpi({ label: 'Camera lắng nghe', icon: 'camera', tone: 'info' });
    var kpiSchedule = makeKpi({ label: 'Lịch gác', icon: 'clock', tone: 'primary' });
    var kpiCooldown = makeKpi({ label: 'Cooldown', icon: 'clock', tone: 'neutral' });
    var kpiHistory = makeKpi({ label: 'Sự kiện đã ghi', icon: 'bell', tone: 'warning' });
    kpiGrid.appendChild(kpiListeners.el);
    kpiGrid.appendChild(kpiSchedule.el);
    kpiGrid.appendChild(kpiCooldown.el);
    kpiGrid.appendChild(kpiHistory.el);
    statusCard.body.appendChild(kpiGrid);

    var listenerWrap = el('div', { class: 'u-mt-16' });
    listenerWrap.appendChild(el('div', { class: 'c-card__subtitle', text: 'Camera đang lắng nghe sự kiện' }));
    var listenerChips = el('div', { class: 'c-chip-row u-mt-8' });
    listenerWrap.appendChild(listenerChips);
    statusCard.body.appendChild(listenerWrap);
    root.appendChild(statusCard.el);

    /* -------------------------- Telegram card -------------------------- */
    var tgCard = null;
    var testBtn = null;
    var settingsBtn = null;
    var tgStatus = null;
    var tgError = null;
    var tgFormSlot = null;
    if (isAdmin()) {
      testBtn = ui.button({
        label: 'Gửi thử',
        icon: 'bell',
        variant: 'secondary',
        size: 'sm',
        disabled: true,
        testId: 'alarms-test-telegram',
        onClick: openTestModal
      });
      settingsBtn = ui.button({
        label: 'Mở cài đặt',
        icon: 'settings',
        variant: 'ghost',
        size: 'sm',
        onClick: function () { ctx.router.go('settings'); }
      });
      tgCard = makeCard({
        title: 'Telegram và phạm vi gác',
        subtitle: 'Cấu hình gửi cảnh báo, lịch gác và camera áp dụng',
        icon: 'bell',
        testId: 'alarms-telegram-card',
        actions: [testBtn, settingsBtn]
      });
      tgCard.el.setAttribute('data-admin-only', '1');
      tgStatus = el('div', { class: 'c-row c-row--wrap u-mb-16' });
      tgCard.body.appendChild(tgStatus);
      tgError = el('div', { hidden: true });
      tgCard.body.appendChild(tgError);
      tgFormSlot = el('div');
      tgFormSlot.appendChild(ui.skeleton({ variant: 'text', rows: 6 }));
      tgCard.body.appendChild(tgFormSlot);
      root.appendChild(tgCard.el);
    }

    /* -------------------------- Watchdog card -------------------------- */
    var watchdogCard = makeCard({
      title: 'Watchdog thẻ nhớ',
      subtitle: 'Kiểm tra sức khoẻ thẻ nhớ định kỳ và theo yêu cầu',
      icon: 'activity',
      testId: 'alarms-watchdog'
    });
    var watchdogMeta = el('div', { class: 'c-row c-row--between c-row--wrap' });
    var watchdogLastRun = el('span', { class: 'c-muted-block', text: 'Lần chạy cuối: chưa chạy' });
    var watchdogInterval = el('span', { class: 'c-muted-block', text: 'Chu kỳ: theo cấu hình máy chủ' });
    watchdogMeta.appendChild(watchdogLastRun);
    watchdogMeta.appendChild(watchdogInterval);
    watchdogCard.body.appendChild(watchdogMeta);

    var watchdogControls = null;
    var watchdogForceSwitch = null;
    var runWatchdogBtn = null;
    if (isAdmin()) {
      watchdogControls = el('div', {
        class: 'c-row c-row--between c-row--wrap u-mt-16',
        attrs: { 'data-admin-only': '1' }
      });
      watchdogForceSwitch = ui.switch({
        checked: false,
        label: 'Gửi Telegram khi phát hiện lỗi',
        description: 'Chỉ áp dụng cho lần quét này; cần cấu hình bot hợp lệ.',
        testId: 'alarms-watchdog-force-send'
      });
      runWatchdogBtn = ui.button({
        label: 'Quét ngay',
        icon: 'activity',
        variant: 'secondary',
        size: 'sm',
        disabled: true,
        testId: 'alarms-run-watchdog',
        onClick: runWatchdog
      });
      var watchdogRight = el('div', { class: 'c-row' });
      watchdogRight.appendChild(runWatchdogBtn);
      watchdogControls.appendChild(watchdogForceSwitch.el);
      watchdogControls.appendChild(watchdogRight);
      watchdogCard.body.appendChild(watchdogControls);
    }

    var watchdogResult = el('div', { class: 'u-mt-16' });
    watchdogCard.body.appendChild(watchdogResult);
    var watchdogError = el('div', { class: 'u-mt-16', hidden: true });
    watchdogCard.body.appendChild(watchdogError);

    var watchdogEmpty = el('div');
    watchdogEmpty.appendChild(ui.empty({
      icon: 'sd-card',
      title: 'Chưa có dữ liệu watchdog',
      description: 'Trạng thái thẻ nhớ sẽ xuất hiện sau lần kiểm tra đầu tiên.'
    }));
    var watchdogTable = ui.table({
      columns: [
        {
          key: 'name',
          label: 'Camera',
          render: function (row) { return el('span', { text: row.name || row.ip || '—' }); }
        },
        {
          key: 'ip',
          label: 'IP',
          mono: true,
          render: function (row) { return row.ip || '—'; }
        },
        {
          key: 'status',
          label: 'Trạng thái',
          render: function (row) { return watchdogStatusNode(row.state); }
        },
        {
          key: 'error_code',
          label: 'Mã lỗi',
          mono: true,
          render: function (row) {
            return row.state && row.state.error_code ? String(row.state.error_code) : '—';
          }
        },
        {
          key: 'last_check',
          label: 'Kiểm tra cuối',
          render: function (row) {
            return row.state && row.state.last_check ? fmt.dateTime(row.state.last_check) : '—';
          }
        }
      ],
      rows: [],
      loading: true,
      emptyNode: watchdogEmpty,
      mobile: 'cards',
      caption: 'Trạng thái watchdog thẻ nhớ',
      rowKey: function (row) { return row && row.ip ? row.ip : ''; },
      testId: 'alarms-watchdog-table'
    });
    var watchdogTableWrap = el('div', { class: 'u-mt-16' });
    watchdogTableWrap.appendChild(watchdogTable.el);
    watchdogCard.body.appendChild(watchdogTableWrap);
    root.appendChild(watchdogCard.el);

    /* --------------------------- History card --------------------------- */
    var historyCountBadge = ui.badge('—', { tone: 'neutral' });
    var historyActions = [historyCountBadge];
    var clearHistoryBtn = null;
    if (isAdmin()) {
      clearHistoryBtn = ui.button({
        label: 'Xoá lịch sử',
        icon: 'trash',
        variant: 'ghost',
        size: 'sm',
        testId: 'alarms-clear-history',
        onClick: confirmClearHistory
      });
      historyActions.push(clearHistoryBtn);
    }
    var historyCard = makeCard({
      title: 'Lịch sử cảnh báo',
      subtitle: 'Sự kiện đã gửi, bỏ qua hoặc bị chặn',
      icon: 'bell',
      actions: historyActions
    });

    var historyCameraField = ui.field({
      label: 'Camera',
      name: 'history-camera',
      type: 'select',
      options: [{ value: '', label: 'Tất cả camera' }],
      value: '',
      testId: 'alarms-history-camera'
    });
    var historyDateField = ui.field({
      label: 'Ngày',
      name: 'history-date',
      type: 'date',
      value: '',
      testId: 'alarms-history-date'
    });
    var historyStatusField = ui.field({
      label: 'Trạng thái',
      name: 'history-status',
      type: 'select',
      options: HISTORY_STATUSES,
      value: '',
      testId: 'alarms-history-status'
    });
    var historyFilterBtn = ui.button({
      label: 'Lọc',
      icon: 'filter',
      variant: 'primary',
      size: 'sm',
      testId: 'alarms-history-filter',
      onClick: function () { loadHistory(1); }
    });
    var historyClearFilterBtn = ui.button({
      label: 'Xoá lọc',
      icon: 'x',
      variant: 'ghost',
      size: 'sm',
      onClick: clearHistoryFilters
    });
    var historyToolbar = el('div', { class: 'c-toolbar' });
    var historyToolbarLeft = el('div', { class: 'c-toolbar__left' });
    historyToolbarLeft.appendChild(historyCameraField.el);
    historyToolbarLeft.appendChild(historyDateField.el);
    historyToolbarLeft.appendChild(historyStatusField.el);
    var historyToolbarRight = el('div', { class: 'c-toolbar__right' });
    historyToolbarRight.appendChild(historyClearFilterBtn);
    historyToolbarRight.appendChild(historyFilterBtn);
    historyToolbar.appendChild(historyToolbarLeft);
    historyToolbar.appendChild(historyToolbarRight);
    historyCard.body.appendChild(historyToolbar);

    var historyError = el('div', { class: 'u-mt-16', hidden: true });
    historyCard.body.appendChild(historyError);

    historyEmpty = el('div');
    historyEmpty.appendChild(ui.empty({
      icon: 'bell-off',
      title: 'Chưa có cảnh báo',
      description: 'Lịch sử sẽ xuất hiện khi hệ thống ghi nhận sự kiện an ninh.'
    }));
    historyTable = ui.table({
      columns: [
        {
          key: 'timestamp',
          label: 'Thời gian',
          render: function (row) { return fmt.dateTime(row.timestamp); }
        },
        {
          key: 'camera',
          label: 'Camera',
          render: function (row) {
            var wrap = el('div');
            wrap.appendChild(el('div', { text: row.name || row.ip || '—' }));
            if (row.ip) {
              wrap.appendChild(el('div', { class: 'c-muted-block u-mono', text: row.ip }));
            }
            return wrap;
          }
        },
        {
          key: 'event',
          label: 'Sự kiện',
          render: function (row) {
            var wrap = el('div');
            wrap.appendChild(el('div', { text: row.title || row.code || 'Sự kiện' }));
            if (row.code) {
              wrap.appendChild(el('div', { class: 'c-muted-block u-mono', text: row.code }));
            }
            return wrap;
          }
        },
        {
          key: 'status',
          label: 'Trạng thái',
          render: function (row) { return ui.statusPill(row.status || 'unknown'); }
        },
        {
          key: 'snapshot',
          label: 'Ảnh',
          align: 'center',
          render: function (row) { return snapshotNode(row); }
        }
      ],
      rows: [],
      loading: true,
      emptyNode: historyEmpty,
      mobile: 'cards',
      caption: 'Lịch sử cảnh báo',
      rowKey: function (row, index) {
        return row && row.id ? String(row.id) : 'history-' + index;
      },
      testId: 'alarms-history-table'
    });
    var historyTableWrap = el('div', { class: 'u-mt-16' });
    historyTableWrap.appendChild(historyTable.el);
    historyCard.body.appendChild(historyTableWrap);

    historyPager = ui.pagination({
      page: 1,
      pageSize: historyPageSize,
      total: 0,
      pageSizes: [10, 15, 20, 30, 50],
      onChange: function (page, pageSize, sizeChanged) {
        historyPageSize = pageSize;
        if (sizeChanged) {
          ctx.state.setUi('pageSize', pageSize);
          loadHistory(1);
        } else {
          loadHistory(page);
        }
      }
    });
    historyCard.body.appendChild(historyPager.el);
    root.appendChild(historyCard.el);

    container.appendChild(root);

    refs = {
      updated: updated,
      refreshBtn: refreshBtn,
      pageError: pageError,
      statusError: statusError,
      armSwitch: armSwitch,
      armPill: armPill,
      graceSlot: graceSlot,
      kpiListeners: kpiListeners,
      kpiSchedule: kpiSchedule,
      kpiCooldown: kpiCooldown,
      kpiHistory: kpiHistory,
      listenerChips: listenerChips,
      testBtn: testBtn,
      tgStatus: tgStatus,
      tgError: tgError,
      tgFormSlot: tgFormSlot,
      watchdogLastRun: watchdogLastRun,
      watchdogInterval: watchdogInterval,
      watchdogForceSwitch: watchdogForceSwitch,
      runWatchdogBtn: runWatchdogBtn,
      watchdogResult: watchdogResult,
      watchdogError: watchdogError,
      watchdogTable: watchdogTable,
      watchdogEmpty: watchdogEmpty,
      historyCameraField: historyCameraField,
      historyDateField: historyDateField,
      historyStatusField: historyStatusField,
      historyCountBadge: historyCountBadge,
      clearHistoryBtn: clearHistoryBtn,
      historyError: historyError,
      historyTable: historyTable,
      historyPager: historyPager
    };

    historyCameraField.input.addEventListener('change', function () { loadHistory(1); });
    historyStatusField.input.addEventListener('change', function () { loadHistory(1); });
    historyDateField.input.addEventListener('change', function () { loadHistory(1); });
  }

  /* --------------------------- Page errors ----------------------------- */

  function showPageError(err) {
    if (!refs || !refs.pageError) { return; }
    clear(refs.pageError);
    refs.pageError.hidden = false;
    refs.pageError.appendChild(ui.banner({
      tone: 'danger',
      title: 'Không tải được danh sách camera',
      message: actionErrorText(err, 'Máy chủ không phản hồi.'),
      actions: [ui.button({
        label: 'Thử lại',
        icon: 'refresh',
        variant: 'secondary',
        size: 'sm',
        onClick: refreshAll
      })],
      dismissible: true
    }));
    markUpdated(true);
  }

  function hidePageError() {
    if (!refs || !refs.pageError) { return; }
    refs.pageError.hidden = true;
    clear(refs.pageError);
  }

  function showStatusError(err) {
    if (!refs) { return; }
    if (refs.statusError) {
      clear(refs.statusError);
      refs.statusError.hidden = false;
      refs.statusError.appendChild(ui.banner({
        tone: 'danger',
        title: 'Không cập nhật được trạng thái cảnh báo',
        message: actionErrorText(err, 'Máy chủ không phản hồi.'),
        actions: [ui.button({
          label: 'Thử lại',
          icon: 'refresh',
          variant: 'secondary',
          size: 'sm',
          onClick: function () { loadStatus().catch(function () { return null; }); }
        })],
        dismissible: true
      }));
    }
    if (!lastStatus && refs.armSwitch) { refs.armSwitch.setDisabled(true); }
    if (!lastStatus && refs.testBtn) { refs.testBtn.disabled = true; }
    markUpdated(true);
  }

  function hideStatusError() {
    if (!refs || !refs.statusError) { return; }
    refs.statusError.hidden = true;
    clear(refs.statusError);
  }

  /* ----------------------------- Camera list --------------------------- */

  function loadCameras() {
    return ctx.state.refresh('cameras').then(function (list) {
      cameras = Array.isArray(list) ? list : [];
      hidePageError();
      refreshCameraSelectors();
      if (lastStatus && refs) { renderWatchdog(lastStatus); }
      return cameras;
    }).catch(function (err) {
      cameras = Array.isArray(ctx.state.get('cameras')) ? ctx.state.get('cameras') : [];
      if (err && err.code !== 'ABORTED') { showPageError(err); }
      refreshCameraSelectors();
      return cameras;
    });
  }

  function refreshCameraSelectors() {
    if (!refs || !refs.historyCameraField) { return; }
    var current = refs.historyCameraField.getValue();
    var options = [{ value: '', label: 'Tất cả camera' }];
    cameras.forEach(function (cam) {
      if (!cam || !cam.ip) { return; }
      options.push({
        value: cam.ip,
        label: (cam.name || cam.model || cam.ip) + ' — ' + cam.ip
      });
    });
    if (current && !findCamera(current)) { current = ''; }
    refs.historyCameraField.setOptions(options, current);
  }

  /* ------------------------------- Status ------------------------------ */

  function loadStatus() {
    return ctx.state.refresh('alarmStatus').then(function (data) {
      if (destroyed) { return null; }
      applyStatus(data || {});
      return data;
    }).catch(function (err) {
      if (destroyed || (err && err.code === 'ABORTED')) { return null; }
      showStatusError(err);
      throw err;
    });
  }

  function applyStatus(data) {
    if (!refs || destroyed) { return; }
    lastStatus = data || {};
    var status = lastStatus;
    hideStatusError();

    if (refs.armSwitch && !pendingArm) {
      refs.armSwitch.setChecked(!!status.armed);
      refs.armSwitch.setDisabled(false);
    }
    clear(refs.armPill);
    refs.armPill.appendChild(ui.statusPill(status.armed ? 'armed' : 'disarmed'));

    var listeners = Number(status.listeners_count) || 0;
    var armed = !!status.armed;
    setKpi(
      refs.kpiListeners,
      listeners,
      listeners ? 'camera đang gửi sự kiện' : (armed ? 'chưa có camera nào' : 'hệ thống đang tắt gác')
    );
    refs.kpiListeners.el.setAttribute('data-tone',
      listeners ? 'success' : (armed ? 'warning' : 'neutral'));
    var scheduleEnabled = status.schedule_enabled !== false;
    setKpi(
      refs.kpiSchedule,
      scheduleEnabled ? 'Bật' : 'Tắt',
      scheduleEnabled
        ? scheduleRange(status) + (status.is_in_schedule ? ' · trong lịch' : ' · ngoài lịch')
        : 'Không giới hạn giờ'
    );
    refs.kpiSchedule.el.setAttribute('data-tone',
      !scheduleEnabled ? 'neutral' : (status.is_in_schedule ? 'success' : 'warning'));
    setKpi(refs.kpiCooldown, formatCooldown(status.cooldown_seconds), 'giữa hai cảnh báo');
    setKpi(
      refs.kpiHistory,
      Number(status.history_count) || 0,
      'sự kiện đã ghi nhận'
    );

    clear(refs.graceSlot);
    var grace = Number(status.startup_grace_remaining_seconds) || 0;
    if (grace > 0) {
      refs.graceSlot.appendChild(ui.banner({
        tone: 'warning',
        title: 'Đang trong thời gian chờ khởi động',
        message: 'Hệ thống tạm hoãn gửi cảnh báo trong ' + fmt.duration(grace) +
          ' để tránh cảnh báo giả sau khi khởi động.'
      }));
    }

    renderListeners(Array.isArray(status.active_listeners) ? status.active_listeners : []);
    updateTelegramStatus(status);
    renderWatchdog(status);

    if (refs.testBtn) {
      refs.testBtn.disabled = pendingTest;
      refs.testBtn.title = status.bot_configured
        ? 'Gửi một tin nhắn thử qua Telegram'
        : 'Chưa cấu hình bot token/chat ID';
    }
    if (refs.runWatchdogBtn) {
      refs.runWatchdogBtn.disabled = pendingWatchdog;
    }
    markUpdated();
  }

  function renderListeners(ips) {
    if (!refs || !refs.listenerChips) { return; }
    clear(refs.listenerChips);
    if (!ips.length) {
      refs.listenerChips.appendChild(el('p', {
        class: 'c-muted-block',
        text: 'Chưa có camera nào đang gửi sự kiện.'
      }));
      return;
    }
    ips.forEach(function (ip) {
      var chip = el('span', { class: 'c-chip' });
      chip.appendChild(svg('camera', { size: 13 }));
      chip.appendChild(el('span', { text: cameraLabel(ip) + ' · ' + ip }));
      refs.listenerChips.appendChild(chip);
    });
  }

  function onArmToggle(next) {
    if (!isAdmin() || pendingArm || !ctx) { return; }
    var current = !!(lastStatus && lastStatus.armed);
    if (next === current) { return; }
    pendingArm = true;
    if (refs && refs.armSwitch) { refs.armSwitch.setDisabled(true); }

    var proceed = next ? Promise.resolve(true) : ui.confirm({
      title: 'Tắt chế độ gác an ninh?',
      message: 'Hệ thống sẽ ngừng gửi cảnh báo Telegram cho đến khi bật lại. Camera vẫn ghi hình bình thường.',
      confirmLabel: 'Tắt gác',
      cancelLabel: 'Giữ nguyên',
      variant: 'danger'
    });

    proceed.then(function (ok) {
      if (!ok) {
        if (refs && refs.armSwitch) { refs.armSwitch.setChecked(current); }
        return null;
      }
      if (destroyed || !ctx) { return null; }
      var body = { armed: next };
      if (!next) { body.confirm = true; }
      return ctx.api.post('/api/alarm/toggle', body, {
        signal: ctx.signal,
        silent: true,
        timeoutMs: 15000
      }).then(function (data) {
        if (destroyed) { return null; }
        if (lastStatus) {
          lastStatus.armed = next;
          applyStatus(lastStatus);
        }
        ui.toast(
          (data && data.message) || (next ? 'Đã bật chế độ gác an ninh.' : 'Đã tắt chế độ gác an ninh.'),
          { type: next ? 'success' : 'warning' }
        );
        return loadStatus().catch(function () { return null; });
      }).catch(function (err) {
        if (destroyed || (err && err.code === 'ABORTED')) { return null; }
        if (refs && refs.armSwitch) { refs.armSwitch.setChecked(current); }
        ui.toast(actionErrorText(err, 'Không đổi được trạng thái gác.'), { type: 'error' });
        return null;
      });
    }).then(function () {
      pendingArm = false;
      if (!destroyed && refs && refs.armSwitch) { refs.armSwitch.setDisabled(false); }
    });
  }

  /* ----------------------------- Telegram ------------------------------ */

  function updateTelegramStatus(status) {
    if (!isAdmin() || !refs || !refs.tgStatus) { return; }
    clear(refs.tgStatus);
    if (!status && settingsData === null) {
      refs.tgStatus.appendChild(el('span', { class: 'c-muted-block', text: 'Đang tải trạng thái…' }));
      return;
    }
    var data = status || lastStatus || {};
    if (!status) {
      refs.tgStatus.appendChild(el('span', { class: 'c-muted-block', text: 'Đang tải trạng thái…' }));
    } else {
      refs.tgStatus.appendChild(ui.badge(
        data.bot_configured ? 'Đã cấu hình bot' : 'Chưa cấu hình bot',
        { tone: data.bot_configured ? 'success' : 'warning' }
      ));
      refs.tgStatus.appendChild(ui.badge(
        data.telegram_enabled ? 'Đang bật gửi' : 'Đang tắt gửi',
        { tone: data.telegram_enabled ? 'success' : 'neutral' }
      ));
      refs.tgStatus.appendChild(ui.badge(
        data.schedule_enabled === false
          ? 'Không giới hạn giờ'
          : (data.is_in_schedule ? 'Trong lịch gác' : 'Ngoài lịch gác'),
        { tone: data.schedule_enabled === false ? 'neutral' : (data.is_in_schedule ? 'info' : 'warning') }
      ));
      refs.tgStatus.appendChild(ui.badge(
        data.human_only ? 'Chỉ lọc người' : 'Mọi chuyển động',
        { tone: data.human_only ? 'info' : 'neutral' }
      ));
      refs.tgStatus.appendChild(ui.badge(
        data.telegram_storage_alerts ? 'Cảnh báo thẻ: bật' : 'Cảnh báo thẻ: tắt',
        { tone: data.telegram_storage_alerts ? 'success' : 'neutral' }
      ));
      refs.tgStatus.appendChild(ui.badge(
        'Cooldown ' + formatCooldown(data.cooldown_seconds),
        { tone: 'neutral' }
      ));
    }
    if (settingsData !== null && secrets) {
      refs.tgStatus.appendChild(ui.badge(
        secrets.telegram_bot_token_set ? 'Token đã lưu' : 'Token chưa lưu',
        { tone: secrets.telegram_bot_token_set ? 'success' : 'warning' }
      ));
      refs.tgStatus.appendChild(ui.badge(
        secrets.telegram_chat_id_set ? 'Chat ID đã lưu' : 'Chat ID chưa lưu',
        { tone: secrets.telegram_chat_id_set ? 'success' : 'warning' }
      ));
    }
  }

  function loadSettings() {
    if (!isAdmin() || !refs || !refs.tgFormSlot) { return Promise.resolve(); }
    clear(refs.tgFormSlot);
    refs.tgFormSlot.appendChild(ui.skeleton({ variant: 'text', rows: 6 }));
    return ctx.api.get('/api/settings', {
      signal: ctx.signal,
      silent: true,
      timeoutMs: 20000
    }).then(function (data) {
      if (destroyed) { return; }
      settingsData = (data && data.settings) || {};
      secrets = (data && data.secrets) || {};
      secretsManagedExternally = !!(data && data.secrets_managed_externally);
      buildTelegramForm();
      updateTelegramStatus(lastStatus);
    }).catch(function (err) {
      if (destroyed || (err && err.code === 'ABORTED')) { return; }
      clear(refs.tgFormSlot);
      refs.tgFormSlot.appendChild(panelError(
        errorText(err, 'Không tải được cấu hình Telegram.'),
        err && err.code ? err.code : null,
        err && err.requestId ? err.requestId : null,
        function () { loadSettings(); },
        'Không tải được cấu hình Telegram'
      ));
    });
  }

  function buildTelegramForm() {
    if (!refs || !refs.tgFormSlot || settingsData === null) { return; }
    var settings = settingsData || {};
    clear(refs.tgFormSlot);
    if (refs.tgError) {
      refs.tgError.hidden = true;
      clear(refs.tgError);
    }

    var form = el('form', {
      class: 'c-stack',
      attrs: { novalidate: 'novalidate' }
    });
    form.appendChild(el('p', {
      class: 'c-muted-block',
      text: 'Cấu hình được lưu trên máy chủ. Bot Token và Chat ID không bao giờ được hiển thị lại sau khi lưu.'
    }));

    if (secretsManagedExternally) {
      form.appendChild(ui.banner({
        tone: 'info',
        title: 'Bí mật do file cấu hình quản lý',
        message: 'Token và Chat ID đang được quản lý bên ngoài giao diện. Các ô bên dưới được khoá để tránh ghi đè.'
      }));
    }

    var fieldGrid = el('div', { class: 'c-grid c-grid--2' });
    var tokenField = ui.field({
      label: 'Bot Token',
      name: 'telegram-bot-token',
      type: 'password',
      value: '',
      placeholder: secrets && secrets.telegram_bot_token_set
        ? 'Đã lưu — để trống nếu giữ nguyên'
        : 'Nhập token từ BotFather',
      help: 'Chỉ gửi khi bấm lưu; không hiển thị lại.',
      autocomplete: 'new-password',
      maxlength: 256,
      mono: true,
      disabled: secretsManagedExternally,
      testId: 'alarms-telegram-token'
    });
    var chatField = ui.field({
      label: 'Chat ID',
      name: 'telegram-chat-id',
      type: 'password',
      value: '',
      placeholder: secrets && secrets.telegram_chat_id_set
        ? 'Đã lưu — để trống nếu giữ nguyên'
        : 'Nhập chat ID nhận cảnh báo',
      help: 'Chỉ gửi khi bấm lưu; không hiển thị lại.',
      autocomplete: 'new-password',
      maxlength: 64,
      mono: true,
      disabled: secretsManagedExternally,
      testId: 'alarms-telegram-chat-id'
    });
    var startField = ui.field({
      label: 'Bắt đầu lịch gác',
      name: 'telegram-schedule-start',
      type: 'time',
      value: settings.telegram_schedule_start || '18:00',
      testId: 'alarms-telegram-schedule-start'
    });
    var endField = ui.field({
      label: 'Kết thúc lịch gác',
      name: 'telegram-schedule-end',
      type: 'time',
      value: settings.telegram_schedule_end || '07:00',
      testId: 'alarms-telegram-schedule-end'
    });
    var cooldownField = ui.field({
      label: 'Cooldown (giây)',
      name: 'telegram-cooldown',
      type: 'number',
      value: settings.telegram_cooldown_seconds === undefined ? 60 : settings.telegram_cooldown_seconds,
      min: 10,
      max: 3600,
      step: 1,
      help: 'Khoảng cách tối thiểu giữa hai cảnh báo (10–3600).',
      testId: 'alarms-telegram-cooldown'
    });
    var intervalField = ui.field({
      label: 'Chu kỳ watchdog (phút)',
      name: 'telegram-storage-interval',
      type: 'number',
      value: settings.telegram_storage_check_interval === undefined ? 30 : settings.telegram_storage_check_interval,
      min: 5,
      max: 1440,
      step: 1,
      help: 'Chu kỳ kiểm tra thẻ nhớ tự động (5–1440).',
      testId: 'alarms-telegram-interval'
    });
    [tokenField, chatField, startField, endField, cooldownField, intervalField].forEach(function (field) {
      fieldGrid.appendChild(field.el);
    });
    form.appendChild(fieldGrid);

    var switchGrid = el('div', { class: 'c-grid c-grid--2' });
    var enabledSwitch = ui.switch({
      checked: !!settings.telegram_enabled,
      label: 'Bật gửi Telegram',
      description: 'Tắt để tạm ngừng gửi mọi cảnh báo qua Telegram.',
      testId: 'alarms-telegram-enabled'
    });
    var scheduleSwitch = ui.switch({
      checked: settings.telegram_schedule_enabled !== false,
      label: 'Giới hạn theo lịch gác',
      description: 'Chỉ gửi trong khung giờ bắt đầu và kết thúc.',
      testId: 'alarms-telegram-schedule-enabled'
    });
    var humanSwitch = ui.switch({
      checked: settings.telegram_ai_filter_human !== false,
      label: 'Chỉ gửi khi phát hiện người',
      description: 'Bỏ qua chuyển động không phải người nếu camera hỗ trợ phân loại.',
      testId: 'alarms-telegram-human-only'
    });
    var storageSwitch = ui.switch({
      checked: settings.telegram_storage_alerts !== false,
      label: 'Gửi cảnh báo thẻ nhớ',
      description: 'Bật để gửi sự kiện lỗi hoặc mất kết nối thẻ nhớ.',
      testId: 'alarms-telegram-storage-alerts'
    });
    [enabledSwitch, scheduleSwitch, humanSwitch, storageSwitch].forEach(function (control) {
      switchGrid.appendChild(control.el);
    });
    form.appendChild(switchGrid);

    form.appendChild(el('div', { class: 'c-divider' }));
    form.appendChild(el('h3', { text: 'Phạm vi gác' }));
    form.appendChild(el('p', {
      class: 'c-muted-block',
      text: 'Chọn camera được áp dụng khi gửi cảnh báo Telegram. Camera vẫn có thể tự bật hoặc tắt gác riêng.'
    }));

    var armedList = Array.isArray(settings.telegram_armed_cameras)
      ? settings.telegram_armed_cameras.map(String)
      : [];
    var isAll = !armedList.length || armedList.indexOf('*') !== -1;
    var selectedIps = {};
    armedList.forEach(function (ip) {
      if (ip !== '*') { selectedIps[ip] = true; }
    });

    var scopeField = ui.field({
      label: 'Áp dụng cho',
      name: 'telegram-armed-scope',
      type: 'select',
      options: [
        { value: 'all', label: 'Tất cả camera' },
        { value: 'selected', label: 'Chỉ camera được chọn' }
      ],
      value: isAll ? 'all' : 'selected',
      testId: 'alarms-telegram-scope'
    });
    form.appendChild(scopeField.el);

    var cameraWrap = el('div', { class: 'c-grid c-grid--2 u-mt-8' });
    var entries = [];
    var seen = {};
    cameras.forEach(function (cam) {
      if (!cam || !cam.ip || seen[cam.ip]) { return; }
      seen[cam.ip] = true;
      entries.push({ ip: cam.ip, name: cam.name || cam.model || cam.ip });
    });
    armedList.forEach(function (ip) {
      if (ip === '*' || !ip || seen[ip]) { return; }
      seen[ip] = true;
      entries.push({ ip: ip, name: 'Camera không còn trong danh sách' });
    });
    cameraChecks = [];
    entries.forEach(function (entry) {
      var check = ui.field({
        label: entry.name + ' — ' + entry.ip,
        type: 'checkbox',
        value: isAll ? true : !!selectedIps[entry.ip]
      });
      cameraChecks.push({ ip: entry.ip, field: check });
      cameraWrap.appendChild(check.el);
    });
    if (!entries.length) {
      cameraWrap.appendChild(el('p', {
        class: 'c-muted-block',
        text: 'Chưa có camera nào trong danh sách quản lý.'
      }));
    }
    form.appendChild(cameraWrap);
    form.appendChild(el('p', {
      class: 'c-muted-block',
      text: 'Chế độ "Tất cả camera" gửi cho mọi camera đang bật gác.'
    }));

    var syncScope = function () {
      cameraWrap.hidden = scopeField.getValue() !== 'selected';
    };
    scopeField.input.addEventListener('change', syncScope);
    syncScope();

    var actions = el('div', { class: 'c-row c-row--between c-row--wrap u-mt-8' });
    var leftActions = el('div', { class: 'c-row c-row--wrap' });
    if (secrets && secrets.telegram_bot_token_set && !secretsManagedExternally) {
      leftActions.appendChild(ui.button({
        label: 'Xoá token',
        icon: 'trash',
        variant: 'ghost',
        size: 'sm',
        onClick: function () { clearSecret('token'); }
      }));
    }
    if (secrets && secrets.telegram_chat_id_set && !secretsManagedExternally) {
      leftActions.appendChild(ui.button({
        label: 'Xoá Chat ID',
        icon: 'trash',
        variant: 'ghost',
        size: 'sm',
        onClick: function () { clearSecret('chat'); }
      }));
    }
    var rightActions = el('div', { class: 'c-row c-row--wrap' });
    var resetBtn = ui.button({
      label: 'Hoàn tác',
      variant: 'secondary',
      size: 'sm',
      onClick: buildTelegramForm
    });
    var saveBtn = ui.button({
      label: 'Lưu cấu hình Telegram',
      icon: 'check',
      variant: 'primary',
      size: 'sm',
      type: 'submit',
      testId: 'alarms-save-telegram'
    });
    rightActions.appendChild(resetBtn);
    rightActions.appendChild(saveBtn);
    actions.appendChild(leftActions);
    actions.appendChild(rightActions);
    form.appendChild(actions);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      saveTelegram();
    });

    refs.tgFormSlot.appendChild(form);
    tgFields = {
      token: tokenField,
      chat: chatField,
      start: startField,
      end: endField,
      cooldown: cooldownField,
      interval: intervalField,
      scope: scopeField,
      enabled: enabledSwitch,
      schedule: scheduleSwitch,
      human: humanSwitch,
      storage: storageSwitch,
      saveBtn: saveBtn
    };
    tgFieldList = [tokenField, chatField, startField, endField, cooldownField, intervalField, scopeField];
  }

  function clearFormErrors() {
    tgFieldList.forEach(function (field) {
      if (field && field.clearError) { field.clearError(); }
    });
    if (refs && refs.tgError) {
      refs.tgError.hidden = true;
      clear(refs.tgError);
    }
  }

  function showFormError(message) {
    if (!refs || !refs.tgError) { return; }
    clear(refs.tgError);
    refs.tgError.hidden = false;
    refs.tgError.appendChild(ui.banner({
      tone: 'danger',
      title: 'Không lưu được cấu hình',
      message: message
    }));
  }

  function saveTelegram() {
    if (!isAdmin() || !tgFields || pendingSave || !ctx) { return; }
    clearFormErrors();
    var token = tgFields.token.getValue().trim();
    var chat = tgFields.chat.getValue().trim();
    var start = tgFields.start.getValue().trim();
    var end = tgFields.end.getValue().trim();
    var cooldown = Number(tgFields.cooldown.getValue());
    var interval = Number(tgFields.interval.getValue());
    var scope = tgFields.scope.getValue();
    var hasError = false;

    if (token && token.length > 256) {
      tgFields.token.setError('Tối đa 256 ký tự.');
      hasError = true;
    }
    if (chat && chat.length > 64) {
      tgFields.chat.setError('Tối đa 64 ký tự.');
      hasError = true;
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) {
      tgFields.start.setError('Định dạng HH:MM (00:00–23:59).');
      hasError = true;
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) {
      tgFields.end.setError('Định dạng HH:MM (00:00–23:59).');
      hasError = true;
    }
    if (!isFinite(cooldown) || cooldown < 10 || cooldown > 3600 || Math.round(cooldown) !== cooldown) {
      tgFields.cooldown.setError('Phải là số nguyên trong khoảng 10–3600 giây.');
      hasError = true;
    }
    if (!isFinite(interval) || interval < 5 || interval > 1440 || Math.round(interval) !== interval) {
      tgFields.interval.setError('Phải là số nguyên trong khoảng 5–1440 phút.');
      hasError = true;
    }

    var selected = [];
    if (scope === 'selected') {
      cameraChecks.forEach(function (entry) {
        if (entry.field.getValue()) { selected.push(entry.ip); }
      });
      if (!selected.length) {
        tgFields.scope.setError('Chọn ít nhất một camera hoặc chuyển sang "Tất cả camera".');
        hasError = true;
      }
    }
    if (hasError) {
      showFormError('Kiểm tra các trường được đánh dấu.');
      return;
    }

    var payload = {
      telegram_enabled: tgFields.enabled.isChecked(),
      telegram_schedule_enabled: tgFields.schedule.isChecked(),
      telegram_schedule_start: start,
      telegram_schedule_end: end,
      telegram_cooldown_seconds: cooldown,
      telegram_ai_filter_human: tgFields.human.isChecked(),
      telegram_storage_alerts: tgFields.storage.isChecked(),
      telegram_storage_check_interval: interval,
      telegram_armed_cameras: scope === 'selected' ? selected : ['*']
    };
    if (token) { payload.telegram_bot_token = token; }
    if (chat) { payload.telegram_chat_id = chat; }

    pendingSave = true;
    ui.busy(tgFields.saveBtn, true);
    ctx.api.post('/api/settings', payload, {
      signal: ctx.signal,
      silent: true,
      timeoutMs: 25000
    }).then(function (data) {
      if (destroyed) { return; }
      pendingSave = false;
      if (tgFields && tgFields.saveBtn) { ui.busy(tgFields.saveBtn, false); }
      tgFields.token.setValue('');
      tgFields.chat.setValue('');
      ui.toast((data && data.message) || 'Đã lưu cấu hình Telegram.', { type: 'success' });
      loadStatus().catch(function () { return null; });
      loadSettings();
    }).catch(function (err) {
      if (destroyed) { return; }
      pendingSave = false;
      if (tgFields && tgFields.saveBtn) { ui.busy(tgFields.saveBtn, false); }
      if (err && err.code === 'ABORTED') { return; }
      var fieldMap = {
        telegram_bot_token: tgFields.token,
        telegram_chat_id: tgFields.chat,
        telegram_schedule_start: tgFields.start,
        telegram_schedule_end: tgFields.end,
        telegram_cooldown_seconds: tgFields.cooldown,
        telegram_storage_check_interval: tgFields.interval,
        telegram_armed_cameras: tgFields.scope
      };
      var mapped = false;
      if (err && err.details && err.details.fields && typeof err.details.fields === 'object') {
        Object.keys(err.details.fields).forEach(function (key) {
          var field = fieldMap[key];
          if (field) {
            field.setError(String(err.details.fields[key]));
            mapped = true;
          }
        });
      }
      showFormError(actionErrorText(err, 'Không lưu được cấu hình Telegram.'));
      if (mapped) {
        var first = tgFieldList.filter(function (field) {
          return field.el.classList.contains('is-invalid');
        })[0];
        if (first) { first.focus(); }
      }
    });
  }

  function clearSecret(kind) {
    if (!isAdmin() || pendingSecretClear || !ctx) { return; }
    var label = kind === 'token' ? 'Bot Token' : 'Chat ID';
    ui.confirm({
      title: 'Xoá ' + label + '?',
      message: 'Giá trị đã lưu sẽ bị xoá khỏi máy chủ. Bạn cần nhập lại nếu muốn gửi cảnh báo Telegram.',
      confirmLabel: 'Xoá ' + label,
      cancelLabel: 'Huỷ',
      variant: 'danger'
    }).then(function (ok) {
      if (!ok) { return null; }
      if (destroyed || !ctx) { return null; }
      pendingSecretClear = true;
      var body = kind === 'token'
        ? { clear_telegram_bot_token: true }
        : { clear_telegram_chat_id: true };
      return ctx.api.post('/api/settings', body, {
        signal: ctx.signal,
        silent: true,
        timeoutMs: 20000
      }).then(function () {
        if (destroyed) { return; }
        ui.toast('Đã xoá ' + label + '.', { type: 'success' });
        loadStatus().catch(function () { return null; });
        loadSettings();
      }).catch(function (err) {
        if (destroyed || (err && err.code === 'ABORTED')) { return; }
        ui.toast(actionErrorText(err, 'Không xoá được ' + label + '.'), { type: 'error' });
      }).then(function () {
        pendingSecretClear = false;
      });
    });
  }

  function openTestModal() {
    if (!isAdmin() || pendingTest || !ctx) { return; }
    var body = el('div', { class: 'c-stack' });
    body.appendChild(el('p', {
      class: 'c-muted-block',
      text: 'Tin nhắn thử dùng Bot Token và Chat ID đã lưu trên máy chủ. Màn hình này không nhận token.'
    }));
    if (lastStatus && lastStatus.bot_configured === false) {
      body.appendChild(ui.banner({
        tone: 'warning',
        title: 'Telegram chưa được cấu hình',
        message: 'Hãy lưu Bot Token và Chat ID trước khi gửi thử. Gửi thử lúc này sẽ báo lỗi.'
      }));
    }

    var includeSwitch = ui.switch({
      checked: false,
      label: 'Gửi kèm ảnh snapshot',
      description: 'Không chọn camera thì hệ thống chỉ gửi văn bản, không tự chọn camera.',
      testId: 'alarms-test-snapshot'
    });
    body.appendChild(includeSwitch.el);

    var cameraOptions = [{ value: '', label: 'Không gửi ảnh (chỉ văn bản)' }];
    cameras.forEach(function (cam) {
      if (!cam || !cam.ip) { return; }
      cameraOptions.push({
        value: cam.id || cam.ip,
        label: (cam.name || cam.model || cam.ip) + ' — ' + cam.ip
      });
    });
    var cameraField = ui.field({
      label: 'Camera gửi kèm ảnh',
      name: 'test-telegram-camera',
      type: 'select',
      options: cameraOptions,
      value: '',
      help: 'Chỉ dùng khi bật gửi kèm ảnh snapshot.',
      testId: 'alarms-test-camera'
    });
    body.appendChild(cameraField.el);

    var handle = null;
    var modalClosed = false;
    var cancelBtn = ui.button({
      label: 'Huỷ',
      variant: 'secondary',
      onClick: function () { if (handle) { handle.close(); } }
    });
    var sendBtn = ui.button({
      label: 'Gửi thử',
      icon: 'bell',
      variant: 'primary',
      onClick: function () { submitTest(handle, includeSwitch, cameraField, sendBtn); }
    });

    handle = trackLayer(ui.modal({
      title: 'Gửi thử Telegram',
      subtitle: 'Dùng cấu hình đã lưu',
      body: body,
      footer: [cancelBtn, sendBtn],
      size: 'sm',
      dismissible: true,
      initialFocus: sendBtn,
      onClose: function () {
        modalClosed = true;
        pendingTest = false;
        if (refs && refs.testBtn) { refs.testBtn.disabled = false; }
      }
    }));

    function submitTest(modalHandle, snapshotSwitch, camField, button) {
      if (!modalHandle || pendingTest) { return; }
      pendingTest = true;
      modalHandle.setBusy(true);
      modalHandle.setError('');
      if (refs && refs.testBtn) { refs.testBtn.disabled = true; }
      var includeSnapshot = snapshotSwitch.isChecked();
      var cameraId = camField.getValue();
      var payload = { include_snapshot: includeSnapshot };
      if (includeSnapshot && cameraId) { payload.camera_id = cameraId; }

      ctx.api.post('/api/alarm/test', payload, {
        signal: ctx.signal,
        silent: true,
        timeoutMs: 45000
      }).then(function (data) {
        if (destroyed) { return; }
        pendingTest = false;
        if (!modalClosed) {
          modalHandle.setBusy(false);
          modalHandle.close();
        }
        if (refs && refs.testBtn) { refs.testBtn.disabled = false; }
        ui.toast((data && data.message) || 'Đã gửi tin nhắn thử.', { type: 'success' });
      }).catch(function (err) {
        if (destroyed) { return; }
        pendingTest = false;
        if (refs && refs.testBtn) { refs.testBtn.disabled = false; }
        if (modalClosed) {
          if (err && err.code !== 'ABORTED') {
            ui.toast(actionErrorText(err, 'Không gửi được tin nhắn thử.'), { type: 'error' });
          }
          return;
        }
        if (err && err.code === 'ABORTED') { return; }
        modalHandle.setBusy(false);
        modalHandle.setError(actionErrorText(err, 'Không gửi được tin nhắn thử.'));
        button.disabled = false;
      });
    }
  }

  /* ----------------------------- Watchdog ------------------------------ */

  function watchdogStatusNode(state) {
    if (!state) {
      return ui.badge('Chưa kiểm tra', { tone: 'neutral' });
    }
    if (state.status === 'ok') { return ui.statusPill('ok'); }
    if (state.status === 'error') { return ui.statusPill('storage_error'); }
    if (state.status === 'no_sd') { return ui.statusPill('no_sd'); }
    return ui.badge('Chưa rõ', { tone: 'neutral' });
  }

  function renderWatchdog(data) {
    if (!refs) { return; }
    var wd = data && data.storage_watchdog && typeof data.storage_watchdog === 'object'
      ? data.storage_watchdog
      : {};
    var states = wd.states && typeof wd.states === 'object' ? wd.states : {};
    refs.watchdogLastRun.textContent = 'Lần chạy cuối: ' +
      (wd.last_run ? fmt.dateTime(wd.last_run) : 'chưa chạy');
    refs.watchdogInterval.textContent = isAdmin() && data && data.telegram_storage_check_interval !== undefined
      ? 'Chu kỳ: mỗi ' + formatInterval(data.telegram_storage_check_interval)
      : 'Chu kỳ: theo cấu hình máy chủ';

    var entries = [];
    var seen = {};
    cameras.forEach(function (cam) {
      if (!cam || !cam.ip || seen[cam.ip]) { return; }
      seen[cam.ip] = true;
      entries.push({ ip: cam.ip, name: cam.name || cam.model || cam.ip });
    });
    Object.keys(states).forEach(function (ip) {
      if (seen[ip]) { return; }
      seen[ip] = true;
      entries.push({
        ip: ip,
        name: (states[ip] && states[ip].name) || ip
      });
    });
    entries.sort(function (a, b) {
      return String(a.name).localeCompare(String(b.name), 'vi', { numeric: true });
    });
    var rows = entries.map(function (entry) {
      return {
        ip: entry.ip,
        name: entry.name,
        state: states[entry.ip] || null
      };
    });
    if (!rows.length) {
      clear(refs.watchdogEmpty);
      refs.watchdogEmpty.appendChild(ui.empty({
        icon: 'sd-card',
        title: 'Chưa có camera để kiểm tra',
        description: 'Thêm camera vào danh sách quản lý để watchdog theo dõi thẻ nhớ.'
      }));
    }
    refs.watchdogTable.update({ rows: rows, loading: false });
    if (refs.runWatchdogBtn) {
      refs.runWatchdogBtn.disabled = pendingWatchdog;
    }
    if (refs.watchdogForceSwitch) {
      refs.watchdogForceSwitch.setDisabled(pendingWatchdog);
    }
  }

  function runWatchdog() {
    if (!isAdmin() || pendingWatchdog || !ctx) { return; }
    var forceSend = refs && refs.watchdogForceSwitch
      ? refs.watchdogForceSwitch.isChecked()
      : false;
    var proceed = forceSend ? ui.confirm({
      title: 'Quét và gửi cảnh báo Telegram?',
      message: 'Hệ thống sẽ kiểm tra thẻ nhớ của tất cả camera và gửi Telegram nếu phát hiện lỗi mới. Chỉ tiếp tục nếu bot đã được cấu hình.',
      confirmLabel: 'Quét và gửi',
      cancelLabel: 'Huỷ',
      variant: 'danger'
    }) : Promise.resolve(true);

    proceed.then(function (ok) {
      if (!ok) { return null; }
      if (destroyed || !ctx) { return null; }
      pendingWatchdog = true;
      if (refs) {
        if (refs.runWatchdogBtn) {
          refs.runWatchdogBtn.disabled = true;
          ui.busy(refs.runWatchdogBtn, true);
        }
        if (refs.watchdogForceSwitch) { refs.watchdogForceSwitch.setDisabled(true); }
        clear(refs.watchdogError);
        refs.watchdogError.hidden = true;
        if (refs.watchdogResult) { clear(refs.watchdogResult); }
      }
      return ctx.api.post('/api/storage/watchdog/check_now', { force_send: forceSend }, {
        signal: ctx.signal,
        silent: true,
        timeoutMs: 180000
      }).then(function (data) {
        if (destroyed) { return null; }
        if (refs && refs.watchdogResult) {
          clear(refs.watchdogResult);
          var scanned = Number(data && data.total_scanned) || 0;
          var healthy = Number(data && data.healthy) || 0;
          var errors = Number(data && data.errors) || 0;
          var noSd = Number(data && data.no_sd) || 0;
          var tone = (errors || noSd) ? 'warning' : 'success';
          var message = 'Đã quét ' + scanned + ' camera: ' + healthy + ' bình thường, ' +
            errors + ' lỗi, ' + noSd + ' không có thẻ.';
          if (forceSend && lastStatus && lastStatus.bot_configured === false) {
            message += ' Telegram chưa được cấu hình nên không thể gửi cảnh báo.';
          }
          refs.watchdogResult.appendChild(ui.banner({
            tone: tone,
            title: 'Kết quả quét thẻ nhớ',
            message: message
          }));
        }
        loadStatus().catch(function () { return null; });
        return data;
      }).catch(function (err) {
        if (destroyed || (err && err.code === 'ABORTED')) { return null; }
        if (refs && refs.watchdogError) {
          clear(refs.watchdogError);
          refs.watchdogError.hidden = false;
          refs.watchdogError.appendChild(panelError(
            errorText(err, 'Không quét được thẻ nhớ.'),
            err && err.code ? err.code : null,
            err && err.requestId ? err.requestId : null,
            function () { runWatchdog(); },
            'Không quét được thẻ nhớ'
          ));
        }
        return null;
      });
    }).then(function () {
      pendingWatchdog = false;
      if (!destroyed && refs) {
        if (refs.runWatchdogBtn) {
          ui.busy(refs.runWatchdogBtn, false);
          refs.runWatchdogBtn.disabled = false;
        }
        if (refs.watchdogForceSwitch) { refs.watchdogForceSwitch.setDisabled(false); }
      }
    });
  }

  /* ------------------------------ History ------------------------------ */

  function setHistoryEmpty() {
    if (!historyEmpty) { return; }
    var filtered = false;
    if (refs) {
      filtered = !!(refs.historyCameraField.getValue() ||
        refs.historyDateField.getValue() ||
        refs.historyStatusField.getValue());
    }
    clear(historyEmpty);
    historyEmpty.appendChild(ui.empty({
      icon: 'bell-off',
      title: filtered ? 'Không có cảnh báo phù hợp' : 'Chưa có cảnh báo',
      description: filtered
        ? 'Thử đổi camera, ngày hoặc trạng thái để xem thêm.'
        : 'Lịch sử sẽ xuất hiện khi hệ thống ghi nhận sự kiện an ninh.'
    }));
  }

  function readHistoryFilters() {
    if (!refs || !refs.historyCameraField) { return null; }
    refs.historyCameraField.clearError();
    refs.historyDateField.clearError();
    refs.historyStatusField.clearError();
    var ip = refs.historyCameraField.getValue().trim();
    var date = refs.historyDateField.getValue().trim();
    var status = refs.historyStatusField.getValue();
    var ok = true;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      refs.historyDateField.setError('Ngày phải có định dạng YYYY-MM-DD.');
      ok = false;
    }
    if (status && ['sent', 'failed', 'skipped', 'suppressed'].indexOf(status) === -1) {
      refs.historyStatusField.setError('Trạng thái không hợp lệ.');
      ok = false;
    }
    if (!ok) { return null; }
    return { ip: ip, date: date, status: status };
  }

  function clearHistoryFilters() {
    if (!refs) { return; }
    refs.historyCameraField.setValue('');
    refs.historyDateField.setValue('');
    refs.historyStatusField.setValue('');
    loadHistory(1);
  }

  function showHistoryError(err) {
    if (!refs) { return; }
    clear(refs.historyError);
    refs.historyError.hidden = false;
    refs.historyError.appendChild(panelError(
      errorText(err, 'Không tải được lịch sử cảnh báo.'),
      err && err.code ? err.code : null,
      err && err.requestId ? err.requestId : null,
      function () { loadHistory(historyPage); },
      'Không tải được lịch sử cảnh báo'
    ));
  }

  function hideHistoryError() {
    if (!refs) { return; }
    refs.historyError.hidden = true;
    clear(refs.historyError);
  }

  function loadHistory(page) {
    if (destroyed || !ctx || !refs) { return Promise.resolve(null); }
    var filters = readHistoryFilters();
    if (!filters) { return Promise.resolve(null); }
    var target = Math.max(1, Number(page) || 1);
    var seq = ++historySeq;
    historyPage = target;
    var query = {
      limit: historyPageSize,
      offset: (target - 1) * historyPageSize
    };
    if (filters.ip) { query.ip = filters.ip; }
    if (filters.date) { query.date = filters.date; }
    if (filters.status) { query.status = filters.status; }

    hideHistoryError();
    refs.historyTable.update({ loading: true });

    return ctx.api.get('/api/alarm/history', {
      query: query,
      signal: ctx.signal,
      silent: true,
      timeoutMs: 25000
    }).then(function (data) {
      if (destroyed || seq !== historySeq) { return null; }
      historyRows = data && Array.isArray(data.history) ? data.history : [];
      historyTotal = data && data.total !== undefined ? Number(data.total) || 0 : historyRows.length;
      var maxPage = Math.max(1, Math.ceil(historyTotal / historyPageSize));
      if (target > maxPage) { return loadHistory(maxPage); }
      if (!historyRows.length) { setHistoryEmpty(); }
      refs.historyTable.update({ rows: historyRows, loading: false });
      refs.historyPager.setState({
        page: historyPage,
        pageSize: historyPageSize,
        total: historyTotal
      });
      refs.historyCountBadge.textContent = String(historyTotal);
      return data;
    }).catch(function (err) {
      if (destroyed || seq !== historySeq) { return null; }
      if (err && err.code === 'ABORTED') { return null; }
      refs.historyTable.update({ loading: false, rows: historyRows });
      showHistoryError(err);
      return null;
    });
  }

  function snapshotNode(item) {
    var safe = dom.safePath(item && item.snapshot_url ? item.snapshot_url : '');
    if (!safe) {
      return el('span', { class: 'u-subtle', text: '—' });
    }
    var link = el('a', {
      class: 'c-row',
      attrs: {
        href: safe,
        target: '_blank',
        'aria-label': 'Mở ảnh cảnh báo',
        title: 'Mở ảnh cảnh báo'
      }
    });
    link.appendChild(el('img', {
      class: 'c-alert-item__thumb',
      attrs: {
        src: safe,
        alt: 'Ảnh cảnh báo',
        loading: 'lazy',
        decoding: 'async'
      }
    }));
    return link;
  }

  function confirmClearHistory() {
    if (!isAdmin() || pendingClearHistory || !ctx) { return; }
    ui.confirm({
      title: 'Xoá lịch sử cảnh báo?',
      message: 'Toàn bộ nhật ký cảnh báo sẽ bị xoá khỏi bộ nhớ máy chủ. Cấu hình và camera không bị ảnh hưởng.',
      confirmLabel: 'Xoá lịch sử',
      cancelLabel: 'Huỷ',
      variant: 'danger'
    }).then(function (ok) {
      if (!ok) { return null; }
      if (destroyed || !ctx) { return null; }
      pendingClearHistory = true;
      if (refs && refs.clearHistoryBtn) { ui.busy(refs.clearHistoryBtn, true); }
      return ctx.api.post('/api/alarm/clear_history', { confirm: true }, {
        signal: ctx.signal,
        silent: true,
        timeoutMs: 15000
      }).then(function (data) {
        if (destroyed) { return; }
        ui.toast((data && data.message) || 'Đã xoá nhật ký cảnh báo.', { type: 'success' });
        historyRows = [];
        historyTotal = 0;
        historyPage = 1;
        setHistoryEmpty();
        if (refs) {
          refs.historyTable.update({ rows: [], loading: false });
          refs.historyPager.setState({ page: 1, pageSize: historyPageSize, total: 0 });
          refs.historyCountBadge.textContent = '0';
        }
        loadHistory(1);
        loadStatus().catch(function () { return null; });
      }).catch(function (err) {
        if (destroyed || (err && err.code === 'ABORTED')) { return; }
        ui.toast(actionErrorText(err, 'Không xoá được lịch sử cảnh báo.'), { type: 'error' });
      }).then(function () {
        pendingClearHistory = false;
        if (!destroyed && refs && refs.clearHistoryBtn) {
          ui.busy(refs.clearHistoryBtn, false);
        }
      });
    });
  }

  /* ------------------------------ Data load ---------------------------- */

  function refreshAll() {
    if (destroyed || refreshing) { return; }
    refreshing = true;
    if (refs) { ui.busy(refs.refreshBtn, true); }
    loadCameras().then(function () {
      if (destroyed) { return null; }
      return Promise.all([
        loadStatus().catch(function () { return null; }),
        loadHistory(historyPage)
      ]);
    }).then(function () {
      refreshing = false;
      if (!destroyed && refs) { ui.busy(refs.refreshBtn, false); }
    }, function () {
      refreshing = false;
      if (!destroyed && refs) { ui.busy(refs.refreshBtn, false); }
    });
  }

  function render(container, viewCtx) {
    ctx = viewCtx;
    destroyed = false;
    refs = null;
    openLayers = [];
    cameras = Array.isArray(ctx.state.get('cameras')) ? ctx.state.get('cameras') : [];
    lastStatus = null;
    settingsData = null;
    secrets = null;
    secretsManagedExternally = false;
    tgFields = null;
    tgFieldList = [];
    cameraChecks = [];
    historyRows = [];
    historyTotal = 0;
    historyPage = 1;
    historyPageSize = ctx.state.getUi('pageSize', 10);
    pendingArm = false;
    pendingWatchdog = false;
    pendingSave = false;
    pendingTest = false;
    pendingClearHistory = false;
    pendingSecretClear = false;
    refreshing = false;

    buildPage(container);
    loadHistory(1);
    loadCameras().then(function () {
      if (destroyed) { return; }
      if (isAdmin()) { loadSettings(); }
    });

    stopStatusPoll = CCTV.poll(function () {
      return loadStatus();
    }, {
      intervalMs: 15000,
      immediate: true,
      maxBackoffMs: 60000,
      pauseWhenHidden: true
    });
  }

  function destroy() {
    destroyed = true;
    historySeq += 1;
    if (stopStatusPoll) {
      stopStatusPoll();
      stopStatusPoll = null;
    }
    closeLayers();
    if (historyTable) {
      try { historyTable.destroy(); } catch (err) { /* bỏ qua */ }
      historyTable = null;
    }
    refs = null;
    ctx = null;
    cameras = [];
    lastStatus = null;
    settingsData = null;
    secrets = null;
    tgFields = null;
    historyRows = [];
  }

  CCTV.views.register('alarms', {
    title: 'Cảnh báo',
    icon: 'alarms',
    roles: ['admin', 'viewer'],
    order: 60,
    render: render,
    destroy: destroy
  });
})();
