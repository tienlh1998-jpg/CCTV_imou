/* =========================================================================
   CCTV Vision Hub v2.0 — view Camera
   Quản lý camera đã lưu, chi tiết thiết bị, thẻ nhớ và thao tác hàng loạt.
   Chỉ dùng API/component của core; mọi dữ liệu động render bằng textContent.
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

  var PAGE_SIZES = [10, 15, 20, 30, 50];
  var STATUS_VALUES = ['online', 'offline', 'auth_failed', 'solar_sleep', 'unknown'];
  var STATUS_ORDER = { online: 0, solar_sleep: 1, unknown: 2, auth_failed: 3, offline: 4 };

  var ctx = null;
  var viewRoot = null;
  var refs = {};
  var destroyed = true;
  var cameras = [];
  var selected = new Set();
  var page = 1;
  var pageSize = 15;
  var filters = { q: '', group: '', status: '', armed: '' };
  var sort = { key: 'name', dir: 'asc' };
  var table = null;
  var pagination = null;
  var emptyHost = null;
  var currentRows = [];
  var openLayers = [];
  var refreshToken = 0;

  /* ------------------------------ Helpers ------------------------------ */

  function fold(value) {
    var text = String(value === undefined || value === null ? '' : value);
    try {
      return text.toLowerCase().normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd');
    } catch (err) {
      return text.toLowerCase();
    }
  }

  function camKey(cam) {
    if (!cam) { return ''; }
    return String(cam.id || cam.ip || '');
  }

  function isPrivateIPv4(value) {
    var match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(value || '').trim());
    if (!match) { return false; }
    var parts = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
    for (var i = 0; i < parts.length; i += 1) {
      if (parts[i] < 0 || parts[i] > 255) { return false; }
    }
    if (parts[0] === 10 || parts[0] === 127) { return true; }
    if (parts[0] === 192 && parts[1] === 168) { return true; }
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) { return true; }
    if (parts[0] === 169 && parts[1] === 254) { return true; }
    return false;
  }

  function isValidIPv4(value) {
    var match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(value || '').trim());
    if (!match) { return false; }
    for (var i = 1; i <= 4; i += 1) {
      var part = Number(match[i]);
      if (part < 0 || part > 255) { return false; }
    }
    return true;
  }

  function toPort(value, fallback) {
    var number = parseInt(value, 10);
    if (!isFinite(number) || number < 1 || number > 65535) { return fallback; }
    return number;
  }

  function todayString() {
    var now = new Date();
    var month = String(now.getMonth() + 1).padStart(2, '0');
    var day = String(now.getDate()).padStart(2, '0');
    return now.getFullYear() + '-' + month + '-' + day;
  }

  function display(value) {
    if (value === undefined || value === null || value === '') { return '—'; }
    if (Array.isArray(value)) {
      return value.length ? value.join(', ') : '—';
    }
    var text = String(value).trim();
    if (!text || text === 'N/A' || text === 'Unknown' || text === 'unknown') { return '—'; }
    return text;
  }

  function pick(source, fallback) {
    if (source === undefined || source === null) { return fallback; }
    var text = String(source).trim();
    if (!text || text === 'N/A' || text === 'Unknown' || text === 'unknown') { return fallback; }
    return source;
  }

  function showApiError(err, fallback) {
    if (!err || err.code === 'ABORTED' || err.status === 401) { return; }
    var message = err.message || fallback || 'Thao tác thất bại.';
    var type = (err.status === 403 || err.status === 429 || err.code === 'TEST_MODE_BLOCKED') ? 'warning' : 'error';
    ui.toast(message, { type: type, duration: err.status === 429 ? 8000 : 5000 });
  }

  function errorDetail(err) {
    if (!err) { return ''; }
    if (err.code && err.message) { return err.message + ' (' + err.code + ')'; }
    return err.message || err.code || 'Lỗi không xác định.';
  }

  function openLive(cam) {
    if (!ctx || !cam) { return; }
    /* Bàn giao lựa chọn sang live qua khóa UI được allowlist. */
    ctx.state.setUi('grid', { mode: '1', slots: [{ ip: cam.ip, channel: 1 }] });
    ctx.router.go('live');
  }

  function kvBlock(rows) {
    var dl = el('dl', { class: 'c-kv' });
    rows.forEach(function (row) {
      dl.appendChild(el('dt', { text: String(row[0]) }));
      var dd = el('dd', { text: display(row[1]) });
      if (row[2]) { dd.classList.add('u-mono'); }
      dl.appendChild(dd);
    });
    return dl;
  }

  /* --------------------------- List loading ---------------------------- */

  function setRefreshBusy(busy) {
    if (refs.refreshBtn) { ui.busy(refs.refreshBtn, !!busy); }
  }

  function showLoadError(err) {
    if (!refs.errorHost || !err || err.code === 'ABORTED') { return; }
    refs.errorHost.hidden = false;
    clear(refs.errorHost);
    if (!cameras.length) {
      refs.errorHost.appendChild(ui.errorPanel({
        title: 'Không tải được danh sách camera',
        message: err.message || 'Không kết nối được máy chủ.',
        code: err.code || null,
        requestId: err.requestId || null,
        retry: function () { loadCameras(true); }
      }));
    } else {
      refs.errorHost.appendChild(ui.banner({
        tone: 'warning',
        title: 'Không làm mới được danh sách',
        message: err.message || 'Dữ liệu đang hiển thị có thể đã cũ.',
        actions: [
          ui.button({
            label: 'Thử lại',
            icon: 'refresh',
            variant: 'secondary',
            size: 'sm',
            onClick: function () { loadCameras(true); }
          })
        ],
        dismissible: true
      }));
    }
  }

  function loadCameras(showBusy) {
    if (!ctx || destroyed) { return Promise.resolve([]); }
    refreshToken += 1;
    var token = refreshToken;
    if (showBusy) { setRefreshBusy(true); }
    if (!cameras.length && table) { table.update({ loading: true }); }
    return ctx.state.refresh('cameras').then(function (list) {
      if (destroyed || token !== refreshToken) { return []; }
      cameras = Array.isArray(list) ? list : [];
      pruneSelection();
      if (refs.errorHost) {
        clear(refs.errorHost);
        refs.errorHost.hidden = true;
      }
      updateUpdatedAt();
      renderAll();
      setRefreshBusy(false);
      return cameras;
    }).catch(function (err) {
      if (destroyed || token !== refreshToken) { return []; }
      setRefreshBusy(false);
      if (table && !cameras.length) { table.update({ loading: false }); }
      showLoadError(err);
      return [];
    });
  }

  function updateUpdatedAt() {
    if (!refs.updated) { return; }
    refs.updated.textContent = 'Cập nhật ' + fmt.time(new Date());
  }

  function pruneSelection() {
    var valid = {};
    cameras.forEach(function (cam) { valid[camKey(cam)] = true; });
    var next = new Set();
    selected.forEach(function (key) {
      if (valid[key]) { next.add(key); }
    });
    selected = next;
  }

  /* ---------------------------- Filtering ------------------------------ */

  function cameraHaystack(cam) {
    return fold([
      cam.name, cam.ip, cam.mac, cam.serial, cam.model,
      cam.group, cam.vendor, cam.vlan, cam.note
    ].join(' '));
  }

  function cameraMatches(cam) {
    if (filters.group && String(cam.group || '') !== filters.group) { return false; }
    if (filters.status && String(cam.status || 'unknown') !== filters.status) { return false; }
    if (filters.armed === 'yes' && !cam.alarm_armed) { return false; }
    if (filters.armed === 'no' && cam.alarm_armed) { return false; }
    var query = fold(filters.q).trim();
    if (query && cameraHaystack(cam).indexOf(query) === -1) { return false; }
    return true;
  }

  function timeValue(value) {
    if (!value) { return 0; }
    var text = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(text)) {
      text = text.replace(' ', 'T');
      if (/T\d{2}:\d{2}$/.test(text)) { text += ':00'; }
      text += '+07:00';
    }
    var time = Date.parse(text);
    return isFinite(time) ? time : 0;
  }

  function valueForSort(cam, key) {
    if (key === 'status') { return STATUS_ORDER[cam.status] === undefined ? 9 : STATUS_ORDER[cam.status]; }
    if (key === 'last_seen') { return timeValue(cam.last_seen); }
    if (key === 'alarm_armed') { return cam.alarm_armed ? 1 : 0; }
    if (key === 'ip') {
      return String(cam.ip || '').split('.').map(function (part) {
        return String(Number(part) || 0).padStart(3, '0');
      }).join('.');
    }
    return fold(cam[key]);
  }

  function sortCameras(list) {
    var key = sort.key;
    var dir = sort.dir === 'desc' ? -1 : 1;
    return list.slice().sort(function (a, b) {
      var av = valueForSort(a, key);
      var bv = valueForSort(b, key);
      var result;
      if (typeof av === 'number' && typeof bv === 'number') {
        result = av - bv;
      } else {
        result = String(av).localeCompare(String(bv), 'vi', { numeric: true, sensitivity: 'base' });
      }
      if (result === 0) { result = String(a.name || '').localeCompare(String(b.name || ''), 'vi'); }
      return result * dir;
    });
  }

  function filteredCameras() {
    return sortCameras(cameras.filter(cameraMatches));
  }

  /* ------------------------------ Rendering ---------------------------- */

  function updateGroupOptions() {
    if (!refs.groupField) { return; }
    var seen = {};
    cameras.forEach(function (cam) {
      var group = String(cam.group || '').trim();
      if (group) { seen[group] = true; }
    });
    var groups = Object.keys(seen).sort(function (a, b) { return a.localeCompare(b, 'vi'); });
    if (filters.group && !seen[filters.group]) { filters.group = ''; }
    var options = [{ value: '', label: 'Tất cả nhóm' }];
    groups.forEach(function (group) { options.push({ value: group, label: group }); });
    refs.groupField.setOptions(options, filters.group);
  }

  function updateEmptyHost(filteredTotal) {
    if (!emptyHost) { return; }
    clear(emptyHost);
    if (!cameras.length) {
      var actions = [];
      if (ctx && ctx.isAdmin) {
        actions.push(ui.button({
          label: 'Thêm camera',
          icon: 'plus',
          variant: 'primary',
          onClick: function () { openCameraModal(null); }
        }));
        actions.push(ui.button({
          label: 'Quét mạng',
          icon: 'scanner',
          variant: 'secondary',
          onClick: function () { if (ctx) { ctx.router.go('scanner'); } }
        }));
      }
      emptyHost.appendChild(ui.empty({
        icon: 'cameras',
        title: 'Chưa có camera nào trong NVR',
        description: ctx && ctx.isAdmin
          ? 'Thêm camera thủ công hoặc quét mạng nội bộ để đưa thiết bị vào danh sách quản lý.'
          : 'Chưa có camera nào được cấu hình. Liên hệ quản trị viên.',
        action: actions
      }));
      return;
    }
    emptyHost.appendChild(ui.empty({
      icon: 'search',
      title: 'Không có camera khớp bộ lọc',
      description: filteredTotal === 0 ? 'Thử xoá từ khoá hoặc chọn nhóm, trạng thái khác.' : ''
    }));
  }

  function updateSummary() {
    if (!refs.summary) { return; }
    var stats = { total: cameras.length, online: 0, offline: 0, attention: 0, armed: 0 };
    cameras.forEach(function (cam) {
      if (cam.status === 'online') { stats.online += 1; }
      else if (cam.status === 'offline') { stats.offline += 1; }
      else { stats.attention += 1; }
      if (cam.alarm_armed) { stats.armed += 1; }
    });
    refs.summary.textContent = 'Tổng ' + stats.total +
      ' · Trực tuyến ' + stats.online +
      ' · Ngoại tuyến ' + stats.offline +
      ' · Cần chú ý ' + stats.attention +
      ' · Đang gác ' + stats.armed;
  }

  function renderTable() {
    if (!table || !pagination) { return; }
    var list = filteredCameras();
    var total = list.length;
    var pages = Math.max(1, Math.ceil(total / pageSize));
    if (page > pages) { page = pages; }
    if (page < 1) { page = 1; }
    var start = (page - 1) * pageSize;
    var rows = list.slice(start, start + pageSize);
    currentRows = rows;
    updateEmptyHost(total);
    var selectedKeys = rows.filter(function (cam) {
      return selected.has(camKey(cam));
    }).map(camKey);
    table.update({
      rows: rows,
      loading: false,
      selectedKeys: selectedKeys,
      sort: { key: sort.key, dir: sort.dir }
    });
    pagination.setState({ page: page, pageSize: pageSize, total: total });
    updateSummary();
  }

  function renderAll() {
    updateGroupOptions();
    if (refs.groupField) { refs.groupField.setValue(filters.group); }
    updateBatchBar();
    renderTable();
  }

  /* ---------------------------- Table cells ---------------------------- */

  function nameCell(cam) {
    var wrap = el('div', { attrs: { title: cam.name || cam.ip } });
    wrap.appendChild(el('div', { class: 'u-truncate', text: cam.name || cam.ip || '—' }));
    var meta = [];
    if (cam.is_solar) { meta.push('Năng lượng mặt trời'); }
    if (cam.has_password === false) { meta.push('Chưa có mật khẩu'); }
    if (meta.length) {
      wrap.appendChild(el('div', { class: 'u-subtle', text: meta.join(' · ') }));
    }
    return wrap;
  }

  function ipCell(cam) {
    return el('span', { class: 'u-mono', text: cam.ip || '—' });
  }

  function groupCell(cam) {
    return cam.group ? el('span', { text: String(cam.group) }) : el('span', { class: 'u-subtle', text: '—' });
  }

  function modelCell(cam) {
    var wrap = el('div');
    wrap.appendChild(el('div', { text: cam.model || '—' }));
    if (cam.vendor) { wrap.appendChild(el('div', { class: 'u-subtle', text: String(cam.vendor) })); }
    return wrap;
  }

  function statusCell(cam) {
    var row = el('div', { class: 'c-row c-row--wrap' });
    row.appendChild(ui.statusPill(cam.status || 'unknown'));
    if (cam.is_solar) { row.appendChild(ui.badge('Solar', { tone: 'info' })); }
    return row;
  }

  function armedCell(cam) {
    if (!ctx || !ctx.isAdmin) {
      return ui.badge(cam.alarm_armed ? 'Đang gác' : 'Tắt gác', {
        tone: cam.alarm_armed ? 'success' : 'neutral'
      });
    }
    var control = ui.switch({
      checked: !!cam.alarm_armed,
      onChange: function (checked) { toggleCameraArm(cam, checked, control); }
    });
    control.input.setAttribute('aria-label', 'Gác an ninh cho ' + (cam.name || cam.ip));
    control.input.setAttribute('title', cam.alarm_armed ? 'Đang gác — bấm để tắt' : 'Đang tắt — bấm để bật gác');
    return control.el;
  }

  function lastSeenCell(cam) {
    if (!cam.last_seen) { return el('span', { class: 'u-subtle', text: '—' }); }
    return el('span', {
      class: 'u-nowrap',
      attrs: { title: fmt.dateTime(cam.last_seen) },
      text: fmt.relative(cam.last_seen)
    });
  }

  function actionCell(cam) {
    var row = el('div', { class: 'c-table__actions' });
    row.appendChild(ui.iconButton({
      icon: 'live',
      label: 'Xem trực tiếp ' + (cam.name || cam.ip),
      size: 'sm',
      onClick: function () { openLive(cam); }
    }));
    row.appendChild(ui.iconButton({
      icon: 'snapshot',
      label: 'Chụp ảnh ' + (cam.name || cam.ip),
      size: 'sm',
      onClick: function () { takeSnapshot(cam); }
    }));
    row.appendChild(ui.iconButton({
      icon: 'info',
      label: 'Chi tiết ' + (cam.name || cam.ip),
      size: 'sm',
      onClick: function () { openDetails(cam); }
    }));
    if (ctx && ctx.isAdmin) {
      row.appendChild(ui.iconButton({
        icon: 'edit',
        label: 'Sửa ' + (cam.name || cam.ip),
        size: 'sm',
        onClick: function () { openCameraModal(cam); }
      }));
      row.appendChild(ui.iconButton({
        icon: 'trash',
        label: 'Xoá ' + (cam.name || cam.ip),
        size: 'sm',
        onClick: function () { removeCamera(cam); }
      }));
    }
    return row;
  }

  function buildTableColumns() {
    return [
      { key: 'name', label: 'Tên', sortable: true, render: nameCell },
      { key: 'ip', label: 'IP', sortable: true, mono: true, render: ipCell },
      { key: 'group', label: 'Nhóm', sortable: true, render: groupCell },
      { key: 'model', label: 'Model', sortable: true, render: modelCell },
      { key: 'status', label: 'Trạng thái', sortable: true, render: statusCell },
      { key: 'alarm_armed', label: 'Gác', sortable: true, align: 'center', render: armedCell },
      { key: 'last_seen', label: 'Lần thấy cuối', sortable: true, render: lastSeenCell },
      { key: 'actions', label: 'Hành động', align: 'right', render: actionCell }
    ];
  }

  function createTable() {
    emptyHost = el('div');
    table = ui.table({
      columns: buildTableColumns(),
      rows: [],
      loading: true,
      selectable: !!(ctx && ctx.isAdmin),
      rowKey: function (cam) { return camKey(cam); },
      mobile: 'cards',
      caption: 'Danh sách camera đã quản lý',
      testId: 'cameras-table',
      sort: { key: sort.key, dir: sort.dir },
      emptyNode: emptyHost,
      onSort: function (key, dir) {
        sort = { key: key, dir: dir };
        page = 1;
        renderTable();
      },
      onRowClick: function (cam) { openDetails(cam); },
      onSelectionChange: function (keys) {
        var pageKeys = {};
        currentRows.forEach(function (cam) { pageKeys[camKey(cam)] = true; });
        keys.forEach(function (key) {
          var text = String(key);
          if (pageKeys[text]) { selected.add(text); }
        });
        Object.keys(pageKeys).forEach(function (key) {
          if (keys.indexOf(key) === -1) { selected.delete(key); }
        });
        updateBatchBar();
      }
    });
    refs.tableHost.appendChild(table.el);
  }

  /* --------------------------- Selection UI ---------------------------- */

  function selectedCameras() {
    var list = [];
    cameras.forEach(function (cam) {
      if (selected.has(camKey(cam))) { list.push(cam); }
    });
    return list;
  }

  function updateBatchBar() {
    if (!refs.batchBar) { return; }
    if (!ctx || !ctx.isAdmin) {
      refs.batchBar.hidden = true;
      return;
    }
    var count = selected.size;
    refs.batchBar.hidden = count === 0;
    if (refs.batchCount) {
      refs.batchCount.textContent = 'Đã chọn ' + count + ' camera';
    }
  }

  function clearSelection() {
    selected = new Set();
    updateBatchBar();
    renderTable();
  }

  /* --------------------------- Row operations -------------------------- */

  function toggleCameraArm(cam, checked, control) {
    if (!ctx || !ctx.isAdmin) { return; }
    control.setDisabled(true);
    ctx.api.post('/api/managed/cameras/toggle-alarm', {
      id: cam.id || cam.ip,
      state: !!checked
    }, { signal: ctx.signal, silent: true }).then(function (data) {
      if (destroyed) { return; }
      cam.alarm_armed = !!(data && data.alarm_armed);
      control.setChecked(cam.alarm_armed);
      control.input.setAttribute('title', cam.alarm_armed ? 'Đang gác — bấm để tắt' : 'Đang tắt — bấm để bật gác');
      control.setDisabled(false);
      updateSummary();
    }).catch(function (err) {
      if (destroyed) { return; }
      control.setChecked(!checked);
      control.setDisabled(false);
      showApiError(err, 'Không cập nhật được trạng thái gác.');
    });
  }

  function takeSnapshot(cam) {
    if (!ctx) { return; }
    CCTV.media.snapshot(cam.ip, { signal: ctx.signal, silent: true }).then(function (result) {
      CCTV.media.revoke(result.url);
      if (destroyed) { return; }
      ui.toast('Đã lưu ảnh ' + result.filename + '.', { type: 'success' });
    }).catch(function (err) {
      if (!err || err.code === 'ABORTED') { return; }
      var message = err.code === 'TEST_MODE_BLOCKED'
        ? 'Chế độ kiểm thử không chụp ảnh camera thật.'
        : (err.message || 'Không chụp được ảnh.');
      ui.toast(message, { type: err.code === 'TEST_MODE_BLOCKED' ? 'warning' : 'error' });
    });
  }

  function removeCamera(cam) {
    if (!ctx || !ctx.isAdmin) { return; }
    ctx.confirm({
      title: 'Xoá camera khỏi NVR',
      message: 'Camera "' + (cam.name || cam.ip) + '" sẽ bị xoá khỏi danh sách quản lý.',
      details: 'File ghi hình trên máy chủ không bị xoá. Thiết bị camera không bị thay đổi.',
      confirmLabel: 'Xoá camera',
      cancelLabel: 'Huỷ',
      variant: 'danger'
    }).then(function (confirmed) {
      if (!confirmed || !ctx) { return null; }
      return ctx.api.del('/api/managed/cameras/' + encodeURIComponent(cam.id || cam.ip), { confirm: true }, {
        signal: ctx.signal,
        silent: true
      }).then(function (data) {
        if (destroyed) { return; }
        ui.toast((data && data.message) || 'Đã xoá camera.', { type: 'success' });
        selected.delete(camKey(cam));
        loadCameras(false);
      });
    }).catch(function (err) { showApiError(err, 'Không xoá được camera.'); });
  }

  /* ------------------------ Add / edit dialog -------------------------- */

  function fieldValueTrim(field) {
    return String(field.getValue() || '').trim();
  }

  function openCameraModal(camera) {
    if (!ctx || !ctx.isAdmin) { return; }
    var isEdit = !!camera;
    var modalClosed = false;
    var body = el('div', { class: 'c-stack' });
    var grid = el('div', { class: 'c-grid c-grid--2' });

    var fName = ui.field({
      label: 'Tên camera',
      value: isEdit ? (camera.name || '') : '',
      required: true,
      maxlength: 64,
      placeholder: 'Ví dụ: Cổng chính'
    });
    var fGroup = ui.field({
      label: 'Nhóm',
      value: isEdit ? (camera.group || '') : '',
      maxlength: 32,
      placeholder: 'Mặc định'
    });
    var fVendor = ui.field({
      label: 'Hãng',
      value: isEdit ? (camera.vendor || '') : 'Dahua/Imou',
      maxlength: 32,
      placeholder: 'Dahua/Imou, Hikvision, ONVIF…'
    });
    var fModel = ui.field({
      label: 'Model (tuỳ chọn)',
      value: isEdit ? (camera.model || '') : '',
      maxlength: 64,
      placeholder: 'IPC-HFW…'
    });
    var fIp = ui.field({
      label: 'Địa chỉ IP',
      value: isEdit ? (camera.ip || '') : '',
      required: true,
      mono: true,
      placeholder: '192.168.1.108',
      help: 'Chỉ IPv4 nội bộ (10/8, 172.16/12, 192.168/16, 127/8).'
    });
    var fHttp = ui.field({ label: 'Cổng HTTP', type: 'number', min: 1, max: 65535, value: isEdit ? camera.http_port : 80 });
    var fTcp = ui.field({ label: 'Cổng TCP', type: 'number', min: 1, max: 65535, value: isEdit ? camera.tcp_port : 37777 });
    var fRtsp = ui.field({ label: 'Cổng RTSP', type: 'number', min: 1, max: 65535, value: isEdit ? camera.rtsp_port : 554 });
    var fUser = ui.field({
      label: 'Tên đăng nhập',
      value: isEdit ? (camera.username || 'admin') : 'admin',
      maxlength: 64,
      autocomplete: 'off',
      placeholder: 'admin'
    });
    var fPassword = ui.field({
      label: isEdit ? 'Mật khẩu mới (tuỳ chọn)' : 'Mật khẩu camera',
      type: 'password',
      value: '',
      maxlength: 128,
      autocomplete: 'new-password',
      help: isEdit
        ? 'Để trống để giữ nguyên mật khẩu hiện tại. Mật khẩu không bao giờ được hiển thị lại.'
        : 'Mật khẩu chỉ gửi một lần, không được lưu trong trình duyệt.'
    });
    var fRtspPath = ui.field({
      label: 'Đường dẫn RTSP (tuỳ chọn)',
      value: isEdit ? (camera.rtsp_path || '') : '',
      maxlength: 200,
      mono: true,
      placeholder: '/cam/realmonitor?channel=1&subtype=0',
      help: 'Để trống để máy chủ tự chọn theo hãng.'
    });
    var fNote = ui.field({
      label: 'Ghi chú',
      type: 'textarea',
      value: isEdit ? (camera.note || '') : '',
      maxlength: 500,
      placeholder: 'Vị trí lắp đặt, người phụ trách…'
    });
    var armSwitch = ui.switch({
      checked: isEdit ? !!camera.alarm_armed : true,
      label: 'Gác an ninh',
      description: 'Nhận cảnh báo khi camera phát hiện chuyển động.'
    });

    [
      fName, fGroup, fVendor, fModel, fIp, fHttp, fTcp, fRtsp, fUser, fPassword, fRtspPath
    ].forEach(function (field) { grid.appendChild(field.el); });

    body.appendChild(grid);
    body.appendChild(fNote.el);
    body.appendChild(armSwitch.el);

    var testResult = el('div', { class: 'u-mt-8' });
    body.appendChild(testResult);

    var cancelBtn = ui.button({
      label: 'Huỷ',
      variant: 'secondary',
      onClick: function () { modal.close(); }
    });
    var testBtn = ui.button({
      label: 'Kiểm tra kết nối',
      icon: 'activity',
      variant: 'secondary',
      onClick: function () { runConnectionTest(); }
    });
    var saveBtn = ui.button({
      label: isEdit ? 'Lưu thay đổi' : 'Thêm camera',
      icon: isEdit ? 'check' : 'plus',
      variant: 'primary',
      onClick: function () { submit(); }
    });

    var modal = ui.modal({
      title: isEdit ? 'Sửa camera' : 'Thêm camera',
      subtitle: isEdit ? 'Cập nhật cấu hình đã lưu cho ' + (camera.name || camera.ip) : 'Camera chỉ được thêm vào NVR nội bộ',
      body: body,
      footer: [cancelBtn, testBtn, saveBtn],
      size: 'lg',
      dismissible: true,
      initialFocus: fName.input,
      dirtyCheck: function () { return isDirty(); },
      onClose: function () {
        modalClosed = true;
        fPassword.setValue('');
      }
    });
    openLayers.push(modal);

    var initialValues = currentValues();

    function currentValues() {
      return {
        name: fieldValueTrim(fName),
        group: fieldValueTrim(fGroup),
        vendor: fieldValueTrim(fVendor),
        model: fieldValueTrim(fModel),
        ip: fieldValueTrim(fIp),
        http_port: fieldValueTrim(fHttp),
        tcp_port: fieldValueTrim(fTcp),
        rtsp_port: fieldValueTrim(fRtsp),
        username: fieldValueTrim(fUser),
        rtsp_path: fieldValueTrim(fRtspPath),
        note: fieldValueTrim(fNote),
        alarm_armed: armSwitch.isChecked()
      };
    }

    function isDirty() {
      if (fieldValueTrim(fPassword)) { return true; }
      var current = currentValues();
      var keys = Object.keys(initialValues);
      for (var i = 0; i < keys.length; i += 1) {
        if (current[keys[i]] !== initialValues[keys[i]]) { return true; }
      }
      return false;
    }

    function clearFormErrors() {
      [fName, fGroup, fVendor, fModel, fIp, fHttp, fTcp, fRtsp, fUser, fPassword, fRtspPath, fNote].forEach(function (field) {
        field.clearError();
      });
    }

    function validateForm() {
      clearFormErrors();
      var ok = true;
      if (!fieldValueTrim(fName)) {
        fName.setError('Vui lòng nhập tên camera.');
        ok = false;
      }
      if (!isPrivateIPv4(fieldValueTrim(fIp))) {
        fIp.setError('Địa chỉ IP phải là IPv4 nội bộ hợp lệ.');
        ok = false;
      }
      var httpPort = parseInt(fieldValueTrim(fHttp), 10);
      var tcpPort = parseInt(fieldValueTrim(fTcp), 10);
      var rtspPort = parseInt(fieldValueTrim(fRtsp), 10);
      if (!(httpPort >= 1 && httpPort <= 65535)) {
        fHttp.setError('Cổng HTTP phải trong khoảng 1–65535.');
        ok = false;
      }
      if (!(tcpPort >= 1 && tcpPort <= 65535)) {
        fTcp.setError('Cổng TCP phải trong khoảng 1–65535.');
        ok = false;
      }
      if (!(rtspPort >= 1 && rtspPort <= 65535)) {
        fRtsp.setError('Cổng RTSP phải trong khoảng 1–65535.');
        ok = false;
      }
      var rtspPath = fieldValueTrim(fRtspPath);
      if (rtspPath && rtspPath.charAt(0) !== '/') {
        fRtspPath.setError('Đường dẫn RTSP phải bắt đầu bằng "/".');
        ok = false;
      }
      if (!ok) { return false; }
      return true;
    }

    function showTestResult(tone, title, message) {
      if (modalClosed || !testResult.isConnected) { return; }
      clear(testResult);
      testResult.appendChild(ui.banner({ tone: tone, title: title, message: message }));
    }

    function runConnectionTest() {
      if (modalClosed) { return; }
      var ip = fieldValueTrim(fIp);
      fIp.clearError();
      if (!isPrivateIPv4(ip)) {
        fIp.setError('Địa chỉ IP phải là IPv4 nội bộ hợp lệ.');
        fIp.focus();
        return;
      }
      var port = toPort(fieldValueTrim(fHttp), 80);
      ui.busy(testBtn, true, 'Đang kiểm tra…');
      ctx.api.post('/api/managed/cameras/test', {
        ip: ip,
        port: port,
        username: fieldValueTrim(fUser) || 'admin',
        password: fieldValueTrim(fPassword)
      }, { signal: ctx.signal, silent: true, timeoutMs: 20000 }).then(function (data) {
        if (modalClosed) { return; }
        var ping = data && typeof data.ping_ms === 'number' ? ' · ' + fmt.number(data.ping_ms) + ' ms' : '';
        if (data && data.auth_ok) {
          var extras = [];
          if (data.model) { extras.push('Model ' + data.model); }
          if (data.serial) { extras.push('Serial ' + data.serial); }
          if (data.firmware) { extras.push('Firmware ' + data.firmware); }
          showTestResult('success', 'Kết nối và xác thực thành công' + ping,
            extras.length ? extras.join(' · ') : (data.message || ''));
        } else {
          showTestResult('warning', 'Kết nối được nhưng xác thực thất bại' + ping,
            (data && data.message) || 'Kiểm tra lại tên đăng nhập và mật khẩu camera.');
        }
      }).catch(function (err) {
        if (!err || err.code === 'ABORTED' || modalClosed) { return; }
        if (err.code === 'TEST_MODE_BLOCKED') {
          showTestResult('warning', 'Chế độ kiểm thử', 'Máy chủ không cho phép kiểm tra kết nối camera thật trong chế độ kiểm thử.');
        } else if (err.code === 'CAMERA_CREDENTIAL_REQUIRED') {
          showTestResult('warning', 'Thiếu mật khẩu camera', 'Nhập mật khẩu camera hoặc lưu credential tạm trước khi kiểm tra.');
        } else {
          showTestResult('danger', 'Không kiểm tra được kết nối', errorDetail(err));
        }
      }).then(function () {
        ui.busy(testBtn, false);
      });
    }

    function submit() {
      if (modalClosed) { return; }
      if (!validateForm()) { return; }
      var payload = {
        name: fieldValueTrim(fName),
        group: fieldValueTrim(fGroup),
        vendor: fieldValueTrim(fVendor) || 'Dahua/Imou',
        model: fieldValueTrim(fModel),
        ip: fieldValueTrim(fIp),
        http_port: parseInt(fieldValueTrim(fHttp), 10),
        tcp_port: parseInt(fieldValueTrim(fTcp), 10),
        rtsp_port: parseInt(fieldValueTrim(fRtsp), 10),
        username: fieldValueTrim(fUser) || 'admin',
        rtsp_path: fieldValueTrim(fRtspPath),
        note: fieldValueTrim(fNote),
        alarm_armed: armSwitch.isChecked()
      };
      var password = fieldValueTrim(fPassword);
      if (password) { payload.password = password; }
      modal.setError('');
      modal.setBusy(true);
      var path = isEdit
        ? '/api/managed/cameras/' + encodeURIComponent(camera.id || camera.ip)
        : '/api/managed/cameras';
      var request = isEdit ? ctx.api.put(path, payload, { signal: ctx.signal, silent: true })
        : ctx.api.post(path, payload, { signal: ctx.signal, silent: true });
      request.then(function (data) {
        if (destroyed || modalClosed) { return; }
        fPassword.setValue('');
        modal.close();
        ui.toast((data && data.message) || (isEdit ? 'Đã cập nhật camera.' : 'Đã thêm camera.'), { type: 'success' });
        loadCameras(false);
      }).catch(function (err) {
        if (modalClosed || destroyed) { return; }
        modal.setBusy(false);
        if (err && err.code === 'ABORTED') { return; }
        modal.setError(err && err.message ? err.message : 'Không lưu được camera.');
        if (err && err.code === 'INVALID_IP') { fIp.setError(err.message); }
        if (err && err.code === 'CAMERA_PASSWORD_REQUIRED') { fPassword.setError('Cần nhập mật khẩu camera hoặc đặt mật khẩu mặc định trên máy chủ.'); }
      });
    }
  }

  /* ------------------------- Batch operations -------------------------- */

  function runSequential(items, worker) {
    var results = [];
    var chain = Promise.resolve();
    items.forEach(function (item) {
      chain = chain.then(function () {
        return worker(item).then(function (result) {
          results.push(result);
        }, function (err) {
          if (err && err.code === 'ABORTED') { throw err; }
          results.push({
            ok: false,
            ip: item.ip,
            error: err && err.message ? err.message : 'Lỗi không xác định.'
          });
        });
      });
    });
    return chain.then(function () { return results; }, function (err) {
      if (err && err.code === 'ABORTED') { return results; }
      throw err;
    });
  }

  function failureList(failures) {
    var list = el('ul', { class: 'c-stack c-stack--sm' });
    failures.slice(0, 30).forEach(function (item) {
      list.appendChild(el('li', {
        text: (item.ip || '—') + ': ' + (item.error || item.message || 'Thất bại')
      }));
    });
    if (failures.length > 30) {
      list.appendChild(el('li', { class: 'u-muted', text: '… và ' + (failures.length - 30) + ' mục khác.' }));
    }
    return list;
  }

  function showBatchFailures(title, summary, failures) {
    var body = el('div', { class: 'c-stack' });
    body.appendChild(el('p', { text: summary }));
    body.appendChild(ui.banner({
      tone: 'warning',
      title: failures.length + ' camera thất bại',
      message: 'Chi tiết lỗi bên dưới. Không có mật khẩu nào được hiển thị.'
    }));
    body.appendChild(failureList(failures));
    var handle = ui.modal({
      title: title,
      body: body,
      size: 'md',
      dismissible: true,
      footer: [ui.button({ label: 'Đóng', variant: 'secondary', onClick: function () { handle.close(); } })]
    });
    openLayers.push(handle);
  }

  function reportBatch(verb, data) {
    if (!data) { return; }
    var results = Array.isArray(data.results) ? data.results : [];
    var total = Number(data.total);
    if (!isFinite(total)) { total = results.length; }
    var success = Number(data.success_count);
    if (!isFinite(success)) {
      success = results.filter(function (item) { return item && item.ok; }).length;
    }
    var failures = results.filter(function (item) { return item && item.ok === false; });
    var message = success + '/' + total + ' camera ' + verb + ' thành công.';
    if (failures.length) {
      showBatchFailures('Kết quả ' + verb, message, failures);
    } else {
      ui.toast(message, { type: 'success' });
    }
  }

  function syncHealth(button) {
    if (!ctx) { return; }
    if (button) { ui.busy(button, true); }
    ctx.api.post('/api/managed/cameras/sync', {}, { signal: ctx.signal, silent: true }).then(function (data) {
      if (destroyed) { return; }
      ui.toast('Đã đồng bộ sức khoẻ ' + (data && data.count !== undefined ? data.count : '') + ' camera.', { type: 'success' });
      loadCameras(false);
    }).catch(function (err) {
      if (err && (err.status === 403 || err.status === 429 || err.code === 'TEST_MODE_BLOCKED')) {
        showApiError(err, 'Không đồng bộ được sức khoẻ camera.');
        return;
      }
      showApiError(err, 'Không đồng bộ được sức khoẻ camera.');
    }).then(function () {
      if (button) { ui.busy(button, false); }
    });
  }

  function rebootCameras(list, button) {
    var ips = list.map(function (cam) { return cam.ip; });
    var details = el('div', { class: 'c-stack c-stack--sm' });
    details.appendChild(el('p', { class: 'c-muted-block', text: ips.join(', ') }));
    details.appendChild(el('p', { class: 'c-muted-block', text: 'Camera sẽ mất kết nối trong vài phút. Không thao tác trên thiết bị cho tới khi trực tuyến lại.' }));
    ctx.confirm({
      title: 'Khởi động lại camera',
      message: 'Khởi động lại ' + ips.length + ' camera đã chọn?',
      details: details,
      confirmLabel: 'Khởi động lại',
      cancelLabel: 'Huỷ',
      variant: 'danger',
      requireText: 'REBOOT',
      requireTextLabel: 'Gõ REBOOT để xác nhận'
    }).then(function (confirmed) {
      if (!confirmed || !ctx) { return null; }
      if (button) { ui.busy(button, true, 'Đang gửi…'); }
      return ctx.api.post('/api/reboot', { ips: ips, confirm: true }, {
        signal: ctx.signal,
        silent: true
      }).then(function (data) {
        if (destroyed) { return; }
        reportBatch('khởi động lại', data);
        loadCameras(false);
      }).catch(function (err) {
        showApiError(err, 'Không gửi được lệnh khởi động lại.');
      }).then(function () {
        if (button) { ui.busy(button, false); }
      });
    });
  }

  function openBatchIpModal(button) {
    var list = selectedCameras();
    if (!list.length) { return; }
    var modalClosed = false;
    var body = el('div', { class: 'c-stack' });
    body.appendChild(ui.banner({
      tone: 'warning',
      title: 'Đổi địa chỉ IP hàng loạt',
      message: 'Áp dụng cho ' + list.length + ' camera: ' + list.map(function (cam) { return cam.ip; }).join(', ') + '. Camera có thể mất kết nối sau khi đổi IP.'
    }));

    var fMode = ui.field({
      label: 'Chế độ địa chỉ',
      type: 'select',
      options: [
        { value: 'static', label: 'IP tĩnh' },
        { value: 'dhcp', label: 'DHCP (tự động)' }
      ],
      value: 'static'
    });
    var fStart = ui.field({
      label: 'IP bắt đầu',
      mono: true,
      placeholder: '192.168.1.200',
      help: 'Máy chủ cấp IP tuần tự từ địa chỉ này.'
    });
    var fNetmask = ui.field({
      label: 'Subnet mask',
      mono: true,
      value: '255.255.255.0'
    });
    var fGateway = ui.field({
      label: 'Gateway (tuỳ chọn)',
      mono: true,
      placeholder: '192.168.1.1'
    });
    var autoReboot = ui.switch({
      checked: false,
      label: 'Tự khởi động lại sau khi đổi IP',
      description: 'Chỉ áp dụng cho các camera đổi IP thành công.'
    });
    var fConfirm = ui.field({
      label: 'Gõ DOI-IP để xác nhận',
      mono: true,
      maxlength: 16,
      autocomplete: 'off'
    });

    var grid = el('div', { class: 'c-grid c-grid--2' });
    grid.appendChild(fMode.el);
    grid.appendChild(fStart.el);
    grid.appendChild(fNetmask.el);
    grid.appendChild(fGateway.el);
    body.appendChild(grid);
    body.appendChild(autoReboot.el);
    body.appendChild(fConfirm.el);

    var cancelBtn = ui.button({ label: 'Huỷ', variant: 'secondary', onClick: function () { modal.close(); } });
    var saveBtn = ui.button({
      label: 'Đổi IP',
      icon: 'network',
      variant: 'primary',
      disabled: true,
      onClick: function () { submit(); }
    });

    var modal = ui.modal({
      title: 'Đổi IP camera',
      subtitle: list.length + ' camera được chọn',
      body: body,
      footer: [cancelBtn, saveBtn],
      size: 'lg',
      dismissible: true,
      initialFocus: fStart.input,
      onClose: function () { modalClosed = true; }
    });
    openLayers.push(modal);
    if (button) { ui.busy(button, false); }

    function syncMode() {
      var staticMode = fMode.getValue() === 'static';
      fStart.setDisabled(!staticMode);
      fNetmask.setDisabled(!staticMode);
      fGateway.setDisabled(!staticMode);
    }
    fMode.input.addEventListener('change', syncMode);
    syncMode();

    fConfirm.input.addEventListener('input', function () {
      saveBtn.disabled = fieldValueTrim(fConfirm) !== 'DOI-IP';
    });

    function submit() {
      if (modalClosed) { return; }
      var staticMode = fMode.getValue() === 'static';
      [fStart, fNetmask, fGateway].forEach(function (field) { field.clearError(); });
      var ok = true;
      if (staticMode) {
        if (!isPrivateIPv4(fieldValueTrim(fStart))) {
          fStart.setError('IP bắt đầu phải là IPv4 nội bộ hợp lệ.');
          ok = false;
        }
        if (!isValidIPv4(fieldValueTrim(fNetmask))) {
          fNetmask.setError('Subnet mask không hợp lệ.');
          ok = false;
        }
        if (fieldValueTrim(fGateway) && !isPrivateIPv4(fieldValueTrim(fGateway))) {
          fGateway.setError('Gateway phải là IPv4 nội bộ hợp lệ.');
          ok = false;
        }
      }
      if (!ok) { return; }
      if (fieldValueTrim(fConfirm) !== 'DOI-IP') {
        fConfirm.setError('Gõ đúng DOI-IP để xác nhận.');
        return;
      }
      saveBtn.disabled = true;
      modal.setError('');
      var payload = {
        ips: list.map(function (cam) { return cam.ip; }),
        is_dhcp: !staticMode,
        start_ip: staticMode ? fieldValueTrim(fStart) : '',
        netmask: staticMode ? fieldValueTrim(fNetmask) : '255.255.255.0',
        gateway: staticMode ? fieldValueTrim(fGateway) : '',
        auto_reboot: autoReboot.isChecked(),
        confirm: true
      };
      ctx.api.post('/api/batch-ip', payload, { signal: ctx.signal, silent: true, timeoutMs: 120000 }).then(function (data) {
        if (destroyed) { return; }
        modal.close();
        reportBatch('đổi IP', data);
        loadCameras(false);
      }).catch(function (err) {
        if (modalClosed || destroyed) { return; }
        saveBtn.disabled = fieldValueTrim(fConfirm) !== 'DOI-IP';
        if (err && err.code === 'ABORTED') { return; }
        modal.setError(err && err.message ? err.message : 'Không đổi được IP camera.');
      });
    }
  }

  function openBatchPasswordModal(button) {
    var list = selectedCameras();
    if (!list.length) { return; }
    var modalClosed = false;
    var body = el('div', { class: 'c-stack' });
    body.appendChild(ui.banner({
      tone: 'warning',
      title: 'Đổi mật khẩu camera hàng loạt',
      message: 'Áp dụng cho ' + list.length + ' camera. Mật khẩu mới không bao giờ được hiển thị lại.'
    }));

    var fNew = ui.field({
      label: 'Mật khẩu mới',
      type: 'password',
      maxlength: 128,
      autocomplete: 'new-password',
      help: 'Tối thiểu 8 ký tự, không dùng mật khẩu phổ biến.'
    });
    var fConfirmNew = ui.field({
      label: 'Nhập lại mật khẩu mới',
      type: 'password',
      maxlength: 128,
      autocomplete: 'new-password'
    });
    var fOld = ui.field({
      label: 'Mật khẩu hiện tại (tuỳ chọn)',
      type: 'password',
      maxlength: 128,
      autocomplete: 'current-password',
      help: 'Để trống để máy chủ dùng mật khẩu đã lưu cho từng camera.'
    });
    var fConfirm = ui.field({
      label: 'Gõ DOI-MAT-KHAU để xác nhận',
      mono: true,
      maxlength: 24,
      autocomplete: 'off'
    });

    var grid = el('div', { class: 'c-grid c-grid--2' });
    grid.appendChild(fNew.el);
    grid.appendChild(fConfirmNew.el);
    body.appendChild(grid);
    body.appendChild(fOld.el);
    body.appendChild(fConfirm.el);

    var cancelBtn = ui.button({ label: 'Huỷ', variant: 'secondary', onClick: function () { modal.close(); } });
    var saveBtn = ui.button({
      label: 'Đổi mật khẩu',
      icon: 'key',
      variant: 'primary',
      disabled: true,
      onClick: function () { submit(); }
    });

    var modal = ui.modal({
      title: 'Đổi mật khẩu camera',
      subtitle: list.length + ' camera được chọn',
      body: body,
      footer: [cancelBtn, saveBtn],
      size: 'lg',
      dismissible: true,
      initialFocus: fNew.input,
      onClose: function () {
        modalClosed = true;
        fNew.setValue('');
        fConfirmNew.setValue('');
        fOld.setValue('');
      }
    });
    openLayers.push(modal);
    if (button) { ui.busy(button, false); }

    fConfirm.input.addEventListener('input', function () {
      saveBtn.disabled = fieldValueTrim(fConfirm) !== 'DOI-MAT-KHAU';
    });

    function submit() {
      if (modalClosed) { return; }
      fNew.clearError();
      fConfirmNew.clearError();
      fOld.clearError();
      var password = fNew.getValue();
      var confirmation = fConfirmNew.getValue();
      var ok = true;
      if (password.length < 8) {
        fNew.setError('Mật khẩu mới phải có ít nhất 8 ký tự.');
        ok = false;
      }
      if (password !== confirmation) {
        fConfirmNew.setError('Mật khẩu nhập lại không khớp.');
        ok = false;
      }
      if (fOld.getValue() && fOld.getValue() === password) {
        fNew.setError('Mật khẩu mới phải khác mật khẩu hiện tại.');
        ok = false;
      }
      if (fieldValueTrim(fConfirm) !== 'DOI-MAT-KHAU') {
        fConfirm.setError('Gõ đúng DOI-MAT-KHAU để xác nhận.');
        ok = false;
      }
      if (!ok) { return; }
      saveBtn.disabled = true;
      modal.setError('');
      ctx.api.post('/api/batch_change_password', {
        ips: list.map(function (cam) { return cam.ip; }),
        old_password: fOld.getValue(),
        new_password: password,
        confirm: true
      }, { signal: ctx.signal, silent: true, timeoutMs: 120000 }).then(function (data) {
        if (destroyed) { return; }
        fNew.setValue('');
        fConfirmNew.setValue('');
        fOld.setValue('');
        modal.close();
        var results = Array.isArray(data && data.results) ? data.results : [];
        var success = Number(data && data.success_count);
        if (!isFinite(success)) { success = results.filter(function (item) { return item && item.ok; }).length; }
        var total = Number(data && data.total);
        if (!isFinite(total)) { total = results.length; }
        var failures = results.filter(function (item) { return item && item.ok === false; });
        if (failures.length) {
          showBatchFailures('Kết quả đổi mật khẩu', success + '/' + total + ' camera đổi mật khẩu thành công.', failures);
        } else {
          ui.toast(success + '/' + total + ' camera đổi mật khẩu thành công.', { type: 'success' });
        }
        loadCameras(false);
      }).catch(function (err) {
        if (modalClosed || destroyed) { return; }
        saveBtn.disabled = fieldValueTrim(fConfirm) !== 'DOI-MAT-KHAU';
        if (err && err.code === 'ABORTED') { return; }
        modal.setError(err && err.message ? err.message : 'Không đổi được mật khẩu camera.');
      });
    }
  }

  function syncTimeSelection(button) {
    var list = selectedCameras();
    if (!list.length) { return; }
    ctx.confirm({
      title: 'Đồng bộ giờ camera',
      message: 'Đồng bộ giờ cho ' + list.length + ' camera theo múi giờ GMT+07:00?',
      confirmLabel: 'Đồng bộ giờ',
      cancelLabel: 'Huỷ'
    }).then(function (confirmed) {
      if (!confirmed || !ctx) { return null; }
      if (button) { ui.busy(button, true, 'Đang gửi…'); }
      return ctx.api.post('/api/sync-time', {
        ips: list.map(function (cam) { return cam.ip; }),
        timezone: 'GMT+07:00'
      }, { signal: ctx.signal, silent: true, timeoutMs: 120000 }).then(function (data) {
        if (destroyed) { return; }
        reportBatch('đồng bộ giờ', data);
      }).catch(function (err) {
        showApiError(err, 'Không đồng bộ được giờ camera.');
      }).then(function () {
        if (button) { ui.busy(button, false); }
      });
    });
  }

  function setArmedSelection(armed, button) {
    var list = selectedCameras();
    if (!list.length) { return; }
    ctx.confirm({
      title: armed ? 'Bật gác an ninh' : 'Tắt gác an ninh',
      message: (armed ? 'Bật' : 'Tắt') + ' gác an ninh cho ' + list.length + ' camera đã chọn?',
      details: armed ? 'Camera sẽ gửi cảnh báo theo cấu hình Telegram và lịch gác.' : 'Camera sẽ không gửi cảnh báo cho tới khi bật lại.',
      confirmLabel: armed ? 'Bật gác' : 'Tắt gác',
      cancelLabel: 'Huỷ',
      variant: armed ? 'primary' : 'danger'
    }).then(function (confirmed) {
      if (!confirmed || !ctx) { return null; }
      if (button) { ui.busy(button, true, 'Đang áp dụng…'); }
      return runSequential(list, function (cam) {
        return ctx.api.post('/api/managed/cameras/toggle-alarm', {
          id: cam.id || cam.ip,
          state: !!armed
        }, { signal: ctx.signal, silent: true }).then(function (data) {
          cam.alarm_armed = !!(data && data.alarm_armed);
          return { ok: true, ip: cam.ip };
        });
      }).then(function (results) {
        if (destroyed) { return; }
        var failures = results.filter(function (item) { return !item.ok; });
        var success = results.length - failures.length;
        if (failures.length) {
          showBatchFailures('Kết quả cập nhật gác', success + '/' + results.length + ' camera cập nhật thành công.', failures);
        } else {
          ui.toast(success + '/' + results.length + ' camera đã ' + (armed ? 'bật' : 'tắt') + ' gác.', { type: 'success' });
        }
        renderAll();
      }).catch(function (err) {
        showApiError(err, 'Không cập nhật được trạng thái gác.');
      }).then(function () {
        if (button) { ui.busy(button, false); }
      });
    });
  }

  /* ------------------------- Camera detail drawer ---------------------- */

  function openDetails(camera) {
    if (!ctx || !camera) { return; }
    var controller = new AbortController();
    var detailState = { data: null, error: null, loading: false };
    var hardwareState = { data: null, error: null, loading: false, loaded: false };
    var storageState = {
      info: null, infoError: null, infoLoading: false,
      clips: null, clipsError: null, clipsLoading: false,
      date: todayString(), clipsLoaded: false
    };
    var drawerClosed = false;
    var clipsTable = null;

    var body = el('div', { class: 'c-stack' });

    var head = el('div', { class: 'c-card' });
    var headBody = el('div', { class: 'c-card__body c-row c-row--wrap' });
    headBody.appendChild(ui.statusPill(camera.status || 'unknown'));
    headBody.appendChild(ui.badge(camera.alarm_armed ? 'Đang gác' : 'Tắt gác', {
      tone: camera.alarm_armed ? 'success' : 'neutral'
    }));
    if (camera.is_solar) { headBody.appendChild(ui.badge('Năng lượng mặt trời', { tone: 'info' })); }
    if (camera.has_password === false && ctx.isAdmin) {
      headBody.appendChild(ui.badge('Chưa cấu hình mật khẩu', { tone: 'warning' }));
    }
    headBody.appendChild(el('span', {
      class: 'u-muted u-tabular',
      text: 'Cập nhật ' + fmt.relative(camera.last_seen)
    }));
    head.appendChild(headBody);
    body.appendChild(head);

    var tabController = ui.tabs({
      tabs: [
        { id: 'info', label: 'Thông tin', icon: 'info' },
        { id: 'network', label: 'Mạng', icon: 'network' },
        { id: 'hardware', label: 'Phần cứng', icon: 'cpu' },
        { id: 'storage', label: 'Thẻ nhớ', icon: 'sd-card' }
      ],
      active: 'info',
      label: 'Chi tiết camera',
      onChange: function (id) { activateTab(id); }
    });
    var tabButtons = tabController.el.querySelectorAll('.c-tab');
    ['info', 'network', 'hardware', 'storage'].forEach(function (id, index) {
      if (tabButtons[index]) { tabButtons[index].setAttribute('data-testid', 'cameras-tab-' + id); }
    });

    var panels = {};
    ['info', 'network', 'hardware', 'storage'].forEach(function (id) {
      var panel = el('div', {
        class: 'c-stack',
        attrs: {
          id: tabController.getPanelId(id),
          role: 'tabpanel',
          'aria-labelledby': tabController.getTabId(id)
        }
      });
      panel.hidden = id !== 'info';
      panels[id] = panel;
      body.appendChild(panel);
    });

    body.insertBefore(tabController.el, panels.info);

    var infoHost = el('div');
    var networkHost = el('div');
    var hardwareHost = el('div');
    panels.info.appendChild(infoHost);
    panels.network.appendChild(networkHost);
    panels.hardware.appendChild(hardwareHost);

    /* Storage tab structure */
    var storageInfoHost = el('div');
    var clipsHost = el('div');
    var dateField = ui.field({
      label: 'Ngày ghi trên thẻ',
      type: 'date',
      value: storageState.date
    });
    var loadClipsBtn = ui.button({
      label: 'Tải clip',
      icon: 'refresh',
      variant: 'secondary',
      size: 'sm',
      onClick: function () {
        storageState.date = dateField.getValue() || todayString();
        loadClips(true);
      }
    });
    var clipsFilter = el('div', { class: 'c-row c-row--wrap' });
    clipsFilter.appendChild(dateField.el);
    clipsFilter.appendChild(loadClipsBtn);
    panels.storage.appendChild(storageInfoHost);
    var clipsSection = el('div', { class: 'c-stack c-stack--sm' });
    clipsSection.appendChild(el('h3', { text: 'Clip trên thẻ' }));
    clipsSection.appendChild(clipsFilter);
    clipsSection.appendChild(clipsHost);
    panels.storage.appendChild(clipsSection);

    function activateTab(id) {
      ['info', 'network', 'hardware', 'storage'].forEach(function (key) {
        panels[key].hidden = key !== id;
      });
      if (id === 'hardware') { loadHardware(false); }
      if (id === 'storage') {
        loadStorageInfo(false);
        if (!storageState.clipsLoaded) { loadClips(false); }
      }
    }

    function detailWarning() {
      if (detailState.loading && !detailState.data) {
        return CCTV.ui.skeleton({ variant: 'text', rows: 4 });
      }
      if (detailState.error) {
        return ui.banner({
          tone: 'warning',
          title: detailState.error.code === 'TEST_MODE_BLOCKED'
            ? 'Không đọc được chi tiết trong chế độ kiểm thử'
            : 'Không đọc được thông tin trực tiếp từ camera',
          message: detailState.error.message || 'Dữ liệu bên dưới chỉ lấy từ hồ sơ đã lưu.',
          actions: [ui.button({
            label: 'Thử lại',
            icon: 'refresh',
            variant: 'secondary',
            size: 'sm',
            onClick: function () { loadDetails(true); }
          })],
          dismissible: false
        });
      }
      return null;
    }

    function renderInfo() {
      clear(infoHost);
      var warning = detailWarning();
      if (warning) { infoHost.appendChild(warning); }
      var data = detailState.data || {};
      var rows = [
        ['Tên trong NVR', camera.name],
        ['Tên trên camera', pick(data.name, '—')],
        ['Hãng', pick(data.vendor, camera.vendor)],
        ['Model', pick(data.model, camera.model)],
        ['Serial', pick(data.serial, camera.serial)],
        ['Firmware', pick(data.firmware, camera.firmware)],
        ['Ngày build', pick(data.build_date, '—')],
        ['Phiên bản web', pick(data.web_version, '—')],
        ['Phần cứng', pick(data.hardware, '—')],
        ['Lớp thiết bị', pick(data.device_class, '—')],
        ['Hostname', pick(data.hostname, '—')],
        ['Giờ camera', pick(data.camera_time, '—')],
        ['Nhóm', camera.group],
        ['VLAN', camera.vlan]
      ];
      if (ctx.isAdmin) {
        rows.push(['Tên đăng nhập', pick(camera.username, '—')]);
        rows.push(['Đường dẫn RTSP', pick(camera.rtsp_path, '—')]);
        rows.push(['Ghi chú', pick(camera.note, '—')]);
      }
      infoHost.appendChild(kvBlock(rows));
      if (detailState.loading) {
        infoHost.appendChild(el('p', { class: 'c-muted-block', text: 'Đang đọc thêm thông tin từ camera…' }));
      }
    }

    function renderNetwork() {
      clear(networkHost);
      var warning = detailWarning();
      if (warning) { networkHost.appendChild(warning); }
      var data = detailState.data || {};
      networkHost.appendChild(kvBlock([
        ['Địa chỉ IP', pick(data.ip, camera.ip), true],
        ['MAC', pick(data.mac, camera.mac), true],
        ['Subnet mask', pick(data.netmask, '—'), true],
        ['Gateway', pick(data.gateway, '—'), true],
        ['Chế độ IP', pick(data.dhcp, '—')],
        ['DNS', pick(data.dns, '—'), true],
        ['Cổng HTTP', pick(data.http_port, camera.http_port)],
        ['Cổng TCP', pick(data.tcp_port, camera.tcp_port)],
        ['Cổng RTSP', pick(data.rtsp_port, camera.rtsp_port)],
        ['VLAN', pick(camera.vlan, '—')],
        ['VLAN ID', pick(camera.vlan_id, '—'), true]
      ]));
      if (detailState.loading) {
        networkHost.appendChild(el('p', { class: 'c-muted-block', text: 'Đang đọc cấu hình mạng từ camera…' }));
      }
    }

    function loadDetails(force) {
      if (drawerClosed) { return; }
      if (detailState.loading) { return; }
      if (detailState.data && !force) { return; }
      detailState.loading = true;
      detailState.error = null;
      renderInfo();
      renderNetwork();
      ctx.api.get('/api/camera/details', {
        query: { ip: camera.ip },
        signal: controller.signal,
        silent: true,
        timeoutMs: 20000
      }).then(function (data) {
        if (drawerClosed) { return; }
        detailState.data = data && data.details ? data.details : null;
        detailState.loading = false;
        renderInfo();
        renderNetwork();
      }).catch(function (err) {
        if (drawerClosed || (err && err.code === 'ABORTED')) { return; }
        detailState.error = err;
        detailState.loading = false;
        renderInfo();
        renderNetwork();
      });
    }

    /* Hardware tab */
    function hardwareStatusText(value) {
      if (value === true) { return 'Đang bật'; }
      if (value === false) { return 'Đang tắt'; }
      return 'Không xác định';
    }

    function hardwareTone(value) {
      if (value === true) { return 'success'; }
      if (value === false) { return 'neutral'; }
      return 'warning';
    }

    function loadHardware(force) {
      if (drawerClosed) { return; }
      if (hardwareState.loading) { return; }
      if (hardwareState.loaded && !force) { return; }
      hardwareState.loading = true;
      hardwareState.error = null;
      renderHardware();
      ctx.api.get('/api/hardware/status', {
        query: { ip: camera.ip },
        signal: controller.signal,
        silent: true,
        timeoutMs: 15000
      }).then(function (data) {
        if (drawerClosed) { return; }
        hardwareState.data = data || {};
        hardwareState.loaded = true;
        hardwareState.loading = false;
        if (data && data.error) {
          hardwareState.error = { message: String(data.error), code: 'CAMERA_OPERATION_FAILED' };
        }
        renderHardware();
      }).catch(function (err) {
        if (drawerClosed || (err && err.code === 'ABORTED')) { return; }
        hardwareState.error = err;
        hardwareState.loading = false;
        renderHardware();
      });
    }

    function hardwareApi(path, enable, control, key, statusNode) {
      control.setDisabled(true);
      ctx.api.post(path, { ip: camera.ip, enable: !!enable }, {
        signal: controller.signal,
        silent: true
      }).then(function (data) {
        if (drawerClosed) { return; }
        var value = data && Object.prototype.hasOwnProperty.call(data, key) ? !!data[key] : !!enable;
        hardwareState.data = Object.assign({}, hardwareState.data || {}, {});
        hardwareState.data[key] = value;
        control.setChecked(value);
        control.setDisabled(false);
        if (statusNode) {
          statusNode.textContent = hardwareStatusText(value);
          statusNode.setAttribute('data-tone', hardwareTone(value));
        }
      }).catch(function (err) {
        if (drawerClosed || (err && err.code === 'ABORTED')) { return; }
        control.setChecked(!enable);
        control.setDisabled(false);
        showApiError(err, 'Không thay đổi được trạng thái phần cứng.');
      });
    }

    function sirenControls(known) {
      var data = hardwareState.data || {};
      var row = el('div', { class: 'c-row c-row--wrap' });
      var status = ui.badge(hardwareStatusText(data.siren), { tone: hardwareTone(data.siren) });
      row.appendChild(status);
      if (!ctx.isAdmin) { return row; }
      var startBtn = ui.button({
        label: 'Bật còi',
        icon: 'bell',
        variant: 'danger',
        size: 'sm',
        disabled: !known || !!data.siren,
        onClick: function () {
          ctx.confirm({
            title: 'Bật còi báo động',
            message: 'Còi trên camera "' + (camera.name || camera.ip) + '" sẽ phát ngay.',
            details: 'Chỉ bật khi đã kiểm tra hiện trường. Nhớ tắt còi sau khi xử lý.',
            confirmLabel: 'Bật còi',
            cancelLabel: 'Huỷ',
            variant: 'danger'
          }).then(function (confirmed) {
            if (!confirmed) { return; }
            startBtn.disabled = true;
            ctx.api.post('/api/hardware/siren', { ip: camera.ip, action: 'start', confirm: true }, {
              signal: controller.signal,
              silent: true
            }).then(function (result) {
              if (drawerClosed) { return; }
              hardwareState.data.siren = !!(result && result.siren);
              status.textContent = hardwareStatusText(hardwareState.data.siren);
              status.setAttribute('data-tone', hardwareTone(hardwareState.data.siren));
              startBtn.disabled = !!hardwareState.data.siren;
              stopBtn.disabled = !hardwareState.data.siren;
              ui.toast('Đã gửi lệnh bật còi.', { type: 'warning' });
            }).catch(function (err) {
              if (drawerClosed || (err && err.code === 'ABORTED')) { return; }
              startBtn.disabled = false;
              showApiError(err, 'Không bật được còi camera.');
            });
          });
        }
      });
      var stopBtn = ui.button({
        label: 'Tắt còi',
        icon: 'bell-off',
        variant: 'secondary',
        size: 'sm',
        disabled: !known || !data.siren,
        onClick: function () {
          stopBtn.disabled = true;
          ctx.api.post('/api/hardware/siren', { ip: camera.ip, action: 'stop' }, {
            signal: controller.signal,
            silent: true
          }).then(function (result) {
            if (drawerClosed) { return; }
            hardwareState.data.siren = !!(result && result.siren);
            status.textContent = hardwareStatusText(hardwareState.data.siren);
            status.setAttribute('data-tone', hardwareTone(hardwareState.data.siren));
            startBtn.disabled = !!hardwareState.data.siren;
            stopBtn.disabled = !hardwareState.data.siren;
            ui.toast('Đã gửi lệnh tắt còi.', { type: 'success' });
          }).catch(function (err) {
            if (drawerClosed || (err && err.code === 'ABORTED')) { return; }
            stopBtn.disabled = false;
            showApiError(err, 'Không tắt được còi camera.');
          });
        }
      });
      row.appendChild(startBtn);
      row.appendChild(stopBtn);
      return row;
    }

    function renderHardware() {
      clear(hardwareHost);
      if (hardwareState.loading && !hardwareState.loaded) {
        hardwareHost.appendChild(CCTV.ui.skeleton({ variant: 'text', rows: 4 }));
        return;
      }
      if (hardwareState.error) {
        hardwareHost.appendChild(ui.banner({
          tone: hardwareState.error.code === 'TEST_MODE_BLOCKED' ? 'warning' : 'danger',
          title: hardwareState.error.code === 'TEST_MODE_BLOCKED'
            ? 'Chế độ kiểm thử không đọc được phần cứng'
            : 'Không đọc được trạng thái phần cứng',
          message: hardwareState.error.message || '',
          actions: [ui.button({
            label: 'Thử lại',
            icon: 'refresh',
            variant: 'secondary',
            size: 'sm',
            onClick: function () { loadHardware(true); }
          })]
        }));
      }
      var hasError = !!hardwareState.error;
      var data = hasError ? {} : (hardwareState.data || {});
      var known = hardwareState.loaded && !hasError && !hardwareState.loading;
      if (!ctx.isAdmin) {
        hardwareHost.appendChild(kvBlock([
          ['Che khuất riêng tư', hardwareStatusText(data.privacy)],
          ['Bám theo chuyển động', hardwareStatusText(data.tracking)],
          ['Còi báo động', hardwareStatusText(data.siren)],
          ['Vị trí PTZ', pick(data.ptz_position, '—')]
        ]));
        hardwareHost.appendChild(el('p', { class: 'c-muted-block', text: 'Chỉ quản trị viên có thể thay đổi các thiết lập phần cứng.' }));
        return;
      }
      var privacyStatus = ui.badge(hardwareStatusText(data.privacy), { tone: hardwareTone(data.privacy) });
      var privacySwitch = ui.switch({
        checked: data.privacy === true,
        label: 'Che khuất riêng tư',
        description: 'Che hình ảnh camera khi cần bảo mật hiện trường.',
        disabled: !known,
        onChange: function (checked) {
          hardwareApi('/api/hardware/privacy', checked, privacySwitch, 'privacy', privacyStatus);
        }
      });
      var privacyRow = el('div', { class: 'c-row c-row--between c-row--wrap' });
      privacyRow.appendChild(privacySwitch.el);
      privacyRow.appendChild(privacyStatus);

      var trackingStatus = ui.badge(hardwareStatusText(data.tracking), { tone: hardwareTone(data.tracking) });
      var trackingSwitch = ui.switch({
        checked: data.tracking === true,
        label: 'Bám theo chuyển động',
        description: 'Tự động quay theo chuyển động bằng snapshot nội bộ.',
        disabled: !known,
        onChange: function (checked) {
          hardwareApi('/api/hardware/tracking', checked, trackingSwitch, 'tracking', trackingStatus);
        }
      });
      var trackingRow = el('div', { class: 'c-row c-row--between c-row--wrap' });
      trackingRow.appendChild(trackingSwitch.el);
      trackingRow.appendChild(trackingStatus);

      hardwareHost.appendChild(privacyRow);
      hardwareHost.appendChild(trackingRow);
      var sirenSection = el('div', { class: 'c-stack c-stack--sm' });
      sirenSection.appendChild(el('h3', { text: 'Còi báo động' }));
      sirenSection.appendChild(sirenControls(known));
      hardwareHost.appendChild(sirenSection);
      if (data.ptz_position) {
        hardwareHost.appendChild(kvBlock([['Vị trí PTZ', data.ptz_position]]));
      }
      if (!known) {
        hardwareHost.appendChild(el('p', { class: 'c-muted-block', text: 'Chưa đọc được trạng thái hiện tại của camera.' }));
      }
    }

    /* Storage tab */
    function renderStorageInfo() {
      clear(storageInfoHost);
      if (storageState.infoLoading && !storageState.info) {
        storageInfoHost.appendChild(CCTV.ui.skeleton({ variant: 'text', rows: 4 }));
        return;
      }
      if (storageState.infoError) {
        storageInfoHost.appendChild(ui.banner({
          tone: storageState.infoError.code === 'TEST_MODE_BLOCKED' ? 'warning' : 'danger',
          title: storageState.infoError.code === 'TEST_MODE_BLOCKED'
            ? 'Chế độ kiểm thử không đọc được thẻ nhớ'
            : 'Không đọc được thông tin thẻ nhớ',
          message: storageState.infoError.message || '',
          actions: [ui.button({
            label: 'Thử lại',
            icon: 'refresh',
            variant: 'secondary',
            size: 'sm',
            onClick: function () { loadStorageInfo(true); }
          })]
        }));
      }
      var info = storageState.info;
      if (!info) { return; }
      if (!info.has_sd) {
        storageInfoHost.appendChild(ui.empty({
          icon: 'sd-card',
          title: 'Camera không có thẻ nhớ hoặc chưa đọc được thông tin',
          description: info.status_text || 'Kiểm tra thẻ MicroSD trên camera.'
        }));
        return;
      }
      var card = el('div', { class: 'c-card' });
      var cardBody = el('div', { class: 'c-card__body c-stack c-stack--sm' });
      var gaugeRow = el('div', { class: 'c-row c-row--between c-row--wrap' });
      gaugeRow.appendChild(CCTV.ui.gauge({
        percent: Number(info.percent_used) || 0,
        label: 'Đã dùng',
        valueText: fmt.percent(Number(info.percent_used) || 0)
      }));
      var badgeWrap = el('div', { class: 'c-stack c-stack--sm' });
      badgeWrap.appendChild(ui.badge(info.status_text || (info.is_error ? 'Cần kiểm tra' : 'Bình thường'), {
        tone: info.is_error ? 'danger' : 'success'
      }));
      if (info.product_name) { badgeWrap.appendChild(el('span', { class: 'u-muted', text: String(info.product_name) })); }
      gaugeRow.appendChild(badgeWrap);
      cardBody.appendChild(gaugeRow);
      var rows = [
        ['Tổng dung lượng', fmt.bytes(Number(info.total_bytes) || (Number(info.total_gb) || 0) * 1024 * 1024 * 1024)],
        ['Đã dùng', fmt.bytes(Number(info.used_bytes) || (Number(info.used_gb) || 0) * 1024 * 1024 * 1024)],
        ['Còn trống', fmt.bytes(Number(info.free_bytes) || (Number(info.free_gb) || 0) * 1024 * 1024 * 1024)],
        ['Thiết bị', info.device],
        ['Trạng thái', info.state || info.status_text]
      ];
      if (ctx.isAdmin) { rows.push(['Đường dẫn', info.path]); }
      cardBody.appendChild(kvBlock(rows));
      card.appendChild(cardBody);
      storageInfoHost.appendChild(card);
    }

    function loadStorageInfo(force) {
      if (drawerClosed) { return; }
      if (storageState.infoLoading) { return; }
      if (storageState.info && !force) { return; }
      storageState.infoLoading = true;
      storageState.infoError = null;
      renderStorageInfo();
      ctx.api.get('/api/storage/info', {
        query: { ip: camera.ip },
        signal: controller.signal,
        silent: true,
        timeoutMs: 20000
      }).then(function (data) {
        if (drawerClosed) { return; }
        storageState.info = data || null;
        storageState.infoLoading = false;
        renderStorageInfo();
      }).catch(function (err) {
        if (drawerClosed || (err && err.code === 'ABORTED')) { return; }
        storageState.infoError = err;
        storageState.infoLoading = false;
        renderStorageInfo();
      });
    }

    function renderClips() {
      clear(clipsHost);
      if (clipsTable) {
        clipsTable.destroy();
        clipsTable = null;
      }
      if (storageState.clipsLoading && !storageState.clips) {
        clipsHost.appendChild(CCTV.ui.skeleton({ variant: 'text', rows: 4 }));
        return;
      }
      if (storageState.clipsError) {
        clipsHost.appendChild(ui.banner({
          tone: storageState.clipsError.code === 'TEST_MODE_BLOCKED' ? 'warning' : 'danger',
          title: storageState.clipsError.code === 'TEST_MODE_BLOCKED'
            ? 'Chế độ kiểm thử không đọc được clip'
            : 'Không đọc được danh sách clip',
          message: storageState.clipsError.message || '',
          actions: [ui.button({
            label: 'Thử lại',
            icon: 'refresh',
            variant: 'secondary',
            size: 'sm',
            onClick: function () { loadClips(true); }
          })]
        }));
      }
      var clips = Array.isArray(storageState.clips) ? storageState.clips : null;
      if (!clips) { return; }
      if (!clips.length) {
        clipsHost.appendChild(ui.empty({
          icon: 'film',
          title: 'Không có clip nào trong ngày đã chọn',
          description: 'Chọn ngày khác hoặc kiểm tra tính năng ghi hình trên camera.'
        }));
        return;
      }
      clipsTable = ui.table({
        columns: [
          {
            key: 'start_time',
            label: 'Bắt đầu',
            render: function (clip) { return el('span', { class: 'u-mono', text: fmt.dateTime(clip.start_time) }); }
          },
          {
            key: 'end_time',
            label: 'Kết thúc',
            render: function (clip) { return el('span', { class: 'u-mono', text: fmt.dateTime(clip.end_time) }); }
          },
          {
            key: 'duration',
            label: 'Thời lượng',
            align: 'right',
            render: function (clip) {
              return clip.duration_str || fmt.duration(clip.duration);
            }
          },
          {
            key: 'size_mb',
            label: 'Dung lượng',
            align: 'right',
            render: function (clip) {
              if (typeof clip.size_mb === 'number') { return fmt.number(clip.size_mb) + ' MB'; }
              return fmt.bytes(clip.length_bytes);
            }
          },
          { key: 'event_type', label: 'Sự kiện', render: function (clip) { return clip.event_type || '—'; } },
          { key: 'stream', label: 'Luồng', render: function (clip) { return clip.stream || '—'; } }
        ].concat(ctx.isAdmin ? [{
          key: 'file_path',
          label: 'Đường dẫn',
          render: function (clip) { return el('span', { class: 'u-mono u-truncate', attrs: { title: clip.file_path || '' }, text: clip.file_path || '—' }); }
        }] : []),
        rows: clips,
        rowKey: function (clip) { return String(clip.start_time || '') + '|' + String(clip.end_time || ''); },
        mobile: 'cards',
        caption: 'Clip ghi trên thẻ nhớ'
      });
      clipsHost.appendChild(clipsTable.el);
      clipsHost.appendChild(el('p', {
        class: 'c-muted-block',
        text: 'Tìm thấy ' + clips.length + ' clip trong ngày ' + fmt.date(storageState.date) + '.'
      }));
    }

    function loadClips(force) {
      if (drawerClosed) { return; }
      if (storageState.clipsLoading) { return; }
      if (storageState.clipsLoaded && !force) { return; }
      storageState.clipsLoading = true;
      storageState.clipsError = null;
      renderClips();
      ctx.api.get('/api/storage/recordings', {
        query: { ip: camera.ip, date: storageState.date },
        signal: controller.signal,
        silent: true,
        timeoutMs: 25000
      }).then(function (data) {
        if (drawerClosed) { return; }
        storageState.clips = data && Array.isArray(data.recordings) ? data.recordings : [];
        storageState.clipsLoaded = true;
        storageState.clipsLoading = false;
        renderClips();
      }).catch(function (err) {
        if (drawerClosed || (err && err.code === 'ABORTED')) { return; }
        storageState.clipsError = err;
        storageState.clipsLoading = false;
        renderClips();
      });
    }

    renderInfo();
    renderNetwork();

    var footer = [];
    footer.push(ui.button({
      label: 'Xem trực tiếp',
      icon: 'live',
      variant: 'primary',
      onClick: function () { openLive(camera); }
    }));
    if (ctx.isAdmin) {
      footer.push(ui.button({
        label: 'Đổi tên',
        icon: 'edit',
        variant: 'secondary',
        onClick: function () { openRenameModal(camera, drawer); }
      }));
      footer.push(ui.button({
        label: 'Reboot',
        icon: 'power',
        variant: 'secondary',
        onClick: function () { rebootCameras([camera], null); }
      }));
      footer.push(ui.button({
        label: 'Mở Web GUI',
        icon: 'external-link',
        variant: 'secondary',
        onClick: function () {
          var port = Number(camera.http_port) || 80;
          var url = 'http://' + camera.ip + (port === 80 ? '' : ':' + port);
          ctx.ui.openExternal(url);
        }
      }));
    }

    var drawer = ui.drawer({
      title: camera.name || camera.ip,
      subtitle: camera.ip + (camera.vendor ? ' · ' + camera.vendor : ''),
      body: body,
      footer: footer,
      wide: true,
      dismissible: true,
      onClose: function () {
        drawerClosed = true;
        try { controller.abort(); } catch (err) { /* bỏ qua */ }
        try { tabController.destroy(); } catch (err) { /* bỏ qua */ }
        if (clipsTable) {
          try { clipsTable.destroy(); } catch (err) { /* bỏ qua */ }
          clipsTable = null;
        }
      }
    });
    drawer.el.setAttribute('data-testid', 'cameras-detail-drawer');
    openLayers.push(drawer);

    loadDetails(false);
  }

  function openRenameModal(camera, drawer) {
    if (!ctx || !ctx.isAdmin) { return; }
    var modalClosed = false;
    var host = el('div', { class: 'c-stack c-stack--sm' });
    var field = ui.field({
      label: 'Tên mới',
      value: camera.name || '',
      required: true,
      maxlength: 64,
      help: 'Tên được cập nhật trên camera và trong danh sách NVR (nếu camera phản hồi).'
    });
    host.appendChild(field.el);
    var cancelBtn = ui.button({ label: 'Huỷ', variant: 'secondary', onClick: function () { modal.close(); } });
    var saveBtn = ui.button({
      label: 'Đổi tên',
      icon: 'check',
      variant: 'primary',
      onClick: function () { submit(); }
    });
    var modal = ui.modal({
      title: 'Đổi tên camera',
      subtitle: camera.ip,
      body: host,
      footer: [cancelBtn, saveBtn],
      size: 'sm',
      dismissible: true,
      initialFocus: field.input,
      onClose: function () { modalClosed = true; }
    });
    openLayers.push(modal);

    function submit() {
      if (modalClosed) { return; }
      field.clearError();
      var name = String(field.getValue() || '').trim();
      if (!name) {
        field.setError('Vui lòng nhập tên camera.');
        return;
      }
      modal.setError('');
      modal.setBusy(true);
      ctx.api.post('/api/camera/name', { ip: camera.ip, name: name }, {
        signal: ctx.signal,
        silent: true
      }).then(function (data) {
        if (destroyed || modalClosed) { return; }
        camera.name = (data && data.name) || name;
        if (drawer && drawer.el) {
          var titleNode = drawer.el.querySelector('.c-modal__title');
          if (titleNode) { titleNode.textContent = camera.name; }
        }
        modal.close();
        ui.toast((data && data.message) || 'Đã đổi tên camera.', { type: 'success' });
        loadCameras(false);
      }).catch(function (err) {
        if (modalClosed || destroyed) { return; }
        modal.setBusy(false);
        if (err && err.code === 'ABORTED') { return; }
        modal.setError(err && err.message ? err.message : 'Không đổi được tên camera.');
      });
    }
  }

  /* ------------------------------- Layout ------------------------------ */

  function buildFilters() {
    refs.search = ui.search({
      placeholder: 'Tìm tên, IP, MAC, serial, model…',
      ariaLabel: 'Tìm kiếm camera',
      testId: 'cameras-search',
      onInput: function (value) {
        filters.q = value;
        page = 1;
        renderTable();
      }
    });

    refs.groupField = ui.field({
      label: 'Nhóm',
      type: 'select',
      options: [{ value: '', label: 'Tất cả nhóm' }],
      value: ''
    });
    refs.groupField.input.addEventListener('change', function () {
      filters.group = refs.groupField.getValue();
      page = 1;
      renderTable();
    });

    var statusOptions = [{ value: '', label: 'Tất cả trạng thái' }];
    STATUS_VALUES.forEach(function (status) {
      statusOptions.push({ value: status, label: fmt.status(status).label });
    });
    refs.statusField = ui.field({
      label: 'Trạng thái',
      type: 'select',
      options: statusOptions,
      value: ''
    });
    refs.statusField.input.addEventListener('change', function () {
      filters.status = refs.statusField.getValue();
      page = 1;
      renderTable();
    });

    refs.armedField = ui.field({
      label: 'Gác an ninh',
      type: 'select',
      options: [
        { value: '', label: 'Tất cả' },
        { value: 'yes', label: 'Đang gác' },
        { value: 'no', label: 'Tắt gác' }
      ],
      value: ''
    });
    refs.armedField.input.addEventListener('change', function () {
      filters.armed = refs.armedField.getValue();
      page = 1;
      renderTable();
    });

    var clearBtn = ui.button({
      label: 'Xoá lọc',
      icon: 'x',
      variant: 'ghost',
      size: 'sm',
      onClick: function () {
        filters = { q: '', group: '', status: '', armed: '' };
        refs.search.clear();
        refs.groupField.setValue('');
        refs.statusField.setValue('');
        refs.armedField.setValue('');
        page = 1;
        renderTable();
        refs.search.focus();
      }
    });

    var left = [refs.search.el, refs.groupField.el, refs.statusField.el, refs.armedField.el];
    refs.search.el.classList.add('u-grow');
    refs.filterBar = ui.toolbar({ left: left, right: [clearBtn] });
    refs.filterBar.classList.add('u-mb-16');
  }

  function buildBatchBar() {
    if (!ctx.isAdmin) { return null; }
    var bar = el('div', {
      class: 'c-banner',
      attrs: {
        'data-tone': 'info',
        'data-testid': 'cameras-batch-bar',
        'data-admin-only': '1'
      }
    });
    bar.hidden = true;
    var icon = el('span', { class: 'c-banner__icon' });
    icon.appendChild(svg('layers', { size: 18 }));
    bar.appendChild(icon);
    var bodyWrap = el('div', { class: 'c-banner__body' });
    refs.batchCount = el('div', { class: 'c-banner__title', text: 'Đã chọn 0 camera' });
    bodyWrap.appendChild(refs.batchCount);
    bodyWrap.appendChild(el('div', {
      class: 'c-banner__message',
      text: 'Thao tác hàng loạt áp dụng cho các camera đang được chọn.'
    }));

    var actions = el('div', { class: 'c-banner__actions' });
    var syncBtn = ui.button({
      label: 'Đồng bộ sức khoẻ',
      icon: 'refresh-cw',
      variant: 'secondary',
      size: 'sm',
      testId: 'cameras-sync-health',
      onClick: function () { syncHealth(syncBtn); }
    });
    var rebootBtn = ui.button({
      label: 'Khởi động lại',
      icon: 'power',
      variant: 'secondary',
      size: 'sm',
      onClick: function () { rebootCameras(selectedCameras(), rebootBtn); }
    });
    var ipBtn = ui.button({
      label: 'Đổi IP',
      icon: 'network',
      variant: 'secondary',
      size: 'sm',
      onClick: function () { openBatchIpModal(ipBtn); }
    });
    var passwordBtn = ui.button({
      label: 'Đổi mật khẩu',
      icon: 'key',
      variant: 'secondary',
      size: 'sm',
      onClick: function () { openBatchPasswordModal(passwordBtn); }
    });
    var timeBtn = ui.button({
      label: 'Đồng bộ giờ',
      icon: 'clock',
      variant: 'secondary',
      size: 'sm',
      onClick: function () { syncTimeSelection(timeBtn); }
    });
    var armBtn = ui.button({
      label: 'Bật gác',
      icon: 'shield',
      variant: 'secondary',
      size: 'sm',
      onClick: function () { setArmedSelection(true, armBtn); }
    });
    var disarmBtn = ui.button({
      label: 'Tắt gác',
      icon: 'shield-off',
      variant: 'secondary',
      size: 'sm',
      onClick: function () { setArmedSelection(false, disarmBtn); }
    });
    var clearBtn = ui.button({
      label: 'Bỏ chọn',
      icon: 'x',
      variant: 'ghost',
      size: 'sm',
      onClick: clearSelection
    });
    [syncBtn, rebootBtn, ipBtn, passwordBtn, timeBtn, armBtn, disarmBtn, clearBtn].forEach(function (button) {
      actions.appendChild(button);
    });
    bodyWrap.appendChild(actions);
    bar.appendChild(bodyWrap);
    return bar;
  }

  function buildScanResultsPanel(scanState, list) {
    var card = el('section', {
      class: 'c-card',
      attrs: { 'data-testid': 'cameras-scan-results' }
    });
    var header = el('div', { class: 'c-card__header' });
    var titleWrap = el('div');
    var title = el('div', { class: 'c-card__title' });
    title.appendChild(svg('scanner', { size: 16 }));
    title.appendChild(el('span', { text: 'Kết quả quét gần nhất' }));
    titleWrap.appendChild(title);
    var meta = list.length + ' thiết bị';
    if (scanState && scanState.scannedAt) {
      meta += ' · ' + fmt.dateTime(scanState.scannedAt);
    }
    titleWrap.appendChild(el('div', { class: 'c-card__subtitle', text: meta }));
    header.appendChild(titleWrap);
    header.appendChild(ui.button({
      label: 'Mở màn Quét mạng',
      icon: 'scanner',
      variant: 'secondary',
      onClick: function () { if (ctx) { ctx.router.go('scanner'); } }
    }));
    card.appendChild(header);

    var body = el('div', { class: 'c-card__body' });
    var listEl = el('div', { class: 'c-stack c-stack--sm' });
    list.slice(0, 50).forEach(function (device) {
      var row = el('div', { class: 'c-camera-mini' });
      var info = el('div', { class: 'c-camera-mini__body' });
      info.appendChild(el('div', {
        class: 'c-camera-mini__name',
        text: device.name || device.ip || 'Không rõ tên'
      }));
      info.appendChild(el('div', {
        class: 'c-camera-mini__meta',
        text: [device.ip, device.model, device.vlan].filter(Boolean).join(' · ')
      }));
      row.appendChild(info);
      row.appendChild(ui.statusPill(device.status || 'online'));
      listEl.appendChild(row);
    });
    if (list.length > 50) {
      listEl.appendChild(el('div', {
        class: 'c-muted-block',
        text: '… và ' + (list.length - 50) + ' thiết bị khác. Mở màn Quét mạng để xem đầy đủ.'
      }));
    }
    body.appendChild(listEl);
    card.appendChild(body);
    return card;
  }

  function buildLayout() {
    clear(viewRoot);
    refs = {};

    var updated = el('span', { class: 'u-muted u-tabular', text: 'Đang tải…' });
    refs.updated = updated;
    var actions = [];
    if (ctx.isAdmin) {
      actions.push(ui.button({
        label: 'Quét mạng',
        icon: 'scanner',
        variant: 'secondary',
        onClick: function () { ctx.router.go('scanner'); }
      }));
      actions.push(ui.button({
        label: 'Thêm camera',
        icon: 'plus',
        variant: 'primary',
        testId: 'cameras-add-btn',
        onClick: function () { openCameraModal(null); }
      }));
    }
    refs.refreshBtn = ui.button({
      label: 'Làm mới',
      icon: 'refresh',
      variant: 'secondary',
      onClick: function () { loadCameras(true); }
    });
    actions.push(refs.refreshBtn);

    var header = ui.pageHeader({
      title: 'Camera',
      subtitle: 'Quản lý camera đã lưu, chi tiết thiết bị và thao tác hàng loạt',
      icon: 'cameras',
      actions: actions
    });
    header.querySelector('.c-page-header__subtitle').appendChild(
      el('span', { class: 'u-muted', text: ' · ' })
    );
    header.querySelector('.c-page-header__subtitle').appendChild(updated);
    viewRoot.appendChild(header);

    refs.errorHost = el('div');
    refs.errorHost.hidden = true;
    viewRoot.appendChild(refs.errorHost);

    buildFilters();
    var savedPanel = el('div', { class: 'c-stack' });
    refs.savedPanel = savedPanel;
    savedPanel.appendChild(refs.filterBar);

    var bar = buildBatchBar();
    if (bar) {
      refs.batchBar = bar;
      savedPanel.appendChild(bar);
    }

    var card = el('section', { class: 'c-card' });
    var cardBody = el('div', { class: 'c-card__body c-card__body--flush' });
    refs.tableHost = el('div');
    cardBody.appendChild(refs.tableHost);
    card.appendChild(cardBody);

    var footer = el('div', { class: 'c-card__footer' });
    var footerTop = el('div', { class: 'c-row c-row--between c-row--wrap' });
    refs.summary = el('span', { class: 'u-muted', text: 'Tổng 0 · Trực tuyến 0 · Ngoại tuyến 0 · Đang gác 0' });
    footerTop.appendChild(refs.summary);
    footer.appendChild(footerTop);

    pagination = ui.pagination({
      page: 1,
      pageSize: pageSize,
      total: 0,
      pageSizes: PAGE_SIZES,
      onChange: function (nextPage, nextSize, sizeChanged) {
        page = nextPage;
        if (sizeChanged) {
          pageSize = nextSize;
          if (ctx) { ctx.state.setUi('pageSize', pageSize); }
          page = 1;
        }
        renderTable();
      }
    });
    footer.appendChild(pagination.el);
    card.appendChild(footer);
    savedPanel.appendChild(card);
    viewRoot.appendChild(savedPanel);

    createTable();

    /* Tab "Kết quả quét gần nhất" chỉ xuất hiện khi state có dữ liệu quét;
       không tự động quét lại. */
    var scanState = ctx && ctx.state ? ctx.state.get('scan') : null;
    var scanDevices = scanState && Array.isArray(scanState.devices) ? scanState.devices : [];
    if (scanDevices.length) {
      refs.scanPanel = buildScanResultsPanel(scanState, scanDevices);
      refs.scanPanel.hidden = true;
      var tabsCtrl = ui.tabs({
        label: 'Camera đã lưu và kết quả quét',
        active: 'saved',
        testId: 'cameras-tabs',
        tabs: [
          { id: 'saved', label: 'Đã lưu', icon: 'cameras' },
          { id: 'scan', label: 'Kết quả quét gần nhất', icon: 'scanner', badge: scanDevices.length }
        ],
        onChange: function (id) {
          refs.savedPanel.hidden = id !== 'saved';
          refs.scanPanel.hidden = id !== 'scan';
        }
      });
      refs.tabsCtrl = tabsCtrl;
      viewRoot.insertBefore(tabsCtrl.el, savedPanel);
      viewRoot.appendChild(refs.scanPanel);
    }
  }

  /* ------------------------------- Lifecycle --------------------------- */

  function render(container, viewCtx) {
    ctx = viewCtx;
    destroyed = false;
    pageSize = Number(ctx.state.getUi('pageSize', 15));
    if (PAGE_SIZES.indexOf(pageSize) === -1) { pageSize = 15; }
    page = 1;
    selected = new Set();
    filters = { q: '', group: '', status: '', armed: '' };
    sort = { key: 'name', dir: 'asc' };
    openLayers = [];

    clear(container);
    viewRoot = el('div', { class: 'c-stack view-cameras' });
    container.appendChild(viewRoot);
    buildLayout();

    var uiRequest = ctx.state.get('uiRequest');
    if (uiRequest && uiRequest.openAddCamera) {
      ctx.state.set('uiRequest', null);
      if (ctx.isAdmin) { openCameraModal(null); }
    }

    var cached = ctx.state.get('cameras');
    if (Array.isArray(cached) && cached.length) {
      cameras = cached.slice();
      renderAll();
      if (table) { table.update({ loading: false }); }
    }
    loadCameras(false);
  }

  function destroy() {
    destroyed = true;
    refreshToken += 1;
    openLayers.forEach(function (handle) {
      try { handle.close(); } catch (err) { /* bỏ qua */ }
    });
    openLayers = [];
    if (table) {
      try { table.destroy(); } catch (err) { /* bỏ qua */ }
      table = null;
    }
    if (refs.search && typeof refs.search.destroy === 'function') {
      try { refs.search.destroy(); } catch (err) { /* bỏ qua */ }
    }
    pagination = null;
    emptyHost = null;
    currentRows = [];
    refs = {};
    cameras = [];
    selected = new Set();
    viewRoot = null;
    ctx = null;
  }

  function onResume() {
    if (!ctx || destroyed) { return; }
    if (document.hidden) { return; }
    loadCameras(false);
  }

  CCTV.views.register('cameras', {
    title: 'Camera',
    icon: 'cameras',
    roles: ['admin', 'viewer'],
    order: 30,
    render: render,
    destroy: destroy,
    onResume: onResume
  });
})();
