# CCTV Vision Hub

Ứng dụng quản lý và giám sát camera an ninh đa thương hiệu (Dahua, Imou, Hikvision,
ONVIF, Ezviz, TP-Link Tapo, Uniview, Yoosee...), chạy trong LAN, giao diện web
tiếng Việt, có PWA cho điện thoại và cảnh báo Telegram.

Phiên bản tài liệu: 2.0.0 — 2026-11-05.

> **Nguyên tắc bắt buộc:** không dùng mật khẩu mặc định, không mở cổng ra Internet
> trực tiếp, không đưa `settings.json` / `managed_cameras.json` vào ZIP, Docker image
> hay thư mục `static/`.

---

## 1. Tính năng

- **Quét mạng đa giao thức:** Dahua DHDiscover/DVRIP (UDP 37810), ONVIF WS-Discovery
  (UDP 3702), Hikvision SADP (UDP 37020), quét Unicast theo subnet/VLAN, lọc theo model,
  xuất CSV.
- **Quản lý camera/NVR:** thêm, sửa, xoá, nhóm, arm/disarm, test kết nối, đồng bộ
  sức khoẻ thiết bị.
- **Hành động hàng loạt:** đổi IP, reboot, đồng bộ giờ, đổi mật khẩu camera
  (chỉ các giao thức hỗ trợ; thao tác nguy hiểm yêu cầu xác nhận).
- **Live view:** MJPEG, audio, snapshot, ghi hình, PTZ/preset, chuyển kênh dual-lens,
  grid 2x2/3x3, mở trình phát ngoài (mpv/VLC).
- **Chi tiết camera:** model, serial, MAC, firmware, cấu hình mạng; đổi tên;
  privacy/tracking/siren; thông tin và format thẻ nhớ; danh sách clip trên thẻ.
- **Cảnh báo:** arm/disarm, lịch gác, cấu hình/test Telegram, lịch sử cảnh báo,
  watchdog dung lượng thẻ nhớ, grace period sau khởi động để tránh cảnh báo giả.
- **Cài đặt:** mật khẩu admin, mật khẩu viewer, tham số quét, thư mục lưu,
  Telegram, chẩn đoán FFmpeg, PWA.
- **Bảo mật:** hai vai trò admin/viewer, session server-side, CSRF, rate limit đăng nhập,
  scrypt, security headers/CSP chặt, không trả bí mật qua API.

---

## 2. Kiến trúc

```
Trình duyệt (vanilla JS, CSS thuần, asset tự chứa)
    │  cookie session HttpOnly + X-CSRF-Token
    ▼
Bottle app.py  ──►  auth.py            xác thực, phiên, CSRF, rate limit, headers
    │              managed_manager.py  danh sách camera/NVR
    │              alarm_manager.py    listener sự kiện, watchdog, Telegram
    │              telegram_service.py gửi cảnh báo (TLS nghiêm ngặt)
    │              onvif_manager.py    ONVIF/PTZ/storage
    │              scan_imou.py        quét Dahua/ONVIF/SADP
    │              app.py              RTSP URL builder, FFmpeg, MJPEG/audio/record
    ▼
FFmpeg (bắt buộc) ──► MJPEG / audio / snapshot / recording
```

- Backend: Python 3.11 + Bottle. Không có framework frontend, không CDN.
- Frontend: `templates/index.html`, `static/css/`, `static/js/`; router hash-based,
  7 màn hình: Tổng quan, Xem trực tiếp, Camera, Quét mạng, Lưu trữ, Cảnh báo, Cài đặt.
- Dữ liệu: `settings.json`, `managed_cameras.json`, `recordings/`, `snapshots/`,
  `logs/` — tất cả là dữ liệu vận hành, **không** commit và **không** đóng gói.

---

## 3. Yêu cầu hệ thống

| Thành phần | Yêu cầu |
|---|---|
| Python | 3.11 (đã kiểm tra với 3.11.9) |
| FFmpeg | **Bắt buộc** cho live view, audio, snapshot, ghi hình |
| Hệ điều hành | Windows 10/11 64-bit; Linux (Debian/Ubuntu) hoặc Docker |
| Trình duyệt | Chrome/Edge/Firefox/Safari bản 2023 trở lên |
| Mạng | LAN tin cậy; camera mở RTSP/HTTP/ONVIF theo hãng |

### Cài FFmpeg

```bat
:: Windows (winget)
winget install Gyan.FFmpeg
:: hoặc tải từ https://ffmpeg.org/download.html và thêm thư mục bin vào PATH
```

```bash
# Debian / Ubuntu
sudo apt-get update && sudo apt-get install -y ffmpeg
```

Kiểm tra:

```bash
ffmpeg -version
```

Nếu thiếu FFmpeg, ứng dụng vẫn chạy nhưng `/api/health` trả `status=degraded`,
live view/audio/ghi hình trả lỗi có mã và UI hiển thị cảnh báo. Đây là lỗi cấu hình
cần khắc phục, không phải tính năng tuỳ chọn.

---

## 4. Cài đặt trên Windows

### 4.1. Chạy nhanh

1. Cài Python 3.11 và **tick “Add python.exe to PATH”**.
2. Mở thư mục dự án, chạy `run_windows.bat`.
3. Script kiểm tra Python, dependencies, FFmpeg, sau đó chạy server tại
   `http://127.0.0.1:<cổng>`. Cổng lấy từ biến `CCTV_PORT` (mặc định 8080).

Nếu dự án có sẵn `python_env\tools\python.exe`, script dùng interpreter này trước;
không có thì dùng `python` trong PATH. Script **không** tự cài Python và **không**
chạy ẩn.

### 4.2. Chạy dưới khay hệ thống

```bat
run_windows_tray.bat
```

Script yêu cầu `pystray` + Pillow; nếu thiếu, script in lệnh cài và chờ xác nhận,
không tự `pip install`.

### 4.3. Tự khởi động cùng Windows

Chỉ chạy khi bạn thật sự muốn dịch vụ chạy nền 24/7:

```bat
install_windows_startup.bat
```

Script tạo shortcut trong Startup, dùng `pythonw` nếu có, ghi log lỗi vào
`logs\startup.log`, và hiển thị lệnh gỡ bỏ. Không tự cài package.

### 4.4. Đóng gói EXE (tuỳ chọn)

```bat
build_exe.bat
```

Yêu cầu PyInstaller; script hỏi trước khi cài. Kết quả nằm trong
`dist\CCTVVisionHub\`. Không đóng gói `settings.json`, `managed_cameras.json`, log,
APK hay ZIP cũ.

---

## 5. Cài đặt trên Linux

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export CCTV_HOST=127.0.0.1
export CCTV_PORT=8080
export CCTV_SETTINGS_FILE="$PWD/data/settings.json"
export CCTV_MANAGED_FILE="$PWD/data/managed_cameras.json"
mkdir -p data/recordings data/snapshots data/logs
python app.py
```

Có thể dùng `install_service.sh` để tạo systemd service; script này cũng phải
không tự cài dependency và không hardcode mật khẩu. Với máy chủ nhiều người dùng,
ưu tiên chạy dưới một tài khoản service riêng và giới hạn ACL file cấu hình.

---

## 6. Docker / Docker Compose

```bash
mkdir -p data backups
docker compose build
docker compose up -d
docker compose logs -f
```

- Image chạy user `10001` (non-root), có `HEALTHCHECK` gọi `/api/health`.
- Cấu hình và dữ liệu nằm trong `./data` (mount), không bake vào image.
- Mặc định chỉ publish `127.0.0.1:8080`; đặt `CCTV_PUBLISH_ADDR=0.0.0.0` nếu cần
  truy cập LAN trực tiếp (chỉ trong mạng tin cậy).
- Docker bridge không quét được multicast/broadcast LAN. Muốn quét VLAN, chạy trực
  tiếp trên host hoặc tự cấu hình container host-network có kiểm soát; compose mặc
  định **không** bật host network để giữ lớp cô lập cổng.
- Trên Linux, `./data` phải thuộc uid/gid `10001` để container ghi được:

```bash
sudo chown -R 10001:10001 data
```

- Không mount trực tiếp `settings.json` từ repo vào container. Sao chép một lần
  vào `data/` và giữ quyền hạn chế.

---

## 7. Đăng nhập lần đầu và mô hình quyền

### 7.1. Tạo mật khẩu admin

Ứng dụng **không có mật khẩu mặc định**. Khi khởi động lần đầu, chọn một trong hai cách:

1. Đặt biến môi trường `CCTV_ADMIN_PASSWORD` (tối thiểu 10 ký tự, không thuộc danh sách
   mật khẩu phổ biến) trước lần chạy đầu.
2. Nếu không đặt mật khẩu, đặt `CCTV_BOOTSTRAP_FILE` trỏ tới file ghi được
   (ví dụ `data/bootstrap_admin.txt`; quyền hạn chế). Ứng dụng sinh mật khẩu
   ngẫu nhiên và ghi vào đó. Đọc file này, đăng nhập, rồi **đổi ngay** trong Cài đặt.

Nếu không ghi được file bootstrap và không có `CCTV_ADMIN_PASSWORD`, ứng dụng dừng
với mã 2 thay vì chạy với mật khẩu yếu. Đây là hành vi fail-closed có chủ đích.
Nếu dùng Docker, file bootstrap nằm trong volume `./data`.

Đổi mật khẩu admin: **Cài đặt → Bảo mật → Đổi mật khẩu**. Đổi mật khẩu sẽ thu hồi
toàn bộ session hiện có; mọi người phải đăng nhập lại.

### 7.2. Tài khoản viewer (tuỳ chọn)

- Viewer không được bật mặc định.
- Admin đặt/xoá mật khẩu viewer trong **Cài đặt**; thao tác yêu cầu nhập lại mật khẩu admin.
- Khi chưa đặt, màn hình đăng nhập hiển thị lựa chọn viewer bị vô hiệu hoá.
- Không có mật khẩu viewer mặc định.

### 7.3. Quyền

| Nhóm thao tác | Admin | Viewer |
|---|---|---|
| Xem stream, snapshot, trạng thái, lịch sử, recordings, storage info | Có | Có |
| Quét mạng, export CSV | Có | Không |
| Ghi hình, PTZ, privacy, tracking, siren | Có | Không |
| Format thẻ, reboot, đổi IP, đổi tên, đổi mật khẩu camera | Có | Không |
| Settings, managed mutations, alarm toggle/test/clear, open-folder | Có | Không |
| Đổi mật khẩu admin/viewer | Có | Không |

UI chỉ ẩn nút theo vai trò; **server luôn kiểm tra lại quyền** và trả 401/403.
Người chưa đăng nhập chỉ truy cập được `/api/health`, `/api/auth/login`, `/api/auth/me`.

---

## 8. Cấu hình và bí mật

### 8.1. File cấu hình

- `settings.json`: cấu hình vận hành. Mật khẩu admin/viewer chỉ lưu dạng hash scrypt;
  `default_password`, `telegram_bot_token`, `telegram_chat_id` là write-only và không
  được trả qua API.
- `managed_cameras.json`: danh sách camera, có trường `password` phục vụ kết nối.
  File này là dữ liệu nhạy cảm.
- Mẫu không chứa bí mật: `settings.example.json`, `managed_cameras.example.json`.

Có thể đổi đường dẫn bằng biến môi trường:

| Biến | Ý nghĩa |
|---|---|
| `CCTV_SETTINGS_FILE` | Đường dẫn settings.json |
| `CCTV_MANAGED_FILE` | Đường dẫn managed_cameras.json |
| `CCTV_RECORDINGS_DIR` / `CCTV_SNAPSHOTS_DIR` | Thư mục ghi hình / snapshot |
| `CCTV_AUDIT_LOG` / `CCTV_APP_LOG` | Đường dẫn audit log / app log |
| `CCTV_HOST` / `CCTV_PORT` | Địa chỉ và cổng lắng nghe (mặc định `0.0.0.0:8080`) |
| `CCTV_BOOTSTRAP_FILE` | File ghi mật khẩu admin ngẫu nhiên ở lần chạy đầu |
| `CCTV_ADMIN_PASSWORD` | Mật khẩu admin khởi tạo (≥10 ký tự); ưu tiên hơn bootstrap |
| `CCTV_SESSION_TTL_SECONDS` | TTL session (mặc định 43200 = 12 giờ, tối đa 43200) |
| `CCTV_TRUST_PROXY` | `1` khi chạy sau reverse proxy tin cậy |
| `CCTV_HTTPS` | `1` khi server thực sự chạy sau HTTPS để bật cookie `Secure`/HSTS |
| `CCTV_ALLOWED_ORIGINS` | Danh sách origin bổ sung (phân tách bằng dấu phẩy) |
| `CCTV_SECRETS_FILE` | File JSON ngoài project chứa bí mật (Docker secret/volume) |
| `CCTV_APK_FILE` | Đường dẫn APK v2 để phục vụ `/download/app.apk` |
| `CCTV_TEST_MODE` / `CCTV_DISABLE_ALARMS` | Chế độ kiểm thử, xem mục 11 |

`CCTV_SECRETS_FILE` khi được đặt phải đọc được và là JSON hợp lệ; nếu không, ứng dụng
dừng (fail-closed). Các khóa bí mật trong file này sẽ ghi đè settings và bị chặn ghi
qua API.

### 8.2. Bảo vệ file trên Windows

Chỉ tài khoản chạy service được đọc/ghi file cấu hình. Ví dụ (chạy trong PowerShell
với quyền phù hợp, thay `<TAI_KHOAN>`):

```powershell
icacls settings.json /inheritance:r /grant:r "<TAI_KHOAN>:(R,W)"
icacls managed_cameras.json /inheritance:r /grant:r "<TAI_KHOAN>:(R,W)"
```

Không cấp quyền cho `BUILTIN\Users`. Bật BitLocker cho ổ chứa dữ liệu camera.

---

## 9. Bảo mật vận hành

- **Không** mở cổng 8080 trực tiếp ra Internet. Chỉ dùng LAN, VPN (Tailscale/WireGuard)
  hoặc reverse proxy có TLS.
- **Cloudflare Tunnel** chỉ là kênh truyền, không thay thế xác thực. Bật thêm
  Cloudflare Access (hoặc lớp SSO/MFA tương đương) trước khi cho người ngoài truy cập.
- Không dùng lại mật khẩu camera cho admin; không dùng mật khẩu mặc định của hãng.
- Khi chạy HTTP trong LAN, cookie vẫn được bảo vệ bằng `HttpOnly` + `SameSite=Strict`
  nhưng dữ liệu không mã hoá trên đường truyền. Với kết nối ngoài LAN, bắt buộc HTTPS.
- Không bao giờ tắt xác thực chứng chỉ TLS (`CERT_NONE`, `verify=False`,
  `rejectUnauthorized: false`). Nếu dùng CA nội bộ, đặt `CCTV_CA_BUNDLE`.
- Nếu từng phát tán `static/CCTVVisionHub_Windows.zip` hoặc APK cũ, coi như toàn bộ
  bí mật đã lộ. Thực hiện quy trình rotate trong [`docs/SECURITY.md`](docs/SECURITY.md).

Chi tiết mô hình mối đe dọa và checklist hardening: [`docs/SECURITY.md`](docs/SECURITY.md).

---

## 10. Vận hành, backup và sự cố

### 10.1. Nhật ký và sức khoẻ

- Health công khai: `GET /api/health` (trạng thái, FFmpeg, chế độ test; không lộ bí mật).
- Audit log: `logs/audit.jsonl` hoặc `CCTV_AUDIT_LOG`; app log: `logs/app.log`.
- Docker: `docker compose logs -f` và `docker inspect --format '{{json .State.Health}}' cctv-vision-hub`.

### 10.2. Backup an toàn

Backup **có chứa bí mật** (mật khẩu camera, Telegram token/chat id, hash admin).
Vì vậy:

1. Dừng service trước khi copy để tránh file ghi dở.
2. Backup `settings.json`, `managed_cameras.json`, `recordings/`, `snapshots/`,
   `logs/` (nếu cần điều tra) — không backup `python_env/`.
3. Mã hoá bản backup (BitLocker/VeraCrypt hoặc kho lưu trữ có mã hoá) và giới hạn ACL.
4. Không để backup trong `static/`, không gửi qua kênh công khai, không commit.
5. Kiểm tra khôi phục định kỳ trên máy tách biệt; sau khôi phục, đăng nhập và đổi
   mật khẩu admin/viewer nếu nghi ngờ lộ.

### 10.3. Xử lý sự cố

| Hiện tượng | Kiểm tra |
|---|---|
| Không mở được web | Cổng có bị chiếm? `CCTV_PORT`? firewall Windows? |
| `/api/health` báo `degraded` | Thiếu FFmpeg; cài và kiểm tra `ffmpeg -version` |
| Live view/audio lỗi 503 | Thiếu FFmpeg/libmp3lame; xem `ffmpeg.audio_available` trong health |
| Đăng nhập trả 429 | Rate limit; chờ `Retry-After` rồi thử lại |
| 401 liên tục | Session hết hạn (12 giờ), cookie bị chặn, hoặc server restart |
| 403 với viewer | Thao tác chỉ dành cho admin; dùng tài khoản admin |
| Camera “auth failed” | Sai mật khẩu camera; cập nhật trong Camera (admin) |
| Container không ghi được `data/` | `chown -R 10001:10001 data` |
| Sai giờ ghi hình | Kiểm tra timezone host/container (`Asia/Ho_Chi_Minh`) |

---

## 11. Kiểm thử không cần camera thật

Chế độ test chặn toàn bộ hoạt động ra ngoài (camera, Telegram, mở trình phát,
mở thư mục) và dùng file cấu hình tạm:

```bat
set CCTV_TEST_MODE=1
set CCTV_DISABLE_ALARMS=1
set CCTV_DISABLE_FFMPEG=1
set CCTV_SETTINGS_FILE=%TEMP%\cctv-test\settings.json
set CCTV_MANAGED_FILE=%TEMP%\cctv-test\managed_cameras.json
set CCTV_HOST=127.0.0.1
set CCTV_PORT=18080
set CCTV_ADMIN_PASSWORD=<mật-khẩu-test-manh>
python app.py
```

```bash
CCTV_TEST_MODE=1 CCTV_DISABLE_ALARMS=1 CCTV_DISABLE_FFMPEG=1 \
CCTV_SETTINGS_FILE=/tmp/cctv-test/settings.json \
CCTV_MANAGED_FILE=/tmp/cctv-test/managed_cameras.json \
CCTV_HOST=127.0.0.1 CCTV_PORT=18080 \
CCTV_ADMIN_PASSWORD='<mật-khẩu-test-mạnh>' python app.py
```

Chạy kiểm thử tự động (khi bộ test có mặt):

```bash
python -m compileall -q app.py auth.py
python -m unittest discover -s tests -v
python tests/verify_project.py
python tests/ui_smoke.py
node --check static/js/core.js
```

**Không** chạy test với `settings.json` / `managed_cameras.json` thật; không gọi
camera, Telegram, format thẻ hay reboot ngoài môi trường test.

---

## 12. Đóng gói phát hành

```bash
python package_windows.py
```

Kết quả:

- `dist/CCTVVisionHub_Windows_2.0.0.zip`
- `dist/CCTVVisionHub_Windows_2.0.0.zip.sha256`

Gói chỉ chứa mã nguồn chạy, templates, asset tự chứa, `dahua/`, tài liệu phát hành,
file cấu hình mẫu và script Windows. Gói **không** chứa `settings.json`,
`managed_cameras.json`, log, APK, ZIP cũ, `python_env/`, test hay tài liệu nội bộ.
Không có link tải công khai; phân phối qua kênh nội bộ an toàn.

Kiểm tra tính toàn vẹn:

```powershell
Get-FileHash .\dist\CCTVVisionHub_Windows_2.0.0.zip -Algorithm SHA256
Get-Content .\dist\CCTVVisionHub_Windows_2.0.0.zip.sha256
```

APK cũ (hardcode IP, HTTP cleartext, dùng API cũ) **không được phân phối/hỗ trợ**
trong bản 2.0.0; file cũ cần được xoá sau khi APK v2 được build/verify. APK v2 đặt
tại `CCTV_APK_FILE` và tải qua `/download/app.apk` (yêu cầu đăng nhập). Khi chưa có
APK v2, UI hiển thị thông báo “APK đang được cập nhật”.

---

## 13. Tài liệu

- [`docs/SECURITY.md`](docs/SECURITY.md) — hardening, secret handling, rotate, báo lỗi.
- [`docs/UI_REBUILD_SPEC.md`](docs/UI_REBUILD_SPEC.md) — đặc tả kỹ thuật/API (tài liệu nội bộ).
- [`HUONG_DAN_SU_DUNG_WINDOWS.txt`](HUONG_DAN_SU_DUNG_WINDOWS.txt) — hướng dẫn nhanh cho Windows.
