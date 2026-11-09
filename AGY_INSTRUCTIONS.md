# CCTV Vision Hub — Antigravity (AGY) Project Context & Instructions

## 1. Tổng quan

- **Tên:** CCTV Vision Hub 2.0.0 — quản lý, giám sát camera đa thương hiệu trong LAN.
- **Backend:** Python 3.11 + Bottle, chạy multi-thread; giữ nguyên framework.
- **Frontend:** SPA tự chứa, **vanilla JS + CSS thuần**. Không Tailwind, không Alpine,
  không Lucide CDN, không font/ảnh ngoài, không inline script/style.
- **Video:** FFmpeg (RTSP → MJPEG/audio/snapshot/recording) là gói hệ thống **bắt buộc**.
- **Giao thức:** Dahua DHDiscover/DVRIP, ONVIF WS-Discovery, Hikvision SADP, ARP,
  RTSP; quét unicast theo subnet/VLAN.
- **Mobile:** PWA (`static/manifest.json`, `static/sw.js`); APK v2 là artifact phát hành
  riêng, không nằm trong `static/`, không commit.

## 2. Cấu trúc thư mục và file chính

- `app.py` — route Bottle, validate input, gọi service; không chứa secret.
- `auth.py` — xác thực, phiên server-side, CSRF, rate limit, security headers,
  decorator `@public` / `@require_role`.
- Các module dịch vụ hiện có: `managed_manager.py`, `alarm_manager.py`,
  `telegram_service.py`, `scan_imou.py`, `onvif_manager.py`; `app.py` giữ RTSP URL
  builder, FFmpeg/media helper và route HTTP.
- `dahua/` — package vendored (pure stdlib), **bắt buộc** có trong PYTHONPATH,
  Docker image và ZIP phát hành.
- `templates/index.html` — login screen + app shell + sprite SVG; chỉ `<script src>`
  và `<link>` tới asset nội bộ.
- `static/css/app.css`, `static/css/views/*.css` — design system, dark theme.
- `static/js/core.js` — `CCTV.api/auth/state/ui/router/views/media/dom/fmt/poll/icons`,
  boot, error boundary, purge localStorage cũ, đăng ký Service Worker.
- `static/js/views/{dashboard,live,cameras,scanner,storage,alarms,settings}.js` —
  mỗi view đăng ký qua `CCTV.views.register(name, {title, icon, render, destroy})`.
- `settings.json`, `managed_cameras.json`, `recordings/`, `snapshots/`, `logs/`,
  `data/` — dữ liệu vận hành, **không commit, không đóng gói, không phục vụ static**.
- `package_windows.py` — đóng gói allowlist ra `dist/*.zip` + SHA-256.
- `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.gitignore` — triển khai an toàn.
- `tests/test_security.py`, `tests/verify_project.py`, `tests/ui_smoke.py` — kiểm thử
  không cần camera thật.

## 3. Bất biến bảo mật (không được phá)

1. **Default-deny:** mọi `/api/*` phải có `@public`, `@require_role("viewer")` hoặc
   `@require_role("admin")`. Chỉ public `/api/health`, `/api/auth/login`, `/api/auth/me`.
2. **Hai vai trò:** admin toàn quyền; viewer chỉ đọc. Mọi thao tác thay đổi trạng thái
   là admin. Server quyết định quyền; UI chỉ ẩn nút.
3. **Mật khẩu:** scrypt; không plaintext admin/viewer; migrate khi khởi động; không trả
   hash/mật khẩu qua API; đổi mật khẩu thu hồi toàn bộ session.
4. **Session:** server-side, TTL 12 giờ, cookie `HttpOnly` + `SameSite=Strict`
   (+ `Secure` khi HTTPS), logout thu hồi token.
5. **CSRF:** bắt buộc `X-CSRF-Token` cho mọi request thay đổi trạng thái; kiểm tra
   Origin/Host. Rate limit login (5 lần/5 phút/IP+username, trả 429 + Retry-After).
6. **Header/CSP:** `script-src 'self'`, không `unsafe-inline`, không `unsafe-eval`;
   không CDN; mọi dữ liệu động render bằng `textContent`.
7. **Không mật khẩu trong URL/localStorage/sessionStorage/DOM.** Media URL chỉ có
   `ip`, `subtype`, `channel`; server resolve credential.
8. **Không bí mật trong `static/`:** không `settings.json`, `managed_cameras.json`,
   log, ZIP, APK, `.env`, backup. `/static` chỉ phục vụ extension allowlist.
9. **Telegram TLS nghiêm ngặt:** không `CERT_NONE`, `check_hostname=False`,
   `verify=False`, `rejectUnauthorized:false`; hỗ trợ `CCTV_CA_BUNDLE`.
10. **FFmpeg:** kiểm tra lúc khởi động, trả trạng thái qua `/api/health`; thiếu FFmpeg
    → `degraded`, media trả lỗi có mã; semaphore/giới hạn tài nguyên.
11. **AlarmManager:** grace period sau khởi động; snapshot dùng URL đúng theo hãng;
    đọc canonical key `telegram_enabled`, `telegram_cooldown_seconds`,
    `telegram_ai_filter_human`.

## 4. Quy tắc UI

- 7 màn hình hash: `#/dashboard`, `#/live`, `#/cameras`, `#/scanner`, `#/storage`,
  `#/alarms`, `#/settings`; login là trạng thái riêng, không phải route hash.
- Không deep-link debug, không query tự bật admin, không dữ liệu giả/fake device/MAC,
  không phím tắt bí mật, không mật khẩu mặc định trong text hướng dẫn.
- Không hiển thị nút admin cho viewer; không render mật khẩu.
- Icon SVG inline (sprite), không emoji trong chrome; font hệ thống; responsive
  360px → 1920px; accessibility (focus trap, Escape, ARIA, contrast).
- View agent chỉ sửa file view của mình; foundation sở hữu shell/CSS/core.

## 5. Cấu hình và vận hành

- `settings.json`: cấu hình vận hành + hash admin/viewer; secret write-only.
- `managed_cameras.json`: danh sách camera + mật khẩu camera (nhạy cảm).
- Ưu tiên `CCTV_SETTINGS_FILE`, `CCTV_MANAGED_FILE`, `CCTV_RECORDINGS_DIR`,
  `CCTV_SNAPSHOTS_DIR`, `CCTV_SECRETS_FILE`, `CCTV_HOST`, `CCTV_PORT` khi triển khai.
- Không gọi API camera/Telegram thật khi phát triển; dùng test mode:

```text
CCTV_TEST_MODE=1
CCTV_DISABLE_ALARMS=1
CCTV_DISABLE_FFMPEG=1
CCTV_SETTINGS_FILE=<temp>/settings.json
CCTV_MANAGED_FILE=<temp>/managed_cameras.json
CCTV_HOST=127.0.0.1
CCTV_PORT=18080
CCTV_ADMIN_PASSWORD=<mật-khẩu-test-mạnh>
```

- Không chạy production ở `0.0.0.0:8080` trong lúc kiểm thử.
- Không sửa `settings.json` / `managed_cameras.json` thật trong quá trình dev/test.

## 6. Đóng gói và phát hành

- `python package_windows.py` → `dist/CCTVVisionHub_Windows_2.0.0.zip` + `.sha256`.
- ZIP chỉ chứa allowlist: mã nguồn chạy, `templates/`, `static/css|js|icons`,
  `dahua/`, tài liệu phát hành, script Windows, file cấu hình mẫu.
- Không đưa `settings.json`, `managed_cameras.json`, `docs/`, `tests/`, `android/`,
  `scripts/`, `python_env/`, log, ZIP, APK, backup vào ZIP/image.
- Không copy ZIP/APK vào `static/`; không in link tải công khai.
- Docker: non-root uid 10001, `read_only`, `cap_drop: ALL`, healthcheck `/api/health`;
  secret mount qua `CCTV_SECRETS_FILE`. Docker bridge không quét được multicast/broadcast
  LAN; muốn quét VLAN hãy chạy trực tiếp trên host.

## 7. Kiểm thử trước bàn giao

```bash
python -m py_compile app.py auth.py
python -m unittest discover -s tests -v
python tests/verify_project.py
python tests/ui_smoke.py
node --check static/js/core.js
```

- `test_security.py`: ma trận quyền, CSRF, rate limit, cookie, headers, login/session.
- `verify_project.py`: invariant tĩnh — không CDN/inline script, không secret trong
  static/ZIP, không deep-link debug, không password trong URL/localStorage, packaging an toàn.
- `ui_smoke.py`: HTTP flow ở cổng 18080, không cần camera thật.
- Không báo “đã chạy” nếu chưa thực sự chạy; ghi rõ phần chưa kiểm thử.

## 8. Tài liệu tham chiếu

- `docs/UI_REBUILD_SPEC.md` — hợp đồng API/UI/security chi tiết (tài liệu nội bộ).
- `docs/SECURITY.md` — threat model, hardening, rotation, báo lỗi bảo mật.
- `README.md`, `HUONG_DAN_SU_DUNG_WINDOWS.txt` — hướng dẫn triển khai/vận hành.
