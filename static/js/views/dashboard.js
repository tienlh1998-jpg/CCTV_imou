/* =========================================================================
   CCTV Vision Hub v2.0 — view Tổng quan (dashboard)
   Owner: C1. Chỉ dùng API/component của core; không chèn HTML thô.
   ========================================================================= */
(function () {
  'use strict';

  if (!window.CCTV || !window.CCTV.views) { return; }

  var dom = CCTV.dom;
  var el = dom.el;
  var clear = dom.clear;
  var svg = CCTV.icons.svg;
  var fmt = CCTV.fmt;

  var ctxRef = null;
  var refs = null;
  var destroyed = false;
  var stopStatusPoll = null;
  var stopAlertPoll = null;
  var actionPending = false;

  var ADMIN_ONLY_WARNINGS = {
    BOOTSTRAP_PASSWORD: true,
    DEFAULT_PASSWORD_WEAK: true,
    VIEWER_DISABLED: true,
    TELEGRAM_NOT_CONFIGURED: true,
    ALARM_STATE_DEFAULTED: true
  };

  var WARNING_TONE = {
    critical: 'danger',
    warning: 'warning',
    info: 'info'
  };

  var WARNING_ICON = {
    critical: 'alert-circle',
    warning: 'alert-triangle',
    info: 'info'
  };

  /* ------------------------------ KPI ---------------------------------- */

  function makeKpi(opts) {
    var card = CCTV.ui.kpi({
      label: opts.label,
      value: '—',
      hint: '\u00a0',
      icon: opts.icon,
      tone: opts.tone,
      testId: opts.testId
    });
    return {
      card: card,
      value: card.querySelector('.c-kpi__value'),
      hint: card.querySelector('.c-kpi__hint')
    };
  }

  function setKpi(ref, value, hint) {
    if (!ref) { return; }
    if (ref.value) { ref.value.textContent = String(value); }
    if (ref.hint) { ref.hint.textContent = hint || '\u00a0'; }
  }

  /* --------------------------- Data helpers ---------------------------- */

  function cameraStats(status, cameras) {
    var stats = { total: 0, online: 0, offline: 0, auth_failed: 0, solar_sleep: 0, unknown: 0, armed: 0 };
    if (status && status.cameras) {
      stats.total = Number(status.cameras.total) || 0;
      stats.online = Number(status.cameras.online) || 0;
      stats.offline = Number(status.cameras.offline) || 0;
      stats.auth_failed = Number(status.cameras.auth_failed) || 0;
      stats.solar_sleep = Number(status.cameras.solar_sleep) || 0;
      stats.unknown = Number(status.cameras.unknown) || 0;
      stats.armed = Number(status.cameras.armed) || 0;
    }
    if (!stats.total && Array.isArray(cameras)) {
      stats.total = cameras.length;
      cameras.forEach(function (cam) {
        var cameraStatus = cam && cam.status ? String(cam.status) : 'unknown';
        if (stats[cameraStatus] !== undefined) { stats[cameraStatus] += 1; }
        else { stats.unknown += 1; }
        if (cam && cam.alarm_armed) { stats.armed += 1; }
      });
    }
    return stats;
  }

  function healthFlags(health, status) {
    var source = health && health.ffmpeg ? health.ffmpeg : (status && status.health && status.health.ffmpeg);
    var storage = health && health.storage ? health.storage : null;
    return {
      ffmpegAvailable: !!(source && source.available),
      ffmpegVersion: source && source.version ? String(source.version) : '',
      recordingsWritable: !storage || storage.recordings_writable !== false,
      snapshotsWritable: !storage || storage.snapshots_writable !== false,
      tls: !!(health && health.tls),
      uptime: health && health.uptime_seconds ? Number(health.uptime_seconds) : (status && status.app ? Number(status.app.uptime_seconds) : 0)
    };
  }

  function problemCameras(cameras) {
    if (!Array.isArray(cameras)) { return []; }
    var order = { offline: 0, auth_failed: 1, solar_sleep: 2, unknown: 3 };
    return cameras.filter(function (cam) {
      return cam && cam.status && cam.status !== 'online';
    }).sort(function (a, b) {
      var oa = order[a.status] === undefined ? 9 : order[a.status];
      var ob = order[b.status] === undefined ? 9 : order[b.status];
      return oa - ob;
    });
  }

  /* ----------------------------- Rendering ----------------------------- */

  function buildPage(container) {
    clear(container);
    var root = el('div', { class: 'c-stack', attrs: { 'data-testid': 'dashboard-page' } });

    var updated = el('span', { class: 'u-muted u-tabular', text: 'Đang tải…' });
    var refreshBtn = CCTV.ui.button({
      label: 'Làm mới',
      icon: 'refresh',
      variant: 'secondary',
      size: 'sm',
      onClick: function () { refreshAll(false); }
    });
    var header = CCTV.ui.pageHeader({
      title: 'Tổng quan',
      subtitle: 'Sức khỏe hệ thống và cảnh báo gần đây',
      icon: 'dashboard',
      actions: [updated, refreshBtn]
    });
    root.appendChild(header);

    var errorStrip = el('div', { hidden: true });
    root.appendChild(errorStrip);

    var banners = el('div', { class: 'c-banner-list' });
    root.appendChild(banners);

    var kpiGrid = el('div', { class: 'c-grid c-grid--kpi' });
    var kpi = {
      total: makeKpi({ label: 'Tổng camera', icon: 'camera', tone: 'neutral', testId: 'dashboard-kpi-cameras' }),
      online: makeKpi({ label: 'Trực tuyến', icon: 'wifi', tone: 'success', testId: 'dashboard-kpi-online' }),
      offline: makeKpi({ label: 'Ngoại tuyến', icon: 'wifi-off', tone: 'danger', testId: 'dashboard-kpi-offline' }),
      armed: makeKpi({ label: 'Đang gác', icon: 'shield', tone: 'primary', testId: 'dashboard-kpi-armed' }),
      alerts: makeKpi({ label: 'Cảnh báo hôm nay', icon: 'bell', tone: 'warning', testId: 'dashboard-kpi-alerts' }),
      storage: makeKpi({ label: 'Cảnh báo thẻ nhớ', icon: 'sd-card', tone: 'info', testId: 'dashboard-kpi-storage' })
    };
    Object.keys(kpi).forEach(function (key) { kpiGrid.appendChild(kpi[key].card); });
    root.appendChild(kpiGrid);

    var columns = el('div', { class: 'c-dash-grid' });

    /* Camera status card */
    var cameraCard = el('section', { class: 'c-card' });
    var cameraHeader = el('div', { class: 'c-card__header' });
    var cameraTitle = el('div');
    cameraTitle.appendChild(el('div', { class: 'c-card__title' }));
    cameraTitle.firstChild.appendChild(svg('cameras', { size: 16 }));
    cameraTitle.firstChild.appendChild(el('span', { text: 'Trạng thái camera' }));
    cameraTitle.appendChild(el('div', { class: 'c-card__subtitle', text: 'Phân bố trạng thái và camera cần chú ý' }));
    cameraHeader.appendChild(cameraTitle);
    var cameraAction = CCTV.ui.button({
      label: 'Xem tất cả',
      icon: 'arrow-right',
      variant: 'ghost',
      size: 'sm',
      onClick: function () { ctxRef.router.go('cameras'); }
    });
    cameraHeader.appendChild(cameraAction);
    cameraCard.appendChild(cameraHeader);
    var cameraBody = el('div', { class: 'c-card__body' });
    cameraCard.appendChild(cameraBody);

    var bar = el('div', { class: 'c-bar', attrs: { role: 'img', 'aria-label': 'Phân bố trạng thái camera' } });
    var legend = el('div', { class: 'c-legend' });
    var cameraList = el('div', { class: 'c-stack c-stack--sm' });
    cameraBody.appendChild(bar);
    cameraBody.appendChild(legend);
    cameraBody.appendChild(el('div', { class: 'c-divider' }));
    cameraBody.appendChild(cameraList);
    cameraList.appendChild(CCTV.ui.skeleton({ variant: 'text', rows: 4 }));

    /* Health card */
    var healthCard = el('section', { class: 'c-card' });
    var healthHeader = el('div', { class: 'c-card__header' });
    var healthTitle = el('div');
    healthTitle.appendChild(el('div', { class: 'c-card__title' }));
    healthTitle.firstChild.appendChild(svg('activity', { size: 16 }));
    healthTitle.firstChild.appendChild(el('span', { text: 'Sức khỏe hệ thống' }));
    healthTitle.appendChild(el('div', { class: 'c-card__subtitle', text: 'Dịch vụ nền và tài nguyên' }));
    healthHeader.appendChild(healthTitle);
    healthCard.appendChild(healthHeader);
    var healthBody = el('div', { class: 'c-card__body' });
    healthBody.appendChild(CCTV.ui.skeleton({ variant: 'text', rows: 5 }));
    healthCard.appendChild(healthBody);

    columns.appendChild(cameraCard);
    columns.appendChild(healthCard);
    root.appendChild(columns);

    /* Recent alerts card */
    var alertsCard = el('section', { class: 'c-card', attrs: { 'data-testid': 'dashboard-recent-alerts' } });
    var alertsHeader = el('div', { class: 'c-card__header' });
    var alertsTitle = el('div');
    alertsTitle.appendChild(el('div', { class: 'c-card__title' }));
    alertsTitle.firstChild.appendChild(svg('bell', { size: 16 }));
    alertsTitle.firstChild.appendChild(el('span', { text: 'Cảnh báo gần đây' }));
    alertsTitle.appendChild(el('div', { class: 'c-card__subtitle', text: '5 sự kiện mới nhất từ lịch sử cảnh báo' }));
    alertsHeader.appendChild(alertsTitle);
    var alertsAction = CCTV.ui.button({
      label: 'Xem tất cả',
      icon: 'arrow-right',
      variant: 'ghost',
      size: 'sm',
      onClick: function () { ctxRef.router.go('alarms'); }
    });
    alertsHeader.appendChild(alertsAction);
    alertsCard.appendChild(alertsHeader);
    var alertsBody = el('div', { class: 'c-card__body' });
    alertsBody.appendChild(CCTV.ui.skeleton({ variant: 'text', rows: 4 }));
    alertsCard.appendChild(alertsBody);
    root.appendChild(alertsCard);

    /* Quick actions (admin) */
    var quickCard = null;
    if (ctxRef.isAdmin) {
      quickCard = el('section', { class: 'c-card', attrs: { 'data-testid': 'dashboard-quick-actions', 'data-admin-only': '1' } });
      var quickHeader = el('div', { class: 'c-card__header' });
      var quickTitle = el('div');
      quickTitle.appendChild(el('div', { class: 'c-card__title' }));
      quickTitle.firstChild.appendChild(svg('sliders', { size: 16 }));
      quickTitle.firstChild.appendChild(el('span', { text: 'Hành động nhanh' }));
      quickHeader.appendChild(quickTitle);
      quickCard.appendChild(quickHeader);
      var quickBody = el('div', { class: 'c-card__body' });
      var quickGrid = el('div', { class: 'c-grid c-grid--2' });

      var armBtn = CCTV.ui.button({
        label: 'Đang gác',
        icon: 'shield',
        variant: 'secondary',
        block: true,
        testId: 'dashboard-quick-arm',
        onClick: function () { toggleArmed(); }
      });
      refs.quickArm = armBtn;
      quickGrid.appendChild(CCTV.ui.button({
        label: 'Quét mạng',
        icon: 'scanner',
        variant: 'secondary',
        block: true,
        onClick: function () { ctxRef.router.go('scanner'); }
      }));
      quickGrid.appendChild(CCTV.ui.button({
        label: 'Thêm camera',
        icon: 'plus',
        variant: 'secondary',
        block: true,
        testId: 'dashboard-quick-add-camera',
        onClick: function () {
          /* Mở thẳng modal thêm camera ở view Camera thay vì chỉ điều hướng. */
          ctxRef.state.set('uiRequest', { openAddCamera: true });
          ctxRef.router.go('cameras');
        }
      }));
      quickGrid.appendChild(armBtn);
      quickGrid.appendChild(CCTV.ui.button({
        label: 'Kiểm tra thẻ nhớ',
        icon: 'sd-card',
        variant: 'secondary',
        block: true,
        onClick: function () { ctxRef.router.go('storage'); }
      }));
      quickBody.appendChild(quickGrid);
      quickCard.appendChild(quickBody);
      root.appendChild(quickCard);
    }

    refs.updated = updated;
    refs.errorStrip = errorStrip;
    refs.banners = banners;
    refs.kpi = kpi;
    refs.bar = bar;
    refs.legend = legend;
    refs.cameraList = cameraList;
    refs.healthBody = healthBody;
    refs.alertsBody = alertsBody;
    refs.quickCard = quickCard;
    refs.refreshBtn = refreshBtn;

    container.appendChild(root);
  }

  function showError(message, details) {
    if (!refs || !refs.errorStrip) { return; }
    clear(refs.errorStrip);
    refs.errorStrip.hidden = false;
    refs.errorStrip.appendChild(CCTV.ui.banner({
      tone: 'danger',
      title: 'Không cập nhật được dữ liệu',
      message: message || 'Máy chủ không phản hồi.',
      actions: [CCTV.ui.button({
        label: 'Thử lại',
        icon: 'refresh',
        variant: 'secondary',
        size: 'sm',
        onClick: function () { refreshAll(false); }
      })],
      dismissible: true
    }));
    if (details) { refs.errorStrip.setAttribute('title', details); }
  }

  function hideError() {
    if (!refs || !refs.errorStrip) { return; }
    refs.errorStrip.hidden = true;
    clear(refs.errorStrip);
  }

  function renderUpdated() {
    if (!refs || !refs.updated) { return; }
    refs.updated.textContent = 'Cập nhật: ' + fmt.time(new Date());
  }

  /* --------------------------- Banners --------------------------------- */

  function warningAction(code) {
    if (!ctxRef.isAdmin) { return null; }
    if (code === 'FFMPEG_MISSING') {
      return CCTV.ui.button({
        label: 'Chẩn đoán',
        icon: 'terminal',
        variant: 'secondary',
        size: 'sm',
        onClick: function () { ctxRef.router.go('settings'); }
      });
    }
    if (code === 'BOOTSTRAP_PASSWORD' || code === 'DEFAULT_PASSWORD_WEAK' || code === 'VIEWER_DISABLED' || code === 'TELEGRAM_NOT_CONFIGURED') {
      return CCTV.ui.button({
        label: 'Mở cài đặt',
        icon: 'settings',
        variant: 'secondary',
        size: 'sm',
        onClick: function () { ctxRef.router.go('settings'); }
      });
    }
    if (code === 'ALARM_STATE_DEFAULTED') {
      return CCTV.ui.button({
        label: 'Xem camera',
        icon: 'cameras',
        variant: 'secondary',
        size: 'sm',
        onClick: function () { ctxRef.router.go('cameras'); }
      });
    }
    return null;
  }

  function warningTestId(code) {
    if (code === 'FFMPEG_MISSING') { return 'dashboard-banner-ffmpeg'; }
    if (code === 'BOOTSTRAP_PASSWORD' || code === 'DEFAULT_PASSWORD_WEAK') { return 'dashboard-banner-password'; }
    return 'dashboard-banner-' + String(code).toLowerCase().replace(/_/g, '-');
  }

  function renderBanners(status, health) {
    if (!refs || !refs.banners) { return; }
    clear(refs.banners);
    if (!status) { return; }

    var warnings = Array.isArray(status.warnings) ? status.warnings.slice() : [];
    var seen = {};
    var list = [];
    warnings.forEach(function (warning) {
      if (!warning || !warning.code) { return; }
      var code = String(warning.code);
      if (seen[code]) { return; }
      if (!ctxRef.isAdmin && ADMIN_ONLY_WARNINGS[code]) { return; }
      seen[code] = true;
      list.push(warning);
    });

    var sessionInfo = CCTV.auth.session();
    if (sessionInfo && sessionInfo.expiresAt) {
      var expires = new Date(sessionInfo.expiresAt).getTime();
      var minutesLeft = Math.floor((expires - Date.now()) / 60000);
      if (minutesLeft > 0 && minutesLeft <= 30 && !seen.SESSION_EXPIRING) {
        seen.SESSION_EXPIRING = true;
        list.push({
          code: 'SESSION_EXPIRING',
          severity: 'info',
          message: 'Phiên đăng nhập sẽ hết hạn lúc ' + fmt.time(sessionInfo.expiresAt) + '. Hãy lưu công việc trước khi đăng nhập lại.'
        });
      }
    }

    var flags = healthFlags(health, status);
    if (!flags.ffmpegAvailable && !seen.FFMPEG_MISSING) {
      list.unshift({
        code: 'FFMPEG_MISSING',
        severity: 'critical',
        message: 'FFmpeg chưa được cài hoặc không có trong PATH. Xem trực tiếp, snapshot và ghi hình sẽ không hoạt động.'
      });
    }

    list.forEach(function (warning) {
      var code = String(warning.code);
      var severity = warning.severity === 'critical' || warning.severity === 'warning' ? warning.severity : 'info';
      var action = warningAction(code);
      var extraActions = [];
      if (code === 'HTTP_ONLY' && !ctxRef.isAdmin) {
        extraActions = [];
      }
      if (action) { extraActions.push(action); }
      refs.banners.appendChild(CCTV.ui.banner({
        tone: WARNING_TONE[severity],
        icon: WARNING_ICON[severity],
        title: warningTitle(code),
        message: warning.message || '',
        actions: extraActions,
        testId: warningTestId(code)
      }));
    });
  }

  function warningTitle(code) {
    var titles = {
      FFMPEG_MISSING: 'Thiếu FFmpeg',
      BOOTSTRAP_PASSWORD: 'Đang dùng mật khẩu khởi tạo',
      DEFAULT_PASSWORD_WEAK: 'Mật khẩu camera mặc định yếu',
      VIEWER_DISABLED: 'Tài khoản người xem chưa bật',
      HTTP_ONLY: 'Kết nối HTTP trong LAN',
      STORAGE_UNWRITABLE: 'Thư mục lưu không ghi được',
      ALARM_GRACE_ACTIVE: 'Cảnh báo đang trong thời gian chờ',
      TELEGRAM_NOT_CONFIGURED: 'Telegram chưa cấu hình',
      ALARM_STATE_DEFAULTED: 'Trạng thái gác mặc định',
      SESSION_EXPIRING: 'Phiên đăng nhập sắp hết hạn'
    };
    return titles[code] || code;
  }

  /* ------------------------- Camera status ----------------------------- */

  function renderCameraStatus(stats, cameras) {
    if (!refs) { return; }
    clear(refs.bar);
    clear(refs.legend);
    clear(refs.cameraList);

    var total = stats.total || 1;
    var segments = [
      { key: 'online', count: stats.online, tone: 'success', label: 'Trực tuyến' },
      { key: 'offline', count: stats.offline, tone: 'danger', label: 'Ngoại tuyến' },
      { key: 'auth_failed', count: stats.auth_failed, tone: 'warning', label: 'Sai mật khẩu' },
      { key: 'solar_sleep', count: stats.solar_sleep, tone: 'info', label: 'Ngủ năng lượng' },
      { key: 'unknown', count: stats.unknown, tone: 'neutral', label: 'Chưa rõ' }
    ];
    segments.forEach(function (segment) {
      if (!segment.count) { return; }
      var pct = (segment.count / total) * 100;
      var piece = el('span', {
        class: 'c-bar__seg',
        attrs: { 'data-tone': segment.tone, title: segment.label + ': ' + segment.count }
      });
      piece.style.setProperty('--w', pct.toFixed(2) + '%');
      refs.bar.appendChild(piece);
    });

    segments.forEach(function (segment) {
      var item = el('span', { class: 'c-legend__item' });
      var swatch = el('span', { class: 'c-legend__swatch', attrs: { 'aria-hidden': 'true' } });
      swatch.style.setProperty('background', segment.tone === 'success' ? 'var(--success)' : segment.tone === 'danger' ? 'var(--danger)' : segment.tone === 'warning' ? 'var(--warning)' : segment.tone === 'info' ? 'var(--info)' : 'var(--text-subtle)');
      item.appendChild(swatch);
      item.appendChild(el('span', { text: segment.label + ' ' + segment.count }));
      refs.legend.appendChild(item);
    });

    refs.cameraList.appendChild(el('div', { class: 'c-card__subtitle', text: 'Camera cần chú ý' }));
    var problems = problemCameras(cameras);
    if (!problems.length) {
      refs.cameraList.appendChild(el('p', { class: 'c-muted-block', text: stats.total ? 'Tất cả camera đang trực tuyến.' : 'Chưa có camera nào được cấu hình.' }));
      return;
    }
    var list = el('div');
    problems.slice(0, 6).forEach(function (cam) {
      var row = el('div', { class: 'c-camera-mini' });
      var body = el('div', { class: 'c-camera-mini__body' });
      body.appendChild(el('div', { class: 'c-camera-mini__name', text: cam.name || cam.ip || 'Camera' }));
      body.appendChild(el('div', { class: 'c-camera-mini__meta', text: String(cam.ip || '') }));
      row.appendChild(body);
      row.appendChild(CCTV.ui.statusPill(cam.status || 'unknown'));
      list.appendChild(row);
    });
    if (problems.length > 6) {
      list.appendChild(el('p', { class: 'c-muted-block', text: 'Và ' + (problems.length - 6) + ' camera khác.' }));
      list.appendChild(CCTV.ui.button({
        label: 'Xem danh sách',
        icon: 'arrow-right',
        variant: 'ghost',
        size: 'sm',
        onClick: function () { ctxRef.router.go('cameras'); }
      }));
    }
    refs.cameraList.appendChild(list);
  }

  /* --------------------------- Health card ----------------------------- */

  function healthRow(label, valueNode, dotTone) {
    var row = el('div', { class: 'c-health-row' });
    var labelNode = el('span', { class: 'c-health-row__label' });
    if (dotTone) {
      labelNode.appendChild(el('span', { class: 'c-dot c-dot--' + dotTone, attrs: { 'aria-hidden': 'true' } }));
    }
    labelNode.appendChild(el('span', { text: label }));
    row.appendChild(labelNode);
    var value = el('span', { class: 'c-health-row__value' });
    if (valueNode instanceof Node) {
      value.appendChild(valueNode);
    } else {
      value.textContent = valueNode;
    }
    row.appendChild(value);
    return row;
  }

  function renderHealth(health, status, alarm) {
    if (!refs) { return; }
    clear(refs.healthBody);
    var flags = healthFlags(health, status);
    var rows = el('div', { class: 'c-health-list' });

    rows.appendChild(healthRow(
      'FFmpeg',
      flags.ffmpegAvailable ? 'Sẵn sàng' + (flags.ffmpegVersion ? ' · ' + flags.ffmpegVersion : '') : 'Thiếu',
      flags.ffmpegAvailable ? 'success' : 'warning'
    ));
    rows.appendChild(healthRow(
      'Thư mục ghi',
      flags.recordingsWritable && flags.snapshotsWritable ? 'Ghi được' : 'Có lỗi ghi',
      flags.recordingsWritable && flags.snapshotsWritable ? 'success' : 'danger'
    ));
    rows.appendChild(healthRow(
      'Kết nối',
      flags.tls ? 'HTTPS' : 'HTTP trong LAN',
      flags.tls ? 'success' : 'warning'
    ));
    if (alarm) {
      rows.appendChild(healthRow(
        'Chế độ gác',
        alarm.armed ? 'Đang gác' : 'Tắt gác',
        alarm.armed ? 'success' : 'muted'
      ));
      if (ctxRef.isAdmin && alarm.telegram_configured !== undefined) {
        rows.appendChild(healthRow(
          'Telegram',
          alarm.telegram_configured ? 'Đã cấu hình' : 'Chưa cấu hình',
          alarm.telegram_configured ? 'success' : 'warning'
        ));
      }
    }
    if (status && status.config && typeof status.config.telegram_configured === 'boolean') {
      rows.appendChild(healthRow(
        'Telegram',
        status.config.telegram_configured ? 'Đã cấu hình' : 'Chưa cấu hình',
        status.config.telegram_configured ? 'success' : 'warning'
      ));
    }
    var session = ctxRef.state.get('session');
    if (session && session.expiresAt) {
      rows.appendChild(healthRow('Phiên hết hạn', fmt.dateTime(session.expiresAt), null));
    }
    if (flags.uptime) {
      rows.appendChild(healthRow('Máy chủ hoạt động', fmt.duration(flags.uptime), null));
    }
    if (health && health.mode === 'test') {
      rows.appendChild(healthRow('Chế độ', 'Kiểm thử', 'warning'));
    }
    refs.healthBody.appendChild(rows);
  }

  /* --------------------------- Alerts list ----------------------------- */

  function alertThumb(item) {
    var safe = dom.safePath(item && item.snapshot_url ? item.snapshot_url : '');
    if (!safe) {
      var placeholder = el('span', { class: 'c-alert-item__icon', attrs: { 'aria-hidden': 'true' } });
      placeholder.appendChild(svg('image', { size: 15 }));
      return placeholder;
    }
    var img = el('img', {
      class: 'c-alert-item__thumb',
      attrs: { src: safe, alt: 'Ảnh cảnh báo', loading: 'lazy', decoding: 'async' }
    });
    return img;
  }

  function renderAlerts(history, errorMessage) {
    if (!refs) { return; }
    clear(refs.alertsBody);
    if (errorMessage && (!history || !history.length)) {
      refs.alertsBody.appendChild(CCTV.ui.errorPanel({
        title: 'Không tải được lịch sử cảnh báo',
        message: errorMessage,
        retry: function () { refreshAlerts(); }
      }));
      return;
    }
    if (!history || !history.length) {
      refs.alertsBody.appendChild(CCTV.ui.empty({
        icon: 'bell-off',
        title: 'Chưa có cảnh báo nào',
        description: 'Lịch sử cảnh báo sẽ xuất hiện khi hệ thống ghi nhận sự kiện an ninh.'
      }));
      return;
    }
    if (errorMessage) {
      refs.alertsBody.appendChild(CCTV.ui.banner({
        tone: 'warning',
        title: 'Không cập nhật được lịch sử',
        message: errorMessage,
        dismissible: true
      }));
    }
    var list = el('div', { class: 'c-alert-list' });
    history.slice(0, 5).forEach(function (item) {
      var row = el('div', { class: 'c-alert-item' });
      var icon = el('span', { class: 'c-alert-item__icon', attrs: { 'aria-hidden': 'true' } });
      icon.appendChild(svg('bell', { size: 15 }));
      row.appendChild(icon);
      var body = el('div', { class: 'c-alert-item__body' });
      body.appendChild(el('div', { class: 'c-alert-item__title', text: item && item.title ? String(item.title) : (item && item.code ? String(item.code) : 'Sự kiện') }));
      var metaParts = [];
      if (item && item.timestamp) { metaParts.push(fmt.dateTime(item.timestamp)); }
      if (item && (item.name || item.ip)) { metaParts.push(item.name || item.ip); }
      body.appendChild(el('div', { class: 'c-alert-item__meta', text: metaParts.join(' · ') }));
      row.appendChild(body);
      var right = el('div', { class: 'c-row' });
      right.appendChild(CCTV.ui.statusPill(item && item.status ? item.status : 'unknown'));
      var thumb = alertThumb(item);
      if (thumb) { right.appendChild(thumb); }
      row.appendChild(right);
      list.appendChild(row);
    });
    refs.alertsBody.appendChild(list);
  }

  /* --------------------------- Quick actions ---------------------------- */

  function syncQuickActions(alarm) {
    if (!refs || !refs.quickArm) { return; }
    var armed = !!(alarm && alarm.armed);
    var labelNode = refs.quickArm.querySelector('.c-btn__label');
    var useNode = refs.quickArm.querySelector('use');
    if (labelNode) { labelNode.textContent = armed ? 'Tắt gác' : 'Bật gác'; }
    if (useNode) {
      useNode.setAttribute('href', armed ? '#i-shield-off' : '#i-shield');
      useNode.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', armed ? '#i-shield-off' : '#i-shield');
    }
    refs.quickArm.setAttribute('aria-label', armed ? 'Tắt chế độ gác an ninh' : 'Bật chế độ gác an ninh');
  }

  function toggleArmed() {
    if (actionPending || !ctxRef || !ctxRef.isAdmin) { return; }
    var alarm = ctxRef.state.get('alarmStatus');
    var current = !!(alarm && alarm.armed);
    var next = !current;
    var proceed = next ? Promise.resolve(true) : CCTV.ui.confirm({
      title: 'Tắt chế độ gác an ninh?',
      message: 'Hệ thống sẽ ngừng gửi cảnh báo Telegram cho đến khi bật lại. Camera vẫn ghi hình bình thường.',
      confirmLabel: 'Tắt gác',
      cancelLabel: 'Giữ nguyên',
      variant: 'danger'
    });
    proceed.then(function (ok) {
      if (!ok) { return null; }
      actionPending = true;
      if (refs.quickArm) { CCTV.ui.busy(refs.quickArm, true); }
      var body = { armed: next };
      if (!next) { body.confirm = true; }
      return ctxRef.api.post('/api/alarm/toggle', body, { signal: ctxRef.signal }).then(function () {
        CCTV.ui.toast(next ? 'Đã bật chế độ gác an ninh.' : 'Đã tắt chế độ gác an ninh.', { type: next ? 'success' : 'warning' });
        return ctxRef.state.refresh('alarmStatus').catch(function () { return null; });
      }).then(function (data) {
        if (data) { syncQuickActions(data); }
        return ctxRef.state.refresh('systemStatus').catch(function () { return null; });
      }).then(function (status) {
        if (status) { applyStatus(status); }
      }).catch(function (err) {
        if (err && err.code !== 'ABORTED') {
          CCTV.ui.toast(err.message || 'Không đổi được trạng thái gác.', { type: 'error' });
        }
      }).then(function () {
        actionPending = false;
        if (refs.quickArm) { CCTV.ui.busy(refs.quickArm, false); }
      });
    });
  }

  /* ------------------------------ Data load ----------------------------- */

  function applyStatus(status) {
    if (!ctxRef || destroyed) { return; }
    var cameras = ctxRef.state.get('cameras');
    var health = ctxRef.state.get('health');
    var alarm = ctxRef.state.get('alarmStatus');
    var stats = cameraStats(status, cameras);
    var alertsToday = status && status.alerts ? Number(status.alerts.today) || 0 : 0;
    var storageAlerts = status && status.storage ? Number(status.storage.alerts) || 0 : 0;

    setKpi(refs.kpi.total, stats.total, stats.total ? 'camera đã cấu hình' : 'chưa có camera');
    setKpi(refs.kpi.online, stats.online, stats.total ? Math.round((stats.online / Math.max(1, stats.total)) * 100) + '% tổng số' : '\u00a0');
    setKpi(refs.kpi.offline, stats.offline, stats.auth_failed ? stats.auth_failed + ' sai mật khẩu' : '\u00a0');
    setKpi(refs.kpi.armed, alarm && alarm.armed !== undefined ? (alarm.armed ? 'Bật' : 'Tắt') : stats.armed, alarm && alarm.armed ? 'hệ thống đang gác' : 'camera đang gác');
    setKpi(refs.kpi.alerts, alertsToday, alertsToday ? 'trong ngày hôm nay' : 'chưa có cảnh báo');
    setKpi(refs.kpi.storage, storageAlerts, storageAlerts ? 'camera cần kiểm tra thẻ' : 'thẻ nhớ bình thường');

    renderBanners(status, health);
    renderCameraStatus(stats, cameras);
    renderHealth(health, status, alarm);
    syncQuickActions(alarm);
  }

  function applyAlarm(alarm) {
    if (!alarm || !ctxRef) { return; }
    var status = ctxRef.state.get('systemStatus');
    if (status) { applyStatus(status); }
    else { syncQuickActions(alarm); }
  }

  function refreshAlerts() {
    if (!ctxRef || destroyed) { return; }
    ctxRef.api.get('/api/alarm/history', { query: { limit: 5 }, signal: ctxRef.signal, silent: true })
      .then(function (data) {
        if (destroyed) { return; }
        renderAlerts(data && Array.isArray(data.history) ? data.history : []);
      })
      .catch(function (err) {
        if (destroyed || !err || err.code === 'ABORTED') { return; }
        renderAlerts(ctxRef.state.get('alarms') && ctxRef.state.get('alarms').history, err.message || 'Lỗi tải lịch sử.');
      });
  }

  function refreshAll(initial) {
    if (!ctxRef || destroyed) { return; }
    if (refs.refreshBtn) { CCTV.ui.busy(refs.refreshBtn, true); }
    var tasks = [
      ctxRef.state.refresh('systemStatus').catch(function () { return null; }),
      ctxRef.state.refresh('cameras').catch(function () { return null; }),
      ctxRef.state.refresh('alarmStatus').catch(function () { return null; }),
      ctxRef.state.refresh('health').catch(function () { return null; })
    ];
    Promise.all(tasks).then(function () {
      if (destroyed) { return; }
      var status = ctxRef.state.get('systemStatus');
      if (status) {
        hideError();
        applyStatus(status);
      } else if (initial) {
        showError('Không tải được trạng thái hệ thống. Kiểm tra kết nối máy chủ.');
      } else {
        showError('Không cập nhật được trạng thái hệ thống. Dữ liệu cũ vẫn được giữ lại.');
      }
      if (refs.refreshBtn) { CCTV.ui.busy(refs.refreshBtn, false); }
      renderUpdated();
    });
    refreshAlerts();
  }

  /* ----------------------------- Lifecycle ------------------------------ */

  function render(container, ctx) {
    ctxRef = ctx;
    destroyed = false;
    refs = {};
    clear(container);

    /* Dựng khung đồng bộ với skeleton bên trong các vùng dữ liệu. */
    buildPage(container);

    stopStatusPoll = CCTV.poll(function () {
      if (destroyed) { return null; }
      return ctxRef.state.refresh('systemStatus').then(function (status) {
        if (destroyed || !status) { return null; }
        hideError();
        applyStatus(status);
        renderUpdated();
        return status;
      }).catch(function () {
        if (!destroyed) { showError('Mất kết nối tới máy chủ. Đang thử lại…'); }
        return null;
      });
    }, { intervalMs: 15000, immediate: false, maxBackoffMs: 60000, pauseWhenHidden: true });

    stopAlertPoll = CCTV.poll(function () {
      if (destroyed) { return null; }
      refreshAlerts();
      return null;
    }, { intervalMs: 60000, immediate: false, pauseWhenHidden: true });

    refreshAll(true);
  }

  function destroy() {
    destroyed = true;
    if (stopStatusPoll) { stopStatusPoll(); stopStatusPoll = null; }
    if (stopAlertPoll) { stopAlertPoll(); stopAlertPoll = null; }
    refs = null;
    ctxRef = null;
    actionPending = false;
  }

  function onResume() {
    if (!ctxRef || destroyed) { return; }
    refreshAll(false);
  }

  CCTV.views.register('dashboard', {
    title: 'Tổng quan',
    icon: 'dashboard',
    roles: ['admin', 'viewer'],
    order: 10,
    render: render,
    destroy: destroy,
    onResume: onResume
  });
})();
