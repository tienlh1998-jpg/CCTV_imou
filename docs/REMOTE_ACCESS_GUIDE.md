# HƯỚNG DẪN TRIỂN KHAI ĐA NỀN TẢNG & TRUY CẬP TỪ XA

Tài liệu hướng dẫn triển khai **CCTV Vision Hub** trên Windows, Linux, Docker,
điện thoại và truy cập từ xa an toàn.

> Nguyên tắc: không mở cổng trực tiếp ra Internet, không dùng mật khẩu mặc định,
> không tắt xác thực TLS. Cloudflare Tunnel chỉ là kênh truyền — phải có thêm
> lớp xác thực (Cloudflare Access/SSO/MFA hoặc VPN).

---

## 1. CÀI ĐẶT TRÊN ĐIỆN THOẠI (PWA)

Ứng dụng có PWA tự chứa, không cần App Store/Google Play.

### iPhone / iPad (Safari)

1. Mở Safari, truy cập địa chỉ máy chủ (LAN hoặc link HTTPS từ xa).
2. Nhấn **Chia sẻ (Share)**.
3. Chọn **“Thêm vào Màn hình chính”**.
4. Nhấn **Thêm**.

### Android (Chrome / Samsung Internet)

1. Mở Chrome, truy cập địa chỉ app.
2. Menu 3 chấm → **“Cài đặt ứng dụng”** hoặc **“Thêm vào Màn hình chính”**.
3. Xác nhận cài đặt.

APK cũ (hardcode IP, HTTP cleartext, API cũ) không được phân phối/hỗ trợ trong bản
2.0.0; file cũ cần được xoá sau khi APK v2 được build/verify. APK v2 khi có sẽ tải
tại `/download/app.apk` sau khi đăng nhập. Chưa có APK v2 thì dùng PWA.

---

## 2. TRIỂN KHAI TRÊN WINDOWS (CHẠY 24/7)

### Cách 1: Khởi động nhanh

```text
run_windows.bat
```

- Script dùng `python_env\tools\python.exe` nếu có, nếu không dùng `python` trong PATH.
- Kiểm tra dependency; **hỏi trước khi pip install**.
- Kiểm tra FFmpeg (bắt buộc cho video/audio); cảnh báo rõ nếu thiếu.
- Đọc `CCTV_PORT` (mặc định 8080), mở trình duyệt sau khi `/api/health` trả 200.

### Cách 2: Tự khởi động cùng Windows

```text
install_windows_startup.bat
```

- Hỏi xác nhận trước khi cài.
- Tạo shortcut trong `Startup`, dùng `pythonw` nếu có.
- Runner ghi log vào `logs\startup.log`.
- Không tự pip install.

Gỡ bỏ: mở `shell:startup`, xoá `CCTVVisionHub.vbs`, xoá
`cctv_silent_starter.vbs` và `cctv_startup_runner.bat` trong thư mục dự án.

### Cách 3: Khay hệ thống

```bat
run_windows_tray.bat
```

Nếu thiếu `pystray`/Pillow, script in lệnh cài và dừng; không tự thay đổi môi trường.

### Cách 4: Đóng gói EXE

```bat
build_exe.bat
```

Script hỏi trước khi cài PyInstaller. Kết quả:
`dist\CCTVVisionHub\CCTVVisionHub.exe`. Không nhúng `settings.json`,
`managed_cameras.json`, log, APK hay ZIP.

### Đăng nhập lần đầu

Không có mật khẩu mặc định. Chọn một trong hai cách:

- Đặt `CCTV_ADMIN_PASSWORD` mạnh (≥10 ký tự) trước lần chạy đầu, hoặc
- Đọc mật khẩu ngẫu nhiên trong `data\bootstrap_admin.txt`, đăng nhập rồi đổi ngay.

Sau khi đăng nhập admin, tạo mật khẩu viewer (tuỳ chọn) trong Cài đặt.

---

## 3. TRIỂN KHAI TRÊN LINUX / MINI PC / NAS

### Cách 1: Systemd service

```bash
sudo bash install_service.sh
```

Kiểm tra/quản trị:

```bash
sudo systemctl status cctvapp
sudo systemctl restart cctvapp
sudo journalctl -u cctvapp -f
```

`install_service.sh` không được tự cài dependency và không hardcode mật khẩu.

### Cách 2: Docker & Docker Compose

```bash
mkdir -p data backups
docker compose build
docker compose up -d
```

- Mặc định chỉ publish `127.0.0.1:8080` (an toàn cho reverse proxy cùng máy).
- Cấu hình/dữ liệu nằm trong `./data`; không mount trực tiếp `settings.json` từ repo.
- Trên Linux: `sudo chown -R 10001:10001 data`.
- Quét multicast/broadcast cần host network, dùng profile riêng:

```bash
docker compose --profile hostnet up -d cctv-hub-hostnet
```

Host network bỏ lớp cô lập cổng của Docker; ưu tiên chạy trực tiếp trên host.
Chi tiết: `README.md` và `docs/SECURITY.md`.

---

## 4. TRUY CẬP TỪ XA (4G/5G) KHÔNG MỞ PORT MODEM

### Giải pháp 1: Cloudflare Tunnel + Cloudflare Access (khuyến nghị)

1. Tạo tài khoản tại [Cloudflare Zero Trust](https://one.dash.cloudflare.com/).
2. **Networks → Tunnels → Create a Tunnel**, chọn Windows/Linux.
3. Cài tunnel agent trên máy chủ. Cấu hình service:
   - Type: `HTTP`
   - URL: `127.0.0.1:8080` (hoặc đúng `CCTV_PORT`)
4. Gắn tên miền, ví dụ `https://cctv.example.com`.
5. **Bắt buộc** bật Cloudflare Access (hoặc SSO/MFA) cho hostname này. Tunnel
   một mình không thay thế xác thực của ứng dụng.

### Giải pháp 2: Tailscale / WireGuard

- Cài Tailscale trên máy chủ và điện thoại, đăng nhập cùng tài khoản.
- Truy cập địa chỉ Tailscale của máy chủ, ví dụ `http://100.x.y.z:8080`.
- Không cần mở port modem; vẫn nên dùng HTTPS nếu có thể.

### Không làm

- Không port-forward 8080 ra Internet.
- Không dùng Cloudflare Tunnel rồi để ứng dụng không mật khẩu/không rate limit.
- Không dùng HTTP cleartext cho kết nối ngoài LAN.
- Không chia sẻ link tải ZIP/APK chứa bí mật.
