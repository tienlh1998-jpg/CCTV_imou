/* =========================================================================
   CCTV Vision Hub v2.0 — core.js
   Namespace duy nhất: window.CCTV. Không biến toàn cục khác.
   Không chèn HTML thô, không eval, không inline handler, không CDN.
   ========================================================================= */
(function () {
  'use strict';

  if (window.CCTV && window.CCTV.__loaded) {
    return;
  }

  var CCTV = window.CCTV || {};
  window.CCTV = CCTV;
  CCTV.__loaded = true;
  CCTV.version = '2.0.0';
  CCTV.apiVersion = 2;

  var DOC = document;
  var TIME_ZONE = 'Asia/Ho_Chi_Minh';
  var appMeta = {
    firstRun: false,
    viewerLoginEnabled: true,
    appVersion: '2.0.0',
    apiVersion: 2,
    loaded: false
  };

  /* ============================== Helpers ============================== */

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function clamp(value, min, max) {
    if (value < min) { return min; }
    if (value > max) { return max; }
    return value;
  }

  function toKebab(value) {
    return String(value).replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase(); });
  }

  function byId(id) {
    return DOC.getElementById(id);
  }

  function firstNode(parent, selector) {
    if (!parent) { return null; }
    return parent.querySelector(selector);
  }

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (err) {
      return false;
    }
  }

  function storageRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (err) {
      /* storage bị chặn — bỏ qua */
    }
  }

  function storageKeys() {
    var keys = [];
    try {
      for (var i = 0; i < window.localStorage.length; i += 1) {
        var key = window.localStorage.key(i);
        if (key) { keys.push(key); }
      }
    } catch (err) {
      return [];
    }
    return keys;
  }

  function normalizeClass(value) {
    if (!value) { return ''; }
    if (Array.isArray(value)) {
      return value.filter(Boolean).join(' ');
    }
    return String(value);
  }

  /* ================================ DOM ================================ */

  var BLOCKED_ATTRS = { style: true, srcdoc: true, formaction: true, 'http-equiv': true };

  function isUnsafeAttrName(name) {
    var lower = String(name).toLowerCase();
    return lower.indexOf('on') === 0 || BLOCKED_ATTRS[lower] === true;
  }

  function isSafeHref(value) {
    var s = String(value).trim();
    if (!s) { return false; }
    if (s.charAt(0) === '#') { return true; }
    if (s.indexOf('/') === 0 && s.indexOf('//') !== 0 && s.indexOf('/\\') !== 0) { return true; }
    if (/^blob:/i.test(s)) { return true; }
    if (/^https?:\/\//i.test(s)) {
      try {
        return new URL(s).origin === window.location.origin;
      } catch (err) {
        return false;
      }
    }
    return false;
  }

  function isSafeSrc(value) {
    var s = String(value).trim();
    if (!s) { return false; }
    if (s.indexOf('/') === 0 && s.indexOf('//') !== 0 && s.indexOf('/\\') !== 0) { return true; }
    if (/^blob:/i.test(s)) { return true; }
    if (/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);/i.test(s)) { return true; }
    return false;
  }

  function applyAttrs(node, attrs) {
    Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      if (value === undefined || value === null || value === false) {
        return;
      }
      if (isUnsafeAttrName(key)) {
        throw new Error('Thuộc tính không an toàn: ' + key);
      }
      var name = String(key);
      if (name === 'href') {
        if (!isSafeHref(value)) { throw new Error('href không an toàn'); }
      } else if (name === 'src') {
        if (!isSafeSrc(value)) { throw new Error('src không an toàn'); }
      } else if (name === 'target' && value === '_blank') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
        return;
      } else if (name === 'value') {
        node.value = String(value);
        return;
      } else if (name === 'checked' || name === 'disabled' || name === 'selected' || name === 'required' || name === 'readonly') {
        if (value === true) { node.setAttribute(name, ''); }
        return;
      }
      node.setAttribute(name, String(value));
    });
  }

  function el(tag, opts) {
    opts = opts || {};
    if (hasOwn(opts, 'html')) {
      throw new Error('CCTV.dom.el không nhận html; dùng textContent');
    }
    var node = DOC.createElement(String(tag));
    var classes = normalizeClass(opts.class);
    if (classes) { node.className = classes; }
    if (opts.text !== undefined && opts.text !== null) {
      node.textContent = String(opts.text);
    }
    if (opts.attrs) { applyAttrs(node, opts.attrs); }
    if (opts.dataset) {
      Object.keys(opts.dataset).forEach(function (key) {
        var v = opts.dataset[key];
        if (v !== undefined && v !== null) {
          node.setAttribute('data-' + toKebab(key), String(v));
        }
      });
    }
    if (opts.on) {
      Object.keys(opts.on).forEach(function (eventName) {
        if (!/^[a-z]+$/.test(eventName)) {
          throw new Error('Tên sự kiện không hợp lệ: ' + eventName);
        }
        var handler = opts.on[eventName];
        if (typeof handler === 'function') {
          node.addEventListener(eventName, handler);
        }
      });
    }
    if (opts.children) { appendChildren(node, opts.children); }
    return node;
  }

  function appendChildren(node, children) {
    var list = Array.isArray(children) ? children : [children];
    list.forEach(function (child) {
      if (child === null || child === undefined || child === false) { return; }
      if (child instanceof Node) {
        node.appendChild(child);
      } else {
        node.appendChild(DOC.createTextNode(String(child)));
      }
    });
  }

  function clear(node) {
    if (!node) { return; }
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function fragment(children) {
    var frag = DOC.createDocumentFragment();
    appendChildren(frag, children);
    return frag;
  }

  function setText(node, value) {
    if (node) {
      node.textContent = value === undefined || value === null ? '' : String(value);
    }
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var XLINK_NS = 'http://www.w3.org/1999/xlink';

  function svgIcon(name, opts) {
    opts = opts || {};
    var safeName = String(name || 'circle').replace(/[^a-z0-9-]/gi, '');
    var size = Number(opts.size) > 0 ? Number(opts.size) : 18;
    var svg = DOC.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'c-icon' + (opts.class ? ' ' + opts.class : ''));
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('focusable', 'false');
    if (opts.label) {
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', String(opts.label));
    } else {
      svg.setAttribute('aria-hidden', 'true');
    }
    var use = DOC.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-' + safeName);
    use.setAttributeNS(XLINK_NS, 'xlink:href', '#i-' + safeName);
    svg.appendChild(use);
    return svg;
  }

  function iconExists(name) {
    return !!byId('i-' + String(name || '').replace(/[^a-z0-9-]/gi, ''));
  }

  function safePath(value) {
    if (typeof value !== 'string') { return null; }
    var s = value.trim();
    if (!s || s.charAt(0) !== '/' || s.indexOf('//') === 0 || s.indexOf('\\') !== -1) {
      return null;
    }
    if (/[\u0000-\u001f]/.test(s)) { return null; }
    try {
      var url = new URL(s, window.location.origin);
      if (url.origin !== window.location.origin) { return null; }
      return url.pathname + url.search + url.hash;
    } catch (err) {
      return null;
    }
  }

  /* ============================= Formatting ============================ */

  var dtfCache = null;

  function getDateFormatter() {
    if (dtfCache) { return dtfCache; }
    try {
      dtfCache = new Intl.DateTimeFormat('vi-VN', {
        timeZone: TIME_ZONE,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch (err) {
      dtfCache = null;
    }
    return dtfCache;
  }

  function parseDateValue(value) {
    if (value === null || value === undefined || value === '') { return null; }
    if (value instanceof Date) {
      return isNaN(value.getTime()) ? null : value;
    }
    if (typeof value === 'number' && isFinite(value)) {
      var ms = value < 1e12 ? value * 1000 : value;
      var fromNumber = new Date(ms);
      return isNaN(fromNumber.getTime()) ? null : fromNumber;
    }
    if (typeof value !== 'string') { return null; }
    var s = value.trim();
    if (!s) { return null; }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      s += 'T00:00:00+07:00';
    } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
      s = s.replace(' ', 'T');
      if (/T\d{2}:\d{2}$/.test(s)) { s += ':00'; }
      s += '+07:00';
    }
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function dateParts(date) {
    var fmt = getDateFormatter();
    var result = { year: '', month: '', day: '', hour: '', minute: '', second: '' };
    if (fmt) {
      try {
        fmt.formatToParts(date).forEach(function (part) {
          if (hasOwn(result, part.type)) { result[part.type] = part.value; }
        });
        return result;
      } catch (err) {
        /* fallback bên dưới */
      }
    }
    result.year = String(date.getFullYear());
    result.month = String(date.getMonth() + 1).padStart(2, '0');
    result.day = String(date.getDate()).padStart(2, '0');
    result.hour = String(date.getHours()).padStart(2, '0');
    result.minute = String(date.getMinutes()).padStart(2, '0');
    result.second = String(date.getSeconds()).padStart(2, '0');
    return result;
  }

  var numberFmt;
  try {
    numberFmt = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });
  } catch (err) {
    numberFmt = null;
  }

  function formatNumber(value) {
    var n = Number(value);
    if (!isFinite(n)) { return '—'; }
    return numberFmt ? numberFmt.format(n) : String(n);
  }

  var STATUS_MAP = {
    online: { label: 'Trực tuyến', tone: 'success', icon: 'wifi', css: 'online' },
    offline: { label: 'Ngoại tuyến', tone: 'danger', icon: 'wifi-off', css: 'offline' },
    auth_failed: { label: 'Sai mật khẩu', tone: 'warning', icon: 'lock', css: 'auth_failed' },
    solar_sleep: { label: 'Ngủ năng lượng mặt trời', tone: 'info', icon: 'sun', css: 'solar_sleep' },
    unknown: { label: 'Chưa rõ', tone: 'neutral', icon: 'circle', css: 'unknown' },
    sent: { label: 'Đã gửi', tone: 'success', icon: 'check-circle', css: 'sent' },
    failed: { label: 'Gửi lỗi', tone: 'danger', icon: 'x-circle', css: 'failed' },
    skipped: { label: 'Bỏ qua', tone: 'warning', icon: 'alert-circle', css: 'skipped' },
    suppressed: { label: 'Đã chặn', tone: 'neutral', icon: 'bell-off', css: 'suppressed' },
    recording: { label: 'Đang ghi', tone: 'danger', icon: 'record', css: 'recording' },
    armed: { label: 'Đang gác', tone: 'success', icon: 'shield', css: 'armed' },
    disarmed: { label: 'Tắt gác', tone: 'neutral', icon: 'shield-off', css: 'disarmed' },
    ok: { label: 'Bình thường', tone: 'success', icon: 'check-circle', css: 'success' },
    no_sd: { label: 'Không có thẻ', tone: 'warning', icon: 'sd-card', css: 'warning' },
    storage_error: { label: 'Lỗi thẻ nhớ', tone: 'danger', icon: 'alert-triangle', css: 'failed' }
  };

  var ERROR_LABELS = {
    VALIDATION_ERROR: 'Dữ liệu không hợp lệ.',
    INVALID_IP: 'Địa chỉ IP không hợp lệ.',
    INVALID_SUBNET: 'Dải mạng không hợp lệ hoặc quá lớn.',
    CAMERA_PASSWORD_REQUIRED: 'Camera chưa có mật khẩu.',
    CONFIRMATION_REQUIRED: 'Thiếu xác nhận bắt buộc.',
    RTSP_URL_FORBIDDEN: 'Không được gửi RTSP URL từ trình duyệt.',
    PASSWORD_IN_QUERY_FORBIDDEN: 'Không được gửi mật khẩu trong URL.',
    HOST_NOT_ALLOWED: 'Tên miền truy cập không được phép.',
    UNAUTHENTICATED: 'Phiên đăng nhập đã hết hạn.',
    INVALID_CREDENTIALS: 'Mật khẩu không đúng.',
    FORBIDDEN: 'Bạn không có quyền thực hiện thao tác này.',
    CSRF_INVALID: 'Phiên làm việc không hợp lệ. Vui lòng tải lại trang.',
    ORIGIN_MISMATCH: 'Nguồn yêu cầu không hợp lệ.',
    VIEWER_LOGIN_DISABLED: 'Tài khoản người xem chưa được bật.',
    TEST_MODE_BLOCKED: 'Chế độ kiểm thử chặn thao tác này.',
    NOT_FOUND: 'Không tìm thấy tài nguyên.',
    CAMERA_NOT_FOUND: 'Không tìm thấy camera.',
    NOT_RECORDING: 'Camera hiện không ghi hình.',
    APK_NOT_AVAILABLE: 'APK v2 đang được cập nhật.',
    METHOD_NOT_ALLOWED: 'Phương thức không được hỗ trợ.',
    CONFLICT: 'Dữ liệu đang xung đột.',
    SCAN_IN_PROGRESS: 'Đang có lượt quét mạng khác.',
    ALREADY_RECORDING: 'Camera đang ghi hình.',
    CAMERA_CREDENTIAL_REQUIRED: 'Camera chưa được cấu hình mật khẩu.',
    TELEGRAM_NOT_CONFIGURED: 'Telegram chưa được cấu hình.',
    SECRETS_MANAGED_EXTERNALLY: 'Bí mật đang được quản lý bởi file cấu hình bên ngoài.',
    PAYLOAD_TOO_LARGE: 'Dữ liệu gửi lên quá lớn.',
    UNSUPPORTED_MEDIA_TYPE: 'Định dạng nội dung không được hỗ trợ.',
    RATE_LIMITED: 'Thao tác quá nhanh, vui lòng chờ.',
    TOO_MANY_STREAMS: 'Đã đạt giới hạn luồng xem đồng thời.',
    INTERNAL_ERROR: 'Máy chủ gặp lỗi nội bộ.',
    CAMERA_OPERATION_FAILED: 'Camera không phản hồi đúng.',
    TELEGRAM_SEND_FAILED: 'Không gửi được tin nhắn Telegram.',
    FFMPEG_UNAVAILABLE: 'FFmpeg chưa được cài hoặc không có trong PATH.',
    PLAYER_NOT_AVAILABLE: 'Máy chủ không tìm thấy mpv/VLC.',
    TELEGRAM_DISABLED: 'Telegram đang ở trạng thái không hoạt động.',
    SERVICE_UNAVAILABLE: 'Dịch vụ tạm thời không sẵn sàng.',
    SETUP_REQUIRED: 'Hệ thống chưa được thiết lập mật khẩu quản trị.',
    TIMEOUT: 'Máy chủ phản hồi quá lâu.',
    NETWORK_ERROR: 'Không kết nối được máy chủ CCTV.',
    INVALID_RESPONSE: 'Phản hồi máy chủ không hợp lệ.',
    ABORTED: 'Đã huỷ yêu cầu.'
  };

  var fmt = {
    dateTime: function (value) {
      var d = parseDateValue(value);
      if (!d) { return value === null || value === undefined ? '—' : String(value); }
      var p = dateParts(d);
      return p.hour + ':' + p.minute + ':' + p.second + ' ' + p.day + '/' + p.month + '/' + p.year;
    },
    date: function (value) {
      var d = parseDateValue(value);
      if (!d) { return value === null || value === undefined ? '—' : String(value); }
      var p = dateParts(d);
      return p.day + '/' + p.month + '/' + p.year;
    },
    time: function (value) {
      var d = parseDateValue(value);
      if (!d) { return '—'; }
      var p = dateParts(d);
      return p.hour + ':' + p.minute + ':' + p.second;
    },
    relative: function (value) {
      var d = parseDateValue(value);
      if (!d) { return '—'; }
      var diff = Math.floor((Date.now() - d.getTime()) / 1000);
      if (diff < 0) { return fmt.dateTime(d); }
      if (diff < 45) { return 'vừa xong'; }
      if (diff < 3600) { return Math.floor(diff / 60) + ' phút trước'; }
      if (diff < 86400) { return Math.floor(diff / 3600) + ' giờ trước'; }
      if (diff < 2592000) { return Math.floor(diff / 86400) + ' ngày trước'; }
      return fmt.date(d);
    },
    bytes: function (value) {
      var n = Number(value);
      if (!isFinite(n) || n < 0) { return '—'; }
      if (n < 1024) { return formatNumber(n) + ' B'; }
      var units = ['KB', 'MB', 'GB', 'TB', 'PB'];
      var idx = -1;
      do {
        n = n / 1024;
        idx += 1;
      } while (n >= 1024 && idx < units.length - 1);
      return formatNumber(n) + ' ' + units[idx];
    },
    duration: function (seconds) {
      var total = Math.max(0, Math.floor(Number(seconds) || 0));
      var h = Math.floor(total / 3600);
      var m = Math.floor((total % 3600) / 60);
      var s = total % 60;
      if (h > 0) { return h + ' giờ ' + String(m).padStart(2, '0') + ' phút'; }
      if (m > 0) { return m + ' phút ' + String(s).padStart(2, '0') + ' giây'; }
      return s + ' giây';
    },
    number: formatNumber,
    percent: function (value) {
      var n = Number(value);
      if (!isFinite(n)) { return '—'; }
      return formatNumber(n) + '%';
    },
    status: function (value) {
      var key = String(value || 'unknown');
      var item = STATUS_MAP[key] || STATUS_MAP.unknown;
      return { key: key, label: item.label, tone: item.tone, icon: item.icon, css: item.css };
    },
    errorCode: function (code) {
      var key = String(code || '');
      if (!key) { return ''; }
      var label = ERROR_LABELS[key];
      return label ? key + ' — ' + label : key;
    }
  };

  /* ============================== Polling ============================== */

  function poll(fn, options) {
    options = options || {};
    var intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 15000;
    var maxBackoffMs = Number(options.maxBackoffMs) > 0 ? Number(options.maxBackoffMs) : 60000;
    var pauseWhenHidden = options.pauseWhenHidden !== false;
    var immediate = options.immediate !== false;
    var stopped = false;
    var timer = null;
    var currentDelay = intervalMs;
    var running = false;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var signal = controller ? controller.signal : undefined;

    function clearTimer() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function schedule(delay) {
      clearTimer();
      if (stopped) { return; }
      if (pauseWhenHidden && DOC.hidden) { return; }
      timer = setTimeout(tick, delay);
    }

    function tick() {
      if (stopped || running) { return; }
      if (pauseWhenHidden && DOC.hidden) { return; }
      running = true;
      Promise.resolve()
        .then(function () { return fn(signal); })
        .then(function () {
          currentDelay = intervalMs;
        }, function () {
          currentDelay = Math.min(currentDelay * 2, maxBackoffMs);
        })
        .then(function () {
          running = false;
          schedule(currentDelay);
        });
    }

    function onVisible() {
      if (stopped) { return; }
      if (!DOC.hidden) {
        currentDelay = intervalMs;
        if (!running) {
          tick();
        }
      } else {
        clearTimer();
      }
    }

    if (pauseWhenHidden) {
      DOC.addEventListener('visibilitychange', onVisible);
    }
    if (immediate) {
      tick();
    } else {
      schedule(intervalMs);
    }

    return function stopPolling() {
      if (stopped) { return; }
      stopped = true;
      clearTimer();
      if (pauseWhenHidden) {
        DOC.removeEventListener('visibilitychange', onVisible);
      }
      if (controller) {
        try { controller.abort(); } catch (err) { /* bỏ qua */ }
      }
    };
  }

  /* =============================== ApiError ============================ */

  function ApiError(status, code, message, details, requestId, retryAfterSeconds) {
    this.name = 'ApiError';
    this.status = Number(status) || 0;
    this.code = code || 'HTTP_ERROR';
    this.message = message || ERROR_LABELS[this.code] || 'Yêu cầu thất bại.';
    this.details = details === undefined ? null : details;
    this.requestId = requestId || null;
    this.retryAfterSeconds = Number(retryAfterSeconds) > 0 ? Number(retryAfterSeconds) : null;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  var HTTP_MESSAGES = {
    400: 'Dữ liệu không hợp lệ.',
    401: 'Bạn cần đăng nhập để tiếp tục.',
    403: 'Bạn không có quyền thực hiện thao tác này.',
    404: 'Không tìm thấy tài nguyên.',
    405: 'Phương thức không được hỗ trợ.',
    409: 'Dữ liệu đang xung đột.',
    413: 'Dữ liệu gửi lên quá lớn.',
    415: 'Định dạng nội dung không được hỗ trợ.',
    429: 'Thao tác quá nhanh, vui lòng chờ.',
    500: 'Máy chủ gặp lỗi nội bộ.',
    502: 'Thiết bị không phản hồi đúng.',
    503: 'Dịch vụ tạm thời không sẵn sàng.'
  };

  function errorFromResponse(status, data, requestId, headerRetry) {
    var code = 'HTTP_' + status;
    var message = HTTP_MESSAGES[status] || 'Yêu cầu thất bại.';
    var details = null;
    var rid = requestId || null;
    if (data && typeof data === 'object' && data.error) {
      var source = data.error;
      if (typeof source === 'object') {
        code = source.code || code;
        message = source.message || message;
        details = source.details === undefined ? null : source.details;
        if (source.request_id) { rid = source.request_id; }
      } else if (typeof source === 'string') {
        message = source;
      }
    } else if (data && typeof data === 'object' && typeof data.message === 'string') {
      message = data.message;
    }
    var retry = headerRetry;
    if (!retry && details && typeof details === 'object' && details.retry_after_seconds) {
      retry = details.retry_after_seconds;
    }
    return new ApiError(status, code, message, details, rid, retry);
  }

  function buildUrl(path, query) {
    if (typeof path !== 'string') {
      throw new Error('Đường dẫn API không hợp lệ');
    }
    var raw = path.trim();
    if (!raw || raw.charAt(0) !== '/' || raw.indexOf('//') === 0) {
      throw new Error('API chỉ chấp nhận đường dẫn tương đối bắt đầu bằng /');
    }
    var url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) {
      throw new Error('API không cho phép cross-origin');
    }
    if (query) {
      Object.keys(query).forEach(function (key) {
        var value = query[key];
        if (value === undefined || value === null) { return; }
        if (Array.isArray(value)) {
          value.forEach(function (v) { url.searchParams.append(key, String(v)); });
        } else {
          url.searchParams.set(key, String(value));
        }
      });
    }
    return url.pathname + url.search;
  }

  /* ================================ API ================================ */

  var api = (function () {
    function handleApiError(err, opts) {
      if (!err || err.name !== 'ApiError') { return; }
      if (err.code === 'ABORTED') { return; }
      if (err.status === 401) {
        if (!opts.skipAuthRedirect && err.code !== 'INVALID_CREDENTIALS') {
          auth.handleUnauthenticated('expired');
        }
        return;
      }
      if (opts.silent) { return; }
      if (err.status === 403) {
        ui.toast(err.message || ERROR_LABELS.FORBIDDEN, { type: 'warning' });
        return;
      }
      if (err.status === 429) {
        var wait = err.retryAfterSeconds ? ' Thử lại sau ' + err.retryAfterSeconds + ' giây.' : '';
        ui.toast((err.message || ERROR_LABELS.RATE_LIMITED) + wait, { type: 'warning', duration: 8000 });
        return;
      }
      if (err.status === 503) {
        ui.toast(fmt.errorCode(err.code) || err.message, { type: 'error', duration: 8000 });
        return;
      }
      if (err.status >= 500) {
        ui.toast(fmt.errorCode(err.code) || err.message, { type: 'error', duration: 8000 });
        return;
      }
      if (err.status === 0) {
        ui.toast(err.message || ERROR_LABELS.NETWORK_ERROR, { type: 'error', duration: 8000 });
      }
    }

    function doRequest(method, path, opts) {
      var url;
      try {
        url = buildUrl(path, opts.query);
      } catch (err) {
        return Promise.reject(new ApiError(0, 'INVALID_URL', err.message));
      }
      var stateful = method !== 'GET' && method !== 'HEAD';
      var timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 20000;
      var expect = opts.expect || 'json';

      function run(retryLeft) {
        var controller = new AbortController();
        var timedOut = false;
        var abortedExternally = false;
        var timer = setTimeout(function () {
          timedOut = true;
          try { controller.abort(); } catch (err) { /* bỏ qua */ }
        }, timeoutMs);
        var external = opts.signal;
        var onAbort = function () {
          abortedExternally = true;
          try { controller.abort(); } catch (err) { /* bỏ qua */ }
        };
        if (external) {
          if (external.aborted) {
            clearTimeout(timer);
            return Promise.reject(new ApiError(0, 'ABORTED', ERROR_LABELS.ABORTED));
          }
          external.addEventListener('abort', onAbort, { once: true });
        }

        var headers = { Accept: expect === 'blob' ? '*/*' : 'application/json' };
        if (opts.headers) {
          Object.keys(opts.headers).forEach(function (key) {
            headers[key] = opts.headers[key];
          });
        }
        if (opts.body !== undefined && stateful) {
          headers['Content-Type'] = 'application/json; charset=utf-8';
        }
        if (stateful) {
          var csrf = auth.csrf();
          if (csrf) { headers['X-CSRF-Token'] = csrf; }
        }

        var init = {
          method: method,
          credentials: 'same-origin',
          cache: 'no-store',
          headers: headers,
          referrerPolicy: 'no-referrer'
        };
        init.signal = controller.signal;
        if (opts.body !== undefined && stateful) {
          try {
            init.body = JSON.stringify(opts.body);
          } catch (err) {
            clearTimeout(timer);
            if (external) { external.removeEventListener('abort', onAbort); }
            return Promise.reject(new ApiError(0, 'VALIDATION_ERROR', 'Không thể mã hoá dữ liệu gửi lên.'));
          }
        }

        function cleanup() {
          clearTimeout(timer);
          if (external) { external.removeEventListener('abort', onAbort); }
        }

        return fetch(url, init).then(function (response) {
          cleanup();
          var requestId = response.headers.get('X-Request-Id');
          if (!response.ok) {
            return response.text().then(function (text) {
              var data = null;
              if (text) {
                try { data = JSON.parse(text); } catch (err) { data = null; }
              }
              var retryHeader = Number(response.headers.get('Retry-After'));
              throw errorFromResponse(response.status, data, requestId, retryHeader);
            });
          }
          if (expect === 'blob') {
            return response.blob().then(function (blob) {
              var result = { blob: blob, headers: response.headers, status: response.status };
              if (opts.meta) {
                var disposition = response.headers.get('Content-Disposition') || '';
                var match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
                result.filename = response.headers.get('X-Snapshot-Filename') || (match ? decodeURIComponent(match[1]) : null);
                return result;
              }
              return blob;
            });
          }
          if (expect === 'text') {
            return response.text();
          }
          if (response.status === 204) { return null; }
          return response.text().then(function (text) {
            var data = null;
            if (text) {
              try {
                data = JSON.parse(text);
              } catch (err) {
                throw new ApiError(response.status, 'INVALID_RESPONSE', ERROR_LABELS.INVALID_RESPONSE, null, requestId);
              }
            }
            if (data && typeof data === 'object' && data.ok === false) {
              throw errorFromResponse(response.status, data, requestId, null);
            }
            return data;
          });
        }, function (err) {
          cleanup();
          if (err && err.name === 'ApiError') { throw err; }
          if (err && err.name === 'AbortError') {
            if (timedOut) { throw new ApiError(0, 'TIMEOUT', ERROR_LABELS.TIMEOUT); }
            if (abortedExternally) { throw new ApiError(0, 'ABORTED', ERROR_LABELS.ABORTED); }
            throw new ApiError(0, 'ABORTED', ERROR_LABELS.ABORTED);
          }
          throw new ApiError(0, 'NETWORK_ERROR', ERROR_LABELS.NETWORK_ERROR);
        }).catch(function (err) {
          var apiErr = err && err.name === 'ApiError' ? err : new ApiError(0, 'NETWORK_ERROR', ERROR_LABELS.NETWORK_ERROR);
          if (method === 'GET' && retryLeft > 0 && apiErr.code === 'NETWORK_ERROR') {
            return run(retryLeft - 1);
          }
          handleApiError(apiErr, opts);
          throw apiErr;
        });
      }

      return run(1);
    }

    return {
      ApiError: ApiError,
      request: function (method, path, opts) {
        return doRequest(String(method || 'GET').toUpperCase(), path, opts || {});
      },
      get: function (path, opts) {
        return doRequest('GET', path, opts || {});
      },
      post: function (path, body, opts) {
        var merged = Object.assign({}, opts || {});
        merged.body = body === undefined ? {} : body;
        return doRequest('POST', path, merged);
      },
      put: function (path, body, opts) {
        var merged = Object.assign({}, opts || {});
        merged.body = body === undefined ? {} : body;
        return doRequest('PUT', path, merged);
      },
      del: function (path, body, opts) {
        var merged = Object.assign({}, opts || {});
        if (body !== undefined) { merged.body = body === null ? {} : body; }
        return doRequest('DELETE', path, merged);
      },
      getBlob: function (path, opts) {
        var merged = Object.assign({}, opts || {});
        merged.expect = 'blob';
        merged.meta = true;
        return doRequest('GET', path, merged);
      },
      download: function (path, filename, opts) {
        var merged = Object.assign({}, opts || {});
        merged.expect = 'blob';
        merged.silent = true;
        return doRequest('GET', path, merged).then(function (blob) {
          ui.downloadBlob(blob, filename || 'cctv-download');
        });
      }
    };
  })();

  /* ================================ Auth =============================== */

  var session = null;
  var csrfToken = null;
  var authListeners = new Set();
  var unauthHandled = false;
  var unauthHandler = null;

  function emitAuthChange() {
    var snapshot = auth.session();
    authListeners.forEach(function (fn) {
      try { fn(snapshot); } catch (err) { /* listener lỗi không làm hỏng auth */ }
    });
  }

  function applyMeData(data) {
    appMeta.loaded = true;
    appMeta.firstRun = !!data.first_run;
    if (typeof data.viewer_login_enabled === 'boolean') {
      appMeta.viewerLoginEnabled = data.viewer_login_enabled;
    }
    if (data.app_version) { appMeta.appVersion = String(data.app_version); }
    if (data.api_version) { appMeta.apiVersion = Number(data.api_version) || 2; }

    if (data.authenticated && (data.role === 'admin' || data.role === 'viewer')) {
      var user = isObject(data.user) ? data.user : {};
      session = {
        role: data.role,
        username: user.username || (data.role === 'admin' ? 'admin' : 'viewer'),
        displayName: user.display_name || (data.role === 'admin' ? 'Quản trị viên' : 'Người xem'),
        expiresAt: data.expires_at || null
      };
      csrfToken = data.csrf_token ? String(data.csrf_token) : null;
      unauthHandled = false;
    } else {
      session = null;
      csrfToken = null;
    }
    emitAuthChange();
    return session;
  }

  function clearAuthLocal() {
    session = null;
    csrfToken = null;
    emitAuthChange();
  }

  var auth = {
    ApiError: ApiError,
    init: function () {
      return api.get('/api/auth/me', { skipAuthRedirect: true, silent: true, timeoutMs: 10000 })
        .then(function (data) {
          if (data && data.authenticated && data.role) {
            applyMeData(data);
            return { authenticated: true, role: session ? session.role : null };
          }
          applyMeData(data || { authenticated: false });
          return { authenticated: false, role: null };
        })
        .catch(function (err) {
          clearAuthLocal();
          return { authenticated: false, role: null, error: err };
        });
    },
    me: function (options) {
      var opts = Object.assign({ skipAuthRedirect: true, silent: true }, options || {});
      return api.get('/api/auth/me', opts).then(function (data) {
        applyMeData(data || { authenticated: false });
        return session ? auth.session() : null;
      });
    },
    login: function (role, password) {
      var username = role === 'viewer' ? 'viewer' : 'admin';
      return api.post('/api/auth/login', { username: username, password: String(password || '') }, {
        skipAuthRedirect: true,
        silent: true,
        timeoutMs: 15000
      }).then(function (data) {
        var user = isObject(data && data.user) ? data.user : {};
        session = {
          role: data.role === 'viewer' ? 'viewer' : 'admin',
          username: user.username || username,
          displayName: user.display_name || (data.role === 'viewer' ? 'Người xem' : 'Quản trị viên'),
          expiresAt: data.expires_at || null
        };
        csrfToken = data.csrf_token ? String(data.csrf_token) : null;
        appMeta.firstRun = !!data.first_run;
        appMeta.loaded = true;
        if (data.app_version) { appMeta.appVersion = String(data.app_version); }
        unauthHandled = false;
        emitAuthChange();
        return auth.session();
      });
    },
    logout: function () {
      return api.post('/api/auth/logout', {}, { skipAuthRedirect: true, silent: true })
        .catch(function () { return null; })
        .then(function () {
          clearAuthLocal();
          auth.purgeLegacyStorage();
          try { state.reset(); } catch (err) { /* bỏ qua */ }
          return true;
        });
    },
    changePassword: function (params) {
      var body = {
        target: params.target === 'viewer' ? 'viewer' : 'admin',
        current_password: String(params.currentPassword || ''),
        new_password: String(params.newPassword || '')
      };
      if (params.clearViewer) {
        body.clear_viewer = true;
        delete body.new_password;
      }
      return api.post('/api/auth/change_password', body, { silent: true }).then(function (data) {
        clearAuthLocal();
        auth.purgeLegacyStorage();
        var finish = function () {
          if (unauthHandler) {
            unauthHandler({ reason: 'password-changed', message: 'Mật khẩu đã thay đổi. Vui lòng đăng nhập lại.' });
          }
          return data;
        };
        /* Server đã đổi first_run/viewer_login_enabled và thu hồi session.
           Refresh /api/auth/me trước khi hiện lại login để không dùng appMeta cũ. */
        return auth.me().then(finish, finish);
      });
    },
    role: function () { return session ? session.role : null; },
    isAdmin: function () { return !!session && session.role === 'admin'; },
    csrf: function () { return csrfToken; },
    session: function () {
      if (!session) { return null; }
      return {
        role: session.role,
        username: session.username,
        displayName: session.displayName,
        expiresAt: session.expiresAt
      };
    },
    info: function () {
      return {
        firstRun: appMeta.firstRun,
        viewerLoginEnabled: appMeta.viewerLoginEnabled,
        appVersion: appMeta.appVersion,
        apiVersion: appMeta.apiVersion,
        loaded: appMeta.loaded
      };
    },
    onChange: function (fn) {
      if (typeof fn !== 'function') { return function () {}; }
      authListeners.add(fn);
      return function () { authListeners.delete(fn); };
    },
    handleUnauthenticated: function (reason) {
      if (unauthHandled) { return; }
      unauthHandled = true;
      clearAuthLocal();
      auth.purgeLegacyStorage();
      try { state.reset(); } catch (err) { /* state chưa sẵn sàng khi boot */ }
      try { router.stop(); } catch (err) { /* router chưa sẵn sàng */ }
      if (unauthHandler) {
        unauthHandler(reason || {});
      }
    },
    setUnauthenticatedHandler: function (fn) {
      unauthHandler = typeof fn === 'function' ? fn : null;
    },
    startRevalidation: (function () {
      var stopFn = null;
      return function (intervalMs) {
        if (stopFn) { stopFn(); stopFn = null; }
        var stop = poll(function (signal) {
          if (!session) { return null; }
          return api.get('/api/auth/me', { skipAuthRedirect: true, silent: true, signal: signal })
            .then(function (data) {
              if (!data || !data.authenticated) {
                auth.handleUnauthenticated({ reason: 'expired' });
                return null;
              }
              applyMeData(data);
              return null;
            })
            .catch(function () { return null; });
        }, { intervalMs: intervalMs || 300000, immediate: false, pauseWhenHidden: true, maxBackoffMs: 300000 });
        stopFn = stop;
        return function () {
          if (stopFn) { stopFn(); stopFn = null; }
        };
      };
    })(),
    purgeLegacyStorage: function () {
      var allow = /^cctv\.ui\./;
      storageKeys().forEach(function (key) {
        if (allow.test(key)) { return; }
        if (/^cam_pwd_/i.test(key) ||
            /^(admin_token|cctv_token|session_token)$/i.test(key) ||
            /password|secret|token/i.test(key)) {
          storageRemove(key);
        }
      });
      try {
        var keys = [];
        for (var i = 0; i < window.sessionStorage.length; i += 1) {
          var sk = window.sessionStorage.key(i);
          if (sk && /password|secret|token|cam_pwd_/i.test(sk)) { keys.push(sk); }
        }
        keys.forEach(function (key) { window.sessionStorage.removeItem(key); });
      } catch (err) {
        /* sessionStorage bị chặn — bỏ qua */
      }
    }
  };

  /* ================================ State ============================== */

  var stateDefaults = {
    session: null,
    health: null,
    systemStatus: null,
    cameras: [],
    scan: null,
    alarms: { history: [] },
    settings: null,
    alarmStatus: null,
    uiRequest: null
  };

  var stateStore = Object.assign({}, stateDefaults);
  var stateListeners = new Map();
  var inflight = Object.create(null);

  function notifyState(key) {
    var set = stateListeners.get(key);
    if (!set) { return; }
    set.forEach(function (fn) {
      try { fn(stateStore[key]); } catch (err) { /* listener lỗi bỏ qua */ }
    });
  }

  var stateLoaders = {
    health: function () {
      return api.get('/api/health', { silent: true, timeoutMs: 10000 });
    },
    systemStatus: function () {
      return api.get('/api/system/status', { silent: true });
    },
    cameras: function () {
      return api.get('/api/managed/cameras', { silent: true }).then(function (data) {
        return data && Array.isArray(data.cameras) ? data.cameras : [];
      });
    },
    alarmStatus: function () {
      return api.get('/api/alarm/status', { silent: true });
    },
    settings: function () {
      if (!auth.isAdmin()) { return Promise.resolve(null); }
      return api.get('/api/settings', { silent: true });
    }
  };

  var UI_PAGE_SIZES = [10, 15, 20, 30, 50];

  function sanitizeGrid(value) {
    if (!isObject(value)) { return null; }
    var mode = value.mode === '2x2' || value.mode === '3x3' ? value.mode : '1';
    var max = mode === '3x3' ? 9 : (mode === '2x2' ? 4 : 1);
    var slots = [];
    if (Array.isArray(value.slots)) {
      value.slots.slice(0, max).forEach(function (slot) {
        if (!isObject(slot)) { slots.push(null); return; }
        var ip = typeof slot.ip === 'string' ? slot.ip.trim() : '';
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { slots.push(null); return; }
        slots.push({ ip: ip, channel: slot.channel === 2 ? 2 : 1 });
      });
    }
    while (slots.length < max) { slots.push(null); }
    return { mode: mode, slots: slots };
  }

  function sanitizePtzPresets(value) {
    if (!isObject(value)) { return {}; }
    var out = {};
    Object.keys(value).slice(0, 100).forEach(function (ip) {
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { return; }
      var labels = value[ip];
      if (!isObject(labels)) { return; }
      var clean = {};
      for (var i = 1; i <= 8; i += 1) {
        var label = labels[String(i)];
        if (typeof label === 'string' && label.trim()) {
          clean[String(i)] = label.trim().slice(0, 32);
        }
      }
      if (Object.keys(clean).length) { out[ip] = clean; }
    });
    return out;
  }

  var state = {
    get: function (key) {
      return hasOwn(stateStore, key) ? stateStore[key] : undefined;
    },
    set: function (key, value) {
      if (!hasOwn(stateDefaults, key)) {
        throw new Error('Khóa state không hợp lệ: ' + key);
      }
      stateStore[key] = value;
      notifyState(key);
    },
    patch: function (key, partial) {
      var current = stateStore[key];
      if (!isObject(current) || !isObject(partial)) {
        throw new Error('patch yêu cầu object');
      }
      stateStore[key] = Object.assign({}, current, partial);
      notifyState(key);
    },
    subscribe: function (key, fn) {
      if (typeof fn !== 'function') { return function () {}; }
      if (!stateListeners.has(key)) { stateListeners.set(key, new Set()); }
      stateListeners.get(key).add(fn);
      return function () {
        var set = stateListeners.get(key);
        if (set) { set.delete(fn); }
      };
    },
    reset: function () {
      stateStore = Object.assign({}, stateDefaults, { alarms: { history: [] }, cameras: [] });
      inflight = Object.create(null);
      Object.keys(stateDefaults).forEach(function (key) { notifyState(key); });
    },
    refresh: function (key) {
      var loader = stateLoaders[key];
      if (!loader) {
        return Promise.reject(new Error('Không có loader cho state: ' + key));
      }
      if (inflight[key]) { return inflight[key]; }
      var promise = Promise.resolve()
        .then(function () { return loader(); })
        .then(function (value) {
          stateStore[key] = value;
          notifyState(key);
          return value;
        })
        .finally(function () {
          delete inflight[key];
        });
      inflight[key] = promise;
      return promise;
    },
    getUi: function (key, fallback) {
      var raw = storageGet('cctv.ui.' + key);
      if (raw === null) { return fallback; }
      try {
        if (key === 'sidebarCollapsed') { return raw === '1'; }
        if (key === 'pageSize') {
          var size = Number(raw);
          return UI_PAGE_SIZES.indexOf(size) !== -1 ? size : fallback;
        }
        if (key === 'grid') {
          var parsed = sanitizeGrid(JSON.parse(raw));
          return parsed || fallback;
        }
        if (key === 'ptzPresets') {
          return sanitizePtzPresets(JSON.parse(raw));
        }
      } catch (err) {
        return fallback;
      }
      return fallback;
    },
    setUi: function (key, value) {
      if (key === 'sidebarCollapsed') {
        storageSet('cctv.ui.sidebarCollapsed', value ? '1' : '0');
        return value;
      }
      if (key === 'pageSize') {
        var size = Number(value);
        if (UI_PAGE_SIZES.indexOf(size) === -1) { return null; }
        storageSet('cctv.ui.pageSize', String(size));
        return size;
      }
      if (key === 'grid') {
        var grid = sanitizeGrid(value);
        if (!grid) { return null; }
        storageSet('cctv.ui.grid', JSON.stringify(grid));
        return grid;
      }
      if (key === 'ptzPresets') {
        var presets = sanitizePtzPresets(value);
        storageSet('cctv.ui.ptzPresets', JSON.stringify(presets));
        return presets;
      }
      return null;
    }
  };

  /* ================================ Router ============================= */

  var BUILTIN_META = {
    dashboard: { title: 'Tổng quan', icon: 'dashboard', roles: ['admin', 'viewer'], order: 10 },
    live: { title: 'Xem trực tiếp', icon: 'live', roles: ['admin', 'viewer'], order: 20 },
    cameras: { title: 'Camera', icon: 'cameras', roles: ['admin', 'viewer'], order: 30 },
    scanner: { title: 'Quét mạng', icon: 'scanner', roles: ['admin'], order: 40 },
    storage: { title: 'Lưu trữ', icon: 'storage', roles: ['admin', 'viewer'], order: 50 },
    alarms: { title: 'Cảnh báo', icon: 'alarms', roles: ['admin', 'viewer'], order: 60 },
    settings: { title: 'Cài đặt', icon: 'settings', roles: ['admin'], order: 70 }
  };

  var registry = new Map();
  var routerListeners = new Set();
  var routerStarted = false;
  var currentName = null;
  var currentMod = null;
  var currentAbort = null;
  var currentContainer = null;
  var hashBound = false;

  function normalizeViewMeta(name, mod) {
    var fallback = BUILTIN_META[name] || {};
    var roles = Array.isArray(mod.roles) ? mod.roles.filter(function (r) {
      return r === 'admin' || r === 'viewer';
    }) : (fallback.roles || ['admin']);
    return {
      name: name,
      title: typeof mod.title === 'string' ? mod.title : (fallback.title || name),
      icon: typeof mod.icon === 'string' ? mod.icon : (fallback.icon || 'circle'),
      roles: roles.length ? roles : ['admin'],
      order: Number.isFinite(Number(mod.order)) ? Number(mod.order) : (fallback.order || 100),
      render: mod.render,
      destroy: typeof mod.destroy === 'function' ? mod.destroy : null,
      onResume: typeof mod.onResume === 'function' ? mod.onResume : null
    };
  }

  function viewsRegister(name, mod) {
    if (!/^[a-z][a-z0-9-]*$/.test(String(name))) {
      throw new Error('Tên view không hợp lệ: ' + name);
    }
    if (registry.has(name)) {
      throw new Error('View đã được đăng ký: ' + name);
    }
    if (!mod || typeof mod.render !== 'function') {
      throw new Error('View ' + name + ' thiếu hàm render');
    }
    registry.set(name, normalizeViewMeta(name, mod));
  }

  function registeredViews() {
    return Array.from(registry.values()).sort(function (a, b) { return a.order - b.order; });
  }

  function viewMeta(name) {
    if (registry.has(name)) { return registry.get(name); }
    if (BUILTIN_META[name]) {
      return Object.assign({ name: name, render: null, destroy: null, onResume: null }, BUILTIN_META[name]);
    }
    return null;
  }

  function canAccess(meta) {
    return !!meta && meta.roles.indexOf(auth.role()) !== -1;
  }

  function parseHashName() {
    var hash = window.location.hash || '';
    var match = /^#\/?([a-z0-9-]+)/i.exec(hash);
    return match ? match[1].toLowerCase() : '';
  }

  function setActiveChrome(name) {
    var meta = viewMeta(name);
    var title = meta ? meta.title : 'Tổng quan';
    var heading = byId('view-title');
    var crumb = byId('view-breadcrumb');
    if (heading) { heading.textContent = title; }
    if (crumb) { crumb.textContent = 'CCTV Vision Hub / ' + title; }
    DOC.title = title + ' · CCTV Vision Hub';

    var links = DOC.querySelectorAll('[data-nav-name]');
    for (var i = 0; i < links.length; i += 1) {
      var elNode = links[i];
      if (elNode.getAttribute('data-nav-name') === name) {
        elNode.setAttribute('aria-current', 'page');
      } else {
        elNode.removeAttribute('aria-current');
      }
    }
    routerListeners.forEach(function (fn) {
      try { fn(name); } catch (err) { /* bỏ qua */ }
    });
  }

  function navButton(meta, className) {
    var btn = el('button', {
      class: className,
      attrs: {
        type: 'button',
        'data-nav-name': meta.name,
        /* Sidebar giữ test id chuẩn nav-<name>; bottom nav dùng tiền tố riêng
           để tránh trùng data-testid khi cả hai cùng hiển thị. */
        'data-testid': (className === 'c-bottom-nav__btn' ? 'bottom-nav-' : 'nav-') + meta.name,
        title: meta.title
      },
      on: {
        click: function () {
          closeMobileSidebar();
          router.go(meta.name);
        }
      }
    });
    if (className === 'c-bottom-nav__btn') {
      btn.appendChild(svgIcon(meta.icon, { size: 20 }));
      btn.appendChild(el('span', { text: meta.title }));
    } else {
      btn.appendChild(svgIcon(meta.icon, { size: 19 }));
      btn.appendChild(el('span', { class: 'c-sidebar__link-label', text: meta.title }));
    }
    return btn;
  }

  function buildNavigation() {
    var nav = byId('main-nav');
    var bottom = byId('bottom-nav');
    if (!nav || !bottom) { return; }
    clear(nav);
    clear(bottom);

    var allowed = registeredViews().filter(canAccess);
    allowed.forEach(function (meta) {
      nav.appendChild(navButton(meta, 'c-sidebar__link'));
    });

    var primaryNames = ['dashboard', 'live', 'cameras', 'alarms'];
    var primary = allowed.filter(function (meta) { return primaryNames.indexOf(meta.name) !== -1; });
    var extras = allowed.filter(function (meta) { return primaryNames.indexOf(meta.name) === -1; });
    primary.forEach(function (meta) {
      bottom.appendChild(navButton(meta, 'c-bottom-nav__btn'));
    });
    if (extras.length) {
      var more = el('button', {
        class: 'c-bottom-nav__btn',
        attrs: { type: 'button', 'aria-haspopup': 'dialog' },
        on: { click: openMoreSheet }
      });
      more.appendChild(svgIcon('more-horizontal', { size: 20 }));
      more.appendChild(el('span', { text: 'Thêm' }));
      bottom.appendChild(more);
    }
  }

  function openMoreSheet() {
    var body = el('div', { class: 'c-stack c-stack--sm' });
    var handle = null;
    registeredViews().filter(canAccess).forEach(function (meta) {
      var btn = el('button', {
        class: 'c-menu__item',
        attrs: { type: 'button' },
        on: {
          click: function () {
            if (handle) { handle.close(); }
            router.go(meta.name);
          }
        }
      });
      btn.appendChild(svgIcon(meta.icon, { size: 17 }));
      btn.appendChild(el('span', { text: meta.title }));
      body.appendChild(btn);
    });
    handle = ui.drawer({
      title: 'Điều hướng',
      body: body,
      dismissible: true
    });
  }

  function setMobileSidebarAccessible(open) {
    var sidebar = byId('sidebar');
    if (!sidebar) { return; }
    var mobile = !!(window.matchMedia && window.matchMedia('(max-width: 1023px)').matches);
    if (mobile) {
      sidebar.setAttribute('aria-hidden', open ? 'false' : 'true');
      if ('inert' in sidebar) { sidebar.inert = !open; }
    } else {
      sidebar.removeAttribute('aria-hidden');
      if ('inert' in sidebar) { sidebar.inert = false; }
    }
  }

  function closeMobileSidebar() {
    var shell = byId('app-shell');
    var backdrop = byId('sidebar-backdrop');
    var toggle = byId('sidebar-toggle');
    if (shell) { shell.classList.remove('is-sidebar-open'); }
    if (backdrop) { backdrop.hidden = true; }
    if (toggle) { toggle.setAttribute('aria-expanded', 'false'); }
    setMobileSidebarAccessible(false);
  }

  function destroyCurrentView() {
    if (currentMod && currentMod.destroy) {
      try { currentMod.destroy(); } catch (err) { /* view lỗi không chặn điều hướng */ }
    }
    if (currentAbort) {
      try { currentAbort.abort(); } catch (err) { /* bỏ qua */ }
    }
    if (currentContainer) { clear(currentContainer); }
    currentName = null;
    currentMod = null;
    currentAbort = null;
    currentContainer = null;
  }

  function showViewError(name, error) {
    var container = byId('view-root');
    if (!container) { return; }
    destroyCurrentView();
    currentName = name;
    setActiveChrome(name);
    var message = error && error.message ? error.message : 'Không tải được màn hình.';
    var panel = ui.errorPanel({
      title: 'Không tải được màn hình',
      message: message,
      code: error && error.code ? error.code : null,
      requestId: error && error.requestId ? error.requestId : null,
      retry: function () {
        currentName = null;
        renderRouteName(name);
      }
    });
    container.appendChild(panel);
  }

  function renderRouteName(name) {
    var meta = viewMeta(name);
    if (!meta) { return; }
    var mod = registry.get(name);
    if (!mod) {
      var containerMissing = byId('view-root');
      if (!containerMissing) { return; }
      destroyCurrentView();
      currentName = name;
      setActiveChrome(name);
      containerMissing.appendChild(ui.errorPanel({
        title: 'Không tải được màn hình ' + meta.title,
        message: 'Tệp JavaScript của màn hình chưa được tải. Kiểm tra kết nối và thử lại.',
        retry: function () {
          currentName = null;
          renderRouteName(name);
        }
      }));
      return;
    }

    destroyCurrentView();
    var container = byId('view-root');
    if (!container) { return; }
    currentName = name;
    currentMod = mod;
    currentAbort = typeof AbortController === 'function' ? new AbortController() : null;
    currentContainer = container;
    setActiveChrome(name);

    var ctx = {
      role: auth.role(),
      isAdmin: auth.isAdmin(),
      signal: currentAbort ? currentAbort.signal : undefined,
      api: api,
      ui: ui,
      state: state,
      router: router,
      container: container,
      toast: ui.toast,
      confirm: ui.confirm,
      format: fmt,
      icons: CCTV.icons
    };

    try {
      var result = mod.render(container, ctx);
      if (result && typeof result.then === 'function') {
        result.catch(function (err) { showViewError(name, err); });
      }
    } catch (err) {
      showViewError(name, err);
      return;
    }
    try { container.focus({ preventScroll: true }); } catch (err) { /* bỏ qua */ }
  }

  function handleRoute() {
    if (!routerStarted) { return; }
    var name = parseHashName();
    if (!name) {
      router.go('dashboard', { replace: true });
      return;
    }
    var meta = viewMeta(name);
    if (!meta) {
      ui.toast('Không tìm thấy màn hình "' + name + '".', { type: 'warning' });
      router.go('dashboard', { replace: true });
      return;
    }
    if (!canAccess(meta)) {
      ui.toast('Bạn không có quyền truy cập màn hình này.', { type: 'warning' });
      router.go('dashboard', { replace: true });
      return;
    }
    if (name === currentName) { return; }
    renderRouteName(name);
  }

  var router = {
    defaultView: 'dashboard',
    init: function (options) {
      options = options || {};
      if (options.defaultView) { router.defaultView = options.defaultView; }
      return router;
    },
    start: function () {
      if (routerStarted) { return; }
      if (!auth.role()) { return; }
      routerStarted = true;
      buildNavigation();
      if (!hashBound) {
        window.addEventListener('hashchange', handleRoute);
        hashBound = true;
      }
      handleRoute();
    },
    stop: function () {
      routerStarted = false;
      if (hashBound) {
        window.removeEventListener('hashchange', handleRoute);
        hashBound = false;
      }
      destroyCurrentView();
      var links = DOC.querySelectorAll('[data-nav-name]');
      for (var i = 0; i < links.length; i += 1) {
        links[i].removeAttribute('aria-current');
      }
    },
    go: function (name, options) {
      options = options || {};
      var target = '#/' + String(name);
      if (window.location.hash === target) {
        handleRoute();
        return;
      }
      if (options.replace) {
        try {
          window.history.replaceState(null, '', target);
        } catch (err) {
          window.location.hash = target;
          return;
        }
        handleRoute();
      } else {
        window.location.hash = target;
      }
    },
    current: function () { return currentName; },
    onChange: function (fn) {
      if (typeof fn !== 'function') { return function () {}; }
      routerListeners.add(fn);
      return function () { routerListeners.delete(fn); };
    },
    routes: function () {
      return registeredViews().filter(canAccess).map(function (meta) {
        return { name: meta.name, title: meta.title, icon: meta.icon };
      });
    }
  };

  DOC.addEventListener('visibilitychange', function () {
    if (DOC.hidden || !routerStarted || !currentMod || !currentMod.onResume) { return; }
    try { currentMod.onResume(); } catch (err) { /* bỏ qua */ }
  });

  CCTV.dom = {
    el: el,
    text: setText,
    clear: clear,
    fragment: fragment,
    svg: svgIcon,
    safePath: safePath,
    append: appendChildren
  };
  CCTV.fmt = fmt;
  CCTV.poll = poll;
  CCTV.api = api;
  CCTV.auth = auth;
  CCTV.state = state;
  CCTV.router = router;
  CCTV.views = {
    register: viewsRegister,
    list: function () {
      return registeredViews().map(function (meta) {
        return { name: meta.name, title: meta.title, icon: meta.icon, roles: meta.roles.slice(), order: meta.order };
      });
    },
    has: function (name) { return registry.has(name); }
  };
  CCTV.icons = {
    svg: svgIcon,
    exists: iconExists
  };

  /* ============================== UI: cơ bản =========================== */

  var seq = 0;
  var busyLabels = new WeakMap();
  var toastSeen = Object.create(null);
  var toastRoot = null;

  function nextId(prefix) {
    seq += 1;
    return prefix + '-' + seq;
  }

  function buttonControl(opts) {
    opts = opts || {};
    var variant = opts.variant || 'secondary';
    var hasLabel = opts.label !== undefined && opts.label !== null && String(opts.label) !== '';
    var classes = 'c-btn c-btn--' + variant;
    if (!hasLabel) { classes += ' c-btn--icon'; }
    if (opts.size === 'sm') { classes += ' c-btn--sm'; }
    if (opts.block) { classes += ' c-btn--block'; }
    if (!hasLabel && !opts.ariaLabel && !opts.title) {
      throw new Error('Nút icon phải có ariaLabel');
    }
    var btn = el('button', {
      class: classes,
      attrs: {
        type: opts.type || 'button',
        'aria-label': opts.ariaLabel || null,
        title: opts.title || null,
        'data-testid': opts.testId || null
      }
    });
    if (opts.icon) { btn.appendChild(svgIcon(opts.icon, { size: opts.iconSize || 17 })); }
    if (hasLabel) { btn.appendChild(el('span', { class: 'c-btn__label', text: String(opts.label) })); }
    if (opts.disabled) { btn.disabled = true; }
    if (typeof opts.onClick === 'function') {
      btn.addEventListener('click', opts.onClick);
    }
    return btn;
  }

  function iconButton(opts) {
    opts = opts || {};
    if (!opts.label) { throw new Error('iconButton yêu cầu label'); }
    return buttonControl({
      icon: opts.icon,
      variant: opts.variant || 'ghost',
      ariaLabel: opts.label,
      title: opts.title || opts.label,
      onClick: opts.onClick,
      disabled: opts.disabled,
      size: opts.size,
      testId: opts.testId,
      iconSize: opts.iconSize
    });
  }

  function badge(text, opts) {
    opts = opts || {};
    return el('span', {
      class: 'c-badge',
      attrs: { 'data-tone': opts.tone || 'neutral' },
      text: String(text)
    });
  }

  function statusPill(status, opts) {
    opts = opts || {};
    var info = fmt.status(status);
    var pill = el('span', {
      class: 'c-status',
      attrs: { 'data-status': opts.css || info.css, title: opts.title || info.label }
    });
    pill.appendChild(svgIcon(info.icon, { size: 14 }));
    pill.appendChild(el('span', { text: opts.label || info.label }));
    return pill;
  }

  function kpi(opts) {
    opts = opts || {};
    var card = el('div', {
      class: 'c-kpi',
      attrs: { 'data-tone': opts.tone || 'neutral', 'data-testid': opts.testId || null }
    });
    var top = el('div', { class: 'c-kpi__top' });
    top.appendChild(el('span', { class: 'c-kpi__label', text: String(opts.label || '') }));
    if (opts.icon) {
      var iconWrap = el('span', { class: 'c-kpi__icon' });
      iconWrap.appendChild(svgIcon(opts.icon, { size: 16 }));
      top.appendChild(iconWrap);
    }
    card.appendChild(top);
    card.appendChild(el('span', { class: 'c-kpi__value', text: String(opts.value === undefined || opts.value === null ? '—' : opts.value) }));
    if (opts.hint) {
      card.appendChild(el('span', { class: 'c-kpi__hint', text: String(opts.hint) }));
    }
    return card;
  }

  var BANNER_ICONS = { info: 'info', warning: 'alert-triangle', danger: 'alert-circle', success: 'check-circle' };

  function banner(opts) {
    opts = opts || {};
    var tone = opts.tone === 'danger' || opts.tone === 'warning' || opts.tone === 'success' ? opts.tone : 'info';
    var root = el('div', {
      class: 'c-banner',
      attrs: {
        'data-tone': tone,
        role: tone === 'danger' ? 'alert' : 'status',
        'data-testid': opts.testId || null
      }
    });
    var icon = el('span', { class: 'c-banner__icon' });
    icon.appendChild(svgIcon(opts.icon || BANNER_ICONS[tone], { size: 18 }));
    root.appendChild(icon);
    var bodyWrap = el('div', { class: 'c-banner__body' });
    if (opts.title) { bodyWrap.appendChild(el('div', { class: 'c-banner__title', text: String(opts.title) })); }
    if (opts.message) { bodyWrap.appendChild(el('div', { class: 'c-banner__message', text: String(opts.message) })); }
    if (opts.actions && opts.actions.length) {
      var actions = el('div', { class: 'c-banner__actions' });
      appendChildren(actions, opts.actions);
      bodyWrap.appendChild(actions);
    }
    root.appendChild(bodyWrap);
    if (opts.dismissible) {
      var close = iconButton({
        icon: 'x',
        label: 'Đóng thông báo',
        size: 'sm',
        onClick: function () { root.remove(); }
      });
      close.classList.add('c-banner__close');
      root.appendChild(close);
    }
    return root;
  }

  function progress(opts) {
    opts = opts || {};
    var max = Number(opts.max) > 0 ? Number(opts.max) : 100;
    var root = el('div', { class: 'c-progress' });
    var head = el('div', { class: 'c-progress__head' });
    var label = el('span', { text: String(opts.label || '') });
    var valueText = el('span', { class: 'u-tabular', text: '' });
    head.appendChild(label);
    head.appendChild(valueText);
    if (opts.label) { root.appendChild(head); }
    var track = el('div', {
      class: 'c-progress__track',
      attrs: {
        role: 'progressbar',
        'aria-label': opts.ariaLabel || opts.label || 'Tiến trình',
        'aria-valuemin': '0',
        'aria-valuemax': String(max),
        'aria-valuenow': '0'
      }
    });
    var fill = el('div', {
      class: 'c-progress__fill',
      attrs: { 'data-tone': opts.tone || 'primary' }
    });
    track.appendChild(fill);
    root.appendChild(track);
    function setValue(value, maxValue) {
      var m = Number(maxValue) > 0 ? Number(maxValue) : max;
      var v = clamp(Number(value) || 0, 0, m);
      var pct = m ? (v / m) * 100 : 0;
      fill.style.setProperty('--pct', pct.toFixed(2) + '%');
      track.setAttribute('aria-valuenow', String(Math.round(v)));
      valueText.textContent = opts.valueText ? String(opts.valueText(v, m)) : Math.round(pct) + '%';
    }
    setValue(opts.value || 0, max);
    return { el: root, setValue: setValue };
  }

  function gauge(opts) {
    opts = opts || {};
    var percent = clamp(Number(opts.percent) || 0, 0, 100);
    var tone = opts.tone || (percent >= 90 ? 'danger' : percent >= 75 ? 'warning' : 'primary');
    var root = el('div', { class: 'c-gauge' });
    var svg = DOC.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'c-gauge__svg');
    svg.setAttribute('viewBox', '0 0 96 96');
    svg.setAttribute('aria-hidden', 'true');
    var radius = 40;
    var circ = 2 * Math.PI * radius;
    var track = DOC.createElementNS(SVG_NS, 'circle');
    track.setAttribute('class', 'c-gauge__track');
    track.setAttribute('cx', '48');
    track.setAttribute('cy', '48');
    track.setAttribute('r', String(radius));
    var value = DOC.createElementNS(SVG_NS, 'circle');
    value.setAttribute('class', 'c-gauge__value');
    value.setAttribute('data-tone', tone === 'primary' ? 'primary' : tone);
    value.setAttribute('cx', '48');
    value.setAttribute('cy', '48');
    value.setAttribute('r', String(radius));
    value.setAttribute('transform', 'rotate(-90 48 48)');
    value.setAttribute('stroke-dasharray', circ.toFixed(2));
    value.setAttribute('stroke-dashoffset', (circ * (1 - percent / 100)).toFixed(2));
    var text = DOC.createElementNS(SVG_NS, 'text');
    text.setAttribute('class', 'c-gauge__percent');
    text.setAttribute('x', '48');
    text.setAttribute('y', '53');
    text.textContent = Math.round(percent) + '%';
    svg.appendChild(track);
    svg.appendChild(value);
    svg.appendChild(text);
    root.appendChild(svg);
    var meta = el('div', { class: 'c-gauge__meta' });
    if (opts.label) { meta.appendChild(el('span', { class: 'c-gauge__label', text: String(opts.label) })); }
    if (opts.valueText) { meta.appendChild(el('span', { class: 'c-gauge__value-text', text: String(opts.valueText) })); }
    root.appendChild(meta);
    return root;
  }

  function tabs(opts) {
    opts = opts || {};
    var groupId = nextId('tabs');
    var list = el('div', {
      class: 'c-tabs',
      attrs: { role: 'tablist', 'aria-label': opts.label || 'Các mục', 'data-testid': opts.testId || null }
    });
    var buttons = new Map();
    var activeId = opts.active;

    function panelId(id) {
      return opts.panelId ? String(opts.panelId(id)) : groupId + '-panel-' + id;
    }

    function setActive(id, focus) {
      if (!buttons.has(id)) { return; }
      activeId = id;
      buttons.forEach(function (btn, key) {
        var selected = key === id;
        btn.setAttribute('aria-selected', selected ? 'true' : 'false');
        btn.setAttribute('tabindex', selected ? '0' : '-1');
      });
      if (focus) { buttons.get(id).focus(); }
      if (typeof opts.onChange === 'function') { opts.onChange(id); }
    }

    opts.tabs.forEach(function (tab, index) {
      var tabId = groupId + '-tab-' + tab.id;
      var btn = el('button', {
        class: 'c-tab',
        attrs: {
          type: 'button',
          role: 'tab',
          id: tabId,
          'aria-controls': panelId(tab.id),
          'aria-selected': tab.id === activeId ? 'true' : 'false',
          tabindex: tab.id === activeId ? '0' : '-1'
        }
      });
      if (tab.icon) { btn.appendChild(svgIcon(tab.icon, { size: 15 })); }
      btn.appendChild(el('span', { text: tab.label }));
      if (tab.badge !== undefined && tab.badge !== null) {
        btn.appendChild(badge(tab.badge, { tone: tab.badgeTone || 'neutral' }));
      }
      btn.addEventListener('click', function () { setActive(tab.id, false); });
      btn.addEventListener('keydown', function (ev) {
        var keys = Array.from(buttons.keys());
        var pos = keys.indexOf(activeId);
        if (ev.key === 'ArrowRight') {
          ev.preventDefault();
          setActive(keys[(pos + 1) % keys.length], true);
        } else if (ev.key === 'ArrowLeft') {
          ev.preventDefault();
          setActive(keys[(pos - 1 + keys.length) % keys.length], true);
        } else if (ev.key === 'Home') {
          ev.preventDefault();
          setActive(keys[0], true);
        } else if (ev.key === 'End') {
          ev.preventDefault();
          setActive(keys[keys.length - 1], true);
        }
      });
      buttons.set(tab.id, btn);
      list.appendChild(btn);
    });

    return {
      el: list,
      setActive: setActive,
      getActive: function () { return activeId; },
      getPanelId: panelId,
      getTabId: function (id) { return groupId + '-tab-' + id; },
      destroy: function () { clear(list); buttons.clear(); }
    };
  }

  function switchControl(opts) {
    opts = opts || {};
    var id = nextId('sw');
    var root = el('label', { class: 'c-switch', attrs: { for: id } });
    var input = el('input', {
      attrs: {
        type: 'checkbox',
        id: id,
        role: 'switch',
        'data-testid': opts.testId || null
      }
    });
    input.checked = !!opts.checked;
    if (opts.disabled) { input.disabled = true; }
    var track = el('span', { class: 'c-switch__track', attrs: { 'aria-hidden': 'true' } });
    root.appendChild(input);
    root.appendChild(track);
    if (opts.label || opts.description) {
      var textWrap = el('span', { class: 'c-switch__text' });
      if (opts.label) { textWrap.appendChild(el('span', { class: 'c-switch__label', text: String(opts.label) })); }
      if (opts.description) { textWrap.appendChild(el('span', { class: 'c-switch__desc', text: String(opts.description) })); }
      root.appendChild(textWrap);
    }
    input.addEventListener('change', function () {
      if (typeof opts.onChange === 'function') { opts.onChange(input.checked); }
    });
    return {
      el: root,
      isChecked: function () { return input.checked; },
      setChecked: function (value) { input.checked = !!value; },
      setDisabled: function (value) { input.disabled = !!value; },
      input: input
    };
  }

  function field(opts) {
    opts = opts || {};
    var id = nextId('fld');
    var type = opts.type || 'text';
    var root = el('div', { class: 'c-field' });
    var control;
    var helpId = id + '-help';
    var errorId = id + '-err';
    var errorNode = null;
    var helpNode = null;

    if (type === 'checkbox') {
      var checkWrap = el('label', { class: 'c-check', attrs: { for: id } });
      control = el('input', {
        attrs: {
          type: 'checkbox',
          id: id,
          name: opts.name || null,
          'data-testid': opts.testId || null
        }
      });
      control.checked = !!opts.value;
      if (opts.disabled) { control.disabled = true; }
      checkWrap.appendChild(control);
      checkWrap.appendChild(el('span', { text: String(opts.label || '') }));
      root.appendChild(checkWrap);
    } else {
      var labelNode = el('label', { class: 'c-field__label', attrs: { for: id } });
      labelNode.appendChild(DOC.createTextNode(String(opts.label || '')));
      if (opts.required) {
        var req = el('span', { class: 'c-req', text: '*', attrs: { 'aria-hidden': 'true' } });
        labelNode.appendChild(req);
      }
      root.appendChild(labelNode);

      if (type === 'select') {
        control = el('select', {
          class: 'c-select',
          attrs: {
            id: id,
            name: opts.name || null,
            'data-testid': opts.testId || null,
            disabled: !!opts.disabled || null,
            required: !!opts.required || null
          }
        });
        fillSelect(control, opts.options, opts.value);
      } else if (type === 'textarea') {
        control = el('textarea', {
          class: 'c-textarea',
          attrs: {
            id: id,
            name: opts.name || null,
            placeholder: opts.placeholder || null,
            maxlength: opts.maxlength || null,
            'data-testid': opts.testId || null,
            disabled: !!opts.disabled || null,
            required: !!opts.required || null
          }
        });
        control.value = opts.value === undefined || opts.value === null ? '' : String(opts.value);
      } else {
        control = el('input', {
          class: 'c-input' + (opts.mono ? ' c-input--mono' : ''),
          attrs: {
            type: type,
            id: id,
            name: opts.name || null,
            placeholder: opts.placeholder || null,
            min: opts.min !== undefined ? opts.min : null,
            max: opts.max !== undefined ? opts.max : null,
            step: opts.step !== undefined ? opts.step : null,
            maxlength: opts.maxlength || null,
            autocomplete: opts.autocomplete || (type === 'password' ? 'off' : null),
            inputmode: opts.inputmode || null,
            'data-testid': opts.testId || null,
            disabled: !!opts.disabled || null,
            required: !!opts.required || null
          }
        });
        control.value = opts.value === undefined || opts.value === null ? '' : String(opts.value);
      }
      root.appendChild(control);

      if (opts.help) {
        helpNode = el('span', { class: 'c-field__help', attrs: { id: helpId }, text: String(opts.help) });
        root.appendChild(helpNode);
        control.setAttribute('aria-describedby', helpId);
      }
      errorNode = el('span', { class: 'c-field__error', attrs: { id: errorId }, text: '' });
      errorNode.hidden = true;
      root.appendChild(errorNode);
    }

    function setError(message) {
      root.classList.add('is-invalid');
      control.setAttribute('aria-invalid', 'true');
      if (errorNode) {
        errorNode.hidden = false;
        errorNode.textContent = String(message || 'Giá trị không hợp lệ.');
        control.setAttribute('aria-describedby', errorId);
      }
    }

    function clearError() {
      root.classList.remove('is-invalid');
      control.removeAttribute('aria-invalid');
      if (errorNode) {
        errorNode.hidden = true;
        errorNode.textContent = '';
      }
      if (helpNode) { control.setAttribute('aria-describedby', helpId); }
    }

    return {
      el: root,
      input: control,
      getValue: function () {
        if (type === 'checkbox') { return control.checked; }
        return control.value;
      },
      setValue: function (value) {
        if (type === 'checkbox') {
          control.checked = !!value;
        } else {
          control.value = value === undefined || value === null ? '' : String(value);
        }
      },
      setError: setError,
      clearError: clearError,
      setDisabled: function (value) { control.disabled = !!value; },
      setOptions: function (options, value) {
        if (type === 'select') { fillSelect(control, options, value); }
      },
      focus: function () { control.focus(); }
    };
  }

  function fillSelect(select, options, value) {
    clear(select);
    (Array.isArray(options) ? options : []).forEach(function (option) {
      var opt = option;
      if (!isObject(opt)) {
        opt = { value: option, label: String(option) };
      }
      var node = el('option', {
        attrs: { value: opt.value === undefined || opt.value === null ? '' : String(opt.value) },
        text: opt.label === undefined ? String(opt.value) : String(opt.label)
      });
      if (String(opt.value) === String(value)) { node.selected = true; }
      select.appendChild(node);
    });
    if (value !== undefined && value !== null) {
      select.value = String(value);
    }
  }

  function searchBox(opts) {
    opts = opts || {};
    var id = nextId('search');
    var root = el('div', { class: 'c-input-group c-input-group--with-icon' });
    var icon = el('span', { class: 'c-input-group__icon' });
    icon.appendChild(svgIcon('search', { size: 16 }));
    root.appendChild(icon);
    var input = el('input', {
      class: 'c-input',
      attrs: {
        type: 'search',
        id: id,
        placeholder: opts.placeholder || 'Tìm kiếm…',
        'aria-label': opts.ariaLabel || opts.placeholder || 'Tìm kiếm',
        autocomplete: 'off',
        spellcheck: 'false',
        'data-view-search': '1',
        'data-testid': opts.testId || null
      }
    });
    root.appendChild(input);
    var timer = null;
    function emitNow() {
      if (typeof opts.onInput === 'function') { opts.onInput(input.value); }
    }
    input.addEventListener('input', function () {
      if (timer) { clearTimeout(timer); }
      timer = setTimeout(emitNow, 180);
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (timer) { clearTimeout(timer); }
        emitNow();
      }
    });
    return {
      el: root,
      input: input,
      getValue: function () { return input.value; },
      clear: function () { input.value = ''; emitNow(); },
      focus: function () { input.focus(); },
      destroy: function () { if (timer) { clearTimeout(timer); } }
    };
  }

  function toolbar(opts) {
    opts = opts || {};
    var root = el('div', { class: 'c-toolbar' });
    var left = el('div', { class: 'c-toolbar__left' });
    var right = el('div', { class: 'c-toolbar__right' });
    if (opts.left) { appendChildren(left, opts.left); }
    if (opts.right) { appendChildren(right, opts.right); }
    root.appendChild(left);
    root.appendChild(right);
    return root;
  }

  function pageHeader(opts) {
    opts = opts || {};
    var root = el('div', { class: 'c-page-header', attrs: { 'data-testid': opts.testId || null } });
    var left = el('div', { class: 'c-page-header__left' });
    var titleRow = el('div', { class: 'c-page-header__title' });
    if (opts.icon) { titleRow.appendChild(svgIcon(opts.icon, { size: 22 })); }
    titleRow.appendChild(el('h1', { text: String(opts.title || '') }));
    left.appendChild(titleRow);
    if (opts.subtitle) {
      left.appendChild(el('p', { class: 'c-page-header__subtitle', text: String(opts.subtitle) }));
    }
    root.appendChild(left);
    if (opts.actions && opts.actions.length) {
      var actions = el('div', { class: 'c-page-header__actions' });
      appendChildren(actions, opts.actions);
      root.appendChild(actions);
    }
    return root;
  }

  function pagination(opts) {
    opts = opts || {};
    var state = {
      page: Math.max(1, Number(opts.page) || 1),
      pageSize: Number(opts.pageSize) || 15,
      total: Math.max(0, Number(opts.total) || 0)
    };
    var sizes = Array.isArray(opts.pageSizes) && opts.pageSizes.length ? opts.pageSizes : [10, 15, 20, 30, 50];
    var root = el('div', { class: 'c-pagination' });
    var info = el('span', { class: 'u-tabular' });
    var pages = el('div', { class: 'c-pagination__pages' });
    var sizeWrap = el('label', { class: 'c-pagination__size' });
    sizeWrap.appendChild(el('span', { text: 'Số dòng' }));
    var sizeSelect = el('select', { class: 'c-select', attrs: { 'aria-label': 'Số dòng mỗi trang' } });
    sizes.forEach(function (size) {
      sizeSelect.appendChild(el('option', { attrs: { value: String(size) }, text: String(size) }));
    });
    sizeSelect.value = String(state.pageSize);
    sizeWrap.appendChild(sizeSelect);
    root.appendChild(info);
    root.appendChild(pages);
    root.appendChild(sizeWrap);

    function totalPages() {
      return Math.max(1, Math.ceil(state.total / state.pageSize));
    }

    function emit(changePageSize) {
      if (typeof opts.onChange === 'function') {
        opts.onChange(state.page, state.pageSize, changePageSize === true);
      }
    }

    function pageButton(label, page, ariaLabel, disabled, current) {
      var btn = el('button', {
        class: 'c-pagination__btn',
        attrs: {
          type: 'button',
          'aria-label': ariaLabel || label,
          disabled: !!disabled || null
        },
        text: String(label)
      });
      if (current) { btn.setAttribute('aria-current', 'page'); }
      if (!disabled && !current) {
        btn.addEventListener('click', function () {
          state.page = page;
          render();
          emit(false);
        });
      }
      return btn;
    }

    function render() {
      var tp = totalPages();
      state.page = clamp(state.page, 1, tp);
      var start = state.total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
      var end = Math.min(state.total, state.page * state.pageSize);
      info.textContent = start + '–' + end + ' / ' + state.total;
      clear(pages);
      pages.appendChild(pageButton('‹', state.page - 1, 'Trang trước', state.page <= 1, false));
      var first = Math.max(1, state.page - 2);
      var last = Math.min(tp, first + 4);
      first = Math.max(1, last - 4);
      for (var p = first; p <= last; p += 1) {
        pages.appendChild(pageButton(p, p, 'Trang ' + p, false, p === state.page));
      }
      pages.appendChild(pageButton('›', state.page + 1, 'Trang sau', state.page >= tp, false));
    }

    sizeSelect.addEventListener('change', function () {
      state.pageSize = Number(sizeSelect.value) || 15;
      state.page = 1;
      render();
      emit(true);
    });

    render();
    return {
      el: root,
      setState: function (next) {
        if (next.page !== undefined) { state.page = Math.max(1, Number(next.page) || 1); }
        if (next.pageSize !== undefined) { state.pageSize = Number(next.pageSize) || state.pageSize; }
        if (next.total !== undefined) { state.total = Math.max(0, Number(next.total) || 0); }
        sizeSelect.value = String(state.pageSize);
        render();
      },
      getState: function () { return { page: state.page, pageSize: state.pageSize, total: state.total }; }
    };
  }

  function skeleton(opts) {
    opts = opts || {};
    var rows = Math.max(1, Number(opts.rows) || 3);
    if (opts.variant === 'kpi') {
      return el('div', { class: 'c-skeleton c-skeleton--kpi' });
    }
    if (opts.variant === 'card') {
      return el('div', { class: 'c-skeleton c-skeleton--card' });
    }
    if (opts.variant === 'table') {
      var wrap = el('div', { class: 'c-skeleton-stack', attrs: { 'aria-hidden': 'true' } });
      for (var i = 0; i < rows; i += 1) {
        wrap.appendChild(el('div', { class: 'c-skeleton c-skeleton--line' }));
      }
      return wrap;
    }
    var stack = el('div', { class: 'c-skeleton-stack', attrs: { 'aria-hidden': 'true' } });
    for (var j = 0; j < rows; j += 1) {
      stack.appendChild(el('div', { class: 'c-skeleton c-skeleton--text' }));
    }
    return stack;
  }

  function emptyState(opts) {
    opts = opts || {};
    var root = el('div', { class: 'c-empty' });
    var iconWrap = el('span', { class: 'c-empty__icon', attrs: { 'aria-hidden': 'true' } });
    iconWrap.appendChild(svgIcon(opts.icon || 'circle', { size: 22 }));
    root.appendChild(iconWrap);
    root.appendChild(el('p', { class: 'c-empty__title', text: String(opts.title || 'Không có dữ liệu') }));
    if (opts.description) {
      root.appendChild(el('p', { class: 'c-empty__desc', text: String(opts.description) }));
    }
    if (opts.action) {
      var actions = el('div', { class: 'c-empty__action' });
      appendChildren(actions, opts.action);
      root.appendChild(actions);
    }
    return root;
  }

  function errorPanel(opts) {
    opts = opts || {};
    var root = el('div', { class: 'c-error-panel', attrs: { role: 'alert' } });
    var icon = el('span', { class: 'c-error-panel__icon' });
    icon.appendChild(svgIcon('alert-triangle', { size: 20 }));
    root.appendChild(icon);
    var body = el('div', { class: 'c-error-panel__body' });
    body.appendChild(el('div', { class: 'c-error-panel__title', text: String(opts.title || 'Đã xảy ra lỗi') }));
    if (opts.message) {
      body.appendChild(el('div', { class: 'c-error-panel__message', text: String(opts.message) }));
    }
    var metaParts = [];
    if (opts.code) { metaParts.push('Mã lỗi: ' + opts.code); }
    if (opts.requestId) { metaParts.push('Mã hỗ trợ: ' + opts.requestId); }
    if (metaParts.length) {
      body.appendChild(el('div', { class: 'c-error-panel__meta', text: metaParts.join(' · ') }));
    }
    if (typeof opts.retry === 'function') {
      var actions = el('div', { class: 'c-error-panel__actions' });
      actions.appendChild(buttonControl({ label: 'Thử lại', icon: 'refresh', variant: 'secondary', size: 'sm', onClick: opts.retry }));
      body.appendChild(actions);
    }
    root.appendChild(body);
    return root;
  }

  /* =============================== UI: bảng =========================== */

  function compareValues(a, b) {
    var aNum = typeof a === 'number';
    var bNum = typeof b === 'number';
    if (aNum && bNum) { return a - b; }
    if (typeof a === 'boolean' && typeof b === 'boolean') { return (a ? 1 : 0) - (b ? 1 : 0); }
    return String(a === undefined || a === null ? '' : a).localeCompare(String(b === undefined || b === null ? '' : b), 'vi', { numeric: true, sensitivity: 'base' });
  }

  function table(options) {
    options = options || {};
    if (!Array.isArray(options.columns) || !options.columns.length) {
      throw new Error('ui.table yêu cầu columns');
    }
    var columns = options.columns.slice();
    var controller = new AbortController();
    var signal = controller.signal;
    var state = {
      rows: Array.isArray(options.rows) ? options.rows.slice() : [],
      loading: !!options.loading,
      selected: new Set(Array.isArray(options.selectedKeys) ? options.selectedKeys.map(String) : []),
      sort: options.sort && options.sort.key ? { key: options.sort.key, dir: options.sort.dir === 'desc' ? 'desc' : 'asc' } : null
    };
    var selectable = !!options.selectable;
    var captionText = options.caption || 'Bảng dữ liệu';
    var wrap = el('div', {
      class: 'c-table-wrap',
      attrs: {
        role: 'region',
        'aria-label': captionText,
        tabindex: '0',
        'data-testid': options.testId || null
      }
    });
    var tableNode = el('table', { class: 'c-table' + (options.mobile === 'cards' ? ' c-table--cards' : '') });
    var caption = el('caption', { class: 'u-sr-only', text: captionText });
    var thead = el('thead');
    var tbody = el('tbody');
    tableNode.appendChild(caption);
    tableNode.appendChild(thead);
    tableNode.appendChild(tbody);
    wrap.appendChild(tableNode);

    function keyOf(row, index) {
      if (typeof options.rowKey === 'function') {
        var key = options.rowKey(row, index);
        return key === undefined || key === null ? String(index) : String(key);
      }
      if (row && row.id !== undefined) { return String(row.id); }
      if (row && row.ip !== undefined) { return String(row.ip); }
      return String(index);
    }

    function emitSelection() {
      if (typeof options.onSelectionChange !== 'function') { return; }
      var keys = Array.from(state.selected);
      var rows = state.rows.filter(function (row, index) {
        return state.selected.has(keyOf(row, index));
      });
      options.onSelectionChange(keys, rows);
    }

    function toggleAll(checked) {
      state.rows.forEach(function (row, index) {
        var key = keyOf(row, index);
        if (checked) { state.selected.add(key); } else { state.selected.delete(key); }
      });
      renderBody();
      emitSelection();
    }

    function renderHead() {
      clear(thead);
      var tr = el('tr');
      if (selectable) {
        var thCheck = el('th', { class: 'c-table__check', attrs: { scope: 'col' } });
        var master = el('input', {
          attrs: { type: 'checkbox', 'aria-label': 'Chọn trang này' }
        });
        master.addEventListener('change', function () { toggleAll(master.checked); }, { signal: signal });
        thCheck.appendChild(master);
        tr.appendChild(thCheck);
      }
      columns.forEach(function (col) {
        var alignClass = col.align === 'right' ? ' c-cell--right' : col.align === 'center' ? ' c-cell--center' : '';
        var th = el('th', { class: alignClass, attrs: { scope: 'col' } });
        if (col.width) { th.style.setProperty('width', String(col.width)); }
        if (col.sortable) {
          var dir = state.sort && state.sort.key === col.key ? state.sort.dir : null;
          th.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none');
          var sortBtn = el('button', {
            class: 'c-table__sort',
            attrs: { type: 'button' },
            on: {
              click: function () {
                var nextDir = state.sort && state.sort.key === col.key && state.sort.dir === 'asc' ? 'desc' : 'asc';
                state.sort = { key: col.key, dir: nextDir };
                if (typeof options.onSort === 'function') {
                  options.onSort(col.key, nextDir);
                } else {
                  state.rows.sort(function (a, b) {
                    var av = typeof col.sortValue === 'function' ? col.sortValue(a) : a[col.key];
                    var bv = typeof col.sortValue === 'function' ? col.sortValue(b) : b[col.key];
                    var result = compareValues(av, bv);
                    return nextDir === 'desc' ? -result : result;
                  });
                }
                renderHead();
                renderBody();
              }
            }
          });
          sortBtn.appendChild(el('span', { text: col.label }));
          if (dir) { sortBtn.appendChild(svgIcon(dir === 'asc' ? 'chevron-up' : 'chevron-down', { size: 12 })); }
          th.appendChild(sortBtn);
        } else {
          th.textContent = col.label;
        }
        tr.appendChild(th);
      });
      thead.appendChild(tr);
    }

    function cellValue(col, row) {
      if (typeof col.render === 'function') {
        return col.render(row);
      }
      return row ? row[col.key] : '';
    }

    function renderBody() {
      clear(tbody);
      var colCount = columns.length + (selectable ? 1 : 0);
      if (state.loading) {
        for (var i = 0; i < 4; i += 1) {
          var loadingRow = el('tr', { class: 'c-table__loading' });
          var loadingCell = el('td', { attrs: { colspan: String(colCount) } });
          loadingCell.appendChild(skeleton({ variant: 'text', rows: 1 }));
          loadingRow.appendChild(loadingCell);
          tbody.appendChild(loadingRow);
        }
        return;
      }
      if (!state.rows.length) {
        var emptyRow = el('tr');
        var emptyCell = el('td', { class: 'c-table__empty-cell', attrs: { colspan: String(colCount) } });
        if (options.emptyNode instanceof Node) {
          emptyCell.appendChild(options.emptyNode);
        } else {
          emptyCell.appendChild(emptyState({ title: options.emptyTitle || 'Không có dữ liệu', description: options.emptyDescription || '', icon: options.emptyIcon || 'circle' }));
        }
        emptyRow.appendChild(emptyCell);
        tbody.appendChild(emptyRow);
        return;
      }
      state.rows.forEach(function (row, index) {
        var key = keyOf(row, index);
        var tr = el('tr', { attrs: { 'data-row-key': key } });
        if (state.selected.has(key)) { tr.classList.add('is-selected'); }
        if (selectable) {
          var tdCheck = el('td', { class: 'c-table__check' });
          var box = el('input', {
            attrs: { type: 'checkbox', 'aria-label': 'Chọn dòng ' + (index + 1) }
          });
          box.checked = state.selected.has(key);
          box.addEventListener('change', function () {
            if (box.checked) { state.selected.add(key); } else { state.selected.delete(key); }
            tr.classList.toggle('is-selected', box.checked);
            updateMaster();
            emitSelection();
          }, { signal: signal });
          tdCheck.appendChild(box);
          tr.appendChild(tdCheck);
        }
        columns.forEach(function (col) {
          var classes = 'c-cell';
          if (col.align === 'right') { classes += ' c-cell--right'; }
          if (col.align === 'center') { classes += ' c-cell--center'; }
          if (col.mono) { classes += ' c-cell--mono'; }
          if (col.wrap) { classes += ' c-cell--wrap'; }
          var td = el('td', { class: classes, attrs: { 'data-label': col.label } });
          var value = cellValue(col, row);
          if (value instanceof Node) {
            td.appendChild(value);
          } else if (value !== undefined && value !== null) {
            td.textContent = String(value);
          }
          tr.appendChild(td);
        });
        if (typeof options.onRowClick === 'function') {
          tr.addEventListener('click', function (ev) {
            var target = ev.target;
            if (target && target.closest && target.closest('button,a,input,select,textarea,label')) { return; }
            options.onRowClick(row);
          }, { signal: signal });
        }
        tbody.appendChild(tr);
      });
    }

    function updateMaster() {
      if (!selectable) { return; }
      var master = firstNode(thead, 'input[type="checkbox"]');
      if (!master) { return; }
      var total = state.rows.length;
      var selected = state.rows.filter(function (row, index) { return state.selected.has(keyOf(row, index)); }).length;
      master.checked = total > 0 && selected === total;
      master.indeterminate = selected > 0 && selected < total;
    }

    function refresh() {
      renderHead();
      renderBody();
      updateMaster();
    }

    refresh();

    return {
      el: wrap,
      update: function (next) {
        next = next || {};
        if (next.rows !== undefined) { state.rows = Array.isArray(next.rows) ? next.rows.slice() : []; }
        if (next.loading !== undefined) { state.loading = !!next.loading; }
        if (next.selectedKeys !== undefined) { state.selected = new Set((next.selectedKeys || []).map(String)); }
        if (next.sort !== undefined) { state.sort = next.sort; }
        refresh();
      },
      getSelection: function () {
        var keys = Array.from(state.selected);
        var rows = state.rows.filter(function (row, index) { return state.selected.has(keyOf(row, index)); });
        return { keys: keys, rows: rows };
      },
      destroy: function () {
        try { controller.abort(); } catch (err) { /* bỏ qua */ }
        clear(thead);
        clear(tbody);
      }
    };
  }

  /* =========================== UI: lớp phủ ============================ */

  var layerStack = [];

  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function isVisible(node) {
    return !!(node.offsetWidth || node.offsetHeight || (node.getClientRects && node.getClientRects().length));
  }

  function focusableIn(root) {
    return Array.prototype.slice.call(root.querySelectorAll(FOCUSABLE)).filter(isVisible);
  }

  function syncScrollLock() {
    if (layerStack.length > 0) {
      DOC.body.classList.add('c-no-scroll');
    } else {
      DOC.body.classList.remove('c-no-scroll');
    }
  }

  function onLayerKeydown(ev) {
    var top = layerStack[layerStack.length - 1];
    if (!top) { return; }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      top.requestClose();
      return;
    }
    if (ev.key !== 'Tab') { return; }
    var list = focusableIn(top.panel);
    if (!list.length) {
      ev.preventDefault();
      top.panel.focus();
      return;
    }
    var first = list[0];
    var last = list[list.length - 1];
    if (ev.shiftKey) {
      if (DOC.activeElement === first || !top.panel.contains(DOC.activeElement)) {
        ev.preventDefault();
        last.focus();
      }
    } else if (DOC.activeElement === last || !top.panel.contains(DOC.activeElement)) {
      ev.preventDefault();
      first.focus();
    }
  }

  DOC.addEventListener('keydown', onLayerKeydown, true);

  function openLayer(options, drawerMode) {
    options = options || {};
    var titleId = nextId('modal-title');
    var isDrawer = drawerMode === true || options.variant === 'drawer';
    var layer = el('div', { class: isDrawer ? 'c-drawer-layer' : 'c-modal-layer' });
    var panelClass = isDrawer ? 'c-drawer' : 'c-modal';
    if (!isDrawer && options.size && options.size !== 'md') { panelClass += ' c-modal--' + options.size; }
    if (isDrawer && options.wide) { panelClass += ' c-drawer--wide'; }
    var panel = el('div', {
      class: panelClass,
      attrs: {
        role: options.role || 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleId,
        tabindex: '-1'
      }
    });
    if (options.descriptionId) { panel.setAttribute('aria-describedby', String(options.descriptionId)); }

    var header = el('div', { class: isDrawer ? 'c-drawer__header' : 'c-modal__header' });
    var headingWrap = el('div');
    headingWrap.appendChild(el('h2', { class: 'c-modal__title', attrs: { id: titleId }, text: String(options.title || '') }));
    if (options.subtitle) { headingWrap.appendChild(el('p', { class: 'c-modal__subtitle', text: String(options.subtitle) })); }
    header.appendChild(headingWrap);

    var dismissible = !!options.dismissible;
    var closeBtn = null;
    if (dismissible) {
      closeBtn = iconButton({ icon: 'x', label: 'Đóng hộp thoại', size: 'sm' });
      header.appendChild(closeBtn);
    }
    panel.appendChild(header);

    var bodyClass = isDrawer ? 'c-drawer__body' : 'c-modal__body';
    var body = el('div', { class: bodyClass });
    if (options.body instanceof Node) {
      body.appendChild(options.body);
    } else if (options.body !== undefined && options.body !== null) {
      body.appendChild(el('p', { class: 'c-muted-block', text: String(options.body) }));
    }
    panel.appendChild(body);

    var footerButtons = [];
    var footer = null;
    if (options.footer) {
      footer = el('div', { class: isDrawer ? 'c-drawer__footer' : 'c-modal__footer' });
      var footerItems = Array.isArray(options.footer) ? options.footer : [options.footer];
      footerItems.forEach(function (item) {
        if (item instanceof Node) {
          footer.appendChild(item);
          if (item.tagName === 'BUTTON') { footerButtons.push({ node: item, wasDisabled: item.disabled }); }
        }
      });
      panel.appendChild(footer);
    }

    var errorNode = null;
    var opener = DOC.activeElement;

    function setBusy(busy) {
      if (busy) {
        panel.setAttribute('aria-busy', 'true');
      } else {
        panel.removeAttribute('aria-busy');
      }
      footerButtons.forEach(function (entry) {
        if (busy) { entry.node.disabled = true; } else { entry.node.disabled = entry.wasDisabled; }
      });
      if (closeBtn) { closeBtn.disabled = !!busy; }
    }

    function setError(message) {
      if (!message) {
        if (errorNode) { errorNode.hidden = true; errorNode.textContent = ''; }
        return;
      }
      if (!errorNode) {
        errorNode = el('div', { class: 'c-modal__error', attrs: { role: 'alert' } });
        panel.insertBefore(errorNode, body);
      }
      errorNode.hidden = false;
      errorNode.textContent = String(message);
    }

    var closed = false;
    var confirming = false;

    function close() {
      if (closed) { return; }
      closed = true;
      var idx = layerStack.indexOf(entry);
      if (idx !== -1) { layerStack.splice(idx, 1); }
      syncScrollLock();
      layer.remove();
      if (typeof options.onClose === 'function') {
        try { options.onClose(); } catch (err) { /* bỏ qua */ }
      }
      if (options.restoreFocus !== false && opener && opener.focus && DOC.contains(opener)) {
        try { opener.focus({ preventScroll: true }); } catch (err) { opener.focus(); }
      }
    }

    function requestClose() {
      if (!dismissible) { return; }
      if (typeof options.dirtyCheck === 'function') {
        var dirty = false;
        try { dirty = !!options.dirtyCheck(); } catch (err) { dirty = true; }
        if (dirty) {
          if (confirming) { return; }
          confirming = true;
          ui.confirm({
            title: 'Bỏ thay đổi?',
            message: 'Các thay đổi chưa lưu sẽ bị mất.',
            confirmLabel: 'Bỏ thay đổi',
            cancelLabel: 'Tiếp tục chỉnh sửa',
            variant: 'danger'
          }).then(function (ok) {
            confirming = false;
            if (ok) { close(); }
          });
          return;
        }
      }
      close();
    }

    if (closeBtn) { closeBtn.addEventListener('click', requestClose); }
    layer.addEventListener('click', function (ev) {
      if (ev.target === layer) { requestClose(); }
    });

    var entry = {
      el: layer,
      panel: panel,
      close: close,
      requestClose: requestClose,
      dismissible: dismissible
    };

    layer.appendChild(panel);
    var root = byId('modal-root') || DOC.body;
    root.appendChild(layer);
    layerStack.push(entry);
    syncScrollLock();

    var initial = options.initialFocus instanceof HTMLElement ? options.initialFocus : null;
    if (!initial) {
      var candidates = focusableIn(body);
      initial = candidates.length ? candidates[0] : panel;
    }
    try { initial.focus({ preventScroll: true }); } catch (err) { initial.focus(); }

    return {
      el: panel,
      layer: layer,
      body: body,
      close: close,
      requestClose: requestClose,
      setBusy: setBusy,
      setError: setError
    };
  }

  function confirmDialog(options) {
    options = options || {};
    return new Promise(function (resolve) {
      var settled = false;
      var body = el('div', { class: 'c-stack c-stack--sm' });
      if (options.message) {
        body.appendChild(el('p', { class: 'c-muted-block', text: String(options.message) }));
      }
      if (options.details) {
        if (options.details instanceof Node) {
          body.appendChild(options.details);
        } else {
          body.appendChild(el('p', { class: 'c-muted-block', text: String(options.details) }));
        }
      }
      var handle = null;
      var input = null;
      var confirmBtn = null;

      function finish(value) {
        if (settled) { return; }
        settled = true;
        if (handle) { handle.close(); }
        resolve(value);
      }

      var cancelBtn = buttonControl({
        label: options.cancelLabel || 'Huỷ',
        variant: 'secondary',
        onClick: function () { finish(false); }
      });

      if (options.requireText) {
        var requiredField = field({
          label: options.requireTextLabel || ('Gõ "' + options.requireText + '" để xác nhận'),
          type: 'text',
          autocomplete: 'off',
          mono: true
        });
        input = requiredField.input;
        body.appendChild(requiredField.el);
      }

      confirmBtn = buttonControl({
        label: options.confirmLabel || 'Xác nhận',
        variant: options.variant === 'danger' ? 'danger' : 'primary',
        disabled: !!options.requireText,
        onClick: function () { finish(true); }
      });

      handle = openLayer({
        title: options.title || 'Xác nhận thao tác',
        body: body,
        footer: [cancelBtn, confirmBtn],
        size: 'sm',
        dismissible: true,
        role: 'alertdialog',
        initialFocus: cancelBtn,
        onClose: function () {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        }
      }, false);

      if (input) {
        input.addEventListener('input', function () {
          confirmBtn.disabled = input.value.trim() !== String(options.requireText);
        });
      }
    });
  }

  function toast(message, options) {
    options = options || {};
    var type = ['success', 'error', 'warning', 'info'].indexOf(options.type) !== -1 ? options.type : 'info';
    if (!toastRoot) { toastRoot = byId('toast-root'); }
    if (!toastRoot) {
      return { close: function () {} };
    }
    var text = String(message === undefined || message === null ? '' : message);
    var dedupeKey = type + '|' + text;
    var now = Date.now();
    if (toastSeen[dedupeKey] && now - toastSeen[dedupeKey] < 2000) {
      return { close: function () {} };
    }
    toastSeen[dedupeKey] = now;

    while (toastRoot.children.length >= 3) {
      toastRoot.removeChild(toastRoot.firstChild);
    }

    var icons = { success: 'check-circle', error: 'alert-circle', warning: 'alert-triangle', info: 'info' };
    var node = el('div', {
      class: 'c-toast',
      attrs: { 'data-type': type, role: type === 'error' ? 'alert' : 'status' }
    });
    var icon = el('span', { class: 'c-toast__icon' });
    icon.appendChild(svgIcon(icons[type], { size: 17 }));
    node.appendChild(icon);
    node.appendChild(el('div', { class: 'c-toast__body', text: text }));

    var timer = null;
    function close() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (node.parentNode) { node.remove(); }
    }
    var closeBtn = iconButton({
      icon: 'x',
      label: 'Đóng thông báo',
      size: 'sm',
      onClick: close
    });
    closeBtn.classList.add('c-toast__close');
    node.appendChild(closeBtn);

    var duration = options.duration === 0 ? 0 : (Number(options.duration) || (type === 'error' ? 8000 : 4000));
    if (duration > 0) { timer = setTimeout(close, duration); }

    toastRoot.appendChild(node);
    return { close: close };
  }

  function copyText(value, options) {
    options = options || {};
    var text = String(value === undefined || value === null ? '' : value);
    var label = options.label ? ' ' + String(options.label) : '';

    function report(ok) {
      if (!options.silent) {
        toast(ok ? 'Đã sao chép' + label + '.' : 'Không sao chép được. Hãy chọn và sao chép thủ công.', {
          type: ok ? 'success' : 'error'
        });
      }
      return ok;
    }

    function fallback() {
      var area = el('textarea', { attrs: { readonly: '', 'aria-hidden': 'true' } });
      area.value = text;
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      DOC.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = DOC.execCommand('copy'); } catch (err) { ok = false; }
      area.remove();
      return report(ok);
    }

    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return report(true); }, function () { return fallback(); });
    }
    return Promise.resolve(fallback());
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = el('a', {
      attrs: { href: url, download: String(filename || 'cctv-download'), 'aria-hidden': 'true', tabindex: '-1' }
    });
    link.style.display = 'none';
    DOC.body.appendChild(link);
    link.click();
    setTimeout(function () {
      link.remove();
      URL.revokeObjectURL(url);
    }, 1500);
  }

  function isPrivateHost(hostname) {
    var host = String(hostname || '').toLowerCase();
    if (host === 'localhost') { return true; }
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) { return false; }
    var parts = host.split('.').map(Number);
    if (parts.some(function (n) { return n < 0 || n > 255; })) { return false; }
    if (parts[0] === 10 || parts[0] === 127) { return true; }
    if (parts[0] === 192 && parts[1] === 168) { return true; }
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) { return true; }
    if (parts[0] === 169 && parts[1] === 254) { return true; }
    return false;
  }

  function openExternal(url) {
    var parsed;
    try {
      parsed = new URL(String(url));
    } catch (err) {
      toast('Địa chỉ không hợp lệ.', { type: 'error' });
      return Promise.resolve(false);
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
      toast('Chỉ hỗ trợ địa chỉ HTTP/HTTPS của camera nội bộ.', { type: 'error' });
      return Promise.resolve(false);
    }
    if (!isPrivateHost(parsed.hostname)) {
      toast('Chỉ cho phép mở địa chỉ camera trong mạng nội bộ.', { type: 'error' });
      return Promise.resolve(false);
    }
    function launch() {
      /* Anchor được tạo trực tiếp sau khi URL đã qua validate private-IPv4 + http(s). */
      var link = DOC.createElement('a');
      link.href = parsed.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-hidden', 'true');
      link.tabIndex = -1;
      link.style.display = 'none';
      DOC.body.appendChild(link);
      link.click();
      setTimeout(function () { link.remove(); }, 0);
      return true;
    }
    if (window.location.protocol === 'https:' && parsed.protocol === 'http:') {
      return confirmDialog({
        title: 'Cảnh báo kết nối không an toàn',
        message: 'Trang đang chạy HTTPS nhưng camera dùng HTTP. Trình duyệt có thể chặn nội dung hỗn hợp khi mở Web GUI của camera.',
        confirmLabel: 'Vẫn mở',
        cancelLabel: 'Huỷ',
        variant: 'danger'
      }).then(function (ok) { return ok ? launch() : false; });
    }
    return Promise.resolve(launch());
  }

  function applyRole(root, role) {
    if (!root) { return root; }
    var nodes = root.querySelectorAll('[data-admin-only]');
    for (var i = 0; i < nodes.length; i += 1) {
      /* Ẩn thay vì xoá để có thể đăng nhập lại bằng vai trò khác trong cùng phiên trang. */
      nodes[i].hidden = role !== 'admin';
    }
    return root;
  }

  function setButtonBusy(btn, busy, label) {
    if (!btn) { return; }
    var labelNode = btn.querySelector('.c-btn__label');
    if (busy) {
      if (labelNode && !busyLabels.has(btn)) { busyLabels.set(btn, labelNode.textContent); }
      btn.setAttribute('aria-busy', 'true');
      btn.disabled = true;
      if (labelNode && label) { labelNode.textContent = String(label); }
    } else {
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
      if (labelNode && busyLabels.has(btn)) { labelNode.textContent = busyLabels.get(btn); }
    }
  }

  function debounce(fn, wait) {
    var timer = null;
    function wrapped() {
      var self = this;
      var args = arguments;
      if (timer) { clearTimeout(timer); }
      timer = setTimeout(function () {
        timer = null;
        if (typeof fn === 'function') { fn.apply(self, args); }
      }, Number(wait) > 0 ? Number(wait) : 180);
    }
    wrapped.cancel = function () {
      if (timer) { clearTimeout(timer); timer = null; }
    };
    wrapped.flush = function () {
      if (!timer) { return; }
      clearTimeout(timer);
      timer = null;
      if (typeof fn === 'function') { fn(); }
    };
    return wrapped;
  }

  var ui = {
    button: buttonControl,
    iconButton: iconButton,
    badge: badge,
    statusPill: statusPill,
    kpi: kpi,
    banner: banner,
    progress: progress,
    gauge: gauge,
    tabs: tabs,
    switch: switchControl,
    field: field,
    search: searchBox,
    toolbar: toolbar,
    pageHeader: pageHeader,
    pagination: pagination,
    skeleton: skeleton,
    empty: emptyState,
    errorPanel: errorPanel,
    table: table,
    modal: function (options) { return openLayer(options, false); },
    drawer: function (options) { return openLayer(options, true); },
    confirm: confirmDialog,
    toast: toast,
    copy: copyText,
    downloadBlob: downloadBlob,
    openExternal: openExternal,
    applyRole: applyRole,
    busy: setButtonBusy,
    debounce: debounce
  };

  CCTV.ui = ui;

  /* ================================ Media ============================== */

  var RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000];

  function mediaUrl(path, ip, subtype, channel) {
    return path + '?ip=' + encodeURIComponent(ip) +
      '&subtype=' + encodeURIComponent(String(subtype)) +
      '&channel=' + encodeURIComponent(String(channel));
  }

  var media = {
    mjpeg: function (img, options) {
      if (!(img instanceof HTMLImageElement)) {
        throw new Error('mjpeg yêu cầu thẻ img');
      }
      options = options || {};
      var ip = String(options.ip || '');
      var subtype = String(options.subtype) === '0' ? '0' : '1';
      var channel = options.channel === 2 ? 2 : 1;
      var stopped = false;
      var attempts = 0;
      var timer = null;
      var probing = null;
      var listenersBound = false;

      function notify(state, info) {
        if (stopped) { return; }
        if (typeof options.onState === 'function') {
          try { options.onState(state, info || {}); } catch (err) { /* bỏ qua */ }
        }
      }

      function buildSrc() {
        return mediaUrl('/api/stream/mjpeg', ip, subtype, channel) + '&_=' + Date.now();
      }

      function detach() {
        if (listenersBound) {
          img.removeEventListener('load', onLoad);
          img.removeEventListener('error', onError);
          listenersBound = false;
        }
      }

      function onLoad() {
        if (stopped) { return; }
        attempts = 0;
        notify('live');
      }

      function onError() {
        if (stopped) { return; }
        notify('error', { probing: true });
        probe();
      }

      function scheduleRetry() {
        if (stopped) { return; }
        if (attempts >= RETRY_DELAYS.length) {
          notify('error', { fatal: true, code: 'RETRY_EXHAUSTED' });
          return;
        }
        var delay = RETRY_DELAYS[attempts];
        attempts += 1;
        if (timer) { clearTimeout(timer); }
        timer = setTimeout(load, delay);
      }

      function probe() {
        if (stopped) { return; }
        if (probing) { try { probing.abort(); } catch (err) { /* bỏ qua */ } }
        probing = new AbortController();
        api.getBlob('/api/snapshot', {
          query: { ip: ip, subtype: '0', channel: channel },
          silent: true,
          signal: probing.signal,
          timeoutMs: 8000
        }).then(function () {
          probing = null;
          if (!stopped) { scheduleRetry(); }
        }).catch(function (err) {
          probing = null;
          if (stopped || !err || err.code === 'ABORTED') { return; }
          if (err.code === 'CAMERA_CREDENTIAL_REQUIRED') {
            notify('credential-required', { code: err.code, message: err.message });
            return;
          }
          if (err.code === 'FFMPEG_UNAVAILABLE') {
            notify('unavailable', { code: err.code, message: err.message });
            return;
          }
          if (err.code === 'FORBIDDEN' || err.code === 'CAMERA_NOT_FOUND' || err.code === 'UNAUTHENTICATED') {
            notify('error', { fatal: true, code: err.code, message: err.message });
            return;
          }
          if (err.code === 'TOO_MANY_STREAMS') {
            notify('error', { code: err.code, message: err.message, retry: true });
          }
          scheduleRetry();
        });
      }

      function load() {
        if (stopped) { return; }
        notify('connecting');
        img.src = buildSrc();
      }

      if (!listenersBound) {
        img.addEventListener('load', onLoad);
        img.addEventListener('error', onError);
        listenersBound = true;
      }
      load();

      return {
        stop: function () {
          stopped = true;
          detach();
          if (timer) { clearTimeout(timer); timer = null; }
          if (probing) { try { probing.abort(); } catch (err) { /* bỏ qua */ } probing = null; }
          img.removeAttribute('src');
        },
        restart: function () {
          if (stopped) { return; }
          attempts = 0;
          if (timer) { clearTimeout(timer); timer = null; }
          load();
        },
        setQuality: function (value) {
          subtype = String(value) === '0' ? '0' : '1';
          attempts = 0;
          load();
        },
        setChannel: function (value) {
          channel = value === 2 ? 2 : 1;
          attempts = 0;
          load();
        },
        getChannel: function () { return channel; },
        getQuality: function () { return subtype; }
      };
    },

    audio: function (options) {
      options = options || {};
      var ip = String(options.ip || '');
      var subtype = String(options.subtype) === '0' ? '0' : '1';
      var channel = options.channel === 2 ? 2 : 1;
      var audio = new Audio();
      audio.preload = 'none';
      return {
        el: audio,
        play: function () {
          audio.src = mediaUrl('/api/stream/audio', ip, subtype, channel) + '&_=' + Date.now();
          return audio.play().catch(function (err) {
            audio.removeAttribute('src');
            throw err;
          });
        },
        stop: function () {
          try {
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
          } catch (err) { /* bỏ qua */ }
        }
      };
    },

    snapshot: function (ip, options) {
      options = options || {};
      var subtype = String(options.subtype) === '1' ? '1' : '0';
      var channel = options.channel === 2 ? 2 : 1;
      return api.getBlob('/api/snapshot', {
        query: { ip: ip, subtype: subtype, channel: channel },
        timeoutMs: 20000,
        silent: !!options.silent,
        signal: options.signal
      }).then(function (result) {
        var filename = result.filename || ('snapshot_' + String(ip).replace(/\./g, '_') + '.jpg');
        var url = URL.createObjectURL(result.blob);
        if (options.download !== false) {
          downloadBlob(result.blob, filename);
        }
        return { blob: result.blob, url: url, filename: filename };
      });
    },

    probe: function (ip, options) {
      options = options || {};
      var channel = options.channel === 2 ? 2 : 1;
      var subtype = String(options.subtype) === '0' ? '0' : '1';
      return api.getBlob('/api/snapshot', {
        query: { ip: ip, subtype: subtype, channel: channel },
        silent: true,
        timeoutMs: 10000,
        signal: options.signal
      }).then(function (result) {
        var url = URL.createObjectURL(result.blob);
        return {
          status: 200,
          code: null,
          message: null,
          blob: result.blob,
          url: url,
          filename: result.filename || null
        };
      }).catch(function (err) {
        return {
          status: err && err.status ? err.status : 0,
          code: err && err.code ? err.code : 'NETWORK_ERROR',
          message: err && err.message ? err.message : 'Không kết nối được camera.',
          retryAfterSeconds: err && err.retryAfterSeconds ? err.retryAfterSeconds : null
        };
      });
    },

    revoke: function (url) {
      if (typeof url === 'string' && url.indexOf('blob:') === 0) {
        try { URL.revokeObjectURL(url); } catch (err) { /* bỏ qua */ }
      }
    }
  };

  CCTV.media = media;

  /* ================================ Boot =============================== */

  var refs = {};
  var backgroundStops = [];
  var stopRevalidation = null;
  var currentLoginRole = 'admin';
  var loginCountdownTimer = null;
  var deferredPrompt = null;
  var lanUrlCache = null;

  function collectRefs() {
    var list = [
      'login-screen', 'login-form', 'login-password', 'login-password-toggle', 'login-submit',
      'login-error', 'login-bootstrap', 'login-server', 'login-server-dot', 'login-server-text',
      'login-version', 'login-health-label', 'login-viewer-hint',
      'app-shell', 'sidebar', 'sidebar-backdrop', 'sidebar-toggle', 'sidebar-collapse',
      'main-nav', 'bottom-nav', 'topbar', 'view-root', 'view-title', 'view-breadcrumb',
      'topbar-health', 'topbar-health-dot', 'topbar-health-text', 'topbar-armed', 'topbar-armed-text',
      'user-menu-btn', 'user-menu', 'user-name', 'user-role', 'user-menu-title', 'user-menu-meta',
      'menu-settings', 'menu-pwa', 'menu-apk', 'menu-copy-lan', 'logout-btn',
      'sidebar-health-dot', 'sidebar-ffmpeg', 'sidebar-alarm-dot', 'sidebar-alarm', 'sidebar-version',
      'skip-link', 'modal-root', 'toast-root'
    ];
    list.forEach(function (id) { refs[id] = byId(id); });
    return refs;
  }

  function setLoginError(message) {
    if (!refs['login-error']) { return; }
    if (!message) {
      refs['login-error'].hidden = true;
      refs['login-error'].textContent = '';
      return;
    }
    refs['login-error'].hidden = false;
    refs['login-error'].textContent = String(message);
  }

  function setLoginBusy(busy, label) {
    var btn = refs['login-submit'];
    if (!btn) { return; }
    var labelNode = btn.querySelector('.c-btn__label');
    if (busy) {
      btn.setAttribute('aria-busy', 'true');
      btn.disabled = true;
      if (labelNode) { labelNode.textContent = label || 'Đang đăng nhập…'; }
    } else {
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
      if (labelNode) { labelNode.textContent = 'Đăng nhập'; }
    }
  }

  function setPasswordVisible(visible) {
    var input = refs['login-password'];
    var btn = refs['login-password-toggle'];
    if (!input || !btn) { return; }
    input.type = visible ? 'text' : 'password';
    btn.setAttribute('aria-label', visible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
    var use = btn.querySelector('use');
    if (use) {
      use.setAttribute('href', visible ? '#i-eye-off' : '#i-eye');
      use.setAttributeNS(XLINK_NS, 'xlink:href', visible ? '#i-eye-off' : '#i-eye');
    }
  }

  function selectLoginRole(role) {
    var buttons = DOC.querySelectorAll('[data-login-role]');
    for (var i = 0; i < buttons.length; i += 1) {
      var btn = buttons[i];
      var isTarget = btn.getAttribute('data-login-role') === role;
      btn.classList.toggle('is-active', isTarget);
      btn.setAttribute('aria-checked', isTarget ? 'true' : 'false');
      btn.setAttribute('tabindex', isTarget ? '0' : '-1');
    }
    currentLoginRole = role === 'viewer' ? 'viewer' : 'admin';
  }

  function syncLoginViewerAvailability() {
    var info = auth.info();
    var viewerBtn = DOC.querySelector('[data-login-role="viewer"]');
    var hint = refs['login-viewer-hint'];
    var disabled = info.loaded && info.viewerLoginEnabled === false;
    if (viewerBtn) {
      viewerBtn.disabled = !!disabled;
      viewerBtn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      if (disabled && currentLoginRole === 'viewer') { selectLoginRole('admin'); }
    }
    if (hint) { hint.hidden = !disabled; }
  }

  function applyHealth(data) {
    var health = data && typeof data === 'object' ? data : null;
    var ffmpegAvailable = !!(health && health.ffmpeg && health.ffmpeg.available);
    var ok = !!health && health.status !== 'degraded' && health.status !== 'error';
    var text = 'Đang kiểm tra';
    var dotClass = 'c-dot c-dot--muted';
    if (!health) {
      text = 'Không kết nối';
      dotClass = 'c-dot c-dot--danger';
    } else if (!ffmpegAvailable) {
      text = 'Thiếu FFmpeg';
      dotClass = 'c-dot c-dot--warning';
    } else if (ok) {
      text = 'Hệ thống ổn định';
      dotClass = 'c-dot c-dot--success';
    } else {
      text = 'Hệ thống suy giảm';
      dotClass = 'c-dot c-dot--warning';
    }

    if (refs['topbar-health-text']) { refs['topbar-health-text'].textContent = text; }
    if (refs['topbar-health-dot']) { refs['topbar-health-dot'].className = dotClass; }
    if (refs['sidebar-health-dot']) { refs['sidebar-health-dot'].className = dotClass; }
    if (refs['sidebar-ffmpeg']) {
      refs['sidebar-ffmpeg'].textContent = health
        ? (ffmpegAvailable ? 'FFmpeg: Sẵn sàng' + (health.ffmpeg.version ? ' ' + health.ffmpeg.version : '') : 'FFmpeg: Thiếu')
        : 'FFmpeg: không rõ';
    }
    if (refs['login-server-dot']) { refs['login-server-dot'].className = dotClass; }
    if (refs['login-server-text']) {
      if (!health) {
        refs['login-server-text'].textContent = 'Máy chủ chưa sẵn sàng';
      } else if (!ffmpegAvailable) {
        refs['login-server-text'].textContent = 'Máy chủ hoạt động · thiếu FFmpeg';
      } else {
        refs['login-server-text'].textContent = 'Máy chủ hoạt động' + (health.mode === 'test' ? ' · chế độ kiểm thử' : '');
      }
    }
    if (refs['login-health-label']) {
      refs['login-health-label'].textContent = health
        ? (ffmpegAvailable ? 'Sẵn sàng' : 'Thiếu FFmpeg')
        : 'Chưa kết nối';
    }
    if (health && health.app_version && refs['login-version']) {
      appMeta.appVersion = String(health.app_version);
      refs['login-version'].textContent = 'CCTV Vision Hub v' + appMeta.appVersion;
    }
    if (refs['sidebar-version']) {
      refs['sidebar-version'].textContent = 'CCTV v' + appMeta.appVersion;
    }
    if (refs['topbar-health']) {
      var titleParts = [];
      if (health) {
        titleParts.push('Trạng thái: ' + (health.status || 'ok'));
        titleParts.push('FFmpeg: ' + (ffmpegAvailable ? (health.ffmpeg.version || 'có') : 'thiếu'));
        if (health.uptime_seconds) { titleParts.push('Uptime: ' + fmt.duration(health.uptime_seconds)); }
      } else {
        titleParts.push('Không kết nối được máy chủ');
      }
      refs['topbar-health'].setAttribute('title', titleParts.join(' · '));
    }
  }

  function applyAlarmStatus(data) {
    var status = data && typeof data === 'object' ? data : null;
    var pill = refs['topbar-armed'];
    if (!pill) { return; }
    if (!status) {
      pill.hidden = true;
      return;
    }
    pill.hidden = false;
    var armed = !!status.armed;
    pill.setAttribute('data-status', armed ? 'armed' : 'disarmed');
    pill.setAttribute('aria-label', armed ? 'Đang gác an ninh. Mở màn cảnh báo' : 'Đã tắt gác an ninh. Mở màn cảnh báo');
    if (refs['topbar-armed-text']) {
      refs['topbar-armed-text'].textContent = armed ? 'ĐANG GÁC' : 'TẮT GÁC';
    }
    var dot = refs['sidebar-alarm-dot'];
    if (dot) { dot.className = armed ? 'c-dot c-dot--success' : 'c-dot c-dot--muted'; }
    if (refs['sidebar-alarm']) {
      refs['sidebar-alarm'].textContent = 'Gác: ' + (armed ? 'Bật' : 'Tắt') +
        (status.listeners_count !== undefined ? ' · ' + status.listeners_count + ' camera' : '');
    }
  }

  function applySystemStatus(data) {
    if (!data || typeof data !== 'object') { return; }
    if (data.net && data.net.lan_url) { lanUrlCache = String(data.net.lan_url); }
    else if (data.net && Array.isArray(data.net.lan_ips) && data.net.lan_ips.length) {
      lanUrlCache = window.location.protocol + '//' + data.net.lan_ips[0] + (window.location.port ? ':' + window.location.port : '');
    }
    if (data.app && data.app.version && refs['sidebar-version']) {
      appMeta.appVersion = String(data.app.version);
      refs['sidebar-version'].textContent = 'CCTV v' + appMeta.appVersion;
    }
  }

  function syncSessionChrome() {
    var s = auth.session();
    if (!s) { return; }
    var isAdmin = s.role === 'admin';
    var roleLabel = isAdmin ? 'Quản trị viên' : 'Người xem';
    if (refs['user-name']) { refs['user-name'].textContent = s.displayName || roleLabel; }
    if (refs['user-role']) { refs['user-role'].textContent = isAdmin ? 'admin' : 'viewer'; }
    if (refs['user-menu-title']) { refs['user-menu-title'].textContent = s.displayName || roleLabel; }
    if (refs['user-menu-meta']) {
      refs['user-menu-meta'].textContent = 'Vai trò: ' + roleLabel + (s.expiresAt ? ' · Hết hạn ' + fmt.dateTime(s.expiresAt) : '');
    }
    if (refs['menu-settings']) { refs['menu-settings'].hidden = !isAdmin; }
    if (refs['app-shell']) { applyRole(refs['app-shell'], s.role); }
    if (refs['login-version']) {
      refs['login-version'].textContent = 'CCTV Vision Hub v' + appMeta.appVersion;
    }
  }

  function showShell() {
    if (refs['login-screen']) { refs['login-screen'].hidden = true; }
    if (refs['app-shell']) { refs['app-shell'].hidden = false; }
    if (refs['skip-link']) { refs['skip-link'].setAttribute('href', '#view-root'); }
    DOC.body.classList.remove('is-login');
  }

  function hideShell() {
    if (refs['app-shell']) { refs['app-shell'].hidden = true; }
    closeMobileSidebar();
    closeUserMenu();
  }

  function showLogin(reason) {
    reason = reason || {};
    if (stopRevalidation) { stopRevalidation(); stopRevalidation = null; }
    stopBackgroundPolling();
    router.stop();
    try { state.reset(); } catch (err) { /* bỏ qua */ }
    hideShell();
    if (refs['login-screen']) { refs['login-screen'].hidden = false; }
    if (refs['skip-link']) { refs['skip-link'].setAttribute('href', '#login-form'); }
    DOC.body.classList.add('is-login');
    DOC.title = 'Đăng nhập · CCTV Vision Hub';
    setLoginBusy(false);
    setLoginError('');
    if (reason.message) {
      setLoginError(reason.message);
    } else if (reason.reason === 'expired') {
      setLoginError('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
    } else if (reason.reason === 'password-changed') {
      setLoginError('Mật khẩu đã thay đổi. Vui lòng đăng nhập lại.');
    }
    if (refs['login-bootstrap']) {
      refs['login-bootstrap'].hidden = !auth.info().firstRun;
    }
    syncLoginViewerAvailability();
    if (refs['login-password']) {
      refs['login-password'].value = '';
      try { refs['login-password'].focus(); } catch (err) { /* bỏ qua */ }
    }
    state.refresh('health').then(applyHealth).catch(function () { applyHealth(null); });
  }

  function enterApp() {
    showShell();
    syncSessionChrome();
    router.start();
    startBackgroundPolling();
    stopRevalidation = auth.startRevalidation(300000);
    state.refresh('health').then(applyHealth).catch(function () { applyHealth(null); });
    state.refresh('systemStatus').then(applySystemStatus).catch(function () { return null; });
    state.refresh('cameras').catch(function () { return null; });
    state.refresh('alarmStatus').then(applyAlarmStatus).catch(function () { return null; });
    if (refs['login-password']) { refs['login-password'].value = ''; }
  }

  function stopBackgroundPolling() {
    backgroundStops.forEach(function (stop) {
      try { stop(); } catch (err) { /* bỏ qua */ }
    });
    backgroundStops = [];
  }

  function startBackgroundPolling() {
    stopBackgroundPolling();
    backgroundStops.push(poll(function () {
      return state.refresh('health').then(applyHealth).catch(function () { return null; });
    }, { intervalMs: 60000, immediate: false, pauseWhenHidden: true }));
    backgroundStops.push(poll(function () {
      return state.refresh('alarmStatus').then(applyAlarmStatus).catch(function () { return null; });
    }, { intervalMs: 30000, immediate: false, pauseWhenHidden: true }));
    backgroundStops.push(poll(function () {
      return state.refresh('systemStatus').then(applySystemStatus).catch(function () { return null; });
    }, { intervalMs: 60000, immediate: false, pauseWhenHidden: true }));
  }

  function openHealthModal() {
    Promise.all([
      state.refresh('health').catch(function () { return null; }),
      state.refresh('systemStatus').catch(function () { return null; })
    ]).then(function (values) {
      var health = values[0];
      var status = values[1];
      var body = el('div', { class: 'c-stack' });
      var dl = el('dl', { class: 'c-kv' });
      function row(label, value) {
        dl.appendChild(el('dt', { text: label }));
        var dd = el('dd');
        if (value instanceof Node) { dd.appendChild(value); } else { dd.textContent = value === undefined || value === null || value === '' ? '—' : String(value); }
        dl.appendChild(dd);
      }
      row('Trạng thái', health ? (health.status === 'ok' ? 'Bình thường' : 'Suy giảm') : 'Không kết nối');
      row('Phiên bản', health && health.app_version ? 'v' + health.app_version : 'v' + appMeta.appVersion);
      row('FFmpeg', health && health.ffmpeg
        ? (health.ffmpeg.available ? 'Sẵn sàng' + (health.ffmpeg.version ? ' (' + health.ffmpeg.version + ')' : '') : 'Thiếu')
        : '—');
      row('Uptime', health && health.uptime_seconds ? fmt.duration(health.uptime_seconds) : '—');
      row('TLS', health ? (health.tls ? 'Đang bật HTTPS' : 'HTTP trong LAN') : '—');
      row('Chế độ', health && health.mode === 'test' ? 'Kiểm thử' : 'Vận hành');
      if (health && health.storage) {
        var rec = health.storage.recordings_writable !== false;
        var snap = health.storage.snapshots_writable !== false;
        row('Thư mục ghi', (rec && snap) ? 'Ghi được' : 'Có thư mục không ghi được');
      }
      if (status && status.runtime && status.runtime.python_version) {
        row('Python', status.runtime.python_version);
      }
      if (status && status.app && status.app.uptime_seconds !== undefined) {
        row('Máy chủ', 'uptime ' + fmt.duration(status.app.uptime_seconds));
      }
      body.appendChild(dl);
      if (status && Array.isArray(status.warnings) && status.warnings.length) {
        body.appendChild(el('h3', { text: 'Cảnh báo đang hoạt động' }));
        var list = el('div', { class: 'c-banner-list' });
        status.warnings.forEach(function (warning) {
          list.appendChild(banner({
            tone: warning.severity === 'critical' ? 'danger' : warning.severity === 'warning' ? 'warning' : 'info',
            title: warning.code || 'Cảnh báo',
            message: warning.message || ''
          }));
        });
        body.appendChild(list);
      }
      var handle = ui.modal({
        title: 'Trạng thái hệ thống',
        body: body,
        footer: [buttonControl({ label: 'Đóng', variant: 'secondary', onClick: function () { handle.close(); } })],
        size: 'md',
        dismissible: true
      });
    });
  }

  function openPwaModal() {
    var body = el('div', { class: 'c-stack' });
    body.appendChild(el('p', { class: 'c-muted-block', text: 'Cài CCTV Vision Hub như ứng dụng độc lập trên thiết bị của bạn.' }));
    var list = el('dl', { class: 'c-kv' });
    var entries = [
      ['Desktop (Chrome/Edge)', 'Mở menu trình duyệt → Cài đặt ứng dụng → Cài đặt.'],
      ['Android', 'Mở menu trình duyệt → Thêm vào màn hình chính.'],
      ['iOS Safari', 'Chia sẻ → Thêm vào màn hình chính.'],
      ['APK nội bộ', 'Dùng mục "Tải APK nội bộ" trong menu người dùng.']
    ];
    entries.forEach(function (entry) {
      list.appendChild(el('dt', { text: entry[0] }));
      list.appendChild(el('dd', { text: entry[1] }));
    });
    body.appendChild(list);
    var handle = ui.modal({
      title: 'Cài đặt ứng dụng',
      body: body,
      footer: [buttonControl({ label: 'Đóng', variant: 'secondary', onClick: function () { handle.close(); } })],
      size: 'sm',
      dismissible: true
    });
  }

  function promptInstall() {
    if (deferredPrompt) {
      var prompt = deferredPrompt;
      deferredPrompt = null;
      prompt.prompt();
      Promise.resolve(prompt.userChoice).then(function (choice) {
        if (choice && choice.outcome === 'accepted') {
          toast('Đã bắt đầu cài đặt ứng dụng.', { type: 'success' });
        }
      }).catch(function () { /* bỏ qua */ });
      return;
    }
    openPwaModal();
  }

  function downloadApk() {
    api.getBlob('/download/app.apk', { silent: true, timeoutMs: 60000 }).then(function (result) {
      downloadBlob(result.blob, 'CCTV-VisionHub-v2.apk');
    }).catch(function (err) {
      if (err && (err.code === 'APK_NOT_AVAILABLE' || err.status === 404)) {
        toast('APK v2 đang được cập nhật. Vui lòng dùng bản PWA.', { type: 'info' });
      } else {
        toast(err && err.message ? err.message : 'Không tải được APK.', { type: 'error' });
      }
    });
  }

  function copyLanUrl() {
    var url = lanUrlCache;
    if (!url) {
      var status = state.get('systemStatus');
      if (status && status.net && status.net.lan_url) { url = status.net.lan_url; }
    }
    if (!url) { url = window.location.origin; }
    copyText(url, { label: 'địa chỉ LAN' });
  }

  function closeUserMenu() {
    var menu = refs['user-menu'];
    var btn = refs['user-menu-btn'];
    if (menu) { menu.hidden = true; }
    if (btn) { btn.setAttribute('aria-expanded', 'false'); }
  }

  function toggleUserMenu() {
    var menu = refs['user-menu'];
    var btn = refs['user-menu-btn'];
    if (!menu || !btn) { return; }
    var open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && refs['user-menu-meta']) {
      var s = auth.session();
      if (s) {
        refs['user-menu-meta'].textContent = 'Vai trò: ' + (s.role === 'admin' ? 'Quản trị viên' : 'Người xem') +
          (s.expiresAt ? ' · Hết hạn ' + fmt.dateTime(s.expiresAt) : '');
      }
      var firstItem = firstNode(menu, '.c-menu__item:not([hidden])');
      if (firstItem) { firstItem.focus(); }
    }
  }

  function startLoginCountdown(seconds) {
    var remaining = Math.max(1, Number(seconds) || 60);
    if (loginCountdownTimer) { clearInterval(loginCountdownTimer); }
    function tick() {
      setLoginBusy(false);
      var btn = refs['login-submit'];
      var labelNode = btn ? btn.querySelector('.c-btn__label') : null;
      if (btn) { btn.disabled = true; }
      if (labelNode) { labelNode.textContent = 'Thử lại sau ' + remaining + ' giây'; }
      if (remaining <= 0) {
        clearInterval(loginCountdownTimer);
        loginCountdownTimer = null;
        setLoginBusy(false);
        return;
      }
      remaining -= 1;
    }
    tick();
    loginCountdownTimer = setInterval(tick, 1000);
  }

  function handleLoginSubmit(ev) {
    ev.preventDefault();
    if (refs['login-submit'] && refs['login-submit'].disabled) { return; }
    var password = refs['login-password'] ? refs['login-password'].value : '';
    setLoginError('');
    if (!password) {
      setLoginError('Vui lòng nhập mật khẩu.');
      if (refs['login-password']) { refs['login-password'].focus(); }
      return;
    }
    if (loginCountdownTimer) { clearInterval(loginCountdownTimer); loginCountdownTimer = null; }
    setLoginBusy(true);
    setPasswordVisible(false);
    auth.login(currentLoginRole, password).then(function () {
      setLoginBusy(false);
      if (refs['login-password']) { refs['login-password'].value = ''; }
      enterApp();
    }).catch(function (err) {
      setLoginBusy(false);
      if (err && err.status === 429) {
        startLoginCountdown(err.retryAfterSeconds || 60);
        setLoginError(err.message || 'Bạn đã thử quá nhiều lần. Vui lòng chờ.');
      } else if (err && err.code === 'VIEWER_LOGIN_DISABLED') {
        setLoginError('Tài khoản người xem chưa được bật. Liên hệ quản trị viên.');
        selectLoginRole('admin');
      } else {
        setLoginError(err && err.message ? err.message : 'Đăng nhập thất bại. Kiểm tra mật khẩu và kết nối máy chủ.');
      }
      if (refs['login-password']) {
        refs['login-password'].value = '';
        refs['login-password'].focus();
      }
    });
  }

  function bindLogin() {
    var roleButtons = DOC.querySelectorAll('[data-login-role]');
    function moveRole(ev, direction) {
      var enabled = [];
      for (var i = 0; i < roleButtons.length; i += 1) {
        if (!roleButtons[i].disabled) { enabled.push(roleButtons[i]); }
      }
      if (!enabled.length) { return; }
      var pos = enabled.indexOf(ev.currentTarget);
      var next = pos === -1 ? 0 : (pos + direction + enabled.length) % enabled.length;
      selectLoginRole(enabled[next].getAttribute('data-login-role'));
      enabled[next].focus();
      setLoginError('');
    }
    for (var i = 0; i < roleButtons.length; i += 1) {
      roleButtons[i].addEventListener('click', function (ev) {
        var btn = ev.currentTarget;
        if (btn.disabled) { return; }
        selectLoginRole(btn.getAttribute('data-login-role'));
        setLoginError('');
      });
      roleButtons[i].addEventListener('keydown', function (ev) {
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') {
          ev.preventDefault();
          moveRole(ev, 1);
        } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          moveRole(ev, -1);
        } else if (ev.key === 'Home' || ev.key === 'End') {
          ev.preventDefault();
          var enabled = [];
          for (var j = 0; j < roleButtons.length; j += 1) {
            if (!roleButtons[j].disabled) { enabled.push(roleButtons[j]); }
          }
          if (enabled.length) {
            var target = ev.key === 'Home' ? enabled[0] : enabled[enabled.length - 1];
            selectLoginRole(target.getAttribute('data-login-role'));
            target.focus();
          }
        }
      });
    }
    selectLoginRole(currentLoginRole);
    if (refs['login-password-toggle']) {
      refs['login-password-toggle'].addEventListener('click', function () {
        var input = refs['login-password'];
        setPasswordVisible(input ? input.type === 'password' : true);
      });
    }
    if (refs['login-form']) {
      refs['login-form'].addEventListener('submit', handleLoginSubmit);
    }
    if (refs['login-password']) {
      refs['login-password'].addEventListener('input', function () { setLoginError(''); });
    }
  }

  function bindShell() {
    if (refs['sidebar-toggle']) {
      refs['sidebar-toggle'].addEventListener('click', function () {
        var shell = refs['app-shell'];
        if (!shell) { return; }
        var open = !shell.classList.contains('is-sidebar-open');
        shell.classList.toggle('is-sidebar-open', open);
        if (refs['sidebar-backdrop']) { refs['sidebar-backdrop'].hidden = !open; }
        refs['sidebar-toggle'].setAttribute('aria-expanded', open ? 'true' : 'false');
        setMobileSidebarAccessible(open);
      });
    }
    if (window.matchMedia) {
      var sidebarMq = window.matchMedia('(max-width: 1023px)');
      var syncSidebar = function () {
        var shell = refs['app-shell'];
        setMobileSidebarAccessible(!!(shell && shell.classList.contains('is-sidebar-open')));
      };
      if (sidebarMq.addEventListener) { sidebarMq.addEventListener('change', syncSidebar); }
      else if (sidebarMq.addListener) { sidebarMq.addListener(syncSidebar); }
      syncSidebar();
    }
    if (refs['sidebar-backdrop']) {
      refs['sidebar-backdrop'].addEventListener('click', closeMobileSidebar);
    }
    if (refs['sidebar-collapse']) {
      refs['sidebar-collapse'].addEventListener('click', function () {
        var shell = refs['app-shell'];
        if (!shell) { return; }
        var collapsed = !shell.classList.contains('is-collapsed');
        shell.classList.toggle('is-collapsed', collapsed);
        state.setUi('sidebarCollapsed', collapsed);
        refs['sidebar-collapse'].setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        refs['sidebar-collapse'].setAttribute('aria-label', collapsed ? 'Mở rộng thanh điều hướng' : 'Thu gọn thanh điều hướng');
      });
    }
    if (refs['user-menu-btn']) {
      refs['user-menu-btn'].addEventListener('click', function (ev) {
        ev.stopPropagation();
        toggleUserMenu();
      });
    }
    DOC.addEventListener('click', function (ev) {
      var menu = refs['user-menu'];
      var btn = refs['user-menu-btn'];
      if (!menu || menu.hidden) { return; }
      if (menu.contains(ev.target) || (btn && btn.contains(ev.target))) { return; }
      closeUserMenu();
    });
    if (refs['user-menu']) {
      refs['user-menu'].addEventListener('keydown', function (ev) {
        var items = Array.prototype.slice.call(refs['user-menu'].querySelectorAll('.c-menu__item:not([hidden])'));
        var index = items.indexOf(DOC.activeElement);
        if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          items[(index + 1) % items.length].focus();
        } else if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          items[(index - 1 + items.length) % items.length].focus();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          closeUserMenu();
          if (refs['user-menu-btn']) { refs['user-menu-btn'].focus(); }
        }
      });
    }
    if (refs['menu-settings']) {
      refs['menu-settings'].addEventListener('click', function () {
        closeUserMenu();
        router.go('settings');
      });
    }
    if (refs['menu-pwa']) {
      refs['menu-pwa'].addEventListener('click', function () {
        closeUserMenu();
        promptInstall();
      });
    }
    if (refs['menu-apk']) {
      refs['menu-apk'].addEventListener('click', function () {
        closeUserMenu();
        downloadApk();
      });
    }
    if (refs['menu-copy-lan']) {
      refs['menu-copy-lan'].addEventListener('click', function () {
        closeUserMenu();
        copyLanUrl();
      });
    }
    if (refs['logout-btn']) {
      refs['logout-btn'].addEventListener('click', function () {
        closeUserMenu();
        auth.logout().then(function () {
          showLogin({ reason: 'logout' });
          toast('Đã đăng xuất.', { type: 'success' });
        });
      });
    }
    if (refs['topbar-armed']) {
      refs['topbar-armed'].addEventListener('click', function () {
        if (router.current() !== 'alarms') { router.go('alarms'); }
      });
    }
    if (refs['topbar-health']) {
      refs['topbar-health'].addEventListener('click', openHealthModal);
    }

    var collapsed = state.getUi('sidebarCollapsed', false);
    if (collapsed && refs['app-shell']) {
      refs['app-shell'].classList.add('is-collapsed');
      if (refs['sidebar-collapse']) {
        refs['sidebar-collapse'].setAttribute('aria-expanded', 'false');
        refs['sidebar-collapse'].setAttribute('aria-label', 'Mở rộng thanh điều hướng');
      }
    }

    DOC.addEventListener('keydown', function (ev) {
      if (ev.defaultPrevented) { return; }
      var target = ev.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
        return;
      }
      if (ev.altKey && !ev.ctrlKey && !ev.metaKey && /^[1-7]$/.test(ev.key)) {
        var routes = router.routes();
        var index = Number(ev.key) - 1;
        if (routes[index]) {
          ev.preventDefault();
          router.go(routes[index].name);
        }
        return;
      }
      if (ev.key === '/' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        var search = DOC.querySelector('[data-view-search]');
        if (search) {
          ev.preventDefault();
          search.focus();
          if (search.select) { search.select(); }
        }
        return;
      }
      if (ev.key === 'Escape') {
        closeUserMenu();
        closeMobileSidebar();
      }
    });

    window.addEventListener('beforeinstallprompt', function (ev) {
      ev.preventDefault();
      deferredPrompt = ev;
    });
    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      toast('Đã cài ứng dụng CCTV Vision Hub.', { type: 'success' });
    });

    window.addEventListener('online', function () {
      toast('Đã kết nối lại máy chủ.', { type: 'info', duration: 3000 });
      state.refresh('health').then(applyHealth).catch(function () { return null; });
    });
    window.addEventListener('offline', function () {
      toast('Mất kết nối mạng.', { type: 'warning', duration: 6000 });
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) { return; }
    var secure = window.isSecureContext || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (!secure) { return; }
    navigator.serviceWorker.register('/sw.js').then(function (registration) {
      if (registration && registration.update) {
        registration.update().catch(function () { /* bỏ qua */ });
      }
    }).catch(function () { /* PWA không bắt buộc */ });
  }

  function boot() {
    if (!collectRefs()['login-screen'] || !refs['app-shell']) { return; }
    DOC.body.classList.add('is-login');
    auth.purgeLegacyStorage();
    auth.setUnauthenticatedHandler(function (reason) {
      showLogin(reason || {});
    });
    auth.onChange(function (s) {
      state.set('session', s);
      if (s) { syncSessionChrome(); }
    });
    state.set('session', null);
    bindLogin();
    bindShell();
    registerServiceWorker();
    applyHealth(null);
    state.refresh('health').then(applyHealth).catch(function () { applyHealth(null); });

    auth.init().then(function (result) {
      syncLoginViewerAvailability();
      if (result.authenticated) {
        enterApp();
      } else {
        var message = '';
        if (result.error) {
          message = result.error.code === 'SETUP_REQUIRED'
            ? 'Hệ thống chưa được thiết lập mật khẩu quản trị. Kiểm tra cấu hình máy chủ.'
            : 'Không kết nối được máy chủ CCTV. Kiểm tra máy chủ và thử lại.';
        }
        showLogin({ message: message });
      }
    }).catch(function () {
      showLogin({ message: 'Không kết nối được máy chủ CCTV. Kiểm tra máy chủ và thử lại.' });
    });
  }

  if (DOC.readyState === 'complete') {
    boot();
  } else {
    DOC.addEventListener('DOMContentLoaded', boot, { once: true });
  }

  CCTV.boot = boot;
})();
