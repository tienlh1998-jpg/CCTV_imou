/* =========================================================================
   CCTV Vision Hub v2.0 — view Lưu trữ
   Owner: C5. Thẻ nhớ camera, clip trên thẻ, bản ghi trên máy chủ.
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
  var storageSeq = 0;
  var clipsSeq = 0;
  var cameras = [];
  var selectedIp = '';
  var storageInfo = null;
  var storageInfoIp = '';
  var clipsAll = [];
  var clipsDate = todayStr();
  var clipFilter = 'all';
  var clipsTable = null;
  var clipsEmpty = null;
  var recordTable = null;
  var recordEmpty = null;
  var localRecordings = [];
  var finishedRecordings = [];
  var stopRecordPoll = null;
  var openLayers = [];

  var CLIP_FILTERS = [
    { value: 'all', label: 'Tất cả sự kiện' },
    { value: 'motion', label: 'Chuyển động' },
    { value: 'periodic', label: 'Định kỳ / liên tục' },
    { value: 'manual', label: 'Ghi thủ công' },
    { value: 'other', label: 'Sự kiện khác' }
  ];

  /* ------------------------------ Helpers ------------------------------ */

  function isAdmin() {
    if (ctx && typeof ctx.isAdmin === 'boolean') { return ctx.isAdmin; }
    return CCTV.auth.isAdmin();
  }

  function todayStr() {
    try {
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(new Date());
      var map = {};
      parts.forEach(function (part) {
        if (part.type) { map[part.type] = part.value; }
      });
      if (map.year && map.month && map.day) {
        return map.year + '-' + map.month + '-' + map.day;
      }
    } catch (err) {
      /* fallback bên dưới */
    }
    var now = new Date();
    return now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0');
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

  function cameraOptions() {
    var options = [{ value: '', label: cameras.length ? 'Chọn camera…' : 'Chưa có camera nào' }];
    cameras.forEach(function (cam) {
      if (!cam || !cam.ip) { return; }
      var label = (cam.name || cam.model || cam.ip) + ' — ' + cam.ip;
      options.push({ value: cam.ip, label: label });
    });
    return options;
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

  function kvValue(value, mono) {
    var dd = el('dd');
    if (mono) { dd.classList.add('u-mono'); }
    if (value instanceof Node) {
      dd.appendChild(value);
    } else {
      dd.textContent = value === undefined || value === null || value === '' ? '—' : String(value);
    }
    return dd;
  }

  function makeKv(rows) {
    var dl = el('dl', { class: 'c-kv' });
    rows.forEach(function (row) {
      if (!row || row.value === undefined || row.value === null || row.value === '') { return; }
      dl.appendChild(el('dt', { text: row.label }));
      dl.appendChild(kvValue(row.value, row.mono));
    });
    return dl;
  }

  function bytesText(bytes, fallbackGb) {
    if (bytes !== null && bytes !== undefined && bytes !== '') {
      var n = Number(bytes);
      if (isFinite(n) && n >= 0) { return fmt.bytes(n); }
    }
    if (fallbackGb !== null && fallbackGb !== undefined && fallbackGb !== '') {
      var gb = Number(fallbackGb);
      if (isFinite(gb)) { return fmt.number(gb) + ' GB'; }
    }
    return '—';
  }

  function errorText(err, fallback) {
    if (!err) { return fallback || 'Không rõ lỗi.'; }
    if (err.status === 401) { return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'; }
    if (err.status === 403) { return 'Bạn không có quyền thực hiện thao tác này.'; }
    if (err.code === 'CAMERA_CREDENTIAL_REQUIRED') {
      return 'Camera chưa có mật khẩu để đọc thẻ nhớ. Hãy cấu hình mật khẩu camera hoặc nhập mật khẩu tạm ở màn hình Xem trực tiếp.';
    }
    if (err.code === 'TEST_MODE_BLOCKED') {
      return err.message || 'Chế độ kiểm thử đang bật nên thao tác này bị chặn.';
    }
    if (err.code === 'FFMPEG_UNAVAILABLE') {
      return 'FFmpeg chưa sẵn sàng trên máy chủ. Kiểm tra chẩn đoán trong Cài đặt.';
    }
    if (err.code === 'ABORTED') { return ''; }
    return err.message || fallback || 'Yêu cầu thất bại.';
  }

  function errorCodeSuffix(err) {
    if (!err || !err.code || err.code === 'ABORTED') { return ''; }
    return ' (' + err.code + ')';
  }

  function actionErrorText(err, fallback) {
    var message = errorText(err, fallback);
    return message ? message + errorCodeSuffix(err) : '';
  }

  function maxPercent(value) {
    var n = Number(value);
    if (!isFinite(n)) { return 0; }
    return Math.max(0, Math.min(100, n));
  }

  function progressTone(percent) {
    if (percent >= 95) { return 'danger'; }
    if (percent >= 80) { return 'warning'; }
    return 'success';
  }

  function clipCategory(clip) {
    if (!clip) { return 'other'; }
    var events = Array.isArray(clip.events) ? clip.events.map(String) : [];
    var type = String(clip.event_type || '').toLowerCase();
    if (events.indexOf('VideoMotion') !== -1 || type.indexOf('chuyển động') !== -1 || type.indexOf('motion') !== -1) {
      return 'motion';
    }
    if (events.indexOf('Timing') !== -1 || type.indexOf('liên tục') !== -1 ||
        type.indexOf('normal') !== -1 || type.indexOf('timing') !== -1) {
      return 'periodic';
    }
    if (events.indexOf('Manual') !== -1 || type.indexOf('thủ công') !== -1 || type.indexOf('manual') !== -1) {
      return 'manual';
    }
    return 'other';
  }

  function eventTone(category) {
    if (category === 'motion') { return 'warning'; }
    if (category === 'periodic') { return 'info'; }
    if (category === 'manual') { return 'primary'; }
    return 'neutral';
  }

  function clipDuration(clip) {
    var n = Number(clip && clip.duration);
    if (isFinite(n) && n > 0) { return fmt.duration(n); }
    return clip && clip.duration_str ? String(clip.duration_str) : '—';
  }

  function clipSize(clip) {
    var rawBytes = clip ? clip.length_bytes : null;
    if (rawBytes !== null && rawBytes !== undefined && rawBytes !== '') {
      var bytes = Number(rawBytes);
      if (isFinite(bytes) && bytes >= 0) { return fmt.bytes(bytes); }
    }
    var rawMb = clip ? clip.size_mb : null;
    if (rawMb !== null && rawMb !== undefined && rawMb !== '') {
      var mb = Number(rawMb);
      if (isFinite(mb)) { return fmt.number(mb) + ' MB'; }
    }
    return '—';
  }

  function formatRecordStarted(value) {
    var text = String(value || '');
    var match = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(text);
    if (match) {
      return match[4] + ':' + match[5] + ':' + match[6] + ' ' +
        match[3] + '/' + match[2] + '/' + match[1];
    }
    return text ? fmt.dateTime(text) : '—';
  }

  function safeFilename(value) {
    var name = String(value || '').trim();
    if (!name || name.indexOf('/') !== -1 || name.indexOf('\\') !== -1 || name.indexOf('..') !== -1) {
      return '';
    }
    return name;
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

  function setBusy(node, busy) {
    if (!node) { return; }
    if (busy) {
      node.setAttribute('aria-busy', 'true');
    } else {
      node.removeAttribute('aria-busy');
    }
  }

  function markUpdated(failed) {
    if (refs && refs.updated) {
      refs.updated.textContent = (failed ? 'Lỗi cập nhật: ' : 'Cập nhật: ') + fmt.time(new Date());
    }
  }

  function showPageError(err) {
    if (!refs || !refs.statusStrip) { return; }
    clear(refs.statusStrip);
    refs.statusStrip.hidden = false;
    refs.statusStrip.appendChild(ui.banner({
      tone: 'danger',
      title: 'Không tải được danh sách camera',
      message: actionErrorText(err, 'Máy chủ không phản hồi.'),
      actions: [ui.button({
        label: 'Thử lại',
        icon: 'refresh',
        variant: 'secondary',
        size: 'sm',
        onClick: function () { loadAllData(); }
      })],
      dismissible: true
    }));
    markUpdated(true);
  }

  function hidePageError() {
    if (!refs || !refs.statusStrip) { return; }
    refs.statusStrip.hidden = true;
    clear(refs.statusStrip);
  }

  /* --------------------------- Page skeleton --------------------------- */

  function buildPage(container) {
    clear(container);
    var root = el('div', { class: 'c-stack view-storage' });

    var updated = el('span', { class: 'u-muted u-tabular', text: 'Đang tải…' });
    var refreshBtn = ui.button({
      label: 'Làm mới',
      icon: 'refresh',
      variant: 'secondary',
      size: 'sm',
      testId: 'storage-refresh',
      onClick: function () { loadAllData(true); }
    });
    root.appendChild(ui.pageHeader({
      title: 'Lưu trữ',
      subtitle: 'Thẻ nhớ camera, clip ghi trên thẻ và bản ghi trên máy chủ',
      icon: 'storage',
      actions: [updated, refreshBtn]
    }));

    var statusStrip = el('div', { hidden: true });
    root.appendChild(statusStrip);

    /* Camera picker */
    var pickerCard = el('section', { class: 'c-card' });
    var pickerHeader = el('div', { class: 'c-card__header' });
    var pickerTitle = el('div');
    var pickerTitleLine = el('div', { class: 'c-card__title' });
    pickerTitleLine.appendChild(svg('cameras', { size: 16 }));
    pickerTitleLine.appendChild(el('span', { text: 'Chọn camera' }));
    pickerTitle.appendChild(pickerTitleLine);
    pickerTitle.appendChild(el('div', {
      class: 'c-card__subtitle',
      text: 'Chọn camera đã quản lý để đọc thông tin thẻ nhớ và danh sách clip.'
    }));
    pickerHeader.appendChild(pickerTitle);
    pickerCard.appendChild(pickerHeader);
    var pickerBody = el('div', { class: 'c-card__body' });
    var cameraField = ui.field({
      label: 'Camera được quản lý',
      name: 'storage-camera',
      type: 'select',
      options: [{ value: '', label: 'Đang tải danh sách camera…' }],
      value: '',
      disabled: true,
      testId: 'storage-camera-select'
    });
    var pickerRow = el('div', { class: 'c-toolbar' });
    var pickerLeft = el('div', { class: 'c-toolbar__left' });
    pickerLeft.appendChild(cameraField.el);
    var pickerRight = el('div', { class: 'c-toolbar__right' });
    var cameraPill = el('span');
    var cameraMeta = el('span', { class: 'c-muted-block', text: '' });
    pickerRight.appendChild(cameraMeta);
    pickerRight.appendChild(cameraPill);
    pickerRow.appendChild(pickerLeft);
    pickerRow.appendChild(pickerRight);
    pickerBody.appendChild(pickerRow);
    pickerCard.appendChild(pickerBody);
    root.appendChild(pickerCard);

    /* SD card */
    var sdActions = [];
    var formatBtn = null;
    if (isAdmin()) {
      formatBtn = ui.button({
        label: 'Format thẻ',
        icon: 'trash',
        variant: 'danger',
        size: 'sm',
        disabled: true,
        testId: 'storage-format-btn',
        onClick: openFormatFlow
      });
      sdActions.push(formatBtn);
    }
    var sdCard = makeCard({
      title: 'Thẻ nhớ MicroSD',
      subtitle: 'Dung lượng, sức khoẻ thẻ và thao tác định dạng',
      icon: 'sd-card',
      testId: 'storage-sd-card',
      actions: sdActions
    });
    var sdBody = el('div', { class: 'c-stack' });
    sdBody.appendChild(ui.skeleton({ variant: 'text', rows: 5 }));
    sdCard.body.appendChild(sdBody);
    root.appendChild(sdCard.el);

    /* Clips card */
    var clipsCount = el('span', { class: 'u-muted u-tabular', text: '—' });
    var clipsCard = makeCard({
      title: 'Clip trên thẻ',
      subtitle: 'Tìm bản ghi lưu trên thẻ nhớ theo ngày',
      icon: 'film',
      actions: [clipsCount]
    });
    var dateField = ui.field({
      label: 'Ngày',
      name: 'clip-date',
      type: 'date',
      value: clipsDate,
      testId: 'storage-date'
    });
    var filterField = ui.field({
      label: 'Loại sự kiện',
      name: 'clip-filter',
      type: 'select',
      options: CLIP_FILTERS,
      value: clipFilter,
      testId: 'storage-clip-filter'
    });
    var searchBtn = ui.button({
      label: 'Tìm clip',
      icon: 'search',
      variant: 'primary',
      size: 'sm',
      testId: 'storage-search-clips',
      onClick: function () { loadClips(); }
    });
    var clipsToolbar = el('div', { class: 'c-toolbar' });
    var clipsToolbarLeft = el('div', { class: 'c-toolbar__left' });
    clipsToolbarLeft.appendChild(dateField.el);
    clipsToolbarLeft.appendChild(filterField.el);
    var clipsToolbarRight = el('div', { class: 'c-toolbar__right' });
    clipsToolbarRight.appendChild(searchBtn);
    clipsToolbar.appendChild(clipsToolbarLeft);
    clipsToolbar.appendChild(clipsToolbarRight);
    clipsCard.body.appendChild(clipsToolbar);

    var clipsError = el('div', { class: 'u-mt-16', hidden: true });
    clipsCard.body.appendChild(clipsError);

    clipsEmpty = el('div');
    clipsEmpty.appendChild(ui.empty({
      icon: 'film',
      title: 'Chưa có dữ liệu clip',
      description: 'Chọn camera và ngày để tìm bản ghi trên thẻ.'
    }));
    clipsTable = ui.table({
      columns: [
        {
          key: 'start_time',
          label: 'Bắt đầu',
          sortable: true,
          render: function (row) { return fmt.dateTime(row.start_time); }
        },
        {
          key: 'end_time',
          label: 'Kết thúc',
          render: function (row) { return fmt.dateTime(row.end_time); }
        },
        {
          key: 'duration',
          label: 'Thời lượng',
          sortable: true,
          render: function (row) { return clipDuration(row); }
        },
        {
          key: 'length_bytes',
          label: 'Dung lượng',
          align: 'right',
          sortable: true,
          render: function (row) { return clipSize(row); }
        },
        {
          key: 'event_type',
          label: 'Loại sự kiện',
          render: function (row) {
            var category = clipCategory(row);
            return ui.badge(row.event_type || 'Sự kiện', { tone: eventTone(category) });
          }
        },
        {
          key: 'stream',
          label: 'Luồng',
          render: function (row) {
            return ui.badge(row.stream || '—', { tone: 'neutral' });
          }
        },
        {
          key: 'actions',
          label: '',
          align: 'right',
          render: function (row) {
            return ui.button({
              label: 'Chi tiết',
              icon: 'file-text',
              variant: 'ghost',
              size: 'sm',
              onClick: function () { openClipDetail(row); }
            });
          }
        }
      ],
      rows: [],
      loading: true,
      emptyNode: clipsEmpty,
      mobile: 'cards',
      caption: 'Danh sách clip trên thẻ nhớ',
      rowKey: function (row, index) {
        return (row && row.start_time ? row.start_time : 'clip') + '|' + index + '|' +
          (row && row.file_path ? row.file_path : '');
      },
      testId: 'storage-clips-table'
    });
    var clipsTableWrap = el('div', { class: 'u-mt-16' });
    clipsTableWrap.appendChild(clipsTable.el);
    clipsCard.body.appendChild(clipsTableWrap);
    root.appendChild(clipsCard.el);

    /* Server recordings card */
    var localActions = [];
    var recordRefreshBtn = ui.button({
      icon: 'refresh',
      label: 'Làm mới bản ghi',
      variant: 'ghost',
      size: 'sm',
      onClick: function () { refreshRecordStatus().catch(function () { return null; }); }
    });
    localActions.push(recordRefreshBtn);
    var localCard = makeCard({
      title: 'Bản ghi trên máy chủ',
      subtitle: 'Bản ghi đang hoạt động và tệp vừa dừng trong phiên này',
      icon: 'hard-drive',
      actions: localActions
    });
    var adminFolderSlot = null;
    if (isAdmin()) {
      adminFolderSlot = el('div', { class: 'c-stack c-stack--sm' });
      adminFolderSlot.appendChild(ui.skeleton({ variant: 'text', rows: 2 }));
      localCard.body.appendChild(adminFolderSlot);
      localCard.body.appendChild(el('div', { class: 'c-divider' }));
    }
    var recordError = el('div', { class: 'u-mb-16', hidden: true });
    localCard.body.appendChild(recordError);
    recordEmpty = el('div');
    recordEmpty.appendChild(ui.empty({
      icon: 'record',
      title: 'Chưa có bản ghi nào đang hoạt động',
      description: 'Bản ghi do quản trị viên khởi tạo từ màn hình Xem trực tiếp sẽ xuất hiện tại đây.'
    }));
    recordTable = ui.table({
      columns: [
        {
          key: 'ip',
          label: 'Camera',
          render: function (row) {
            var wrap = el('div');
            wrap.appendChild(el('div', { text: cameraLabel(row.ip) }));
            wrap.appendChild(el('div', { class: 'c-muted-block u-mono', text: row.ip || '—' }));
            return wrap;
          }
        },
        {
          key: 'channel',
          label: 'Kênh',
          align: 'center',
          render: function (row) { return 'Kênh ' + (Number(row.channel) || 1); }
        },
        {
          key: 'started_at',
          label: 'Bắt đầu',
          render: function (row) { return formatRecordStarted(row.started_at); }
        },
        {
          key: 'duration',
          label: 'Thời lượng',
          render: function (row) { return fmt.duration(row.duration || 0); }
        },
        {
          key: 'filename',
          label: 'Tệp',
          mono: true,
          wrap: true,
          render: function (row) {
            return el('span', { class: 'u-mono u-truncate', text: row.filename || '—' });
          }
        },
        {
          key: 'state',
          label: 'Trạng thái',
          render: function (row) {
            var wrap = el('div', { class: 'c-row c-row--wrap' });
            if (row.active) {
              wrap.appendChild(ui.statusPill('recording'));
            } else {
              wrap.appendChild(ui.badge('Đã dừng', { tone: 'neutral' }));
              if (row.ended_at) {
                wrap.appendChild(el('span', { class: 'c-muted-block', text: fmt.dateTime(row.ended_at) }));
              }
            }
            return wrap;
          }
        },
        {
          key: 'download',
          label: '',
          align: 'right',
          render: function (row) {
            return ui.button({
              label: 'Tải xuống',
              icon: 'download',
              variant: 'ghost',
              size: 'sm',
              onClick: function () { downloadRecording(row); }
            });
          }
        }
      ],
      rows: [],
      loading: true,
      emptyNode: recordEmpty,
      mobile: 'cards',
      caption: 'Danh sách bản ghi trên máy chủ',
      rowKey: function (row) { return row && row.filename ? row.filename : ''; },
      testId: 'storage-recordings'
    });
    localCard.body.appendChild(recordTable.el);
    root.appendChild(localCard.el);

    container.appendChild(root);

    var formatBtnRef = formatBtn;
    refs = {
      updated: updated,
      refreshBtn: refreshBtn,
      statusStrip: statusStrip,
      cameraField: cameraField,
      cameraPill: cameraPill,
      cameraMeta: cameraMeta,
      sdCard: sdCard.el,
      sdBody: sdBody,
      formatBtn: formatBtnRef,
      clipsCount: clipsCount,
      clipsError: clipsError,
      dateField: dateField,
      filterField: filterField,
      searchBtn: searchBtn,
      recordError: recordError,
      folderSlot: adminFolderSlot
    };

    cameraField.input.addEventListener('change', function () {
      onCameraChanged(cameraField.getValue());
    });
    dateField.input.addEventListener('change', function () { loadClips(); });
    filterField.input.addEventListener('change', function () {
      clipFilter = filterField.getValue() || 'all';
      applyClipFilter();
    });
  }

  /* --------------------------- Camera list ----------------------------- */

  function loadCameras() {
    return ctx.state.refresh('cameras').then(function (list) {
      cameras = Array.isArray(list) ? list : [];
      hidePageError();
      return cameras;
    }).catch(function (err) {
      cameras = Array.isArray(ctx.state.get('cameras')) ? ctx.state.get('cameras') : [];
      if (err && err.code !== 'ABORTED') { showPageError(err); }
      return cameras;
    });
  }

  function populateCameraSelect() {
    var previous = selectedIp;
    if (!selectedIp || !findCamera(selectedIp)) {
      selectedIp = cameras.length && cameras[0].ip ? cameras[0].ip : '';
    }
    var hasCameras = cameras.length > 0;
    refs.cameraField.setOptions(cameraOptions(), selectedIp);
    refs.cameraField.setValue(selectedIp);
    refs.cameraField.setDisabled(!hasCameras);
    refs.dateField.setDisabled(!hasCameras);
    refs.filterField.setDisabled(!hasCameras);
    refs.searchBtn.disabled = !hasCameras;
    return previous !== selectedIp;
  }

  function updateCameraMeta() {
    if (!refs) { return; }
    clear(refs.cameraPill);
    var cam = findCamera(selectedIp);
    if (!cam) {
      refs.cameraMeta.textContent = cameras.length
        ? 'Chưa chọn camera.'
        : 'Chưa có camera nào được quản lý.';
      return;
    }
    refs.cameraMeta.textContent = (cam.ip || '') +
      (cam.vendor ? ' · ' + cam.vendor : '') +
      (cam.model ? ' · ' + cam.model : '');
    refs.cameraPill.appendChild(ui.statusPill(cam.status || 'unknown'));
  }

  function onCameraChanged(ip) {
    selectedIp = ip || '';
    storageInfo = null;
    storageInfoIp = '';
    clipsAll = [];
    updateCameraMeta();
    hideClipError();
    if (!selectedIp) {
      renderNoCameraState();
      return;
    }
    renderStorageLoading();
    renderClipsLoading();
    loadStorageInfo();
    loadClips();
  }

  function renderNoCameraState() {
    if (!refs) { return; }
    clear(refs.sdBody);
    var actions = [];
    if (isAdmin()) {
      actions.push(ui.button({
        label: 'Mở danh sách camera',
        icon: 'cameras',
        variant: 'secondary',
        size: 'sm',
        onClick: function () { ctx.router.go('cameras'); }
      }));
    }
    refs.sdBody.appendChild(ui.empty({
      icon: 'cameras',
      title: 'Chưa có camera nào',
      description: 'Thêm camera vào danh sách quản lý để đọc thông tin thẻ nhớ và clip.',
      action: actions
    }));
    if (refs.formatBtn) { refs.formatBtn.disabled = true; }
    setBusy(refs.sdCard, false);
    clipsTable.update({ rows: [], loading: false });
    setClipsEmpty('Chưa có camera', 'Chọn một camera đã quản lý để tìm clip trên thẻ.');
    refs.clipsCount.textContent = '—';
    refs.dateField.setDisabled(true);
    refs.filterField.setDisabled(true);
    refs.searchBtn.disabled = true;
    hideClipError();
  }

  /* ---------------------------- SD card -------------------------------- */

  function renderStorageLoading() {
    if (!refs) { return; }
    clear(refs.sdBody);
    refs.sdBody.appendChild(ui.skeleton({ variant: 'text', rows: 5 }));
    refs.sdBody.appendChild(el('p', { class: 'c-muted-block', text: 'Đang đọc thông tin thẻ nhớ từ camera…' }));
    setBusy(refs.sdCard, true);
    if (refs.formatBtn) { refs.formatBtn.disabled = true; }
  }

  function renderStorageInfo() {
    if (!refs) { return; }
    var info = storageInfo || {};
    clear(refs.sdBody);
    setBusy(refs.sdCard, false);

    var displayIp = storageInfoIp || selectedIp;
    var statusRow = el('div', { class: 'c-row c-row--between c-row--wrap' });
    var statusLeft = el('div');
    statusLeft.appendChild(el('div', { class: 'c-card__subtitle', text: 'Camera: ' + cameraLabel(displayIp) }));
    statusLeft.appendChild(el('div', { class: 'c-muted-block u-mono', text: displayIp || '—' }));
    statusRow.appendChild(statusLeft);
    var statusRight = el('div', { class: 'c-row c-row--wrap' });
    statusRight.appendChild(ui.statusPill(storageStatusKey(info)));
    statusRow.appendChild(statusRight);
    refs.sdBody.appendChild(statusRow);

    if (!info.has_sd) {
      refs.sdBody.appendChild(ui.empty({
        icon: 'sd-card',
        title: 'Không có thẻ nhớ',
        description: 'Camera không có thẻ nhớ hoặc chưa đọc được thông tin. Kiểm tra thẻ và thử lại.',
        action: [ui.button({
          label: 'Đọc lại',
          icon: 'refresh',
          variant: 'secondary',
          size: 'sm',
          onClick: function () { loadStorageInfo(); }
        })]
      }));
      if (refs.formatBtn) { refs.formatBtn.disabled = true; }
      markUpdated();
      return;
    }

    var totalBytes = Number(info.total_bytes);
    var usedBytes = Number(info.used_bytes);
    var freeBytes = Number(info.free_bytes);
    var percent = Number(info.percent_used);
    if (!isFinite(percent) && isFinite(totalBytes) && totalBytes > 0 && isFinite(usedBytes)) {
      percent = (usedBytes / totalBytes) * 100;
    }
    percent = maxPercent(percent);
    if (!isFinite(totalBytes) || totalBytes <= 0) {
      totalBytes = 0;
      if (!isFinite(usedBytes) || usedBytes < 0) { usedBytes = 0; }
      if (!isFinite(freeBytes) || freeBytes < 0) { freeBytes = 0; }
    }
    if (!isFinite(usedBytes) && isFinite(totalBytes) && isFinite(freeBytes)) {
      usedBytes = Math.max(0, totalBytes - freeBytes);
    }
    if (!isFinite(freeBytes) && isFinite(totalBytes) && isFinite(usedBytes)) {
      freeBytes = Math.max(0, totalBytes - usedBytes);
    }

    var tone = progressTone(percent);
    var kpiGrid = el('div', { class: 'c-grid c-grid--kpi' });
    kpiGrid.appendChild(ui.kpi({
      label: 'Tổng dung lượng',
      value: bytesText(info.total_bytes, info.total_gb),
      hint: info.device ? String(info.device) : 'thẻ nhớ',
      icon: 'sd-card',
      tone: 'primary'
    }));
    kpiGrid.appendChild(ui.kpi({
      label: 'Đã dùng',
      value: bytesText(info.used_bytes, info.used_gb),
      hint: fmt.percent(percent),
      icon: 'hard-drive',
      tone: tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'info'
    }));
    kpiGrid.appendChild(ui.kpi({
      label: 'Còn trống',
      value: bytesText(info.free_bytes, info.free_gb),
      hint: info.status_text ? String(info.status_text) : 'sẵn sàng ghi',
      icon: 'database',
      tone: 'success'
    }));
    refs.sdBody.appendChild(kpiGrid);

    var visualGrid = el('div', { class: 'c-grid c-grid--2' });
    var visualLeft = el('div', { class: 'c-stack c-stack--sm' });
    visualLeft.appendChild(ui.gauge({
      percent: percent,
      label: 'Dung lượng đã dùng',
      valueText: bytesText(info.used_bytes, info.used_gb) + ' / ' + bytesText(info.total_bytes, info.total_gb),
      tone: tone
    }));
    var progress = ui.progress({
      value: isFinite(usedBytes) ? usedBytes : 0,
      max: totalBytes > 0 ? totalBytes : 100,
      label: 'Đã dùng',
      tone: tone,
      ariaLabel: 'Tỷ lệ dung lượng thẻ nhớ đã dùng'
    });
    visualLeft.appendChild(progress.el);
    visualLeft.appendChild(el('p', {
      class: 'c-muted-block',
      text: 'Thông tin được đọc trực tiếp từ camera; số liệu có thể thay đổi trong lúc ghi hình.'
    }));
    visualGrid.appendChild(visualLeft);

    visualGrid.appendChild(makeKv([
      { label: 'Thiết bị', value: info.device, mono: true },
      { label: 'Sản phẩm', value: info.product_name },
      { label: 'Trạng thái', value: info.status_text },
      { label: 'Mã trạng thái', value: info.state, mono: true },
      { label: 'Đường dẫn', value: isAdmin() ? info.path : null, mono: true }
    ]));
    refs.sdBody.appendChild(visualGrid);

    if (info.is_error) {
      refs.sdBody.appendChild(ui.banner({
        tone: 'danger',
        title: 'Thẻ nhớ báo lỗi',
        message: info.status_text
          ? String(info.status_text)
          : 'Camera báo thẻ nhớ đang gặp sự cố. Hãy kiểm tra hoặc định dạng lại thẻ.',
        actions: [ui.button({
          label: 'Đọc lại',
          icon: 'refresh',
          variant: 'secondary',
          size: 'sm',
          onClick: function () { loadStorageInfo(); }
        })]
      }));
    } else if (totalBytes <= 0) {
      refs.sdBody.appendChild(ui.banner({
        tone: 'warning',
        title: 'Không đọc được dung lượng thẻ',
        message: 'Camera có thẻ nhưng báo dung lượng 0. Thử đọc lại hoặc kiểm tra thẻ trên camera.'
      }));
    }

    if (refs.formatBtn) {
      refs.formatBtn.disabled = !info.has_sd || !!info.is_error && totalBytes <= 0;
    }
    markUpdated();
  }

  function storageStatusKey(info) {
    if (!info || !info.has_sd) { return 'no_sd'; }
    if (info.is_error) { return 'storage_error'; }
    var state = String(info.state || '').toLowerCase();
    if (state && state !== 'success' && state !== 'normal' && state !== 'unknown') {
      return 'storage_error';
    }
    return 'ok';
  }

  function loadStorageInfo() {
    if (!selectedIp || destroyed || !refs) { return; }
    var ip = selectedIp;
    var seq = ++storageSeq;
    var hasData = storageInfo && storageInfoIp === ip;
    if (!hasData) { renderStorageLoading(); }
    else { setBusy(refs.sdCard, true); }

    ctx.api.get('/api/storage/info', {
      query: { ip: ip },
      signal: ctx.signal,
      silent: true,
      timeoutMs: 30000
    }).then(function (data) {
      if (destroyed || seq !== storageSeq || selectedIp !== ip) { return; }
      storageInfo = data && typeof data === 'object' ? data : {};
      storageInfoIp = ip;
      renderStorageInfo();
    }).catch(function (err) {
      if (destroyed || seq !== storageSeq || selectedIp !== ip) { return; }
      if (err && err.code === 'ABORTED') { return; }
      renderStorageError(err);
      markUpdated(true);
    });
  }

  function renderStorageError(err) {
    if (!refs) { return; }
    setBusy(refs.sdCard, false);
    if (refs.formatBtn) { refs.formatBtn.disabled = true; }
    var hasData = storageInfo && storageInfoIp === selectedIp;
    if (hasData) {
      renderStorageInfo();
      refs.sdBody.insertBefore(ui.banner({
        tone: 'warning',
        title: 'Không cập nhật được thông tin thẻ',
        message: actionErrorText(err, 'Camera không phản hồi.'),
        actions: [ui.button({
          label: 'Thử lại',
          icon: 'refresh',
          variant: 'secondary',
          size: 'sm',
          onClick: function () { loadStorageInfo(); }
        })],
        dismissible: true
      }), refs.sdBody.firstChild);
      return;
    }
    clear(refs.sdBody);
    storageInfo = null;
    storageInfoIp = '';
    refs.sdBody.appendChild(ui.errorPanel({
      title: 'Không đọc được thông tin thẻ nhớ',
      message: errorText(err, 'Camera không phản hồi.'),
      code: err && err.code ? err.code : null,
      requestId: err && err.requestId ? err.requestId : null,
      retry: function () { loadStorageInfo(); }
    }));
    if (err && err.code === 'TEST_MODE_BLOCKED') {
      refs.sdBody.appendChild(el('p', {
        class: 'c-muted-block u-mt-8',
        text: 'Đây là chế độ kiểm thử nên camera không được gọi thật. Chạy ứng dụng ở chế độ vận hành để đọc thẻ nhớ.'
      }));
    }
  }

  /* --------------------------- Format flow ----------------------------- */

  function openFormatFlow() {
    if (!isAdmin() || !selectedIp) { return; }
    var ip = selectedIp;
    var cameraName = cameraLabel(ip);
    var first = ctx.confirm({
      title: 'Định dạng thẻ nhớ?',
      message: 'Toàn bộ dữ liệu ghi trên thẻ nhớ của camera sẽ bị xoá. Thao tác này không thể hoàn tác.',
      details: 'Camera: ' + cameraName + ' (' + ip + ')',
      confirmLabel: 'Tôi hiểu, tiếp tục',
      cancelLabel: 'Huỷ',
      variant: 'danger'
    });
    first.then(function (ok) {
      if (!ok || destroyed) { return; }
      openFormatModal(ip, cameraName);
    });
  }

  function openFormatModal(ip, cameraName) {
    var body = el('div', { class: 'c-stack' });
    body.appendChild(ui.banner({
      tone: 'danger',
      title: 'Cảnh báo mất dữ liệu',
      message: 'Định dạng sẽ xoá toàn bộ clip và dữ liệu trên thẻ MicroSD. Hãy chắc chắn dữ liệu quan trọng đã được sao lưu.'
    }));
    body.appendChild(el('p', {
      class: 'c-muted-block',
      text: 'Camera: ' + cameraName + ' (' + ip + ')'
    }));
    var confirmField = ui.field({
      label: 'Gõ FORMAT để xác nhận',
      name: 'format-confirm',
      type: 'text',
      placeholder: 'FORMAT',
      autocomplete: 'off',
      mono: true,
      help: 'Phải nhập đúng chữ hoa FORMAT.',
      testId: 'storage-format-confirm'
    });
    body.appendChild(confirmField.el);

    var handle = null;
    var cancelBtn = ui.button({
      label: 'Huỷ',
      variant: 'secondary',
      onClick: function () { if (handle) { handle.close(); } }
    });
    var submitBtn = ui.button({
      label: 'Định dạng thẻ',
      icon: 'trash',
      variant: 'danger',
      disabled: true,
      onClick: function () { submitFormat(handle, confirmField, submitBtn); }
    });

    function syncSubmit() {
      submitBtn.disabled = confirmField.getValue().trim() !== 'FORMAT';
    }
    confirmField.input.addEventListener('input', syncSubmit);

    handle = trackLayer(ui.modal({
      title: 'Xác nhận định dạng thẻ',
      subtitle: cameraName + ' · ' + ip,
      body: body,
      footer: [cancelBtn, submitBtn],
      size: 'sm',
      dismissible: true,
      initialFocus: confirmField.input,
      onClose: function () {
        confirmField.setValue('');
      }
    }));

    function submitFormat(modalHandle, field, button) {
      if (!modalHandle) { return; }
      var value = field.getValue().trim();
      if (value !== 'FORMAT') {
        field.setError('Nhập đúng chữ FORMAT để xác nhận.');
        field.focus();
        return;
      }
      field.clearError();
      modalHandle.setBusy(true);
      modalHandle.setError('');
      ctx.api.post('/api/storage/format', {
        ip: ip,
        confirm: 'FORMAT'
      }, {
        signal: ctx.signal,
        silent: true,
        timeoutMs: 45000
      }).then(function (data) {
        if (destroyed) { return; }
        modalHandle.close();
        ui.toast((data && data.message) || 'Đã gửi lệnh định dạng thẻ.', { type: 'success' });
        clipsAll = [];
        if (refs) {
          clipsTable.update({ rows: [], loading: false });
          setClipsEmpty('Đang định dạng thẻ', 'Camera đang xử lý lệnh định dạng. Chờ camera hoàn tất rồi bấm Tìm clip.');
          refs.clipsCount.textContent = '—';
          if (refs.formatBtn) { refs.formatBtn.disabled = true; }
        }
        loadStorageInfo();
      }).catch(function (err) {
        if (destroyed) { return; }
        if (err && err.code === 'ABORTED') { return; }
        modalHandle.setBusy(false);
        button.disabled = field.getValue().trim() !== 'FORMAT';
        modalHandle.setError(actionErrorText(err, 'Camera từ chối lệnh định dạng.'));
      });
    }

    syncSubmit();
  }

  /* ----------------------------- Clips --------------------------------- */

  function setClipsEmpty(title, description) {
    if (!clipsEmpty) { return; }
    clear(clipsEmpty);
    clipsEmpty.appendChild(ui.empty({
      icon: 'film',
      title: title,
      description: description
    }));
  }

  function renderClipsLoading() {
    if (!refs) { return; }
    refs.clipsError.hidden = true;
    clear(refs.clipsError);
    refs.clipsCount.textContent = 'Đang tải…';
    clipsTable.update({ rows: [], loading: true });
  }

  function hideClipError() {
    if (!refs) { return; }
    refs.clipsError.hidden = true;
    clear(refs.clipsError);
  }

  function showClipError(err) {
    if (!refs) { return; }
    clear(refs.clipsError);
    refs.clipsError.hidden = false;
    refs.clipsError.appendChild(ui.banner({
      tone: 'danger',
      title: 'Không tải được clip trên thẻ',
      message: actionErrorText(err, 'Camera không phản hồi.'),
      actions: [ui.button({
        label: 'Thử lại',
        icon: 'refresh',
        variant: 'secondary',
        size: 'sm',
        onClick: function () { loadClips(); }
      })],
      dismissible: true
    }));
  }

  function loadClips() {
    if (!selectedIp || destroyed || !refs) { return; }
    var ip = selectedIp;
    var date = refs.dateField.getValue();
    if (!date) {
      date = todayStr();
      refs.dateField.setValue(date);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      refs.dateField.setError('Ngày phải có định dạng YYYY-MM-DD.');
      return;
    }
    refs.dateField.clearError();
    if (storageInfo && storageInfoIp === ip && storageInfo.has_sd === false) {
      clipsAll = [];
      clipsDate = date;
      hideClipError();
      refs.clipsCount.textContent = '0 clip';
      clipsTable.update({ rows: [], loading: false });
      setClipsEmpty('Không có thẻ nhớ', 'Camera không có thẻ nhớ hoặc chưa đọc được thông tin.');
      return;
    }

    var seq = ++clipsSeq;
    refs.clipsError.hidden = true;
    clear(refs.clipsError);
    refs.clipsCount.textContent = 'Đang tải…';
    clipsTable.update({ rows: [], loading: true });

    ctx.api.get('/api/storage/recordings', {
      query: { ip: ip, date: date },
      signal: ctx.signal,
      silent: true,
      timeoutMs: 35000
    }).then(function (data) {
      if (destroyed || seq !== clipsSeq || selectedIp !== ip) { return; }
      clipsAll = data && Array.isArray(data.recordings) ? data.recordings : [];
      clipsDate = date;
      hideClipError();
      applyClipFilter();
      markUpdated();
    }).catch(function (err) {
      if (destroyed || seq !== clipsSeq || selectedIp !== ip) { return; }
      if (err && err.code === 'ABORTED') { return; }
      clipsAll = [];
      clipsTable.update({ rows: [], loading: false });
      refs.clipsCount.textContent = 'Lỗi';
      setClipsEmpty('Không tải được clip', 'Kiểm tra kết nối camera hoặc thử lại sau.');
      showClipError(err);
      markUpdated(true);
    });
  }

  function applyClipFilter() {
    if (!refs) { return; }
    var rows = clipsAll;
    if (clipFilter !== 'all') {
      rows = clipsAll.filter(function (clip) { return clipCategory(clip) === clipFilter; });
    }
    if (!clipsAll.length) {
      setClipsEmpty(
        'Không có clip nào',
        'Không tìm thấy bản ghi trong ngày ' + (clipsDate || 'đã chọn') + '. Thử chọn ngày khác.'
      );
    } else if (!rows.length) {
      setClipsEmpty('Không có clip phù hợp', 'Thử đổi bộ lọc loại sự kiện.');
    }
    clipsTable.update({ rows: rows, loading: false });
    var countText = clipsAll.length + ' clip';
    if (rows.length !== clipsAll.length) {
      countText += ' · ' + rows.length + ' sau lọc';
    }
    refs.clipsCount.textContent = countText;
  }

  function openClipDetail(clip) {
    if (!clip) { return; }
    var category = clipCategory(clip);
    var rows = [
      { label: 'Bắt đầu', value: fmt.dateTime(clip.start_time) },
      { label: 'Kết thúc', value: fmt.dateTime(clip.end_time) },
      { label: 'Thời lượng', value: clipDuration(clip) },
      { label: 'Dung lượng', value: clipSize(clip) },
      { label: 'Loại sự kiện', value: clip.event_type || 'Sự kiện' },
      { label: 'Sự kiện gốc', value: Array.isArray(clip.events) && clip.events.length ? clip.events.join(', ') : null, mono: true },
      { label: 'Luồng', value: clip.stream || '—' },
      { label: 'Nhóm sự kiện', value: (CLIP_FILTERS.filter(function (item) {
        return item.value === category;
      })[0] || {}).label }
    ];
    if (isAdmin() && clip.file_path) {
      rows.push({ label: 'Đường dẫn trên camera', value: clip.file_path, mono: true });
    }
    var body = el('div', { class: 'c-stack' });
    body.appendChild(makeKv(rows));
    body.appendChild(el('p', {
      class: 'c-muted-block',
      text: 'Clip được lưu trên thẻ nhớ của camera. Dùng giao diện camera để tải hoặc phát lại clip gốc.'
    }));
    var handle = null;
    handle = trackLayer(ui.drawer({
      title: 'Chi tiết clip',
      subtitle: fmt.dateTime(clip.start_time),
      body: body,
      footer: [ui.button({
        label: 'Đóng',
        variant: 'secondary',
        onClick: function () { if (handle) { handle.close(); } }
      })],
      dismissible: true
    }));
  }

  /* ----------------------- Server recordings --------------------------- */

  function renderFolderLoading() {
    if (!refs || !refs.folderSlot) { return; }
    clear(refs.folderSlot);
    refs.folderSlot.appendChild(ui.skeleton({ variant: 'text', rows: 2 }));
  }

  function openFolderButton(folder, label, testId) {
    var btn = ui.button({
      label: label,
      icon: 'external-link',
      variant: 'secondary',
      size: 'sm',
      testId: testId,
      onClick: function () { openFolder(folder, btn); }
    });
    return btn;
  }

  function renderFolderPaths(settings) {
    if (!refs || !refs.folderSlot) { return; }
    clear(refs.folderSlot);
    var wrap = el('div', { class: 'c-stack c-stack--sm' });
    wrap.appendChild(el('div', { class: 'c-card__subtitle', text: 'Thư mục trên máy chủ' }));
    wrap.appendChild(makeKv([
      { label: 'Ghi hình', value: settings.recordings_dir || '(mặc định của máy chủ)', mono: true },
      { label: 'Ảnh snapshot', value: settings.snapshots_dir || '(mặc định của máy chủ)', mono: true }
    ]));
    var actions = el('div', { class: 'c-row c-row--wrap' });
    actions.appendChild(openFolderButton('recordings', 'Mở thư mục ghi hình', 'storage-open-folder'));
    actions.appendChild(openFolderButton('snapshots', 'Mở thư mục ảnh', 'storage-open-snapshots'));
    wrap.appendChild(actions);
    wrap.appendChild(el('p', {
      class: 'c-muted-block',
      text: 'Thao tác mở thư mục chỉ có hiệu lực trên máy tính đang chạy ứng dụng.'
    }));
    refs.folderSlot.appendChild(wrap);
  }

  function renderFolderError(err) {
    if (!refs || !refs.folderSlot) { return; }
    clear(refs.folderSlot);
    var wrap = el('div', { class: 'c-stack c-stack--sm' });
    wrap.appendChild(ui.banner({
      tone: 'warning',
      title: 'Không đọc được cấu hình thư mục',
      message: actionErrorText(err, 'Không tải được cài đặt lưu trữ.'),
      dismissible: true
    }));
    var actions = el('div', { class: 'c-row c-row--wrap' });
    actions.appendChild(openFolderButton('recordings', 'Mở thư mục ghi hình', 'storage-open-folder'));
    actions.appendChild(openFolderButton('snapshots', 'Mở thư mục ảnh', 'storage-open-snapshots'));
    wrap.appendChild(actions);
    refs.folderSlot.appendChild(wrap);
  }

  function loadServerSettings() {
    if (!isAdmin() || !refs || !refs.folderSlot) { return Promise.resolve(); }
    renderFolderLoading();
    return ctx.api.get('/api/settings', {
      signal: ctx.signal,
      silent: true,
      timeoutMs: 15000
    }).then(function (data) {
      if (destroyed) { return; }
      renderFolderPaths((data && data.settings) || {});
    }).catch(function (err) {
      if (destroyed || (err && err.code === 'ABORTED')) { return; }
      renderFolderError(err);
    });
  }

  function openFolder(folder, button) {
    if (!isAdmin()) { return; }
    ui.busy(button, true);
    ctx.api.post('/api/settings/open-folder', { folder: folder }, {
      signal: ctx.signal,
      silent: true,
      timeoutMs: 15000
    }).then(function (data) {
      if (destroyed) { return; }
      ui.toast((data && data.message) || 'Đã mở thư mục.', { type: 'success' });
    }).catch(function (err) {
      if (destroyed || (err && err.code === 'ABORTED')) { return; }
      ui.toast(actionErrorText(err, 'Không mở được thư mục.'), { type: 'error' });
    }).then(function () {
      if (!destroyed) { ui.busy(button, false); }
    });
  }

  function normalizeActive(item) {
    if (!item || !item.filename) { return null; }
    var filename = safeFilename(item.filename);
    if (!filename) { return null; }
    return {
      filename: filename,
      ip: item.ip ? String(item.ip) : '',
      channel: Number(item.channel) || 1,
      duration: Number(item.duration) || 0,
      started_at: item.started_at || '',
      active: true,
      ended_at: null
    };
  }

  function isFinishedRecording(filename) {
    for (var i = 0; i < finishedRecordings.length; i += 1) {
      if (finishedRecordings[i].filename === filename) { return true; }
    }
    return false;
  }

  function applyRecordings(list) {
    var previous = localRecordings.slice();
    var active = [];
    var seen = {};
    (Array.isArray(list) ? list : []).forEach(function (item) {
      var row = normalizeActive(item);
      if (!row || seen[row.filename]) { return; }
      seen[row.filename] = true;
      active.push(row);
    });

    previous.forEach(function (oldRow) {
      if (seen[oldRow.filename]) { return; }
      if (isFinishedRecording(oldRow.filename)) { return; }
      finishedRecordings.unshift({
        filename: oldRow.filename,
        ip: oldRow.ip,
        channel: oldRow.channel,
        duration: oldRow.duration,
        started_at: oldRow.started_at,
        active: false,
        ended_at: new Date().toISOString()
      });
    });

    finishedRecordings = finishedRecordings.filter(function (row) {
      return !seen[row.filename];
    });
    if (finishedRecordings.length > 30) {
      finishedRecordings = finishedRecordings.slice(0, 30);
    }

    active.sort(function (a, b) {
      var aKey = String(a.started_at || '');
      var bKey = String(b.started_at || '');
      if (aKey !== bKey) { return aKey < bKey ? 1 : -1; }
      return String(a.filename).localeCompare(String(b.filename), 'vi');
    });
    localRecordings = active;
    renderRecordings();
  }

  function setRecordEmpty(title, description) {
    if (!recordEmpty) { return; }
    clear(recordEmpty);
    recordEmpty.appendChild(ui.empty({
      icon: 'record',
      title: title,
      description: description
    }));
  }

  function renderRecordings() {
    if (!refs) { return; }
    var rows = localRecordings.concat(finishedRecordings);
    if (!rows.length) {
      setRecordEmpty(
        'Chưa có bản ghi nào đang hoạt động',
        isAdmin()
          ? 'Bản ghi do bạn khởi tạo từ màn hình Xem trực tiếp sẽ xuất hiện tại đây.'
          : 'Bản ghi do quản trị viên khởi tạo từ màn hình Xem trực tiếp sẽ xuất hiện tại đây.'
      );
    }
    recordTable.update({ rows: rows, loading: false });
  }

  function showRecordError(err) {
    if (!refs) { return; }
    clear(refs.recordError);
    refs.recordError.hidden = false;
    refs.recordError.appendChild(ui.banner({
      tone: 'warning',
      title: 'Không cập nhật được bản ghi trên máy chủ',
      message: actionErrorText(err, 'Máy chủ không phản hồi.'),
      actions: [ui.button({
        label: 'Thử lại',
        icon: 'refresh',
        variant: 'secondary',
        size: 'sm',
        onClick: function () { refreshRecordStatus().catch(function () { return null; }); }
      })],
      dismissible: true
    }));
  }

  function hideRecordError() {
    if (!refs) { return; }
    refs.recordError.hidden = true;
    clear(refs.recordError);
  }

  function refreshRecordStatus() {
    if (destroyed) { return Promise.resolve(null); }
    return ctx.api.get('/api/record/status', {
      signal: ctx.signal,
      silent: true,
      timeoutMs: 15000
    }).then(function (data) {
      if (destroyed) { return null; }
      hideRecordError();
      applyRecordings(data && Array.isArray(data.recordings) ? data.recordings : []);
      return data;
    }).catch(function (err) {
      if (destroyed || (err && err.code === 'ABORTED')) { return null; }
      showRecordError(err);
      throw err;
    });
  }

  function downloadRecording(row) {
    if (!row || !row.filename) { return; }
    var filename = safeFilename(row.filename);
    if (!filename) {
      ui.toast('Tên tệp bản ghi không hợp lệ.', { type: 'error' });
      return;
    }
    ui.toast('Đang tải bản ghi ' + filename + '…', { type: 'info', duration: 3000 });
    ctx.api.download('/api/recordings/' + encodeURIComponent(filename), filename, {
      signal: ctx.signal,
      timeoutMs: 300000
    }).then(function () {
      if (!destroyed) {
        ui.toast('Đã tải bản ghi ' + filename + '.', { type: 'success' });
      }
    }).catch(function (err) {
      if (destroyed || (err && err.code === 'ABORTED')) { return; }
      ui.toast(actionErrorText(err, 'Không tải được bản ghi.'), { type: 'error' });
    });
  }

  /* ------------------------------ Data load ---------------------------- */

  function loadAllData(showBusy) {
    if (destroyed) { return; }
    if (showBusy && refs) { ui.busy(refs.refreshBtn, true); }
    loadCameras().then(function () {
      if (destroyed) { return null; }
      populateCameraSelect();
      updateCameraMeta();
      if (!cameras.length) {
        renderNoCameraState();
      } else {
        loadStorageInfo();
        loadClips();
      }
      if (isAdmin()) { loadServerSettings(); }
      return refreshRecordStatus().catch(function () { return null; });
    }).then(function () {
      if (showBusy && refs && !destroyed) { ui.busy(refs.refreshBtn, false); }
    }).catch(function () {
      if (showBusy && refs && !destroyed) { ui.busy(refs.refreshBtn, false); }
    });
  }

  function render(container, viewCtx) {
    ctx = viewCtx;
    destroyed = false;
    refs = null;
    openLayers = [];
    localRecordings = [];
    finishedRecordings = [];
    cameras = Array.isArray(ctx.state.get('cameras')) ? ctx.state.get('cameras') : [];
    selectedIp = '';
    storageInfo = null;
    storageInfoIp = '';
    clipsAll = [];
    clipsDate = todayStr();
    clipFilter = 'all';

    buildPage(container);
    loadAllData(false);

    stopRecordPoll = CCTV.poll(function () {
      return refreshRecordStatus();
    }, {
      intervalMs: 5000,
      immediate: false,
      maxBackoffMs: 30000,
      pauseWhenHidden: true
    });
  }

  function destroy() {
    destroyed = true;
    storageSeq += 1;
    clipsSeq += 1;
    if (stopRecordPoll) {
      stopRecordPoll();
      stopRecordPoll = null;
    }
    closeLayers();
    if (clipsTable) {
      try { clipsTable.destroy(); } catch (err) { /* bỏ qua */ }
      clipsTable = null;
    }
    if (recordTable) {
      try { recordTable.destroy(); } catch (err) { /* bỏ qua */ }
      recordTable = null;
    }
    refs = null;
    ctx = null;
    cameras = [];
    localRecordings = [];
    finishedRecordings = [];
  }

  CCTV.views.register('storage', {
    title: 'Lưu trữ',
    icon: 'storage',
    roles: ['admin', 'viewer'],
    order: 50,
    render: render,
    destroy: destroy
  });
})();
