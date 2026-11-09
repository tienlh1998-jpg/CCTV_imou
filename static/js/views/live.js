/* =========================================================================
   CCTV Vision Hub v2.0 — view Xem trực tiếp (live)
   Owner: C2. MJPEG/audio/snapshot/record/PTZ/grid 1-4-9.
   Không mật khẩu trong URL/localStorage/DOM; server tự resolve credential.
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

  var ctxRef = null;
  var viewRoot = null;
  var refs = {};
  var destroyed = true;
  var tiles = [];
  var camerasCache = [];
  var view = {
    mode: '1',
    slots: [],
    activeIndex: 0,
    subtype: '1',
    ptzOpen: true,
    theater: false,
    cameraFilter: ''
  };
  var audioCtl = null;
  var audioKey = null;
  var recordings = {};
  var downloads = {};
  var hardware = {};
  var hardwareFetchedAt = {};
  var hardwareLoading = {};
  var stopCameraPoll = null;
  var stopRecordPoll = null;
  var recordClock = null;
  var fullscreenHandler = null;
  var theaterKeyHandler = null;
  var modals = [];
  var credentialPromptIp = null;
  var ptzSpeed = 5;
  var presetTarget = 1;

  /* ------------------------------ Helpers ------------------------------ */

  function maxSlots(mode) {
    if (mode === '3x3') { return 9; }
    if (mode === '2x2') { return 4; }
    return 1;
  }

  function scanDevices() {
    if (!ctxRef) { return []; }
    var scan = ctxRef.state.get('scan');
    return scan && Array.isArray(scan.devices) ? scan.devices : [];
  }

  function allCameras() {
    var list = [];
    var known = {};
    (camerasCache || []).forEach(function (cam) {
      if (!cam || !cam.ip) { return; }
      known[cam.ip] = true;
      list.push({
        ip: String(cam.ip),
        name: cam.name || cam.ip,
        group: cam.group || 'Chưa phân nhóm',
        model: cam.model || '',
        status: cam.status || 'unknown',
        raw: cam,
        source: 'managed'
      });
    });
    scanDevices().forEach(function (dev) {
      if (!dev || !dev.ip || known[dev.ip]) { return; }
      known[dev.ip] = true;
      list.push({
        ip: String(dev.ip),
        name: dev.name || dev.model || dev.ip,
        group: 'Kết quả quét',
        model: dev.model || '',
        status: dev.status || 'online',
        raw: dev,
        source: 'scan'
      });
    });
    return list;
  }

  function findCamera(ip) {
    var list = allCameras();
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].ip === ip) { return list[i]; }
    }
    return null;
  }

  function isDualLens(cam) {
    if (!cam || !cam.raw) { return false; }
    var haystack = String((cam.raw.model || '') + ' ' + (cam.raw.name || '')).toLowerCase();
    return haystack.indexOf('dual') !== -1 || haystack.indexOf('s7x') !== -1 ||
      haystack.indexOf('s2x') !== -1 || haystack.indexOf('cruiser dual') !== -1 ||
      haystack.indexOf('ranger dual') !== -1;
  }

  function slotAt(index) {
    return view.slots[index] || null;
  }

  function activeSlot() {
    return slotAt(view.activeIndex);
  }

  function activeCamera() {
    var slot = activeSlot();
    return slot ? findCamera(slot.ip) : null;
  }

  function activeChannel() {
    var slot = activeSlot();
    return slot ? slot.channel : 1;
  }

  function keyOf(ip, channel) {
    return String(ip) + '|' + String(channel);
  }

  function slotKey(slot) {
    return slot ? keyOf(slot.ip, slot.channel) : '';
  }

  function clockText(totalSeconds) {
    var total = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    if (h > 0) {
      return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function recordingFor(slot) {
    if (!slot) { return null; }
    return recordings[keyOf(slot.ip, slot.channel)] || null;
  }

  function recordingSeconds(rec) {
    if (!rec) { return 0; }
    if (rec.startedAtMs) {
      return Math.max(0, Math.floor((Date.now() - rec.startedAtMs) / 1000));
    }
    return Number(rec.duration) || 0;
  }

  function setButtonLabel(btn, text) {
    if (!btn) { return; }
    var labelNode = btn.querySelector('.c-btn__label');
    if (labelNode) { labelNode.textContent = String(text); }
    btn.setAttribute('title', String(text));
  }

  function setUseIcon(btn, iconName) {
    if (!btn) { return; }
    var use = btn.querySelector('use');
    if (!use) { return; }
    use.setAttribute('href', '#i-' + iconName);
    use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#i-' + iconName);
  }

  function addBadge(container, text, tone, icon) {
    var badge = ui.badge(text, { tone: tone || 'neutral' });
    if (icon) {
      badge.insertBefore(svg(icon, { size: 11 }), badge.firstChild);
    }
    container.appendChild(badge);
  }

  /* --------------------------- Camera options -------------------------- */

  function fillCameraSelect(select, includeEmpty, selectedIp) {
    if (!select) { return; }
    clear(select);
    select.appendChild(el('option', {
      attrs: { value: '' },
      text: includeEmpty ? '— Trống —' : '— Chọn camera —'
    }));
    var filter = String(view.cameraFilter || '').trim().toLowerCase();
    var list = allCameras().filter(function (cam) {
      if (!filter) { return true; }
      return (cam.name + ' ' + cam.ip + ' ' + cam.group + ' ' + cam.model).toLowerCase().indexOf(filter) !== -1;
    });
    var groups = {};
    list.forEach(function (cam) {
      if (!groups[cam.group]) { groups[cam.group] = []; }
      groups[cam.group].push(cam);
    });
    Object.keys(groups).sort(function (a, b) { return a.localeCompare(b, 'vi'); }).forEach(function (groupName) {
      var group = el('optgroup', { attrs: { label: groupName } });
      groups[groupName].sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'vi', { numeric: true }); }).forEach(function (cam) {
        var suffix = cam.status && cam.status !== 'online' ? ' — ' + fmt.status(cam.status).label : '';
        group.appendChild(el('option', {
          attrs: { value: cam.ip, title: cam.ip },
          text: cam.name + ' (' + cam.ip + ')' + suffix
        }));
      });
      select.appendChild(group);
    });

    if (selectedIp) {
      var exists = false;
      for (var i = 0; i < select.options.length; i += 1) {
        if (select.options[i].value === selectedIp) { exists = true; break; }
      }
      if (!exists) {
        select.appendChild(el('option', {
          attrs: { value: selectedIp },
          text: selectedIp + ' (không có trong danh sách)'
        }));
      }
      select.value = selectedIp;
    } else {
      select.value = '';
    }
  }

  function refillAllCameraSelects() {
    if (!refs.cameraSelect) { return; }
    var current = activeSlot();
    fillCameraSelect(refs.cameraSelect, false, current ? current.ip : '');
    tiles.forEach(function (tile, index) {
      if (!tile || !tile.select) { return; }
      var slot = slotAt(index);
      fillCameraSelect(tile.select, true, slot ? slot.ip : '');
    });
  }

  /* ----------------------------- Grid state ---------------------------- */

  function persistGrid() {
    if (!ctxRef) { return; }
    ctxRef.state.setUi('grid', { mode: view.mode, slots: view.slots });
  }

  function loadGridState() {
    var saved = ctxRef.state.getUi('grid', { mode: '1', slots: [] });
    var mode = saved && (saved.mode === '2x2' || saved.mode === '3x3') ? saved.mode : '1';
    view.mode = mode;
    view.slots = new Array(maxSlots(mode)).fill(null);
    if (saved && Array.isArray(saved.slots)) {
      saved.slots.slice(0, maxSlots(mode)).forEach(function (slot, index) {
        if (slot && slot.ip) {
          view.slots[index] = { ip: slot.ip, channel: slot.channel === 2 ? 2 : 1 };
        }
      });
    }
    var hasSlot = view.slots.some(function (slot) { return !!slot; });
    if (!hasSlot && allCameras().length) {
      view.slots[0] = { ip: allCameras()[0].ip, channel: 1 };
    }
    view.activeIndex = 0;
    for (var i = 0; i < view.slots.length; i += 1) {
      if (view.slots[i]) { view.activeIndex = i; break; }
    }
    persistGrid();
  }

  /* ------------------------------ Toolbar ------------------------------ */

  function controlLabel(text, select, className) {
    var wrap = el('label', { class: 'c-live__control' + (className ? ' ' + className : '') });
    wrap.appendChild(el('span', { class: 'u-sr-only', text: text }));
    wrap.appendChild(select);
    return wrap;
  }

  function buildToolbar() {
    var bar = el('div', { class: 'c-live__toolbar', attrs: { role: 'toolbar', 'aria-label': 'Điều khiển xem trực tiếp' } });

    var groupCamera = el('div', { class: 'c-live__toolbar-group' });
    refs.cameraSelect = el('select', {
      class: 'c-select',
      attrs: { id: 'live-camera-select-el', 'data-testid': 'live-camera-select', 'aria-label': 'Camera đang xem' }
    });
    refs.cameraSelect.addEventListener('change', function () {
      var ip = refs.cameraSelect.value;
      if (view.mode === '1') {
        assignSlot(0, ip);
      } else {
        assignSlot(view.activeIndex, ip);
      }
    });
    groupCamera.appendChild(controlLabel('Camera', refs.cameraSelect));

    refs.cameraFilter = ui.search({
      placeholder: 'Lọc camera…',
      ariaLabel: 'Lọc danh sách camera theo tên, IP, nhóm hoặc model',
      testId: 'live-camera-filter',
      onInput: function (value) {
        view.cameraFilter = value;
        refillAllCameraSelects();
        syncToolbar();
      }
    });
    refs.cameraFilter.el.classList.add('c-live__filter');
    groupCamera.appendChild(refs.cameraFilter.el);

    refs.qualitySelect = el('select', {
      class: 'c-select',
      attrs: { id: 'live-quality-el', 'data-testid': 'live-quality', 'aria-label': 'Chất lượng luồng' }
    });
    refs.qualitySelect.appendChild(el('option', { attrs: { value: '1' }, text: 'SD' }));
    refs.qualitySelect.appendChild(el('option', { attrs: { value: '0' }, text: 'HD' }));
    refs.qualitySelect.value = view.subtype;
    refs.qualitySelect.addEventListener('change', function () {
      view.subtype = refs.qualitySelect.value === '0' ? '0' : '1';
      tiles.forEach(function (tile) {
        if (tile && tile.ctl) { tile.ctl.setQuality(view.subtype); }
      });
      if (audioCtl) { stopAudio(); }
    });
    groupCamera.appendChild(controlLabel('Chất lượng', refs.qualitySelect, 'c-live__control--narrow'));

    refs.lensWrap = el('label', { class: 'c-live__control c-live__control--narrow', attrs: { hidden: '' } });
    refs.lensWrap.appendChild(el('span', { class: 'u-sr-only', text: 'Mắt camera' }));
    refs.lensSelect = el('select', {
      class: 'c-select',
      attrs: { id: 'live-lens-el', 'data-testid': 'live-lens', 'aria-label': 'Chọn mắt camera' }
    });
    refs.lensSelect.appendChild(el('option', { attrs: { value: '1' }, text: 'Mắt 1' }));
    refs.lensSelect.appendChild(el('option', { attrs: { value: '2' }, text: 'Mắt 2' }));
    refs.lensSelect.addEventListener('change', function () {
      var slot = activeSlot();
      if (!slot) { return; }
      slot.channel = refs.lensSelect.value === '2' ? 2 : 1;
      persistGrid();
      stopAudio();
      if (view.mode === '1') { renderStage(); } else { renderTile(view.activeIndex); }
      syncToolbar();
    });
    refs.lensWrap.appendChild(refs.lensSelect);
    groupCamera.appendChild(refs.lensWrap);

    var groupGrid = el('div', { class: 'c-live__toolbar-group' });
    var gridSegment = el('div', { class: 'c-segment', attrs: { role: 'group', 'aria-label': 'Bố cục lưới' } });
    refs.gridButtons = {};
    [['1', '1', 'live-grid-1'], ['2x2', '2×2', 'live-grid-2x2'], ['3x3', '3×3', 'live-grid-3x3']].forEach(function (item) {
      var mode = item[0];
      var btn = el('button', {
        class: 'c-segment__btn' + (view.mode === mode ? ' is-active' : ''),
        attrs: {
          type: 'button',
          'aria-pressed': view.mode === mode ? 'true' : 'false',
          'data-testid': item[2]
        },
        text: item[1]
      });
      btn.addEventListener('click', function () { setGridMode(mode); });
      refs.gridButtons[mode] = btn;
      gridSegment.appendChild(btn);
    });
    groupGrid.appendChild(gridSegment);
    bar.appendChild(groupCamera);
    bar.appendChild(groupGrid);

    var groupActions = el('div', { class: 'c-live__toolbar-group' });

    refs.audioBtn = ui.button({
      label: 'Âm thanh',
      icon: 'volume-x',
      variant: 'secondary',
      size: 'sm',
      testId: 'live-audio-btn',
      onClick: function () { toggleAudio(); }
    });
    groupActions.appendChild(refs.audioBtn);

    refs.snapshotBtn = ui.button({
      label: 'Snapshot',
      icon: 'snapshot',
      variant: 'secondary',
      size: 'sm',
      testId: 'live-snapshot-btn',
      onClick: function () {
        var slot = activeSlot();
        if (!slot) { ui.toast('Chọn camera trước khi chụp ảnh.', { type: 'warning' }); return; }
        takeSnapshot(slot.ip, slot.channel);
      }
    });
    groupActions.appendChild(refs.snapshotBtn);

    if (ctxRef.isAdmin) {
      refs.recordBtn = ui.button({
        label: 'Ghi hình',
        icon: 'record',
        variant: 'secondary',
        size: 'sm',
        testId: 'live-record-btn',
        onClick: function () { toggleRecord(); }
      });
      groupActions.appendChild(refs.recordBtn);

      refs.ptzToggle = ui.button({
        label: 'PTZ',
        icon: 'ptz',
        variant: 'secondary',
        size: 'sm',
        ariaLabel: 'Bật tắt bảng điều khiển PTZ',
        onClick: function () { setPtzOpen(!view.ptzOpen); }
      });
      refs.ptzToggle.setAttribute('aria-pressed', view.ptzOpen ? 'true' : 'false');
      groupActions.appendChild(refs.ptzToggle);

      refs.externalBtn = ui.button({
        label: 'Trình phát ngoài',
        icon: 'external-link',
        variant: 'secondary',
        size: 'sm',
        testId: 'live-external-player',
        onClick: function () { openExternalPlayer(); }
      });
      groupActions.appendChild(refs.externalBtn);
    }

    refs.theaterBtn = ui.button({
      label: 'Theater',
      icon: 'layers',
      variant: 'secondary',
      size: 'sm',
      onClick: function () { toggleTheater(); }
    });
    refs.theaterBtn.setAttribute('aria-pressed', 'false');
    groupActions.appendChild(refs.theaterBtn);

    refs.fullscreenBtn = ui.button({
      label: 'Toàn màn hình',
      icon: 'maximize',
      variant: 'secondary',
      size: 'sm',
      onClick: function () { toggleFullscreen(); }
    });
    groupActions.appendChild(refs.fullscreenBtn);

    bar.appendChild(groupActions);
    return bar;
  }

  /* ------------------------------- Tiles ------------------------------- */

  function buildTile(index) {
    var slot = slotAt(index);
    var cam = slot ? findCamera(slot.ip) : null;
    var dual = isDualLens(cam);
    var root = el('figure', {
      class: 'c-video-tile' + (index === view.activeIndex ? ' is-active' : ''),
      attrs: {
        'data-testid': 'live-tile',
        'data-slot': String(index),
        'aria-label': slot ? ('Ô xem ' + (cam ? cam.name : slot.ip)) : 'Ô xem trống'
      }
    });

    var media = el('div', { class: 'c-video-tile__media' });
    var overlay = el('div', { class: 'c-video-tile__overlay' });
    var top = el('div', { class: 'c-video-tile__top' });
    var identity = el('div', { class: 'c-video-tile__id' });
    var nameNode = el('span', { class: 'c-video-tile__name', text: slot ? (cam ? cam.name : slot.ip) : 'Chọn camera' });
    var ipNode = el('span', { class: 'c-video-tile__ip', text: slot ? slot.ip : '' });
    identity.appendChild(nameNode);
    identity.appendChild(ipNode);
    var badges = el('div', { class: 'c-video-tile__badges' });
    top.appendChild(identity);
    top.appendChild(badges);

    var bottom = el('div', { class: 'c-video-tile__bottom' });
    var statusWrap = el('div', { class: 'c-video-tile__badges' });
    var actions = el('div', { class: 'c-video-tile__actions' });
    bottom.appendChild(statusWrap);
    bottom.appendChild(actions);
    overlay.appendChild(top);
    overlay.appendChild(bottom);

    var stateLayer = el('div', { class: 'c-video-tile__state', attrs: { hidden: '' } });
    media.appendChild(overlay);
    media.appendChild(stateLayer);

    var tile = {
      index: index,
      root: root,
      media: media,
      overlay: overlay,
      identity: identity,
      nameNode: nameNode,
      ipNode: ipNode,
      badges: badges,
      statusWrap: statusWrap,
      actions: actions,
      stateLayer: stateLayer,
      select: null,
      ctl: null,
      img: null,
      liveState: 'idle',
      slot: slot,
      downloadBtn: null
    };
    /* Gán sớm để callback 'connecting' của media tìm thấy tile trong mảng. */
    tiles[index] = tile;

    if (!slot) {
      overlay.hidden = true;
      var placeholder = el('div', { class: 'c-video-tile__empty' });
      placeholder.appendChild(svg('video', { size: 20 }));
      placeholder.appendChild(el('span', { text: 'Chọn camera cho ô này' }));
      media.appendChild(placeholder);
      root.appendChild(media);
    } else {
      if (dual) {
        actions.appendChild(ui.iconButton({
          icon: 'layers',
          label: 'Đổi sang mắt ' + (slot.channel === 2 ? '1' : '2'),
          size: 'sm',
          onClick: function () { switchLens(index); }
        }));
      }
      actions.appendChild(ui.iconButton({
        icon: 'snapshot',
        label: 'Chụp ảnh từ ' + (cam ? cam.name : slot.ip),
        size: 'sm',
        onClick: function () { takeSnapshot(slot.ip, slot.channel); }
      }));
      if (view.mode !== '1') {
        actions.appendChild(ui.iconButton({
          icon: 'maximize',
          label: 'Phóng to camera ' + (cam ? cam.name : slot.ip),
          size: 'sm',
          onClick: function () { maximizeTile(index); }
        }));
      }
      var download = downloads[keyOf(slot.ip, slot.channel)];
      if (download) {
        tile.downloadBtn = ui.iconButton({
          icon: 'download',
          label: 'Tải bản ghi gần nhất',
          size: 'sm',
          onClick: function () { downloadRecording(slot.ip, slot.channel); }
        });
        actions.appendChild(tile.downloadBtn);
      }
      actions.appendChild(ui.iconButton({
        icon: 'x',
        label: 'Gỡ camera khỏi ô',
        size: 'sm',
        onClick: function () { assignSlot(index, ''); }
      }));

      root.appendChild(media);
      startTileMedia(tile);
    }

    if (view.mode !== '1') {
      var footer = el('div', { class: 'c-video-tile__footer' });
      var selectId = 'live-slot-select-' + index;
      var label = el('label', { class: 'u-sr-only', attrs: { for: selectId }, text: 'Chọn camera cho ô ' + (index + 1) });
      var select = el('select', {
        class: 'c-select',
        attrs: { id: selectId, 'aria-label': 'Chọn camera cho ô ' + (index + 1) }
      });
      fillCameraSelect(select, true, slot ? slot.ip : '');
      select.addEventListener('change', function () { assignSlot(index, select.value); });
      footer.appendChild(label);
      footer.appendChild(select);
      if (slot && dual) {
        footer.appendChild(ui.badge('Mắt ' + slot.channel, { tone: 'info' }));
      }
      tile.select = select;
      root.appendChild(footer);
    }

    root.addEventListener('click', function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest('button,a,select,input,label')) { return; }
      setActive(index);
    });
    root.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') { return; }
      if (ev.target && ev.target.closest && ev.target.closest('button,a,select,input,label')) { return; }
      ev.preventDefault();
      setActive(index);
    });
    root.setAttribute('tabindex', '0');

    return tile;
  }

  function startTileMedia(tile) {
    var slot = tile.slot;
    if (!slot) { return; }
    var cam = findCamera(slot.ip);
    var img = el('img', {
      attrs: {
        alt: 'Luồng trực tiếp ' + (cam ? cam.name : slot.ip),
        decoding: 'async'
      }
    });
    tile.img = img;
    tile.media.insertBefore(img, tile.overlay);
    setTileState(tile.index, 'connecting');
    tile.ctl = CCTV.media.mjpeg(img, {
      ip: slot.ip,
      subtype: view.subtype,
      channel: slot.channel,
      onState: function (state, info) { onTileState(tile.index, state, info || {}); }
    });
  }

  function stopTileMedia(index) {
    var tile = tiles[index];
    if (!tile) { return; }
    if (tile.ctl) {
      try { tile.ctl.stop(); } catch (err) { /* bỏ qua */ }
      tile.ctl = null;
    }
    if (tile.img) {
      tile.img.removeAttribute('src');
      if (tile.img.parentNode) { tile.img.remove(); }
      tile.img = null;
    }
  }

  function stopAllMedia() {
    for (var i = 0; i < tiles.length; i += 1) { stopTileMedia(i); }
    stopAudio();
  }

  function onTileState(index, state, info) {
    var tile = tiles[index];
    if (!tile) { return; }
    if (state === 'live') {
      tile.liveState = 'live';
      setTileState(index, 'live');
      if (index === view.activeIndex) { refreshHardware(tile.slot.ip); }
    } else if (state === 'connecting') {
      tile.liveState = 'connecting';
      setTileState(index, 'connecting');
    } else if (state === 'credential-required') {
      tile.liveState = 'credential';
      setTileState(index, 'credential', info);
      if (ctxRef.isAdmin && index === view.activeIndex) {
        openCredentialModal(tile.slot.ip);
      }
    } else if (state === 'unavailable') {
      tile.liveState = 'unavailable';
      setTileState(index, 'unavailable', info);
    } else {
      tile.liveState = 'error';
      setTileState(index, 'error', info);
    }
    updateTileBadges(index);
  }

  function setTileState(index, kind, info) {
    var tile = tiles[index];
    if (!tile) { return; }
    var layer = tile.stateLayer;
    clear(layer);
    if (kind === 'live') {
      layer.hidden = true;
      return;
    }
    layer.hidden = false;
    layer.className = 'c-video-tile__state' + (kind === 'error' || kind === 'credential' || kind === 'unavailable' ? ' c-video-tile__state--error' : '');

    var iconWrap = el('span');
    if (kind === 'connecting') {
      iconWrap.appendChild(svg('loader', { size: 22, class: 'c-spin' }));
    } else if (kind === 'credential') {
      iconWrap.appendChild(svg('lock', { size: 22 }));
    } else if (kind === 'unavailable') {
      iconWrap.appendChild(svg('alert-triangle', { size: 22 }));
    } else {
      iconWrap.appendChild(svg('alert-circle', { size: 22 }));
    }
    layer.appendChild(iconWrap);

    var title = 'Không kết nối được camera';
    var message = '';
    var actions = el('div', { class: 'c-row c-row--wrap' });

    if (kind === 'connecting') {
      title = 'Đang kết nối…';
      message = 'Luồng MJPEG đang được thiết lập.';
    } else if (kind === 'credential') {
      title = 'Cần mật khẩu camera';
      message = ctxRef.isAdmin
        ? 'Camera chưa có thông tin đăng nhập đã lưu. Nhập mật khẩu tạm để tiếp tục.'
        : 'Camera chưa được cấu hình mật khẩu. Liên hệ quản trị viên.';
      if (ctxRef.isAdmin) {
        actions.appendChild(ui.button({
          label: 'Nhập mật khẩu',
          icon: 'key',
          variant: 'primary',
          size: 'sm',
          onClick: function () { openCredentialModal(tile.slot.ip); }
        }));
      }
    } else if (kind === 'unavailable') {
      title = 'Thiếu FFmpeg';
      message = 'Máy chủ chưa có FFmpeg nên không thể phát hoặc chụp ảnh. Liên hệ quản trị viên để cài đặt.';
      actions.appendChild(ui.button({
        label: 'Thử lại',
        icon: 'refresh',
        variant: 'secondary',
        size: 'sm',
        onClick: function () { retryTile(index); }
      }));
      if (ctxRef.isAdmin) {
        actions.appendChild(ui.button({
          label: 'Mở cài đặt',
          icon: 'settings',
          variant: 'secondary',
          size: 'sm',
          onClick: function () { if (ctxRef) { ctxRef.router.go('settings'); } }
        }));
      }
    } else {
      title = 'Không thể xem camera';
      message = info && info.message ? info.message : 'Camera không phản hồi hoặc luồng bị gián đoạn.';
      if (info && info.code) { message += ' (' + info.code + ')'; }
      actions.appendChild(ui.button({
        label: 'Thử lại',
        icon: 'refresh',
        variant: 'secondary',
        size: 'sm',
        onClick: function () { retryTile(index); }
      }));
    }

    layer.appendChild(el('div', { class: 'c-video-tile__state-title', text: title }));
    layer.appendChild(el('div', { class: 'c-video-tile__state-text', text: message }));
    if (actions.children.length) { layer.appendChild(actions); }
  }

  function updateTileBadges(index) {
    var tile = tiles[index];
    if (!tile) { return; }
    if (!tile.slot) {
      clear(tile.badges);
      clear(tile.statusWrap);
      return;
    }
    clear(tile.badges);
    clear(tile.statusWrap);
    var cam = findCamera(tile.slot.ip);
    if (cam && cam.status) {
      tile.statusWrap.appendChild(ui.statusPill(cam.status));
    }
    if (tile.liveState === 'live') {
      addBadge(tile.badges, 'LIVE', 'danger', 'dot');
    }
    var rec = recordingFor(tile.slot);
    if (rec) {
      addBadge(tile.badges, 'REC ' + clockText(recordingSeconds(rec)), 'danger', 'record');
    }
    if (audioKey === slotKey(tile.slot)) {
      addBadge(tile.badges, 'Âm thanh', 'info', 'volume');
    }
    var hw = hardware[tile.slot.ip];
    if (hw) {
      if (hw.privacy) { addBadge(tile.badges, 'Riêng tư', 'warning', 'eye-off'); }
      if (hw.tracking) { addBadge(tile.badges, 'Bám người', 'info', 'ptz'); }
      if (hw.siren) { addBadge(tile.badges, 'Còi', 'danger', 'bell'); }
    }
  }

  function updateAllBadges() {
    for (var i = 0; i < tiles.length; i += 1) { updateTileBadges(i); }
  }

  function updateActiveClasses() {
    tiles.forEach(function (tile, index) {
      if (!tile) { return; }
      tile.root.classList.toggle('is-active', index === view.activeIndex);
    });
  }

  function renderTile(index) {
    var old = tiles[index];
    stopTileMedia(index);
    var tile = buildTile(index);
    if (old && old.root.parentNode) {
      old.root.parentNode.replaceChild(tile.root, old.root);
    } else if (refs.grid) {
      refs.grid.appendChild(tile.root);
    }
    tiles[index] = tile;
    updateActiveClasses();
    updateTileBadges(index);
    syncToolbar();
  }

  function renderStage() {
    if (!refs.grid) { return; }
    stopAllMedia();
    clear(refs.grid);
    tiles = [];
    refs.grid.setAttribute('data-grid', view.mode);

    if (view.mode === '1' && !view.slots[0]) {
      var box = el('div', { class: 'c-card' });
      var body = el('div', { class: 'c-card__body' });
      body.appendChild(ui.empty({
        icon: 'live',
        title: 'Chưa chọn camera',
        description: 'Chọn camera ở thanh công cụ để bắt đầu xem trực tiếp.',
        action: [ui.button({
          label: 'Chọn camera',
          icon: 'search',
          variant: 'secondary',
          onClick: function () { if (refs.cameraSelect) { refs.cameraSelect.focus(); } }
        })]
      }));
      box.appendChild(body);
      refs.grid.appendChild(box);
      syncToolbar();
      return;
    }

    for (var i = 0; i < maxSlots(view.mode); i += 1) {
      var tile = buildTile(i);
      tiles[i] = tile;
      refs.grid.appendChild(tile.root);
    }
    updateActiveClasses();
    syncToolbar();
  }

  function assignSlot(index, ip) {
    if (index < 0 || index >= view.slots.length) { return; }
    var previous = view.slots[index];
    if (!ip && !previous) { return; }
    if (ip && previous && previous.ip === ip) {
      view.activeIndex = index;
      updateActiveClasses();
      syncToolbar();
      return;
    }
    if (previous && audioKey === keyOf(previous.ip, previous.channel)) { stopAudio(); }
    if (!ip) {
      view.slots[index] = null;
    } else {
      view.slots[index] = {
        ip: String(ip),
        channel: previous && previous.ip === ip ? previous.channel : 1
      };
      view.activeIndex = index;
    }
    persistGrid();
    if (view.mode === '1') {
      renderStage();
    } else {
      renderTile(index);
      updateActiveClasses();
    }
    syncToolbar();
    if (ip) { refreshHardware(ip); }
  }

  function setGridMode(mode) {
    var target = mode === '2x2' || mode === '3x3' ? mode : '1';
    if (target === view.mode) { return; }
    stopAudio();
    stopAllMedia();
    var previousSlots = view.slots.slice();
    view.mode = target;
    var max = maxSlots(target);
    var next = new Array(max).fill(null);
    for (var i = 0; i < Math.min(max, previousSlots.length); i += 1) {
      next[i] = previousSlots[i] ? { ip: previousSlots[i].ip, channel: previousSlots[i].channel } : null;
    }
    view.slots = next;
    var first = next.findIndex(function (slot) { return !!slot; });
    view.activeIndex = first >= 0 ? first : 0;
    persistGrid();
    renderStage();
  }

  function setActive(index) {
    if (index < 0 || index >= maxSlots(view.mode)) { return; }
    if (index === view.activeIndex) {
      syncToolbar();
      return;
    }
    stopAudio();
    view.activeIndex = index;
    updateActiveClasses();
    syncToolbar();
    var slot = activeSlot();
    if (slot) { refreshHardware(slot.ip); }
  }

  function switchLens(index) {
    var slot = slotAt(index);
    if (!slot) { return; }
    slot.channel = slot.channel === 2 ? 1 : 2;
    persistGrid();
    stopAudio();
    if (view.mode === '1') { renderStage(); } else { renderTile(index); }
    syncToolbar();
  }

  function maximizeTile(index) {
    var slot = slotAt(index);
    if (!slot) { return; }
    stopAudio();
    view.mode = '1';
    view.slots = [{ ip: slot.ip, channel: slot.channel }];
    view.activeIndex = 0;
    persistGrid();
    renderStage();
  }

  function retryTile(index) {
    var slot = slotAt(index);
    if (!slot) { return; }
    if (view.mode === '1') {
      renderStage();
    } else {
      renderTile(index);
    }
  }

  function restartTilesForIp(ip) {
    for (var i = 0; i < view.slots.length; i += 1) {
      var slot = view.slots[i];
      if (slot && slot.ip === ip) {
        delete hardwareFetchedAt[ip];
        if (view.mode === '1') { renderStage(); return; }
        renderTile(i);
      }
    }
    syncToolbar();
  }

  /* ------------------------------- Audio ------------------------------- */

  function stopAudio() {
    if (audioCtl) {
      try { audioCtl.stop(); } catch (err) { /* bỏ qua */ }
    }
    audioCtl = null;
    audioKey = null;
    updateAllBadges();
    syncToolbar();
  }

  function toggleAudio() {
    if (audioCtl) {
      stopAudio();
      return;
    }
    var slot = activeSlot();
    if (!slot) {
      ui.toast('Chọn camera trước khi bật âm thanh.', { type: 'warning' });
      return;
    }
    var ctl = CCTV.media.audio({ ip: slot.ip, subtype: view.subtype, channel: slot.channel });
    audioCtl = ctl;
    audioKey = keyOf(slot.ip, slot.channel);
    ctl.play().then(function () {
      if (destroyed || audioCtl !== ctl) {
        ctl.stop();
        return;
      }
      ui.toast('Đang phát âm thanh từ camera.', { type: 'info', duration: 2500 });
      updateAllBadges();
      syncToolbar();
    }).catch(function () {
      if (audioCtl === ctl) {
        audioCtl = null;
        audioKey = null;
        ctl.stop();
      }
      ui.toast('Không phát được âm thanh. Kiểm tra FFmpeg, quyền truy cập hoặc âm lượng trình duyệt.', { type: 'error' });
      syncToolbar();
    });
  }

  /* -------------------------- Snapshot / record ------------------------ */

  function takeSnapshot(ip, channel) {
    if (!ip || !ctxRef) { return; }
    CCTV.media.snapshot(ip, {
      channel: channel === 2 ? 2 : 1,
      subtype: '0',
      silent: true,
      signal: ctxRef.signal
    }).then(function (result) {
      /* Ảnh đã được tải xuống; giải phóng blob URL để không giữ tới khi đóng tab. */
      if (result && result.url) { CCTV.media.revoke(result.url); }
      ui.toast('Đã tải ảnh chụp từ camera.', { type: 'success' });
    }).catch(function (err) {
      if (err && err.code === 'ABORTED') { return; }
      ui.toast(fmt.errorCode(err && err.code ? err.code : '') || (err && err.message) || 'Không chụp được ảnh.', { type: 'error' });
    });
  }

  function syncRecordButton() {
    if (!refs.recordBtn) { return; }
    var slot = activeSlot();
    var rec = recordingFor(slot);
    if (rec) {
      setButtonLabel(refs.recordBtn, 'Dừng ghi');
      setUseIcon(refs.recordBtn, 'stop');
      refs.recordBtn.setAttribute('aria-pressed', 'true');
    } else {
      setButtonLabel(refs.recordBtn, 'Ghi hình');
      setUseIcon(refs.recordBtn, 'record');
      refs.recordBtn.setAttribute('aria-pressed', 'false');
    }
    refs.recordBtn.disabled = !slot;
  }

  function ensureRecordTimers() {
    if (destroyed) { return; }
    if (!stopRecordPoll) {
      stopRecordPoll = CCTV.poll(function () {
        if (destroyed) { return null; }
        return ctxRef.api.get('/api/record/status', { signal: ctxRef.signal, silent: true }).then(function (data) {
          var list = data && Array.isArray(data.recordings) ? data.recordings : [];
          var next = {};
          list.forEach(function (rec) {
            if (!rec || !rec.ip) { return; }
            var key = keyOf(rec.ip, rec.channel || 1);
            var previous = recordings[key];
            var duration = Number(rec.duration) || 0;
            next[key] = {
              filename: rec.filename || '',
              duration: duration,
              startedAt: rec.started_at || null,
              startedAtMs: previous && previous.startedAtMs
                ? previous.startedAtMs
                : Date.now() - (duration * 1000)
            };
          });
          recordings = next;
          updateAllBadges();
          syncRecordButton();
          maybeStopRecordTimers();
          return null;
        }).catch(function () { return null; });
      }, { intervalMs: 3000, immediate: true, pauseWhenHidden: true });
    }
    if (!recordClock) {
      recordClock = setInterval(function () {
        if (destroyed) { return; }
        updateAllBadges();
      }, 1000);
    }
  }

  function maybeStopRecordTimers() {
    if (Object.keys(recordings).length) { return; }
    if (stopRecordPoll) { stopRecordPoll(); stopRecordPoll = null; }
    if (recordClock) { clearInterval(recordClock); recordClock = null; }
  }

  function startRecording() {
    var slot = activeSlot();
    if (!slot) { return; }
    ctxRef.api.post('/api/record/start', {
      ip: slot.ip,
      subtype: view.subtype,
      channel: slot.channel
    }, { signal: ctxRef.signal, silent: true }).then(function (data) {
      recordings[keyOf(slot.ip, slot.channel)] = {
        filename: data && data.filename ? data.filename : '',
        duration: 0,
        startedAt: data && data.started_at ? data.started_at : null,
        startedAtMs: Date.now()
      };
      ensureRecordTimers();
      updateAllBadges();
      syncRecordButton();
      ui.toast('Đã bắt đầu ghi hình.', { type: 'success' });
    }).catch(function (err) {
      if (err && err.code === 'ALREADY_RECORDING') {
        recordings[keyOf(slot.ip, slot.channel)] = {
          filename: err.details && err.details.filename ? err.details.filename : '',
          duration: 0,
          startedAt: null,
          startedAtMs: Date.now()
        };
        ensureRecordTimers();
        updateAllBadges();
        syncRecordButton();
        ui.toast('Camera đang ghi hình.', { type: 'warning' });
        return;
      }
      if (err && err.code !== 'ABORTED') {
        ui.toast(err.message || 'Không bắt đầu ghi hình được.', { type: 'error' });
      }
    });
  }

  function stopRecording() {
    var slot = activeSlot();
    if (!slot) { return; }
    var key = keyOf(slot.ip, slot.channel);
    ctxRef.api.post('/api/record/stop', {
      ip: slot.ip,
      channel: slot.channel
    }, { signal: ctxRef.signal, silent: true }).then(function (data) {
      delete recordings[key];
      if (data && data.download_url) {
        downloads[key] = {
          url: data.download_url,
          filename: data.filename || 'recording.mp4'
        };
      }
      maybeStopRecordTimers();
      updateAllBadges();
      syncRecordButton();
      ensureDownloadAction(slot.ip, slot.channel);
      ui.toast('Đã dừng ghi hình. Bản ghi sẵn sàng để tải.', { type: 'success' });
    }).catch(function (err) {
      if (err && err.code === 'NOT_RECORDING') {
        delete recordings[key];
        maybeStopRecordTimers();
        updateAllBadges();
        syncRecordButton();
        ui.toast('Camera không còn ghi hình.', { type: 'info' });
        return;
      }
      if (err && err.code !== 'ABORTED') {
        ui.toast(err.message || 'Không dừng ghi hình được.', { type: 'error' });
      }
    });
  }

  function toggleRecord() {
    var slot = activeSlot();
    if (!slot) {
      ui.toast('Chọn camera trước khi ghi hình.', { type: 'warning' });
      return;
    }
    if (recordingFor(slot)) { stopRecording(); } else { startRecording(); }
  }

  function downloadRecording(ip, channel) {
    var info = downloads[keyOf(ip, channel)];
    if (!info) { return; }
    ctxRef.api.download(info.url, info.filename, { signal: ctxRef.signal }).then(function () {
      ui.toast('Đang tải bản ghi.', { type: 'info', duration: 2500 });
    }).catch(function (err) {
      if (err && err.code !== 'ABORTED') {
        ui.toast(err.message || 'Không tải được bản ghi.', { type: 'error' });
      }
    });
  }

  function ensureDownloadAction(ip, channel) {
    if (!downloads[keyOf(ip, channel)]) { return; }
    for (var i = 0; i < view.slots.length; i += 1) {
      var slot = view.slots[i];
      if (!slot || slot.ip !== ip || slot.channel !== channel) { continue; }
      var tile = tiles[i];
      if (!tile || tile.downloadBtn) { continue; }
      tile.downloadBtn = ui.iconButton({
        icon: 'download',
        label: 'Tải bản ghi gần nhất',
        size: 'sm',
        onClick: function () { downloadRecording(ip, channel); }
      });
      tile.actions.appendChild(tile.downloadBtn);
    }
  }

  /* -------------------------------- PTZ -------------------------------- */

  function ptzPanelVisible() {
    return !!refs.ptzPanel && view.ptzOpen;
  }

  function setPtzOpen(open) {
    view.ptzOpen = !!open;
    if (refs.layout) { refs.layout.classList.toggle('is-ptz-collapsed', !view.ptzOpen); }
    if (refs.ptzPanel) { refs.ptzPanel.hidden = !view.ptzOpen; }
    if (refs.ptzToggle) { refs.ptzToggle.setAttribute('aria-pressed', view.ptzOpen ? 'true' : 'false'); }
  }

  function sendPtz(action, preset) {
    var slot = activeSlot();
    if (!slot) {
      ui.toast('Chọn camera trước khi điều khiển PTZ.', { type: 'warning' });
      return;
    }
    var body = { ip: slot.ip, action: action, speed: ptzSpeed };
    if (preset !== undefined && preset !== null) { body.preset = preset; }
    ctxRef.api.post('/api/ptz', body, { signal: ctxRef.signal, silent: true }).catch(function (err) {
      if (!err || err.code === 'ABORTED') { return; }
      if (err.code === 'RATE_LIMITED') {
        ui.toast('Thao tác PTZ quá nhanh' + (err.retryAfterSeconds ? '. Thử lại sau ' + err.retryAfterSeconds + ' giây.' : '.'), { type: 'warning' });
        return;
      }
      ui.toast(err.message || 'Không gửi được lệnh PTZ.', { type: 'error' });
    });
  }

  function getPresetLabels(ip) {
    var presets = ctxRef.state.getUi('ptzPresets', {}) || {};
    return presets[ip] || {};
  }

  function savePresetLabel(ip, number, label) {
    var presets = ctxRef.state.getUi('ptzPresets', {}) || {};
    var forIp = Object.assign({}, presets[ip] || {});
    if (label) {
      forIp[String(number)] = String(label).trim().slice(0, 32);
    } else {
      delete forIp[String(number)];
    }
    presets[ip] = forIp;
    if (!Object.keys(forIp).length) { delete presets[ip]; }
    ctxRef.state.setUi('ptzPresets', presets);
  }

  function refreshPresetLabels() {
    if (!refs.presetGrid) { return; }
    var slot = activeSlot();
    var labels = slot ? getPresetLabels(slot.ip) : {};
    for (var i = 1; i <= 8; i += 1) {
      var btn = refs.presetGrid.querySelector('[data-preset="' + i + '"]');
      if (!btn) { continue; }
      var text = labels[String(i)] || 'Preset ' + i;
      var labelNode = btn.querySelector('span');
      if (labelNode) { labelNode.textContent = text; labelNode.setAttribute('title', text); }
      btn.classList.toggle('is-set', !!labels[String(i)]);
    }
  }

  function openPresetRename() {
    var slot = activeSlot();
    if (!slot) {
      ui.toast('Chọn camera trước khi đặt tên preset.', { type: 'warning' });
      return;
    }
    var number = presetTarget;
    var labels = getPresetLabels(slot.ip);
    var nameField = ui.field({
      label: 'Tên gợi nhớ cho preset ' + number,
      type: 'text',
      value: labels[String(number)] || '',
      maxlength: 32,
      autocomplete: 'off',
      help: 'Chỉ lưu trên trình duyệt này, tối đa 32 ký tự.'
    });
    var handle = null;
    var saveBtn = ui.button({
      label: 'Lưu tên',
      variant: 'primary',
      onClick: function () {
        savePresetLabel(slot.ip, number, nameField.getValue());
        handle.close();
        refreshPresetLabels();
        ui.toast('Đã lưu tên preset.', { type: 'success' });
      }
    });
    var cancelBtn = ui.button({ label: 'Huỷ', variant: 'secondary', onClick: function () { handle.close(); } });
    handle = ui.modal({
      title: 'Đặt tên preset ' + number,
      body: nameField.el,
      footer: [cancelBtn, saveBtn],
      size: 'sm',
      dismissible: true
    });
    modals.push(handle);
  }

  function buildPtzPanel() {
    var panel = el('aside', {
      class: 'c-ptz',
      attrs: { 'data-testid': 'live-ptz-panel', 'aria-label': 'Bảng điều khiển PTZ', tabindex: '0' }
    });
    var header = el('div', { class: 'c-ptz__header' });
    header.appendChild(el('span', { class: 'c-ptz__title', text: 'Điều khiển PTZ' }));
    header.appendChild(ui.iconButton({
      icon: 'chevron-right',
      label: 'Ẩn bảng PTZ',
      size: 'sm',
      onClick: function () { setPtzOpen(false); }
    }));
    panel.appendChild(header);
    var body = el('div', { class: 'c-ptz__body' });
    panel.appendChild(body);

    var pad = el('div', { class: 'c-ptz__pad' });
    var padMap = [
      { pos: '1', action: null },
      { pos: '2', action: 'Up', icon: 'chevron-up', label: 'Lên' },
      { pos: '3', action: null },
      { pos: '4', action: 'Left', icon: 'chevron-left', label: 'Trái' },
      { pos: '5', action: 'Stop', label: 'Dừng', stop: true },
      { pos: '6', action: 'Right', icon: 'chevron-right', label: 'Phải' },
      { pos: '7', action: null },
      { pos: '8', action: 'Down', icon: 'chevron-down', label: 'Xuống' },
      { pos: '9', action: null }
    ];
    padMap.forEach(function (item) {
      if (!item.action) {
        pad.appendChild(el('span', { attrs: { 'aria-hidden': 'true' } }));
        return;
      }
      var btn = el('button', {
        class: 'c-ptz__btn' + (item.stop ? ' c-ptz__btn--stop' : ''),
        attrs: { type: 'button', 'aria-label': 'PTZ ' + item.label, title: item.label },
        on: { click: function () { sendPtz(item.action); } }
      });
      if (item.stop) {
        btn.appendChild(svg('stop', { size: 16 }));
      } else {
        btn.appendChild(svg(item.icon, { size: 18 }));
      }
      pad.appendChild(btn);
    });
    body.appendChild(pad);

    var stepRow = el('div', { class: 'c-ptz__step-row', attrs: { role: 'group', 'aria-label': 'Bước nhỏ' } });
    [['StepLeft', 'chevron-left', 'Bước trái'], ['StepUp', 'chevron-up', 'Bước lên'], ['StepDown', 'chevron-down', 'Bước xuống'], ['StepRight', 'chevron-right', 'Bước phải']].forEach(function (item) {
      var btn = el('button', {
        class: 'c-ptz__btn',
        attrs: { type: 'button', 'aria-label': 'PTZ ' + item[2], title: item[2] },
        on: { click: function () { sendPtz(item[0]); } }
      });
      btn.appendChild(svg(item[1], { size: 14 }));
      btn.appendChild(el('span', { text: item[2] }));
      stepRow.appendChild(btn);
    });
    body.appendChild(stepRow);

    var speedWrap = el('div', { class: 'c-ptz__speed' });
    var speedLabel = el('label', { attrs: { for: 'live-ptz-speed' }, text: 'Tốc độ: ' + ptzSpeed });
    var speedInput = el('input', {
      attrs: { id: 'live-ptz-speed', type: 'range', min: '1', max: '8', step: '1', value: String(ptzSpeed) }
    });
    speedInput.addEventListener('input', function () {
      ptzSpeed = clampNumber(Number(speedInput.value) || 5, 1, 8);
      speedLabel.textContent = 'Tốc độ: ' + ptzSpeed;
    });
    speedWrap.appendChild(speedLabel);
    speedWrap.appendChild(speedInput);
    body.appendChild(speedWrap);

    body.appendChild(el('div', { class: 'c-divider' }));
    body.appendChild(el('div', { class: 'c-ptz__title', text: 'Preset góc quay' }));
    var presetGrid = el('div', { class: 'c-ptz__presets' });
    for (var i = 1; i <= 8; i += 1) {
      (function (number) {
        var btn = el('button', {
          class: 'c-ptz__preset',
          attrs: { type: 'button', 'data-preset': String(number), 'aria-label': 'Gọi preset ' + number, title: 'Gọi preset ' + number },
          on: { click: function () { presetTarget = number; presetSelect.value = String(number); sendPtz('GotoPreset', number); } }
        });
        btn.appendChild(el('b', { text: String(number) }));
        btn.appendChild(el('span', { text: 'Preset ' + number }));
        presetGrid.appendChild(btn);
      })(i);
    }
    body.appendChild(presetGrid);
    refs.presetGrid = presetGrid;

    var presetTools = el('div', { class: 'c-ptz__preset-actions' });
    var presetSelect = el('select', {
      class: 'c-select',
      attrs: { 'aria-label': 'Chọn preset để thao tác' }
    });
    for (var p = 1; p <= 8; p += 1) {
      presetSelect.appendChild(el('option', { attrs: { value: String(p) }, text: 'Preset ' + p }));
    }
    presetSelect.value = String(presetTarget);
    presetSelect.addEventListener('change', function () { presetTarget = Number(presetSelect.value) || 1; refreshPresetLabels(); });
    var presetRow = el('div', { class: 'c-ptz__preset-actions' });
    presetRow.appendChild(presetSelect);
    var actionRow = el('div', { class: 'c-ptz__preset-actions' });
    actionRow.appendChild(ui.button({ label: 'Gọi', variant: 'secondary', size: 'sm', onClick: function () { sendPtz('GotoPreset', presetTarget); } }));
    actionRow.appendChild(ui.button({ label: 'Đặt', variant: 'secondary', size: 'sm', onClick: function () { sendPtz('SetPreset', presetTarget); } }));
    actionRow.appendChild(ui.button({ label: 'Xoá', variant: 'secondary', size: 'sm', onClick: function () { sendPtz('ClearPreset', presetTarget); } }));
    actionRow.appendChild(ui.button({ label: 'Đặt tên', variant: 'ghost', size: 'sm', onClick: openPresetRename }));
    body.appendChild(presetRow);
    body.appendChild(actionRow);
    body.appendChild(el('p', {
      class: 'c-ptz__hint',
      text: 'Phím tắt khi bảng PTZ được focus: mũi tên di chuyển, Space dừng. Preset chỉ lưu tên trên trình duyệt này.'
    }));

    panel.addEventListener('keydown', function (ev) {
      var target = ev.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) { return; }
      if ((ev.key === ' ' || ev.key === 'Spacebar') && target && target.tagName === 'BUTTON') {
        return; /* để nút nhận Space theo hành vi native */
      }
      var map = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
      if (map[ev.key]) {
        ev.preventDefault();
        sendPtz(map[ev.key]);
      } else if (ev.key === ' ' || ev.key === 'Spacebar') {
        ev.preventDefault();
        sendPtz('Stop');
      }
    });

    refs.ptzPanel = panel;
    refs.presetSelect = presetSelect;
    refreshPresetLabels();
    return panel;
  }

  function clampNumber(value, min, max) {
    if (value < min) { return min; }
    if (value > max) { return max; }
    return value;
  }

  /* ----------------------------- Credentials --------------------------- */

  function openCredentialModal(ip) {
    if (!ctxRef || !ctxRef.isAdmin || credentialPromptIp === ip) { return; }
    credentialPromptIp = ip;
    var cam = findCamera(ip);
    var userField = ui.field({
      label: 'Tên đăng nhập camera',
      type: 'text',
      value: 'admin',
      autocomplete: 'off',
      maxlength: 64
    });
    var passField = ui.field({
      label: 'Mật khẩu camera',
      type: 'password',
      autocomplete: 'off',
      maxlength: 128,
      help: 'Mật khẩu chỉ dùng cho phiên hiện tại, không lưu xuống trình duyệt.'
    });
    var body = el('div', { class: 'c-stack c-stack--sm' });
    body.appendChild(el('p', {
      class: 'c-muted-block',
      text: 'Camera ' + (cam ? cam.name + ' (' + ip + ')' : ip) + ' chưa có thông tin đăng nhập. Nhập mật khẩu để xem luồng.'
    }));
    body.appendChild(userField.el);
    body.appendChild(passField.el);

    var handle = null;
    function cleanup() {
      passField.setValue('');
      credentialPromptIp = null;
    }
    var cancelBtn = ui.button({ label: 'Huỷ', variant: 'secondary', onClick: function () { handle.close(); } });
    var saveBtn = ui.button({
      label: 'Lưu tạm',
      icon: 'key',
      variant: 'primary',
      onClick: function () {
        var password = passField.getValue();
        if (!password) {
          passField.setError('Vui lòng nhập mật khẩu camera.');
          passField.focus();
          return;
        }
        passField.clearError();
        handle.setBusy(true);
        ctxRef.api.post('/api/cameras/credentials', {
          ip: ip,
          username: userField.getValue() || 'admin',
          password: password
        }, { signal: ctxRef.signal, silent: true }).then(function (data) {
          passField.setValue('');
          handle.setBusy(false);
          handle.close();
          ui.toast('Đã lưu mật khẩu tạm cho camera. Phiên có hiệu lực đến ' + fmt.time(data && data.expires_at ? data.expires_at : new Date()) + '.', { type: 'success' });
          restartTilesForIp(ip);
        }).catch(function (err) {
          handle.setBusy(false);
          if (err && (err.code === 'VALIDATION_ERROR' || err.code === 'INVALID_IP')) {
            passField.setError(err.message || 'Dữ liệu không hợp lệ.');
          } else {
            handle.setError(err && err.message ? err.message : 'Không lưu được mật khẩu camera.');
          }
        });
      }
    });
    handle = ui.modal({
      title: 'Nhập mật khẩu camera',
      subtitle: cam ? cam.name : ip,
      body: body,
      footer: [cancelBtn, saveBtn],
      size: 'sm',
      dismissible: true,
      initialFocus: passField.input,
      onClose: cleanup
    });
    modals.push(handle);
  }

  /* ----------------------------- Hardware ------------------------------ */

  function refreshHardware(ip) {
    if (!ip || !ctxRef || destroyed) { return; }
    var now = Date.now();
    if (hardwareLoading[ip]) { return; }
    if (hardwareFetchedAt[ip] && now - hardwareFetchedAt[ip] < 30000) { return; }
    hardwareLoading[ip] = true;
    ctxRef.api.get('/api/hardware/status', { query: { ip: ip }, signal: ctxRef.signal, silent: true })
      .then(function (data) {
        hardware[ip] = {
          privacy: !!data.privacy,
          tracking: !!data.tracking,
          siren: !!data.siren
        };
        hardwareFetchedAt[ip] = Date.now();
        updateAllBadges();
      })
      .catch(function () { /* trạng thái phần cứng là tùy chọn */ })
      .then(function () { hardwareLoading[ip] = false; });
  }

  /* --------------------------- Other actions --------------------------- */

  function openExternalPlayer() {
    var slot = activeSlot();
    if (!slot) {
      ui.toast('Chọn camera trước khi mở trình phát ngoài.', { type: 'warning' });
      return;
    }
    var cam = activeCamera();
    ctxRef.api.post('/api/stream/open', {
      ip: slot.ip,
      channel: slot.channel,
      name: cam ? cam.name : slot.ip
    }, { signal: ctxRef.signal, silent: true }).then(function (data) {
      ui.toast('Đã mở bằng ' + (data && data.player ? data.player : 'trình phát') + ' trên máy chủ.', { type: 'success' });
    }).catch(function (err) {
      if (err && err.code !== 'ABORTED') {
        ui.toast(fmt.errorCode(err.code) || err.message || 'Không mở được trình phát ngoài.', { type: 'error' });
      }
    });
  }

  function toggleTheater() {
    view.theater = !view.theater;
    if (viewRoot) { viewRoot.classList.toggle('is-theater', view.theater); }
    if (refs.theaterBtn) { refs.theaterBtn.setAttribute('aria-pressed', view.theater ? 'true' : 'false'); }
  }

  function toggleFullscreen() {
    var stage = refs.stage;
    if (!stage) { return; }
    var doc = DOC_FULLSCREEN_API();
    if (doc.fullscreenElement) {
      if (doc.exitFullscreen) { doc.exitFullscreen().catch(function () {}); }
      return;
    }
    var request = stage.requestFullscreen || stage.webkitRequestFullscreen || stage.msRequestFullscreen;
    if (!request) {
      ui.toast('Trình duyệt không hỗ trợ toàn màn hình.', { type: 'warning' });
      return;
    }
    try {
      var result = request.call(stage);
      if (result && result.catch) { result.catch(function () { ui.toast('Không bật được toàn màn hình.', { type: 'warning' }); }); }
    } catch (err) {
      ui.toast('Không bật được toàn màn hình.', { type: 'warning' });
    }
  }

  function DOC_FULLSCREEN_API() {
    return document;
  }

  function onFullscreenChange() {
    var active = !!document.fullscreenElement;
    if (refs.fullscreenBtn) {
      setUseIcon(refs.fullscreenBtn, active ? 'minimize' : 'maximize');
      setButtonLabel(refs.fullscreenBtn, active ? 'Thoát toàn màn hình' : 'Toàn màn hình');
      refs.fullscreenBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  /* ------------------------------ Toolbar sync ------------------------- */

  function syncToolbar() {
    if (!ctxRef || !refs.cameraSelect) { return; }
    var slot = activeSlot();
    var cam = slot ? findCamera(slot.ip) : null;
    var target = slot ? slot.ip : '';
    fillCameraSelect(refs.cameraSelect, false, target);
    refs.cameraSelect.disabled = !allCameras().length;

    var dual = isDualLens(cam);
    if (refs.lensWrap) { refs.lensWrap.hidden = !dual; }
    if (refs.lensSelect && dual) { refs.lensSelect.value = String(slot.channel); }
    if (refs.qualitySelect) { refs.qualitySelect.value = view.subtype; }

    Object.keys(refs.gridButtons || {}).forEach(function (mode) {
      var btn = refs.gridButtons[mode];
      var active = mode === view.mode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    if (refs.snapshotBtn) { refs.snapshotBtn.disabled = !slot; }
    if (refs.externalBtn) { refs.externalBtn.disabled = !slot; }
    if (refs.recordBtn) { syncRecordButton(); }
    if (refs.audioBtn) {
      var on = !!audioKey && !!slot && audioKey === slotKey(slot);
      refs.audioBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      setUseIcon(refs.audioBtn, on ? 'volume' : 'volume-x');
      setButtonLabel(refs.audioBtn, on ? 'Tắt âm thanh' : 'Âm thanh');
      refs.audioBtn.disabled = !slot;
    }
    if (refs.ptzToggle) {
      refs.ptzToggle.setAttribute('aria-pressed', view.ptzOpen ? 'true' : 'false');
      refs.ptzToggle.disabled = !slot;
    }
    if (refs.layout) { refs.layout.classList.toggle('is-ptz-collapsed', !view.ptzOpen); }
    if (refs.theaterBtn) { refs.theaterBtn.setAttribute('aria-pressed', view.theater ? 'true' : 'false'); }
    refreshPresetLabels();
    updateSubtitle();
  }

  function updateSubtitle() {
    if (!refs.subtitle) { return; }
    var count = allCameras().length;
    refs.subtitle.textContent = count + ' camera khả dụng · Cập nhật ' + fmt.time(new Date());
  }

  /* ------------------------------ Loading ------------------------------ */

  function buildHeader() {
    refs.subtitle = el('span');
    refs.refreshBtn = ui.button({
      label: 'Làm mới danh sách',
      icon: 'refresh',
      variant: 'secondary',
      size: 'sm',
      onClick: function () { refreshCameras(true); }
    });
    var header = ui.pageHeader({
      title: 'Xem trực tiếp',
      subtitle: 'Luồng MJPEG, âm thanh, PTZ, ghi hình và lưới 1 / 2×2 / 3×3',
      icon: 'live',
      actions: [refs.refreshBtn]
    });
    header.querySelector('.c-page-header__subtitle').appendChild(refs.subtitle);
    return header;
  }

  function buildLoading() {
    var card = el('div', { class: 'c-card' });
    var body = el('div', { class: 'c-card__body' });
    body.appendChild(CCTV.ui.skeleton({ variant: 'text', rows: 5 }));
    card.appendChild(body);
    return card;
  }

  function emptyCard() {
    var card = el('div', { class: 'c-card' });
    var body = el('div', { class: 'c-card__body' });
    var actions = [];
    if (ctxRef.isAdmin) {
      actions.push(ui.button({
        label: 'Mở danh sách camera',
        icon: 'cameras',
        variant: 'primary',
        onClick: function () { ctxRef.router.go('cameras'); }
      }));
      actions.push(ui.button({
        label: 'Quét mạng',
        icon: 'scanner',
        variant: 'secondary',
        onClick: function () { ctxRef.router.go('scanner'); }
      }));
    }
    body.appendChild(ui.empty({
      icon: 'live',
      title: 'Chưa có camera nào trong NVR',
      description: ctxRef.isAdmin
        ? 'Thêm camera đã lưu hoặc quét mạng để bắt đầu xem trực tiếp.'
        : 'Chưa có camera nào được cấu hình. Liên hệ quản trị viên.',
      action: actions
    }));
    card.appendChild(body);
    return card;
  }

  function initView() {
    if (destroyed || !ctxRef) { return; }
    camerasCache = ctxRef.state.get('cameras') || [];
    clear(viewRoot);
    viewRoot.appendChild(buildHeader());
    if (!allCameras().length) {
      viewRoot.appendChild(emptyCard());
      updateSubtitle();
      startCameraPoll();
      return;
    }
    loadGridState();
    viewRoot.appendChild(buildToolbar());
    refs.layout = el('div', { class: 'c-live__layout' + (view.ptzOpen ? '' : ' is-ptz-collapsed') });
    refs.stage = el('div', { class: 'c-live__stage' });
    refs.grid = el('div', { class: 'c-live__grid', attrs: { 'data-grid': view.mode } });
    refs.stage.appendChild(refs.grid);
    refs.layout.appendChild(refs.stage);
    if (ctxRef.isAdmin) {
      var ptz = buildPtzPanel();
      ptz.hidden = !view.ptzOpen;
      refs.layout.appendChild(ptz);
    }
    viewRoot.appendChild(refs.layout);
    renderStage();
    startCameraPoll();
    hydrateRecordings();
    syncToolbar();
  }

  function hydrateRecordings() {
    if (!ctxRef || destroyed) { return; }
    ctxRef.api.get('/api/record/status', { signal: ctxRef.signal, silent: true }).then(function (data) {
      if (destroyed) { return; }
      var list = data && Array.isArray(data.recordings) ? data.recordings : [];
      var next = {};
      list.forEach(function (rec) {
        if (!rec || !rec.ip) { return; }
        var duration = Number(rec.duration) || 0;
        next[keyOf(rec.ip, rec.channel || 1)] = {
          filename: rec.filename || '',
          duration: duration,
          startedAt: rec.started_at || null,
          startedAtMs: Date.now() - (duration * 1000)
        };
      });
      recordings = next;
      updateAllBadges();
      syncRecordButton();
      if (Object.keys(recordings).length) { ensureRecordTimers(); }
    }).catch(function () { /* không có ghi hình đang chạy */ });
  }

  function refreshCameras(showBusy) {
    if (!ctxRef || destroyed) { return; }
    if (showBusy && refs.refreshBtn) { ui.busy(refs.refreshBtn, true); }
    return ctxRef.state.refresh('cameras').then(function (list) {
      if (destroyed) { return null; }
      camerasCache = Array.isArray(list) ? list : [];
      if (!refs.grid && allCameras().length) {
        initView();
        if (refs.refreshBtn) { ui.busy(refs.refreshBtn, false); }
        return list;
      }
      refillAllCameraSelects();
      syncToolbar();
      updateAllBadges();
      tiles.forEach(function (tile, index) {
        if (!tile || !tile.slot) { return; }
        var cam = findCamera(tile.slot.ip);
        if (cam) {
          tile.nameNode.textContent = cam.name;
          tile.ipNode.textContent = cam.ip;
        }
        updateTileBadges(index);
      });
      if (refs.refreshBtn) { ui.busy(refs.refreshBtn, false); }
      return list;
    }).catch(function (err) {
      if (refs.refreshBtn) { ui.busy(refs.refreshBtn, false); }
      if (err && err.code !== 'ABORTED') {
        ui.toast(err.message || 'Không tải được danh sách camera.', { type: 'error', silent: false });
      }
      return null;
    });
  }

  function startCameraPoll() {
    if (stopCameraPoll) { return; }
    stopCameraPoll = CCTV.poll(function () {
      if (destroyed) { return null; }
      return ctxRef.state.refresh('cameras').then(function (list) {
        camerasCache = Array.isArray(list) ? list : [];
        if (!refs.grid && allCameras().length) {
          initView();
          return null;
        }
        refillAllCameraSelects();
        syncToolbar();
        updateAllBadges();
        tiles.forEach(function (tile, index) {
          if (!tile || !tile.slot) { return; }
          var cam = findCamera(tile.slot.ip);
          if (cam) {
            tile.nameNode.textContent = cam.name;
            tile.ipNode.textContent = cam.ip;
          }
          updateTileBadges(index);
        });
        return null;
      }).catch(function () { return null; });
    }, { intervalMs: 60000, immediate: false, pauseWhenHidden: true });
  }

  function showLoadError(err) {
    if (destroyed) { return; }
    clear(viewRoot);
    viewRoot.appendChild(ui.pageHeader({
      title: 'Xem trực tiếp',
      subtitle: 'Luồng MJPEG, âm thanh, PTZ, ghi hình và lưới 1 / 2×2 / 3×3',
      icon: 'live'
    }));
    viewRoot.appendChild(ui.errorPanel({
      title: 'Không tải được danh sách camera',
      message: err && err.message ? err.message : 'Máy chủ không phản hồi.',
      code: err && err.code ? err.code : null,
      requestId: err && err.requestId ? err.requestId : null,
      retry: function () {
        if (destroyed) { return; }
        clear(viewRoot);
        viewRoot.appendChild(buildLoading());
        ctxRef.state.refresh('cameras').then(function () {
          if (!destroyed) { initView(); }
        }).catch(showLoadError);
      }
    }));
  }

  /* ------------------------------ Lifecycle ---------------------------- */

  function render(container, ctx) {
    ctxRef = ctx;
    destroyed = false;
    refs = {};
    tiles = [];
    recordings = {};
    downloads = {};
    hardware = {};
    hardwareFetchedAt = {};
    hardwareLoading = {};
    credentialPromptIp = null;
    audioCtl = null;
    audioKey = null;
    view.ptzOpen = true;
    view.theater = false;
    view.cameraFilter = '';

    clear(container);
    viewRoot = el('div', { class: 'c-live', attrs: { 'data-testid': 'live-view' } });
    container.appendChild(viewRoot);
    viewRoot.appendChild(buildHeader());
    viewRoot.appendChild(buildLoading());

    var cached = ctx.state.get('cameras');
    if (Array.isArray(cached) && cached.length) {
      initView();
      refreshCameras(false);
    } else {
      ctx.state.refresh('cameras').then(function (list) {
        if (destroyed) { return; }
        camerasCache = Array.isArray(list) ? list : [];
        initView();
      }).catch(function (err) {
        if (!destroyed) { showLoadError(err); }
      });
    }

    fullscreenHandler = onFullscreenChange;
    document.addEventListener('fullscreenchange', fullscreenHandler);
    theaterKeyHandler = function (ev) {
      if (ev.key !== 'Escape' || !view.theater) { return; }
      if (document.querySelector('.c-modal-layer, .c-drawer-layer')) { return; }
      toggleTheater();
    };
    document.addEventListener('keydown', theaterKeyHandler);
  }

  function destroy() {
    destroyed = true;
    stopAllMedia();
    if (stopCameraPoll) { stopCameraPoll(); stopCameraPoll = null; }
    if (stopRecordPoll) { stopRecordPoll(); stopRecordPoll = null; }
    if (recordClock) { clearInterval(recordClock); recordClock = null; }
    if (fullscreenHandler) {
      document.removeEventListener('fullscreenchange', fullscreenHandler);
      fullscreenHandler = null;
    }
    if (theaterKeyHandler) {
      document.removeEventListener('keydown', theaterKeyHandler);
      theaterKeyHandler = null;
    }
    if (refs.cameraFilter && typeof refs.cameraFilter.destroy === 'function') {
      refs.cameraFilter.destroy();
    }
    if (document.fullscreenElement && document.exitFullscreen) {
      try {
        var exiting = document.exitFullscreen();
        if (exiting && exiting.catch) { exiting.catch(function () {}); }
      } catch (err) { /* bỏ qua */ }
    }
    modals.forEach(function (handle) {
      try { handle.close(); } catch (err) { /* bỏ qua */ }
    });
    modals = [];
    if (viewRoot) { viewRoot.classList.remove('is-theater'); }
    tiles = [];
    refs = {};
    viewRoot = null;
    ctxRef = null;
    credentialPromptIp = null;
    audioCtl = null;
    audioKey = null;
    view.theater = false;
  }

  function onResume() {
    if (!ctxRef || destroyed) { return; }
    refreshCameras(false);
  }

  CCTV.views.register('live', {
    title: 'Xem trực tiếp',
    icon: 'live',
    roles: ['admin', 'viewer'],
    order: 20,
    render: render,
    destroy: destroy,
    onResume: onResume
  });
})();
