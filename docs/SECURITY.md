# CCTV Vision Hub — Hướng dẫn bảo mật và hardening

Tài liệu dành cho người triển khai/vận hành. Mục tiêu: giữ bí mật camera, tài khoản
quản trị và dữ liệu ghi hình trong môi trường LAN tin cậy, đồng thời giảm thiệt hại
nếu một lớp phòng vệ bị vượt qua.

Phiên bản áp dụng: 2.0.0.

---

## 1. Mô hình mối đe dọa

### 1.1. Tài sản cần bảo vệ

| Tài sản | Nơi lưu | Hậu quả nếu lộ |
|---|---|---|
| Mật khẩu/hash admin, viewer | `settings.json` | Chiếm toàn bộ hệ thống |
| Mật khẩu camera/NVR | `managed_cameras.json`, bộ nhớ server | Xem/điều khiển camera, pivot vào mạng camera |
| Telegram bot token + chat id | `settings.json` / secret file | Gửi tin nhắn giả, lộ ảnh camera, chiếm bot |
| Snapshot, recording | `snapshots/`, `recordings/` | Lộ đời sống riêng tư, hình ảnh nội bộ |
| Session cookie, CSRF token | Trình duyệt | Chiếm phiên admin/viewer |
| Log, audit | `logs/`, stdout | Lộ IP, tên camera, dấu vết khai thác |

### 1.2. Tác nhân và ranh giới tin cậy

- **Người dùng LAN hợp lệ:** admin/viewer, trình duyệt hiện đại.
- **Kẻ tấn công trong LAN:** quét cổng, ARP spoofing, đánh cắp cookie, brute force.
- **Kẻ tấn công qua Internet:** chỉ tiếp cận nếu operator mở cổng hoặc dùng tunnel
  không có lớp xác thực bổ sung.
- **Thiết bị camera/NVR:** có thể bị chiếm, trả dữ liệu độc hại (tên/model chứa HTML,
  URL lạ). Mọi dữ liệu từ thiết bị được coi là không tin cậy.
- **Nhà cung cấp CDN/bên thứ ba:** không được phép trong UI; mọi asset phải self-host.

### 1.3. Giả định

- Server chạy trên máy do tổ chức kiểm soát, có tài khoản service riêng.
- Không có yêu cầu multi-tenant hay phân quyền chi tiết hơn admin/viewer.
- TLS do reverse proxy/VPN đảm nhiệm nếu truy cập ngoài LAN.
- FFmpeg, Python và dependency được cập nhật từ nguồn tin cậy.

### 1.4. Rủi ro còn lại (đã biết)

1. **Mật khẩu camera lưu plaintext at-rest** trong `managed_cameras.json` (theo quyết
   định kỹ thuật của bản 2.0.0, không tự viết crypto). Bù trừ bằng ACL, BitLocker,
   write-only API, không log, không trả qua API. Nếu cần mã hoá at-rest, dùng giải pháp
   OS/volume encryption hoặc thư viện chuẩn với key từ secret store — không tự chế.
2. **HTTP trong LAN:** cookie và dữ liệu không được mã hoá trên đường truyền. Chấp nhận
   trong LAN tin cậy; bắt buộc HTTPS khi đi qua Internet.
3. **Session lưu trong bộ nhớ:** restart server làm mất session (mọi người đăng nhập lại).
4. **FFmpeg là tiến trình ngoài:** tài nguyên CPU/RAM/disk có thể bị lạm dụng nếu tài khoản
   admin bị chiếm. Server có semaphore/giới hạn, nhưng vẫn cần giám sát tài nguyên.
5. **APK cũ không tương thích API mới:** không được phát hành; APK v2 phải build/verify riêng.

---

## 2. Kiến trúc bảo mật trong bản 2.0.0

### 2.1. Xác thực và phân quyền

- Mọi `/api/*` mặc định **deny**. Chỉ public: `GET /api/health`, `POST /api/auth/login`,
  `GET /api/auth/me`.
- Hai vai trò: `admin` toàn quyền; `viewer` chỉ đọc (stream, snapshot, status, history,
  recordings, storage info).
- Mọi thao tác thay đổi trạng thái yêu cầu `admin`: scan, record, PTZ, siren, privacy,
  tracking, format thẻ, reboot, đổi IP, đổi mật khẩu camera, đổi tên, settings,
  managed mutations, alarm toggle/test/clear, open-folder, export.
- UI chỉ ẩn nút; server kiểm tra lại và trả `401`/`403`.

### 2.2. Mật khẩu

- Hash bằng **scrypt** (salt ngẫu nhiên, tham số được lưu cùng hash).
- Không lưu plaintext admin/viewer. Migration từ bản cũ hash lại khi khởi động và xoá
  plaintext; mật khẩu yếu/backdoor cũ bị vô hiệu hoá.
- Đổi mật khẩu yêu cầu mật khẩu hiện tại (re-auth) và **thu hồi toàn bộ session**.
- Không có endpoint khôi phục mật khẩu công khai, không có mật khẩu mặc định.
- Quên mật khẩu: dừng service, sao lưu `settings.json`, xoá hai khóa
  `admin_password_hash` và `admin_password_bootstrap` (hoặc dùng một
  `CCTV_SETTINGS_FILE` mới), sau đó đặt `CCTV_ADMIN_PASSWORD` mạnh hoặc trỏ
  `CCTV_BOOTSTRAP_FILE` tới thư mục ghi được và khởi động lại. `CCTV_ADMIN_PASSWORD`
  chỉ có hiệu lực khi chưa có hash — đây là quy trình reset có kiểm soát, không phải
  backdoor reset lúc đang chạy. Đăng nhập bằng mật khẩu mới rồi đổi lại ngay.

### 2.3. Session và cookie

- Session server-side, TTL tuyệt đối **12 giờ**, logout thu hồi token.
- Cookie: `HttpOnly`, `SameSite=Strict`, `Secure` khi HTTPS, `Path=/`.
- Không trả session token trong JSON, không nhận token qua header tùy biến.
- Đổi mật khẩu/logout gửi `Clear-Site-Data` để xoá cache/storage.

### 2.4. CSRF và Origin/Host

- Mọi `POST/PUT/PATCH/DELETE` trên `/api/*` (trừ login) yêu cầu `X-CSRF-Token`.
- Server kiểm tra `Origin`/`Host` với allowlist cấu hình; request cross-origin bị từ chối.
- Client giữ CSRF token trong bộ nhớ (closure), reload lấy lại qua `/api/auth/me`.

### 2.5. Rate limit

- Login: 5 lần sai/5 phút cho `(IP, username)`, 20 lần/15 phút cho IP, khóa tạm toàn cục
  khi có dấu hiệu spray. Trả `429` + `Retry-After`.
- Các endpoint nhạy cảm khác (scan, snapshot, format, reboot, đổi mật khẩu, Telegram test)
  có giới hạn riêng.
- Không khóa tài khoản vĩnh viễn (tránh DoS); chỉ rate limit.

### 2.6. Header và CSP

Mọi response có:

- `Content-Security-Policy` với `script-src 'self'`, không `unsafe-inline`, không `unsafe-eval`.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`,
  `X-Permitted-Cross-Domain-Policies: none`.
- `Cache-Control: no-store` cho HTML và API nhạy cảm.
- `Strict-Transport-Security` chỉ khi HTTPS.

UI không dùng CDN, không inline script/style, không ảnh/font ngoài. Mọi dữ liệu động
render bằng `textContent`.

### 2.7. Media và mật khẩu camera

- Server giữ mật khẩu camera; media URL chỉ có `ip`, `subtype`, `channel`.
- Không nhận `password` trong query string; server trả `400 PASSWORD_IN_QUERY_FORBIDDEN`.
- Admin nhập mật khẩu camera một lần qua body `POST /api/cameras/credentials` (write-only),
  không lưu vào localStorage/sessionStorage/DOM.
- Không trả mật khẩu mới/hash qua API; batch đổi mật khẩu chỉ trả kết quả.

### 2.8. File tĩnh

- Chỉ phục vụ extension allowlist trong `static/`; từ chối `.zip`, `.apk`, `.exe`, `.log`,
  `.py`, `.env`, dotfile và path traversal.
- Không directory listing.
- APK chỉ qua `/download/app.apk` sau khi đăng nhập; ZIP phát hành không nằm trong web root.

### 2.9. Telegram TLS

- Không tắt xác thực chứng chỉ. Không dùng `CERT_NONE`, `check_hostname=False`,
  `verify=False`, `rejectUnauthorized: false`.
- Hỗ trợ CA nội bộ qua `CCTV_CA_BUNDLE`; mặc định dùng CA hệ thống/certifi.
- Bot token là bí mật: không log, không đưa vào URL hiển thị cho người dùng.

### 2.10. Ghi log và audit

- Audit các sự kiện: login success/failure, rate limit, đổi mật khẩu, thay đổi settings,
  thao tác nguy hiểm (format/reboot/đổi IP), thay đổi camera.
- Không ghi mật khẩu, token, hash, query nhạy cảm. Redact query string.
- Log xoay vòng; không để log trong web root, ZIP hay Docker image.
- Không log toàn bộ object camera/settings.

---

## 3. Checklist hardening khi triển khai

### 3.1. Trước khi chạy

- [ ] Không có mật khẩu mặc định/backdoor trong `settings.json`; migration đã hash lại.
- [ ] `CCTV_ADMIN_PASSWORD` mạnh hoặc file bootstrap ghi được; mật khẩu ≥10 ký tự.
- [ ] `settings.json`, `managed_cameras.json` có ACL chỉ tài khoản service.
- [ ] Đã backup bản cũ và xác nhận backup mã hoá/kiểm soát truy cập.
- [ ] FFmpeg đã cài; `/api/health` không báo `degraded` vì FFmpeg (trừ test mode).
- [ ] Không có `static/CCTVVisionHub_Windows.zip`, APK cũ, `app_crash.log`, `app_test.log`.
- [ ] Không có `settings.json`/`managed_cameras.json` trong `static/`, ZIP, Docker image.

### 3.2. Khi chạy

- [ ] Server bind `127.0.0.1` hoặc LAN tin cậy; không publish `0.0.0.0` ra Internet.
- [ ] Reverse proxy/VPN có TLS nếu truy cập ngoài LAN.
- [ ] Cloudflare Tunnel được bảo vệ thêm bằng Cloudflare Access/SSO/MFA.
- [ ] Cookie `HttpOnly` + `SameSite=Strict`; `Secure` khi HTTPS.
- [ ] `X-CSRF-Token` bắt buộc cho mọi thao tác thay đổi trạng thái.
- [ ] Rate limit login hoạt động (thử 6 lần sai → `429` + `Retry-After`).
- [ ] Security headers/CSP có mặt; UI không tải tài nguyên ngoài.
- [ ] Viewer không gọi được API admin (kiểm tra `403`).
- [ ] Không có mật khẩu trong URL/localStorage/DOM (DevTools → Network/Application).
- [ ] Telegram TLS strict; không có `CERT_NONE`/`verify=False`.
- [ ] AlarmManager có grace period; không gửi cảnh báo giả ngay sau restart.
- [ ] Docker chạy non-root, `read_only`, `cap_drop: ALL`, `no-new-privileges`.
- [ ] Log/audit không chứa bí mật; quyền file log hạn chế.

### 3.3. Định kỳ

- [ ] Cập nhật Python/Bottle/requests/Pillow và FFmpeg có kiểm soát.
- [ ] Rà soát tài khoản admin/viewer; xoá viewer không còn dùng.
- [ ] Kiểm tra dung lượng/backup; thử khôi phục.
- [ ] Rà soát log đăng nhập thất bại/rate limit bất thường.
- [ ] Kiểm tra chứng chỉ TLS/reverse proxy.
- [ ] Xác nhận không có artifact cũ (`.zip`, `.apk`, log) trong web root hoặc image.

---

## 4. Quản lý bí mật

### 4.1. Phân loại

| Bí mật | Lưu ở đâu | Ghi chú |
|---|---|---|
| Hash admin/viewer | `settings.json` | scrypt; không trả API |
| Mật khẩu camera | `managed_cameras.json` | write-only; ACL + volume encryption |
| `default_password` | `settings.json` | write-only; nên để rỗng nếu không dùng |
| Telegram bot token/chat id | `settings.json` hoặc `CCTV_SECRETS_FILE` | write-only; rotate khi lộ |
| Bootstrap admin | `data/bootstrap_admin.txt` | xoá sau khi đổi mật khẩu |
| Session/CSRF | RAM server + cookie HttpOnly | TTL 12 giờ |

### 4.2. Quyền file

**Windows:**

```powershell
icacls settings.json /inheritance:r /grant:r "<TAI_KHOAN_SERVICE>:(R,W)"
icacls managed_cameras.json /inheritance:r /grant:r "<TAI_KHOAN_SERVICE>:(R,W)"
icacls data /inheritance:r /grant:r "<TAI_KHOAN_SERVICE>:(OI)(CI)(M)"
icacls logs /inheritance:r /grant:r "<TAI_KHOAN_SERVICE>:(OI)(CI)(M)"
```

Không để `BUILTIN\Users:(RX,W)`. Kiểm tra lại bằng `icacls <file>`.

**Linux:**

```bash
chmod 600 settings.json managed_cameras.json
chmod 700 data logs
sudo chown <service-user>:<service-group> settings.json managed_cameras.json data logs
```

### 4.3. Docker secret

- Không đặt bí mật trong `docker-compose.yml`, Dockerfile, image, biến `ENV` công khai.
- Dùng `CCTV_SECRETS_FILE` trỏ tới file mount read-only (Docker secret/volume).
- Nếu file secret không đọc được/JSON sai, ứng dụng phải dừng (fail-closed).

### 4.4. Không đưa bí mật vào

- `static/`, ZIP phát hành, Docker image, log, audit, email/chat, ticket.
- URL/query string, localStorage, sessionStorage, DOM, `data-*`, comment HTML.
- Ảnh chụp màn hình, video demo, tài liệu hướng dẫn, source code.

---

## 5. Xoay vòng bí mật (rotation)

### 5.1. Khi nào phải rotate ngay

Rotate **toàn bộ** nếu bất kỳ điều nào xảy ra:

- Đã từng phát tán `static/CCTVVisionHub_Windows.zip` hoặc bản ZIP cũ.
- Đã từng public APK cũ, log, backup, hoặc thư mục dự án.
- Nghi ngờ lộ `settings.json` / `managed_cameras.json` / Telegram token.
- Máy chủ bị chiếm quyền, có tài khoản lạ, hoặc log bất thường.
- Nhân sự vận hành rời đi mà vẫn biết mật khẩu.

### 5.2. Thứ tự xoay vòng

1. **Cô lập:** dừng service, ngắt tunnel/reverse proxy, thu hồi bản ZIP/APK/log đã phát tán.
2. **Thu hồi session:** restart service (session in-memory mất) hoặc logout toàn bộ.
3. **Đổi mật khẩu admin:** đăng nhập bằng bootstrap/env, đổi mật khẩu mạnh mới.
4. **Đổi/xoá mật khẩu viewer:** đặt lại hoặc tắt viewer nếu không dùng.
5. **Đổi mật khẩu camera:** dùng chức năng đổi mật khẩu hàng loạt (admin), ưu tiên camera
   có mật khẩu từng nằm trong ZIP. Với camera không hỗ trợ API, đổi qua Web GUI hãng.
6. **Rotate Telegram bot token:** BotFather → `/revoke` → tạo token mới; cập nhật
   `telegram_bot_token`. Kiểm tra chat id vẫn đúng; nếu bot bị chiếm, tạo bot mới.
7. **Rotate `default_password`:** đặt mật khẩu mới mạnh hoặc xoá (rỗng) nếu không dùng.
8. **Kiểm tra lại:** đăng nhập admin/viewer, xem `/api/health`, gửi test Telegram,
   kiểm tra camera online, audit log.
9. **Ghi biên bản:** thời điểm, phạm vi, người thực hiện, bằng chứng (không ghi giá trị bí mật).

### 5.3. Sau khi rotate

- [ ] Mật khẩu cũ không còn đăng nhập được.
- [ ] Cookie/session cũ bị từ chối (`401`).
- [ ] Telegram chỉ gửi từ token mới.
- [ ] Camera cũ không còn dùng mật khẩu cũ.
- [ ] ZIP/APK/log cũ đã bị xoá khỏi mọi nơi (web root, share, email, backup công khai).
- [ ] Backup mới được mã hoá và kiểm tra ACL.

---

## 6. Những việc tuyệt đối không làm

- Không dùng mật khẩu mặc định/backdoor, không tạo lại cơ chế “PIN khẩn cấp”.
- Không tắt xác thực chứng chỉ TLS (`CERT_NONE`, `check_hostname=False`, `verify=False`,
  `rejectUnauthorized: false`).
- Không đưa ZIP/APK/settings/log vào `static/` hoặc public link.
- Không đưa mật khẩu vào query string, localStorage, sessionStorage, DOM, log.
- Không trả mật khẩu/hash qua API; không hiển thị lại mật khẩu đã lưu.
- Không thêm endpoint debug/backdoor, deep-link tự bật admin, phím tắt bí mật.
- Không dùng CDN, inline script, `eval`, `innerHTML` với dữ liệu không tin cậy.
- Không chạy container bằng root; không dùng `network_mode: host` mặc định.
- Không mở cổng 8080 trực tiếp ra Internet; không dùng Cloudflare Tunnel mà không có
  lớp xác thực bổ sung.
- Không commit `settings.json`, `managed_cameras.json`, `.env`, backup, log.
- Không ghi giá trị bí mật vào ticket/chat/email; chỉ ghi tên khóa và thời điểm rotate.

---

## 7. Kiểm tra nhanh sau triển khai

```bash
# Health công khai (không cần đăng nhập)
curl -i http://127.0.0.1:8080/api/health

# API bảo vệ phải trả 401 khi không có cookie
curl -i http://127.0.0.1:8080/api/settings
curl -i http://127.0.0.1:8080/api/managed/cameras

# Không còn route admin cũ
curl -i -X POST http://127.0.0.1:8080/api/admin/login   # mong đợi 404

# Không phục vụ ZIP/APK cũ
curl -i http://127.0.0.1:8080/static/CCTVVisionHub_Windows.zip  # mong đợi 404
curl -i http://127.0.0.1:8080/static/CCTVVisionHub.apk          # mong đợi 404
```

Kiểm tra header trên trang chủ:

```bash
curl -sI http://127.0.0.1:8080/ | grep -iE 'content-security-policy|x-frame-options|x-content-type-options|referrer-policy|cache-control'
```

Kiểm tra rate limit (trong môi trường test, không dùng tài khoản thật):

```bash
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:18080/api/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"username":"admin","password":"sai"}'
done
# Mong đợi: các lần đầu 401, lần vượt ngưỡng 429 kèm Retry-After
```

Các kiểm tra tự động đầy đủ nằm trong `tests/test_security.py`,
`tests/verify_project.py`, `tests/ui_smoke.py` (chạy ở chế độ test, cổng 18080).

---

## 8. Báo lỗi bảo mật

- Không tạo issue công khai chứa chi tiết khai thác hoặc bí mật.
- Gửi báo cáo cho quản trị viên hệ thống/đội vận hành qua kênh nội bộ đã định.
- Bao gồm: phiên bản, mô tả, bước tái hiện, ảnh hưởng, mức độ, đề xuất (nếu có).
- Không đính kèm `settings.json`, `managed_cameras.json`, token, mật khẩu, log thô.
- Thời hạn phản hồi/khắc phục do tổ chức quy định; ưu tiên lỗi cho phép chiếm admin,
  lộ mật khẩu camera hoặc vượt qua xác thực.
