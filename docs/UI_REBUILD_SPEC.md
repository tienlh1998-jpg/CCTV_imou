# ĐẶC TẢ TRIỂN KHAI — CCTV VISION HUB v2.0

**Tên tài liệu:** Đặc tả triển khai lại giao diện, hợp đồng API và hardening bảo mật
**Phiên bản:** 2.0.0 (baseline triển khai)
**Ngày:** 2026-11-05
**Chủ sở hữu:** Kiến trúc sư sản phẩm kiêm Security Lead
**Trạng thái:** Đã chốt để 3 nhóm triển khai song song
**Đường dẫn chuẩn:** `CCTVVisionHub/docs/UI_REBUILD_SPEC.md`

> Tài liệu này là **hợp đồng thi công**. Khi có mâu thuẫn giữa mã nguồn cũ và tài liệu này, tài liệu này thắng.
> Mọi thay đổi hợp đồng phải được cập nhật vào đây trước khi sửa mã. Không agent nào được tự ý đổi shape API, tên route, tên file hoặc quyền sở hữu file.

---

## 0. TÓM TẮT ĐIỀU HÀNH VÀ CÁC QUYẾT ĐỊNH KHÓA

### 0.1 Baseline đã kiểm chứng trong phiên này

Các số liệu dưới đây được xác minh bằng cách đọc trực tiếp mã nguồn và chạy lệnh read-only, không sửa file, không gọi camera/Telegram:

| Hạng mục | Bằng chứng |
|---|---|
| 51 route, trong đó 45 route `/api` | `findstr /n /c:"@route" app.py` trả 51 dòng, từ `app.py:247` đến `app.py:1606` |
| Phần lớn route API không có xác thực; `is_admin(` xuất hiện 10 lần = 1 định nghĩa + 9 route (932, 944, 1185, 1226, 1246, 1521, 1530, 1551, 1565); 2 route chỉ che một phần (settings GET, managed GET) | `findstr /n /c:"is_admin(" app.py`; AST xác nhận 51 route. Theo audit được cung cấp, probe in-process cho `GET /api/settings` không cookie → 200; `GET /api/managed/cameras` → 200; `POST /api/alarm/clear_history` → 200 |
| `settings.json` có 4 khóa bí mật/plaintext: `admin_password`, `default_password`, `telegram_bot_token`, `telegram_chat_id` | Đọc key bằng `python_env/tools/python.exe -c "json.load(...).keys()"`, không in giá trị |
| `managed_cameras.json` có trường `password` trên 7/7 bản ghi | Theo audit được cung cấp; kiểm tra key bản ghi đầu có `password`, không in giá trị |
| UI cũ dài 6.845 dòng, không có màn đăng nhập, không có 7 màn hình | `find /c /v "" templates\index.html` → 6845 |
| Có CDN Tailwind/Lucide/Alpine và ảnh Unsplash, inline script | `templates/index.html:20-58`, `:1053` |
| Có thiết bị giả, MAC giả, mật khẩu giả trong deep-link debug | `templates/index.html:4523-4618`; thêm dữ liệu giả trong scanner tại `scan_imou.py:247-319` |
| Có hardcode tài khoản router Ruijie và tắt xác thực TLS | `scan_imou.py:176`, `:143`, `:156`; `telegram_service.py:27` |
| Không có thư mục `tests/`, không có `.dockerignore`, không có `.gitignore` | `dir /b tests` → không tồn tại; `dir /b .dockerignore` → không tồn tại |
| FFmpeg không có trong PATH trên máy hiện tại | `where ffmpeg` → `INFO: Could not find files for the given pattern(s).` |
| Python test sẵn có | `python_env\tools\python.exe --version` → Python 3.11.9; Node `v24.21.0` |
| Bottle dùng được cho test in-process | `bottle.default_app()` là `bottle.Bottle`, callable, có `.wsgi` |
| `dahua/` là package vendored bắt buộc | `dir /s dahua` → 11 file `.py`; `alarm_manager.py:26` import `from dahua.events import EventListener`; `onvif_manager.py` import `from dahua import DahuaClient`; không có trong `requirements.txt` |
| Build APK cũ hardcode keystore/storepass/keypass và tải tool từ Internet | `scripts/build_apk.sh:124-125,151-152` (mật khẩu hardcode), `:42,53,61` (curl aapt2/r8/android.jar), `:159,164` copy vào `static/`; `build_windows.py:48` `--add-data=static` |
| `settings.json` admin password trùng bộ backdoor | Kiểm tra boolean `v in ('1998','Admin@1998')` → `True`, độ dài 10; không in giá trị |
| `managed_cameras.json` chứa giá trị trùng bộ fake device cũ | Boolean check theo IP/MAC/serial mẫu → cả ba `True`; không in giá trị; file dữ liệu thật phải được miễn trừ khỏi static scan |

**Kết luận baseline:** không thể chỉ làm lại UI. Toàn bộ vi phạm backend trong audit vẫn tồn tại nếu giữ nguyên `app.py`; vì vậy đặc tả này gồm cả backend hardening và hợp đồng API mới.

### 0.2 Các quyết định kiến trúc bắt buộc (ADR)

| ID | Quyết định | Lý do | Hệ quả |
|---|---|---|---|
| ADR-01 | Frontend dùng **vanilla JS classic script** (IIFE, `window.CCTV`), không ES module, không Alpine/Tailwind/Lucide | CSP `script-src 'self'` không cần `unsafe-inline`; `node --check` kiểm tra được từng file; không cần bundler | Mỗi file view là một IIFE; thứ tự `<script defer>` trong `index.html` do Foundation quy định |
| ADR-02 | Xác thực bằng **cookie session server-side + CSRF synchronizer token**; không trả session token trong JSON, không nhận `X-Admin-Token` | Loại bỏ token trong JSON/localStorage, chống XSS đánh cắp token; cookie `HttpOnly` | Client chỉ giữ CSRF token trong bộ nhớ; reload lấy lại qua `/api/auth/me` |
| ADR-03 | **Mật khẩu camera chỉ tồn tại phía server**. Client không gửi mật khẩu cho media/PTZ/record/detail; chỉ batch admin có fallback write-only trong body. Camera chưa lưu được cấp credential tạm trong session | Không còn `?password=` trong URL, không localStorage, không DOM | Admin nhập mật khẩu một lần qua `POST /api/cameras/credentials`; viewer chỉ xem camera đã lưu |
| ADR-04 | **Default-deny** ở server: mọi hàm route phải có `@public`, `@require_role("viewer")` hoặc `@require_role("admin")`; hook chặn mọi `/api/*` không thuộc allowlist công khai | Tránh route mới quên auth; kiểm tra tĩnh bằng AST | `verify_project.py` fail nếu có `@route` thiếu decorator phân quyền |
| ADR-05 | **Xóa hoàn toàn `/api/admin/*`**, thay bằng `/api/auth/*`; không giữ alias tương thích | Yêu cầu bắt buộc; alias cũ sẽ giữ lỗ hổng/backdoor | APK/PWA cũ không dùng được; phải phát hành APK v2 (xem §13.5) |
| ADR-06 | Tách backend thành `security.py`, `settings_store.py`, `credentials.py`, `camera_urls.py`, `camera_media.py` | Route mỏng, dễ test, tránh lặp logic password/RTSP/FFmpeg | `app.py` chỉ còn route + validate + gọi service |
| ADR-07 | **Test mode chặn toàn bộ hoạt động ra ngoài** (camera, Telegram, mở trình phát, mở thư mục); scan dùng fixture; media/PTZ/hardware success path dùng **fake camera backend** chỉ nạp khi `CCTV_TEST_FAKE_CAMERA=1` | Không thể vô tình gọi thiết bị thật khi test; vẫn test được success path | Fake backend chỉ phục vụ dải `10.255.255.0/24`, dùng file fixture JPEG/MP4/MP3; không phải dữ liệu sản phẩm |
| ADR-08 | APK cũ bị loại khỏi `/static`/`/download` và khỏi gói phát hành; APK v2 là **release blocker**, owner A — Release, build offline, `/download/app.apk` chỉ phục vụ APK v2 | APK cũ hardcode IP, cleartext, `allowBackup=true`, dùng `/api/admin/*` đã xóa; build script cũ hardcode keystore và tải tool từ Internet | Không release nếu APK v2 chưa build/verify; UI dev không chặn |
| ADR-09 | **Không mã hóa at-rest mật khẩu camera trong đợt này**; thay bằng ACL, write-only API, không log, không trả qua API; hỗ trợ `CCTV_SECRETS_FILE` | Không thêm dependency crypto; tránh tự viết crypto | Residual risk được ghi rõ §8.13; khuyến nghị BitLocker/ACL/secret volume |
| ADR-10 | scrypt cho admin/viewer, TTL session tuyệt đối 12 giờ, rate limit đăng nhập 5 lần/5 phút/IP+username | Yêu cầu bắt buộc | Không “remember me”; hết hạn phải đăng nhập lại |
| ADR-11 | Media (`<img>` MJPEG, `<audio>`) xác thực bằng cookie session; URL chỉ có `ip`, `subtype`, `channel` | `<img>` không gửi được header tùy biến; cookie `SameSite=Strict` vẫn gửi cho same-site | Không cần stream ticket; giảm phức tạp; server tự resolve credential |
| ADR-12 | Dùng **test ID** `data-testid` cố định trên phần tử quan trọng | Cho phép browser test/manual QA ổn định | View agent phải giữ đúng test ID trong bảng §2.9 |

### 0.3 Xung đột đã biết và cách xử lý

1. **APK cũ vs API mới:** `/api/admin/login` bị xóa nên APK cũ không thể đăng nhập. Không giữ alias. Phát hành APK v2; trong thời gian chờ, `/download/app.apk` trả 404 `APK_NOT_AVAILABLE` và UI hiển thị thông báo “APK đang được cập nhật”, không phát hành APK cũ.
2. **PWA cũ vs service worker cũ:** SW cũ cache `/` và UI cũ. SW v2 không cache `/`, dùng network-only cho navigation, tăng version cache và gọi `skipWaiting`/`clients.claim`; server gửi `Clear-Site-Data` khi logout/đổi mật khẩu; core.js purge legacy localStorage.
3. **Khóa Telegram trùng:** `settings.json` hiện có cả `telegram_cooldown` và `telegram_cooldown_seconds`, cả `telegram_human_only` và `telegram_ai_filter_human`. Chốt canonical là `telegram_cooldown_seconds` và `telegram_ai_filter_human`; alias cũ được migrate và bị bỏ khỏi file sau backup (§13.1).
4. **`telegram_enabled` thiếu trong `DEFAULT_SETTINGS`:** thêm canonical `telegram_enabled: false`; AlarmManager đọc đúng khóa.
5. **`auto_reboot_on_ip_change` vs body `auto_reboot`:** settings là giá trị mặc định; body batch-ip có thể override; không tự ý đổi `default_password` toàn cục sau batch.
6. **`scan_imou.py` chứa dữ liệu giả và credential router:** phải xóa trước khi làm bất kỳ việc gì khác (§10.2), vì đây là lỗ hổng nghiêm trọng và là “demo data” trái yêu cầu.
7. **FFmpeg không có trên máy hiện tại:** đây là trạng thái hợp lệ; UI và API phải degrade đúng, không được giả định có FFmpeg.

### 0.4 Truy vết audit → biện pháp

| Nhóm phát hiện audit | Mức | Biện pháp trong đặc tả |
|---|---|---|
| Phần lớn route API không auth (chỉ 9 route gọi `is_admin`, 2 route che một phần) | High | §7 role matrix, §8.1 default-deny, §11 test ma trận quyền |
| Backdoor PIN 1998/Admin@1998, so sánh plaintext, min 4 ký tự | High | §8.2 scrypt, bỏ fallback, min 10, §10.2 remove |
| Session không TTL, cookie thiếu HttpOnly/SameSite/Secure, token trong JSON | High | §8.3–8.5, cookie flags, no token JSON |
| Không CSRF/Origin/Host | High | §8.5, `X-CSRF-Token`, Origin/Host allowlist |
| Không rate limit login | High | §8.6, 429 + Retry-After |
| Secret plaintext trong settings/managed/ZIP công khai | High | §8.10 migration, §9.5 write-only, §10.2 xóa ZIP, §13.1–13.2 |
| `/api/managed/cameras/sync` trả password | High | §6.4 sanitized object, test no `password` key |
| `/api/batch_change_password` trả `new_password` | High | §6.7 response mới không có password |
| `GET /api/settings` lộ chat_id/paths | High | §6.3 **admin-only** + không trả secret |
| `POST /api/settings` merge tùy ý | High | §6.3 whitelist, từ chối secret keys |
| Password camera trong query/localStorage/DOM | High | §8.12, §9.4, media cookie auth |
| CDN + inline script, không CSP | High | §9.1–9.3, self-host asset, CSP nghiêm |
| Deep-link tự bật admin, fake devices | High | §10.2 remove, router không đọc query param |
| Static ZIP chứa secrets | High | §9.6, §13.6, xóa file |
| Snapshot/recording không auth | Medium | §6.6 viewer auth, path validation |
| Telegram `CERT_NONE` | High | §12.1/§8.13, TLS strict + `CCTV_CA_BUNDLE` |
| FFmpeg spawn vô hạn | High | §12.3 semaphore, max duration, 503 |
| Scan CIDR /0 cạn RAM | High | §6.5 cap host, private-only |
| SSRF camera test/stream | High | §6.4/§6.6 private IPv4 validation |
| CSV injection | Medium | §6.5 sanitize công thức |
| Docker COPY secrets, root, host network | High | §12.4, §13.6 |
| Alarm hardcode Dahua URL, không grace | Medium | §6.8, §8.13, grace 120s |
| Khóa settings lệch | Medium | §13.1 canonical |
| Router Ruijie hardcode credential, `rejectUnauthorized:false` | High | §10.2 remove toàn bộ nhánh |
| Log cũ lộ IP/stack trace | Medium | §10.2 xóa, §9.8 redaction |

---

## 1. MỤC TIÊU, PHẠM VI, KHÔNG PHẠM VI, GIẢ ĐỊNH

### 1.1 Mục tiêu

1. Làm lại toàn bộ giao diện thành **7 màn hình NOC/SOC chuyên nghiệp**, tiếng Việt, dark theme, mật độ thông tin cao, responsive desktop/tablet/mobile.
2. **Tự chứa hoàn toàn**: không CDN, không font ngoài, không ảnh ngoài, không Tailwind/Alpine/Lucide, không inline script, tương thích CSP `script-src 'self'`.
3. Giữ **đầy đủ tính năng thật** đang có (feature parity), đồng thời loại bỏ demo, dữ liệu giả, deep-link debug, code chết và backdoor.
4. Hardening backend: mọi API có xác thực, phân quyền admin/viewer, CSRF, rate limit, session an toàn, scrypt, security headers, không lộ bí mật qua file tĩnh/URL/localStorage/DOM.
5. Dọn dẹp đóng gói: không đưa `settings.json`, `managed_cameras.json`, log, ZIP chứa secret vào ZIP phát hành hoặc Docker image.
6. Có bộ kiểm thử tự động chạy được **không cần camera thật**, và kiểm toán tĩnh trước bàn giao.

### 1.2 Trong phạm vi

- Viết lại `templates/index.html`, thêm `static/css/app.css`, `static/css/views/*.css`, `static/js/core.js`, `static/js/views/*.js`.
- Sửa `app.py` và tách module bảo mật/dịch vụ như §5.
- Sửa `managed_manager.py`, `alarm_manager.py`, `telegram_service.py`, `scan_imou.py`, `onvif_manager.py`, `cctv_tray.py` ở phạm vi cần thiết; giữ và đóng gói vendored `dahua/`.
- Sửa build/release: `android/`, `scripts/build_apk.sh`, `build_windows.py`, `build_exe.bat`, artifact APK v2.
- Thêm `tests/test_security.py`, `tests/verify_project.py`, `tests/ui_smoke.py`, fixture test.
- Sửa `Dockerfile`, `docker-compose.yml`, `package_windows.py`, `static/sw.js`, `static/manifest.json`; thêm `.dockerignore`, `.gitignore`.
- Xóa file/đoạn mã theo §10.2.
- Cập nhật tài liệu hướng dẫn đang chứa PIN/IP nội bộ.

### 1.3 Không phạm vi

- Không đổi framework (giữ Bottle, Python 3.11, wsgiref/ThreadedServer).
- Không viết lại giao thức Dahua/ONVIF/SADP; chỉ sửa lỗi bảo mật và dữ liệu giả trong các module hiện có.
- Không xây dựng hệ thống phân quyền chi tiết hơn 2 vai trò admin/viewer.
- Không mã hóa at-rest mật khẩu camera bằng crypto tự viết; xem ADR-09 và §8.13.
- APK v2 thuộc **release track của Agent A — Release** (P6), không chặn phát triển UI nhưng là release blocker; xem §13.5.
- Không thiết lập TLS/reverse proxy tự động; hỗ trợ cấu hình TLS tùy chọn và cảnh báo khi chạy HTTP (§12.2).
- Không thêm dependency Python/JS mới nếu không thật cần. Không dùng CDN.

### 1.4 Giả định

1. `BRIEF` không tồn tại dưới dạng file riêng trong dự án; đặc tả này đối chiếu theo yêu cầu trong đề bài và kết quả audit.
2. Người dùng cuối truy cập trong LAN, trình duyệt hiện đại (Chrome/Edge/Firefox/Safari bản hỗ trợ 2023+), có JavaScript.
3. Server chạy trên Windows là chính; Linux/Docker vẫn phải chạy được.
4. `settings.json` và `managed_cameras.json` thật **không được sửa trong quá trình phát triển/test**. Mọi test dùng file tạm.
5. Không có nhu cầu đa người dùng đồng thời quy mô lớn: tối đa ~500 session, ~200 camera, ~9 stream đồng thời/phiên.
6. Camera có thể offline, sai mật khẩu, hoặc ngủ năng lượng mặt trời; UI phải hiển thị trạng thái thay vì giả định online.
7. FFmpeg có thể không có trên máy chạy (đã xác nhận trên máy hiện tại); đây là trạng thái phải xử lý, không phải lỗi test.
8. Thời gian hiển thị theo `Asia/Ho_Chi_Minh` (GMT+7); server dùng giờ hệ điều hành đã cấu hình.

### 1.5 Nguyên tắc thi công

1. **Server là nguồn quyết định quyền.** UI chỉ ẩn nút; mọi hành động phải được server kiểm tra lại.
2. **Fail closed.** Thiếu cấu hình bảo mật, hash hỏng, không xác định được quyền → từ chối, không fallback về mặc định yếu.
3. **Không bí mật ở phía client.** Không mật khẩu, token, hash, chat ID, session token trong DOM/localStorage/sessionStorage/URL/log.
4. **Hợp đồng trước, code sau.** View agent không tự thêm endpoint; mọi nhu cầu dữ liệu phải có trong §6.
5. **Không dữ liệu giả trong sản phẩm.** Fixture chỉ được nằm trong `tests/fixtures/` và chỉ nạp khi `CCTV_TEST_MODE=1`.
6. **Mọi hành động nguy hiểm phải xác nhận rõ ràng**, ưu tiên xác nhận bằng cách gõ từ khóa.
7. **Không phá dữ liệu thật.** Migration phải backup và atomic; test không trỏ vào file thật.
8. **Đo lường được.** Mỗi yêu cầu trong §14 phải có cách kiểm chứng (test tự động, lệnh, hoặc checklist thủ công ghi rõ).

---

## 2. INFORMATION ARCHITECTURE

### 2.1 Sơ đồ tổng thể

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ LOGIN SCREEN (không có shell, không có dữ liệu camera)                        │
│  Logo / phiên bản / trạng thái server / form admin-viewer / lỗi 401-429       │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ đăng nhập thành công (cookie + CSRF)
┌───────────────────────────────▼──────────────────────────────────────────────┐
│ APP SHELL                                                                     │
│ ┌──────────┬───────────────────────────────────────────────────────────────┐ │
│ │ SIDEBAR  │ TOPBAR: tiêu đề màn / health / armed / user menu / PWA        │ │
│ │ 248/72px ├───────────────────────────────────────────────────────────────┤ │
│ │          │ MAIN CONTENT (view container)                                 │ │
│ │ Tổng quan│  #/dashboard  #/live  #/cameras  #/scanner                   │ │
│ │ Live     │  #/storage    #/alarms #/settings                             │ │
│ │ Camera   │                                                               │ │
│ │ Quét mạng│                                                               │ │
│ │ Lưu trữ  │                                                               │ │
│ │ Cảnh báo │                                                               │ │
│ │ Cài đặt  │                                                               │ │
│ └──────────┴───────────────────────────────────────────────────────────────┘ │
│ Mobile <768px: topbar + bottom nav 5 mục + sheet "Thêm"                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Bảng route hash

Router hash-based, không dùng History API (tránh cấu hình rewrite của Bottle). Login **không phải route hash**; là trạng thái `unauthenticated` của shell.

| Hash | Tên view | Tiêu đề hiển thị | Vai trò được vào | Dữ liệu chính |
|---|---|---|---|---|
| `#/dashboard` | `dashboard` | Tổng quan | admin, viewer | `/api/system/status`, `/api/alarm/history?limit=5`, `/api/managed/cameras` |
| `#/live` | `live` | Xem trực tiếp | admin, viewer | `/api/managed/cameras`, `/api/stream/*`, `/api/snapshot`, `/api/ptz` (admin), `/api/record/*` (admin) |
| `#/cameras` | `cameras` | Camera | admin, viewer | `/api/managed/cameras`, `/api/camera/details`, `/api/hardware/status`, `/api/storage/info` |
| `#/scanner` | `scanner` | Quét mạng | admin | `/api/scan`, `/api/scan/vlans`, `/api/export`, batch APIs |
| `#/storage` | `storage` | Lưu trữ | admin, viewer | `/api/storage/info`, `/api/storage/recordings`, `/api/storage/format` (admin) |
| `#/alarms` | `alarms` | Cảnh báo | admin, viewer | `/api/alarm/status`, `/api/alarm/history`, `/api/alarm/toggle` (admin), `/api/alarm/test` (admin), `/api/storage/watchdog/check_now` (admin) |
| `#/settings` | `settings` | Cài đặt | admin | `/api/settings`, `/api/auth/change_password`, `/api/scan/vlans`, `/api/health`, `/api/system/status` |

Quy tắc router:

- Hash rỗng → `#/dashboard` (sau khi đăng nhập).
- Hash không tồn tại → chuyển `#/dashboard` và toast `Không tìm thấy màn hình`.
- Hash của view không đủ quyền (viewer vào `#/scanner` hoặc `#/settings`) → chuyển `#/dashboard` + toast `Bạn không có quyền truy cập màn hình này` (server vẫn là nơi quyết định; client chỉ điều hướng).
- Router **không đọc query string ngoài hash**, không có deep-link debug. Mọi tham số cũ như `view_admin`, `batch_modal`, `settings_admin`, `settings_telegram`, `storage_modal`, `stream_solar`, `theater`, `view_grid`, `managed_modal`, `view_managed`, `view_scanner` bị bỏ qua hoàn toàn.
- Điều hướng nội bộ dùng `CCTV.router.go(name)`; không dùng `location.href`.
- Khi session hết hạn/401: lưu hash hiện tại vào biến bộ nhớ, hiện login; sau khi đăng nhập quay lại hash đó nếu role còn hợp lệ.

### 2.3 Login screen và shell

**Login screen** (`#login-screen`):

- Nền tối, logo chữ `CCTV VISION HUB`, phụ đề `Giám sát · Vận hành · An ninh`.
- Chọn vai trò bằng segmented control `Quản trị viên` / `Người xem`; viewer bị disable nếu `/api/auth/me` trả `viewer_login_enabled=false`, kèm chú thích “Quản trị viên chưa bật tài khoản người xem”.
- Trường mật khẩu `type=password`, nút hiện/ẩn, `autocomplete="current-password"`, không prefill, không gợi ý mật khẩu mặc định.
- Nút `Đăng nhập`, trạng thái loading, vùng lỗi `role=alert`.
- Hiển thị `Phiên bản 2.0.0`, trạng thái server từ `/api/health` (kể cả FFmpeg thiếu).
- Nếu `first_run=true`: banner hướng dẫn “Hệ thống chưa có mật khẩu quản trị. Dùng mật khẩu khởi tạo từ **file bootstrap hoặc biến môi trường do quản trị đặt** trên máy chủ (xem hướng dẫn triển khai).” **Không hiển thị giá trị, không hiển thị đường dẫn/tên biến môi trường**.
- Sau 5 lần sai: hiển thị đếm ngược theo `Retry-After`, nút submit disabled.

**Shell** (`#app-shell`, có `hidden` cho đến khi xác thực):

- Sidebar: logo, 7 nav item, badge vai trò, nút thu gọn (desktop), footer trạng thái (FFmpeg, Alarm, phiên bản).
- Topbar: tiêu đề màn hiện tại + breadcrumb nhẹ, chỉ báo sức khỏe, pill `ĐANG GÁC`/`TẮT GÁC`, menu người dùng (vai trò, đổi mật khẩu nếu admin, tải APK, cài PWA, đăng xuất), nút cài PWA.
- Main: `<main id="view-root" role="main" tabindex="-1">`.
- Mobile <768px: topbar giữ logo + menu; bottom nav 5 mục `Tổng quan`, `Live`, `Camera`, `Cảnh báo`, `Thêm`; sheet `Thêm` chứa `Quét mạng`, `Lưu trữ`, `Cài đặt` theo quyền.
- Skip link `Bỏ qua điều hướng` là phần tử đầu tiên trong body.
- Shell **không render dữ liệu** trước khi `/api/auth/me` trả `authenticated=true`.

### 2.4 Đặc tả 7 màn hình

#### 2.4.1 Tổng quan — `#/dashboard`

**Mục đích:** cho người vận hành thấy ngay sức khỏe hệ thống, camera offline, cảnh báo gần đây, và hành động nhanh.

**Bố cục (desktop ≥1024px):**

1. Page header: `Tổng quan`, thời điểm cập nhật, nút `Làm mới`.
2. Vùng banner (xếp dọc, chỉ hiện khi có vấn đề). Viewer chỉ thấy banner vận hành (`FFMPEG_MISSING`, `STORAGE_UNWRITABLE`, `HTTP_ONLY`, `ALARM_GRACE_ACTIVE`); các banner cấu hình bên dưới chỉ admin thấy:
   - `FFMPEG_MISSING` critical: “FFmpeg chưa được cài hoặc không có trong PATH. Xem trực tiếp, snapshot và ghi hình sẽ không hoạt động.” Nút `Chẩn đoán` → `#/settings` tab Hệ thống.
   - `BOOTSTRAP_PASSWORD` critical: “Hệ thống đang dùng mật khẩu khởi tạo. Hãy đổi mật khẩu quản trị.” Nút `Đổi mật khẩu`.
   - `DEFAULT_PASSWORD_WEAK` warning: “Mật khẩu camera mặc định yếu hoặc chưa đặt.” Nút `Cài đặt`.
   - `VIEWER_DISABLED` info (chỉ admin): “Tài khoản người xem chưa được bật.”
   - `HTTP_ONLY` warning: “Kết nối đang dùng HTTP trong LAN. Mật khẩu và phiên có thể bị nghe lén trên đường truyền.”
   - `STORAGE_UNWRITABLE` critical.
   - `ALARM_GRACE_ACTIVE` info: “Hệ thống cảnh báo đang trong thời gian chờ sau khởi động.”
3. KPI grid 6 thẻ: Tổng camera, Trực tuyến, Ngoại tuyến, Đang gác, Cảnh báo hôm nay, Cảnh báo thẻ nhớ. Mỗi thẻ có số lớn, nhãn, icon, xu hướng/ghi chú nhỏ.
4. Hàng 2 cột (desktop): `Trạng thái camera` (stacked bar + legend + danh sách tối đa 6 camera offline/sai mật khẩu) và `Sức khỏe hệ thống` (FFmpeg, Telegram, thư mục lưu, phiên, uptime).
5. `Cảnh báo gần đây`: bảng 5 dòng (thời gian, camera, sự kiện, trạng thái, ảnh thu nhỏ nếu có) + link `Xem tất cả` → `#/alarms`.
6. `Hành động nhanh` (chỉ admin): `Quét mạng`, `Thêm camera`, `Bật/Tắt gác`, `Kiểm tra thẻ nhớ`.

**Dữ liệu:** `/api/system/status` (poll 15s, backoff 15→30→60s khi lỗi, dừng khi tab ẩn), `/api/alarm/history?limit=5`.

**Viewer:** thấy KPI, banner (trừ nút admin), danh sách, cảnh báo; không thấy `Hành động nhanh`; nút chỉ điều hướng.

**Trạng thái:** skeleton 6 KPI + 2 card; empty khi 0 camera (“Chưa có camera nào được thêm” + CTA admin); error panel có `Thử lại`, giữ dữ liệu cũ nếu có.

**Test ID:** `dashboard-kpi-cameras`, `dashboard-kpi-online`, `dashboard-banner-ffmpeg`, `dashboard-recent-alerts`, `dashboard-quick-actions`.

#### 2.4.2 Xem trực tiếp — `#/live`

**Mục đích:** xem MJPEG nhiều camera, audio, snapshot, PTZ, ghi hình, grid 2x2/3x3.

**Bố cục:**

- Toolbar trên: chọn camera (searchable select, nhóm theo group), chất lượng `SD/HD`, mắt `1/2` (chỉ camera dual-lens), grid `1 / 2x2 / 3x3`, `Theater`, `Toàn màn hình`, `Âm thanh`, `Snapshot`, `Ghi hình` (admin), `PTZ` (admin), `Trình phát ngoài` (admin).
- Stage: 1 tile lớn hoặc grid. Mỗi tile: video `<img>` MJPEG, overlay tên camera + IP + badge trạng thái + badge `LIVE`/`REC`/`Audio`/`Privacy`/`Tracking`/`Siren`, nút thao tác khi hover/focus (snapshot, ghim vào ô, đổi mắt, phóng to, gỡ).
- PTZ panel bên phải (admin, có thể thu gọn): D-pad 8 hướng + Stop, slider tốc độ 1–8, 8 preset (gọi/đặt/xoá, đổi tên lưu localStorage `cctv.ui.ptzPresets` chỉ chứa nhãn).
- Grid: chọn camera cho từng ô từ **managed cameras** và **kết quả quét gần nhất trong state**; lưu layout `cctv.ui.grid` vào localStorage (chỉ `id`/`ip`/`channel`, không mật khẩu).
- Audio: một luồng/phiên; nút bật yêu cầu user gesture; dừng khi đổi camera/tile hoặc rời view.
- Ghi hình: nút start/stop theo tile/mắt đang chọn (`channel` 1/2); khóa theo `(ip,channel)`; hiển thị đồng hồ REC; khi stop hiện link tải `download_url`; trạng thái lấy từ `/api/record/status?ip=&channel=` poll 3s.
- Snapshot: gọi `GET /api/snapshot`, nhận blob, tải xuống; hiển thị lỗi nếu HTTP không phải 200 (không báo thành công giả).
- Ngoài view: destroy phải dừng mọi `<img>` (set `src=''`), audio, poller, và abort fetch.

**Xử lý lỗi tile:** khi `<img>` lỗi, view gọi `GET /api/snapshot?ip=...` (fetch) để phân biệt:
- 401 → về login.
- 403 → “Không đủ quyền”.
- 409 `CAMERA_CREDENTIAL_REQUIRED` → admin: mở modal nhập **username (mặc định admin) + mật khẩu camera** (transient, không prefill) → `POST /api/cameras/credentials` → thử lại; viewer: “Camera chưa được cấu hình mật khẩu. Liên hệ quản trị viên.”
- 503 `FFMPEG_UNAVAILABLE` → banner FFmpeg + không retry tự động.
- 503 `TEST_MODE_BLOCKED` → “Chế độ kiểm thử chặn luồng video.”
- Lỗi khác → panel “Không thể kết nối camera” + `Thử lại` + mã lỗi.

**Admin vs viewer:** viewer có stream, audio, snapshot, đổi grid/quality/lens, fullscreen; không có PTZ, ghi hình, trình phát ngoài, siren/privacy/tracking (các nút này không render và server trả 403).

**Test ID:** `live-camera-select`, `live-grid-2x2`, `live-grid-3x3`, `live-ptz-panel`, `live-record-btn`, `live-snapshot-btn`, `live-tile`.

#### 2.4.3 Camera — `#/cameras`

**Mục đích:** quản lý danh sách camera đã lưu (NVR), xem chi tiết, test kết nối, arm/disarm, thao tác hàng loạt.

**Bố cục:**

- Tabs: `Đã lưu` (mặc định) và `Kết quả quét gần nhất` (chỉ hiển thị nếu state có kết quả; không tự quét).
- Thanh lọc: tìm kiếm (tên/IP/MAC/serial/model), nhóm, hãng, trạng thái, `Đang gác`.
- Bảng NVR: checkbox (admin), Tên, IP, Nhóm, Model, Trạng thái, Gác (switch admin), Lần thấy cuối, Hành động.
- Hành động dòng: `Xem` (live), `Snapshot`, `Chi tiết`, `Sửa`, `Xoá` (admin).
- Drawer chi tiết: tab `Thông tin` (`cameras-tab-info`), `Mạng` (`cameras-tab-network`), `Phần cứng` (`cameras-tab-hardware`), `Thẻ nhớ` (`cameras-tab-storage`); nút `Xem trực tiếp`, `Đổi tên` (admin), `Reboot` (admin), `Mở Web GUI` (admin, `CCTV.ui.openExternal`, cảnh báo mixed content), `Privacy/Tracking/Siren` (admin).
- Modal thêm/sửa camera: tên, nhóm, hãng, IP, cổng HTTP/TCP/RTSP, username, mật khẩu (write-only), đường dẫn RTSP tùy chọn, ghi chú, `Gác an ninh`; nút `Kiểm tra kết nối`.
- Thanh batch (admin, khi chọn): `Đồng bộ sức khỏe`, `Reboot`, `Đồng bộ giờ`, `Đổi mật khẩu`, `Đổi IP`, `Bỏ chọn`.
- Footer: tổng, online, offline, số đang gác.

**Viewer:** bảng không checkbox, không switch gác, không nút thêm/sửa/xoá/batch; vẫn xem chi tiết, live, snapshot, thẻ nhớ (read-only); không thấy username/note/rtsp_path trong chi tiết.

**Empty:** “Chưa có camera nào trong NVR” + CTA `Thêm camera` (admin) / `Quét mạng` (admin); viewer thấy “Chưa có camera nào được cấu hình”.

**Test ID:** `cameras-table`, `cameras-add-btn`, `cameras-search`, `cameras-detail-drawer`, `cameras-batch-bar`.

#### 2.4.4 Quét mạng — `#/scanner` (admin)

**Mục đích:** quét Dahua/Imou, ONVIF, Hikvision SADP; lọc VLAN; đưa camera vào NVR; thao tác hàng loạt.

**Bố cục:**

- Form quét: input dải mạng (CIDR/dải/IP đơn, phân cách phẩy), switch `Quét sâu`, nút `Dò VLAN`, chip VLAN nhanh (lấy từ `/api/settings` + `/api/scan/vlans`), nút `Bắt đầu quét`, nút `Huỷ` (abort fetch phía client).
- Trạng thái quét: spinner + text “Đang quét …”, không tự quét khi mở màn.
- Kết quả: số lượng, bộ lọc (IP/model/tên/MAC/serial/VLAN), sắp xếp IP/Model, chọn trang, chọn tất cả theo bộ lọc, phân trang 10/15/20/30/50.
- Cột: checkbox, IP, VLAN, Tên, Model, MAC, Serial, HTTP, TCP, Hãng, Giao thức, Trạng thái.
- Hành động dòng: `Live`, `Thêm vào NVR`, `Thẻ nhớ`, `Chi tiết`.
- Batch: `Thêm vào NVR` (modal mật khẩu mặc định write-only), `Đổi IP`, `Reboot`, `Đồng bộ giờ`, `Đổi mật khẩu`, `Xuất CSV`.
- Modal đổi IP: preview bảng IP cũ → IP mới, DHCP/tĩnh, netmask, gateway, `auto_reboot`; xác nhận gõ `DOI-IP`.
- Modal đổi mật khẩu: mật khẩu mới + xác nhận, cảnh báo “Mật khẩu mới không hiển thị lại”; xác nhận gõ `DOI-MAT-KHAU`.
- Reboot: xác nhận gõ `REBOOT`.
- Không hiển thị mật khẩu ở bất kỳ đâu; không có nút copy RTSP URL.

**Viewer:** không có nav; nếu vào hash trực tiếp → dashboard + toast.

**Test ID:** `scanner-subnet`, `scanner-start-btn`, `scanner-results`, `scanner-batch-add`, `scanner-export`.

#### 2.4.5 Lưu trữ — `#/storage`

**Mục đích:** xem/format thẻ nhớ camera, tìm clip ghi trên thẻ, xem metadata; quản lý thư mục lưu local.

**Bố cục:**

- Chọn camera (managed).
- Card `Thẻ nhớ MicroSD`: trạng thái, gauge dung lượng, tổng/đã dùng/còn trống, tên thiết bị, đường dẫn (chỉ admin), nút `Format thẻ` (admin).
- Format: modal 2 bước, gõ `FORMAT`, hiển thị cảnh báo mất toàn bộ dữ liệu trên thẻ; server yêu cầu `confirm:"FORMAT"`.
- Card `Clip trên thẻ`: date picker (mặc định hôm nay), lọc `Tất cả / Chuyển động / Định kỳ / Thủ công`, bảng clip (bắt đầu, kết thúc, thời lượng, dung lượng, loại sự kiện, luồng), drawer chi tiết.
- Card `Lưu trữ máy chủ`: đường dẫn recordings/snapshots (admin), nút `Mở thư mục` (admin), danh sách **bản ghi đang hoạt động** lấy từ `GET /api/record/status` (không `ip`, poll 5s) + link tải khi dừng. Không có endpoint lịch sử file local trong phạm vi này.
- Empty: “Camera không có thẻ nhớ hoặc chưa đọc được thông tin.”
- Viewer: xem dung lượng, clip, tải bản ghi; không thấy format, đường dẫn, mở thư mục, không thấy `file_path` của clip.

**Test ID:** `storage-camera-select`, `storage-sd-card`, `storage-format-btn`, `storage-clips-table`.

#### 2.4.6 Cảnh báo — `#/alarms`

**Mục đích:** vận hành gác an ninh, cấu hình Telegram, xem lịch sử, watchdog thẻ nhớ.

**Bố cục:**

- Header trạng thái: switch `Đang gác` (admin; tắt phải confirm), số listener, lịch gác, trạng thái trong/ngoài lịch gác, cooldown (viewer được xem).
- Card `Telegram` (admin): trạng thái `Đã cấu hình`/`Chưa cấu hình`, lịch, bộ lọc người, nút `Gửi thử` (dùng cấu hình đã lưu, không nhập token trên màn này; nếu không chọn camera thì chỉ gửi text, không snapshot), link `Cấu hình Telegram` → `#/settings` tab Telegram. Viewer không thấy card này (API cũng không trả cấu hình Telegram cho viewer).
- Card `Phạm vi gác` (admin): `Tất cả camera` hoặc `Chỉ định` + danh sách checkbox camera. Viewer không thấy card này (API không trả `telegram_armed_cameras` cho viewer).
- Card `Watchdog thẻ nhớ`: bảng trạng thái từng camera, lần chạy cuối, nút `Quét ngay` (admin), `Gửi cảnh báo` (admin, mặc định tắt).
- `Lịch sử cảnh báo`: bộ lọc camera/ngày/trạng thái, bảng (thời gian, camera, sự kiện, trạng thái, ảnh), thumbnail mở `/snapshots/...`; nút `Xoá lịch sử` (admin, confirm).
- Poll `/api/alarm/status` 15s; history tải lại sau thao tác.

**Test ID:** `alarms-arm-switch`, `alarms-test-telegram`, `alarms-history-table`, `alarms-clear-history`, `alarms-watchdog`.

#### 2.4.7 Cài đặt — `#/settings` (admin)

**Mục đích:** cấu hình hệ thống, tài khoản, chẩn đoán, PWA/APK.

**Tabs:**

1. `Tài khoản & phiên`:
   - Đổi mật khẩu admin: mật khẩu hiện tại, mới, xác nhận; chính sách hiển thị; sau đổi → đăng xuất tất cả, về login.
   - Đặt/đổi/xoá mật khẩu viewer: mật khẩu admin hiện tại (re-auth), mật khẩu viewer mới + xác nhận; nút `Tắt đăng nhập người xem`; sau thao tác → đăng xuất tất cả, về login.
   - Thông tin phiên: vai trò, hết hạn, thời gian còn lại; nút `Đăng xuất`.
2. `Quét mạng`: `default_subnet`, `last_subnets`, `scan_timeout` (1–10s), `deep_scan` mặc định, `Dò VLAN` và danh sách VLAN (read-only), nút lưu.
3. `Lưu trữ & Video`: `recordings_dir`, `snapshots_dir`, `auto_reboot_on_ip_change`, nút `Mở thư mục`; FFmpeg `available/version/audio_available` từ `/api/health`, `ffmpeg_path` từ `systemStatus.runtime`; giới hạn stream/recording từ `systemStatus.limits` (read-only).
4. `Telegram`: token (write-only), chat ID (write-only), trạng thái đã cấu hình, `telegram_enabled`, cooldown, lọc người, lịch gác; nút `Gửi thử`; nút `Xoá token`.
5. `Hệ thống`: phiên bản app/API, `runtime.python_version`, `runtime.platform`, uptime, health, TLS, LAN URL + copy, cài PWA, tải APK (hoặc thông báo chưa có), nút `Khôi phục mặc định` (chỉ cấu hình vận hành, không xoá mật khẩu/bí mật/đường dẫn; confirm gõ `RESET`).
6. `Giới thiệu`: mô tả ngắn, hướng dẫn PWA/APK, không link ngoài, không nội dung tĩnh trùng lặp.

**Viewer:** không có nav, vào hash trực tiếp → dashboard.

**Test ID:** `settings-tab-account`, `settings-tab-scan`, `settings-tab-storage`, `settings-tab-telegram`, `settings-tab-system`, `settings-tab-about`, `settings-change-password`, `settings-viewer-password`, `settings-save`.

### 2.5 Ma trận hiển thị theo vai trò (UI)

| Thành phần | Admin | Viewer |
|---|---|---|
| Sidebar `Quét mạng`, `Cài đặt` | Có | Không |
| Dashboard quick actions | Có | Không |
| Camera add/edit/delete/batch | Có | Không |
| Camera arm/disarm switch | Có | Không (chỉ badge) |
| Camera detail actions (rename/reboot/privacy/tracking/siren) | Có | Không |
| Live PTZ/record/external player | Có | Không |
| Live audio/snapshot/grid/quality/lens | Có | Có |
| Storage format/open folder | Có | Không |
| Alarms arm/disarm/test/clear/watchdog run | Có | Không |
| Alarms history/snapshot | Có | Có |
| Settings | Có | Không |
| PWA install / APK download | Có | Có |
| Copy LAN URL | Có | Có (từ `systemStatus.net.lan_url` hoặc `location.origin` fallback; không secret) |

Quy ước DOM: mọi phần tử chỉ admin được thấy phải có `data-admin-only="1"`; view render theo role, và `CCTV.ui.applyRole(root, role)` ẩn/xoá các phần tử này khi viewer. Test static kiểm tra không có nút admin ngoài `data-admin-only`; test HTTP kiểm tra server trả 403.

### 2.6 Điều hướng và trạng thái ứng dụng

- Trạng thái cấp cao: `boot` → `unauthenticated` (login) → `authenticated` (shell + router) → `session-expired` (login + thông báo).
- Khi login thành công: nạp `/api/auth/me` (đã có), `/api/health`, `/api/system/status`; hiện shell; router chạy.
- Khi logout: gọi API, purge state, dừng router, destroy view, xoá CSRF khỏi bộ nhớ, hiện login.
- Khi 401 từ bất kỳ API: `CCTV.auth.handleUnauthenticated()`; destroy view; hiện login; lưu hash hiện tại.
- Khi 403: toast lỗi; không tự logout.
- Khi 429: toast “Thao tác quá nhanh, thử lại sau N giây”; không retry tự động với POST.
- Khi 503: banner tương ứng (FFmpeg/player/Telegram/test mode); không retry tự động.
- Khi tab quay lại foreground: refresh view hiện tại (nếu view hỗ trợ `onResume`) và kiểm tra session.

### 2.7 Luồng dữ liệu

```
View → CCTV.api (cookie + CSRF) → Bottle route @require_role
     → validate input → service (settings/credentials/camera_media/...)
     → JSON envelope {ok:true,...} hoặc {ok:false,error:{code,...}}
View → CCTV.state (cache trong bộ nhớ) → render bằng DOM API (textContent)
```

- Không có state toàn cục chứa secret.
- Không có fetch trực tiếp trong view; luôn qua `CCTV.api`.
- Không có `fetch` trong inline HTML.
- Không có dữ liệu giả trong production; nếu API lỗi, view hiển thị lỗi/empty, không bịa dữ liệu.

### 2.8 Quy ước test ID

Mọi phần tử tương tác chính có `data-testid` theo bảng ở từng màn. Quy ước: `kebab-case`, tiền tố theo view (`dashboard-`, `live-`, `cameras-`, `scanner-`, `storage-`, `alarms-`, `settings-`, `login-`). Không đổi test ID sau khi đã chốt nếu không cập nhật tài liệu.

### 2.9 Bảng test ID bắt buộc

| View | Test ID |
|---|---|
| Login | `login-form`, `login-role-admin`, `login-role-viewer`, `login-password`, `login-submit`, `login-error` |
| Shell | `app-shell`, `sidebar`, `topbar`, `nav-dashboard`, `nav-live`, `nav-cameras`, `nav-scanner`, `nav-storage`, `nav-alarms`, `nav-settings`, `user-menu`, `logout-btn` |
| Dashboard | `dashboard-kpi-cameras`, `dashboard-kpi-online`, `dashboard-kpi-offline`, `dashboard-kpi-armed`, `dashboard-kpi-alerts`, `dashboard-banner-ffmpeg`, `dashboard-banner-password`, `dashboard-recent-alerts`, `dashboard-quick-actions` |
| Live | `live-camera-select`, `live-quality`, `live-lens`, `live-grid-1`, `live-grid-2x2`, `live-grid-3x3`, `live-snapshot-btn`, `live-audio-btn`, `live-record-btn`, `live-ptz-panel`, `live-external-player`, `live-tile` |
| Cameras | `cameras-table`, `cameras-search`, `cameras-add-btn`, `cameras-detail-drawer`, `cameras-batch-bar`, `cameras-sync-health`, `cameras-tab-info`, `cameras-tab-network`, `cameras-tab-hardware`, `cameras-tab-storage` |
| Scanner | `scanner-subnet`, `scanner-deep`, `scanner-detect-vlans`, `scanner-start-btn`, `scanner-cancel-btn`, `scanner-results`, `scanner-batch-add`, `scanner-export` |
| Storage | `storage-camera-select`, `storage-sd-card`, `storage-format-btn`, `storage-date`, `storage-clips-table`, `storage-open-folder` |
| Alarms | `alarms-arm-switch`, `alarms-test-telegram`, `alarms-history-table`, `alarms-clear-history`, `alarms-watchdog`, `alarms-run-watchdog` |
| Settings | `settings-tab-account`, `settings-tab-scan`, `settings-tab-storage`, `settings-tab-telegram`, `settings-tab-system`, `settings-tab-about`, `settings-change-password`, `settings-viewer-password`, `settings-save` |

---

## 3. DESIGN SYSTEM

### 3.1 Token màu — Dark NOC (mặc định)

Tất cả token khai báo trong `:root` của `static/css/app.css`. Không hardcode mã màu trong view CSS; chỉ dùng `var(--...)`.

| Token | Giá trị | Dùng cho |
|---|---|---|
| `--bg` | `#060A13` | Nền toàn trang |
| `--bg-elevated` | `#0B1220` | Sidebar/topbar |
| `--surface` | `#0F1828` | Card, panel |
| `--surface-2` | `#142034` | Header bảng, input |
| `--surface-3` | `#1A2942` | Hover, selected |
| `--border` | `#22314D` | Viền mặc định |
| `--border-strong` | `#31456A` | Viền focus/hover |
| `--text` | `#E8EEF8` | Chữ chính |
| `--text-muted` | `#9AA9C0` | Chữ phụ (contrast ≥ 4.5:1 trên `--surface`) |
| `--text-subtle` | `#7C8BA5` | Nhãn nhỏ (chỉ dùng ≥13px, không dùng cho thông tin quan trọng) |
| `--primary` | `#22D3EE` | Hành động chính, link |
| `--primary-hover` | `#67E8F9` | Hover primary |
| `--primary-press` | `#06B6D4` | Active |
| `--on-primary` | `#04121A` | Chữ trên nền primary |
| `--accent` | `#60A5FA` | Liên kết phụ, chart |
| `--success` | `#4ADE80` | Online/thành công |
| `--success-bg` | `rgba(74,222,128,.12)` | Nền badge success |
| `--warning` | `#FBBF24` | Cảnh báo |
| `--warning-bg` | `rgba(251,191,36,.12)` | Nền badge warning |
| `--danger` | `#F87171` | Lỗi/nguy hiểm (dùng cho chữ; nền nút dùng `--danger-solid`) |
| `--danger-solid` | `#DC2626` | Nền nút phá huỷ, chữ trắng |
| `--danger-bg` | `rgba(248,113,113,.12)` | Nền badge danger |
| `--info` | `#38BDF8` | Thông tin |
| `--focus` | `#67E8F9` | Focus ring |
| `--overlay` | `rgba(2,6,15,.72)` | Backdrop modal/drawer |
| `--shadow-color` | `rgba(0,0,0,.45)` | Shadow |

**Kiểm tra tương phản bắt buộc:** `--text` trên `--surface` ≥ 7:1; `--text-muted` trên `--surface` ≥ 4.5:1; `--on-primary` trên `--primary` ≥ 4.5:1; chữ trắng trên `--danger-solid` ≥ 4.5:1. Không dùng màu làm dấu hiệu duy nhất.

### 3.2 Token màu — Light (định nghĩa sẵn, chưa bắt buộc phát hành)

Đặt dưới `[data-theme="light"]`. Dark là theme mặc định và là theme duy nhất trong phạm vi nghiệm thu; light token để dùng cho in ấn/tương lai, không cần nút chuyển theme.

| Token | Giá trị |
|---|---|
| `--bg` | `#F6F8FB` |
| `--bg-elevated` | `#FFFFFF` |
| `--surface` | `#FFFFFF` |
| `--surface-2` | `#F1F5F9` |
| `--surface-3` | `#E2E8F0` |
| `--border` | `#D8E0EA` |
| `--border-strong` | `#94A3B8` |
| `--text` | `#0F172A` |
| `--text-muted` | `#475569` |
| `--text-subtle` | `#64748B` |
| `--primary` | `#0E7490` |
| `--primary-hover` | `#155E75` |
| `--on-primary` | `#FFFFFF` |
| `--success` | `#15803D` |
| `--warning` | `#B45309` |
| `--danger` | `#B91C1C` |
| `--danger-solid` | `#B91C1C` |
| `--info` | `#0369A1` |
| `--focus` | `#0E7490` |

### 3.3 Typography

**Font hệ thống, không tải ngoài:**

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
--font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
```

| Vai trò | Size / line-height | Weight | Ghi chú |
|---|---|---|---|
| Display | 28/36 | 700 | Chỉ login/empty lớn |
| H1 | 22/30 | 600 | Tiêu đề màn |
| H2 | 18/26 | 600 | Tiêu đề card |
| H3 | 15/22 | 600 | Tiêu đề nhóm |
| Body | 14/21 | 400 | Mặc định |
| Body strong | 14/21 | 600 | Nhấn |
| Small | 13/19 | 400 | Phụ |
| Caption | 12/17 | 500 | Nhãn, meta |
| Micro | 11/16 | 600 | Badge, uppercase label, letter-spacing .02em |
| Numeric | 14/20 | 600 | `font-variant-numeric: tabular-nums` |

- IP, MAC, serial, port, đường dẫn, mã lỗi dùng `--font-mono`.
- Không dùng font ngoài, không `@font-face` trừ file self-host (không cần).
- Không viết hoa toàn bộ câu; chỉ nhãn ngắn.

### 3.4 Spacing, radius, shadow, z-index, motion

**Spacing (4px grid):** `2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48`.
- Padding card: 16px desktop, 12px mobile.
- Gap giữa card: 16px.
- Padding page: 24px desktop, 16px tablet, 12px mobile.
- Row bảng: 40px (compact), 44px (comfortable); header 36px.

**Radius:** `--radius-xs: 4px`, `--radius-sm: 6px`, `--radius-md: 8px`, `--radius-lg: 12px`, `--radius-xl: 16px`, `--radius-full: 999px`.

**Shadow:**
- `--shadow-sm: 0 1px 2px var(--shadow-color)`
- `--shadow-md: 0 4px 12px var(--shadow-color)`
- `--shadow-lg: 0 16px 40px var(--shadow-color)`
- `--shadow-focus: 0 0 0 3px rgba(103,232,249,.25)`

**Z-index:** base 0; sticky 10; dropdown 100; drawer 200; modal 300; toast 400; tooltip 500.

**Motion:** `--dur-fast: 120ms`, `--dur-base: 180ms`, `--ease: cubic-bezier(.2,.8,.2,1)`. Tôn trọng `prefers-reduced-motion: reduce` → tắt animation/transition không cần thiết.

### 3.5 Trạng thái tương tác

| Trạng thái | Quy tắc |
|---|---|
| Hover | Tăng sáng nền `--surface-3`; không đổi layout; không dùng hover làm cách duy nhất để lộ hành động (phải có focus) |
| Focus | `outline: 2px solid var(--focus); outline-offset: 2px;` hoặc `box-shadow` tương đương; **không bao giờ `outline: none`** nếu không thay thế |
| Active/pressed | `transform: translateY(1px)` + `--primary-press` |
| Disabled | `opacity: .45; cursor: not-allowed;` + `aria-disabled="true"`; không chỉ dựa vào màu |
| Selected | Nền `--surface-3` + viền trái 2px `--primary` + `aria-selected="true"` |
| Invalid | Viền `--danger`, icon cảnh báo, text lỗi dưới field, `aria-invalid="true"` |
| Loading | Skeleton hoặc spinner; nút có `aria-busy="true"`, disable tạm |
| Dragging/streaming | Badge `LIVE` có chấm nhấp nháy; tôn trọng reduced-motion |

### 3.6 Layout và breakpoint

| Breakpoint | Khoảng | Sidebar | Topbar | Nội dung |
|---|---|---|---|---|
| `xs` | <480px | Off-canvas | 52px | 1 cột, bottom nav |
| `sm` | 480–767px | Off-canvas | 52px | 1 cột, bottom nav |
| `md` | 768–1023px | Thu gọn 72px (icon + tooltip) | 56px | 1–2 cột; bảng scroll ngang |
| `lg` | 1024–1439px | 248px | 56px | 2 cột; bảng đầy đủ |
| `xl` | ≥1440px | 248px | 56px | 2–3 cột; max-width nội dung 1680px |

- Sidebar desktop có thể thu gọn còn 72px; lưu `cctv.ui.sidebarCollapsed`.
- Topbar sticky; sidebar sticky full height; main scroll độc lập.
- Mobile: bottom nav 56px + `env(safe-area-inset-bottom)`; ẩn sidebar sau hamburger; modal/drawer full-screen.
- Bảng: container `.c-table-wrap` có `overflow-x:auto` và `role="region"` + `aria-label`; cột đầu sticky khi cần.
- Mobile: bảng chuyển thành danh sách card cho các bảng chính (camera, alerts, clips); bảng scanner có thể giữ scroll ngang vì nhiều cột.
- Không đặt chiều cao cố định gây cắt nội dung; dùng `max-height` + scroll cho danh sách dài.
- Không cấm zoom; viewport: `width=device-width, initial-scale=1, viewport-fit=cover` (không `user-scalable=no`, không `maximum-scale=1`).

### 3.7 Accessibility (WCAG 2.1 AA)

**Bắt buộc:**

1. `<html lang="vi">`; title mô tả màn; mỗi màn có đúng một `<h1>`.
2. Landmark: `<header>`, `<nav aria-label="Điều hướng chính">`, `<main>`, `<aside>`; skip link.
3. Mọi icon-only button có `aria-label` tiếng Việt; icon trang trí `aria-hidden="true"`.
4. Modal/drawer: `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, focus trap, Escape đóng (trừ khi form dirty → confirm), focus trả về phần tử mở.
5. Confirm dialog: `role="alertdialog"`; nút nguy hiểm không phải focus mặc định nếu có thể; mô tả hậu quả rõ.
6. Form: `<label for>`, `aria-describedby` cho help/error, `aria-invalid`; không dùng placeholder thay label.
7. Switch: native checkbox ẩn hợp lý hoặc `role="switch"` + `aria-checked`; điều khiển bằng Space/Enter.
8. Tabs: `role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls`, `role="tabpanel"`; phím mũi tên chuyển tab.
9. Bảng: `<caption>` (có thể sr-only), `<th scope="col">`, `aria-sort` cho cột sắp xếp, checkbox có label.
10. Toast: `aria-live="polite"` cho thông tin, `role="alert"` cho lỗi nghiêm trọng; không tự biến mất quá nhanh với lỗi (≥8s hoặc có nút đóng).
11. Trạng thái không chỉ dựa vào màu: badge có icon + text; dòng lỗi có text.
12. Bàn phím: mọi hành động dùng được không cần chuột; thứ tự tab hợp lý; không bẫy focus ngoài modal.
13. Phím tắt: `Alt+1..7` điều hướng (khi không ở trong input), `/` focus ô tìm kiếm của màn hiện tại, `Escape` đóng lớp phủ, mũi tên điều khiển PTZ **chỉ khi focus nằm trong PTZ panel**, `Space` dừng PTZ trong panel. Không có phím tắt bí mật mở admin.
14. PTZ panel có hướng dẫn phím tắt hiển thị; không chiếm phím mũi tên toàn cục.
15. Tương phản: text ≥4.5:1, UI component ≥3:1; focus indicator ≥3:1 với nền.
16. Touch target mobile ≥44×44px; desktop ≥32×32px với khoảng cách.
17. `prefers-reduced-motion` được tôn trọng.
18. Không autoplay audio; audio chỉ phát sau user gesture.

### 3.8 Quy ước nội dung

- Toàn bộ tiếng Việt có dấu, câu ngắn, giọng vận hành. Mã lỗi hiển thị kèm thông điệp tiếng Việt, ví dụ `FFMPEG_UNAVAILABLE — FFmpeg chưa được cài`.
- Không emoji trong chrome/icon/nút/nhãn. Emoji chỉ được phép trong nội dung do người dùng nhập (tên camera) và phải render bằng `textContent`.
- Ngày giờ: `HH:mm:ss DD/MM/YYYY`; tương đối: “2 phút trước”. Dùng `Intl.DateTimeFormat('vi-VN', {timeZone:'Asia/Ho_Chi_Minh'})`.
- Dung lượng: `1,24 GB` (dấu phẩy thập phân vi-VN); tốc độ: `ms`.
- Địa chỉ IP/MAC/serial/port: monospace, không xuống dòng giữa chừng; MAC chuẩn `AA:BB:CC:DD:EE:FF`.
- Trạng thái camera: `online` → “Trực tuyến”, `offline` → “Ngoại tuyến”, `auth_failed` → “Sai mật khẩu”, `solar_sleep` → “Ngủ năng lượng mặt trời”, `unknown` → “Chưa rõ”.
- Nút: động từ + đối tượng (`Lưu cài đặt`, `Xoá camera`), không dùng “OK”/“Submit”.

---

## 4. COMPONENT VÀ API JAVASCRIPT DÙNG CHUNG

### 4.1 Namespace, thứ tự nạp và quy ước file

- Mỗi file JS là một IIFE `'use strict'`, gắn API vào `window.CCTV`. Không dùng ES module/import để `node --check` kiểm tra được và không cần bundler.
- `index.html` nạp theo thứ tự (tất cả `defer`):

```html
<script defer src="/static/js/core.js?v=2.0.0"></script>
<script defer src="/static/js/views/dashboard.js?v=2.0.0"></script>
<script defer src="/static/js/views/live.js?v=2.0.0"></script>
<script defer src="/static/js/views/cameras.js?v=2.0.0"></script>
<script defer src="/static/js/views/scanner.js?v=2.0.0"></script>
<script defer src="/static/js/views/storage.js?v=2.0.0"></script>
<script defer src="/static/js/views/alarms.js?v=2.0.0"></script>
<script defer src="/static/js/views/settings.js?v=2.0.0"></script>
```

- `core.js` phải định nghĩa `CCTV.views` trước khi view script chạy; view script chỉ gọi `CCTV.views.register(...)`, không chạy logic mạng/DOM ở top-level.
- Nếu một file view thiếu/404, `core.js` vẫn boot; router hiển thị error panel “Không tải được màn hình …”. Không được treo toàn app.
- Không có biến toàn cục ngoài `CCTV`. Không ghi đè `window.fetch`, `console`, prototype.
- `CCTV.version = '2.0.0'`; `CCTV.apiVersion = 2`.

### 4.2 `CCTV.api`

```js
const err = await CCTV.api.get('/api/managed/cameras'); // -> object JSON
CCTV.api.post('/api/ptz', {ip, action:'Left', speed:5});
CCTV.api.put('/api/managed/cameras/cam_...', {name:'Cổng chính'});
CCTV.api.del('/api/managed/cameras/cam_...');
const blob = await CCTV.api.get('/api/snapshot', {query:{ip}, expect:'blob'});
```

**Hợp đồng:**

```ts
CCTV.api.request(method, path, {
  body?: object,
  query?: Record<string,string|number|boolean>,
  signal?: AbortSignal,
  timeoutMs?: number,          // mặc định 20000; scan 120000
  expect?: 'json'|'blob'|'text' // mặc định 'json'
}) -> Promise<any>

CCTV.api.get(path, opts?)
CCTV.api.post(path, body?, opts?)
CCTV.api.put(path, body?, opts?)
CCTV.api.del(path, body?, opts?)
CCTV.api.download(path, filename, opts?) -> Promise<void>
```

**Quy tắc:**

1. `path` là **relative**, bắt đầu bằng `/`; `CCTV.api` từ chối URL tuyệt đối/`//host`/`javascript:`.
2. Luôn `credentials: 'same-origin'`; không gửi cookie cross-origin.
3. Header: `Accept: application/json` (hoặc `*/*` cho blob), `Content-Type: application/json` khi có body, `X-CSRF-Token` cho `POST/PUT/PATCH/DELETE` nếu đã có CSRF.
4. Không retry tự động cho POST/PUT/DELETE; GET được retry 1 lần khi lỗi mạng (không retry 4xx/5xx).
5. Parse JSON; nếu response không phải JSON hoặc JSON sai → `ApiError` code `INVALID_RESPONSE`, kèm status.
6. Nếu HTTP 401: gọi `CCTV.auth.handleUnauthenticated()` rồi ném lỗi — **trừ** `/api/auth/login` và `/api/auth/me` (login sai không được đẩy về login lần nữa).
7. Nếu HTTP 429: đọc `Retry-After`, gắn `retryAfterSeconds` vào lỗi.
8. Nếu HTTP 503: gắn `code` (ví dụ `FFMPEG_UNAVAILABLE`) vào lỗi; `core.js` cập nhật banner toàn cục tương ứng.
9. Không log body/response ra console. Chỉ log `method`, `path` (không query secret), `status`, `code`, `requestId`.
10. Server sinh `X-Request-Id`; client chỉ đọc header `X-Request-Id` trong lỗi để hiển thị “Mã hỗ trợ”.
11. Trên HTTP 2xx, nếu JSON có `ok === false` → ném `ApiError` với `code` từ `error.code` (không coi là thành công).

**`ApiError`:**

```js
class ApiError extends Error {
  name = 'ApiError';
  status;        // HTTP status
  code;          // mã lỗi server, ví dụ 'FORBIDDEN'
  message;       // thông điệp tiếng Việt từ server
  details;       // object|null, không chứa secret
  requestId;     // string|null
  retryAfterSeconds; // number|null
}
```

**Bảng xử lý lỗi mặc định ở tầng core:**

| HTTP | Code | Hành vi UI |
|---|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_IP`, `INVALID_SUBNET`, `CONFIRMATION_REQUIRED` | Hiển thị lỗi cạnh field/modal; không toast chung |
| 401 | `UNAUTHENTICATED`, `INVALID_CREDENTIALS` | Login screen; nếu đang ở API khác thì “Phiên đã hết hạn” |
| 403 | `FORBIDDEN`, `CSRF_INVALID`, `ORIGIN_MISMATCH`, `VIEWER_LOGIN_DISABLED` | Toast “Bạn không có quyền thực hiện thao tác này”; không logout |
| 404 | `NOT_FOUND`, `CAMERA_NOT_FOUND` | Empty/error panel tương ứng |
| 409 | `CAMERA_CREDENTIAL_REQUIRED` | Admin: modal username + mật khẩu camera (transient); viewer: thông báo liên hệ admin |
| 409 | `ALREADY_RECORDING`, `SCAN_IN_PROGRESS`, `TELEGRAM_NOT_CONFIGURED` | Toast + gợi ý hành động |
| 413 | `PAYLOAD_TOO_LARGE` | Toast lỗi |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Toast lỗi (lỗi lập trình) |
| 429 | `RATE_LIMITED`, `TOO_MANY_STREAMS` | Toast kèm đếm ngược `Retry-After`; disable nút tạm |
| 500 | `INTERNAL_ERROR` | Error panel + mã hỗ trợ; không hiện stack |
| 502 | `CAMERA_OPERATION_FAILED`, `TELEGRAM_SEND_FAILED` | Toast/error panel “Thiết bị không phản hồi đúng”; giữ form để thử lại |
| 503 | `FFMPEG_UNAVAILABLE` | Banner toàn cục + disable hành động video |
| 503 | `PLAYER_NOT_AVAILABLE` | Toast “Không tìm thấy mpv/VLC trên máy chủ” |
| 503 | `TELEGRAM_DISABLED`, `TEST_MODE_BLOCKED` | Toast/banner tương ứng |
| 503 | `SERVICE_UNAVAILABLE` | Error panel + thử lại |

### 4.3 `CCTV.auth`

```ts
CCTV.auth.init() -> Promise<{authenticated:boolean, role:'admin'|'viewer'|null}>
CCTV.auth.login(role:'admin'|'viewer', password:string) -> Promise<Session>
CCTV.auth.logout() -> Promise<void>
CCTV.auth.changePassword({target:'admin'|'viewer', currentPassword:string, newPassword:string, clearViewer?:boolean}) -> Promise<void>
CCTV.auth.me() -> Promise<Session|null>
CCTV.auth.role() -> 'admin'|'viewer'|null
CCTV.auth.isAdmin() -> boolean
CCTV.auth.csrf() -> string|null
CCTV.auth.session() -> {role, username, expiresAt}|null
CCTV.auth.onChange(fn) -> unsubscribe
CCTV.auth.handleUnauthenticated() -> void
CCTV.auth.startRevalidation(intervalMs = 300000) -> stop
```

**Quy tắc:**

- `Session` chỉ chứa `{role, username, displayName, expiresAt}` và CSRF token tách riêng trong closure. **Không** lưu token session ở bất kỳ storage nào.
- `login` không nhận token từ JSON; cookie do server set. Response chỉ dùng `role`, `csrf_token`, `expires_at`.
- `logout` gọi `POST /api/auth/logout` với CSRF; sau đó:
  - `CCTV.state.reset()`,
  - `CCTV.auth.purgeLegacyStorage()`,
  - dừng router, destroy view, ẩn shell, hiện login.
- `handleUnauthenticated()` idempotent: chỉ xử lý một lần cho mỗi chuyển trạng thái; dừng poller, đóng modal, hiện login.
- `startRevalidation` gọi `/api/auth/me` mỗi 5 phút; nếu `authenticated=false` → handleUnauthenticated.
- Khi tab được focus lại: gọi `me()` một lần (debounce 2s).
- `purgeLegacyStorage()` xóa mọi key:
  - bắt đầu bằng `cam_pwd_`,
  - bằng `admin_token`, `cctv_token`, `session_token`,
  - chứa `password`, `secret`, `token` (case-insensitive) trừ allowlist UI (`cctv.ui.*`).
- Không lưu role vào localStorage; reload luôn hỏi server qua `/api/auth/me`.

### 4.4 `CCTV.state`

```ts
CCTV.state.get(key) -> any
CCTV.state.set(key, value) -> void
CCTV.state.patch(key, partial) -> void
CCTV.state.subscribe(key, fn) -> unsubscribe
CCTV.state.reset() -> void
```

**Khóa hợp lệ và shape:**

| Khóa | Shape | Ghi chú |
|---|---|---|
| `session` | `{role, username, expiresAt}` | Không secret |
| `health` | object từ `/api/health` | Poll 30s |
| `systemStatus` | object từ `/api/system/status` | Không secret |
| `cameras` | `ManagedCamera[]` (sanitized) | Không password |
| `scan` | `{devices: ScanDevice[], scannedAt, targets}` | Chỉ trong bộ nhớ; không localStorage |
| `alarms` | `{history: AlarmHistoryItem[]}` | Ảnh chỉ URL |
| `settings` | object an toàn theo role | Không secret |
| `ui` | `{sidebarCollapsed, grid, pageSize, ptzPresets}` | Chỉ phần này được persist |

**Persist UI (allowlist duy nhất được phép dùng localStorage):**

| Key | Giá trị | Giới hạn |
|---|---|---|
| `cctv.ui.sidebarCollapsed` | `"1"`/`"0"` | |
| `cctv.ui.grid` | JSON `{mode:"1"/"2x2"/"3x3", slots:[{ip,channel}]}` | Không password; tối đa 9 slot |
| `cctv.ui.pageSize` | number | 10/15/20/30/50 |
| `cctv.ui.ptzPresets` | JSON `{ip:{1:"Tên",...}}` | Chỉ nhãn, tối đa 8 mỗi IP, cắt 32 ký tự |

- Không lưu token, role, mật khẩu, ảnh, dữ liệu camera nhạy cảm.
- `state.reset()` xóa cache nhưng **không** xóa `cctv.ui.*`.

### 4.5 `CCTV.router` và vòng đời view

```ts
CCTV.views.register(name, {
  title: string,          // tiêu đề hiển thị
  icon: string,           // tên icon trong sprite, ví dụ 'dashboard'
  roles: ('admin'|'viewer')[],
  order: number,          // thứ tự sidebar
  render(container: HTMLElement, ctx: ViewContext): void,
  destroy(): void,
  onResume?(): void       // tùy chọn, gọi khi tab visible lại
});

CCTV.router.init({defaultView:'dashboard'})
CCTV.router.go(name, {replace?:boolean})
CCTV.router.current() -> string|null
CCTV.router.onChange(fn) -> unsubscribe
CCTV.router.stop() -> void
```

**`ViewContext`:**

```ts
{
  role: 'admin'|'viewer',
  isAdmin: boolean,
  signal: AbortSignal,       // aborted khi rời view
  api: CCTV.api,
  ui: CCTV.ui,
  state: CCTV.state,
  router: CCTV.router,
  container: HTMLElement,
  toast: CCTV.ui.toast,
  confirm: CCTV.ui.confirm,
  format: CCTV.fmt,
  icons: CCTV.icons
}
```

**Vòng đời bắt buộc:**

1. Router parse hash → tên view; nếu chưa đăng nhập, không render.
2. Kiểm tra `roles`; nếu không hợp lệ → `#/dashboard` + toast.
3. Gọi `destroy()` của view cũ; abort `ctx.signal` cũ; xóa `container`.
4. Tạo `AbortController` mới; gọi `render(container, ctx)`.
5. `render` phải:
   - render skeleton/khung ngay (đồng bộ) trước khi await,
   - dùng `ctx.signal` cho mọi fetch,
   - không throw ra ngoài; lỗi không xử lý được thì throw để router hiển thị error panel,
   - gắn test ID.
6. Khi rời view: router gọi `destroy()` trước hoặc song song với abort; view phải idempotent.
7. `destroy()` phải:
   - dừng mọi `CCTV.poll`, interval, timeout,
   - dừng mọi `CCTV.media` (MJPEG/audio/snapshot blob URL),
   - abort mọi fetch/`AbortController` riêng,
   - remove event listener trên `window`/`document`,
   - đóng modal/drawer do view mở,
   - không để lại audio đang phát.
8. Nếu `destroy()` ném lỗi, router log warning và vẫn tiếp tục điều hướng.
9. `onResume` chỉ được gọi khi tab visible lại và view hiện tại còn active; view tự quyết định refresh.

**Quy tắc cấm:**

- Không đọc/ghi `location.hash` trực tiếp; dùng `CCTV.router`.
- Không tự ý `location.reload()`.
- Không gọi `CCTV.views.register` hai lần cùng tên (throw).
- Không render dữ liệu trước khi xác thực.
- Không dùng `setInterval` trực tiếp; dùng `CCTV.poll`.
- Không thêm `<script>`/`<style>` động.
- Không dùng `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`.
- Không dùng `element.setAttribute('style', ...)`; nếu cần thanh tiến trình, set CSS custom property qua `element.style.setProperty`.

### 4.6 `CCTV.ui` — API component

Tất cả component trả về `HTMLElement` hoặc handle; không trả HTML string. Nội dung động luôn qua `textContent`/`CCTV.dom.el`.

```ts
CCTV.ui.button({label, variant:'primary'|'secondary'|'ghost'|'danger', icon?, onClick?, disabled?, ariaLabel?, title?, testId?}) -> HTMLButtonElement
CCTV.ui.iconButton({icon, label, onClick, variant?, testId?}) -> HTMLButtonElement
CCTV.ui.kpi({label, value, hint?, icon?, tone?, testId?}) -> HTMLElement
CCTV.ui.statusPill(status, {label?}) -> HTMLElement
CCTV.ui.badge(text, {tone?}) -> HTMLElement
CCTV.ui.banner({tone, title, message, actions?, dismissible?}) -> HTMLElement
CCTV.ui.progress({value, max, label?}) -> {el, setValue}
CCTV.ui.gauge({percent, label, valueText}) -> HTMLElement
CCTV.ui.tabs({tabs:[{id,label,icon?}], active, onChange, testId?}) -> {el, setActive, destroy}
CCTV.ui.switch({checked, label, description?, onChange, disabled?, testId?}) -> {el, setChecked, isChecked}
CCTV.ui.field({label, name, type:'text'|'password'|'number'|'date'|'time'|'textarea'|'select'|'checkbox', value?, options?, placeholder?, help?, required?, autocomplete?, testId?}) -> {el, getValue, setValue, setError, clearError, setDisabled}
CCTV.ui.search({placeholder, onInput, testId?}) -> {el, getValue, clear, focus}
CCTV.ui.toolbar({left:[Node], right:[Node]}) -> HTMLElement
CCTV.ui.pageHeader({title, subtitle?, actions?:Node[], testId?}) -> HTMLElement
CCTV.ui.pagination({page, pageSize, total, onChange, pageSizes?}) -> {el, setState}
CCTV.ui.skeleton({variant:'text'|'card'|'table'|'kpi', rows?}) -> HTMLElement
CCTV.ui.empty({icon?, title, description?, action?}) -> HTMLElement
CCTV.ui.errorPanel({title, message, code?, requestId?, retry?}) -> HTMLElement
CCTV.ui.table(options) -> TableHandle
CCTV.ui.modal(options) -> ModalHandle
CCTV.ui.drawer(options) -> DrawerHandle
CCTV.ui.confirm(options) -> Promise<boolean>
CCTV.ui.toast(message, options?) -> {close}
CCTV.ui.copy(text, {label?}) -> Promise<boolean>
CCTV.ui.openExternal(url) -> boolean // chỉ http(s)://IPv4-private, mở window.open(..., 'noopener,noreferrer')
```

- `openExternal` từ chối URL có `user:pass@`, hostname (chỉ IPv4 private/loopback), scheme khác http/https; nếu app đang HTTPS và URL HTTP → hiển thị cảnh báo mixed content trước khi mở; không dùng `location.href`.

**`CCTV.ui.table`:**

```ts
CCTV.ui.table({
  columns: [{
    key: string,
    label: string,
    sortable?: boolean,
    align?: 'left'|'right'|'center',
    width?: string,               // CSS width, ví dụ '120px'
    render?: (row) => Node | string, // string được set bằng textContent
    srLabel?: string
  }],
  rows: object[],
  rowKey: (row) => string,
  selectable?: boolean,
  selectedKeys?: string[],
  sort?: {key, dir:'asc'|'desc'},
  onSort?: (key, dir) => void,
  pageSize?: number,
  page?: number,
  total?: number,
  onPageChange?: (page, pageSize) => void,
  onRowClick?: (row) => void,
  onSelectionChange?: (keys: string[], rows: object[]) => void,
  loading?: boolean,
  emptyNode?: Node,
  caption: string,
  testId?: string,
  mobile?: 'cards'|'scroll'
}) -> {
  el: HTMLElement,
  update({rows?, loading?, selectedKeys?, sort?}): void,
  getSelection(): {keys:string[], rows:object[]},
  destroy(): void
}
```

- Header sortable có `aria-sort="ascending|descending|none"` và nút bên trong.
- Checkbox "chọn tất cả" chỉ chọn trang hiện tại; nhãn ghi rõ “Chọn trang này”.
- Không render HTML từ `render`; nếu trả string, component dùng `textContent`.
- Mobile `cards`: mỗi dòng thành card với label/value; vẫn giữ test ID.

**`CCTV.ui.modal`:**

```ts
CCTV.ui.modal({
  title: string,
  body: Node,
  footer?: Node | Node[],
  size?: 'sm'|'md'|'lg'|'xl',
  dismissible?: boolean,        // mặc định false cho form nguy hiểm
  initialFocus?: HTMLElement,
  dirtyCheck?: () => boolean,   // true = có thay đổi chưa lưu
  onClose?: () => void
}) -> {el, close, setBusy, setError}
```

- Tạo `<div class="c-modal-layer" role="presentation">` + `<div role="dialog" aria-modal="true" aria-labelledby=...>`.
- Focus trap: Tab/Shift+Tab quay vòng trong modal; focus vào phần tử đầu tiên hoặc `initialFocus`.
- Escape/backdrop: nếu `dismissible` và (`!dirtyCheck` hoặc `dirtyCheck()` false) thì đóng; nếu dirty thì mở confirm “Bỏ thay đổi?”.
- Đóng: restore focus về phần tử mở; remove listener.
- `setBusy(true)` disable footer buttons, `aria-busy`; `setError(message)` hiện lỗi trong modal, không đóng.
- Không dùng `alert()`/`confirm()` native.

**`CCTV.ui.drawer`:** tương tự modal, `role="dialog"`, đặt phải, full-screen mobile; có `dismissible` mặc định true.

**`CCTV.ui.confirm`:**

```ts
await CCTV.ui.confirm({
  title, message, details?: Node|string,
  confirmLabel='Xác nhận', cancelLabel='Huỷ',
  variant:'primary'|'danger',
  requireText?: string,     // người dùng phải gõ đúng chuỗi (so sánh trim, phân biệt hoa thường)
  requireTextLabel?: string
})
```

- Trả `false` khi huỷ/Escape.
- `requireText` hiển thị ô nhập và chỉ bật nút khi khớp.
- Không dùng confirm cho hành động không nguy hiểm (tránh mệt mỏi).

**`CCTV.ui.toast`:**

- Tối đa 3 toast; stack góc phải trên desktop, trên cùng mobile.
- `type`: success (icon check), error (icon alert, `role=alert`, duration 8s hoặc đóng tay), warning, info (4s).
- Không chứa dữ liệu nhạy cảm.

### 4.7 `CCTV.media`

```ts
CCTV.media.mjpeg(img: HTMLImageElement, {
  ip, subtype: '0'|'1', channel: 1|2,
  onState?: (state:'connecting'|'live'|'error', info?) => void
}) -> {stop(), restart(), setQuality(subtype), setChannel(channel)}

CCTV.media.audio({ip, subtype, channel}) -> {play():Promise<void>, stop(), el:HTMLAudioElement}
CCTV.media.snapshot(ip, {subtype?, channel?, download?:boolean}) -> Promise<{blob:Blob, url:string, filename:string|null}>
CCTV.media.revoke(url) -> void
CCTV.media.probe(ip, {subtype?, channel?}) -> Promise<{status:number, code:string|null, blob?:Blob, url?:string, filename?:string|null}>
```

**Quy tắc:**

- URL MJPEG: `/api/stream/mjpeg?ip=<ip>&subtype=<0|1>&channel=<1|2>&_=<timestamp>`; **không password**, không token.
- Audio: `/api/stream/audio?ip=...&subtype=...&channel=...&_=...`; chỉ phát sau user gesture.
- Snapshot: `fetch` với cookie, nhận blob; tạo object URL; caller phải `revoke` sau khi tải/không dùng.
- `probe` gọi snapshot và trả status; dùng để phân biệt 401/403/409/503 khi `<img>` lỗi. Nếu 200, trả blob cho view dùng làm poster; view phải revoke.
- Reconnect MJPEG: backoff 1s, 2s, 4s, 8s, 15s; tối đa 5 lần; khi 401 gọi `auth.handleUnauthenticated`; khi 503 `FFMPEG_UNAVAILABLE` dừng và bật banner; khi 409 mở luồng nhập credential (admin).
- `stop()` phải set `img.src=''`, remove handler, clear timer, abort fetch.
- Không dùng `EventSource`/WebSocket cho MJPEG.
- Không log URL media/stream để tránh lộ cấu trúc mạng; nếu cần debug, chỉ log path không query.

### 4.8 `CCTV.dom`, `CCTV.fmt`, `CCTV.poll`, `CCTV.icons`

```ts
CCTV.dom.el(tag, {
  class?, text?, attrs?, dataset?, on?, children?
}) -> HTMLElement
CCTV.dom.clear(node)
CCTV.dom.fragment(children)
CCTV.dom.text(node, value)
CCTV.dom.svg(name, {size?, label?}) -> SVGElement
CCTV.dom.safePath(url) -> string|null   // chỉ '/...' cùng origin, không '//'

CCTV.fmt.dateTime(v) -> string   // 'HH:mm:ss DD/MM/YYYY'
CCTV.fmt.date(v) -> string
CCTV.fmt.relative(v) -> string
CCTV.fmt.bytes(n) -> string
CCTV.fmt.duration(sec) -> string // '1 giờ 02 phút'
CCTV.fmt.number(n) -> string
CCTV.fmt.percent(n) -> string
CCTV.fmt.status(v) -> {label, tone, icon}
CCTV.fmt.errorCode(code) -> string

CCTV.poll(fn, {intervalMs, immediate?, maxBackoffMs?, pauseWhenHidden?}) -> stop()
CCTV.icons.svg(name, {size?, label?}) -> SVGElement
CCTV.icons.exists(name) -> boolean
```

- `CCTV.dom.el` **không** nhận `html`; nếu truyền `html` → throw trong dev, bỏ qua trong production.
- `attrs` chỉ cho phép thuộc tính an toàn; `href` chỉ nhận `#...` hoặc `/...`; `src` chỉ nhận `/static/...`, `/snapshots/...`, blob URL do chính app tạo.
- `CCTV.fmt.dateTime` chấp nhận cả `YYYY-MM-DD HH:mm:ss` và ISO 8601; nếu không parse được trả chuỗi gốc.
- `CCTV.poll` dừng khi `document.hidden` (nếu `pauseWhenHidden`), chạy lại ngay khi visible; backoff nhân đôi khi lỗi, reset khi thành công; `fn` nhận `AbortSignal`.

### 4.9 Catalog component và class CSS

Tên class theo BEM rút gọn: `.c-<component>`, modifier `.c-<component>--<variant>`, trạng thái `.is-*`, tiện ích `.u-*`. View CSS chỉ được style trong phạm vi `.view-<name>`.

| Component | Class gốc | Owner | Ghi chú |
|---|---|---|---|
| App shell | `.c-shell` | Foundation | Grid sidebar/topbar/main |
| Sidebar | `.c-sidebar` | Foundation | Nav, collapse, footer |
| Topbar | `.c-topbar` | Foundation | Title, health, user menu |
| Page header | `.c-page-header` | Foundation | |
| Card | `.c-card` | Foundation | `header/body/footer` |
| KPI | `.c-kpi` | Foundation | Số lớn, tone |
| Banner | `.c-banner` | Foundation | tone info/warning/danger |
| Table | `.c-table` | Foundation | Wrap scroll, sticky header |
| Toolbar | `.c-toolbar` | Foundation | |
| Badge | `.c-badge` | Foundation | |
| Status pill | `.c-status` | Foundation | icon + text, `data-status` |
| Switch | `.c-switch` | Foundation | native input + track |
| Tabs | `.c-tabs` | Foundation | role tablist |
| Modal | `.c-modal` | Foundation | layer, dialog, footer |
| Drawer | `.c-drawer` | Foundation | |
| Confirm | `.c-confirm` | Foundation | alertdialog |
| Toast | `.c-toast` | Foundation | stack, aria-live |
| Skeleton | `.c-skeleton` | Foundation | shimmer (reduced-motion off) |
| Empty | `.c-empty` | Foundation | |
| Gauge | `.c-gauge` | Foundation | SVG vòng cung |
| Progress | `.c-progress` | Foundation | |
| Form field | `.c-field` | Foundation | label/help/error |
| Input/Select/Textarea | `.c-input`, `.c-select`, `.c-textarea` | Foundation | |
| Checkbox/Radio | `.c-check`, `.c-radio` | Foundation | |
| Chip | `.c-chip` | Foundation | |
| Pagination | `.c-pagination` | Foundation | |
| Menu | `.c-menu` | Foundation | user menu, row actions |
| Tooltip | `.c-tooltip` | Foundation | CSS + `aria-describedby` |
| Video tile | `.c-video-tile` | Live view | dùng component con của Foundation |
| PTZ pad | `.c-ptz` | Live view | |
| Scan results | `.c-scan-*` | Scanner view | |
| SD gauge layout | `.c-sd-*` | Storage view | |

**Quy tắc CSS:**

- `app.css` chứa reset, token, layout, component, utility tối thiểu, responsive chung.
- Mỗi view có file `static/css/views/<name>.css`, chỉ chứa rule bắt đầu bằng `.view-<name>`; không override token/component toàn cục.
- Không dùng `!important` trừ utility `.u-hidden`/`.u-sr-only`.
- Không dùng inline style trong HTML; JS được set CSS custom property qua `element.style.setProperty`.
- Không import font/ảnh ngoài; icon là sprite inline trong `index.html`.
- Không dùng `@import`; thứ tự `<link>` do Foundation quy định.

### 4.10 Quy ước lỗi, toast, confirm, modal, bảng

1. **Lỗi field:** hiển thị dưới field, `aria-invalid`, focus vào field lỗi đầu tiên; không toast.
2. **Lỗi thao tác:** toast `error` + giữ modal mở; nếu lỗi 409/503 có hướng dẫn cụ thể.
3. **Thành công:** toast `success` ngắn; đóng modal; refresh dữ liệu liên quan; không reload trang.
4. **Xác nhận:** mọi hành động phá huỷ dùng `CCTV.ui.confirm`; format/đổi IP/đổi mật khẩu hàng loạt/reboot dùng `requireText`.
5. **Modal form:** không đóng khi click ra ngoài/Escape nếu `dirtyCheck()` true; hỏi “Bỏ thay đổi?”.
6. **Bảng:** loading dùng skeleton trong `tbody`; empty dùng `emptyNode`; lỗi dùng error panel phía trên bảng, giữ dữ liệu cũ nếu có.
7. **Phân trang:** client-side cho danh sách ≤500; server-side nếu API hỗ trợ (alarm history có `limit/offset`).
8. **Sắp xếp:** client-side cho scan/cameras/alerts; giữ sort khi refresh nếu có thể.
9. **Chọn hàng loạt:** hiển thị thanh batch sticky dưới toolbar; nút xoá chọn khi đổi bộ lọc (tránh thao tác nhầm).
10. **Số liệu:** `tabular-nums`; không làm tròn gây hiểu nhầm (dung lượng 2 chữ số thập phân).

### 4.11 Checklist bắt buộc cho từng view agent

- [ ] Đăng ký đúng `name`, `title`, `icon`, `roles`, `order`.
- [ ] `render` vẽ skeleton đồng bộ trước khi await.
- [ ] Mọi fetch dùng `CCTV.api` + `ctx.signal`.
- [ ] `destroy` dừng poller/media/modal/listener; gọi lại nhiều lần không lỗi.
- [ ] Không có nút admin khi viewer (dùng `data-admin-only` và kiểm tra `ctx.isAdmin`).
- [ ] Không lưu/không hiển thị mật khẩu; field mật khẩu chỉ transient, clear sau submit/đóng.
- [ ] Không `innerHTML`/`eval`/inline handler.
- [ ] Dùng `textContent` cho mọi dữ liệu từ API.
- [ ] Xử lý đủ 401/403/409/429/503 theo §4.2.
- [ ] Có đủ test ID trong §2.9.
- [ ] Responsive tại 360/768/1024/1440px.
- [ ] Bàn phím + screen reader cho luồng chính.
- [ ] Không tự quét mạng/không tự gọi hành động nguy hiểm khi mount.
- [ ] Không dùng emoji trong chrome.
- [ ] Không thêm dependency/CDN.

---

## 5. CẤU TRÚC FILE VÀ QUYỀN SỞ HỮU

### 5.1 Cây file sau khi hoàn thành

```
CCTVVisionHub/
├─ app.py                     # route mỏng + bootstrap server
├─ security.py                # NEW: scrypt, session, CSRF, rate limit, headers, decorators
├─ settings_store.py          # NEW: settings canonical, whitelist, migration, secret flags
├─ credentials.py             # NEW: resolve credential + ephemeral session credential
├─ camera_urls.py             # NEW: build RTSP URL theo hãng (dùng chung app/alarm/tracking)
├─ camera_media.py            # NEW: FFmpeg status, semaphore, MJPEG/audio/snapshot/recording
├─ managed_manager.py         # sửa: sanitize, lock, status enum, atomic save
├─ alarm_manager.py           # sửa: grace, canonical keys, camera_urls, snapshot
├─ telegram_service.py        # sửa: TLS strict, redact token, timeout
├─ scan_imou.py               # sửa: bỏ Ruijie/fake, cap target, giữ protocol thật
├─ onvif_manager.py           # sửa: XML escape, bỏ CGI password query, validate IP
├─ cctv_tray.py               # sửa: không gọi API không auth; mở web hoặc login có CSRF
├─ dahua/                     # VENDORED, pure-stdlib; BẮT BUỘC đóng gói
│  ├─ __init__.py             # import DahuaClient, EventListener, HttpMediaClient, ...
│  ├─ aio.py, client.py, const.py, discovery.py, events.py,
│  │  exceptions.py, media.py, rtsp.py, transport.py, cli.py
│  └─ __pycache__/            # KHÔNG đóng gói
├─ android/                   # nguồn APK v2 (owner A — Release); build outputs bị loại
│  ├─ app/src/main/AndroidManifest.xml
│  ├─ app/src/main/java/com/cctv/visionhub/MainActivity.java
│  └─ app/build.gradle, build.gradle, settings.gradle, gradle.properties
├─ scripts/
│  ├─ build_apk.sh            # REWRITE: build offline, keystore từ env, output dist/
│  └─ harden_windows_acl.ps1  # NEW: ACL settings/managed/data/logs
├─ build_windows.py           # sửa: add-data dahua/templates/static con, không static APK/ZIP
├─ build_exe.bat              # sửa: hỏi trước khi pip install, gọi build_windows.py
├─ templates/
│  └─ index.html              # REWRITE: login + shell + sprite, không inline script
├─ static/
│  ├─ css/
│  │  ├─ app.css              # NEW: token/reset/layout/component
│  │  └─ views/
│  │     ├─ dashboard.css     # NEW (C1)
│  │     ├─ live.css          # NEW (C2)
│  │     ├─ cameras.css       # NEW (C3)
│  │     ├─ scanner.css       # NEW (C4)
│  │     ├─ storage.css       # NEW (C5)
│  │     ├─ alarms.css        # NEW (C6)
│  │     └─ settings.css      # NEW (C7)
│  ├─ js/
│  │  ├─ core.js              # NEW (B): CCTV.*, boot, router, components
│  │  └─ views/
│  │     ├─ dashboard.js      # NEW (C1)
│  │     ├─ live.js           # NEW (C2)
│  │     ├─ cameras.js        # NEW (C3)
│  │     ├─ scanner.js        # NEW (C4)
│  │     ├─ storage.js        # NEW (C5)
│  │     ├─ alarms.js         # NEW (C6)
│  │     └─ settings.js       # NEW (C7)
│  ├─ icons/                  # giữ + có thể bổ sung icon PWA
│  ├─ download/               # APK v2 (không commit nếu chưa build; phục vụ qua /download/app.apk)
│  ├─ offline.html            # NEW (B)
│  ├─ manifest.json           # sửa (B)
│  └─ sw.js                   # sửa (B)
├─ tests/
│  ├─ __init__.py             # NEW (A)
│  ├─ support.py              # NEW (A): WSGI test client, temp config, helpers
│  ├─ test_security.py        # NEW (A)
│  ├─ mock_telegram.py        # NEW (A): mock HTTP/HTTPS Telegram local
│  ├─ verify_project.py       # NEW (B)
│  ├─ ui_smoke.py             # NEW (B)
│  └─ fixtures/
│     ├─ scan_devices.json    # NEW (A): dữ liệu test, dải riêng 10.255.255.0/24
│     ├─ scan/                 # NEW (A): DHIP packet, ONVIF XML, SADP XML fixture
│     ├─ forbidden_patterns.json # NEW (A): regex nhạy cảm cho V24, không giá trị thật
│     ├─ settings.test.json   # NEW (A): không secret thật
│     └─ camera/              # NEW (A): frame.jpg, sample.mp4, sample.mp3 cho fake backend
├─ dist/                      # artifact phát hành (ZIP/APK), KHÔNG commit, KHÔNG web root
├─ build/                     # PyInstaller tạm, KHÔNG commit
├─ data/                      # runtime, KHÔNG commit, KHÔNG đóng gói
│  ├─ bootstrap_admin.txt     # chỉ khi first-run, xoá sau đổi mật khẩu
│  └─ ...                     # settings.json/managed_cameras.json nếu dùng data dir
├─ logs/                      # runtime, KHÔNG commit, KHÔNG đóng gói
│  └─ audit.jsonl
├─ docs/
│  ├─ UI_REBUILD_SPEC.md      # tài liệu này (Product owner); KHÔNG đóng gói phát hành
│  ├─ BUILD_APK_GUIDE.md      # cập nhật: APK v2, không IP/PIN/keystore
│  └─ REMOTE_ACCESS_GUIDE.md  # rà soát, xoá IP/serial/VLAN nội bộ
├─ Dockerfile                 # sửa (A)
├─ .dockerignore              # NEW (A)
├─ docker-compose.yml         # sửa (A)
├─ .gitignore                 # NEW (A)
├─ package_windows.py         # sửa (A)
├─ requirements.txt           # giữ dependency hiện có; dahua/ là vendored, KHÔNG thêm package
└─ (xóa/khóa) static/CCTVVisionHub_Windows.zip, static/CCTVVisionHub.apk,
         app_crash.log, app_test.log, gibberish_aes.js,
         android/app/build/**, CCTVVisionHub.apk cũ (xoá hẳn, không giữ trong dist/),
         các đoạn fake trong scan_imou.py/index.html
```

### 5.2 Bảng quyền sở hữu file

| File/thư mục | Owner | Được phép sửa bởi | Ghi chú |
|---|---|---|---|
| `app.py` | **A — Backend/Security** | A | Không ai khác sửa route |
| `security.py` | A | A | File mới |
| `settings_store.py` | A | A | File mới |
| `credentials.py` | A | A | File mới |
| `camera_urls.py` | A | A | File mới |
| `camera_media.py` | A | A | File mới |
| `managed_manager.py` | A | A | |
| `alarm_manager.py` | A | A | |
| `telegram_service.py` | A | A | |
| `scan_imou.py` | A | A | Bỏ dữ liệu giả/Ruijie; giữ protocol |
| `onvif_manager.py` | A | A | Bỏ default `admin`, resolve username/password |
| `cctv_tray.py` | A | A | Không gọi API không auth; đọc port env |
| `dahua/**` | A | A | Vendored pure-stdlib; không sửa protocol nếu không cần; phải đóng gói |
| `android/**` (trừ `app/build/**`) | A — Release | A | Nguồn APK v2 |
| `scripts/build_apk.sh` | A — Release | A | Build offline, keystore từ env, output `dist/` |
| `scripts/harden_windows_acl.ps1` | A | A | ACL thủ công khi deploy |
| `build_windows.py`, `build_exe.bat` | A — Release | A | Không nhúng static APK/ZIP; hỏi trước pip install |
| `tests/test_security.py` | A | A | |
| `tests/support.py`, `tests/__init__.py` | A | A | |
| `tests/fixtures/*`, `tests/fixtures/camera/*` | A | A | Chỉ dùng cho test; không phát hành |
| `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.gitignore` | A | A | |
| `package_windows.py` | A | A | Bao gồm `dahua/`; loại secret/log/APK/ZIP |
| `templates/index.html` | **B — Foundation UI** | B | Login, shell, sprite, script/link tags |
| `static/css/app.css` | B | B | Token/layout/component |
| `static/js/core.js` | B | B | `CCTV.*`, router, components, boot |
| `static/sw.js` | B | B | SW v2 |
| `static/manifest.json` | B | B | |
| `static/offline.html` | B | B | |
| `static/icons/*` | B | B | Giữ icon hiện có; thêm nếu cần |
| `tests/verify_project.py` | B | B | Kiểm tra tĩnh |
| `tests/ui_smoke.py` | B | B | HTTP smoke |
| `static/js/views/dashboard.js` + `static/css/views/dashboard.css` | **C1** | C1 | Không sửa file khác |
| `static/js/views/live.js` + `static/css/views/live.css` | **C2** | C2 | |
| `static/js/views/cameras.js` + `static/css/views/cameras.css` | **C3** | C3 | |
| `static/js/views/scanner.js` + `static/css/views/scanner.css` | **C4** | C4 | |
| `static/js/views/storage.js` + `static/css/views/storage.css` | **C5** | C5 | |
| `static/js/views/alarms.js` + `static/css/views/alarms.css` | **C6** | C6 | |
| `static/js/views/settings.js` + `static/css/views/settings.css` | **C7** | C7 | |
| `docs/UI_REBUILD_SPEC.md` | **Product** | Không agent nào | Chỉ Product cập nhật; không đóng gói phát hành |
| `docs/BUILD_APK_GUIDE.md`, `README.md` | **B** | B | Nội dung UI/PWA; không PIN/IP/serial/keystore |
| `HUONG_DAN_SU_DUNG_WINDOWS.txt`, `README_RESTORE_HUONG_DAN.txt` | **A** | A | Nội dung vận hành/bảo mật; không PIN/IP nội bộ |
| `docs/REMOTE_ACCESS_GUIDE.md`, `AGY_INSTRUCTIONS.md` | **A** | A | Rà soát/xóa IP/serial/VLAN/site label nội bộ |

### 5.3 Quy tắc cho từng nhóm

**Agent A — Backend/Security:**

- Được tạo/xóa/sửa file backend, test bảo mật, Docker/packaging, `dahua/`, `android/`, build scripts.
- Không sửa file UI (`templates/`, `static/css`, `static/js`) trừ khi được Product cho phép bằng văn bản trong tài liệu này.
- Phải giữ `dahua/` trong PYTHONPATH, Docker image, ZIP phát hành và test import.
- Mọi route mới phải có decorator phân quyền và được thêm vào §6/§7 (nếu cần, cập nhật tài liệu trước).
- Không chạy server ngoài test mode; không gọi camera/Telegram thật.
- Phải cung cấp test server/test fixture cho B và C.

**Agent B — Foundation UI:**

- Sở hữu `index.html`, `app.css`, `core.js`, `sw.js`, `manifest.json`, `offline.html`, sprite icon.
- Tạo khung `<script defer>` cho 7 view và `<link>` cho 7 view CSS ngay từ đầu, kể cả khi file view chưa tồn tại.
- Không định nghĩa logic nghiệp vụ của view; không hardcode dữ liệu camera.
- Cung cấp đủ component/API trong §4 trước khi C bắt đầu; nếu thiếu, bổ sung không phá API.
- Không sửa file view của C.
- Chịu trách nhiệm `verify_project.py` và `ui_smoke.py`.

**Agent C1–C7 — View:**

- Chỉ sửa đúng 2 file của mình: `static/js/views/<name>.js` và `static/css/views/<name>.css`.
- Không sửa `core.js`, `app.css`, `index.html`, backend, test của người khác.
- Nếu thiếu API/component: báo Product/Foundation; không tự thêm endpoint hay copy component.
- Có thể đọc mọi file để hiểu hợp đồng.
- Phải tự chạy `node --check` file JS của mình và kiểm tra thủ công/test server.
- Không thêm dependency, không CDN, không emoji chrome, không innerHTML.

### 5.4 Quy trình thay đổi hợp đồng

1. Phát hiện thiếu/sai hợp đồng → ghi rõ trong báo cáo, không tự sửa ngoài phạm vi.
2. Product cập nhật `docs/UI_REBUILD_SPEC.md` (version + changelog).
3. A/B cập nhật implementation; C cập nhật view.
4. Chạy lại toàn bộ test trước khi merge.

### 5.5 Thứ tự triển khai và điểm đồng bộ

| Pha | Agent | Deliverable | Điều kiện để pha sau bắt đầu |
|---|---|---|---|
| P0 | Product | Tài liệu này | Đã chốt |
| P1 | A | `security.py`, `settings_store.py`, `credentials.py`, `/api/auth/*`, `/api/health`, `/api/system/status`, decorators, test fixture + test server chạy được | `test_security.py` phần auth/CSRF/role pass; test server 18080 lên được |
| P2 | B | Shell/login/core/components/CSP, `verify_project.py`, `ui_smoke.py` khung | Login admin/viewer chạy với backend P1; `verify_project` pass phần cấu trúc |
| P3 | C1–C7 | 7 view + CSS | Có thể bắt đầu ngay sau P0 bằng hợp đồng; cần P1/P2 để chạy thật |
| P4 | A | Toàn bộ endpoint còn lại + packaging/Docker | `test_security.py` đầy đủ pass |
| P5 | B + A | Integration, `ui_smoke.py` đầy đủ, fake camera fixture, kiểm tra chéo | Tất cả test pass |
| P6 | A — Release | APK v2 (`android/`, `scripts/build_apk.sh`), ZIP sạch, SHA-256, Docker image | APK cài được + `/download/app.apk` trả file đúng hash; ZIP/Docker không secret |
| P7 | Product/QA | Kiểm toán độc lập, checklist thủ công, sign-off | §14 pass; release blocker APK resolved |

**Điểm đồng bộ bắt buộc:**

- Cuối P1: A gửi B/C danh sách route thực tế + fixture + cách chạy test server.
- Cuối P2: B gửi C bản `core.js` API final + component catalog + test ID.
- Trước P5: C gửi B danh sách selector/test ID đã dùng để B hoàn thiện `ui_smoke`.
- Trước sign-off: A chạy `test_security.py`; B chạy `verify_project.py` + `ui_smoke.py`; Product chạy lại toàn bộ.

---

## 6. HỢP ĐỒNG API ĐẦY ĐỦ

### 6.1 Quy ước chung

**Base:** cùng origin, đường dẫn tương đối. Không CORS, không API key, không `X-Admin-Token`.

**Content type:**

- Request có body: `Content-Type: application/json; charset=utf-8`. Server trả 415 nếu khác (trừ GET/HEAD).
- Response JSON: `application/json; charset=utf-8`.
- Media: `multipart/x-mixed-replace`, `audio/mpeg`, `image/jpeg`, `video/mp4`, `text/csv`.

**Envelope thành công:**

```json
{ "ok": true, "...": "..." }
```

**Envelope lỗi (thay thế hoàn toàn `error` dạng chuỗi cũ):**

```json
{
  "ok": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Bạn không có quyền thực hiện thao tác này.",
    "details": null,
    "request_id": "f0c1a2..."
  }
}
```

- `message` luôn tiếng Việt, không chứa stack trace, không chứa secret.
- `details` chỉ chứa dữ liệu an toàn (ví dụ danh sách field lỗi, `retry_after_seconds`).
- `request_id` lấy từ header `X-Request-Id` nếu khớp `^[A-Za-z0-9_-]{8,64}$`; ngược lại server sinh mới (chống header injection).

**Header phản hồi chung cho `/api/*`:**

- `X-CCTV-API-Version: 2`
- `X-Request-Id: <id>`
- `Cache-Control: no-store, no-cache, must-revalidate`
- `Pragma: no-cache`
- Security headers theo §9.1.

**Giới hạn request:**

| Hạng mục | Giới hạn |
|---|---|
| JSON body | 1 MiB (login 4 KiB; settings 64 KiB) |
| Query string | 2 KiB |
| Số phần tử batch | 100 camera/lần (managed batch 500) |
| Số target scan | 8 biểu thức, tổng host ≤1024 |
| Timeout server cho thao tác camera | 5–15s tùy endpoint |
| Số session | 500 |
| Số stream | xem §12.3 |

- Mỗi endpoint dùng chung bảng mã lỗi §6.12; phần đặc tả endpoint chỉ nêu lỗi đặc thù ngoài các lỗi chung (401/403/CSRF/validation/429/503).

**Thứ tự kiểm tra bắt buộc trong server:**

1. Host allowlist → 400 `HOST_NOT_ALLOWED`.
2. Route/method → 404/405.
3. Session (trừ public) → 401 `UNAUTHENTICATED`.
4. Role → 403 `FORBIDDEN`.
5. CSRF + Origin (mọi method thay đổi trạng thái) → 403 `CSRF_INVALID`/`ORIGIN_MISMATCH`.
6. Content-Type + kích thước + JSON parse → 415/413/400.
7. Validate định dạng input → 400 `VALIDATION_ERROR`/`INVALID_IP`/`INVALID_SUBNET`.
8. **Target scope:** viewer + IP ngoài managed/public → 404 `CAMERA_NOT_FOUND`; admin + IP public khi không cho phép → 400 `INVALID_IP`.
9. **Rate limit** → 429 (kể cả trong test mode; trước test-mode block để E03 trả 429).
10. **Theo lớp endpoint:**
    - **Lớp media/camera-lifecycle** (`stream`, `audio`, `snapshot`, `record/start|stop|status`, `ptz`, `camera/details`, `hardware/status`, `storage/info`, `storage/recordings`): nếu fake backend + IP fixture → fake; ngược lại credential resolution → 409, rồi test-mode block → 503.
    - **Lớp destructive/batch/settings** (`storage/format`, `storage/watchdog/check_now`, `reboot`, `batch-ip`, `batch_change_password`, `sync-time`, `alarm/test`, `stream/open`, `settings/open-folder`): nếu fake backend + IP fixture → fake; ngược lại test-mode block → 503 trước, rồi credential resolution → 409.
11. Nghiệp vụ → 404/409/502/503/500.

- Với `CCTV_TEST_FAKE_CAMERA=1` **và IP thuộc `10.255.255.0/24`**: cả hai lớp dùng fake backend, bỏ qua credential/FFmpeg và trả fixture/200 mô phỏng; không thực hiện hành động thật. Với IP ngoài fixture, lớp destructive vẫn 503 `TEST_MODE_BLOCKED`.

**Domain failure:** không dùng HTTP 200 `{ok:false}` cho hành động một camera. Camera từ chối/không kết nối → **502 `CAMERA_OPERATION_FAILED`** với envelope lỗi. Ngoại lệ: các endpoint batch (`batch-ip`, `reboot`, `sync-time`, `batch_change_password`) trả **200 `{ok:true, total, success_count, failed_count, results}`** sau khi xử lý; `ok:true` chỉ nghĩa “đã xử lý xong”, UI phải đọc `success_count`/`results`. `CCTV.api` phải kiểm tra cả `ok` trên HTTP 2xx và ném `ApiError` nếu `ok:false`.

**Định nghĩa “method thay đổi trạng thái”:** `POST`, `PUT`, `PATCH`, `DELETE`. Tất cả đều cần CSRF, kể cả khi body rỗng (gửi `{}`).

**Không bao giờ trả về:** `password`, `new_password`, `admin_password`, `admin_password_hash`, `viewer_password_hash`, `telegram_bot_token`, `telegram_chat_id` (raw), session token, CSRF của session khác, đường dẫn tuyệt đối ngoài phạm vi cho viewer.

### 6.2 Bảng route tổng và trạng thái

| # | Route cũ | Trạng thái | Route mới/thay thế |
|---|---|---|---|
| 1 | `GET /` | Giữ | `GET /` (index có login) |
| 2 | `GET /static/<path>` | Giữ, siết allowlist | `GET /static/<path>` |
| 3 | `GET /manifest.json` | Giữ | |
| 4 | `GET /sw.js` | Giữ, nội dung mới | |
| 5 | `GET /favicon.ico` | Giữ | |
| 6 | `GET /api/scan` | Giữ, admin | |
| 7 | `GET /api/scan/vlans` | Giữ, admin, sửa contract | |
| 8 | `POST /api/stream/open` | Giữ, admin, bỏ `rtsp_url` | |
| 9 | `GET /api/stream/mjpeg` | Giữ, viewer, bỏ `password` | |
| 10 | `GET /api/stream/audio` | Giữ, viewer, bỏ `password` | |
| 11 | `GET /api/snapshot` | Giữ, viewer, bỏ `password` | |
| 12 | `POST /api/record/start` | Giữ, admin | |
| 13 | `POST /api/record/stop` | Giữ, admin | |
| 14 | `GET /api/record/status` | Giữ, viewer, có dùng trong UI | |
| 15 | `GET /api/recordings/<filename>` | Giữ, viewer, validate path | |
| 16 | `GET /api/export` | Giữ, admin, chống CSV injection | |
| 17 | `POST /api/ptz` | Giữ, admin | |
| 18 | `POST /api/batch-ip` | Giữ, admin, confirm | |
| 19 | `POST /api/reboot` | Giữ, admin, confirm | |
| 20 | `POST /api/sync-time` | Giữ, admin | |
| 21 | `GET /api/settings` | Giữ, **admin only** | |
| 22 | `POST /api/settings` | Giữ, admin, whitelist | |
| 23 | `POST /api/settings/open-folder` | Giữ, admin | |
| 24 | `GET /snapshots/<path>` | Giữ, viewer, validate path | |
| 25 | `GET /api/alarm/status` | Giữ, viewer | |
| 26 | `POST /api/alarm/toggle` | Giữ, admin, confirm khi tắt | |
| 27 | `POST /api/alarm/test` | Giữ, admin, chỉ dùng cấu hình đã lưu | |
| 28 | `GET /api/alarm/history` | Giữ, viewer, limit/offset | |
| 29 | `POST /api/alarm/clear_history` | Giữ, admin | |
| 30 | `GET /api/camera/details` | Giữ, viewer, bỏ `password` | |
| 31 | `POST /api/camera/name` | Giữ, admin | |
| 32 | `POST /api/admin/login` | **XÓA** | `POST /api/auth/login` |
| 33 | `POST /api/admin/change_password` | **XÓA** | `POST /api/auth/change_password` |
| 34 | `GET /api/admin/verify` | **XÓA** | `GET /api/auth/me` |
| 35 | `POST /api/admin/logout` | **XÓA** | `POST /api/auth/logout` |
| 36 | `POST /api/batch_change_password` | Giữ, admin, không trả mật khẩu | |
| 37 | `GET /api/hardware/status` | Giữ, viewer, bỏ `password` | |
| 38 | `POST /api/hardware/privacy` | Giữ, admin | |
| 39 | `POST /api/hardware/tracking` | Giữ, admin | |
| 40 | `POST /api/hardware/siren` | Giữ, admin, confirm khi bật | |
| 41 | `GET /api/storage/info` | Giữ, viewer, bỏ `password` | |
| 42 | `POST /api/storage/format` | Giữ, admin, confirm bắt buộc | |
| 43 | `GET /api/storage/recordings` | Giữ, viewer, bỏ `password` | |
| 44 | `POST /api/storage/watchdog/check_now` | Giữ, admin | |
| 45 | `GET /api/managed/cameras` | Giữ, viewer, sanitize | |
| 46 | `POST /api/managed/cameras` | Giữ, admin | |
| 47 | `PUT /api/managed/cameras/<id>` | Giữ, admin | |
| 48 | `DELETE /api/managed/cameras/<id>` | Giữ, admin | |
| 49 | `POST /api/managed/cameras/test` | Giữ, admin, private IP | |
| 50 | `POST /api/managed/cameras/sync` | Giữ, admin, không trả password | |
| 51 | `POST /api/managed/cameras/toggle-alarm` | Giữ, admin | |
| 52 | — | **MỚI** | `GET /api/health` (public) |
| 53 | — | **MỚI** | `POST /api/auth/login` (public) |
| 54 | — | **MỚI** | `GET /api/auth/me` (public) |
| 55 | — | **MỚI** | `POST /api/auth/logout` (auth + CSRF) |
| 56 | — | **MỚI** | `POST /api/auth/change_password` (admin + CSRF) |
| 57 | — | **MỚI** | `GET /api/system/status` (viewer) |
| 58 | — | **MỚI** | `POST /api/cameras/credentials` (admin + CSRF) |
| 59 | — | **MỚI** | `DELETE /api/cameras/credentials/<ip>` (admin + CSRF) |
| 60 | — | **MỚI** | `GET /download/app.apk` (viewer) |

### 6.3 Auth, health, system status, settings

#### `POST /api/auth/login` — public

**Request:**

```json
{ "username": "admin", "password": "..." }
```

- `username` bắt buộc, chỉ `admin` hoặc `viewer`; trim, lowercase.
- `password` bắt buộc, 1–128 ký tự.
- Không nhận `token`, `remember`, `role` ngoài `username`.

**200:**

```json
{
  "ok": true,
  "role": "admin",
  "user": { "username": "admin", "display_name": "Quản trị viên" },
  "csrf_token": "<43 ký tự>",
  "expires_at": "2026-11-05T18:00:00+07:00",
  "first_run": false
}
```

- `Set-Cookie: cctv_sid=<token>; Path=/; Max-Age=<TTL>; HttpOnly; SameSite=Strict[; Secure]`; `TTL` mặc định 43200, lấy từ `CCTV_SESSION_TTL_SECONDS`.
- Không trả session token trong JSON.
- `first_run=true` khi đang dùng mật khẩu bootstrap; `false` khi đã đổi mật khẩu.

**Lỗi:**

| HTTP | Code | Khi nào |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Thiếu username/password hoặc body sai định dạng |
| 401 | `INVALID_CREDENTIALS` | Sai mật khẩu **hoặc username lạ** (cùng message, dummy scrypt) |
| 403 | `VIEWER_LOGIN_DISABLED` | Viewer chưa được đặt mật khẩu |
| 429 | `RATE_LIMITED` | Vượt rate limit; `details.retry_after_seconds` |
| 503 | `SETUP_REQUIRED` | Chưa có hash admin và không tạo được bootstrap (lỗi cấu hình) |

#### `GET /api/auth/me` — public

**200 (đã đăng nhập):**

```json
{
  "ok": true,
  "authenticated": true,
  "role": "admin",
  "user": { "username": "admin", "display_name": "Quản trị viên" },
  "csrf_token": "<43 ký tự>",
  "expires_at": "2026-11-05T18:00:00+07:00",
  "first_run": false,
  "viewer_login_enabled": true,
  "api_version": 2,
  "app_version": "2.0.0"
}
```

**200 (chưa đăng nhập):**

```json
{
  "ok": true,
  "authenticated": false,
  "role": null,
  "first_run": false,
  "viewer_login_enabled": true,
  "api_version": 2,
  "app_version": "2.0.0"
}
```

- Không set cookie mới nếu chưa đăng nhập.
- Nếu cookie có nhưng session hết hạn/không tồn tại: trả `authenticated:false` + `Set-Cookie` xoá cookie.
- `first_run` phản ánh `admin_password_bootstrap` và có thể `true` ngay cả khi chưa đăng nhập.
- `viewer_login_enabled` phản ánh việc đã đặt `viewer_password_hash`.
- `Cache-Control: no-store`.

#### `POST /api/auth/logout` — admin/viewer + CSRF

**Request:** `{}`.

**200:** `{ "ok": true }`; xoá cookie; thu hồi session; `Clear-Site-Data: "cache", "storage"`; audit `logout`.

**Lỗi:** 401 nếu chưa đăng nhập; 403 `CSRF_INVALID`.

#### `POST /api/auth/change_password` — admin + CSRF

**Request đổi mật khẩu admin:**

```json
{
  "target": "admin",
  "current_password": "...",
  "new_password": "..."
}
```

**Request đổi/đặt mật khẩu viewer:**

```json
{
  "target": "viewer",
  "current_password": "<mật khẩu admin hiện tại>",
  "new_password": "..."
}
```

**Request tắt đăng nhập viewer:**

```json
{
  "target": "viewer",
  "current_password": "<mật khẩu admin hiện tại>",
  "clear_viewer": true
}
```

**200:**

```json
{ "ok": true, "reauth_required": true, "revoked_sessions": 3 }
```

- Mọi thay đổi mật khẩu, đặt hoặc xoá mật khẩu viewer đều thu hồi **toàn bộ** session (admin + viewer), xoá cookie hiện tại; client quay về login.
- `revoked_sessions` là số session bị thu hồi (số nguyên ≥ 1).
- `reauth_required` luôn `true` cho đến khi client đăng nhập lại.
- `Clear-Site-Data: "cache", "storage"`.
- Ghi audit, không ghi mật khẩu.

**Lỗi:**

| HTTP | Code | Khi nào |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Thiếu field, mật khẩu mới <10/>128, trùng mật khẩu cũ, mật khẩu phổ biến |
| 401 | `INVALID_CREDENTIALS` | `current_password` sai |
| 403 | `FORBIDDEN` | Không phải admin |
| 409 | `SECRETS_MANAGED_EXTERNALLY` | `CCTV_SECRETS_FILE` đang quản lý hash |
| 429 | `RATE_LIMITED` | Quá nhiều lần thử |

#### `GET /api/health` — public

**200:**

```json
{
  "ok": true,
  "status": "ok",
  "api_version": 2,
  "app_version": "2.0.0",
  "uptime_seconds": 1234,
  "time": "2026-11-05T14:03:00+07:00",
  "ffmpeg": { "available": false, "version": null, "audio_available": false },
  "tls": false,
  "alarm": { "running": true, "armed": true, "grace_remaining_seconds": 0 },
  "storage": { "recordings_writable": true, "snapshots_writable": true },
  "mode": "production"
}
```

- `status`: `ok` hoặc `degraded` (FFmpeg thiếu hoặc thư mục không ghi được).
- Không trả đường dẫn tuyệt đối, không secret, không IP.
- `mode`: `production` hoặc `test`.
- Endpoint này không yêu cầu auth nhưng vẫn chịu Host check.

#### `GET /api/system/status` — viewer

**200:**

```json
{
  "ok": true,
  "app": { "version": "2.0.0", "api_version": 2, "uptime_seconds": 1234, "mode": "production", "started_at": "..." },
  "health": { "status": "ok", "ffmpeg": { "available": true, "version": "6.1.1", "audio_available": true }, "tls": false },
  "session": { "role": "admin", "expires_at": "..." },
  "net": { "lan_url": "http://192.168.10.5:8080", "lan_ips": ["192.168.10.5"] },
  "cameras": { "total": 12, "online": 9, "offline": 2, "auth_failed": 1, "solar_sleep": 0, "unknown": 0, "armed": 10 },
  "alerts": { "today": 4, "history_count": 120, "last_at": "..." },
  "storage": { "watchdog": { "states": {}, "last_run": "..." }, "alerts": 1 },
  "config": {
    "viewer_login_enabled": true,
    "telegram_configured": true,
    "default_password_set": true,
    "default_password_is_weak": false,
    "using_bootstrap_password": false
  },
  "runtime": {
    "python_version": "3.11.9",
    "platform": "Windows-10",
    "ffmpeg_path": "C:\\\\tools\\\\ffmpeg.exe"
  },
  "limits": {
    "max_mjpeg_streams": 12,
    "max_mjpeg_per_session": 9,
    "max_audio_streams": 4,
    "max_recordings": 2,
    "max_recording_seconds": 21600,
    "max_scan_hosts": 1024,
    "session_ttl_seconds": 43200
  },
  "warnings": [
    { "code": "FFMPEG_MISSING", "severity": "critical", "message": "FFmpeg chưa được cài hoặc không có trong PATH." }
  ]
}
```

- `warnings` chỉ chứa code/message; UI map icon.
- **Viewer không nhận đường dẫn tuyệt đối**; admin có `runtime.ffmpeg_path`. Không chứa token/chat ID với mọi vai trò.
- Viewer nhận `config` rút gọn chỉ gồm `viewer_login_enabled`; các cờ `telegram_configured`, `default_password_set`, `default_password_is_weak`, `using_bootstrap_password` chỉ admin.
- `runtime` chỉ admin (gồm `python_version`, `platform`, `ffmpeg_path`); `ffmpeg_path` không trả trong `/api/health` public.
- `net.lan_url`/`net.lan_ips` viewer được xem để Copy LAN URL; nếu không có interface LAN, `lan_url` = `location.origin` do UI tự fallback.
- `limits` viewer được xem (không mật) để UI hiển thị giới hạn stream/recording.
- Viewer được xem vì đây là dữ liệu vận hành không mật.

**Mã cảnh báo (`warnings[].code`):**

| Code | Severity | Điều kiện | Vai trò |
|---|---|---|---|
| `FFMPEG_MISSING` | critical | FFmpeg không có/không chạy được | viewer |
| `STORAGE_UNWRITABLE` | critical | recordings/snapshots không ghi được | viewer |
| `HTTP_ONLY` | warning | không phải HTTPS | viewer |
| `ALARM_GRACE_ACTIVE` | info | còn trong grace period | viewer |
| `BOOTSTRAP_PASSWORD` | critical | `admin_password_bootstrap=true` | admin |
| `DEFAULT_PASSWORD_WEAK` | warning | chưa đặt hoặc <8 ký tự/common | admin |
| `VIEWER_DISABLED` | info | chưa đặt viewer password | admin |
| `TELEGRAM_NOT_CONFIGURED` | info | thiếu token/chat ID | admin |
| `ALARM_STATE_DEFAULTED` | warning | managed cũ thiếu cả `alarm_armed`/`alarm_enabled`, đã mặc định `true` | admin |

- Cột cuối là vai trò tối thiểu nhận warning; viewer không nhận warning cấu hình tài khoản/mật khẩu/Telegram.

#### `GET /api/settings` — admin

> Viewer không được đọc settings (kể cả subset). Viewer chỉ dùng `/api/system/status` và các endpoint read-only đã liệt kê; tránh lộ cấu hình Telegram/scan/LAN/file path.

**200 — admin (phần chung):**

```json
{
  "ok": true,
  "schema_version": 2,
  "settings": {
    "scan_timeout": 2.5,
    "default_subnet": "",
    "last_subnets": "192.168.10.0/24",
    "selected_vlans": ["Khu Văn Phòng"],
    "deep_scan": true,
    "telegram_enabled": true,
    "telegram_schedule_enabled": true,
    "telegram_schedule_start": "18:00",
    "telegram_schedule_end": "07:00",
    "telegram_cooldown_seconds": 60,
    "telegram_ai_filter_human": true,
    "telegram_storage_alerts": true,
    "telegram_storage_check_interval": 30,
    "alarm_startup_grace_seconds": 120,
    "lan_ip": "192.168.10.5",
    "lan_ips": ["192.168.10.5"],
    "lan_url": "http://192.168.10.5:8080",
    "viewer_login_enabled": true
  },
  "secrets": {
    "default_password_set": true,
    "telegram_bot_token_set": true,
    "telegram_chat_id_set": true
  }
}
```

**Admin (tiếp):**

```json
{
  "settings": {
    "recordings_dir": "D:\\CCTV\\recordings",
    "snapshots_dir": "D:\\CCTV\\snapshots",
    "auto_reboot_on_ip_change": false,
    "scan_ports": [37810, 80, 554, 37777],
    "company_vlans": [{"vlan": "10", "subnet": "192.168.10.0/24", "label": "VLAN 10"}],
    "telegram_armed_cameras": []
  },
  "secrets_managed_externally": false
}
```

- Không bao giờ trả `default_password`, `telegram_bot_token`, `telegram_chat_id`, `admin_password*`, `viewer_password*`.
- Chỉ admin được gọi; viewer → 403 `FORBIDDEN`.
- `lan_url` tính từ scheme + Host/port thực tế (không hardcode 8080); nếu sau reverse proxy chỉ dùng khi `CCTV_TRUST_PROXY=1`.
- `viewer_login_enabled` = có `viewer_password_hash`.
- `Cache-Control: no-store`.

#### `POST /api/settings` — admin + CSRF

**Whitelist chính xác (chỉ các khóa sau được chấp nhận):**

| Khóa | Kiểu | Ràng buộc | Ghi chú |
|---|---|---|---|
| `scan_timeout` | number | 1.0–10.0 | giây |
| `default_subnet` | string | ≤500; CIDR/dải/IP private | có thể rỗng |
| `last_subnets` | string | ≤500; như trên | có thể rỗng |
| `selected_vlans` | string[] | ≤20, mỗi phần tử ≤64 | |
| `company_vlans` | object[] | ≤64; `{vlan,subnet,label}`; subnet private CIDR; label ≤64 generic | thay hardcode `COMPANY_VLANS` |
| `deep_scan` | bool | | |
| `recordings_dir` | string | 1–500; absolute/relative; không root; ghi được; phải nằm dưới `BASE_DIR` hoặc `CCTV_ALLOWED_STORAGE_ROOTS` | ngoài `BASE_DIR` cần thêm `CCTV_ALLOW_EXTERNAL_STORAGE=1` |
| `snapshots_dir` | string | như trên | |
| `auto_reboot_on_ip_change` | bool | | |
| `telegram_enabled` | bool | | |
| `telegram_schedule_enabled` | bool | | |
| `telegram_schedule_start` | string | `HH:MM` 24 giờ (00:00–23:59) | |
| `telegram_schedule_end` | string | như trên | |
| `telegram_cooldown_seconds` | int | 10–3600 | |
| `telegram_ai_filter_human` | bool | | |
| `telegram_armed_cameras` | string[] | ≤256; `"*"` hoặc IPv4 private | `[]` hoặc `["*"]` = tất cả |
| `telegram_storage_alerts` | bool | | |
| `telegram_storage_check_interval` | int | 5–1440 | phút |
| `alarm_startup_grace_seconds` | int | 0–600 | |
| `telegram_bot_token` | string | 1–256 | **write-only**; rỗng = giữ nguyên |
| `telegram_chat_id` | string | 1–64 | **write-only**; rỗng = giữ nguyên |
| `default_password` | string | 8–128 | **write-only**; rỗng = giữ nguyên |
| `clear_telegram_bot_token` | bool | | xoá token |
| `clear_telegram_chat_id` | bool | | xoá chat ID |
| `clear_default_password` | bool | | xoá mật khẩu camera mặc định |

**Quy tắc:**

- Khóa ngoài whitelist → 400 `VALIDATION_ERROR`, `details.unknown_keys` (không silently merge).
- `admin_password`, `admin_password_hash`, `viewer_password_hash`, `viewer_password`, `schema_version`, `lan_ip`, `lan_ips`, `lan_url`, `viewer_login_enabled` → 400 (không cho ghi qua settings; dùng `/api/auth/change_password`).
- Nếu `CCTV_SECRETS_FILE` quản lý `telegram_bot_token`/`telegram_chat_id`/`default_password` → 409 `SECRETS_MANAGED_EXTERNALLY`.
- `recordings_dir`/`snapshots_dir` được kiểm tra ghi (tạo thử file tạm rồi xoá); lỗi → 400.
- Không tự đổi mật khẩu camera hay mật khẩu admin.
- Ghi atomic, backup, audit **tên khóa** đã đổi (không giá trị).
- Sau khi lưu: `ALARM_MANAGER.sync_listeners()`, cập nhật cache host/interface nếu cần.

**200:**

```json
{ "ok": true, "settings": { "...": "..." }, "message": "Đã lưu cài đặt." }
```

- Response là settings an toàn của admin (không secret).
- **403** viewer; **409** secret ngoài; **400** validation.
- Không có endpoint reset riêng: UI `Khôi phục mặc định` gửi `POST /api/settings` với các khóa vận hành (scan/schedule/cooldown) về default, **không** gồm mật khẩu, secret, đường dẫn, `telegram_armed_cameras`; phải confirm gõ `RESET`.

#### `POST /api/settings/open-folder` — admin + CSRF

**Request:** `{ "folder": "recordings" | "snapshots" }`.

**200:** `{ "ok": true, "folder": "recordings", "path": "...", "message": "Đã mở thư mục." }`.

**Lỗi:** 400 folder lạ; 500 OS lỗi; 503 `TEST_MODE_BLOCKED` (không mở Explorer trong test).

### 6.4 Managed cameras

#### `GET /api/managed/cameras` — viewer

**200:**

```json
{
  "ok": true,
  "count": 2,
  "cameras": [
    {
      "id": "cam_aabbccddeeff",
      "name": "Cổng chính",
      "ip": "192.168.10.21",
      "http_port": 80,
      "tcp_port": 37777,
      "rtsp_port": 554,
      "username": "admin",
      "model": "IPC-HFW",
      "mac": "AA:BB:CC:DD:EE:FF",
      "serial": "ABC123",
      "firmware": "2.0.0",
      "group": "Khu A",
      "vlan": "VLAN 10",
      "vlan_id": "10",
      "alarm_armed": true,
      "status": "online",
      "is_solar": false,
      "vendor": "Dahua/Imou",
      "rtsp_path": "",
      "last_seen": "2026-11-05 14:00:00",
      "last_updated": "2026-11-05 13:00:00",
      "note": "",
      "has_password": true
    }
  ]
}
```

- **Không có** `password`, `alarm_enabled` (legacy alias), `raw_info`.
- `status` enum §6.11.
- Admin nhận đầy đủ. Viewer **không nhận** `username`, `note`, `rtsp_path` (giảm lộ cấu hình); các field còn lại giống nhau.

#### `POST /api/managed/cameras` — admin + CSRF

**Thêm lẻ:**

```json
{
  "name": "Cổng chính",
  "ip": "192.168.10.21",
  "http_port": 80,
  "tcp_port": 37777,
  "rtsp_port": 554,
  "username": "admin",
  "password": "...",
  "model": "IPC-HFW",
  "mac": "",
  "serial": "",
  "firmware": "",
  "group": "Khu A",
  "vlan": "VLAN 10",
  "vlan_id": "10",
  "alarm_armed": true,
  "is_solar": false,
  "vendor": "Dahua/Imou",
  "rtsp_path": "",
  "note": ""
}
```

- `password`: write-only, 1–128 ký tự; nếu rỗng và có `default_password` thì dùng default; nếu không có cả hai → 400 `CAMERA_PASSWORD_REQUIRED`.
- Không còn mặc định `Camera@2020`.
- `ip` phải là IPv4 private/loopback (không hostname).
- `http_port`/`tcp_port`/`rtsp_port`: 1–65535; `username` 1–64, mặc định `admin`.
- `name` 1–64; `group` 1–32; `vendor` 1–32; `note` ≤500; `rtsp_path` bắt đầu `/` nếu có; tất cả loại bỏ ký tự điều khiển/xuống dòng bất thường.
- `status` không nhận từ client; server tự đặt `unknown`/`online` theo kiểm tra (nếu test mode: `unknown`).

**200:** `{ "ok": true, "camera": ManagedCamera, "message": "Đã thêm camera ..." }`.

**Batch:**

```json
{
  "batch": [ { "ip": "...", "name": "...", "model": "..." } ],
  "default_password": "..."
}
```

**200:**

```json
{ "ok": true, "total": 5, "added_count": 3, "updated_count": 2, "errors": [], "message": "..." }
```

- Batch tối đa 500 phần tử; mỗi phần tử được validate như thêm lẻ.
- Không trả password.

#### `PUT /api/managed/cameras/<id_or_ip>` — admin + CSRF

- `id_or_ip` URL-encoded; server chấp nhận id hoặc IP như cũ.
- Body chỉ các field được phép: `name, ip, http_port, tcp_port, rtsp_port, username, password, group, note, alarm_armed, vendor, rtsp_path, model`.
- `password` rỗng = giữ nguyên; không có `clear_password`.
- `ip` đổi phải private IPv4; nếu đổi IP, cập nhật `vlan`/`vlan_id` tương ứng.
- **200:** `{ "ok": true, "camera": ManagedCamera, "message": "..." }`.
- **404** `CAMERA_NOT_FOUND`; **400** validation.

#### `DELETE /api/managed/cameras/<id_or_ip>` — admin + CSRF

**Request:** `{ "confirm": true }` (bắt buộc; nếu thiếu → 400 `CONFIRMATION_REQUIRED`).

**200:** `{ "ok": true, "message": "Đã xóa camera khỏi danh sách quản lý." }`.

- Xoá listener AlarmManager tương ứng; không xoá file ghi hình.
- Audit.

#### `POST /api/managed/cameras/test` — admin + CSRF

**Request:**

```json
{ "ip": "192.168.10.21", "port": 80, "username": "admin", "password": "..." }
```

- `password` optional; nếu rỗng, server resolve cả username/password từ managed/default (bỏ qua username body); nếu có password, dùng username body (mặc định `admin`).
- Chỉ private IPv4.
- Test mode: 503 `TEST_MODE_BLOCKED`.

**200:**

```json
{
  "ok": true,
  "ip": "192.168.10.21",
  "port": 80,
  "ping_ms": 12.4,
  "auth_ok": true,
  "model": "IPC-HFW",
  "serial": "ABC123",
  "firmware": "2.0.0",
  "message": "Kết nối thành công (12.4ms)"
}
```

- `ok:true` nghĩa là đã thực hiện kiểm tra; `auth_ok` mới là xác thực thành công.
- **429** rate limit; **503** test mode.

#### `POST /api/managed/cameras/sync` — admin + CSRF

**Request:** `{}`.

**200:**

```json
{ "ok": true, "count": 12, "checked_at": "2026-11-05 14:05:00", "cameras": [ManagedCamera] }
```

- Không trả password (khắc phục lỗi cũ `app.py:1598-1603`).
- Test mode: 503 `TEST_MODE_BLOCKED` (tránh ping camera thật).

#### `POST /api/managed/cameras/toggle-alarm` — admin + CSRF

**Request:** `{ "id": "cam_...", "state": true }` (`state` bắt buộc boolean).

**200:** `{ "ok": true, "id": "...", "alarm_armed": true, "message": "..." }`.

- Đồng bộ `alarm_enabled` nội bộ để tương thích file cũ; API chỉ trả `alarm_armed`.
- Gọi `ALARM_MANAGER.sync_listeners()`.

#### `POST /api/cameras/credentials` — admin + CSRF

**Request:** `{ "ip": "192.168.10.21", "username": "admin", "password": "..." }`.

- `ip` private IPv4; `username` 1–64 (mặc định `admin`); `password` 1–128.
- Lưu credential tạm trong bộ nhớ cho `(session, ip)`, gồm username + password, TTL 1800s; tối đa 50 IP/phiên.
- Không trả lại password; không log; không ghi file.
- Test mode: cho phép (chỉ memory), không gọi camera.

**200:** `{ "ok": true, "ip": "192.168.10.21", "expires_at": "2026-11-05T14:35:00+07:00" }`.

**Lỗi:** 400 IP/password sai; 403 viewer; 429 >10/phút/phiên.

#### `DELETE /api/cameras/credentials/<ip>` — admin + CSRF

- Xoá credential tạm của IP trong session hiện tại; idempotent.
- **200:** `{ "ok": true, "ip": "192.168.10.21" }`.
- IP sai định dạng → 400; IP không có credential → vẫn 200 (idempotent).

### 6.5 Scan và export

#### `GET /api/scan` — admin

**Query:**

| Tên | Kiểu | Mặc định | Ràng buộc |
|---|---|---|---|
| `subnet` | string | `settings.last_subnets` | ≤500 ký tự; 1–8 biểu thức CIDR/dải/IP; chỉ private IPv4; tổng host ≤1024; CIDR prefix ≥/22 |
| `deep` | `0`/`1` | `settings.deep_scan` | `1` = unicast |
| `model` | string | rỗng | ≤64 ký tự, lọc client/server |

**200:**

```json
{
  "ok": true,
  "count": 4,
  "devices": [ScanDevice],
  "scanned_at": "2026-11-05T14:10:00+07:00",
  "duration_ms": 4120,
  "targets": 254,
  "truncated": false
}
```

**Lỗi:**

| HTTP | Code | Khi nào |
|---|---|---|
| 400 | `INVALID_SUBNET` | CIDR/dải sai, public IP, quá 1024 host |
| 409 | `SCAN_IN_PROGRESS` | Đang có scan chạy |
| 429 | `RATE_LIMITED` | >6 lần/phút |
| 503 | `TEST_MODE_BLOCKED` | Test mode không có fixture |
| 500 | `INTERNAL_ERROR` | Lỗi scanner |

- Test mode có `CCTV_TEST_SCAN_FIXTURE`: trả fixture, không mở socket.
- `parse_target_ips` phải có cap `max_hosts` (mặc định 1024) và chỉ private; CLI cũng dùng cùng validation (không bypass).
- Không tự quét khi mở UI; endpoint chỉ chạy khi người dùng bấm.
- `GET /api/scan`/`/api/scan/vlans` giữ GET để tương thích nhưng có tác dụng phụ; bảo vệ bằng auth admin + `SameSite=Strict` + rate limit + `Cache-Control: no-store`. Nếu có thể đổi hợp đồng, ưu tiên `POST` + CSRF; nếu giữ GET, đây là ngoại lệ được ghi nhận, không dùng cho dữ liệu nhạy cảm.
- Scan chạy synchronous; client timeout 120s và có nút huỷ (abort request). Server giữ lock và vẫn hoàn tất scan hiện tại; kết quả được lưu cache, UI bỏ qua nếu người dùng đã huỷ.

#### `GET /api/scan/vlans` — admin

**200 (contract sửa):**

```json
{
  "ok": true,
  "vlans": [
    { "vlan": "10", "subnet": "192.168.10.0/24", "label": "VLAN 10 (...)", "gateway": "192.168.10.1", "is_up": true }
  ],
  "all_subnets_str": "192.168.10.0/24, 192.168.12.0/24",
  "count": 12,
  "scanned_at": "2026-11-05T14:10:00+07:00"
}
```

- UI chỉ dùng các key này; bỏ `status`, `active_vlans`, `all_subnets`.
- Danh sách lấy từ `settings.company_vlans` (default generic), không hardcode label công ty trong `scan_imou.py`.
- Test mode: trả fixture tĩnh, không ping.

#### `GET /api/export` — admin

- Trả CSV UTF-8 BOM, `Content-Disposition: attachment; filename=cctv_cameras_YYYYmmdd_HHMM.csv`.
- Cột như cũ: IP, Tên, Model, Loại, MAC, Serial, HTTP, TCP, Gateway, Netmask, DHCP, Firmware.
- **Chống CSV injection:** nếu giá trị bắt đầu bằng `=`, `+`, `-`, `@`, tab, CR → prefix `'`.
- Dữ liệu lấy từ `CACHED_DEVICES` mới nhất; nếu chưa quét → CSV chỉ có header (không lỗi).
- Không trả JSON; lỗi xác thực vẫn trả JSON 401/403 (client dùng fetch blob để đọc).
- UI không dùng `window.location.href`; dùng `CCTV.api.download`.

### 6.6 Stream, snapshot, record, media

#### `GET /api/stream/mjpeg` — viewer

**Query:** `ip` (bắt buộc), `subtype` (`0` HD / `1` SD, mặc định `1`), `channel` (`1`/`2`, mặc định `1`), `_` (cache buster).

- **Không nhận** `password`; nếu có key `password` trong query → 400 `PASSWORD_IN_QUERY_FORBIDDEN` (phát hiện client cũ).
- Server resolve credential: managed → ephemeral session → body (chỉ batch admin) → default. Không có → 409 `CAMERA_CREDENTIAL_REQUIRED`.
- Viewer chỉ được IP thuộc managed; ngoài danh sách → 404 `CAMERA_NOT_FOUND` (xem §8.12).
- FFmpeg thiếu → 503 `FFMPEG_UNAVAILABLE`.
- Vượt giới hạn → 429 `TOO_MANY_STREAMS`.
- Test mode → 503 `TEST_MODE_BLOCKED`.

**200:** `multipart/x-mixed-replace; boundary=frame`, `Cache-Control: no-cache, no-store, must-revalidate`.

- Stream dừng khi: client ngắt, session hết hạn, quá 12h, hoặc FFmpeg exit.
- Không log URL/credential.

#### `GET /api/stream/audio` — viewer

- Query như MJPEG; trả `audio/mpeg`.
- Một luồng audio/phiên; vượt → 429.
- FFmpeg thiếu hoặc thiếu libmp3lame → 503 `FFMPEG_UNAVAILABLE` `details.capability="audio"`.
- Test mode → 503 (trừ fake backend).

#### `GET /api/snapshot` — viewer

**Query:** `ip`, `subtype` (mặc định `0`), `channel`.

**200:** `image/jpeg`, `Content-Disposition: inline; filename="snapshot_<ip>_<ts>_<6hex>.jpg"`, header `X-Snapshot-Filename: <file>`.

- Lưu file vào `snapshots_dir` với tên ngẫu nhiên; lỗi lưu không làm hỏng response ảnh (chỉ log).
- Rate limit 30 snapshot/phút/phiên; vượt → 429 (tránh làm đầy đĩa).
- Không nhận password.
- Test mode/FFmpeg thiếu → 503.

#### `POST /api/record/start` — admin + CSRF

**Request:** `{ "ip": "...", "subtype": "0", "channel": 1 }`.

- `channel`: `1` hoặc `2` (dual-lens), mặc định `1`; ghi hình mắt 2 dùng `channel=2`.
- Khóa recording theo `(ip, channel)`; hai mắt có thể ghi đồng thời nếu còn slot.

**200:**

```json
{ "ok": true, "recording": true, "filename": "rec_192.168.10.21_c1_20261105_140500_a1b2c3.mp4", "ip": "192.168.10.21", "channel": 1, "started_at": "2026-11-05 14:05:00" }
```

- Nếu đang ghi cùng `(ip, channel)` → 409 `ALREADY_RECORDING` (kèm `details.filename`).
- Vượt giới hạn recording → 429/503.
- FFmpeg không khởi động được → 500 `INTERNAL_ERROR` hoặc 503 `FFMPEG_UNAVAILABLE` (không trả 200 giả).
- Filename có hậu tố ngẫu nhiên 6 hex; không đoán được.
- Tự dừng sau `CCTV_MAX_RECORDING_SECONDS` (mặc định 21600s).

#### `POST /api/record/stop` — admin + CSRF

**Request:** `{ "ip": "...", "channel": 1 }`.

**200:**

```json
{
  "ok": true,
  "recording": false,
  "filename": "...",
  "download_url": "/api/recordings/<filename>",
  "duration_seconds": 42.1,
  "file_size": 12345678,
  "ip": "192.168.10.21",
  "channel": 1
}
```

- Không ghi → 404 `NOT_RECORDING`.

#### `GET /api/record/status` — viewer

**Query:** `ip` (không bắt buộc), `channel` (không bắt buộc).

- Có `ip`: `{ "ok": true, "is_recording": true, "duration": 12, "filename": "...", "channel": 1, "started_at": "...", "max_duration_seconds": 21600 }`.
- Không có `ip`: `{ "ok": true, "recordings": [{ip, channel, filename, duration, started_at}] }`.

#### `GET /api/recordings/<filename>` — viewer

- Chỉ filename khớp `^[A-Za-z0-9_.-]+\.mp4$`; resolve trong `recordings_dir`; từ chối path traversal/realpath ngoài root.
- `download=1` → `Content-Disposition: attachment`; mặc định `inline`.
- `video/mp4`; hỗ trợ Range nếu `static_file` của Bottle hỗ trợ; nếu không, chấp nhận không seek.
- Không auth → 401; không tồn tại → 404.

#### `POST /api/stream/open` — admin + CSRF

**Request:** `{ "ip": "...", "channel": 1, "name": "..." }`.

- **Không nhận `rtsp_url`**; nếu có → 400 `RTSP_URL_FORBIDDEN`.
- Server tự build URL từ credential; kiểm tra IP private.
- Tìm mpv/VLC; nếu không có → 503 `PLAYER_NOT_AVAILABLE`.
- Subprocess dùng `--` trước URL để chặn argument injection; không dùng `shell=True`.
- Test mode → 503.

**200:** `{ "ok": true, "player": "mpv"|"vlc", "message": "..." }`.

### 6.7 Camera details, hardware, storage, batch

#### `POST /api/ptz` — admin + CSRF

**Request:**

```json
{ "ip": "192.168.10.21", "action": "Left", "speed": 5, "preset": 1 }
```

- `action` allowlist (case-insensitive, server chuẩn hoá): `Stop`, `Up`, `Down`, `Left`, `Right`, `StepUp`, `StepDown`, `StepLeft`, `StepRight`, `SetPreset`, `GotoPreset`, `ClearPreset`.
- `speed`: 1–8, mặc định 5; server clamp trong khoảng.
- `preset`: 1–8, bắt buộc với `SetPreset`/`GotoPreset`/`ClearPreset`.
- Không nhận password; server resolve credential. Viewer → 403. Không có credential → 409. Test mode → 503.
- Rate limit: tối đa 10 lệnh/giây/phiên (đủ cho D-pad); vượt → 429 `RATE_LIMITED`. Lệnh `Stop` luôn được ưu tiên (không chặn bởi rate limit nếu có thể).

**200:**

```json
{ "ok": true, "ip": "192.168.10.21", "action": "ContinuousMove", "pan": -0.625, "tilt": 0.0 }
```

- Preset trả `{ "ok": true, "ip": "...", "preset": 1, "action": "SetPreset", "method": "DHIP" }`.
- `Stop` trả `{ "ok": true, "ip": "...", "action": "Stop" }`.
- Lỗi giao tiếp camera → **502 `CAMERA_OPERATION_FAILED`** (error envelope), không trả 200 `ok:false`.
- Hành động không hỗ trợ → 400 `VALIDATION_ERROR` (không gọi camera).
- Không hỗ trợ Zoom/Focus/Iris trong phạm vi hiện tại; nếu thêm phải cập nhật allowlist + test.

#### `GET /api/camera/details` — viewer

**Query:** `ip`.

**200:** `{ "ok": true, "details": { ... } }` với các field cũ:

`ip, name, model, vendor, serial, firmware, build_date, web_version, hardware, device_class, hostname, mac, netmask, gateway, dhcp, dns, http_port, tcp_port, rtsp_port, camera_time`.

- Không nhận password; server resolve credential; không có → 409.
- Viewer chỉ được IP thuộc managed; ngoài danh sách → 404 `CAMERA_NOT_FOUND`.
- Camera không đọc được → 502 `CAMERA_OPERATION_FAILED` (không bịa dữ liệu).
- Dữ liệu thiếu lấy từ `CACHED_DEVICES` (không bịa).
- Test mode → 503.

#### `POST /api/camera/name` — admin + CSRF

**Request:** `{ "ip": "...", "name": "..." }`.

**200:** `{ "ok": true, "ip": "...", "name": "...", "message": "..." }`.

- Cập nhật camera thật và managed record nếu có. Camera không kết nối/từ chối → **502 `CAMERA_OPERATION_FAILED`**; không được âm thầm “thành công cục bộ” như cũ.
- Test mode → 503.

#### `POST /api/batch-ip` — admin + CSRF

**Request:**

```json
{
  "ips": ["192.168.10.21"],
  "is_dhcp": false,
  "start_ip": "192.168.10.200",
  "netmask": "255.255.255.0",
  "gateway": "192.168.10.1",
  "auto_reboot": false,
  "username": "",
  "password": "",
  "confirm": true
}
```

- `ips` 1–100, private IPv4 duy nhất.
- `confirm` bắt buộc `true`.
- `start_ip`, `gateway`, `netmask` validate IPv4.
- `username`/`password` optional, **write-only**, **override** credential đã lưu khi có (admin chủ động); nếu rỗng thì resolve managed/ephemeral/default. Không trả/log.
- Không tự đổi `default_password` toàn cục.
- Với camera managed đổi IP tĩnh thành công: cập nhật `ip` trong managed (nếu `new_ip` xác định); với DHCP: đánh dấu `unknown` và yêu cầu sync.
- Test mode → 503.

**200:** `{ "ok": true, "total": n, "success_count": x, "fail_count": y, "results": [{ "ok": true, "old_ip": "...", "new_ip": "...", "is_dhcp": false, "message": "..." }] }`.

#### `POST /api/reboot` — admin + CSRF

**Request:** `{ "ips": ["..."], "username": "", "password": "", "confirm": true }`.

**200:** `{ "ok": true, "total": n, "success_count": x, "fail_count": y, "results": [{ "ok": true, "ip": "...", "message": "..." }] }`.

- 100 IP tối đa; private IPv4; test mode 503.
- `username`/`password` optional, write-only, override nếu có; không trả/log.

#### `POST /api/sync-time` — admin + CSRF

**Request:** `{ "ips": ["..."], "username": "", "password": "", "timezone": "GMT+07:00" }`.

- `timezone` khớp `^GMT[+-]\d{2}:\d{2}$`.
- `username`/`password` optional, write-only, override nếu có; không trả/log.
- **200:** `{ "ok": true, "total": n, "success_count": x, "fail_count": y, "synced_time": "...", "timezone": "GMT+07:00", "results": [...] }`.
- Test mode 503.

#### `POST /api/batch_change_password` — admin + CSRF

**Request:**

```json
{
  "ips": ["192.168.10.21"],
  "username": "",
  "old_password": "...",
  "new_password": "...",
  "confirm": true
}
```

- `username` optional 1–64; nếu rỗng, dùng username của từng camera từ resolver; nếu có, override cho tất cả (chỉ admin).
- `old_password` optional; nếu rỗng, server dùng credential đã lưu. Nếu không có credential → lỗi từng camera.
- `new_password` 8–128, khác `old_password`, không nằm trong danh sách phổ biến.
- `confirm` bắt buộc.
- **Response không có `new_password`**:

```json
{
  "ok": true,
  "total": 2,
  "success_count": 2,
  "failed_count": 0,
  "results": [{ "ok": true, "ip": "192.168.10.21", "message": "Đã đổi mật khẩu thành công." }]
}
```

- Với camera thành công: cập nhật `password` trong managed record (server-side), xoá ephemeral credential và dừng smart-tracking worker của IP đó (worker không giữ mật khẩu cũ).
- Không đổi `default_password` toàn cục.
- Test mode → 503.

#### `GET /api/hardware/status` — viewer

**Query:** `ip`.

**200:** `{ "ok": true, "ip": "...", "privacy": false, "tracking": false, "siren": false, "ptz_position": "", "error": null }`.

- Camera không đọc được → **502 `CAMERA_OPERATION_FAILED`**; UI hiển thị trạng thái không xác định, không bịa false.
- Không password; 409 nếu thiếu credential; test mode 503 (trừ fake backend).

#### `POST /api/hardware/privacy` — admin + CSRF

**Request:** `{ "ip": "...", "enable": true }`.

**200:** `{ "ok": true, "ip": "...", "privacy": true, "message": "..." }` (theo kết quả camera). Camera từ chối/lỗi → 502 `CAMERA_OPERATION_FAILED`.

#### `POST /api/hardware/tracking` — admin + CSRF

**Request:** `{ "ip": "...", "enable": true }`.

**200:** `{ "ok": true, "ip": "...", "tracking": true, "message": "..." }`.

- Smart tracking worker chạy trong process, dùng `camera_media.capture_snapshot` (không gọi HTTP localhost:8080 như cũ).
- Camera từ chối/lỗi → 502 `CAMERA_OPERATION_FAILED`.
- Test mode 503.

#### `POST /api/hardware/siren` — admin + CSRF

**Request:** `{ "ip": "...", "action": "start"|"stop", "confirm": true }`.

- `confirm` bắt buộc khi `start`.
- **200:** `{ "ok": true, "ip": "...", "siren": true, "message": "..." }`.
- Camera từ chối/lỗi → 502 `CAMERA_OPERATION_FAILED`.
- Không còn còi WebAudio giả ở client.

#### `GET /api/storage/info` — viewer

**Query:** `ip`.

**200:** các field như cũ:

`ok, ip, has_sd, device, path, total_bytes, used_bytes, free_bytes, total_gb, used_gb, free_gb, percent_used, status_text, state, is_error`.

- Viewer: ẩn `path` (server trả `null`) để giảm lộ cấu trúc; admin nhận path.
- Không password; 409 nếu thiếu credential; camera không đọc được → 502 `CAMERA_OPERATION_FAILED`; test mode 503.

#### `POST /api/storage/format` — admin + CSRF

**Request:** `{ "ip": "...", "confirm": "FORMAT" }`.

- Thiếu/sai confirm → 400 `CONFIRMATION_REQUIRED`.
- **200:** `{ "ok": true, "ip": "...", "message": "Đã gửi lệnh định dạng thẻ..." }` khi camera xác nhận.
- Camera từ chối/không kết nối → 502 `CAMERA_OPERATION_FAILED` (error envelope), không trả 200 `ok:false`.
- Test mode → 503.

#### `GET /api/storage/recordings` — viewer

**Query:** `ip`, `date` (`YYYY-MM-DD`, mặc định hôm nay).

**200:** `{ "ok": true, "ip": "...", "start_time": "...", "end_time": "...", "total_found": n, "recordings": [RecordingClip] }`.

- Viewer: mỗi `RecordingClip.file_path` bị đặt `null` (không lộ đường dẫn tuyệt đối trên camera); admin nhận path.
- `date` sai → 400; camera lỗi → 502 `CAMERA_OPERATION_FAILED`.
- Test mode 503.

#### `POST /api/storage/watchdog/check_now` — admin + CSRF

**Request:** `{ "force_send": false }`.

**200:**

```json
{ "ok": true, "timestamp": "...", "total_scanned": 12, "healthy": 10, "errors": 1, "no_sd": 1, "details": [...] }
```

- **Test mode:** luôn 503 `TEST_MODE_BLOCKED` cho **cả** `force_send=false` và `force_send=true` (watchdog quét toàn bộ camera; không được chạm thiết bị thật). Không có fake backend cho watchdog trong phạm vi này.
- Production: `force_send=true` chỉ gửi Telegram nếu đã cấu hình và `telegram_enabled`; `force_send=false` chỉ cập nhật trạng thái, không gửi.
- Rate limit 2/phút.

### 6.8 Alarm và Telegram

#### `GET /api/alarm/status` — viewer

**200:**

```json
{
  "ok": true,
  "armed": true,
  "telegram_enabled": true,
  "bot_configured": true,
  "schedule_enabled": true,
  "schedule_start": "18:00",
  "schedule_end": "07:00",
  "is_in_schedule": false,
  "cooldown_seconds": 60,
  "human_only": true,
  "telegram_storage_alerts": true,
  "telegram_storage_check_interval": 30,
  "storage_watchdog": { "states": {}, "last_run": "..." },
  "active_listeners": ["192.168.10.21"],
  "listeners_count": 1,
  "history_count": 120,
  "startup_grace_remaining_seconds": 0
}
```

- Không trả token/chat ID/đường dẫn.
- Trong `startup_grace_remaining_seconds > 0`: AlarmManager không gửi Telegram và bỏ qua sự kiện (không ghi history) để tránh cảnh báo giả sau khởi động.
- `storage_watchdog` shape chính xác:
  ```json
  {
    "last_run": "2026-11-05 14:00:00",
    "states": {
      "192.168.10.21": {
        "name": "Cổng chính",
        "status": "ok|error|no_sd",
        "error_code": "STORAGE_ERROR|NO_SD|null",
        "last_check": "2026-11-05 14:00:00"
      }
    }
  }
  ```
  Không chứa `error_reason` raw, `state` gốc, dung lượng, stack trace, đường dẫn tuyệt đối hoặc exception.
- `AlarmHistoryItem.status` là enum `sent|failed|skipped|suppressed`; `title` không chứa emoji. Server map từ trạng thái nội bộ, không trả chuỗi tiếng Việt tự do/emoji.
- Viewer nhận subset: `ok, armed, schedule_enabled, schedule_start, schedule_end, is_in_schedule, cooldown_seconds, storage_watchdog, active_listeners, listeners_count, history_count, startup_grace_remaining_seconds`; các field cấu hình Telegram nhạy cảm (`telegram_enabled`, `bot_configured`, `human_only`, `telegram_storage_alerts`, `telegram_storage_check_interval`) chỉ admin.

#### `POST /api/alarm/toggle` — admin + CSRF

**Request:** `{ "armed": true }`; tắt phải thêm `"confirm": true`.

**200:** `{ "ok": true, "armed": false, "message": "Đã TẮT chế độ gác an ninh." }`.

- Bật không cần confirm; tắt cần confirm (tránh vô tình tắt gác).
- Audit.

#### `POST /api/alarm/test` — admin + CSRF

**Request:** `{ "include_snapshot": true, "camera_id": "cam_..." }` (cả hai optional).

- Chỉ dùng `telegram_bot_token`/`telegram_chat_id` đã lưu; **không nhận token/chat_id/IP tùy ý** (chặn kênh exfiltration ảnh camera).
- `camera_id` phải là camera managed; server resolve credential.
- `include_snapshot=true` mà thiếu `camera_id` → **không gửi snapshot**, chỉ gửi text (không tự chọn camera).
- Test mode: 503 `TEST_MODE_BLOCKED` **trừ khi** `CCTV_TEST_TELEGRAM_MOCK=1` (mock server nội bộ, không outbound). Với mock, trả kết quả mock và ghi request để test redaction.
- Chưa cấu hình → 409 `TELEGRAM_NOT_CONFIGURED`.
- Rate limit 2/phút.
- **200:** `{ "ok": true, "message": "Đã gửi tin nhắn thử.", "telegram": { "message_id": 123 } }`; lỗi Telegram → **502 `TELEGRAM_SEND_FAILED`** với thông điệp đã redact token.

#### `GET /api/alarm/history` — viewer

**Query:** `limit` (mặc định 50, 1–200), `offset` (mặc định 0), `ip` (optional), `date` (optional), `status` (optional: `sent|failed|skipped|suppressed`). Lọc server-side; UI có thể lọc client-side trong trang hiện tại nhưng không tải toàn bộ lịch sử.

**200:**

```json
{
  "ok": true,
  "count": 50,
  "total": 120,
  "history": [
    {
      "id": "...",
      "timestamp": "2026-11-05 13:59:00",
      "ip": "192.168.10.21",
      "name": "Cổng chính",
      "code": "MotionDetect",
      "title": "Phát hiện chuyển động",
      "status": "sent",
      "snapshot_file": "alarm_...jpg",
      "snapshot_url": "/snapshots/alarm_...jpg"
    }
  ]
}
```

- `snapshot_url` chỉ có nếu file tồn tại và nằm trong `snapshots_dir`; không trả đường dẫn tuyệt đối.
- `status`: `sent`, `failed`, `skipped`, `suppressed`.

#### `POST /api/alarm/clear_history` — admin + CSRF

**Request:** `{ "confirm": true }`.

**200:** `{ "ok": true, "message": "Đã xóa nhật ký cảnh báo." }`.

- Audit.

### 6.9 Static, PWA, APK

#### `GET /` — public

- Phục vụ `templates/index.html` (login screen + shell ẩn + sprite).
- Không chứa dữ liệu camera/secret trong HTML; mọi dữ liệu tải qua API sau đăng nhập.
- `Cache-Control: no-store`; CSP/security headers theo §9.
- Không redirect dựa trên query/hash.

#### `GET /static/<path>` — public

- Chỉ phục vụ extension allowlist: `.css`, `.js`, `.png`, `.jpg`, `.jpeg`, `.svg`, `.ico`, `.webp`, `.woff2`, `.woff`, `.ttf`, `.html` (chỉ `offline.html`). Không phục vụ `.map` (source map).
- Từ chối: `.zip`, `.apk`, `.json` (manifest phục vụ riêng), `.log`, `.py`, `.env`, `.bak`, `.db`, dotfile, path có `..`.
- Không liệt kê thư mục.
- `Cache-Control: public, max-age=3600` cho asset; `sw.js`/`manifest.json` no-cache.
- Sửa lỗi cũ: ZIP và APK không còn được phục vụ công khai.

#### `GET /manifest.json`, `GET /sw.js`, `GET /favicon.ico` — public

- `sw.js` phải có `Service-Worker-Allowed: /`, `Cache-Control: no-cache`.
- Manifest `start_url: "/"`, `scope: "/"`, `lang: "vi"`, icon nội bộ.

#### `GET /download/app.apk` — viewer

- Chỉ phục vụ file APK v2 tại `CCTV_APK_FILE` (mặc định `static/download/CCTVVisionHub-v2.apk`), không phục vụ APK cũ. Docker nên mount file APK vào `/app/data/CCTVVisionHub-v2.apk` thay vì bake vào image.
- `Content-Type: application/vnd.android.package-archive`, `Content-Disposition: attachment`.
- Chưa có file → 404 `APK_NOT_AVAILABLE`.
- Không public: phải đăng nhập viewer/admin.
- Không cache qua SW.

#### `GET /snapshots/<path>` — viewer

- Chỉ file ảnh trong `snapshots_dir`; extension `.jpg/.jpeg/.png`; realpath phải nằm trong root; từ chối `..`.
- Không auth → 401; không tồn tại → 404.

### 6.10 Endpoint bị xóa

| Endpoint | Xử lý |
|---|---|
| `POST /api/admin/login` | Xóa route; trả 404 `NOT_FOUND` |
| `POST /api/admin/change_password` | Xóa route; trả 404 |
| `GET /api/admin/verify` | Xóa route; trả 404 |
| `POST /api/admin/logout` | Xóa route; trả 404 |

- Không alias, không redirect, không nhận `X-Admin-Token`.
- Test bắt buộc: 4 route trên trả 404 kể cả khi có cookie admin hợp lệ.

### 6.11 Data object chuẩn

**`ManagedCamera`:** xem ví dụ §6.4. Quy tắc:

- `status`: `"online" | "offline" | "auth_failed" | "solar_sleep" | "unknown"`.
- `alarm_armed`: boolean (canonical).
- `has_password`: boolean (không trả password).
- `last_seen`, `last_updated`: `YYYY-MM-DD HH:MM:SS` (giữ tương thích) hoặc `null`.
- `rtsp_path`: string, có thể rỗng (chỉ admin).
- `username`, `note`: chỉ admin.
- Không có `password`, `alarm_enabled`, `raw_info`.

**`ScanDevice`:**

```json
{
  "ip": "192.168.10.21",
  "name": "Cổng chính",
  "model": "IPC-HFW",
  "class": "IPC",
  "mac": "AA:BB:CC:DD:EE:FF",
  "serial": "ABC123",
  "firmware": "2.0.0",
  "http_port": 80,
  "tcp_port": 37777,
  "gateway": "192.168.10.1",
  "netmask": "255.255.255.0",
  "dhcp": "Static",
  "vendor": "Dahua/Imou",
  "init_state": 0,
  "vlan": "VLAN 10",
  "vlan_id": "10",
  "status": "online",
  "is_solar": false,
  "discovery_proto": "Dahua DHIP",
  "onvif_supported": false
}
```

- Không có `raw_info`, không password.
- `status` của thiết bị quét được là `online`; `solar_sleep` chỉ dùng cho managed camera khi mất kết nối và `is_solar`.

**`AlarmHistoryItem`:** xem §6.8.

**`RecordingClip`:**

```json
{
  "start_time": "2026-11-05 13:00:00",
  "end_time": "2026-11-05 13:05:00",
  "duration": 300,
  "duration_str": "5m 0s",
  "length_bytes": 12345678,
  "size_mb": 11.77,
  "event_type": "Chuyển động (Motion)",
  "events": ["VideoMotion"],
  "stream": "Main",
  "file_path": "/mnt/sd/..."
}
```

- `file_path` chỉ admin nhận; viewer nhận `null`.

**`BatchResultItem`:** `{ "ok": boolean, "ip": string, "message"?: string, "error"?: string }`.

### 6.12 Bảng mã lỗi chuẩn

| Code | HTTP | Ý nghĩa |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Dữ liệu sai/thiếu; `details.fields` |
| `INVALID_IP` | 400 | IP không phải IPv4 private hợp lệ |
| `INVALID_SUBNET` | 400 | CIDR/dải sai/quá lớn |
| `CAMERA_PASSWORD_REQUIRED` | 400 | Thêm camera thiếu mật khẩu và không có default |
| `CONFIRMATION_REQUIRED` | 400 | Thiếu xác nhận bắt buộc |
| `RTSP_URL_FORBIDDEN` | 400 | Client gửi `rtsp_url` bị cấm |
| `PASSWORD_IN_QUERY_FORBIDDEN` | 400 | Client cũ gửi `password` trong query |
| `HOST_NOT_ALLOWED` | 400 | Host không nằm trong allowlist |
| `UNAUTHENTICATED` | 401 | Chưa đăng nhập/session hết hạn |
| `INVALID_CREDENTIALS` | 401 | Sai mật khẩu |
| `FORBIDDEN` | 403 | Không đủ quyền |
| `CSRF_INVALID` | 403 | Thiếu/sai CSRF |
| `ORIGIN_MISMATCH` | 403 | Origin không hợp lệ |
| `VIEWER_LOGIN_DISABLED` | 403 | Viewer chưa bật |
| `TEST_MODE_BLOCKED` | 503 | Test mode chặn hoạt động ra ngoài |
| `NOT_FOUND` | 404 | Route/tài nguyên không tồn tại |
| `CAMERA_NOT_FOUND` | 404 | Không thấy camera |
| `NOT_RECORDING` | 404 | Camera không ghi hình |
| `APK_NOT_AVAILABLE` | 404 | Chưa có APK v2 |
| `METHOD_NOT_ALLOWED` | 405 | Sai method |
| `CONFLICT` | 409 | Xung đột chung |
| `SCAN_IN_PROGRESS` | 409 | Đang quét |
| `ALREADY_RECORDING` | 409 | Đang ghi hình |
| `CAMERA_CREDENTIAL_REQUIRED` | 409 | Không có mật khẩu camera |
| `TELEGRAM_NOT_CONFIGURED` | 409 | Chưa cấu hình Telegram |
| `SECRETS_MANAGED_EXTERNALLY` | 409 | Secret do file ngoài quản lý |
| `PAYLOAD_TOO_LARGE` | 413 | Body quá lớn |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Không phải JSON |
| `RATE_LIMITED` | 429 | Vượt rate limit; `details.retry_after_seconds` |
| `TOO_MANY_STREAMS` | 429 | Vượt giới hạn stream |
| `INTERNAL_ERROR` | 500 | Lỗi server |
| `CAMERA_OPERATION_FAILED` | 502 | Camera từ chối/không kết nối/trả lỗi cho hành động đơn |
| `TELEGRAM_SEND_FAILED` | 502 | Telegram API trả lỗi sau khi đã redact token |
| `FFMPEG_UNAVAILABLE` | 503 | FFmpeg thiếu |
| `PLAYER_NOT_AVAILABLE` | 503 | Không có mpv/VLC |
| `TELEGRAM_DISABLED` | 503 | Telegram bị tắt/test mode |
| `SERVICE_UNAVAILABLE` | 503 | Tạm không phục vụ (quá tải/cấu hình) |
| `SETUP_REQUIRED` | 503 | Chưa thiết lập được admin |

---

## 7. ROLE MATRIX CHI TIẾT

Ký hiệu: `P` = public (không cần đăng nhập), `V` = viewer hoặc admin, `A` = chỉ admin. Mọi `A`/`V` đều yêu cầu session hợp lệ; mọi method thay đổi trạng thái còn yêu cầu CSRF.

| Endpoint | Method | P | V | A | Ghi chú |
|---|---|:---:|:---:|:---:|---|
| `/` | GET | ✓ | ✓ | ✓ | Login shell |
| `/static/*` | GET | ✓ | ✓ | ✓ | Allowlist extension |
| `/manifest.json` | GET | ✓ | ✓ | ✓ | |
| `/sw.js` | GET | ✓ | ✓ | ✓ | |
| `/favicon.ico` | GET | ✓ | ✓ | ✓ | |
| `/download/app.apk` | GET |  | ✓ | ✓ | 404 nếu chưa có APK v2 |
| `/api/health` | GET | ✓ | ✓ | ✓ | Không lộ secret |
| `/api/auth/login` | POST | ✓ | ✓ | ✓ | Rate limit; không CSRF |
| `/api/auth/me` | GET | ✓ | ✓ | ✓ | Trả authenticated/role |
| `/api/auth/logout` | POST |  | ✓ | ✓ | CSRF |
| `/api/auth/change_password` | POST |  |  | ✓ | CSRF; re-auth |
| `/api/system/status` | GET |  | ✓ | ✓ | Không secret |
| `/api/settings` | GET |  |  | ✓ | Admin only; không trả secret |
| `/api/settings` | POST |  |  | ✓ | Whitelist; CSRF |
| `/api/settings/open-folder` | POST |  |  | ✓ | CSRF; test mode chặn |
| `/api/managed/cameras` | GET |  | ✓ | ✓ | Sanitized |
| `/api/managed/cameras` | POST |  |  | ✓ | CSRF |
| `/api/managed/cameras/<id>` | PUT |  |  | ✓ | CSRF |
| `/api/managed/cameras/<id>` | DELETE |  |  | ✓ | CSRF; confirm |
| `/api/managed/cameras/test` | POST |  |  | ✓ | Private IP; test mode chặn |
| `/api/managed/cameras/sync` | POST |  |  | ✓ | CSRF; test mode chặn |
| `/api/managed/cameras/toggle-alarm` | POST |  |  | ✓ | CSRF |
| `/api/cameras/credentials` | POST |  |  | ✓ | CSRF; credential tạm |
| `/api/cameras/credentials/<ip>` | DELETE |  |  | ✓ | CSRF |
| `/api/scan` | GET |  |  | ✓ | Cap subnet; rate limit |
| `/api/scan/vlans` | GET |  |  | ✓ | Rate limit |
| `/api/export` | GET |  |  | ✓ | CSV injection safe |
| `/api/stream/mjpeg` | GET |  | ✓ | ✓ | Cookie; không password |
| `/api/stream/audio` | GET |  | ✓ | ✓ | Cookie; không password |
| `/api/snapshot` | GET |  | ✓ | ✓ | Cookie; không password |
| `/api/stream/open` | POST |  |  | ✓ | Không nhận rtsp_url |
| `/api/record/start` | POST |  |  | ✓ | CSRF |
| `/api/record/stop` | POST |  |  | ✓ | CSRF |
| `/api/record/status` | GET |  | ✓ | ✓ | |
| `/api/recordings/<filename>` | GET |  | ✓ | ✓ | Path validation |
| `/api/ptz` | POST |  |  | ✓ | CSRF; action allowlist |
| `/api/batch-ip` | POST |  |  | ✓ | CSRF; confirm |
| `/api/reboot` | POST |  |  | ✓ | CSRF; confirm |
| `/api/sync-time` | POST |  |  | ✓ | CSRF |
| `/api/batch_change_password` | POST |  |  | ✓ | CSRF; confirm; không trả password |
| `/api/camera/details` | GET |  | ✓ | ✓ | Cookie; không password |
| `/api/camera/name` | POST |  |  | ✓ | CSRF |
| `/api/hardware/status` | GET |  | ✓ | ✓ | |
| `/api/hardware/privacy` | POST |  |  | ✓ | CSRF |
| `/api/hardware/tracking` | POST |  |  | ✓ | CSRF |
| `/api/hardware/siren` | POST |  |  | ✓ | CSRF; confirm start |
| `/api/storage/info` | GET |  | ✓ | ✓ | Viewer ẩn path |
| `/api/storage/format` | POST |  |  | ✓ | CSRF; confirm FORMAT |
| `/api/storage/recordings` | GET |  | ✓ | ✓ | |
| `/api/storage/watchdog/check_now` | POST |  |  | ✓ | CSRF |
| `/api/alarm/status` | GET |  | ✓ | ✓ | |
| `/api/alarm/toggle` | POST |  |  | ✓ | CSRF; confirm khi tắt |
| `/api/alarm/test` | POST |  |  | ✓ | CSRF; cấu hình đã lưu |
| `/api/alarm/history` | GET |  | ✓ | ✓ | |
| `/api/alarm/clear_history` | POST |  |  | ✓ | CSRF |
| `/snapshots/<path>` | GET |  | ✓ | ✓ | Path validation |
| `/api/admin/*` | * |  |  |  | **ĐÃ XÓA — 404** |

**Quy tắc kiểm tra tự động:**

- `verify_project.py` parse AST `app.py`; mỗi hàm có `@route` phải có đúng một trong `@public`, `@require_role("viewer")`, `@require_role("admin")`.
- `test_security.py` sinh ma trận từ bảng trên (hoặc danh sách tương đương) và kiểm tra:
  - không cookie → 401 cho mọi `V`/`A`;
  - viewer cookie → 403 cho mọi `A`;
  - admin cookie + CSRF → không 401/403 (có thể 400/409/503 do validate/test mode).
- Mọi route không nằm trong bảng public phải trả 401 khi không cookie, kể cả route mới thêm.

---

## 8. MÔ HÌNH XÁC THỰC VÀ PHIÊN

### 8.1 Vai trò và nguyên tắc

- **admin:** toàn quyền, kể cả cấu hình, quét, PTZ, ghi hình, format, reboot, đổi mật khẩu camera, quản lý NVR, alarm.
- **viewer:** chỉ đọc: dashboard, live stream, audio, snapshot, record status, recordings, snapshots, camera details, hardware status, storage info, storage recordings, alarm status/history, system status. **Không** đọc settings.
- Không có vai trò “anonymous viewer”. Người chưa đăng nhập chỉ thấy login screen và `/api/health`/`/api/auth/me`/`/api/auth/login`.
- Không có “admin ẩn” bằng query/URL/phím tắt. Quyền chỉ đến từ session server-side.

### 8.2 Hash mật khẩu (scrypt)

**Định dạng lưu:**

```
scrypt$32768$8$1$<salt_base64>$<derived_key_base64>
```

- `N=32768, r=8, p=1, dklen=32`, salt 16 byte ngẫu nhiên (`secrets.token_bytes(16)`).
- Dùng `hashlib.scrypt(password.encode('utf-8'), salt=salt, n=N, r=r, p=p, dklen=32, maxmem=64*1024*1024)`.
- Encode base64 chuẩn (không URL-safe) để dễ đọc.
- So sánh bằng `hmac.compare_digest`.
- `verify()` trả `(ok, needs_rehash)`; nếu params khác hiện tại và verify thành công → hash lại bằng params mới.
- Không dùng `hashlib.pbkdf2_hmac`, không dùng SHA256 trần, không mã hóa hai chiều.
- Không trả hash qua API, không log hash.

**Chính sách mật khẩu admin/viewer:**

- Dài 10–128 ký tự sau khi trim outer whitespace.
- Không được nằm trong danh sách phổ biến: `admin`, `password`, `123456`, `1234567890`, `1998`, `Admin@1998`, `Camera@2020`, `cctv`, `cctv123`, `qwerty`, `letmein`.
- Không được trùng mật khẩu hiện tại.
- Không yêu cầu ký tự đặc biệt bắt buộc (theo NIST), nhưng UI hiển thị độ mạnh.
- Không gợi ý/không hiển thị mật khẩu mặc định trong bất kỳ tài liệu/UI nào.

**Mật khẩu camera (batch):** 8–128, không trùng mật khẩu cũ; server không trả lại.

### 8.3 Session server-side

**Cấu trúc session (bộ nhớ):**

```python
{
  "token_hash": "<sha256 hex>",
  "role": "admin"|"viewer",
  "username": "admin"|"viewer",
  "csrf_hash": "<sha256 hex>",
  "created_at": 1762340000.0,
  "expires_at": 1762383200.0,
  "last_seen_at": 1762340000.0,
  "client_ip": "192.168.10.10",
  "ua_hash": "<sha256 hex>"
}
```

- Token thô chỉ nằm trong cookie; server lưu SHA-256 để giảm rủi ro memory dump.
- CSRF thô chỉ trả về client qua response body; server lưu SHA-256.
- **TTL tuyệt đối**, mặc định 12 giờ (43200s), cấu hình bằng `CCTV_SESSION_TTL_SECONDS` (10–43200; production khuyến nghị 43200, <3600 chỉ dùng test). Mỗi request cập nhật `last_seen_at` nhưng không kéo dài `expires_at`.
- Không có sliding session; hết TTL phải đăng nhập lại.
- Tối đa 500 session; khi vượt: prune session hết hạn; nếu vẫn vượt → 503 `SERVICE_UNAVAILABLE`.
- Prune mỗi lần kiểm tra auth và định kỳ 60s.
- Restart server → mất toàn bộ session (chấp nhận; an toàn hơn lưu file).
- Không lưu session vào localStorage/sessionStorage.

**Tạo session:**

1. `token = secrets.token_urlsafe(32)`.
2. `csrf = secrets.token_urlsafe(32)`.
3. Lưu hash; set cookie với `Max-Age=TTL`; trả `csrf_token` + `expires_at` (now+TTL) trong JSON.
4. Nếu request có cookie session cũ hợp lệ → thu hồi token cũ trước khi tạo mới (chống session fixation/tích tụ).
5. `SessionStore(ttl_seconds=..., now_fn=time.time)` và `LoginRateLimiter(now_fn=...)` phải cho phép inject clock để test B04/B11 không cần sleep.

**Thu hồi:**

- Logout: xoá đúng session + cookie.
- Đổi mật khẩu admin: xoá tất cả session.
- Đổi/xoá viewer: xoá tất cả session (admin + viewer) để đảm bảo không còn phiên nào dùng cấu hình cũ.
- Không có endpoint logout-all riêng; đổi mật khẩu là cách thu hồi toàn bộ session.

### 8.4 Cookie

- Tên: `cctv_sid`.
- Thuộc tính: `Path=/`, `HttpOnly`, `SameSite=Strict`, `Max-Age=<TTL>`, `Expires=<now+TTL>`; TTL lấy từ `CCTV_SESSION_TTL_SECONDS` (cùng giá trị dùng cho `expires_at`).
- `Secure` khi:
  - request scheme là HTTPS, hoặc
  - `CCTV_HTTPS=1`, hoặc
  - `CCTV_TRUST_PROXY=1` và `X-Forwarded-Proto=https`.
- Không đặt `Domain` (host-only).
- Xoá cookie: cùng Path/attributes, `Max-Age=0`.
- Không dùng cookie cho CSRF; CSRF nằm trong header.
- `Clear-Site-Data: "cache", "storage"` khi logout/đổi mật khẩu (chỉ có hiệu lực trên HTTPS/localhost; vẫn set header).
- `SameSite=Strict`: mở link từ site khác vào app có thể phải đăng nhập lại; đây là đánh đổi bảo mật được chấp nhận.

### 8.5 CSRF, Origin, Host

**CSRF:**

- Mọi `POST/PUT/PATCH/DELETE` trên `/api/*` (trừ `/api/auth/login`) yêu cầu header `X-CSRF-Token`.
- So sánh SHA-256 của token gửi lên với `session.csrf_hash` bằng `hmac.compare_digest`.
- Thiếu/sai → 403 `CSRF_INVALID`; audit.
- Token KHÔNG đặt trong cookie (không double-submit), không trong URL, không trong localStorage.
- Client lấy token từ `/api/auth/me` hoặc response login; giữ trong closure.
- Khi session rotate (đăng nhập lại), token mới.

**Origin:**

- Với mọi request thay đổi trạng thái:
  - Nếu có `Origin`: parse; chỉ chấp nhận `http`/`https`; `host:port` phải khớp `Host` của request hoặc nằm trong `CCTV_ALLOWED_ORIGINS`.
  - Nếu `Origin: null` → 403.
  - Nếu không có `Origin`: chấp nhận nếu CSRF hợp lệ và `Sec-Fetch-Site` (nếu có) là `same-origin`/`none`.
- `CCTV_ALLOWED_ORIGINS` dạng CSV, ví dụ `https://cctv.example.com,http://192.168.10.5:8080`.

**Host:**

- Allowlist xây lúc khởi động:
  - `localhost`, `127.0.0.1`, `::1`,
  - hostname máy (`socket.gethostname()`),
  - tất cả IPv4/IPv6 interface local (từ `get_local_interfaces()`),
  - `CCTV_ALLOWED_HOSTS` (CSV, có thể gồm domain/IP; không hỗ trợ `*`).
- Bỏ port khi so sánh; lowercase; xử lý IPv6 trong ngoặc vuông.
- Host không hợp lệ → 400 `HOST_NOT_ALLOWED` (JSON cho `/api`, text/HTML cho trang).
- Nếu chạy sau reverse proxy, admin phải thêm domain vào `CCTV_ALLOWED_HOSTS`; `X-Forwarded-Host` chỉ tin khi `CCTV_TRUST_PROXY=1`.
- IP client: `REMOTE_ADDR`; chỉ dùng `X-Forwarded-For` (first hop) khi `CCTV_TRUST_PROXY=1`; validate IPv4/IPv6.

### 8.6 Rate limit đăng nhập và brute force

**Login:**

- Khóa theo `(client_ip, username)`:
  - Tối đa **5 lần thất bại / 5 phút**.
  - Khi vượt → 429 kèm `Retry-After` (giây) và `details.retry_after_seconds`.
- Khóa theo IP:
  - Tối đa **20 lần thất bại / 15 phút** cho mọi username.
- Khóa toàn cục: 100 lần thất bại/15 phút → tạm chặn login 60s (tránh spray).
- Đăng nhập thành công → reset bộ đếm của `(ip, username)`, không reset IP.
- Không tiết lộ username tồn tại: sai user/sai pass đều 401 cùng message.
- Luôn chạy dummy scrypt verify khi username không tồn tại để cân bằng thời gian.
- Không khóa tài khoản vĩnh viễn (tránh DoS); chỉ rate limit.
- Ghi audit `login_failure` với IP/username, không ghi mật khẩu.
- Rate limiter in-memory, thread-safe, prune bucket hết hạn.

**Các endpoint khác (bắt buộc):**

| Endpoint | Giới hạn |
|---|---|
| `POST /api/cameras/credentials` | 10/phút/phiên |
| `GET /api/snapshot` | 30/phút/phiên |
| `POST /api/managed/cameras/test` | 10/phút/IP |
| `GET /api/scan`, `/api/scan/vlans` | 6/phút/IP; 1 scan đồng thời |
| `POST /api/managed/cameras/sync` | 3/phút/phiên; single-flight (không chạy 2 sync cùng lúc) |
| `POST /api/stream/open` | 3/phút/phiên |
| `POST /api/record/start` | 6/phút/phiên |
| `POST /api/alarm/test` | 2/phút/phiên |
| `POST /api/storage/format`, `/api/reboot`, `/api/batch-ip`, `/api/batch_change_password` | 3/phút/phiên |
| `POST /api/settings` | 10/phút/phiên |
| `POST /api/auth/change_password` | 5/15 phút/phiên |

- Mọi 429 phải có `Retry-After` và audit `rate_limited` (không ghi body).

### 8.7 First-run và bootstrap

**Điều kiện tiên quyết trước khi nâng cấp (bắt buộc):**

- Operator phải chọn **một** trong hai cách:
  - đặt `CCTV_ADMIN_PASSWORD` mạnh (≥10 ký tự, không nằm trong danh sách phổ biến; policy-check lúc startup), hoặc
  - đảm bảo `CCTV_BOOTSTRAP_FILE` (và thư mục cha) ghi được bởi tài khoản service.
- Nếu dữ liệu cũ chứa `admin_password` plaintext trùng bộ backdoor/mặc định (đã xác nhận boolean), **không được** giữ nguyên; migration phải dùng env hoặc bootstrap mới.
- Nếu không thoả điều kiện: **dừng server với mã 2 trước khi ghi settings**, in hướng dẫn rõ; không tạo trạng thái nửa vời, không tự đổi mật khẩu im lặng.

**Thứ tự khởi động:**

1. `SettingsStore` đọc file cấu hình; kiểm tra `CCTV_SETTINGS_FILE` ghi được trước khi migrate. Chỉ kiểm tra `CCTV_BOOTSTRAP_FILE` ghi được khi thực sự cần bootstrap (không có hash/env).
2. Xác định hash admin theo thứ tự:
   - `admin_password_hash` hợp lệ → dùng.
   - `CCTV_ADMIN_PASSWORD` (env) → policy-check; nếu yếu → dừng mã 2; nếu hợp lệ → hash, lưu, `admin_password_bootstrap=true`.
   - `admin_password` plaintext **không thuộc** bộ mặc định/backdoor và **≥10 ký tự** → hash, xoá plaintext, `admin_password_bootstrap=true` (vẫn cảnh báo đổi).
   - `admin_password` plaintext thuộc bộ mặc định/backdoor **hoặc <10 ký tự** → **không dùng**; sinh mật khẩu ngẫu nhiên 20 ký tự, hash, ghi file bootstrap, `admin_password_bootstrap=true`.
   - Không có gì → sinh ngẫu nhiên như trên.
3. File bootstrap:
   - Đường dẫn `CCTV_BOOTSTRAP_FILE` (mặc định `data/bootstrap_admin.txt`); tạo thư mục nếu cần.
   - Nội dung: hướng dẫn ngắn + mật khẩu một dòng. Tạo với quyền 0600 (`os.open(..., O_CREAT|O_EXCL, 0o600)`); trên Windows thử `icacls` giới hạn user hiện tại.
   - **Fail closed:** nếu không ghi được file bootstrap (và không dùng env) → dừng server mã 2 trước khi thay settings; không chỉ in console.
   - In mật khẩu bootstrap **một lần** ra console local lúc khởi động (nếu console khả dụng); tuyệt đối không in qua API, app log, audit log hoặc file khác ngoài file bootstrap. Test mode không in.
   - Xoá file sau khi đổi mật khẩu admin thành công (best effort).
4. Lưu `admin_password_bootstrap: true/false`; **không** trả raw; chỉ trả `using_bootstrap_password`.
5. `GET /api/auth/me` trả `first_run: true` khi `admin_password_bootstrap=true`.
6. Dashboard banner critical + Settings nhắc đổi; không chặn thao tác admin (tránh khóa vận hành) nhưng cảnh báo rõ.

**Recovery khi mất quyền admin:**

- Dừng service; đặt `CCTV_ADMIN_PASSWORD` mạnh (không có hash hợp lệ) hoặc trỏ `CCTV_BOOTSTRAP_FILE` tới thư mục ghi được; khởi động lại test mode với bản copy settings để xác nhận trước.
- Không có endpoint recovery công khai. Không khôi phục mật khẩu backdoor. Nếu cần rollback, dùng backup `settings.json.bak` **sau khi** đã có mật khẩu mới hợp lệ.

**Test mode:** dùng `CCTV_ADMIN_PASSWORD` hoặc fixture hash; không sinh file trong project; `CCTV_BOOTSTRAP_FILE` trỏ temp và phải ghi được. Test B23/B24 kiểm tra fail-closed và env path.

### 8.8 Viewer password (tuỳ chọn)

- Mặc định **không có** viewer password → viewer login bị tắt, trả 403 `VIEWER_LOGIN_DISABLED`.
- Admin đặt viewer password qua `POST /api/auth/change_password` với `target=viewer` + mật khẩu admin hiện tại (re-auth).
- Khi đã đặt, `viewer_login_enabled=true` trong `/api/auth/me`; login screen bật lựa chọn viewer.
- Admin có thể đổi hoặc xoá (`clear_viewer:true`); xoá sẽ thu hồi toàn bộ session (admin + viewer).
- Viewer không thể đổi mật khẩu của mình (không có endpoint); admin quản lý.
- Không có “viewer mặc định”/mật khẩu viewer mặc định.

### 8.9 Migration mật khẩu cũ

**Thứ tự khởi động:**

1. Đọc `settings.json` gốc (hoặc `CCTV_SETTINGS_FILE`).
2. Nếu JSON hỏng hoặc `admin_password_hash` sai định dạng → dừng server với mã lỗi 2, không ghi đè; log đường dẫn (không log nội dung).
3. Backup `settings.json.bak.<YYYYmmddHHMMSS>` (giữ 5 bản gần nhất).
4. Alias:
   - `telegram_cooldown` → `telegram_cooldown_seconds` (nếu canonical chưa có).
   - `telegram_human_only` → `telegram_ai_filter_human` (nếu canonical chưa có).
   - Bỏ alias sau khi map; canonical thắng nếu xung đột.
5. Thêm default còn thiếu (`telegram_enabled`, `alarm_startup_grace_seconds`, `admin_password_bootstrap`, `schema_version`).
6. Hash admin plaintext theo §8.7; xoá `admin_password`.
7. Nếu có `viewer_password` plaintext (không có trong bản hiện tại nhưng phòng tương lai) → hash, xoá.
8. Ghi atomic (temp + `os.replace`), `ensure_ascii=False`, `indent=2`.
9. Đặt quyền file 0600 (POSIX) / ACL hạn chế (Windows) nếu có thể.
10. Không migrate `managed_cameras.json` sang định dạng khác; chỉ chuẩn hoá status/field khi đọc.

**Không bao giờ** giữ lại mật khẩu mặc định `Admin@1998`/`1998` dưới dạng hash. Đây là backdoor; phải vô hiệu hoá.

### 8.10 Đổi mật khẩu và thu hồi

- Đổi admin: yêu cầu `current_password`; verify scrypt; hash mới; lưu; thu hồi **tất cả** session; xoá cookie; `Clear-Site-Data`; audit.
- Đổi viewer: yêu cầu admin session + mật khẩu admin hiện tại; hash mới; thu hồi **tất cả** session (admin + viewer); xoá cookie; `Clear-Site-Data`; audit.
- Xoá viewer: như trên, đặt hash rỗng; thu hồi tất cả session.
- Không trả hash/mật khẩu.
- Nếu `CCTV_SECRETS_FILE` được cấu hình và chứa `admin_password_hash`/`viewer_password_hash` → từ chối đổi qua API (409 `SECRETS_MANAGED_EXTERNALLY`), hướng dẫn sửa file secret.
- Ghi audit `password_change` với target, không giá trị.

### 8.11 Audit log và chống brute force

**Audit log JSONL** tại `CCTV_AUDIT_LOG` (mặc định `logs/audit.jsonl`), rotate theo ngày hoặc 10MB, giữ 30 ngày.

Mỗi dòng:

```json
{
  "ts": "2026-11-05T14:03:00+07:00",
  "event": "camera_delete",
  "role": "admin",
  "actor": "admin",
  "client_ip": "192.168.10.10",
  "target": "cam_aabbccdd",
  "result": "ok",
  "request_id": "...",
  "details": { "ip": "192.168.10.21" }
}
```

- Bắt buộc ghi: login_success, login_failure, logout, password_change, settings_update, camera_add/update/delete, camera_test, sync, toggle_alarm, scan, export, credential_set/clear, stream_open, record_start/stop, hardware_privacy/tracking/siren, storage_format, reboot, batch_ip, batch_password, sync_time, alarm_toggle/test/clear, watchdog_run, open_folder, rate_limited, csrf_failure, forbidden.
- Không ghi từng lệnh PTZ (tránh spam); chỉ ghi khi bật/tắt smart tracking và các thao tác phần cứng khác.
- **Không ghi**: mật khẩu, token, chat ID, nội dung body, URL có query nhạy cảm, ảnh.
- File audit không được phục vụ qua `/static`; nằm ngoài web root hoặc bị chặn.
- Lỗi ghi audit không được làm fail request nghiệp vụ; log warning và tiếp tục.
- Không log request body mặc định; nếu cần debug, chỉ log sau khi redact.

### 8.12 Mật khẩu camera và credential tạm

**API resolver (bắt buộc):**

```python
credentials.resolve_credentials(
    ip, session,
    body_username=None, body_password=None,
    prefer_body=False
) -> {"username": str, "password": str}
```

**Thứ tự resolve — bắt buộc:**

0. Nếu `prefer_body=True` và `body_password` khác rỗng: dùng `body_username` (hoặc username managed của IP, hoặc `admin`) + `body_password`. Đây là **override có chủ đích** cho `managed/cameras/test`, `batch-ip`, `reboot`, `sync-time`; write-only, không trả/log. Nếu chỉ có `body_username` mà password rỗng → bỏ qua body, resolve như bình thường.
1. `managed_cameras.json`: dùng `username` (mặc định `admin`) và `password` của camera có `ip` trùng (nếu password khác rỗng).
2. Credential tạm của session cho IP đó (nếu còn hạn), gồm cả `username`.
3. `body_username`/`body_password` fallback nếu endpoint cho phép và `prefer_body=False` (không dùng cho media/PTZ/details/hardware/storage/record/camera name); write-only.
4. `settings.default_password` với `username="admin"` (nếu password khác rỗng).
5. Không có password → `CAMERA_CREDENTIAL_REQUIRED` (409). `username` mặc định `admin` nếu không có nguồn nào khác.

- Endpoint `POST /api/managed/cameras/test` **phải** dùng `prefer_body=True` khi có `password` để admin test mật khẩu mới trước khi lưu; nếu `password` rỗng thì resolve credential đã lưu.
- `batch_change_password` dùng `old_password`/`username` riêng, không đi qua resolver cho mật khẩu mới.

- **Không hardcode `username="admin"` ở route/service.** Tất cả call site (`ptz`, `camera/details`, `camera/name`, `hardware/*`, `storage/*`, `batch*`, `alarm_manager` snapshot, smart tracking) phải dùng username/password từ resolver.
- Không có fallback đặc biệt cho chuỗi `"admin"`: chỉ chuỗi rỗng/không truyền mới được coi là “không cung cấp”. Mật khẩu camera hợp lệ là `"admin"` vẫn được dùng nếu được lưu/truyền rõ.
- Test bắt buộc: camera managed có `username` khác `admin` phải stream/PTZ/details/storage/batch thành công.

**Phạm vi target theo vai trò (bắt buộc):**

- **Viewer:** chỉ được thao tác/xem IP có trong `managed_cameras.json` **và là private IPv4**. IP ngoài danh sách/public → 404 `CAMERA_NOT_FOUND` (không tiết lộ thiết bị ngoài NVR), kể cả khi `default_password` có thể đăng nhập được.
- **Admin:** được phép IP private bất kỳ nếu có credential (managed/ephemeral/default), phục vụ vận hành/scan; IP public chỉ khi `CCTV_ALLOW_PUBLIC_TARGETS=1`.
- Áp dụng cho: `stream/mjpeg`, `stream/audio`, `snapshot`, `camera/details`, `hardware/status`, `storage/info`, `storage/recordings`, `record/status` (khi có `ip`), và các hành động admin tương ứng.
- Không áp dụng cho `recordings/<filename>`/`snapshots/<path>` (tài nguyên file, đã có auth viewer).

**Credential tạm:**

- `POST /api/cameras/credentials` body `{ip, username?, password}`.
- Lưu in-memory: key = `sha256(session_token) + ip`; value = `{username, password, expires_at}` (1800s).
- Tối đa 50 IP/session; vượt → 429.
- Không trả lại password; response chỉ `{ok:true, ip, expires_at}`.
- Xoá khi: logout, session hết hạn, đổi mật khẩu camera thành công, `DELETE /api/cameras/credentials/<ip>`, server restart.
- Không ghi audit password; chỉ ghi `credential_set` với IP.
- Không lưu vào file/localStorage/DOM/URL.

**Quy tắc client:**

- Không bao giờ gửi password cho `stream/mjpeg`, `audio`, `snapshot`, `ptz`, `record`, `camera/details`, `hardware`, `storage`, `camera/name`.
- Chỉ gửi password trong body của: `auth/login`, `auth/change_password`, `cameras/credentials`, `managed/cameras` (add/update), `managed/cameras/test`, `batch_change_password`, và fallback optional của `batch-ip`/`reboot`/`sync-time` (admin).
- Không gửi password trong query, header, URL, localStorage, sessionStorage, DOM; không log.
- Form mật khẩu camera phải clear ngay sau submit/đóng modal.

### 8.13 Threat model và residual risks

| Nguy cơ | Biện pháp | Residual |
|---|---|---|
| XSS đánh cắp session | Cookie HttpOnly + CSP + textContent + không innerHTML | Phụ thuộc trình duyệt; không có XSS đã biết |
| CSRF | Synchronizer token + Origin + SameSite=Strict + JSON-only | Request không phải browser cần token; chấp nhận |
| Brute force login | scrypt + rate limit + dummy verify | Tấn công phân tán chậm vẫn có thể; audit/alert ngoài phạm vi |
| Lộ mật khẩu camera qua URL | Không password trong query; credential server-side | Log reverse proxy có thể ghi URL media (không có password) |
| Lộ mật khẩu camera qua process list | FFmpeg cần URL RTSP trong argv | **Residual cao**: user local/service account đọc được process list; giảm thiểu bằng ACL/service account/BitLocker; ghi rõ trong tài liệu vận hành |
| Mật khẩu camera at-rest | File JSON + ACL | **Residual**: plaintext nếu ổ đĩa bị đọc; khuyến nghị BitLocker/ACL/secret volume |
| HTTP LAN | Cảnh báo `HTTP_ONLY`; hỗ trợ TLS tùy chọn | **Residual**: mật khẩu/phiên có thể bị nghe lén trong LAN |
| Telegram token | Không trả API; redact log; TLS strict | Token vẫn trong URL path của Telegram API (theo thiết kế); không log |
| SSRF/scan | Chỉ private IPv4; cap host; auth admin | Admin có thể quét LAN; chấp nhận |
| Rò rỉ qua snapshot/recording | Auth viewer; path validation | Viewer đã được phép xem; chia sẻ tài khoản viewer ngoài phạm vi |
| Session theft | HttpOnly/Secure/SameSite/TTL | Malware trên máy client ngoài phạm vi |
| DoS stream/FFmpeg | Semaphore, max duration, rate limit | Tài nguyên hữu hạn; admin có thể chiếm dụng; chấp nhận |
| DNS rebinding | Host allowlist | Cần cấu hình đúng khi dùng domain |
| ONVIF HTTP nội bộ | Digest auth, LAN | Camera không hỗ trợ HTTPS; chấp nhận |
| CSV injection | Prefix `'` | File CSV vẫn có thể nguy hiểm nếu người dùng bỏ qua; giảm thiểu |
| APK cũ | Không phục vụ; APK v2 release track A | Chưa build APK v2 → release bị chặn |

---

## 9. SECURITY HEADERS, CSP VÀ QUY TẮC BÍ MẬT

### 9.1 Security headers bắt buộc

Áp dụng cho **mọi response** (HTML, JSON, media, static), trừ khi ghi chú khác.

| Header | Giá trị | Ghi chú |
|---|---|---|
| `Content-Security-Policy` | chuỗi ở §9.2 | Không `unsafe-inline`, không `unsafe-eval` |
| `X-Content-Type-Options` | `nosniff` | |
| `X-Frame-Options` | `DENY` | Chống clickjacking |
| `Referrer-Policy` | `no-referrer` | Không gửi Referer |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=(), idle-detection=()` | Không dùng các quyền này |
| `Cross-Origin-Opener-Policy` | `same-origin` | |
| `Cross-Origin-Resource-Policy` | `same-origin` | |
| `X-Permitted-Cross-Domain-Policies` | `none` | |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | **Chỉ khi HTTPS**; không set khi HTTP |
| `Server` | `CCTV` | Ghi đè `server_version`/`sys_version` của WSGIServer để không lộ phiên bản và không tạo header trùng |
| `Cache-Control` | `no-store, no-cache, must-revalidate` | Cho HTML và `/api/*`; static dùng cache riêng |
| `Pragma` | `no-cache` | Tương thích |
| `X-CCTV-API-Version` | `2` | Chỉ `/api/*` |
| `X-Request-Id` | `<id>` | Mọi response |
| `Clear-Site-Data` | `"cache", "storage"` | Chỉ logout/đổi mật khẩu |

- Không thêm `Access-Control-Allow-Origin`/CORS. Ứng dụng chỉ same-origin.
- Không set `X-XSS-Protection` (đã lỗi thời); dựa vào CSP.
- Không set `Public-Key-Pins`.
- Nếu chạy sau reverse proxy, reverse proxy phải không ghi đè/xoá các header này.

### 9.2 CSP chính xác

```
default-src 'none';
script-src 'self';
script-src-attr 'none';
style-src 'self';
style-src-attr 'none';
img-src 'self' data: blob:;
font-src 'self';
media-src 'self' blob:;
connect-src 'self';
worker-src 'self';
manifest-src 'self';
base-uri 'none';
form-action 'self';
frame-ancestors 'none';
object-src 'none'
```

- Khi HTTPS, thêm `upgrade-insecure-requests` (chỉ khi toàn bộ tài nguyên same-origin HTTPS; nếu camera Web GUI HTTP mở tab mới thì không ảnh hưởng).
- Không dùng nonce/hash vì không có inline script.
- `data:` cho phép ảnh nhỏ/placeholder; `blob:` cho snapshot/download do app tạo.
- `connect-src 'self'` cho fetch; MJPEG dùng `img-src`, audio dùng `media-src`.
- Service worker thuộc `worker-src 'self'`; manifest `manifest-src 'self'`.
- `frame-ancestors 'none'` + `X-Frame-Options: DENY`.

### 9.3 Quy tắc không inline script/eval

**Cấm tuyệt đối trong `templates/`, `static/js`, `static/css`:**

- `<script>` không có `src`.
- Thuộc tính sự kiện inline: `onclick`, `onchange`, `onload`, `onerror`, `onsubmit`, `oninput`, `onkeydown`, ... (bất kỳ `on*=`).
- `<style>` trong HTML.
- `style="..."` trong HTML (thuộc tính style).
- `javascript:` URL.
- `eval(`, `new Function(`, `setTimeout("...")`, `setInterval("...")`.
- `document.write`, `document.writeln`.
- `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `createContextualFragment` với dữ liệu động.
- `<iframe srcdoc>`.
- `import()` từ URL ngoài.
- `fetch`/XHR tới origin khác.

**Cho phép:**

- `<script src="/static/js/...">` với `defer`.
- Inline SVG trong `index.html` (sprite `<symbol>`), không phải script.
- Markup tĩnh dùng `<template>` trong `index.html` + `cloneNode(true)`; không dùng `innerHTML` kể cả với chuỗi hằng.
- `element.style.setProperty('--progress', value)` và thay đổi CSSOM khác (không bị CSP `style-src-attr` chặn).
- `URL.createObjectURL(blob)` cho snapshot/download.
- `navigator.clipboard.writeText` sau user gesture.

**Kiểm tra tự động:** `verify_project.py` fail nếu bất kỳ pattern cấm nào xuất hiện trong `templates/` hoặc `static/` (trừ chính `verify_project.py`).

### 9.4 Quy tắc không mật khẩu trong URL/localStorage/DOM

**URL:**

- Không có query/param tên `password`, `pwd`, `pass`, `token`, `secret`, `key`, `auth` trong bất kỳ URL do UI tạo.
- Media URL chỉ có `ip`, `subtype`, `channel`, `_`.
- Server từ chối `password` trong query của media/detail/storage/hardware bằng 400 `PASSWORD_IN_QUERY_FORBIDDEN`.
- Không copy RTSP URL có credential; không hiển thị `rtsp://user:pass@...`.
- Không log URL có query nhạy cảm; nếu có, redact.

**localStorage/sessionStorage:**

- Allowlist duy nhất: `cctv.ui.sidebarCollapsed`, `cctv.ui.grid`, `cctv.ui.pageSize`, `cctv.ui.ptzPresets`.
- `cctv.ui.ptzPresets` chỉ chứa nhãn preset, tối đa 32 ký tự; key có thể là IP (không phải secret); không chứa URL/mật khẩu.
- Core purge mọi key cũ `cam_pwd_*`, `admin_token`, `*password*`, `*secret*`, `*token*` (trừ allowlist UI).
- Không lưu role/session/CSRF.

**DOM:**

- Không prefill mật khẩu đã lưu vào input; không đặt `value` cho field mật khẩu trong HTML template.
- Không đặt mật khẩu vào `data-*`, `title`, `aria-label`, `hidden` input, comment HTML.
- Không render chuỗi `password`/`token` từ API (API cũng không trả).
- Field mật khẩu dùng `type=password`, `autocomplete="off"` (camera) hoặc `current-password`/`new-password` (login/đổi mật khẩu).
- Clear giá trị input ngay sau submit/đóng modal; không lưu vào state toàn cục.
- Không dùng `console.log` object camera/settings; nếu cần debug, log code/status.

**Clipboard:**

- Chỉ copy: LAN URL, serial, IP, mã lỗi. Không copy mật khẩu/RTSP URL.

### 9.5 Bí mật at-rest

**Bắt buộc:**

- `settings.json` **không chứa plaintext admin/viewer**; chỉ chứa `admin_password_hash`/`viewer_password_hash`.
- `default_password`, `telegram_bot_token`, `telegram_chat_id` vẫn có thể nằm trong settings (do yêu cầu chức năng) nhưng:
  - không bao giờ trả qua API,
  - không log,
  - không đóng gói,
  - file quyền 0600/ACL hạn chế.
- `managed_cameras.json` chứa mật khẩu camera; không trả qua API, không log, ACL hạn chế.
- `CCTV_SECRETS_FILE` (tuỳ chọn): file JSON ngoài project chứa các key bí mật; nếu có, ghi đè giá trị trong settings khi đọc và chặn ghi các key đó qua API (409). Dùng cho Docker secret/volume. Nếu biến được đặt nhưng file không đọc được/JSON sai → dừng server mã 2 (fail closed), không fallback về settings.
- Không đưa `settings.json`, `managed_cameras.json`, `data/`, `logs/`, file `.bak`, `.zip`, `.apk` vào `static/`, ZIP phát hành hoặc Docker image.
- `package_windows.py` allowlist; `.dockerignore`/`.gitignore` chặn secret.
- Windows ACL: chỉ user chạy service đọc/ghi; xoá `BUILTIN\Users` quyền ghi nếu có thể.
- Khuyến nghị BitLocker/ổ đĩa mã hoá và chạy service bằng tài khoản riêng.

**Không làm trong đợt này:** mã hoá AES mật khẩu camera at-rest (xem ADR-09). Nếu triển khai sau, phải dùng thư viện chuẩn (`cryptography`) và key từ OS secret store, không tự viết crypto.

### 9.6 Chính sách file tĩnh

- `/static/*` chỉ phục vụ extension allowlist; mọi file khác 404.
- Không phục vụ `.zip`, `.apk`, `.exe`, `.msi`, `.json` (trừ manifest riêng), `.log`, `.py`, `.env`, `.ini`, `.bat`, `.ps1`, `.sh`, `.bak`, `.db`, `.sqlite`, `.map`.
- Không phục vụ dotfile/ẩn.
- `realpath` phải nằm trong `static/`; từ chối `..`, encoded traversal, null byte.
- Không bật directory listing.
- `Content-Type` đúng; `nosniff`.
- `static/CCTVVisionHub_Windows.zip` bị xoá; nếu còn, route phải 404.
- APK chỉ qua `/download/app.apk` (auth viewer), không qua `/static`.
- `offline.html` là file HTML duy nhất được phép trong `/static`.

### 9.7 XSS, CSV injection, SSRF, path traversal, command injection

**XSS:**

- Mọi dữ liệu từ camera/scan/API render bằng `textContent`/`CCTV.dom.el({text})`.
- Thuộc tính do dữ liệu quyết định phải qua allowlist (`title` có thể chứa text; `href` chỉ `/...` hoặc `#...`).
- Tên camera/model/MAC/serial có thể chứa ký tự đặc biệt → không render HTML.
- Snapshot URL do server tạo, nhưng client vẫn validate `safePath`.
- Không dùng `eval` để parse JSON; dùng `JSON.parse`.
- Không dùng `dangerouslySetInnerHTML` (không có React).
- CSP là lớp phòng thủ cuối.

**CSV injection:**

- `/api/export` prefix `'` cho giá trị bắt đầu `=`, `+`, `-`, `@`, `\t`, `\r`.
- Không thay đổi dữ liệu gốc trong bộ nhớ; chỉ khi ghi CSV.
- Tên file ASCII, không chứa IP/token.

**SSRF:**

- Chỉ chấp nhận IPv4 literal thuộc:
  - `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`.
  - **Không** chấp nhận `169.254.0.0/16` (metadata/link-local), `0.0.0.0/8`, multicast, broadcast, public.
- Không chấp nhận hostname trong `ip` cho camera actions (tránh DNS rebinding); nếu tương lai hỗ trợ hostname, phải resolve và kiểm tra IP.
- Scan chỉ private, cap host; không cho `0.0.0.0/0`.
- `CCTV_ALLOW_PUBLIC_TARGETS=1` chỉ dành cho lab, mặc định 0; nếu bật, ghi cảnh báo startup.
- Port cho `managed/cameras/test`: 1–65535; không giới hạn thêm nhưng rate limit.

**Path traversal:**

- `recordings`: filename regex `^[A-Za-z0-9_.-]+\.mp4$`; resolve + prefix check.
- `snapshots`: path không chứa `..`, extension ảnh, resolve + prefix check.
- `settings` dirs: chuẩn hoá absolute; không cho root (`/`, `C:\`); phải nằm dưới `BASE_DIR` hoặc một root trong `CCTV_ALLOWED_STORAGE_ROOTS`; nếu ngoài `BASE_DIR` yêu cầu thêm `CCTV_ALLOW_EXTERNAL_STORAGE=1`; kiểm tra ghi được.
- `static`: resolve + prefix check; deny `..`.
- Không dùng `os.path.join(root, user_input)` mà không resolve.

**Command injection:**

- Mọi lệnh dùng list args, `shell=False`.
- `mpv`/`vlc`: thêm `--` trước URL; không nhận `rtsp_url` từ client.
- FFmpeg: URL do server build từ IP/vendor; không nhận path tùy ý từ client; `rtsp_path` chỉ admin và validate bắt đầu `/`, không whitespace/control.
- Không dùng `os.system`.

### 9.8 Logging và redaction

- Không log request body.
- Không log header `Cookie`, `Authorization`, `X-CSRF-Token`.
- Query string: không có secret; nếu phát hiện key `password`/`token` → log `[redacted]`.
- Redact:
  - Telegram token pattern `\b\d{6,}:[A-Za-z0-9_-]{20,}\b` → `bot***`.
  - `password=...`/`pwd=...` → `password=***`.
  - `rtsp://user:pass@host` → `rtsp://***:***@host`.
- Error 500: trả `request_id`, log stack trace server-side (không trả client).
- Audit log tách khỏi app log; không chứa secret.
- Rotate log; không để log trong web root/Docker image/ZIP.
- `app_crash.log`, `app_test.log` bị xóa; thay bằng `logs/app.log` (gitignored).

---

## 10. DANH SÁCH VIỆC THÊM/XOÁ VÀ CHECKLIST TÍNH NĂNG

### 10.1 Việc cần thêm

**Backend:**

- [ ] `security.py`: scrypt hasher, session store, CSRF, Origin/Host check, rate limiter, security headers hook, decorators `@public`/`@require_role`, JSON error helper, body limit, request ID, client IP.
- [ ] `settings_store.py`: canonical defaults, whitelist, alias migration, secret flags, lock + atomic write, backup, `CCTV_SECRETS_FILE`.
- [ ] `credentials.py`: resolver trả `(username, password)`, hỗ trợ `prefer_body` cho `managed/test`/batch, ephemeral credential store; không hardcode `admin`.
- [ ] `camera_urls.py`: build RTSP URL theo vendor/port/path, dùng chung app/alarm/tracking; nhận username/password từ resolver, không hardcode `admin`.
- [ ] `camera_media.py`: FFmpeg detect/version, semaphore, MJPEG/audio/snapshot, recording manager khóa theo `(ip,channel)`, max duration, cleanup.
- [ ] `app.py`: `/api/auth/*`, `/api/health`, `/api/system/status`, `/api/cameras/credentials`, `/download/app.apk`; decorator cho mọi route; bỏ mọi `request.query.get("password")`; validate input; JSON envelope mới; `CACHED_DEVICES` có lock và copy khi trả API/export; hỗ trợ `CCTV_MIGRATION_ONLY=1` (migrate/validate rồi exit 0/2, không server).
- [ ] `managed_manager.py`: lock + atomic save, `public_view`, status enum, bỏ default `Camera@2020`, cập nhật mật khẩu/IP sau batch.
- [ ] `alarm_manager.py`: grace 120s, canonical keys, `camera_urls`, snapshot không hardcode Dahua và tên file có hậu tố ngẫu nhiên, status `cooldown_seconds`/`human_only`; map history status sang `sent|failed|skipped|suppressed`; bỏ emoji khỏi `title`; sanitize `storage_watchdog.states` đúng shape §6.8; resolve username/password qua `credentials`.
- [ ] `telegram_service.py`: TLS strict, `CCTV_CA_BUNDLE`, timeout, redact token.
- [ ] `scan_imou.py`: bỏ Ruijie/gibberish/fake solar; cap target; private-only; giữ protocol thật; tách `parse_onvif_probe_match`/`parse_sadp_probe_match` thành hàm thuần để test fixture S01–S04.
- [ ] `onvif_manager.py`: XML escape mọi giá trị nội suy; bỏ CGI fallback đặt mật khẩu trong query (chỉ RPC2/ONVIF, camera không hỗ trợ → lỗi rõ); validate IP; timeout; bỏ default `username="admin"`/`default_password="admin"`, nhận credential từ resolver.
- [ ] `app.py`: bỏ mọi `username="admin"` hardcode tại PTZ/details/rename/hardware/storage/batch; dùng `credentials.resolve_credentials`.
- [ ] `scan_imou.py`: đưa `COMPANY_VLANS` vào settings `company_vlans` (default generic, không label site-specific); migrate danh sách cũ một lần; không hardcode IP/label công ty trong source phát hành.
- [ ] `cctv_tray.py`: không gọi API không auth; mở web hoặc login có CSRF.
- [ ] `/api/export` chống CSV injection; `Cache-Control` no-store; `Server` header.
- [ ] Audit log JSONL + rotation.
- [ ] Giữ và đóng gói `dahua/` (11 module, pure-stdlib) trong Docker/EXE/ZIP; test import.
- [ ] `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.gitignore`, `package_windows.py` an toàn; COPY `dahua/`.
- [ ] `scripts/harden_windows_acl.ps1` (hoặc hướng dẫn lệnh) cho settings/managed/data/logs.

**Release/Android:**

- [ ] `scripts/build_apk.sh`: rewrite offline, keystore từ env, output `dist/`, không copy `static/`; `versionName 2.0.0`.
- [ ] `android/`: `allowBackup=false`, cleartext opt-in, `DEFAULT_URL` không hardcode IP, mixed content không always allow; `CCTV_APK_FILE`.
- [ ] `build_windows.py`/`build_exe.bat`: `--add-data=dahua`; không nhúng static APK/ZIP; hỏi trước pip install.

**Frontend:**

- [ ] `templates/index.html`: login screen, shell, sidebar, topbar, sprite SVG, `<script defer>` 7 view, `<link>` 7 view CSS, không inline script/style, viewport cho zoom.
- [ ] `static/css/app.css`: token dark/light, reset, layout, component, responsive, accessibility.
- [ ] `static/js/core.js`: `CCTV.api/auth/state/ui/router/views/media/dom/fmt/poll/icons`, boot, error boundary, legacy storage purge, SW registration.
- [ ] 7 file view JS + 7 file view CSS.
- [ ] `static/offline.html`.
- [ ] `static/sw.js` v2: không cache `/`, network-only navigation/API/media, cache static an toàn.
- [ ] `static/manifest.json`: `lang`, `start_url`, icons nội bộ.

**Test/docs:**

- [ ] `tests/test_security.py`, `tests/support.py`, `tests/fixtures/*`.
- [ ] `tests/verify_project.py`, `tests/ui_smoke.py`.
- [ ] Cập nhật `README.md`, `HUONG_DAN_SU_DUNG_WINDOWS.txt`, `docs/BUILD_APK_GUIDE.md`, `docs/REMOTE_ACCESS_GUIDE.md`, `AGY_INSTRUCTIONS.md`: bỏ PIN mặc định/IP nội bộ, mô tả login mới, test mode, APK v2.

### 10.2 Việc cần xoá

| Hạng mục | Vị trí | Lý do |
|---|---|---|
| Thiết bị giả, MAC giả, trạng thái giả trong deep-link | `templates/index.html:4523-4618` | Demo data, tự bật admin |
| Deep-link `view_admin`, `batch_modal`, `view_admin`, `settings_admin`, `settings_telegram`, `view_grid`, `theater`, `storage_modal`, `stream_solar`, `managed_modal`, `view_managed`, `view_scanner` | `templates/index.html:4523-4618` | Debug/backdoor |
| Tự bật `isAdmin` theo query | `templates/index.html:6092-6098`, `:4528-4562` | Leo thang quyền client |
| Phím tắt bí mật `Ctrl+Shift+A`/`F9` | `templates/index.html:4511-4521` | Backdoor UI |
| Mật khẩu mặc định `Camera@2020` | `managed_manager.py:135`, `templates/index.html:3584`, `:4590-4591` | Credential mặc định |
| Fallback mật khẩu `"admin"` khi thiếu cấu hình | `app.py:78,135`, `alarm_manager.py:146,326,499`, `onvif_manager.py:222,275,360`, các chỗ `default_password` | Thay bằng chuỗi rỗng + 409 `CAMERA_CREDENTIAL_REQUIRED` |
| Hardcode `username="admin"` cho camera | `app.py:779,1083,1109,1345,1375,1398,1424,1449,1455,1471,1493`; `alarm_manager.py:196`; `onvif_manager.py` | Dùng `resolve_credentials` (username + password) |
| Label/serial/IP nội bộ trong source/docs | `scan_imou.py:909-922` (`COMPANY_VLANS`), `AGY_INSTRUCTIONS.md:28,34` | Chuyển config generic; xóa/redact khỏi source phát hành |
| PIN/backdoor `1998`/`Admin@1998` | `app.py:1153,1159,1206,1211`, tài liệu `HUONG_DAN_SU_DUNG_WINDOWS.txt:69` | Backdoor |
| Hardcode tài khoản router Ruijie + `rejectUnauthorized:false` | `scan_imou.py:130-223` (`get_ruijie_clients`) | Credential hardcode, TLS off |
| `gibberish_aes.js` | thư mục gốc | Chỉ dùng cho router hardcode |
| Dữ liệu giả Solar (IP/MAC/serial/name) | `scan_imou.py:225-321`, `:794` | Demo data |
| CGI fallback đặt `pwd`/`pwdOld` trong query string | `onvif_manager.py` (`batch_change_camera_password` fallback) | Lộ mật khẩu qua URL/log; chỉ giữ RPC2/ONVIF |
| XML ONVIF nội suy không escape | `onvif_manager.py` (SetUser/SetNetwork/Timezone) | XML injection/lỗi dữ liệu |
| Hardcode `192.168.10.124` trong copy LAN | `templates/index.html:5775` | Sai môi trường |
| Danh sách VLAN hardcode trong UI | `templates/index.html:4251-4263` | Phải lấy từ API |
| Ba chấm điều khiển cửa sổ giả | `templates/index.html:245-249` | Trang trí |
| Còi WebAudio giả | `templates/index.html:5047-5086` | Gây nhầm trạng thái |
| Ô RTSP URL + copy credential | `templates/index.html:1647-1688`, `:4771-4791`, `:4984-4995` | Lộ mật khẩu |
| Ô nhập mật khẩu camera nhanh + `cam_pwd_*` | `templates/index.html:1690-1733`, `:4885-4896`, `:4920`, `:5660`, `:6276`, `:6573-6578` | Password trong DOM/localStorage |
| `loadSettings()`, `openAlarmModal()` không tồn tại | `templates/index.html:6142,6162,4217` | Lỗi JS |
| `presetsMap` chưa khởi tạo | `templates/index.html:5213-5224` | Lỗi JS |
| Dòng “Live stream is ready” tĩnh / badge Online luôn xanh | `templates/index.html:1735-1739`, `:986-990` | Trạng thái giả |
| CDN Tailwind/Lucide/Alpine, ảnh Unsplash, inline script | `templates/index.html:20-58`, `:1053` | Không self-contained, CSP |
| `static/CCTVVisionHub_Windows.zip` | `static/` | Phát tán secret |
| `static/CCTVVisionHub.apk` + APK cũ root | `static/`, `CCTVVisionHub.apk` | Phục vụ APK cũ không auth/không tương thích; **xoá hẳn** sau khi APK v2 verify; không giữ trong `dist/` |
| Hardcode keystore/storepass/keypass | `scripts/build_apk.sh:124-125,151-152` | Secret trong source; thay bằng env/CI secret |
| Tải aapt2/r8/android.jar từ Internet khi build | `scripts/build_apk.sh:42,53,61` | Supply-chain; dùng SDK local/pin SHA-256 |
| Copy APK vào `static/` | `scripts/build_apk.sh:159,164` | Phát tán công khai; chỉ `dist/` |
| `--add-data=static` kéo APK/ZIP vào EXE | `build_windows.py:48` | Đóng gói secret/artifact cũ |
| `android/app/build/**` | `android/` | Build output/APK cũ không commit/không đóng gói |
| AGY chứa serial/IP/VLAN thật | `AGY_INSTRUCTIONS.md:28,34` | Redact/xóa; không đóng gói |
| `app_crash.log`, `app_test.log` | thư mục gốc | Lộ IP/stack trace |
| `/api/admin/*` | `app.py:1142-1239` | Thay bằng `/api/auth/*` |
| Alias `X-Admin-Token` | `app.py:1138` | Token header cũ |
| `telegram_cooldown`/`telegram_human_only` (alias) | `alarm_manager.py:289-296`, settings | Canonical hóa |
| `rich` CLI trong `scan_imou.py` (nếu không dùng) | `scan_imou.py:951+` | Dependency ngoài requirements |
| Tài liệu chứa PIN/IP nội bộ | `HUONG_DAN_SU_DUNG_WINDOWS.txt:56,69`, `docs/BUILD_APK_GUIDE.md:27` | Lộ thông tin |

### 10.3 Việc cần thay đổi (tóm tắt)

- Đổi mọi route `/api/admin/*` → `/api/auth/*`; bỏ `X-Admin-Token`; cookie `cctv_sid`.
- Đổi media/detail/storage/hardware/record/PTZ từ nhận `password` sang server resolve credential.
- Đổi response lỗi từ string → object `{code,message,request_id}`.
- Đổi `GET /api/settings` thành admin-only, không trả secret; `POST` whitelist.
- Đổi `GET /api/managed/cameras/sync` không trả password; `batch_change_password` không trả `new_password`.
- Đổi status camera sang enum lowercase.
- Đổi `alarm_manager` đọc canonical keys + grace; snapshot theo vendor.
- Đổi mật khẩu camera: chỉ RPC2/ONVIF; bỏ CGI fallback đặt mật khẩu trong query; camera chỉ hỗ trợ CGI phải đổi qua Web GUI và nhận lỗi rõ.
- Đổi UI sang vanilla/CSS thuần, login riêng, 7 view hash.
- Đổi SW/manifest; purge legacy localStorage.
- Đổi packaging/Docker.

### 10.4 Checklist tính năng để nghiệm thu

| # | Tính năng (feature parity) | Màn hình | API chính | Điều kiện nghiệm thu |
|---|---|---|---|---|
| F01 | Quét Dahua/Imou DHDiscover | Scanner | `GET /api/scan` | Trả device thật/fixture; không fake; lọc model |
| F02 | Quét ONVIF WS-Discovery | Scanner | `GET /api/scan` | `discovery_proto` đúng; không duplicate IP |
| F03 | Quét Hikvision SADP | Scanner | `GET /api/scan` | Device hiện trong kết quả |
| F04 | Quét sâu/unicast và VLAN | Scanner | `GET /api/scan`, `GET /api/scan/vlans` | UI hiển thị VLAN từ API, không hardcode |
| F05 | Lọc model/IP/MAC/serial/tên | Scanner | client-side | Lọc đúng, không mất dữ liệu |
| F06 | Export CSV | Scanner | `GET /api/export` | Admin; CSV injection safe; BOM UTF-8 |
| F07 | Thêm/sửa/xoá camera NVR | Camera | `POST/PUT/DELETE /api/managed/cameras` | Admin; password write-only; empty giữ nguyên |
| F08 | Nhóm camera | Camera | managed `group` | Lọc theo nhóm |
| F09 | Arm/disarm từng camera | Camera | `POST .../toggle-alarm` | Admin; viewer chỉ xem badge |
| F10 | Test kết nối trước lưu | Camera | `POST .../test` | TCP + auth; body username/password override credential đã lưu; kết quả chỉ cảnh báo, không tự chặn lưu |
| F11 | Đồng bộ sức khỏe | Camera | `POST .../sync` | Status online/offline/auth_failed/solar_sleep; không password |
| F12 | Đổi IP hàng loạt | Scanner/Camera | `POST /api/batch-ip` | Confirm; preview; cập nhật managed; không đổi default password |
| F13 | Reboot hàng loạt | Scanner/Camera | `POST /api/reboot` | Confirm gõ `REBOOT`; admin |
| F14 | Đồng bộ giờ GMT+7 | Scanner/Camera | `POST /api/sync-time` | Timezone validate; kết quả từng camera |
| F15 | Đổi mật khẩu camera hàng loạt | Scanner/Camera | `POST /api/batch_change_password` | Confirm; không trả mật khẩu; cập nhật managed |
| F16 | Live MJPEG đơn/grid | Live | `GET /api/stream/mjpeg` | Viewer; không password URL; grid 2x2/3x3 |
| F17 | Audio camera | Live | `GET /api/stream/audio` | Viewer; một luồng; user gesture |
| F18 | Snapshot tải về | Live/Camera | `GET /api/snapshot` | Viewer; lỗi hiển thị thật; không báo thành công giả |
| F19 | Ghi hình MP4 start/stop/tải | Live | `/api/record/*` | Admin; filename ngẫu nhiên; max duration; trạng thái REC |
| F20 | PTZ D-pad/tốc độ/stop | Live | `POST /api/ptz` | Admin; action allowlist; viewer không thấy panel |
| F21 | Preset 1–8 đặt/gọi/xoá/đổi tên | Live | `POST /api/ptz` | Admin; tên lưu localStorage (chỉ nhãn) |
| F22 | Chuyển mắt dual-lens | Live | stream `channel=2` | Hoạt động với camera 2 mắt; nhãn đúng |
| F23 | Chuyển SD/HD | Live | stream `subtype` | Thay đổi luồng thật |
| F24 | Trình phát ngoài mpv/VLC | Live | `POST /api/stream/open` | Admin; không nhận rtsp_url; fake test C28; 503 nếu thiếu player thật |
| F25 | Chi tiết camera (model/serial/MAC/firmware/mạng) | Camera | `GET /api/camera/details` | Viewer; không password; dữ liệu thật/không bịa |
| F26 | Đổi tên camera | Camera | `POST /api/camera/name` | Admin; cập nhật managed; lỗi thật |
| F27 | Privacy/Tracking/Siren | Camera | `/api/hardware/*` | Admin; confirm siren; trạng thái thật |
| F28 | Thông tin thẻ nhớ | Storage | `GET /api/storage/info` | Viewer; ẩn path |
| F29 | Format thẻ 2 bước | Storage | `POST /api/storage/format` | Admin; gõ `FORMAT`; server confirm |
| F30 | Tìm clip theo ngày/lọc sự kiện | Storage | `GET /api/storage/recordings` | Viewer; metadata đúng |
| F31 | Arm/disarm toàn hệ thống | Alarms | `POST /api/alarm/toggle` | Admin; confirm khi tắt |
| F32 | Lịch gác | Alarms/Settings | `GET/POST /api/settings` | Cấu hình đúng canonical key; AlarmManager đọc đúng |
| F33 | Cấu hình Telegram write-only | Settings | `GET/POST /api/settings` | Không trả token/chat ID |
| F34 | Gửi thử Telegram | Alarms | `POST /api/alarm/test` | Admin; chỉ cấu hình đã lưu; test mode chặn |
| F35 | Lịch sử cảnh báo + ảnh | Alarms | `GET /api/alarm/history` | Viewer; snapshot URL auth |
| F36 | Xoá lịch sử | Alarms | `POST /api/alarm/clear_history` | Admin; confirm |
| F37 | Watchdog thẻ nhớ + chạy ngay | Alarms | `GET /api/alarm/status`, `POST .../check_now` | Admin chạy; viewer xem; test mode luôn 503 nên success path là manual/notCovered |
| F38 | Đổi mật khẩu admin | Settings | `POST /api/auth/change_password` | scrypt; thu hồi session; không trả hash |
| F39 | Đặt/xoá mật khẩu viewer | Settings | `POST /api/auth/change_password` | Admin re-auth; viewer login bật/tắt |
| F40 | Cấu hình scan/timeout/dirs | Settings | `GET/POST /api/settings` | Whitelist; validate; lưu atomic |
| F41 | Chẩn đoán FFmpeg | Settings/Dashboard | `GET /api/health` | Hiển thị available/version/audio_available; video/audio 503 đúng capability |
| F42 | PWA cài đặt/offline | Settings/Shell | `manifest.json`, `sw.js` | Cài được; offline page; không cache API |
| F43 | Tải APK nội bộ | Settings | `GET /download/app.apk` | Auth viewer; 404 nếu chưa có v2 |
| F44 | Login admin/viewer | Login | `/api/auth/*` | Phân biệt vai trò; rate limit; cookie an toàn |
| F45 | Dashboard KPI/cảnh báo/sức khỏe | Dashboard | `GET /api/system/status` | Dữ liệu thật; banner FFmpeg/mật khẩu/session |
| F46 | Session hết hạn/quyền | Toàn app | mọi API | 401 về login; 403 toast; 429 đếm ngược; 503 banner |
| F47 | Không có dữ liệu giả | Toàn app | — | Không fake device/MAC/password; fixture chỉ trong test |
| F48 | Không có quyền admin ẩn | Toàn app | — | Không query/phím tắt; viewer không thấy nút admin |

---

## 11. KẾ HOẠCH KIỂM THỬ

### 11.1 Test mode và biến môi trường

Chạy test **bắt buộc** với:

```bat
set CCTV_TEST_MODE=1
set CCTV_DISABLE_ALARMS=1
set CCTV_DISABLE_TELEGRAM=1
set CCTV_DISABLE_FFMPEG=1
set CCTV_DISABLE_BROWSER=1
set CCTV_SETTINGS_FILE=%TEMP%\cctv-test\settings.json
set CCTV_MANAGED_FILE=%TEMP%\cctv-test\managed_cameras.json
set CCTV_BOOTSTRAP_FILE=%TEMP%\cctv-test\bootstrap_admin.txt
set CCTV_AUDIT_LOG=%TEMP%\cctv-test\audit.jsonl
set CCTV_APP_LOG=%TEMP%\cctv-test\app.log
set CCTV_RECORDINGS_DIR=%TEMP%\cctv-test\recordings
set CCTV_SNAPSHOTS_DIR=%TEMP%\cctv-test\snapshots
set CCTV_ALLOWED_STORAGE_ROOTS=%TEMP%\cctv-test
set CCTV_ALLOW_EXTERNAL_STORAGE=1
set CCTV_HOST=127.0.0.1
set CCTV_PORT=18080
set CCTV_ADMIN_PASSWORD=Test-Admin-Password-2026
set CCTV_TEST_SCAN_FIXTURE=tests\fixtures\scan_devices.json
set CCTV_TEST_FAKE_CAMERA=1
```

PowerShell tương đương dùng `$env:...`.

**Quy tắc test mode:**

- Không mở browser.
- Không start AlarmManager.
- Không gọi Telegram/camera/ONVIF/FFmpeg/mpv/VLC/Explorer.
- Không đọc/ghi `settings.json`/`managed_cameras.json` thật.
- Không sinh `data/bootstrap_admin.txt` trong project.
- Không bind `0.0.0.0` hoặc port 8080; nếu env cố tình đặt → thoát với lỗi rõ ràng.
- Scan chỉ trả fixture; nếu không có fixture → 503 `TEST_MODE_BLOCKED`.
- Mọi endpoint cần camera/Telegram/FFmpeg/player/Explorer trả 503 `TEST_MODE_BLOCKED`, **trừ**:
  - `CCTV_TEST_FAKE_CAMERA=1` + IP `10.255.255.0/24`: fake backend trả fixture, không mở socket/FFmpeg;
  - `CCTV_TEST_TELEGRAM_MOCK=1` + `CCTV_DISABLE_TELEGRAM=0`: `/api/alarm/test` gọi mock local, không outbound.
- Fake backend chỉ nạp khi `CCTV_TEST_MODE=1`; nếu `CCTV_TEST_FAKE_CAMERA=1` mà không có test mode hoặc thiếu file fixture → thoát mã 2.
- Fake backend áp dụng cho cả hành động destructive (format/reboot/batch) **chỉ với IP fixture**, mô phỏng kết quả, không gọi camera; IP ngoài fixture vẫn 503.
- Hành vi fake backend (IP `10.255.255.0/24`):
  - MJPEG: generator multipart trả `frame.jpg` lặp lại; `audio`: bytes `sample.mp3`; `snapshot`: `frame.jpg`.
  - `record/start`: tạo entry; `record/stop`: copy `sample.mp4` vào `recordings_dir`, trả `download_url`; file tải được.
  - `ptz`, `camera/name`, `hardware/privacy|tracking|siren`, `storage/info|format|recordings`, `managed/test|sync`, `stream/open` (player `fake`), batch IP/reboot/time/password: trả success fixture deterministic, ghi log username nhận được (không log password).
  - Không mở socket, không spawn FFmpeg/mpv/VLC, không ghi ngoài temp/recordings test.
- Thêm/sửa camera bỏ qua enrichment qua mạng và lưu dữ liệu từ body.
- Test support từ chối chạy nếu `CCTV_SETTINGS_FILE`/`CCTV_MANAGED_FILE` nằm trong thư mục dự án (trừ `tests/fixtures`).
- `CCTV_TEST_MODE` phải được log ở mức WARNING khi khởi động (không lẫn với production).
- `CCTV_MIGRATION_ONLY=1` chỉ hợp lệ khi `CCTV_TEST_MODE=1`; nếu không → exit 2. Chế độ này chạy `SettingsStore` migration/validation trên file cấu hình tạm rồi exit, không bind cổng, không start AlarmManager.
- `run_migration_case(env_overrides)` trong `tests/support.py` phải chạy **subprocess riêng** cho từng ca (không dùng app import chung), truyền `CCTV_MIGRATION_ONLY=1`, `CCTV_SETTINGS_FILE`/`CCTV_BOOTSTRAP_FILE` temp, env theo ca; trả `returncode`, stdout/stderr đã redact và settings sau migration.

### 11.2 File test và quyền sở hữu

| File | Owner | Mục đích |
|---|---|---|
| `tests/__init__.py` | A | Package |
| `tests/support.py` | A | WSGI client in-process, temp config, cookie jar, JSON helper, fake-camera fixture loader, `run_migration_case(env_overrides)` dùng subprocess riêng |
| `tests/mock_telegram.py` | A | Mock HTTP/HTTPS Telegram local, ghi request, trả lỗi có token để test redaction; chỉ test |
| `tests/test_security.py` | A | Ma trận quyền, auth, CSRF, rate limit, headers, secrets, validation, SSRF |
| `tests/fixtures/scan_devices.json` | A | Device dải test riêng `10.255.255.0/24`, không secret |
| `tests/fixtures/settings.test.json` | A | Settings temp không secret, có plaintext admin giả để test migration |
| `tests/fixtures/camera/{frame.jpg,sample.mp4,sample.mp3}` | A | Fixture fake camera cho test success path; không phải dữ liệu sản phẩm |
| `tests/fixtures/scan/{dhip.bin,onvif.xml,sadp.xml}` | A | Packet/XML fixture cho parser S01–S04; không gọi mạng |
| `tests/fixtures/forbidden_patterns.json` | A | Regex/pattern nhạy cảm cho V24; **không chứa giá trị thật** |
| `tests/verify_project.py` | B | Invariant tĩnh |
| `tests/ui_smoke.py` | B | HTTP smoke với server thật ở 18080 |

**Lưu ý:** `unittest discover -s tests` chỉ chạy `test_*.py`; `verify_project.py` và `ui_smoke.py` chạy riêng.

### 11.3 `tests/test_security.py` — các ca bắt buộc

Dùng WSGI in-process (`bottle.default_app()`) với env test đặt trước khi import `app` cho các ca API thông thường. **Các ca migration B19/B20/B23/B24/B25/B26 phải dùng `run_migration_case`/subprocess riêng**, vì mỗi ca cần env `CCTV_ADMIN_PASSWORD` khác nhau và không được phụ thuộc env toàn cục. `run_migration_case` chỉ chạy migration/validation rồi exit; ca cần login (B19/B24) dùng một app instance/subprocess khác trỏ cùng temp settings. Không mở cổng.

**A. Public/route**

| ID | Ca | Kỳ vọng |
|---|---|---|
| A01 | GET `/api/health` không cookie | 200; `ok=true`, `status` là chuỗi `ok` hoặc `degraded`; không secret |
| A02 | GET `/api/auth/me` không cookie | 200, `authenticated=false`, không set cookie |
| A03 | POST `/api/auth/login` đúng | 200, cookie, không token JSON |
| A04 | 4 route `/api/admin/*` (kể cả có cookie admin) | 404 |
| A05 | GET `/` không cookie | 200, có login screen, shell hidden |
| A06 | GET `/static/css/app.css` | 200, `text/css` |
| A07 | GET `/static/CCTVVisionHub_Windows.zip` | 404 |
| A08 | GET `/static/../settings.json` | 403/404 |
| A09 | GET `/download/app.apk` không cookie | 401 |
| A10 | GET `/download/app.apk` viewer, chưa có file | 404 `APK_NOT_AVAILABLE` |
| A11 | `import dahua, app` trong venv test | Thành công; `dahua.__version__` tồn tại; không ModuleNotFoundError |

**B. Auth/session**

| ID | Ca | Kỳ vọng |
|---|---|---|
| B01 | Login sai mật khẩu | 401 `INVALID_CREDENTIALS`, message chung |
| B02 | Login username lạ | 401 cùng message (không enumeration) |
| B03 | 5 lần sai liên tiếp | Lần 6 → 429, có `Retry-After` |
| B04 | Sau 5 phút (unit test `LoginRateLimiter(now_fn=...)`) | Login đúng → 200 |
| B05 | Cookie sau login | `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age` = TTL cấu hình (mặc định 43200), không `Secure` trên HTTP |
| B06 | `CCTV_HTTPS=1` | Cookie có `Secure` |
| B07 | Token session trong JSON | Không có key `token`/`session_token` |
| B08 | `/api/auth/me` có cookie | `authenticated=true`, có `csrf_token`, role đúng |
| B09 | Logout không CSRF | 403 `CSRF_INVALID` |
| B10 | Logout có CSRF | 200; dùng lại cookie cũ → 401 |
| B11 | Session TTL (unit test `SessionStore(now_fn=...)`, now = TTL+1) | 401 |
| B12 | Đổi mật khẩu admin sai current | 401 |
| B13 | Đổi mật khẩu admin mới yếu (<10) | 400 |
| B14 | Đổi mật khẩu admin thành công | 200; session cũ 401; login mật khẩu cũ 401; mật khẩu mới 200 |
| B15 | Viewer login khi chưa đặt mật khẩu | 403 `VIEWER_LOGIN_DISABLED` |
| B16 | Admin đặt viewer password | 200; viewer login 200; role viewer; **phải đăng nhập lại admin** cho bước sau (revoke all) |
| B17 | Xoá viewer password | 200; viewer login 403; session viewer cũ 401; đăng nhập lại admin |
| B18 | Scrypt format trên file | Khớp `^scrypt\$\d+\$\d+\$\d+\$...`; không có `admin_password` plaintext |
| B19 | Migration plaintext admin custom qua `run_migration_case(env không có CCTV_ADMIN_PASSWORD)` | Hash được tạo; plaintext bị xóa; login bằng mật khẩu cũ 200 |
| B20 | Migration plaintext `Admin@1998`/`1998` qua `run_migration_case` | Không login được bằng 2 giá trị này; bootstrap mới được tạo |
| B21 | Hash admin hỏng | `SettingsStore` raise; server exit mã 2; không ghi đè, không tạo bootstrap thay thế |
| B22 | `CCTV_SECRETS_FILE` | Admin/viewer hash đọc từ file; API đổi mật khẩu → 409 |
| B23 | `run_migration_case` backdoor/default, không env, bootstrap path không ghi được | Subprocess exit mã 2; settings không bị ghi; không mất dữ liệu |
| B24 | `run_migration_case` backdoor/default + `CCTV_ADMIN_PASSWORD` mạnh | Hash mới; login bằng env 200; backdoor cũ 401 |
| B25 | `run_migration_case` plaintext custom yếu (<10), không env | Nếu bootstrap ghi được: exit 0 + bootstrap mới, mật khẩu cũ không dùng; nếu không ghi được: exit 2; không hash giữ nguyên/yếu |
| B26 | Managed legacy thiếu cả `alarm_armed`/`alarm_enabled` | Giữ `true`, cảnh báo `ALARM_STATE_DEFAULTED`, không tự tắt gác |

**C. RBAC**

| ID | Ca | Kỳ vọng |
|---|---|---|
| C01 | Ma trận: mọi endpoint `V`/`A` không cookie | 401 (trừ public) |
| C02 | Ma trận: mọi endpoint `A` với cookie viewer | 403 |
| C03 | Viewer GET stream/snapshot/details/storage/alarm status/history với managed fixture IP | 200 (fake backend) hoặc 503 nếu fake backend tắt; không 401/403 |
| C04 | Viewer GET `/api/system/status` | 200 |
| C05 | Viewer GET `/api/settings` | 403 `FORBIDDEN` (admin-only) |
| C06 | Viewer POST settings/format/reboot/PTZ/batch/alarm/toggle | 403 trước validate |
| C07 | Admin POST với `{}` (thiếu field) | 400, không phải 403 |
| C08 | Admin GET `/api/settings` | Có cờ `secrets.*_set`, không giá trị |
| C09 | Viewer GET stream/details/storage với IP ngoài managed | 404 `CAMERA_NOT_FOUND` |
| C10 | Admin GET stream với IP ngoài managed/fake range, `default_password` rỗng | 409 `CAMERA_CREDENTIAL_REQUIRED` (media class: credential trước test-block) |
| C11 | Viewer GET managed cameras | Không có `username`, `note`, `rtsp_path`, `password` |
| C12 | Camera managed có `username` khác `admin` | Stream/PTZ/details/storage/batch dùng đúng username (fake backend log username) |
| C13 | Viewer GET MJPEG managed fixture (fake backend) | 200 `multipart/x-mixed-replace`, có frame JPEG, không gọi camera |
| C14 | Viewer GET audio managed fixture | 200 `audio/mpeg`, có bytes MP3 fixture |
| C15 | Viewer GET snapshot managed fixture | 200 `image/jpeg`, đúng bytes fixture |
| C16 | Admin record start/stop + tải file fixture | 200; file trong recordings_dir; `/api/recordings/...` 200 |
| C17 | Admin PTZ các action allowlist (fake) | 200; action không hỗ trợ 400 |
| C18 | Admin hardware privacy/tracking/siren + storage info/format/recordings (fake) | 200 đúng shape |
| C19 | Admin camera rename + managed test/sync + batch IP/reboot/time/password (fake) | 200; success_count đúng |
| C20 | Viewer không thấy/không gọi được admin actions trên fake camera | 403 trước business |
| C21 | Viewer GET storage recordings (fake) | `RecordingClip.file_path` là `null`; admin nhận path |
| C22 | Dual-lens: stream/snapshot `channel=2`; record start `channel=2` (fake) | 200; filename/status có `channel=2`; ghi mắt 2 độc lập |
| C23 | `POST /api/alarm/test` với mock Telegram (`CCTV_TEST_TELEGRAM_MOCK=1`, `CCTV_DISABLE_TELEGRAM=0`, base URL local) | 200; mock nhận `sendMessage`, không outbound |
| C24 | Mock Telegram trả lỗi có token trong body/message | API trả 502 `TELEGRAM_SEND_FAILED`; token bị redact trong response/audit/log |
| C25 | `CCTV_CA_BUNDLE` + mock HTTPS (`CCTV_TEST_TELEGRAM_TLS=1`) | TLS verify thành công với CA test; nếu không tạo được cert (thiếu openssl) → `notCovered`, không đánh dấu pass |
| C26 | `telegram_service._get_ssl_context()` không CA bundle | `check_hostname=True`, `verify_mode=CERT_REQUIRED`; không có `CERT_NONE` |
| C27 | `managed/cameras/test` với password/username body khác credential đã lưu (fake) | Dùng body override (prefer_body=True), không dùng mật khẩu cũ |
| C28 | `POST /api/stream/open` fake IP fixture | 200 `player="fake"`; không mở mpv/VLC thật |

**D. CSRF/Origin/Host**

| ID | Ca | Kỳ vọng |
|---|---|---|
| D01 | Admin POST không `X-CSRF-Token` | 403 `CSRF_INVALID` |
| D02 | Admin POST sai CSRF | 403 |
| D03 | Admin POST `Origin: http://evil.example` | 403 `ORIGIN_MISMATCH` |
| D04 | Admin POST `Origin` đúng | Không 403 |
| D05 | `Host: evil.example` | 400 `HOST_NOT_ALLOWED` |
| D06 | POST `Content-Type: application/x-www-form-urlencoded` | 415 |
| D07 | Body > 1 MiB | 413 |
| D08 | JSON sai | 400 `VALIDATION_ERROR` |
| D09 | Thiếu `X-CSRF-Token` nhưng có `Origin` đúng | 403 (CSRF vẫn bắt buộc) |

**E. Rate limit**

| ID | Ca | Kỳ vọng |
|---|---|---|
| E01 | Login 6 lần sai | 429, `Retry-After` >0 |
| E02 | Scan >6/phút | 429 |
| E03 | `alarm/test` >2/phút (kể cả test mode; rate limit trước test-block) | 429 |
| E04 | `cameras/credentials` >10/phút | 429 |
| E05 | 429 không ghi mật khẩu vào audit | Audit không chứa password |

**F. Secrets/response**

| ID | Ca | Kỳ vọng |
|---|---|---|
| F01 | GET managed cameras | Không key `password`/`alarm_enabled` |
| F02 | GET settings (admin) | Không `telegram_bot_token`, `telegram_chat_id`, `admin_password*`, `viewer_password*`, `default_password`; viewer nhận 403 |
| F03 | POST managed sync | Không key `password` |
| F04 | POST batch change password | Không `new_password` |
| F05 | Toàn bộ response JSON của 1 phiên test | Không chứa giá trị secret fixture |
| F06 | Media endpoint có `?password=` | 400 `PASSWORD_IN_QUERY_FORBIDDEN` |
| F07 | `POST /api/cameras/credentials` | Response không chứa password; audit không chứa password |
| F08 | `/api/settings` POST thử `admin_password`/`evil_key` | Không lưu các key này |
| F09 | Telegram token set | GET chỉ trả `secrets.telegram_bot_token_set=true` |
| F10 | Audit log | Không chứa secret/pattern token |

**G. Validation/SSRF/path/CSV**

| ID | Ca | Kỳ vọng |
|---|---|---|
| G01 | Scan `8.8.8.8/32` | 400 |
| G02 | Scan `10.0.0.0/8` | 400 (quá lớn) |
| G03 | Scan `0.0.0.0/0` | 400 |
| G04 | Scan 9 biểu thức | 400 |
| G05 | Managed test IP public | 400 |
| G06 | Admin stream IP public (không bật `CCTV_ALLOW_PUBLIC_TARGETS`) | 400 `INVALID_IP`; viewer cùng IP → 404 `CAMERA_NOT_FOUND` |
| G07 | `batch_change_password` confirm thiếu | 400 |
| G08 | `storage/format` confirm thiếu/sai | 400 |
| G09 | `reboot` confirm thiếu | 400 |
| G10 | `batch-ip` confirm thiếu | 400 |
| G11 | `sync-time` timezone sai | 400 |
| G12 | `storage/recordings` date sai | 400 |
| G13 | `/api/recordings/..%2fsettings.json` | 404 |
| G14 | `/snapshots/../settings.json` | 403/404 |
| G15 | CSV với tên bắt đầu `=cmd…` | Có prefix `'`; không thực thi |
| G16 | Test mode: alarm test/format/reboot/scan (không vượt rate limit; IP ngoài fake fixture hoặc tắt fake) | 503 `TEST_MODE_BLOCKED`; scan có fixture → 200; nếu đã vượt rate limit → 429 |
| G17 | PTZ action không hỗ trợ | 400 `VALIDATION_ERROR`; không gọi camera |
| G18 | PTZ preset thiếu/ngoài 1–8 | 400 |
| G19 | Test mode `storage/watchdog/check_now` với `force_send=false` và `true` | Cả hai 503 `TEST_MODE_BLOCKED`; không camera/Telegram |

**H. Headers/static**

| ID | Ca | Kỳ vọng |
|---|---|---|
| H01 | GET `/` | CSP đúng, không `unsafe-inline`/`unsafe-eval` |
| H02 | Header `X-Content-Type-Options` | `nosniff` |
| H03 | `X-Frame-Options` | `DENY` |
| H04 | `Referrer-Policy` | `no-referrer` |
| H05 | `Permissions-Policy` | Có `camera=()` |
| H06 | API response | `Cache-Control: no-store` |
| H07 | `Server` header | Không chứa `WSGIServer`/phiên bản Python |
| H08 | `/api/health` | Không `Set-Cookie` |
| H09 | Static ZIP/APK/log | 404 |
| H10 | `/download/app.apk` viewer | 404/200, không cache qua SW |

**I. FFmpeg/health**

| ID | Ca | Kỳ vọng |
|---|---|---|
| I01 | `CCTV_DISABLE_FFMPEG=1` | `/api/health` `ffmpeg.available=false`, `status=degraded` |
| I02 | Stream/snapshot khi FFmpeg tắt | 503 `FFMPEG_UNAVAILABLE` (nếu không ở test mode chặn trước) |
| I03 | Record start khi FFmpeg tắt | 503 |
| I04 | `CCTV_FFMPEG_PATH` không tồn tại | 503, không crash startup |
| I05 | FFmpeg có nhưng thiếu libmp3lame | `health.ffmpeg.audio_available=false`; audio 503 `FFMPEG_UNAVAILABLE` capability audio; MJPEG/snapshot vẫn 200 |

**S. Scanner parser (bắt buộc, không mở socket; class trong `tests/test_security.py`)**

| ID | Ca | Kỳ vọng |
|---|---|---|
| S01 | `build_probe_packet` + `parse_device_packet` với fixture DHIP JSON | Parse đúng IP/MAC/serial/model; roundtrip không lỗi |
| S02 | `parse_onvif_probe_match(xml, sender_ip)` với fixture WS-Discovery | Đúng XAddrs/IP/port, Scopes → vendor/name |
| S03 | `parse_sadp_probe_match(xml, sender_ip)` với fixture SADP | Đúng IPv4/SN/MAC/HTTP/command port; vendor Hikvision/Ezviz |
| S04 | `parse_target_ips` CIDR/range/IP + cap | Đúng danh sách; vượt `max_hosts` → error; public → error |

**U. Unit test AlarmManager/audit/media (bắt buộc; class trong `tests/test_security.py`)**

| ID | Ca | Kỳ vọng |
|---|---|---|
| U01 | AlarmManager trong grace, inject event | Không history, không Telegram, không listener; hết grace mới xử lý |
| U02 | `_log_history`/map status + title | `status` thuộc `sent`, `failed`, `skipped`, `suppressed`; title không emoji |
| U03 | `storage_watchdog.states` sanitize | Chỉ `name/status/error_code/last_check`; không exception/path/size |
| U04 | Audit event coverage | login_success, login_failure, settings_update, camera_delete, alarm_toggle, storage_format... ghi đúng event; không secret |
| U05 | Semaphore MJPEG/audio/record (fake) | Vượt giới hạn → 429; per-session 9; release khi stop |
| U06 | Cleanup | Stop/destroy/shutdown → active streams/recordings = 0; không process/file ngoài temp |
| U07 | Record max duration (fake clock) | Tự dừng đúng `CCTV_MAX_RECORDING_SECONDS`, file được đóng |
| U08 | `camera_urls.build_rtsp_url` cho Dahua/Imou, Hikvision, Tapo, Uniview, custom path | URL đúng vendor/port/channel/subtype; username/password từ resolver |

### 11.4 `tests/verify_project.py` — invariant tĩnh

Mỗi mục là một check in kết quả `PASS/FAIL`, exit code 1 nếu có FAIL.

| ID | Check |
|---|---|
| V01 | Tồn tại đủ file bắt buộc: `templates/index.html`, `static/css/app.css`, `static/js/core.js`, 7 view JS, 7 view CSS, `security.py`, `settings_store.py`, `credentials.py`, `camera_urls.py`, `camera_media.py`, `dahua/__init__.py` + 10 module `.py`, `tests/test_security.py`, `tests/verify_project.py`, `tests/ui_smoke.py`, `tests/support.py`, `tests/mock_telegram.py`, `tests/fixtures/camera/frame.jpg`, `tests/fixtures/camera/sample.mp4`, `tests/fixtures/camera/sample.mp3`, `tests/fixtures/scan/{dhip.bin,onvif.xml,sadp.xml}`, `tests/fixtures/forbidden_patterns.json` |
| V02 | Mỗi hàm `@route` trong `app.py` có `@public` hoặc `@require_role(...)` (AST) |
| V03 | Không còn chuỗi `/api/admin/` trong `templates/`, `static/js`, `static/css` (test âm tính được phép) |
| V04 | Không có CDN/tài nguyên ngoài trong HTML/CSS/JS: `cdn.`, `unpkg.com`, `jsdelivr`, `fonts.googleapis`, `images.unsplash`, `src="http`, `href="http`, `url(http` |
| V05 | Không có `<script>` không `src`; không có thuộc tính `on*=`; không `<style>`; không `style="` trong HTML |
| V06 | Không có `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval(`, `new Function`, `setTimeout("`, `setInterval("` trong `static/js` |
| V07 | Không có `localStorage`/`sessionStorage` với key chứa `password`/`token`/`secret`; chỉ allowlist `cctv.ui.*` |
| V08 | Không có `?password=`, `&password=`, `password:` trong URL construction; không có `cam_pwd_` |
| V09 | Không có deep-link token: `view_admin`, `batch_modal`, `settings_admin`, `settings_telegram`, `storage_modal`, `stream_solar`, `theater`, `view_grid`, `managed_modal`, `view_managed`, `view_scanner` |
| V10 | Không có backdoor/default password (`Admin@1998`, `1998` dạng password, `Camera@2020`), phím tắt bí mật trong **UI + backend + release docs**. Scope: `templates/`, `static/` (trừ `static/download`), `app.py` + module backend, `README.md`, `HUONG_DAN_SU_DUNG_WINDOWS.txt`, `docs/BUILD_APK_GUIDE.md`, `docs/REMOTE_ACCESS_GUIDE.md`, `AGY_INSTRUCTIONS.md`, `README_RESTORE_HUONG_DAN.txt`. **Loại trừ:** `docs/UI_REBUILD_SPEC.md`, `tests/` (negative assertions), `settings.json`, `managed_cameras.json`. |
| V11 | Không có IP/MAC/serial giả cũ trong UI/backend/release docs. Scope: như V10 + **chỉ file dữ liệu** trong `tests/fixtures/**` (fixture phải dùng `10.255.255.x`). **Loại trừ:** `managed_cameras.json` (dữ liệu thật, read-only), `settings.json`, `docs/UI_REBUILD_SPEC.md`, `tests/*.py` (negative assertions), `tests/mock_telegram.py`. |
| V12 | Không có `static/CCTVVisionHub_Windows.zip`, `app_crash.log`, `app_test.log` |
| V13 | `settings.json`/`managed_cameras.json` không nằm trong `static/`; `package_windows.py` exclude chúng và không copy ZIP vào `static` |
| V14 | `Dockerfile` có `USER` non-root, không `COPY . .` (hoặc `.dockerignore` chặn secret), không `network_mode: host` mặc định |
| V15 | `.dockerignore`/`.gitignore` chứa `settings.json`, `managed_cameras.json`, `*.log`, `data/`, `logs/`, `*.zip`, `*.apk`, `python_env/` |
| V16 | `manifest.json` không có URL ngoài; `start_url`/`scope` `/`; `lang` `vi` |
| V17 | `sw.js` không cache `/`, `/api/`, `/snapshots/`, `/download/`; có version mới; có `skipWaiting` |
| V18 | Viewport cho phép zoom: không `user-scalable=no`, không `maximum-scale=1` |
| V19 | Không emoji trong chrome: quét dải emoji trong `templates/index.html` và `static/js` (trừ fixture/test) |
| V20 | Mọi icon dùng trong `CCTV.icons.svg`/`data-icon` có `<symbol id="i-...">` trong sprite |
| V21 | `index.html` tham chiếu đủ 7 view JS/CSS; không tham chiếu file không tồn tại |
| V22 | Có `data-testid` bắt buộc trong HTML/JS (theo §2.9) |
| V23 | `requirements.txt` không thêm dependency mới ngoài baseline (`bottle`, `requests`, `urllib3`, `pillow`, `pystray`) |
| V24 | Release docs (`README`, `HUONG_DAN...`, `BUILD_APK_GUIDE`, `REMOTE_ACCESS_GUIDE`, `AGY_INSTRUCTIONS`) không chứa **pattern denylist**: PIN/backdoor, IP server nội bộ dạng site-specific, serial/MAC thật, label VLAN site-specific. Pattern đọc từ `tests/fixtures/forbidden_patterns.json` (regex, **không chứa giá trị thật**) để tránh mâu thuẫn V30; IP/serial không phải secret nhưng vẫn nhạy cảm. Không cấm RFC1918 generic có `x`/`0/24`. Loại trừ `docs/UI_REBUILD_SPEC.md`, `tests/`, `settings.json`, `managed_cameras.json`. |
| V25 | `app.py` không có `request.query.get("password")`; không có `new_password` trong response; không có `admin_password` trong JSON trả về; không có `username="admin"` hardcode trong call site camera (grep/ast) |
| V26 | `scan_imou.py` không còn `get_ruijie_clients`, `gibberish`, `192.168.10.179`, `82ACDA`, `rejectUnauthorized` |
| V27 | `telegram_service.py` không còn `CERT_NONE`, `check_hostname = False`, `verify=False` |
| V28 | `alarm_manager.py` có `grace`, đọc `telegram_cooldown_seconds`/`telegram_ai_filter_human`, dùng `camera_urls`, map status enum, không emoji title, sanitize watchdog state |
| V29 | `package_windows.py` không copy ZIP vào `static`; output ngoài `static`; có SHA-256 |
| V30 | `tests/` tồn tại và có fixture; không chứa secret thật |
| V31 | Không có `.zip`/`.apk` được tham chiếu công khai; static route deny hai extension này; APK chỉ qua `/download/app.apk` |
| V32 | `dahua/__init__.py` tồn tại; `python -c "import dahua, app"` thành công trong venv test (không thiếu vendored package) |
| V33 | `Dockerfile` COPY `dahua/`; `package_windows.py` include `dahua/`; `build_windows.py` có `--add-data=dahua`; `requirements.txt` **không** thêm package dahua |
| V34 | ZIP phát hành không chứa `docs/`, `settings.json`, `managed_cameras.json`, `*.log`, `*.apk`, `*.zip`, `tests/`, `python_env/`; có `dahua/` |
| V35 | Quét `static/`, `static/download/`, `dist/`, root: không còn `*.apk`/`*.zip` cũ, `android/app/build/**`, `CCTVVisionHub.apk` cũ; `dist/` chỉ được chứa đúng tên `CCTVVisionHub-v2.apk` (+ `.sha256`) và `CCTVVisionHub_Windows_2.0.0.zip` (+ `.sha256`) |
| V36 | Không còn hardcode `username="admin"` trong `app.py`/`onvif_manager.py`/`alarm_manager.py` (grep cho call site camera); chỉ default qua resolver |
| V37 | `alarm_manager.py` không còn emoji trong `event_title`/`title`; status history map sang enum |

### 11.5 `tests/ui_smoke.py` — luồng HTTP

Chạy server test thật ở `127.0.0.1:18080` bằng subprocess với env §11.1. Dùng `requests.Session`.

1. Tạo temp dir, ghi settings fixture (có plaintext admin giả để test migration), managed fixture có camera `10.255.255.10` (password fixture), scan fixture.
2. Start `python app.py`; chờ `/api/health` tối đa 30s.
3. Assert health: `mode=test`, `ffmpeg.available=false`, `status=degraded` (do `CCTV_DISABLE_FFMPEG=1`).
4. GET `/`: 200, có `login-screen`, `app-shell` hidden, CSP header, không inline script.
5. GET `/static/css/app.css`, `/static/js/core.js`, 7 view JS: 200.
6. GET `/api/auth/me`: `authenticated=false`.
7. POST `/api/auth/login` sai: 401.
8. POST login admin đúng: 200; kiểm tra cookie flags; không token JSON; lưu CSRF.
9. GET `/api/auth/me`: admin; csrf.
10. GET `/api/system/status`: 200; JSON không chứa secret.
11. GET `/api/managed/cameras`: 200; không key `password`.
12. POST `/api/settings` không CSRF: 403; có CSRF: 200.
13. GET `/api/scan` với fixture: 200; `devices` không `raw_info`.
14. POST `/api/storage/format` IP ngoài fake (`10.255.254.1`) không confirm: 400; có confirm: 503 `TEST_MODE_BLOCKED`.
15. POST `/api/reboot` IP ngoài fake + confirm: 503.
16. POST `/api/alarm/test` (không snapshot): 503.
17. Viewer login khi chưa bật: 403.
18. Admin đặt viewer password: 200; **đăng nhập lại admin** (revoke all); viewer login: 200.
19. Viewer GET `/api/system/status`: 200; GET `/api/managed/cameras`: 200; GET `/api/settings`: 403; POST `/api/ptz`: 403.
20. GET `/api/admin/login` và 3 route admin khác: 404.
21. GET `/static/CCTVVisionHub_Windows.zip` và `/static/CCTVVisionHub.apk`: 404; GET `/download/app.apk` không auth: 401.
22. Với fake camera managed `10.255.255.10`: viewer GET MJPEG 200 (bytes), snapshot 200 JPEG, audio 200 MP3; admin PTZ 200; không gọi camera/FFmpeg thật.
23. Logout: 200; dùng cookie cũ: 401.
24. Dừng server: `terminate`, chờ 10s, `kill` nếu cần; assert process exit; không còn child.
25. In tổng hợp PASS/FAIL; exit code.

**Không** gọi camera/Telegram; test mode đảm bảo.

**notCovered:** `ui_smoke.py` chỉ kiểm tra HTTP/asset/API, **không render DOM/router**. Kiểm tra 7 view, focus trap, responsive, contrast phải làm thủ công; nếu muốn tự động hóa cần bổ sung browser test (Playwright/Selenium) như dependency riêng, không nằm trong baseline này.

### 11.6 Kiểm thử thủ công bắt buộc

- [ ] Responsive 360×640, 768×1024, 1024×768, 1440×900, 1920×1080; không tràn ngang ngoài bảng.
- [ ] Chrome/Edge/Firefox; console không lỗi CSP/JS.
- [ ] Bàn phím: Tab qua toàn bộ login/shell/modal; focus trap; Escape; `Alt+1..7`; `/`; PTZ arrow chỉ trong panel.
- [ ] Screen reader (NVDA): login, bảng, modal confirm, toast.
- [ ] Contrast DevTools: text ≥4.5:1, UI ≥3:1.
- [ ] `prefers-reduced-motion`.
- [ ] Zoom 200% không mất chức năng.
- [ ] PWA install, offline page, cập nhật SW không phục vụ UI cũ.
- [ ] Không tìm thấy chuỗi mật khẩu/RTSP credential trong DOM, URL, localStorage, sessionStorage, clipboard.
- [ ] FFmpeg có/không: banner, 503, nút video disable.
- [ ] Rate limit login hiển thị đếm ngược.
- [ ] Session hết hạn (đặt `CCTV_SESSION_TTL_SECONDS=10`): về login, giữ hash.
- [ ] Viewer không thấy nút admin; server 403 khi gọi trực tiếp.
- [ ] APK: chưa có v2 → thông báo; có v2 → tải được sau login.
- [ ] Tiếng Việt có dấu, không emoji chrome, định dạng ngày/dung lượng.

### 11.7 Lệnh chạy kiểm thử

```bat
python_env\tools\python.exe -m py_compile app.py security.py settings_store.py credentials.py camera_urls.py camera_media.py managed_manager.py alarm_manager.py telegram_service.py scan_imou.py onvif_manager.py

python_env\tools\python.exe -m unittest discover -s tests -v

node --check static\js\core.js
node --check static\js\views\dashboard.js
node --check static\js\views\live.js
node --check static\js\views\cameras.js
node --check static\js\views\scanner.js
node --check static\js\views\storage.js
node --check static\js\views\alarms.js
node --check static\js\views\settings.js

python_env\tools\python.exe tests\verify_project.py
python_env\tools\python.exe tests\ui_smoke.py
```

- Trên máy hiện tại, `where ffmpeg` không tìm thấy FFmpeg; test phải pass với `CCTV_DISABLE_FFMPEG=1` và không được yêu cầu FFmpeg thật.
- Không chạy `python app.py` mặc định (0.0.0.0:8080) trong quá trình phát triển/test.
- Nếu `ui_smoke.py` không chạy được do môi trường (port bị chiếm, quyền), ghi rõ `notCovered` và không đánh dấu pass.

### 11.8 Definition of Done

- [ ] Tất cả ca §11.3 pass.
- [ ] `verify_project.py` pass toàn bộ V01–V37.
- [ ] `ui_smoke.py` pass 25 bước.
- [ ] `py_compile` sạch.
- [ ] `node --check` sạch 8 file.
- [ ] Không còn file/tham chiếu bị xóa.
- [ ] Không có secret trong static/ZIP/Docker/docs.
- [ ] Checklist thủ công §11.6 hoàn tất, ghi chú rõ mục chưa làm.
- [ ] Báo cáo bàn giao nêu file đã đổi, lệnh đã chạy, kết quả, việc chưa làm.

---

## 12. RÀNG BUỘC VẬN HÀNH

### 12.1 FFmpeg

- FFmpeg là **bắt buộc cho video**: MJPEG, audio, snapshot, ghi hình. Không có FFmpeg thì các tính năng này không hoạt động; các tính năng scan/NVR/PTZ ONVIF/cài đặt vẫn hoạt động.
- Kiểm tra lúc khởi động:
  - `path = os.environ.get("CCTV_FFMPEG_PATH") or shutil.which("ffmpeg")`.
  - Chạy `[path, "-version"]` timeout 3s, parse dòng đầu.
  - Kiểm tra encoder audio: `[path, "-hide_banner", "-encoders"]` tìm `libmp3lame` (cache kết quả); lưu `audio_available`.
  - Không tự tải/cài FFmpeg.
- `/api/health` trả `ffmpeg.available`, `ffmpeg.version`, `ffmpeg.audio_available` (libmp3lame); nếu thiếu FFmpeg `status=degraded`; nếu thiếu libmp3lame, audio trả 503 `FFMPEG_UNAVAILABLE` `details.capability="audio"` và UI cảnh báo riêng.
- Endpoint video trả 503 `FFMPEG_UNAVAILABLE` với `details.capability` (`mjpeg`/`audio`/`snapshot`/`record`).
- UI:
  - Dashboard banner critical.
  - Live/Snapshot/Record disable nút và hiển thị lý do.
  - Settings tab Hệ thống hiển thị đường dẫn/phiên bản hoặc hướng dẫn cài.
- Cài đặt gợi ý:
  - Windows: `winget install Gyan.FFmpeg` hoặc tải bản build, thêm vào PATH; đặt `CCTV_FFMPEG_PATH` nếu không muốn PATH.
  - Linux/Docker: `apt-get install ffmpeg`.
- Test: `CCTV_DISABLE_FFMPEG=1` → coi như không có; không spawn process.
- Không log URL RTSP/credential; residual risk process args được ghi ở §8.13.
- Giới hạn tài nguyên ở §12.3; cleanup trong `finally`/atexit.

### 12.2 Host, port, TLS và biến môi trường

**Mặc định production:** `0.0.0.0:8080` (giữ để dùng LAN như hiện tại), nhưng:
- Khởi động log cảnh báo nếu HTTP và không phải test.
- Dashboard hiển thị `HTTP_ONLY`.
- Khuyến nghị chạy sau reverse proxy TLS hoặc bật TLS tích hợp.

**Test:** mặc định `127.0.0.1:18080` (tự áp dụng nếu không set `CCTV_HOST`/`CCTV_PORT`). Nếu `CCTV_TEST_MODE=1` và `CCTV_HOST=0.0.0.0` hoặc `CCTV_PORT=8080` được đặt tường minh → thoát với mã 2 và thông báo rõ.

**Bảng biến môi trường:**

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `CCTV_HOST` | `0.0.0.0` | Địa chỉ bind; test phải `127.0.0.1` |
| `CCTV_PORT` | `8080` | Cổng; test `18080` |
| `CCTV_TEST_MODE` | `0` | Bật test mode (chặn outbound, không browser, không alarm) |
| `CCTV_DISABLE_ALARMS` | `0` | Không start AlarmManager |
| `CCTV_DISABLE_TELEGRAM` | `0` | Mọi lời gọi Telegram trả 503 |
| `CCTV_DISABLE_FFMPEG` | `0` | Coi như FFmpeg không có |
| `CCTV_DISABLE_BROWSER` | `0` | Không tự mở browser |
| `CCTV_SETTINGS_FILE` | `<BASE>/settings.json` | File settings; test trỏ temp ngoài project |
| `CCTV_MANAGED_FILE` | `<BASE>/managed_cameras.json` | File NVR; test trỏ temp |
| `CCTV_RECORDINGS_DIR` | `<BASE>/recordings` | Thư mục ghi hình |
| `CCTV_SNAPSHOTS_DIR` | `<BASE>/snapshots` | Thư mục snapshot |
| `CCTV_BOOTSTRAP_FILE` | `<BASE>/data/bootstrap_admin.txt` | File mật khẩu khởi tạo; xoá sau đổi |
| `CCTV_AUDIT_LOG` | `<BASE>/logs/audit.jsonl` | Audit JSONL |
| `CCTV_APP_LOG` | `<BASE>/logs/app.log` | App log |
| `CCTV_SECRETS_FILE` | rỗng | File JSON secret ngoài project (tuỳ chọn) |
| `CCTV_ADMIN_PASSWORD` | rỗng | Chỉ dùng khi chưa có hash admin; phải pass policy ≥10/không phổ biến, nếu yếu → exit 2 |
| `CCTV_SESSION_TTL_SECONDS` | `43200` | Cho phép 10–43200; production khuyến nghị 43200; <3600 cảnh báo |
| `CCTV_LOGIN_MAX_ATTEMPTS` | `5` | Số lần sai/5 phút/IP+user |
| `CCTV_ALLOWED_HOSTS` | rỗng | CSV host/domain bổ sung; không hỗ trợ `*` |
| `CCTV_ALLOWED_ORIGINS` | rỗng | CSV origin bổ sung |
| `CCTV_TRUST_PROXY` | `0` | Tin `X-Forwarded-*` (chỉ khi có proxy tin cậy) |
| `CCTV_HTTPS` | `0` | Ép cookie Secure + HSTS (khi TLS) |
| `CCTV_TLS_CERT` | rỗng | Đường dẫn cert PEM (tuỳ chọn) |
| `CCTV_TLS_KEY` | rỗng | Đường dẫn key PEM (tuỳ chọn) |
| `CCTV_CA_BUNDLE` | rỗng | CA bundle cho Telegram |
| `CCTV_FFMPEG_PATH` | rỗng | Đường dẫn FFmpeg; rỗng = `shutil.which` |
| `CCTV_ALLOW_PUBLIC_TARGETS` | `0` | Cho scan/test public IP (chỉ lab) |
| `CCTV_ALLOW_EXTERNAL_STORAGE` | `0` | Cho `recordings_dir`/`snapshots_dir` ngoài `BASE_DIR` (vẫn phải nằm trong `CCTV_ALLOWED_STORAGE_ROOTS`) |
| `CCTV_ALLOWED_STORAGE_ROOTS` | `<BASE_DIR>` | CSV các root được phép đặt recordings/snapshots |
| `CCTV_MAX_SCAN_HOSTS` | `1024` | Cap host/lần scan |
| `CCTV_MAX_RECORDING_SECONDS` | `21600` | 6 giờ |
| `CCTV_MAX_MJPEG_STREAMS` | `12` | Toàn cục |
| `CCTV_MAX_AUDIO_STREAMS` | `4` | Toàn cục |
| `CCTV_MAX_SNAPSHOTS` | `4` | Đồng thời |
| `CCTV_MAX_RECORDINGS` | `2` | Đồng thời |
| `CCTV_LOG_LEVEL` | `INFO` | `DEBUG` không log secret |
| `CCTV_APK_FILE` | `<BASE>/static/download/CCTVVisionHub-v2.apk` | File APK v2 phục vụ qua `/download/app.apk` |
| `CCTV_TEST_SCAN_FIXTURE` | rỗng | File JSON fixture scan |
| `CCTV_TEST_FAKE_CAMERA` | `0` | Chỉ test mode: fake backend cho dải `10.255.255.0/24`, dùng fixture JPEG/MP4/MP3, không gọi camera/FFmpeg |
| `CCTV_MIGRATION_ONLY` | `0` | Chỉ test mode: load/migrate/validate settings rồi exit 0/2, không mở server/không alarm; dùng cho `run_migration_case` |
| `CCTV_TEST_TELEGRAM_MOCK` | `0` | Chỉ test mode: cho phép `/api/alarm/test` gọi mock server nội bộ |
| `CCTV_TELEGRAM_BASE_URL` | rỗng | Chỉ test mode: base URL mock Telegram (HTTP/HTTPS local); production luôn `https://api.telegram.org` |
| `CCTV_TEST_TELEGRAM_TLS` | `0` | Chỉ test mode: mock HTTPS với cert tự ký + `CCTV_CA_BUNDLE`; nếu thiếu openssl → notCovered |

**Telegram base URL (test-only):** `CCTV_TELEGRAM_BASE_URL`/`CCTV_TEST_TELEGRAM_MOCK`/`CCTV_TEST_TELEGRAM_TLS` chỉ hợp lệ khi `CCTV_TEST_MODE=1`; nếu bất kỳ biến nào được đặt ngoài test mode → exit 2. Production luôn dùng `https://api.telegram.org`, không cho override; `CCTV_CA_BUNDLE` vẫn dùng được production.

**TLS tích hợp (tuỳ chọn):**

- Nếu có `CCTV_TLS_CERT` và `CCTV_TLS_KEY`: wrap socket bằng `ssl.SSLContext(PROTOCOL_TLS_SERVER)`, load cert/key; chạy cùng cổng.
- Nếu chỉ có một trong hai → thoát mã 2.
- Khi TLS: cookie Secure, HSTS, `CCTV_HTTPS=1` tự động.
- Không tự redirect HTTP→HTTPS (chỉ một listener); khuyến nghị reverse proxy.

**Reverse proxy:**

- Đặt `CCTV_TRUST_PROXY=1` và `CCTV_ALLOWED_HOSTS=domain`.
- Proxy phải set `X-Forwarded-Proto`, `X-Forwarded-Host`; không cho client tự set.
- Proxy không được cache `/api/*`, `/snapshots/*`, `/download/*`.
- Proxy nên giới hạn body 1 MiB và timeout phù hợp.

### 12.3 Giới hạn tiến trình và tài nguyên

| Tài nguyên | Giới hạn | Hành vi khi vượt |
|---|---|---|
| MJPEG toàn cục | 12 | 429 `TOO_MANY_STREAMS` |
| MJPEG/phiên | 9 (grid 3x3) | 429 |
| Audio toàn cục | 4 | 429 |
| Audio/phiên | 1 | 429 |
| Snapshot đồng thời | 4 | 429/503 |
| Recording đồng thời | 2 | 429/503 |
| Thời lượng stream | 12h hoặc hết session | Tự dừng |
| Thời lượng recording | 6h | Tự dừng, trả file |
| Scan đồng thời | 1 | 409 `SCAN_IN_PROGRESS` |
| Scan host/lần | 1024 | 400 |
| Login sessions | 500 | 503 |
| Request body | 1 MiB | 413 |
| HTTP request queue | 64 | OS/backlog |

- Semaphore dùng `threading.BoundedSemaphore`, acquire non-blocking; release trong `finally`.
- Đếm theo phiên dùng lock; giảm khi stream kết thúc.
- Mọi `Popen` phải được terminate/kill trong `finally` và atexit.
- Recording manager dừng tất cả khi shutdown.
- Smart tracking: set toàn bộ cờ `CAMERA_TRACKING_ACTIVE=False`, join thread tối đa 2s khi shutdown.
- Không giới hạn cứng số thread server (ThreadingMixIn hiện tại); semaphore bảo vệ FFmpeg/CPU.
- Snapshot timeout 8s; ONVIF 5–15s; Telegram 10s.
- Không chạy scan/stream trong request context của login/settings.

### 12.4 Docker

**`.dockerignore` bắt buộc:**

```
settings.json
managed_cameras.json
*.log
data/
logs/
recordings/
snapshots/
python_env/
python_3.11.9.zip
python_installer.exe
*.zip
*.apk
*.bak
.git/
.venv/
__pycache__/
dist/
build/
tests/
docs/
CCTVVisionHub.apk
```

**Dockerfile:**

```dockerfile
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates curl iproute2 tzdata \
 && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Ho_Chi_Minh \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    CCTV_SETTINGS_FILE=/app/data/settings.json \
    CCTV_MANAGED_FILE=/app/data/managed_cameras.json \
    CCTV_RECORDINGS_DIR=/app/data/recordings \
    CCTV_SNAPSHOTS_DIR=/app/data/snapshots \
    CCTV_AUDIT_LOG=/app/data/logs/audit.jsonl \
    CCTV_APP_LOG=/app/data/logs/app.log

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py security.py settings_store.py credentials.py camera_urls.py camera_media.py \
     managed_manager.py alarm_manager.py telegram_service.py scan_imou.py onvif_manager.py \
     cctv_tray.py ./
COPY dahua ./dahua
COPY templates ./templates
COPY static ./static

RUN groupadd -g 10001 cctv && useradd -u 10001 -g cctv -s /usr/sbin/nologin cctv \
 && mkdir -p /app/data/recordings /app/data/snapshots /app/data/logs \
 && chown -R cctv:cctv /app/data

USER 10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health >/dev/null || exit 1
CMD ["python", "app.py"]
```

- Không `COPY . .`.
- Không chạy root.
- Không chứa secret trong image; secret mount khi chạy.
- Image **không** copy `docs/`, `tests/`, secrets; tài liệu phát hành riêng.

**`docker-compose.yml` mẫu:**

```yaml
services:
  cctv-hub:
    build: .
    container_name: cctv-vision-hub
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      TZ: Asia/Ho_Chi_Minh
      PYTHONUNBUFFERED: "1"
      CCTV_SETTINGS_FILE: /app/data/settings.json
      CCTV_MANAGED_FILE: /app/data/managed_cameras.json
      CCTV_RECORDINGS_DIR: /app/data/recordings
      CCTV_SNAPSHOTS_DIR: /app/data/snapshots
      CCTV_AUDIT_LOG: /app/data/logs/audit.jsonl
      CCTV_APP_LOG: /app/data/logs/app.log
      CCTV_APK_FILE: /app/data/CCTVVisionHub-v2.apk
      CCTV_SECRETS_FILE: /run/secrets/cctv_secrets
    volumes:
      - ./data:/app/data
      - ./backups:/app/backups
    secrets:
      - cctv_secrets
    read_only: true
    tmpfs:
      - /tmp:size=256m
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8080/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3

secrets:
  cctv_secrets:
    file: ./secrets/cctv_secrets.json
```

- Không dùng `network_mode: host` mặc định. Nếu cần broadcast/scan UDP trong LAN, dùng profile riêng `hostnet` và ghi cảnh báo bảo mật; ưu tiên chạy trực tiếp trên host.
- `read_only: true` yêu cầu mount ghi cho `/app/data`, `/tmp`.
- Trên Linux, đảm bảo host `./data` thuộc uid/gid 10001 (hoặc dùng named volume) để user container ghi được.
- Không mount trực tiếp `settings.json` từ repo (tránh sửa file thật và lộ secret); copy vào `data/` một lần.

### 12.5 Windows: script khởi động, tray, ACL

**`run_windows.bat`, `run_windows_tray.bat`, `install_service.sh`:**

- Kiểm tra Python và FFmpeg; nếu thiếu, in hướng dẫn, **hỏi** trước khi cài (`pip install`), không silent.
- `run_windows_tray.bat:29` và `install_service.sh:26` không được tự `pip install`; chỉ in lệnh và chờ xác nhận.
- `run_windows.bat` không hardcode `8080`; đọc `CCTV_PORT` và hiển thị URL đúng.
- Set `CCTV_HOST`/`CCTV_PORT` nếu có; mở browser **sau khi** `/api/health` trả 200 (poll tối đa 20s).
- Không chạy ẩn; log ra `logs/`.
- Không tự thêm startup.

**`install_windows_startup.bat`:**

- Chỉ chạy khi người dùng gọi rõ ràng; hiển thị cảnh báo dịch vụ chạy nền và yêu cầu xác nhận `Y`.
- Tạo VBS/shortcut chạy `python app.py` với env; log; không `pip install` trong startup.
- Đặt ACL cho `settings.json`, `managed_cameras.json`, `data/`, `logs/` cho user chạy.
- Cung cấp lệnh gỡ startup.

**`cctv_tray.py`:**

- Đọc `CCTV_PORT`/`CCTV_HOST` (không hardcode `http://127.0.0.1:8080`).
- Không gọi `/api/alarm/toggle` không auth/CSRF. Chọn:
  - mở web UI (`webbrowser.open`), hoặc
  - đăng nhập bằng hộp thoại (tkinter) và gửi cookie + CSRF; không lưu mật khẩu.
- Không hardcode URL/IP.
- Nếu không cập nhật kịp, **ẩn menu toggle** để tránh lỗi.

**ACL mẫu (chạy thủ công khi triển khai, KHÔNG chạy trong test):**

```bat
icacls "D:\OLD\CCTV\CCTVVisionHub\settings.json" /inheritance:r /grant:r "%USERNAME%":F
icacls "D:\OLD\CCTV\CCTVVisionHub\managed_cameras.json" /inheritance:r /grant:r "%USERNAME%":F
icacls "D:\OLD\CCTV\CCTVVisionHub\data" /inheritance:r /grant:r "%USERNAME%":(OI)(CI)F
icacls "D:\OLD\CCTV\CCTVVisionHub\logs" /inheritance:r /grant:r "%USERNAME%":(OI)(CI)F
```

- Nếu chạy dưới service account, thay `%USERNAME%` bằng tài khoản service; giữ quyền cho SYSTEM/Administrators nếu cần.
- Kiểm tra bằng `icacls` sau khi set; không áp dụng mù quáng trên máy khác.
- Khuyến nghị BitLocker cho ổ chứa secret.

### 12.6 Backup, restore, dữ liệu

- Trước migration: backup `settings.json` → `settings.json.bak.<ts>`; giữ 5 bản.
- `managed_cameras.json` backup mỗi lần ghi → `.bak`; giữ 5 bản.
- Không backup vào `static/`/web root.
- `recordings/`, `snapshots/` backup theo chính sách vận hành; không đưa vào ZIP.
- Restore: dừng app → khôi phục file → chạy test mode kiểm tra → chạy production.
- Không xoá backup ngoài dự án (ràng buộc).
- Không xoá dữ liệu camera/thẻ nhớ.

### 12.7 Các hành vi bị cấm trong quá trình phát triển/test

- Không chạy `python app.py` mặc định (0.0.0.0:8080) khi phát triển/test.
- Không sửa `settings.json`, `managed_cameras.json` thật.
- Không gọi camera thật, không gửi Telegram, không format thẻ, không reboot, không đổi IP camera.
- Không xoá backup ngoài dự án.
- Không commit secret/log/ZIP/APK vào package.
- Không thêm dependency/CDN.
- Không dùng dữ liệu giả trong sản phẩm; chỉ fixture test.
- Không hạ cấp bảo mật để “cho chạy được” (ví dụ tắt CSRF, `CERT_NONE`, `verify=False`, mở CORS).

---

## 13. MIGRATION VÀ TƯƠNG THÍCH NGƯỢC

### 13.1 `settings.json`

**Bảng map khóa:**

| Khóa hiện tại | Canonical v2 | Hành động |
|---|---|---|
| `admin_password` | — | Nếu custom ≥10 và không thuộc backdoor: hash scrypt → `admin_password_hash`, xoá plaintext. Nếu default/backdoor/<10: **không dùng**, cần `CCTV_ADMIN_PASSWORD` hoặc bootstrap ghi được; nếu không → exit 2 (§8.7) |
| `viewer_password` (nếu có) | — | Hash → `viewer_password_hash`; xoá plaintext |
| `default_password` | `default_password` | Giữ; write-only; cảnh báo nếu yếu |
| `scan_timeout` | `scan_timeout` | Giữ; validate 1–10 |
| `default_subnet` | `default_subnet` | Giữ; validate khi dùng |
| `last_subnets` | `last_subnets` | Giữ; validate khi scan |
| `selected_vlans` | `selected_vlans` | Giữ; max 20 |
| `deep_scan` | `deep_scan` | Giữ |
| `scan_ports` | `scan_ports` | Giữ; chỉ admin, không UI |
| `COMPANY_VLANS` hardcode | `company_vlans` | Migrate một lần sang settings với label generic; xoá label site-specific khỏi source |
| `recordings_dir` | `recordings_dir` | Giữ; validate/fallback |
| `snapshots_dir` | `snapshots_dir` | Giữ; validate/fallback |
| `auto_reboot_on_ip_change` | `auto_reboot_on_ip_change` | Giữ |
| `telegram_enabled` | `telegram_enabled` | Giữ/thêm default `false` |
| `telegram_bot_token` | `telegram_bot_token` | Giữ; write-only |
| `telegram_chat_id` | `telegram_chat_id` | Giữ; write-only |
| `telegram_schedule_enabled` | same | Giữ |
| `telegram_schedule_start` | same | Validate `HH:MM` |
| `telegram_schedule_end` | same | Validate `HH:MM` |
| `telegram_cooldown` | `telegram_cooldown_seconds` | Map nếu canonical chưa có; xoá alias |
| `telegram_cooldown_seconds` | `telegram_cooldown_seconds` | Canonical thắng |
| `telegram_human_only` | `telegram_ai_filter_human` | Map nếu canonical chưa có; xoá alias |
| `telegram_ai_filter_human` | `telegram_ai_filter_human` | Canonical thắng |
| `telegram_armed_cameras` | same | Validate `[]`, `["*"]` hoặc IP |
| `telegram_storage_alerts` | same | Giữ |
| `telegram_storage_check_interval` | same | Validate 5–1440 |
| — | `alarm_startup_grace_seconds` | Thêm default `120` |
| — | `admin_password_bootstrap` | Cờ nội bộ: `true` khi dùng mật khẩu bootstrap; `false` sau khi đổi; không trả raw qua API |
| — | `schema_version` | Thêm `2` |

**Quy trình ghi:**

1. Backup.
2. Merge defaults + file.
3. Map alias (canonical thắng).
4. Hash admin/viewer theo §8.7; nếu không đủ điều kiện bootstrap/env → exit 2 trước khi ghi.
5. Xoá alias/plaintext.
6. Validate `recordings_dir`/`snapshots_dir`: giữ nguyên nếu hợp lệ (kể cả ngoài `BASE_DIR` khi đã có trong `CCTV_ALLOWED_STORAGE_ROOTS`); chỉ fallback default khi path **không hợp lệ/không ghi được**, kèm warning rõ và không xoá dữ liệu cũ. Không tự đổi path hợp lệ.
7. Ghi atomic; set quyền.
8. Log tóm tắt: số khóa migrate, không giá trị.

**Không tự đổi mật khẩu camera** khi phát hiện `default_password` yếu; chỉ cảnh báo dashboard.
**Default mới** cho `default_password` là chuỗi rỗng; không tạo mật khẩu camera mặc định trên cài đặt mới.

### 13.2 `managed_cameras.json`

- Giữ nguyên mảng JSON; không đổi cấu trúc gốc.
- Chuẩn hoá khi đọc:
  - `status`: map `"Online"` → `"online"`, `"Offline"` → `"offline"`, `"Solar Sleep"` → `"solar_sleep"`, `"AuthFailed"/"Sai Pass"` → `"auth_failed"`; khác → `"unknown"`.
  - `alarm_armed`: nếu thiếu, lấy `alarm_enabled`; nếu cả hai thiếu → **`true`** để giữ hành vi cũ (`managed_manager.py:39-50`), đồng thời cảnh báo dashboard `ALARM_STATE_DEFAULTED` và audit một lần; admin có thể tắt.
  - `id`: nếu thiếu → `cam_<mac|ip>`.
  - `password`: giữ nguyên; không trả API.
  - `is_solar`: bool; chỉ dựa trên dữ liệu thật (model/name), không IP hardcode.
- Không ghi lại file khi chỉ đọc/khởi động; chỉ ghi khi có mutation, với lock + backup + atomic.
- IP public trong dữ liệu cũ: giữ record nhưng đánh dấu `status=unknown`, không cho stream/actions trừ khi `CCTV_ALLOW_PUBLIC_TARGETS=1`.
- Khi xoá camera: xoá record + listener; không xoá file ghi hình.
- Không tự thêm camera từ scan khi chưa có hành động admin.

### 13.3 API và UI

- Đây là **breaking change có chủ đích**:
  - `/api/admin/*` → 404; client cũ phải dùng `/api/auth/*`.
  - Response lỗi đổi shape.
  - Media không nhận `password`.
  - `GET /api/settings` admin-only, không trả secret.
  - Status enum lowercase.
- Thêm header `X-CCTV-API-Version: 2`; client có thể kiểm tra.
- Không giữ compatibility shim vì sẽ giữ lỗ hổng.
- UI cũ bị thay hoàn toàn; không có route cũ.
- Nếu có script/tích hợp nội bộ dùng API cũ, phải cập nhật theo §6.

### 13.4 Service Worker, PWA và localStorage cũ

**SW v2:**

- `CACHE_NAME = 'cctv-hub-v2-<build>'`.
- Precache: CSS/JS/icons/offline.html (không `/`).
- `install`: `skipWaiting()`.
- `activate`: xoá cache cũ, `clients.claim()`.
- Fetch:
  - navigation (`mode==='navigate'`): network-only; lỗi mạng → `/static/offline.html`.
  - `/api/`, `/snapshots/`, `/download/`, media (`mjpeg`, `audio`): network-only, không cache.
  - static GET: network-first, fallback cache; chỉ cache response 200, không cache response có `Set-Cookie`.
- Không cache HTML `/` để tránh UI cũ sau cập nhật.
- Manifest: `lang: "vi"`, `start_url: "/"`, `scope: "/"`, `display: "standalone"`, icons nội bộ.

**Legacy localStorage purge (core.js lúc boot):**

- Xoá key bắt đầu `cam_pwd_`.
- Xoá `admin_token`, `cctv_token`, `session_token`.
- Xoá key chứa `password`/`secret`/`token` (case-insensitive) trừ `cctv.ui.*`.
- Migrate (nếu muốn) `cctv_view_mode`/`cctv_grid_slots` sang `cctv.ui.*`; không migrate mật khẩu.
- Chạy trước khi render login/shell; không log giá trị.

**Server:** `Clear-Site-Data: "cache", "storage"` khi logout/đổi mật khẩu.

### 13.5 APK

- APK cũ:
  - Không phục vụ qua `/static` hoặc `/download`.
  - Không đưa vào ZIP/Docker.
  - Không cố giữ tương thích `/api/admin/*`.
- APK v2 là **release blocker**; owner **A — Release**, phase P6; không release nếu chưa build/verify. Artifact: `dist/CCTVVisionHub-v2.apk` + `.sha256`; deploy copy tới `CCTV_APK_FILE` (không commit, không static).
- Build script `scripts/build_apk.sh` phải rewrite:
  - `versionName` 2.0.0, `versionCode` 2; target SDK 34.
  - **Không hardcode keystore/password**: đọc `CCTV_APK_KEYSTORE`, `CCTV_APK_STOREPASS`, `CCTV_APK_KEYPASS`, `CCTV_APK_KEY_ALIAS` từ env/CI secret; thiếu → exit 1, không tạo keystore debug.
  - **Không tải tool từ Internet khi build phát hành**: dùng `ANDROID_SDK_ROOT`/`AAPT2`/`D8`/`APKSIGNER` local; nếu CI tải, phải pin URL + SHA-256 và verify.
  - Không copy APK vào `static/`; chỉ `dist/`; không in mật khẩu.
- Android:
  - `android:allowBackup="false"`.
  - `usesCleartextTraffic` mặc định `false`; nếu cho HTTP nội bộ, là tùy chọn người dùng bật rõ ràng + network security config giới hạn; không bật `MIXED_CONTENT_ALWAYS_ALLOW`.
  - `DEFAULT_URL` rỗng hoặc placeholder, không hardcode IP; server URL cấu hình được.
  - Đăng nhập admin/viewer qua `/api/auth/login`, giữ cookie WebView + CSRF; không lưu mật khẩu camera.
  - WebView tải UI từ chính server (same-origin), **không** dùng `file://`/local asset.
  - Không lưu secret trong SharedPreferences/localStorage.
- `build_windows.py` không nhúng `static/CCTVVisionHub.apk`/ZIP; `build_exe.bat` hỏi trước khi pip install.
- Trong thời gian chưa có APK v2: endpoint 404 `APK_NOT_AVAILABLE`; UI hiển thị “APK đang được cập nhật”; **không phát hành APK cũ**.
- Cập nhật `docs/BUILD_APK_GUIDE.md`, bỏ IP nội bộ/PIN/keystore.

### 13.6 Đóng gói ZIP và Docker

**`package_windows.py`:**

- Refactor thành hàm, có `if __name__ == "__main__"`, để test import được.
- Allowlist file/dir:
  - `app.py`, các module `.py` cần thiết, `requirements.txt`, **`dahua/` (toàn bộ package, trừ `__pycache__`)**,
  - `templates/`, `static/css/`, `static/js/`, `static/icons/`, `static/manifest.json`, `static/sw.js`, `static/offline.html`,
  - `README.md`, `HUONG_DAN_SU_DUNG_WINDOWS.txt`, `run_windows.bat`, `run_windows_tray.bat`, `install_windows_startup.bat`, `cctv_tray.py`.
- Không đưa `docs/` (đặc biệt `docs/UI_REBUILD_SPEC.md`, `docs/REMOTE_ACCESS_GUIDE.md`, `AGY_INSTRUCTIONS.md`) vào ZIP phát hành; tài liệu nội bộ giữ trong repo.
- Exclude tuyệt đối:
  - `settings.json`, `managed_cameras.json`, `*.bak`, `*.log`, `data/`, `logs/`, `backups/`,
  - `recordings/`, `snapshots/` (trừ `.gitkeep` nếu muốn),
  - `python_env/`, `python_3.11.9.zip`, `python_installer.exe`,
  - `tests/`, `dist/`, `build/`, `__pycache__/`, `.git/`, `.venv/`,
  - `android/`, `scripts/`, `build_windows.py`, `build_exe.bat`,
  - `*.zip`, `*.apk`, `static/CCTVVisionHub_Windows.zip`, `static/CCTVVisionHub.apk`.
- Output: `dist/CCTVVisionHub_Windows_2.0.0.zip` + `.sha256`; **không** copy vào `static/`, không copy ra thư mục cha.
- Test `verify_project.py` mở ZIP kiểm tra không có secret, có `dahua/__init__.py`, không có APK/ZIP/log/settings/managed.

**Docker:** xem §12.4. Không `COPY . .`; `.dockerignore` chặn secret; non-root; secret mount; healthcheck.

### 13.7 Rollback

- Trước deploy: copy thư mục dự án hoặc ít nhất `app.py`, module, `templates/`, `static/`, `settings.json`, `managed_cameras.json`, `data/`.
- Rollback code: khôi phục bản copy; rollback settings: dùng `.bak` gần nhất.
- Session in-memory mất khi restart → mọi người đăng nhập lại (chấp nhận).
- Không rollback về ZIP/APK cũ vì lý do bảo mật.
- Sau rollback, chạy test mode và kiểm tra `/api/health` trước khi mở production.
- Ghi audit rollback (nếu có thể).

### 13.8 Checklist migration

- [ ] Backup settings/managed.
- [ ] **Trước nâng cấp:** đặt `CCTV_ADMIN_PASSWORD` mạnh **hoặc** đảm bảo `CCTV_BOOTSTRAP_FILE` ghi được; xác nhận policy ≥10; ghi lại nơi lưu an toàn.
- [ ] Kiểm tra thư mục `settings`/`bootstrap` ghi được bằng tài khoản service (không phải Administrator interactive).
- [ ] Chạy app ở test mode với bản copy settings thật (đọc-only) để xem migration log; không ghi file thật; thử case bootstrap không ghi được phải exit 2.
- [ ] Xác nhận `schema_version=2`, không còn `admin_password`.
- [ ] Đăng nhập admin bằng bootstrap/custom; đổi mật khẩu; xoá bootstrap file.
- [ ] Đặt viewer password nếu cần.
- [ ] Kiểm tra Telegram enabled/cooldown/human filter đúng canonical.
- [ ] Kiểm tra NVR list, status enum, arm/disarm.
- [ ] Kiểm tra `/api/health` FFmpeg; kiểm tra `recordings_dir`/`snapshots_dir` cũ vẫn được giữ nếu hợp lệ (không fallback im lặng).
- [ ] Kiểm tra PWA cập nhật (xoá cache cũ), localStorage không còn `cam_pwd_*`.
- [ ] Kiểm tra `/static/*.zip` 404; `/download/app.apk` trả APK v2 đúng SHA-256 (release blocker) hoặc 404 nếu chưa build.
- [ ] Xác nhận `dahua/` có trong môi trường chạy (`python -c "import dahua, app"`), Docker image và ZIP.
- [ ] Chạy test đầy đủ, gồm fake camera success path.

---

## 14. TIÊU CHÍ CHẤP NHẬN

Mỗi tiêu chí phải được kiểm chứng bằng test tự động (ghi ID) hoặc checklist thủ công. Không đánh dấu đạt nếu chưa chạy.

### 14.1 Chức năng

| ID | Tiêu chí | Kiểm chứng |
|---|---|---|
| AC-F01 | 7 màn hình mở được bằng hash, đúng quyền, không lỗi console | Manual browser (ui_smoke chỉ kiểm tra asset/HTTP) |
| AC-F02 | Login admin và viewer hoạt động; viewer bị tắt mặc định | B15/B16/B17 |
| AC-F03 | Dashboard hiển thị KPI/cảnh báo/sức khỏe từ API thật | Manual + F45 |
| AC-F04 | Live xem MJPEG, audio, snapshot; grid 2x2 và 3x3 | C13/C14/C15 (fake backend) + manual UI |
| AC-F05 | PTZ/preset/dual-lens/quality hoạt động (admin; lens/quality viewer) | C17/C12/C22/C28 (fake) + manual UI |
| AC-F06 | Ghi hình start/stop/tải; trạng thái REC thật | C16 (fake) + manual UI |
| AC-F07 | Camera CRUD, nhóm, test, sync, arm/disarm | C19 (fake) + manual UI |
| AC-F08 | Scanner 3 giao thức, VLAN, lọc, phân trang, CSV | S01–S04 + F01–F06 + manual UI |
| AC-F09 | Batch IP/reboot/sync time/password có confirm và kết quả từng camera | C19 (fake) + manual UI |
| AC-F10 | Chi tiết camera, rename, privacy/tracking/siren | C18/C19 (fake) + manual UI |
| AC-F11 | Storage info/format/clips theo ngày/lọc | C18 (fake) + manual UI |
| AC-F12 | Alarm arm/disarm/schedule/Telegram test/history/watchdog | C23/C24/U01–U03; C25 nếu TLS mock chạy, ngược lại notCovered; watchdog success path manual/notCovered (test mode 503); manual UI |
| AC-F13 | Settings admin/scan/storage/Telegram/system | C05/F02 + manual UI |
| AC-F14 | PWA cài được; offline page; tải APK v2 đúng SHA-256 | Manual + release artifact; APK v2 là release blocker |
| AC-F15 | Không còn dữ liệu giả/deep-link/backdoor | V09/V10/V11 + manual |
| AC-F16 | Không còn chức năng chết gây lỗi JS | Manual console + node --check |
| AC-F17 | FFmpeg thiếu → banner + 503, không crash | I01-I04 + manual |
| AC-F18 | Mọi lỗi hiển thị tiếng Việt, có mã hỗ trợ | Manual |
| AC-F19 | Dashboard cảnh báo mật khẩu mặc định/yếu và phiên | Manual + F45 |
| AC-F20 | Không hiển thị nút admin cho viewer; server 403 | C02/C06 + manual |

### 14.2 Bảo mật

| ID | Tiêu chí | Kiểm chứng |
|---|---|---|
| AC-S01 | Mọi `/api/*` (trừ health/login/me) trả 401 khi không session | C01 |
| AC-S02 | Mọi endpoint admin trả 403 với viewer | C02 |
| AC-S03 | Không response nào chứa password/hash/**session token**/chat ID; `csrf_token` được phép theo thiết kế | F01–F10 |
| AC-S04 | Cookie `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age` = TTL cấu hình (mặc định 12h); `Secure` khi HTTPS | B05/B06 |
| AC-S05 | Mật khẩu admin/viewer hash scrypt; không plaintext | B18 |
| AC-S06 | Migration hash đúng; backdoor 1998/Admin@1998 vô hiệu; fail-closed khi không bootstrap | B19/B20/B23–B25 |
| AC-S07 | Rate limit login 5/5 phút; 429 + Retry-After | B03/B04/E01 |
| AC-S08 | CSRF bắt buộc; Origin/Host kiểm tra | D01–D09 |
| AC-S09 | CSP/security headers đúng, không unsafe-inline/eval | H01–H07 |
| AC-S10 | Static không phục vụ ZIP/APK/log/json/secret | A07–A09/H09 |
| AC-S11 | Không password trong URL/localStorage/sessionStorage/DOM | V07/V08 + manual |
| AC-S12 | Test mode không gọi camera/Telegram/FFmpeg | G16 |
| AC-S13 | FFmpeg thiếu trả 503 và UI cảnh báo | I01–I04 |
| AC-S14 | Telegram TLS strict, hỗ trợ `CCTV_CA_BUNDLE` | C25/C26 + V27; nếu không tạo được cert test → C25 notCovered, vẫn giữ C26 |
| AC-S15 | AlarmManager có grace period, snapshot đúng vendor | U01/U02/U03/U08 + V28 |
| AC-S16 | ZIP/Docker không chứa settings/managed/logs/secret | V13–V15/V29 |
| AC-S17 | `/api/admin/*` trả 404 kể cả có cookie admin | A04 |
| AC-S18 | Viewer login mặc định tắt; bật/tắt bằng admin re-auth | B15–B17 |
| AC-S19 | Logout/đổi mật khẩu thu hồi session đúng | B10/B14/B17 |
| AC-S20 | Audit log ghi thao tác admin, không chứa secret | U04 + F10 |
| AC-S21 | CSV injection được vô hiệu | G15 |
| AC-S22 | SSRF bị chặn (public/link-local/CIDR lớn) | G01–G06 |
| AC-S23 | Path traversal recordings/snapshots bị chặn | G13/G14 |
| AC-S24 | Không còn backdoor/phím tắt/ẩn admin | V09/V10 + manual |
| AC-S25 | `CCTV_SECRETS_FILE` hoạt động và chặn ghi secret qua API | B22 |
| AC-S26 | Session token không nằm trong JSON; `X-Admin-Token` bị bỏ | B07 |
| AC-S27 | Mọi response API có `no-store`, `nosniff`, `X-Request-Id` | H02/H06 |
| AC-S28 | Mọi route có decorator phân quyền (AST) | V02 |
| AC-S29 | Scan chỉ private, cap host, 1 scan đồng thời | G01–G04 |
| AC-S30 | Recording/stream có giới hạn và cleanup | U05/U06/U07 + C16/C13 |
| AC-S31 | Migration không làm mất quyền admin: backdoor/yếu cần env/bootstrap; file không ghi được → exit 2 | B23/B24/B25 |
| AC-S32 | `dahua/` được import/đóng gói trong test, Docker, ZIP | A11/V32/V33 |

### 14.3 Giao diện và trải nghiệm

| ID | Tiêu chí | Kiểm chứng |
|---|---|---|
| AC-U01 | Dark NOC, token đúng, không hardcode màu ngoài token | Manual/CSS review |
| AC-U02 | Responsive 360/768/1024/1440/1920; không tràn ngang ngoài bảng | Manual |
| AC-U03 | Không CDN/font/ảnh ngoài; asset self-host | V04 |
| AC-U04 | Không inline script/style/event handler; CSP không vi phạm | V05/V06 + console |
| AC-U05 | Không emoji trong chrome; icon SVG sprite | V19/V20 |
| AC-U06 | Login riêng; shell chỉ hiện sau xác thực | A05 + manual |
| AC-U07 | Viewer không thấy nút admin (DOM) | C02/C06 + manual |
| AC-U08 | Modal/drawer focus trap, Escape, restore focus | Manual |
| AC-U09 | Bảng có caption/scope/aria-sort; form có label | Manual |
| AC-U10 | Contrast AA; focus ring rõ; không chỉ dùng màu | Manual |
| AC-U11 | Bàn phím điều hướng đầy đủ; PTZ không chiếm phím toàn cục | Manual |
| AC-U12 | Toast phân loại, aria-live; lỗi không tự biến mất quá nhanh | Manual |
| AC-U13 | Loading skeleton/empty/error đầy đủ, không bịa dữ liệu | Manual |
| AC-U14 | Tiếng Việt có dấu, định dạng ngày/dung lượng đúng | Manual |
| AC-U15 | Không hiển thị mật khẩu mặc định/gợi ý mật khẩu | V24 + manual |

### 14.4 Vận hành và đóng gói

| ID | Tiêu chí | Kiểm chứng |
|---|---|---|
| AC-O01 | Test mode chạy 127.0.0.1:18080, không outbound | ui_smoke + G16 |
| AC-O02 | Không dùng settings/managed thật trong test | Test support kiểm tra path |
| AC-O03 | `py_compile` sạch toàn bộ module | Command §11.7 |
| AC-O04 | `node --check` sạch 8 file JS | Command §11.7 |
| AC-O05 | `unittest` pass; `verify_project` pass; `ui_smoke` pass | Commands §11.7 |
| AC-O06 | ZIP phát hành không chứa secret/log/APK cũ | V13/V29 + mở ZIP kiểm tra |
| AC-O07 | Docker non-root, không copy secret, healthcheck | V14 + build/scan |
| AC-O08 | `.dockerignore`/`.gitignore` đầy đủ | V15 |
| AC-O09 | Docs không còn PIN/IP nội bộ | V24 |
| AC-O10 | APK cũ không còn được phục vụ; APK v2 tải được qua `/download/app.apk`, đúng SHA-256, ký và cài được | A09/A10 + release artifact verification |
| AC-O11 | FFmpeg install/check được ghi trong docs; UI chẩn đoán | Manual |
| AC-O12 | ACL/backup được hướng dẫn; không tự chạy trong test | Manual |

### 14.5 Bằng chứng kiểm thử bàn giao

Báo cáo cuối phải ghi:

1. Danh sách file đã tạo/sửa/xoá.
2. Lệnh đã chạy + kết quả thật (pass/fail, số test).
3. Các mục chưa chạy được và lý do (`notCovered`), không được đánh dấu pass.
4. Xác nhận không đụng `settings.json`/`managed_cameras.json` thật (kiểm tra mtime/hash trước/sau).
5. Xác nhận không gọi camera/Telegram/FFmpeg thật.
6. Kết quả mở ZIP kiểm tra secret + `dahua/`; SHA-256 APK v2.
7. Kết quả kiểm tra header/CSP thực tế.
8. Kết quả kiểm tra DOM/URL/localStorage không có mật khẩu (manual hoặc script browser).
9. Kết quả S01–S04/U01–U08/C23–C28; mục nào `notCovered` (đặc biệt TLS mock nếu thiếu openssl, watchdog success path) ghi rõ.
10. Các residual risk còn lại theo §8.13.
11. Điều kiện phát hành APK v2/TLS.

### 14.6 Bảng sign-off

| Vai trò | Người | Ngày | Bằng chứng | Kết luận |
|---|---|---|---|---|
| Backend/Security (A) | | | test_security + packaging | |
| Release/Android (A) | | | APK v2, SHA-256, ZIP/Docker | |
| Foundation UI (B) | | | verify_project + ui_smoke | |
| View lead (C1–C7) | | | node --check + manual | |
| Product/Security lead | | | kiểm toán độc lập + §14 | |
| Chủ dự án | | | chấp nhận residual risk/APK/TLS | |

---

## PHỤ LỤC A — DANH SÁCH ICON SVG BẮT BUỘC

Sprite nằm trong `templates/index.html` với `<symbol id="i-<name>">`; kích thước mặc định 16/20/24; stroke currentColor; `fill="none"` trừ logo.

**Điều hướng:** `dashboard`, `live`, `cameras`, `scanner`, `storage`, `alarms`, `settings`.
**Hành động:** `search`, `filter`, `refresh`, `plus`, `edit`, `trash`, `eye`, `eye-off`, `play`, `stop`, `pause`, `record`, `camera`, `video`, `download`, `upload`, `check`, `x`, `copy`, `external-link`, `maximize`, `minimize`, `power`, `rotate-ccw`.
**Trạng thái:** `alert-triangle`, `alert-circle`, `info`, `check-circle`, `x-circle`, `loader`, `shield`, `shield-off`, `bell`, `bell-off`, `lock`, `unlock`, `key`, `user`, `users`, `log-out`, `wifi`, `wifi-off`, `activity`, `gauge`.
**Thiết bị:** `server`, `hard-drive`, `sd-card`, `cpu`, `terminal`, `network`, `router`, `clock`, `calendar`.
**Điều hướng phụ:** `menu`, `chevron-down`, `chevron-up`, `chevron-left`, `chevron-right`, `more-horizontal`, `arrow-left`, `arrow-right`, `grid`, `layers`, `list`, `sliders`, `map-pin`, `tag`, `file-text`, `image`, `film`, `database`.
**Media:** `volume`, `volume-x`, `snapshot`, `ptz`, `preset`, `sun`, `moon`.
**PWA:** `download`, `smartphone`, `monitor`, `install`.
**Khác:** `refresh-cw`, `circle`, `dot`, `spinner`.

Quy tắc: icon chỉ trang trí `aria-hidden="true"`; icon-only button phải có `aria-label`; không dùng emoji thay icon.

---

## PHỤ LỤC B — FIXTURE TEST

`tests/fixtures/scan_devices.json`:

```json
{
  "devices": [
    {
      "ip": "10.255.255.10",
      "name": "Test Camera 01",
      "model": "IPC-TEST-01",
      "class": "IPC",
      "mac": "02:00:00:00:00:10",
      "serial": "TEST00000010",
      "firmware": "1.0.0-test",
      "http_port": 80,
      "tcp_port": 37777,
      "gateway": "10.255.255.1",
      "netmask": "255.255.255.0",
      "dhcp": "Static",
      "vendor": "Dahua/Imou",
      "init_state": 0,
      "vlan": "VLAN 255",
      "vlan_id": "255",
      "status": "online",
      "is_solar": false,
      "discovery_proto": "Dahua DHIP",
      "onvif_supported": false
    },
    {
      "ip": "10.255.255.11",
      "name": "Test Camera 02",
      "model": "IPC-TEST-02",
      "class": "IPC",
      "mac": "02:00:00:00:00:11",
      "serial": "TEST00000011",
      "firmware": "1.0.0-test",
      "http_port": 80,
      "tcp_port": 37777,
      "gateway": "10.255.255.1",
      "netmask": "255.255.255.0",
      "dhcp": "DHCP",
      "vendor": "Hikvision",
      "init_state": 0,
      "vlan": "VLAN 255",
      "vlan_id": "255",
      "status": "online",
      "is_solar": false,
      "discovery_proto": "Hikvision SADP",
      "onvif_supported": true
    }
  ]
}
```

- Dùng dải `10.255.255.0/24` (RFC1918) để qua validate private IP; test mode chặn outbound nên không chạm thiết bị thật.
- Không dùng IP/MAC thật của khách hàng.
- `settings.test.json` chứa `admin_password` plaintext giả (ví dụ `Test-Only-Password-2026`) để test migration; không dùng mật khẩu thật.

---

## PHỤ LỤC C — CHECKLIST NHANH CHO TỪNG AGENT

**Agent A (Backend/Security):**

- [ ] Default-deny hook + decorators; AST test.
- [ ] scrypt/session/CSRF/rate limit/headers.
- [ ] `/api/auth/*`, `/api/health`, `/api/system/status`, credentials.
- [ ] Sanitize mọi response camera/settings.
- [ ] Bỏ password query; credential resolver.
- [ ] FFmpeg detect + semaphore + limits.
- [ ] Scan cap/private; bỏ fake/Ruijie.
- [ ] Telegram TLS strict; alarm grace/vendor.
- [ ] Audit/redaction.
- [ ] Packaging/Docker/.dockerignore/.gitignore.
- [ ] test_security + support + fixtures.
- [ ] Docs security cập nhật.

**Agent B (Foundation UI):**

- [ ] index.html login/shell/sprite/CSP-safe.
- [ ] app.css token/component/responsive/a11y.
- [ ] core.js API/router/views/components/media/dom/fmt/poll/icons.
- [ ] Boot sequence, 401 handling, legacy storage purge, SW register.
- [ ] sw.js v2/manifest/offline.
- [ ] verify_project + ui_smoke.
- [ ] Docs UI/PWA cập nhật.

**Agent C1–C7:**

- [ ] File JS/CSS đúng tên, không sửa file khác.
- [ ] `CCTV.views.register` đúng meta.
- [ ] Skeleton/loading/empty/error.
- [ ] `ctx.signal`, destroy sạch.
- [ ] Không admin UI cho viewer.
- [ ] Không password/DOM/innerHTML/CDN.
- [ ] Test ID + responsive + keyboard.
- [ ] `node --check` pass.
- [ ] Báo cáo mục chưa làm.

---

## PHỤ LỤC D — CÂU HỎI CẦN CHỦ DỰ ÁN XÁC NHẬN TRƯỚC PHÁT HÀNH

Các mục này không chặn triển khai theo đặc tả, nhưng cần quyết định khi phát hành:

Các mục này **không chặn triển khai**; đã chốt kỹ thuật ở thân tài liệu, chỉ cần chủ dự án xác nhận lịch/cấu hình triển khai:

1. **APK v2:** owner A — Release, phase P6; cần xác nhận **ngày build** và việc có cho phép HTTP nội bộ opt-in hay bắt buộc HTTPS.
2. **TLS:** dùng reverse proxy hay TLS tích hợp; domain nào cần thêm vào `CCTV_ALLOWED_HOSTS`.
3. **Lưu trữ ngoài:** có dùng ổ/thư mục ngoài `BASE_DIR` không (cần `CCTV_ALLOW_EXTERNAL_STORAGE=1` + `CCTV_ALLOWED_STORAGE_ROOTS`).
4. **Secret store:** có dùng `CCTV_SECRETS_FILE`/Docker secret/BitLocker không.
5. **Bootstrap:** có muốn **bắt buộc** đổi mật khẩu bootstrap ngay sau login không (hiện chỉ cảnh báo critical, không chặn).
6. **Mã hoá at-rest mật khẩu camera:** chấp nhận residual risk (ADR-09) hay đầu tư secret store/AES-GCM sau.
7. **Phạm vi scan:** có cần scan ngoài RFC1918 không (mặc định không; `CCTV_ALLOW_PUBLIC_TARGETS=1` chỉ lab).

---

**HẾT TÀI LIỆU**
