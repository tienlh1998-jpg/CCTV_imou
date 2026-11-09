/* =========================================================================
   CCTV Vision Hub v2.0 — view Quét mạng (admin)
   Dò Dahua/Imou, ONVIF, Hikvision SADP; lọc VLAN, đưa camera vào NVR, xuất CSV.
   Không tự quét khi mở màn; không dùng nội dung HTML từ API.
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
  var auth = CCTV.auth;

  var PAGE_SIZES = [10, 15, 20, 30, 50];

  var ctx = null;
  var viewRoot = null;
  var refs = {};
  var destroyed = true;

  var devices = [];
  var scanMeta = null;
  var selected = new Set();
  var page = 1;
  var pageSize = 15;
  var filters = { q: '', model: '' };
  var sort = { key: 'ip', dir: 'asc' };
  var currentRows = [];
  var table = null;
  var pagination = null;
  var emptyHost = null;

  var vlans = [];
  var vlanBusy = false;
  var viewToken = 0;
  var deepTouched = false;
  var subnetPrefilled = false;
  var openLayers = [];

  var scanState = {
    busy: false,
    seq: 0,
    controller: null,
    stopProgress: null,
    progress: null,
    statusText: null,
    startedAt: 0,
    elapsed: 0
  };

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

  function deviceKey(device) {
    return String((device && device.ip) || '');
  }

  function showApiError(err, fallback) {
    if (!err || err.code === 'ABORTED' || err.status === 401) { return; }
    var type = (err.status === 403 || err.status === 429 || err.code === 'TEST_MODE_BLOCKED') ? 'warning' : 'error';
    ui.toast(err.message || fallback || 'Thao tác thất bại.', {
      type: type,
      duration: err.status === 429 ? 8000 : 5000
    });
  }

  function detailText(err) {
    if (!err) { return 'Lỗi không xác định.'; }
    if (err.code === 'TEST_MODE_BLOCKED') {
      return 'Chế độ kiểm thử không cho phép quét mạng thật. Cấu hình CCTV_TEST_SCAN_FIXTURE để nhận dữ liệu mẫu.';
    }
    if (err.code === 'TIMEOUT') {
      return 'Máy chủ chưa phản hồi trong thời gian chờ. Lượt quét có thể vẫn đang chạy trên máy chủ; hãy thử lại sau.';
    }
    if (err.code === 'RATE_LIMITED' && err.retryAfterSeconds) {
      return 'Bạn quét quá nhanh. Thử lại sau ' + err.retryAfterSeconds + ' giây.';
    }
    if (err.message) { return err.message; }
    return 'Không thực hiện được yêu cầu.';
  }

  function toNumber(value, fallback) {
    var number = Number(value);
    return isFinite(number) ? number : fallback;
  }

  function display(value) {
    if (value === undefined || value === null || value === '') { return '—'; }
    if (Array.isArray(value)) { return value.length ? value.join(', ') : '—'; }
    var text = String(value).trim();
    if (!text || text === 'N/A' || text === 'Unknown' || text === 'unknown') { return '—'; }
    return text;
  }

  function fieldValueTrim(field) {
    return String(field && field.getValue ? field.getValue() : '').trim();
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

  function openLive(device) {
    if (!ctx || !device || !device.ip) { return; }
    /* Bàn giao lựa chọn sang live qua khóa UI được allowlist. */
    ctx.state.setUi('grid', { mode: '1', slots: [{ ip: device.ip, channel: 1 }] });
    ctx.router.go('live');
  }

  /* ---------------------------- Status banner --------------------------- */

  function clearStatus() {
    if (!refs.statusHost) { return; }
    clear(refs.statusHost);
    refs.statusHost.hidden = true;
  }

  function showStatus(tone, title, message, retry) {
    if (!refs.statusHost) { return; }
    refs.statusHost.hidden = false;
    clear(refs.statusHost);
    var actions = [];
    if (typeof retry === 'function') {
      actions.push(ui.button({
        label: 'Thử lại',
        icon: 'refresh',
        variant: 'secondary',
        size: 'sm',
        onClick: retry
      }));
    }
    refs.statusHost.appendChild(ui.banner({
      tone: tone,
      title: title,
      message: message,
      actions: actions,
      dismissible: true
    }));
  }

  /* ------------------------------ VLAN --------------------------------- */

  function normalizeVlans(list) {
    if (!Array.isArray(list)) { return []; }
    return list.filter(function (item) {
      return item && typeof item === 'object';
    }).map(function (item) {
      return {
        vlan: String(item.vlan || ''),
        subnet: String(item.subnet || ''),
        label: String(item.label || ''),
        gateway: item.gateway || '',
        is_up: item.is_up !== false
      };
    });
  }

  function setVlans(list, allSubnets, origin) {
    vlans = normalizeVlans(list);
    updateVlanOptions();
    updateChips();
    if (refs.vlanHint) {
      var count = vlans.length;
      var parts = [];
      if (origin) { parts.push(origin); }
      parts.push(count ? (count + ' VLAN') : 'Chưa có VLAN');
      if (allSubnets) { parts.push('Dải: ' + allSubnets); }
      refs.vlanHint.textContent = parts.join(' · ');
    }
    if (allSubnets && !subnetPrefilled && !String(refs.subnet ? refs.subnet.getValue() : '').trim()) {
      setSubnet(allSubnets);
    }
  }

  function setSubnet(value) {
    if (!refs.subnet) { return; }
    refs.subnet.setValue(value || '');
    subnetPrefilled = true;
    updateChipActive();
  }

  function updateVlanOptions() {
    if (!refs.vlanField) { return; }
    var current = refs.vlanField.getValue();
    var options = [{ value: '', label: 'Theo dải nhập tay' }];
    var seen = {};
    vlans.forEach(function (item) {
      var value = item.subnet;
      if (!value || seen[value]) { return; }
      seen[value] = true;
      var label = item.label || ('VLAN ' + (item.vlan || '?'));
      if (label.indexOf(value) === -1) { label += ' (' + value + ')'; }
      options.push({ value: value, label: label });
    });
    refs.vlanField.setOptions(options, current);
  }

  function updateChips() {
    if (!refs.chipHost) { return; }
    clear(refs.chipHost);
    refs.chipHost.hidden = vlans.length === 0;
    vlans.forEach(function (item) {
      var value = item.subnet;
      if (!value) { return; }
      var label = item.label || ('VLAN ' + (item.vlan || '?'));
      var chip = el('button', {
        class: 'c-chip c-chip--button',
        attrs: {
          type: 'button',
          title: item.gateway ? ('Gateway ' + item.gateway) : label,
          disabled: scanState.busy || null
        },
        text: label
      });
      chip.setAttribute('data-vlan-value', value);
      chip.addEventListener('click', function () {
        if (scanState.busy) { return; }
        setSubnet(value);
        if (refs.vlanField) { refs.vlanField.setValue(value); }
      });
      refs.chipHost.appendChild(chip);
    });
    updateChipActive();
  }

  function updateChipActive() {
    if (!refs.chipHost || !refs.subnet) { return; }
    var current = String(refs.subnet.getValue() || '').trim();
    var chips = refs.chipHost.querySelectorAll('[data-vlan-value]');
    for (var i = 0; i < chips.length; i += 1) {
      var value = chips[i].getAttribute('data-vlan-value') || '';
      var active = !!current && value === current;
      chips[i].classList.toggle('is-active', active);
      chips[i].setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function detectVlans() {
    if (!ctx || vlanBusy || scanState.busy) { return; }
    vlanBusy = true;
    var token = viewToken;
    if (refs.detectBtn) {
      ui.busy(refs.detectBtn, true, 'Đang dò…');
    }
    ctx.api.get('/api/scan/vlans', {
      signal: ctx.signal,
      silent: true,
      timeoutMs: 25000
    }).then(function (data) {
      if (destroyed || token !== viewToken) { return; }
      var list = data && Array.isArray(data.vlans) ? data.vlans : [];
      setVlans(list, data && data.all_subnets_str ? String(data.all_subnets_str) : '', 'Đã dò');
      ui.toast('Đã dò ' + list.length + ' VLAN.', { type: 'success' });
    }).catch(function (err) {
      if (!err || err.code === 'ABORTED' || destroyed || token !== viewToken) { return; }
      showStatus('warning', 'Không dò được VLAN', detailText(err), detectVlans);
    }).then(function () {
      if (token !== viewToken) { return; }
      vlanBusy = false;
      if (refs.detectBtn) {
        ui.busy(refs.detectBtn, false);
        refs.detectBtn.disabled = scanState.busy;
      }
    });
  }

  function applySettings(data) {
    if (!data || typeof data !== 'object') { return; }
    /* GET /api/settings bọc cấu hình trong khóa settings. */
    var source = data.settings && typeof data.settings === 'object' ? data.settings : data;
    var configured = Array.isArray(source.company_vlans) ? source.company_vlans : [];
    if (vlans.length === 0 && configured.length) {
      var last = String(source.last_subnets || source.default_subnet || '');
      setVlans(configured, last, 'Cấu hình máy chủ');
    }
    if (!subnetPrefilled && refs.subnet && !String(refs.subnet.getValue() || '').trim()) {
      var preferred = String(source.last_subnets || source.default_subnet || '');
      if (preferred) { setSubnet(preferred); }
    }
    if (!deepTouched && refs.deepSwitch) {
      refs.deepSwitch.setChecked(!!source.deep_scan);
    }
    if (refs.serverHint) {
      var timeout = toNumber(source.scan_timeout, 0);
      refs.serverHint.textContent = timeout > 0
        ? 'Máy chủ đặt thời gian phản hồi mỗi thiết bị khoảng ' + fmt.number(timeout) + ' giây.'
        : 'Máy chủ dùng thời gian quét mặc định.';
    }
  }

  function loadSettings() {
    if (!ctx || destroyed) { return; }
    var token = viewToken;
    ctx.state.refresh('settings').then(function (data) {
      if (destroyed || token !== viewToken) { return; }
      applySettings(data);
    }).catch(function () {
      /* Không có settings vẫn cho phép quét bằng dải nhập tay. */
    });
  }

  /* --------------------------- Results loading ------------------------- */

  function loadSavedResults() {
    var saved = ctx.state.get('scan');
    if (!saved || !Array.isArray(saved.devices)) { return; }
    devices = saved.devices.slice();
    scanMeta = {
      scannedAt: saved.scannedAt || null,
      targets: toNumber(saved.targets, 0),
      durationMs: toNumber(saved.durationMs, 0),
      truncated: !!saved.truncated
    };
    selected = new Set();
    page = 1;
    updateModelOptions();
    renderResults();
  }

  function deviceHaystack(device) {
    return fold([
      device.ip, device.name, device.model, device.mac,
      device.serial, device.vlan, device.vendor,
      device.discovery_proto, device['class']
    ].join(' '));
  }

  function deviceMatches(device) {
    if (filters.model && String(device.model || '') !== filters.model) { return false; }
    var query = fold(filters.q).trim();
    if (query && deviceHaystack(device).indexOf(query) === -1) { return false; }
    return true;
  }

  function ipSortValue(ip) {
    return String(ip || '').split('.').map(function (part) {
      return String(Number(part) || 0).padStart(3, '0');
    }).join('.');
  }

  function valueForSort(device, key) {
    if (key === 'ip') { return ipSortValue(device.ip); }
    if (key === 'http_port') { return toNumber(device.http_port, 0); }
    return fold(device[key]);
  }

  function sortDevices(list) {
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
      if (result === 0) { result = String(a.ip || '').localeCompare(String(b.ip || ''), 'vi', { numeric: true }); }
      return result * dir;
    });
  }

  function filteredDevices() {
    return sortDevices(devices.filter(deviceMatches));
  }

  /* ------------------------------ Rendering ---------------------------- */

  function updateModelOptions() {
    if (!refs.modelField) { return; }
    var seen = {};
    devices.forEach(function (device) {
      var model = String(device.model || '').trim();
      if (model) { seen[model] = true; }
    });
    var models = Object.keys(seen).sort(function (a, b) { return a.localeCompare(b, 'vi'); });
    if (filters.model && !seen[filters.model]) { filters.model = ''; }
    var options = [{ value: '', label: 'Tất cả model' }];
    models.forEach(function (model) { options.push({ value: model, label: model }); });
    refs.modelField.setOptions(options, filters.model);
  }

  function updateEmptyHost(filteredTotal) {
    if (!emptyHost) { return; }
    clear(emptyHost);
    if (!devices.length) {
      emptyHost.appendChild(ui.empty({
        icon: 'scanner',
        title: scanMeta ? 'Không tìm thấy thiết bị nào' : 'Chưa có kết quả quét',
        description: scanMeta
          ? 'Lượt quét đã hoàn tất nhưng không phát hiện camera Dahua/Imou, ONVIF hoặc Hikvision trong dải đã chọn.'
          : 'Nhập dải mạng hoặc chọn VLAN, sau đó bấm "Bắt đầu quét". Ứng dụng không tự quét khi mở màn hình.'
      }));
      return;
    }
    emptyHost.appendChild(ui.empty({
      icon: 'search',
      title: 'Không có thiết bị khớp bộ lọc',
      description: filteredTotal === 0 ? 'Thử xoá từ khoá hoặc chọn model khác.' : ''
    }));
  }

  function updateResultsMeta() {
    if (!refs.resultsMeta) { return; }
    if (!scanMeta) {
      refs.resultsMeta.textContent = 'Chưa có lượt quét nào trong phiên này.';
      return;
    }
    var parts = [];
    parts.push(devices.length + ' thiết bị');
    parts.push('Quét lúc ' + (scanMeta.scannedAt ? fmt.dateTime(scanMeta.scannedAt) : '—'));
    parts.push(scanMeta.targets + ' mục tiêu');
    if (scanMeta.durationMs > 0) { parts.push(fmt.number(scanMeta.durationMs / 1000) + ' giây'); }
    if (scanMeta.truncated) { parts.push('Danh sách có thể bị cắt'); }
    refs.resultsMeta.textContent = parts.join(' · ');
  }

  function updateBatchBar() {
    if (!refs.batchBar) { return; }
    var count = selected.size;
    refs.batchBar.hidden = count === 0;
    if (refs.batchWrap) { refs.batchWrap.hidden = count === 0; }
    if (refs.batchCount) {
      refs.batchCount.textContent = 'Đã chọn ' + count + ' thiết bị';
    }
    if (refs.batchAddBtn) {
      refs.batchAddBtn.disabled = count === 0 || count > 500;
    }
    [refs.batchIpBtn, refs.batchRebootBtn, refs.batchSyncBtn, refs.batchPasswordBtn]
      .forEach(function (button) {
        if (button) { button.disabled = count === 0 || count > 100; }
      });
  }

  function renderResults() {
    if (!table || !pagination) { return; }
    var list = filteredDevices();
    var total = list.length;
    var pages = Math.max(1, Math.ceil(total / pageSize));
    if (page > pages) { page = pages; }
    if (page < 1) { page = 1; }
    var start = (page - 1) * pageSize;
    var rows = list.slice(start, start + pageSize);
    currentRows = rows;
    updateEmptyHost(total);
    var selectedKeys = rows.filter(function (device) {
      return selected.has(deviceKey(device));
    }).map(deviceKey);
    table.update({
      rows: rows,
      loading: false,
      selectedKeys: selectedKeys,
      sort: { key: sort.key, dir: sort.dir }
    });
    pagination.setState({ page: page, pageSize: pageSize, total: total });
    updateResultsMeta();
    updateBatchBar();
    if (refs.exportBtn) { refs.exportBtn.disabled = devices.length === 0; }
  }

  function clearSelection() {
    selected = new Set();
    renderResults();
  }

  /* ---------------------------- Table cells ---------------------------- */

  function nameCell(device) {
    var wrap = el('div', { attrs: { title: device.name || device.ip } });
    wrap.appendChild(el('div', { class: 'u-truncate', text: device.name || '—' }));
    if (device.is_solar) {
      wrap.appendChild(el('div', { class: 'u-subtle', text: 'Năng lượng mặt trời' }));
    }
    return wrap;
  }

  function modelCell(device) {
    return el('span', { class: 'u-truncate', attrs: { title: device.model || '' }, text: device.model || '—' });
  }

  function vlanCell(device) {
    var text = device.vlan || (device.vlan_id ? 'VLAN ' + device.vlan_id : '—');
    return el('span', { text: text });
  }

  function portsCell(device) {
    var httpPort = display(device.http_port);
    var tcpPort = display(device.tcp_port);
    return el('span', { class: 'u-mono', text: 'H ' + httpPort + ' / T ' + tcpPort });
  }

  function protocolCell(device) {
    return device.discovery_proto || (device.onvif_supported ? 'ONVIF' : '—');
  }

  function statusCell(device) {
    var row = el('div', { class: 'c-row c-row--wrap' });
    row.appendChild(ui.statusPill(device.status || 'online'));
    if (device.is_solar) { row.appendChild(ui.badge('Solar', { tone: 'info' })); }
    return row;
  }

  function actionCell(device) {
    var row = el('div', { class: 'c-table__actions' });
    row.appendChild(ui.iconButton({
      icon: 'live',
      label: 'Xem trực tiếp ' + (device.name || device.ip),
      size: 'sm',
      onClick: function () { openLive(device); }
    }));
    row.appendChild(ui.iconButton({
      icon: 'plus',
      label: 'Thêm ' + (device.name || device.ip) + ' vào NVR',
      size: 'sm',
      onClick: function () { openAddDialog([device]); }
    }));
    row.appendChild(ui.iconButton({
      icon: 'sd-card',
      label: 'Kiểm tra thẻ nhớ ' + (device.name || device.ip),
      size: 'sm',
      onClick: function () { openStorageDetails(device); }
    }));
    row.appendChild(ui.iconButton({
      icon: 'info',
      label: 'Chi tiết ' + (device.name || device.ip),
      size: 'sm',
      onClick: function () { openDeviceDetails(device); }
    }));
    return row;
  }

  function createTable() {
    emptyHost = el('div');
    table = ui.table({
      columns: [
        { key: 'ip', label: 'IP', sortable: true, mono: true, render: function (device) {
          return el('span', { class: 'u-mono', text: device.ip || '—' });
        } },
        { key: 'vlan', label: 'VLAN', sortable: true, render: vlanCell },
        { key: 'name', label: 'Tên', sortable: true, render: nameCell },
        { key: 'model', label: 'Model', sortable: true, render: modelCell },
        { key: 'mac', label: 'MAC', mono: true, render: function (device) { return device.mac || '—'; } },
        { key: 'serial', label: 'Serial', mono: true, render: function (device) { return device.serial || '—'; } },
        { key: 'firmware', label: 'Firmware', render: function (device) { return device.firmware || '—'; } },
        { key: 'http_port', label: 'Cổng', sortable: true, render: portsCell },
        { key: 'vendor', label: 'Hãng', sortable: true, render: function (device) { return device.vendor || '—'; } },
        { key: 'discovery_proto', label: 'Giao thức', render: protocolCell },
        { key: 'status', label: 'Trạng thái', render: statusCell },
        { key: 'actions', label: 'Hành động', align: 'right', render: actionCell }
      ],
      rows: [],
      loading: false,
      selectable: true,
      rowKey: function (device) { return deviceKey(device); },
      mobile: 'cards',
      caption: 'Thiết bị tìm thấy trong mạng nội bộ',
      testId: 'scanner-results',
      sort: { key: sort.key, dir: sort.dir },
      emptyNode: emptyHost,
      onSort: function (key, dir) {
        sort = { key: key, dir: dir };
        page = 1;
        renderResults();
      },
      onRowClick: function (device) { openDeviceDetails(device); },
      onSelectionChange: function (keys) {
        var pageKeys = {};
        currentRows.forEach(function (device) { pageKeys[deviceKey(device)] = true; });
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

  /* ------------------------------ Scan form ---------------------------- */

  function updateFormBusy(busy) {
    if (refs.subnet) { refs.subnet.setDisabled(busy); }
    if (refs.vlanField) { refs.vlanField.setDisabled(busy); }
    if (refs.timeoutField) { refs.timeoutField.setDisabled(busy); }
    if (refs.deepSwitch) { refs.deepSwitch.setDisabled(busy); }
    if (refs.detectBtn) { refs.detectBtn.disabled = busy || vlanBusy; }
    if (refs.startBtn) {
      refs.startBtn.disabled = busy;
      if (busy) { refs.startBtn.setAttribute('aria-busy', 'true'); }
      else { refs.startBtn.removeAttribute('aria-busy'); }
    }
    if (refs.cancelBtn) { refs.cancelBtn.hidden = !busy; }
    if (refs.chipHost) {
      var chips = refs.chipHost.querySelectorAll('button[data-vlan-value]');
      for (var i = 0; i < chips.length; i += 1) { chips[i].disabled = busy; }
    }
  }

  function showProgress() {
    if (!refs.scanStateHost) { return; }
    refs.scanStateHost.hidden = false;
    clear(refs.scanStateHost);
    scanState.elapsed = 0;
    var wrap = el('div', { class: 'c-stack c-stack--sm' });
    var row = el('div', { class: 'c-row' });
    var icon = svg('loader', { size: 16 });
    icon.classList.add('c-spin');
    row.appendChild(icon);
    scanState.statusText = el('span', { text: 'Đang quét mạng… (0 giây)' });
    row.appendChild(scanState.statusText);
    wrap.appendChild(row);
    scanState.progress = ui.progress({
      label: 'Tiến trình quét',
      value: 0,
      max: 100,
      ariaLabel: 'Tiến trình quét mạng',
      valueText: function () { return scanState.elapsed + ' giây'; }
    });
    wrap.appendChild(scanState.progress.el);
    refs.scanStateHost.appendChild(wrap);
  }

  function clearProgress() {
    if (scanState.stopProgress) {
      try { scanState.stopProgress(); } catch (err) { /* bỏ qua */ }
      scanState.stopProgress = null;
    }
    scanState.progress = null;
    scanState.statusText = null;
    if (refs.scanStateHost) {
      clear(refs.scanStateHost);
      refs.scanStateHost.hidden = true;
    }
  }

  function finishScan() {
    scanState.busy = false;
    scanState.controller = null;
    clearProgress();
    if (!destroyed) { updateFormBusy(false); }
  }

  function startProgressTicker() {
    scanState.stopProgress = CCTV.poll(function () {
      if (!scanState.busy) { return; }
      scanState.elapsed = Math.max(0, Math.floor((Date.now() - scanState.startedAt) / 1000));
      if (scanState.statusText) {
        scanState.statusText.textContent = 'Đang quét mạng… (' + scanState.elapsed + ' giây)';
      }
      if (scanState.progress) {
        scanState.progress.setValue(Math.min(95, scanState.elapsed * 4), 100);
      }
    }, { intervalMs: 1000, immediate: true, pauseWhenHidden: true, maxBackoffMs: 5000 });
  }

  function handleScanError(err) {
    if (!err || err.code === 'ABORTED') { return; }
    if (err.code === 'INVALID_SUBNET' && refs.subnet) {
      refs.subnet.setError(err.message || 'Dải mạng không hợp lệ.');
      refs.subnet.focus();
      return;
    }
    if (err.code === 'SCAN_IN_PROGRESS') {
      showStatus('warning', 'Đang có lượt quét khác', detailText(err), startScan);
      return;
    }
    if (err.code === 'TEST_MODE_BLOCKED') {
      showStatus('warning', 'Chế độ kiểm thử', detailText(err));
      return;
    }
    if (err.code === 'RATE_LIMITED') {
      showStatus('warning', 'Quét quá nhanh', detailText(err), startScan);
      return;
    }
    showStatus('danger', 'Không quét được mạng', detailText(err), startScan);
  }

  function startScan() {
    if (!ctx || destroyed || scanState.busy) { return; }
    clearStatus();
    if (refs.subnet) { refs.subnet.clearError(); }
    var subnet = refs.subnet ? String(refs.subnet.getValue() || '').trim() : '';
    var deep = refs.deepSwitch ? refs.deepSwitch.isChecked() : false;
    var timeoutSeconds = Math.max(10, Math.min(300, toNumber(refs.timeoutField ? refs.timeoutField.getValue() : '', 120) || 120));

    scanState.busy = true;
    scanState.seq += 1;
    var seq = scanState.seq;
    scanState.controller = new AbortController();
    scanState.startedAt = Date.now();
    updateFormBusy(true);
    showProgress();
    startProgressTicker();

    ctx.api.get('/api/scan', {
      query: { subnet: subnet, deep: deep ? '1' : '0' },
      signal: scanState.controller.signal,
      silent: true,
      timeoutMs: timeoutSeconds * 1000
    }).then(function (data) {
      if (destroyed || seq !== scanState.seq) { return; }
      finishScan();
      var list = data && Array.isArray(data.devices) ? data.devices : [];
      devices = list;
      scanMeta = {
        scannedAt: data && data.scanned_at ? String(data.scanned_at) : null,
        targets: data ? toNumber(data.targets, 0) : 0,
        durationMs: data ? toNumber(data.duration_ms, 0) : 0,
        truncated: !!(data && data.truncated)
      };
      selected = new Set();
      page = 1;
      if (ctx) {
        ctx.state.set('scan', {
          devices: devices,
          scannedAt: scanMeta.scannedAt,
          targets: scanMeta.targets,
          durationMs: scanMeta.durationMs,
          truncated: scanMeta.truncated
        });
      }
      updateModelOptions();
      renderResults();
      if (scanMeta.truncated) {
        showStatus('warning', 'Kết quả có thể chưa đầy đủ', 'Máy chủ đã giới hạn số mục tiêu quét. Thu hẹp dải mạng để có kết quả đầy đủ hơn.');
        ui.toast('Đã quét xong nhưng danh sách có thể bị cắt.', { type: 'warning' });
      } else {
        ui.toast('Tìm thấy ' + devices.length + ' thiết bị.', {
          type: devices.length ? 'success' : 'info'
        });
      }
    }).catch(function (err) {
      if (destroyed || seq !== scanState.seq) { return; }
      finishScan();
      handleScanError(err);
    });
  }

  function cancelScan() {
    if (!scanState.busy) { return; }
    var controller = scanState.controller;
    scanState.seq += 1;
    finishScan();
    if (controller) {
      try { controller.abort(); } catch (err) { /* bỏ qua */ }
    }
    ui.toast('Đã huỷ yêu cầu quét phía trình duyệt. Máy chủ có thể vẫn hoàn tất lượt đang chạy.', {
      type: 'info',
      duration: 6000
    });
  }

  /* ------------------------------- Export ------------------------------ */

  function exportCsv() {
    if (!ctx || destroyed) { return; }
    if (!devices.length) {
      ui.toast('Chưa có kết quả quét để xuất CSV.', { type: 'warning' });
      return;
    }
    var button = refs.exportBtn;
    if (button) { ui.busy(button, true, 'Đang xuất…'); }
    ctx.api.getBlob('/api/export', {
      signal: ctx.signal,
      silent: true,
      timeoutMs: 30000
    }).then(function (result) {
      if (destroyed) { return; }
      ui.downloadBlob(result.blob, result.filename || 'cctv_cameras.csv');
      ui.toast('Đã xuất CSV.', { type: 'success' });
    }).catch(function (err) {
      if (!err || err.code === 'ABORTED') { return; }
      showApiError(err, 'Không xuất được CSV.');
    }).then(function () {
      if (button) { ui.busy(button, false); }
    });
  }

  /* ----------------------------- Add to NVR ---------------------------- */

  function deviceToManaged(device, group, armed) {
    var output = {
      ip: device.ip,
      name: device.name || device.model || ('Camera ' + device.ip),
      model: device.model || '',
      mac: device.mac || '',
      serial: device.serial || '',
      firmware: device.firmware || '',
      vendor: device.vendor || '',
      vlan: device.vlan || '',
      vlan_id: device.vlan_id || '',
      is_solar: !!device.is_solar,
      alarm_armed: !!armed
    };
    var httpPort = toNumber(device.http_port, 0);
    var tcpPort = toNumber(device.tcp_port, 0);
    if (httpPort >= 1 && httpPort <= 65535) { output.http_port = httpPort; }
    if (tcpPort >= 1 && tcpPort <= 65535) { output.tcp_port = tcpPort; }
    if (group) { output.group = group; }
    return output;
  }

  function showAddResult(data) {
    var body = el('div', { class: 'c-stack' });
    var added = toNumber(data && data.added_count, 0);
    var updated = toNumber(data && data.updated_count, 0);
    var total = toNumber(data && data.total, added + updated);
    body.appendChild(ui.banner({
      tone: 'success',
      title: 'Đã xử lý ' + total + ' thiết bị',
      message: (data && data.message) || ('Thêm mới ' + added + ', cập nhật ' + updated + '.')
    }));
    body.appendChild(kvBlock([
      ['Thêm mới', added],
      ['Cập nhật', updated]
    ]));
    var errors = data && Array.isArray(data.errors) ? data.errors : [];
    if (errors.length) {
      body.appendChild(ui.banner({
        tone: 'warning',
        title: errors.length + ' thiết bị chưa được thêm',
        message: 'Kiểm tra mật khẩu mặc định hoặc thông tin thiết bị.'
      }));
      var list = el('ul', { class: 'c-stack c-stack--sm' });
      errors.slice(0, 50).forEach(function (message) {
        list.appendChild(el('li', { text: String(message) }));
      });
      if (errors.length > 50) {
        list.appendChild(el('li', { class: 'u-muted', text: '… và ' + (errors.length - 50) + ' lỗi khác.' }));
      }
      body.appendChild(list);
    }
    var handle = ui.modal({
      title: 'Kết quả thêm vào NVR',
      body: body,
      size: 'md',
      dismissible: true,
      footer: [ui.button({
        label: 'Đóng',
        variant: 'primary',
        onClick: function () { handle.close(); }
      })]
    });
    openLayers.push(handle);
  }

  function openAddDialog(list) {
    if (!ctx || !list.length) { return; }
    if (list.length > 500) {
      ui.toast('Chỉ có thể thêm tối đa 500 thiết bị mỗi lần. Hãy chọn ít hơn.', { type: 'warning' });
      return;
    }
    var modalClosed = false;
    var body = el('div', { class: 'c-stack' });
    body.appendChild(ui.banner({
      tone: 'info',
      title: 'Thêm ' + list.length + ' thiết bị vào NVR',
      message: 'Mật khẩu mặc định chỉ được gửi trong nội dung yêu cầu và không hiển thị lại.'
    }));

    var preview = el('ul', { class: 'c-stack c-stack--sm' });
    list.slice(0, 8).forEach(function (device) {
      preview.appendChild(el('li', {
        text: (device.ip || '—') + ' · ' + (device.name || device.model || 'Không rõ tên')
      }));
    });
    if (list.length > 8) {
      preview.appendChild(el('li', { class: 'u-muted', text: '… và ' + (list.length - 8) + ' thiết bị khác.' }));
    }
    body.appendChild(preview);

    var grid = el('div', { class: 'c-grid c-grid--2' });
    var fPassword = ui.field({
      label: 'Mật khẩu mặc định',
      type: 'password',
      maxlength: 128,
      autocomplete: 'new-password',
      help: 'Để trống nếu máy chủ đã cấu hình mật khẩu mặc định cho camera.'
    });
    var fGroup = ui.field({
      label: 'Nhóm (tuỳ chọn)',
      value: 'Quét mạng',
      maxlength: 32,
      placeholder: 'Quét mạng'
    });
    grid.appendChild(fPassword.el);
    grid.appendChild(fGroup.el);
    body.appendChild(grid);

    var armSwitch = ui.switch({
      checked: true,
      label: 'Gác an ninh',
      description: 'Bật cảnh báo cho các camera được thêm.'
    });
    body.appendChild(armSwitch.el);

    var cancelBtn = ui.button({ label: 'Huỷ', variant: 'secondary', onClick: function () { modal.close(); } });
    var addBtn = ui.button({
      label: 'Thêm vào NVR',
      icon: 'plus',
      variant: 'primary',
      onClick: function () { submit(); }
    });
    var modal = ui.modal({
      title: 'Đưa camera vào NVR',
      subtitle: list.length + ' thiết bị từ kết quả quét',
      body: body,
      footer: [cancelBtn, addBtn],
      size: 'lg',
      dismissible: true,
      initialFocus: fPassword.input,
      onClose: function () {
        modalClosed = true;
        fPassword.setValue('');
      }
    });
    openLayers.push(modal);

    function submit() {
      if (modalClosed) { return; }
      var group = String(fGroup.getValue() || '').trim();
      var batch = list.map(function (device) {
        return deviceToManaged(device, group, armSwitch.isChecked());
      });
      modal.setError('');
      modal.setBusy(true);
      ctx.api.post('/api/managed/cameras', {
        batch: batch,
        default_password: fPassword.getValue()
      }, { signal: ctx.signal, silent: true, timeoutMs: 60000 }).then(function (data) {
        fPassword.setValue('');
        if (destroyed) { return; }
        if (modalClosed) {
          ui.toast('Đã gửi yêu cầu thêm camera vào NVR.', { type: 'success' });
          return;
        }
        modal.close();
        selected = new Set();
        renderResults();
        showAddResult(data || {});
        if (ctx) {
          ctx.state.refresh('cameras').then(function () { return null; }).catch(function () { return null; });
        }
      }).catch(function (err) {
        if (modalClosed || destroyed) { return; }
        modal.setBusy(false);
        if (err && err.code === 'ABORTED') { return; }
        modal.setError(err && err.message ? err.message : 'Không thêm được camera vào NVR.');
      });
    }
  }

  /* ---------------------------- Batch actions -------------------------- */

  function selectedIps() {
    return selectedDevices().map(function (device) { return device.ip; })
      .filter(function (ip) { return !!ip; });
  }

  function reportBatchResult(verb, data) {
    var results = Array.isArray(data && data.results) ? data.results : [];
    var success = Number(data && data.success_count);
    if (!isFinite(success)) {
      success = results.filter(function (item) { return item && item.ok; }).length;
    }
    var total = Number(data && data.total);
    if (!isFinite(total)) { total = results.length; }
    var failures = results.filter(function (item) { return item && item.ok === false; });
    var message = success + '/' + total + ' thiết bị ' + verb + ' thành công.';
    if (failures.length) {
      ui.toast(message + ' ' + failures.length + ' thiết bị lỗi.', { type: 'warning', duration: 7000 });
    } else {
      ui.toast(message, { type: 'success' });
    }
  }

  function openBatchIpModal() {
    var list = selectedDevices();
    if (!list.length) { return; }
    var modalClosed = false;
    var body = el('div', { class: 'c-stack' });
    body.appendChild(ui.banner({
      tone: 'warning',
      title: 'Đổi địa chỉ IP hàng loạt',
      message: 'Áp dụng cho ' + list.length + ' thiết bị: '
        + list.map(function (device) { return device.ip; }).join(', ')
        + '. Camera có thể mất kết nối sau khi đổi IP.'
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
    var fNetmask = ui.field({ label: 'Subnet mask', mono: true, value: '255.255.255.0' });
    var fGateway = ui.field({ label: 'Gateway (tuỳ chọn)', mono: true, placeholder: '192.168.1.1' });
    var fUser = ui.field({
      label: 'Username camera (tuỳ chọn)',
      maxlength: 64,
      autocomplete: 'off',
      help: 'Để trống để máy chủ dùng thông tin đã lưu.'
    });
    var fPass = ui.field({
      label: 'Mật khẩu camera (tuỳ chọn)',
      type: 'password',
      maxlength: 128,
      autocomplete: 'current-password'
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
    [fMode, fStart, fNetmask, fGateway, fUser, fPass].forEach(function (field) {
      grid.appendChild(field.el);
    });
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
      subtitle: list.length + ' thiết bị được chọn',
      body: body,
      footer: [cancelBtn, saveBtn],
      size: 'lg',
      dismissible: true,
      initialFocus: fStart.input,
      onClose: function () { modalClosed = true; }
    });
    openLayers.push(modal);

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
      if (staticMode && !isPrivateIPv4(fieldValueTrim(fStart))) {
        fStart.setError('IP bắt đầu phải là IPv4 nội bộ hợp lệ.');
        return;
      }
      if (fieldValueTrim(fConfirm) !== 'DOI-IP') {
        fConfirm.setError('Gõ đúng DOI-IP để xác nhận.');
        return;
      }
      saveBtn.disabled = true;
      modal.setError('');
      var payload = {
        ips: selectedIps(),
        is_dhcp: !staticMode,
        start_ip: staticMode ? fieldValueTrim(fStart) : '',
        netmask: staticMode ? fieldValueTrim(fNetmask) : '255.255.255.0',
        gateway: staticMode ? fieldValueTrim(fGateway) : '',
        auto_reboot: autoReboot.isChecked(),
        confirm: true
      };
      if (fieldValueTrim(fUser)) { payload.username = fieldValueTrim(fUser); }
      if (fPass.getValue()) { payload.password = fPass.getValue(); }
      ctx.api.post('/api/batch-ip', payload, {
        signal: ctx.signal, silent: true, timeoutMs: 120000
      }).then(function (data) {
        if (destroyed) { return; }
        modal.close();
        reportBatchResult('đổi IP', data);
      }).catch(function (err) {
        if (modalClosed || destroyed) { return; }
        saveBtn.disabled = false;
        modal.setError(err && err.message ? err.message : 'Không đổi được IP camera.');
      });
    }
  }

  function rebootSelection() {
    var ips = selectedIps();
    if (!ips.length) { return; }
    ctx.confirm({
      title: 'Khởi động lại camera',
      message: 'Khởi động lại ' + ips.length + ' thiết bị đã chọn?',
      details: el('p', { class: 'c-muted-block', text: ips.join(', ') }),
      confirmLabel: 'Khởi động lại',
      cancelLabel: 'Huỷ',
      variant: 'danger',
      requireText: 'REBOOT',
      requireTextLabel: 'Gõ REBOOT để xác nhận'
    }).then(function (confirmed) {
      if (!confirmed || !ctx) { return null; }
      return ctx.api.post('/api/reboot', { ips: ips, confirm: true }, {
        signal: ctx.signal, silent: true, timeoutMs: 120000
      }).then(function (data) {
        if (destroyed) { return; }
        reportBatchResult('khởi động lại', data);
      }).catch(function (err) {
        showApiError(err, 'Không gửi được lệnh khởi động lại.');
      });
    });
  }

  function syncTimeSelection() {
    var ips = selectedIps();
    if (!ips.length) { return; }
    ctx.confirm({
      title: 'Đồng bộ giờ camera',
      message: 'Đồng bộ giờ cho ' + ips.length + ' thiết bị theo múi giờ GMT+07:00?',
      confirmLabel: 'Đồng bộ giờ',
      cancelLabel: 'Huỷ'
    }).then(function (confirmed) {
      if (!confirmed || !ctx) { return null; }
      return ctx.api.post('/api/sync-time', {
        ips: ips,
        timezone: 'GMT+07:00'
      }, { signal: ctx.signal, silent: true, timeoutMs: 120000 }).then(function (data) {
        if (destroyed) { return; }
        reportBatchResult('đồng bộ giờ', data);
      }).catch(function (err) {
        showApiError(err, 'Không đồng bộ được giờ camera.');
      });
    });
  }

  function openBatchPasswordModal() {
    var list = selectedDevices();
    if (!list.length) { return; }
    var modalClosed = false;
    var body = el('div', { class: 'c-stack' });
    body.appendChild(ui.banner({
      tone: 'warning',
      title: 'Đổi mật khẩu camera hàng loạt',
      message: 'Áp dụng cho ' + list.length + ' thiết bị. Mật khẩu mới không bao giờ được hiển thị lại.'
    }));
    var fUser = ui.field({
      label: 'Username camera (tuỳ chọn)',
      maxlength: 64,
      autocomplete: 'off'
    });
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
    [fUser, fNew, fConfirmNew, fOld].forEach(function (field) {
      grid.appendChild(field.el);
    });
    body.appendChild(grid);
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
      subtitle: list.length + ' thiết bị được chọn',
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
    fConfirm.input.addEventListener('input', function () {
      saveBtn.disabled = fieldValueTrim(fConfirm) !== 'DOI-MAT-KHAU';
    });

    function submit() {
      if (modalClosed) { return; }
      fNew.clearError();
      fConfirmNew.clearError();
      var password = fNew.getValue();
      if (password.length < 8) {
        fNew.setError('Mật khẩu mới phải có ít nhất 8 ký tự.');
        return;
      }
      if (password !== fConfirmNew.getValue()) {
        fConfirmNew.setError('Mật khẩu nhập lại không khớp.');
        return;
      }
      if (fieldValueTrim(fConfirm) !== 'DOI-MAT-KHAU') {
        fConfirm.setError('Gõ đúng DOI-MAT-KHAU để xác nhận.');
        return;
      }
      saveBtn.disabled = true;
      modal.setError('');
      var payload = {
        ips: selectedIps(),
        old_password: fOld.getValue(),
        new_password: password,
        confirm: true
      };
      if (fieldValueTrim(fUser)) { payload.username = fieldValueTrim(fUser); }
      ctx.api.post('/api/batch_change_password', payload, {
        signal: ctx.signal, silent: true, timeoutMs: 120000
      }).then(function (data) {
        if (destroyed) { return; }
        fNew.setValue('');
        fConfirmNew.setValue('');
        fOld.setValue('');
        modal.close();
        reportBatchResult('đổi mật khẩu', data);
      }).catch(function (err) {
        if (modalClosed || destroyed) { return; }
        saveBtn.disabled = false;
        modal.setError(err && err.message ? err.message : 'Không đổi được mật khẩu camera.');
      });
    }
  }

  /* --------------------------- Storage details ------------------------- */

  function askCameraCredentials(device, onSaved) {
    var fUser = ui.field({ label: 'Username', value: 'admin', maxlength: 64, autocomplete: 'username' });
    var fPass = ui.field({ label: 'Mật khẩu camera', type: 'password', maxlength: 128, autocomplete: 'current-password' });
    var modalClosed = false;
    var body = el('div', { class: 'c-stack' });
    body.appendChild(ui.banner({
      tone: 'info',
      title: 'Thông tin đăng nhập tạm thời',
      message: 'Chỉ lưu trong phiên hiện tại và không hiển thị lại.'
    }));
    body.appendChild(fUser.el);
    body.appendChild(fPass.el);
    var cancelBtn = ui.button({ label: 'Huỷ', variant: 'secondary', onClick: function () { modal.close(); } });
    var saveBtn = ui.button({
      label: 'Lưu & thử lại',
      icon: 'key',
      variant: 'primary',
      onClick: function () {
        saveBtn.disabled = true;
        modal.setError('');
        ctx.api.post('/api/cameras/credentials', {
          ip: device.ip,
          username: fieldValueTrim(fUser) || 'admin',
          password: fPass.getValue()
        }, { signal: ctx.signal, silent: true }).then(function () {
          if (modalClosed) { return; }
          modal.close();
          if (typeof onSaved === 'function') { onSaved(); }
        }).catch(function (err) {
          if (modalClosed) { return; }
          saveBtn.disabled = false;
          modal.setError(err && err.message ? err.message : 'Không lưu được thông tin camera.');
        });
      }
    });
    var modal = ui.modal({
      title: 'Nhập mật khẩu camera',
      subtitle: device.ip,
      body: body,
      footer: [cancelBtn, saveBtn],
      size: 'sm',
      dismissible: true,
      initialFocus: fPass.input,
      onClose: function () {
        modalClosed = true;
        fPass.setValue('');
      }
    });
    openLayers.push(modal);
  }

  function openStorageDetails(device) {
    if (!ctx || !device || !device.ip) { return; }
    var content = el('div', { class: 'c-stack' });
    var handle = ui.modal({
      title: 'Thẻ nhớ — ' + (device.name || device.ip),
      subtitle: device.ip,
      body: content,
      size: 'md',
      dismissible: true,
      footer: [ui.button({ label: 'Đóng', variant: 'primary', onClick: function () { handle.close(); } })]
    });
    openLayers.push(handle);

    function load() {
      clear(content);
      content.appendChild(ui.skeleton({ variant: 'text', rows: 3 }));
      ctx.api.get('/api/storage/info', {
        query: { ip: device.ip },
        signal: ctx.signal,
        silent: true
      }).then(function (info) {
        if (destroyed) { return; }
        clear(content);
        if (!info || info.has_sd === false) {
          content.appendChild(ui.banner({
            tone: 'neutral',
            title: 'Không có thẻ nhớ',
            message: (info && info.status_text) || 'Camera không báo cáo thẻ nhớ MicroSD.'
          }));
          return;
        }
        content.appendChild(kvBlock([
          ['Thiết bị', info.device],
          ['Tổng dung lượng', fmt.bytes ? fmt.bytes(info.total_bytes) : (info.total_gb + ' GB')],
          ['Đã dùng', fmt.bytes ? fmt.bytes(info.used_bytes) : (info.used_gb + ' GB')],
          ['Còn trống', fmt.bytes ? fmt.bytes(info.free_bytes) : (info.free_gb + ' GB')],
          ['Tình trạng', info.status_text],
          ['Sản phẩm', info.product_name]
        ]));
      }).catch(function (err) {
        if (destroyed) { return; }
        clear(content);
        if (err && err.code === 'CAMERA_CREDENTIAL_REQUIRED') {
          content.appendChild(ui.banner({
            tone: 'warning',
            title: 'Chưa có mật khẩu camera',
            message: 'Cần thông tin đăng nhập camera để đọc thẻ nhớ.',
            actions: [ui.button({
              label: 'Nhập mật khẩu',
              icon: 'key',
              variant: 'secondary',
              onClick: function () { askCameraCredentials(device, load); }
            })]
          }));
          return;
        }
        content.appendChild(ui.banner({
          tone: err && err.code === 'TEST_MODE_BLOCKED' ? 'warning' : 'danger',
          title: 'Không đọc được thẻ nhớ',
          message: (err && err.message) || 'Camera không phản hồi.'
        }));
      });
    }
    load();
  }

  /* --------------------------- Device details -------------------------- */

  function openDeviceDetails(device) {
    if (!ctx || !device) { return; }
    var body = el('div', { class: 'c-stack' });
    var statusRow = el('div', { class: 'c-row c-row--wrap' });
    statusRow.appendChild(ui.statusPill(device.status || 'online'));
    if (device.is_solar) { statusRow.appendChild(ui.badge('Năng lượng mặt trời', { tone: 'info' })); }
    if (device.onvif_supported) { statusRow.appendChild(ui.badge('ONVIF', { tone: 'primary' })); }
    body.appendChild(statusRow);
    body.appendChild(kvBlock([
      ['Địa chỉ IP', device.ip, true],
      ['Tên thiết bị', device.name],
      ['Model', device.model],
      ['Lớp thiết bị', device['class']],
      ['Hãng', device.vendor],
      ['MAC', device.mac, true],
      ['Serial', device.serial, true],
      ['Firmware', device.firmware],
      ['VLAN', device.vlan],
      ['VLAN ID', device.vlan_id, true],
      ['Gateway', device.gateway, true],
      ['Subnet mask', device.netmask, true],
      ['Chế độ IP', device.dhcp],
      ['Cổng HTTP', device.http_port],
      ['Cổng TCP', device.tcp_port],
      ['Giao thức', protocolCell(device)]
    ]));

    var footer = [
      ui.button({
        label: 'Thêm vào NVR',
        icon: 'plus',
        variant: 'primary',
        onClick: function () { handle.close(); openAddDialog([device]); }
      }),
      ui.button({
        label: 'Xem trực tiếp',
        icon: 'live',
        variant: 'secondary',
        onClick: function () { handle.close(); openLive(device); }
      })
    ];
    var handle = ui.modal({
      title: device.name || device.ip,
      subtitle: device.ip,
      body: body,
      footer: footer,
      size: 'md',
      dismissible: true
    });
    openLayers.push(handle);
  }

  /* ------------------------------- Layout ------------------------------ */

  function buildFilters() {
    refs.search = ui.search({
      placeholder: 'Lọc IP, tên, model, MAC, serial, VLAN…',
      ariaLabel: 'Tìm kiếm thiết bị quét được',
      onInput: function (value) {
        filters.q = value;
        page = 1;
        renderResults();
      }
    });
    refs.modelField = ui.field({
      label: 'Model',
      type: 'select',
      options: [{ value: '', label: 'Tất cả model' }],
      value: ''
    });
    refs.modelField.input.addEventListener('change', function () {
      filters.model = refs.modelField.getValue();
      page = 1;
      renderResults();
    });
    var clearBtn = ui.button({
      label: 'Xoá lọc',
      icon: 'x',
      variant: 'ghost',
      size: 'sm',
      onClick: function () {
        filters = { q: '', model: '' };
        refs.search.clear();
        refs.modelField.setValue('');
        page = 1;
        renderResults();
        refs.search.focus();
      }
    });
    refs.search.el.classList.add('u-grow');
    refs.filterBar = ui.toolbar({
      left: [refs.search.el, refs.modelField.el],
      right: [clearBtn]
    });
    refs.filterBar.classList.add('u-mb-16');
  }

  function buildForm() {
    var card = el('section', { class: 'c-card' });
    var header = el('div', { class: 'c-card__header' });
    var titleWrap = el('div');
    var title = el('div', { class: 'c-card__title' });
    title.appendChild(svg('scanner', { size: 16 }));
    title.appendChild(el('span', { text: 'Phạm vi quét' }));
    titleWrap.appendChild(title);
    titleWrap.appendChild(el('div', {
      class: 'c-card__subtitle',
      text: 'Dahua/Imou, ONVIF WS-Discovery và Hikvision SADP trong mạng nội bộ'
    }));
    header.appendChild(titleWrap);
    card.appendChild(header);

    var body = el('div', { class: 'c-card__body c-stack' });
    refs.subnet = ui.field({
      label: 'Dải mạng / IP',
      mono: true,
      testId: 'scanner-subnet',
      placeholder: '192.168.1.0/24 hoặc 192.168.1.10-60, 10.0.0.0/24',
      help: 'Tối đa 8 biểu thức CIDR/dải/IP đơn, cách nhau bằng dấu phẩy. Chỉ IPv4 nội bộ, tổng tối đa 1024 host.'
    });
    refs.subnet.input.addEventListener('input', function () {
      subnetPrefilled = true;
      updateChipActive();
    });
    body.appendChild(refs.subnet.el);

    var grid = el('div', { class: 'c-grid c-grid--2' });
    refs.vlanField = ui.field({
      label: 'VLAN',
      type: 'select',
      options: [{ value: '', label: 'Theo dải nhập tay' }],
      value: ''
    });
    refs.vlanField.input.addEventListener('change', function () {
      var value = refs.vlanField.getValue();
      if (value) { setSubnet(value); }
    });
    refs.timeoutField = ui.field({
      label: 'Thời gian chờ tối đa (giây)',
      type: 'number',
      min: 10,
      max: 300,
      value: 120,
      help: 'Huỷ yêu cầu phía trình duyệt sau khoảng thời gian này.'
    });
    grid.appendChild(refs.vlanField.el);
    grid.appendChild(refs.timeoutField.el);
    body.appendChild(grid);

    refs.vlanHint = el('p', { class: 'c-muted-block', text: 'Chưa dò VLAN. Bấm "Dò VLAN" để lấy danh sách từ máy chủ.' });
    body.appendChild(refs.vlanHint);

    refs.chipHost = el('div', { class: 'c-chip-row', attrs: { role: 'group', 'aria-label': 'VLAN nhanh' } });
    refs.chipHost.hidden = true;
    body.appendChild(refs.chipHost);

    var controls = el('div', { class: 'c-row c-row--wrap c-row--between' });
    var leftControls = el('div', { class: 'c-row c-row--wrap' });
    refs.deepSwitch = ui.switch({
      checked: false,
      label: 'Quét sâu',
      description: 'Dò unicast từng địa chỉ, chậm hơn nhưng phát hiện nhiều thiết bị hơn.',
      testId: 'scanner-deep'
    });
    refs.deepSwitch.input.addEventListener('change', function () { deepTouched = true; });
    leftControls.appendChild(refs.deepSwitch.el);

    var rightControls = el('div', { class: 'c-row c-row--wrap' });
    refs.detectBtn = ui.button({
      label: 'Dò VLAN',
      icon: 'network',
      variant: 'secondary',
      testId: 'scanner-detect-vlans',
      onClick: detectVlans
    });
    refs.startBtn = ui.button({
      label: 'Bắt đầu quét',
      icon: 'scanner',
      variant: 'primary',
      testId: 'scanner-start-btn',
      onClick: startScan
    });
    refs.cancelBtn = ui.button({
      label: 'Huỷ',
      icon: 'x',
      variant: 'danger',
      testId: 'scanner-cancel-btn',
      onClick: cancelScan
    });
    refs.cancelBtn.hidden = true;
    rightControls.appendChild(refs.detectBtn);
    rightControls.appendChild(refs.startBtn);
    rightControls.appendChild(refs.cancelBtn);
    controls.appendChild(leftControls);
    controls.appendChild(rightControls);
    body.appendChild(controls);

    refs.serverHint = el('p', { class: 'c-muted-block', text: 'Máy chủ dùng thời gian quét mặc định.' });
    body.appendChild(refs.serverHint);

    refs.scanStateHost = el('div');
    refs.scanStateHost.hidden = true;
    body.appendChild(refs.scanStateHost);

    card.appendChild(body);
    return card;
  }

  function buildResultsCard() {
    var card = el('section', { class: 'c-card' });
    var header = el('div', { class: 'c-card__header' });
    var titleWrap = el('div');
    var title = el('div', { class: 'c-card__title' });
    title.appendChild(svg('list', { size: 16 }));
    title.appendChild(el('span', { text: 'Thiết bị tìm thấy' }));
    titleWrap.appendChild(title);
    refs.resultsMeta = el('div', { class: 'c-card__subtitle', text: 'Chưa có lượt quét nào trong phiên này.' });
    titleWrap.appendChild(refs.resultsMeta);
    header.appendChild(titleWrap);
    refs.exportBtn = ui.button({
      label: 'Xuất CSV',
      icon: 'download',
      variant: 'secondary',
      testId: 'scanner-export',
      onClick: exportCsv
    });
    header.appendChild(refs.exportBtn);
    card.appendChild(header);

    var body = el('div', { class: 'c-card__body c-card__body--flush' });

    refs.batchBar = el('div', {
      class: 'c-banner',
      attrs: { 'data-tone': 'info', 'data-admin-only': '1' }
    });
    refs.batchBar.hidden = true;
    var batchIcon = el('span', { class: 'c-banner__icon' });
    batchIcon.appendChild(svg('layers', { size: 18 }));
    refs.batchBar.appendChild(batchIcon);
    var batchBody = el('div', { class: 'c-banner__body' });
    refs.batchCount = el('div', { class: 'c-banner__title', text: 'Đã chọn 0 thiết bị' });
    batchBody.appendChild(refs.batchCount);
    batchBody.appendChild(el('div', {
      class: 'c-banner__message',
      text: 'Thêm vào NVR hoặc thao tác hàng loạt (tối đa 100 thiết bị mỗi lần).'
    }));
    var batchActions = el('div', { class: 'c-banner__actions' });
    refs.batchAddBtn = ui.button({
      label: 'Thêm vào NVR',
      icon: 'plus',
      variant: 'primary',
      size: 'sm',
      testId: 'scanner-batch-add',
      onClick: function () { openAddDialog(selectedDevices()); }
    });
    refs.batchIpBtn = ui.button({
      label: 'Đổi IP',
      icon: 'network',
      variant: 'secondary',
      size: 'sm',
      testId: 'scanner-batch-ip',
      onClick: openBatchIpModal
    });
    refs.batchRebootBtn = ui.button({
      label: 'Reboot',
      icon: 'power',
      variant: 'secondary',
      size: 'sm',
      testId: 'scanner-batch-reboot',
      onClick: rebootSelection
    });
    refs.batchSyncBtn = ui.button({
      label: 'Đồng bộ giờ',
      icon: 'clock',
      variant: 'secondary',
      size: 'sm',
      testId: 'scanner-batch-sync-time',
      onClick: syncTimeSelection
    });
    refs.batchPasswordBtn = ui.button({
      label: 'Đổi mật khẩu',
      icon: 'key',
      variant: 'secondary',
      size: 'sm',
      testId: 'scanner-batch-password',
      onClick: openBatchPasswordModal
    });
    var clearBtn = ui.button({
      label: 'Bỏ chọn',
      icon: 'x',
      variant: 'ghost',
      size: 'sm',
      onClick: clearSelection
    });
    [refs.batchAddBtn, refs.batchIpBtn, refs.batchRebootBtn,
      refs.batchSyncBtn, refs.batchPasswordBtn, clearBtn].forEach(function (button) {
      batchActions.appendChild(button);
    });
    batchBody.appendChild(batchActions);
    refs.batchBar.appendChild(batchBody);
    var batchWrap = el('div', { class: 'c-card__body' });
    batchWrap.hidden = true;
    batchWrap.appendChild(refs.batchBar);
    refs.batchWrap = batchWrap;
    body.appendChild(batchWrap);

    var filtersWrap = el('div', { class: 'c-card__body' });
    buildFilters();
    filtersWrap.appendChild(refs.filterBar);
    body.appendChild(filtersWrap);

    refs.tableHost = el('div');
    body.appendChild(refs.tableHost);

    var footer = el('div', { class: 'c-card__footer' });
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
        renderResults();
      }
    });
    footer.appendChild(pagination.el);
    var note = el('p', {
      class: 'c-muted-block u-mt-8',
      text: 'Xuất CSV lấy toàn bộ kết quả quét gần nhất trên máy chủ (không chỉ trang hiện tại).'
    });
    footer.appendChild(note);
    card.appendChild(body);
    card.appendChild(footer);
    return card;
  }

  function selectedDevices() {
    var list = [];
    devices.forEach(function (device) {
      if (selected.has(deviceKey(device))) { list.push(device); }
    });
    return list;
  }

  function buildLayout() {
    clear(viewRoot);
    refs = {};
    pageSize = Number(ctx.state.getUi('pageSize', 15));
    if (PAGE_SIZES.indexOf(pageSize) === -1) { pageSize = 15; }
    page = 1;
    selected = new Set();
    filters = { q: '', model: '' };
    sort = { key: 'ip', dir: 'asc' };
    openLayers = [];

    var header = ui.pageHeader({
      title: 'Quét mạng',
      subtitle: 'Dò camera Dahua/Imou, ONVIF và Hikvision SADP trong mạng nội bộ',
      icon: 'scanner'
    });
    viewRoot.appendChild(header);

    refs.statusHost = el('div');
    refs.statusHost.hidden = true;
    viewRoot.appendChild(refs.statusHost);

    viewRoot.appendChild(buildForm());

    refs.resultsCard = buildResultsCard();
    viewRoot.appendChild(refs.resultsCard);

    createTable();

    refs.exportBtn.disabled = true;
    updateBatchBar();
    updateEmptyHost(0);
    updateResultsMeta();
  }

  function buildDenied(container) {
    clear(container);
    viewRoot = el('div', { class: 'c-stack view-scanner' });
    container.appendChild(viewRoot);
    viewRoot.appendChild(ui.pageHeader({
      title: 'Quét mạng',
      subtitle: 'Chức năng chỉ dành cho quản trị viên',
      icon: 'scanner'
    }));
    var card = el('div', { class: 'c-card' });
    var body = el('div', { class: 'c-card__body' });
    body.appendChild(ui.empty({
      icon: 'lock',
      title: 'Bạn không có quyền truy cập màn hình này',
      description: 'Màn hình Quét mạng yêu cầu vai trò quản trị viên. Người xem chỉ được xem camera, lưu trữ và cảnh báo.',
      action: [ui.button({
        label: 'Về Tổng quan',
        icon: 'dashboard',
        variant: 'primary',
        onClick: function () { if (ctx) { ctx.router.go('dashboard'); } }
      })]
    }));
    card.appendChild(body);
    viewRoot.appendChild(card);
  }

  /* ------------------------------- Lifecycle --------------------------- */

  function render(container, viewCtx) {
    ctx = viewCtx;
    destroyed = false;
    viewToken += 1;
    vlanBusy = false;
    deepTouched = false;
    subnetPrefilled = false;
    vlans = [];
    devices = [];
    scanMeta = null;
    selected = new Set();
    scanState.busy = false;
    scanState.controller = null;
    scanState.progress = null;
    scanState.statusText = null;
    scanState.stopProgress = null;
    clear(container);

    if (!ctx.isAdmin || !auth || !auth.isAdmin()) {
      buildDenied(container);
      return;
    }

    viewRoot = el('div', { class: 'c-stack view-scanner' });
    container.appendChild(viewRoot);
    buildLayout();
    loadSavedResults();
    loadSettings();
  }

  function destroy() {
    destroyed = true;
    viewToken += 1;
    vlanBusy = false;
    scanState.seq += 1;
    if (scanState.controller) {
      try { scanState.controller.abort(); } catch (err) { /* bỏ qua */ }
      scanState.controller = null;
    }
    scanState.busy = false;
    clearProgress();
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
    devices = [];
    selected = new Set();
    scanMeta = null;
    vlans = [];
    viewRoot = null;
    ctx = null;
  }

  CCTV.views.register('scanner', {
    title: 'Quét mạng',
    icon: 'scanner',
    roles: ['admin'],
    order: 40,
    render: render,
    destroy: destroy
  });
})();
