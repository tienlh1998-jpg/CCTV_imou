================================================================================
        CCTV VISION HUB - HƯỚNG DẪN KHÔI PHỤC SAU KHI CÀI LẠI WINDOWS
================================================================================

Phiên bản tài liệu: 2.0.0

Mục đích: khôi phục mã nguồn và cấu hình vận hành trên một máy Windows mới,
theo cách KHÔNG làm lộ mật khẩu camera, Telegram token hay mật khẩu admin.

--------------------------------------------------------------------------------
1. NHỮNG GÌ CẦN SAO LƯU (RIÊNG NHAU)
--------------------------------------------------------------------------------
A. MÃ NGUỒN / GÓI PHÁT HÀNH
   - Thư mục dự án, hoặc file ZIP phát hành sạch do package_windows.py tạo.
   - Gói phát hành KHÔNG chứa settings.json, managed_cameras.json, log, APK,
     ZIP cũ hay python_env.

B. CẤU HÌNH VẬN HÀNH (CÓ CHỨA BÍ MẬT)
   - settings.json: hash admin/viewer, Telegram token/chat id, tham số quét.
   - managed_cameras.json: danh sách camera và mật khẩu camera.
   - recordings/, snapshots/ (nếu cần giữ dữ liệu).
   - Log chỉ sao lưu khi cần điều tra sự cố.

   CẢNH BÁO: các file trên chứa bí mật. Phải lưu trong nơi được mã hoá
   (BitLocker/VeraCrypt hoặc kho lưu trữ có mã hoá), có ACL hạn chế.
   KHÔNG gửi qua chat/email, KHÔNG để trong static/, KHÔNG commit lên git.

C. PYTHON / FFMPEG
   - Không cần sao lưu python_env. Cài Python 3.11 và FFmpeg trên máy mới.

--------------------------------------------------------------------------------
2. KHÔI PHỤC TRÊN MÁY WINDOWS MỚI
--------------------------------------------------------------------------------
BƯỚC 1: Cài Python 3.11
   - Tải tại https://www.python.org/downloads/
   - TÍCH CHỌN "Add python.exe to PATH" khi cài đặt.

BƯỚC 2: Cài FFmpeg (BẮT BUỘC cho video/audio)
   - winget install Gyan.FFmpeg
   - Kiểm tra: ffmpeg -version

BƯỚC 3: Khôi phục mã nguồn
   - Giải nén ZIP sạch hoặc copy thư mục dự án vào ổ đĩa.
   - Không copy settings.json / managed_cameras.json từ gói ZIP công khai cũ.

BƯỚC 4: Khôi phục cấu hình
   - Copy settings.json và managed_cameras.json từ bản backup đã mã hoá
     vào thư mục dự án (hoặc thư mục data/ nếu dùng Docker).
   - Kiểm tra quyền file: chỉ tài khoản chạy service được đọc/ghi.
   - Nếu nghi ngờ bản backup từng bị lộ, KHÔNG dùng lại ngay; xem bước 6.

BƯỚC 5: Khởi chạy
   - Click đúp run_windows.bat.
   - Script dùng python_env\tools\python.exe nếu có, kiểm tra dependency/FFmpeg,
     rồi mở http://127.0.0.1:<CCTV_PORT> (mặc định 8080).
   - Đăng nhập bằng tài khoản đã khôi phục. Nếu chưa có mật khẩu admin hợp lệ,
     đặt CCTV_ADMIN_PASSWORD mạnh hoặc làm theo data\bootstrap_admin.txt.

BƯỚC 6: Nếu bí mật từng bị lộ
   - Rotate mật khẩu admin/viewer, mật khẩu camera và Telegram bot token.
   - Thu hồi session cũ bằng cách restart service.
   - Xem chi tiết trong docs\SECURITY.md.

--------------------------------------------------------------------------------
3. TIỆN ÍCH
--------------------------------------------------------------------------------
- run_windows_tray.bat: chạy dưới khay hệ thống; không tự pip install.
- install_windows_startup.bat: đăng ký chạy nền cùng Windows, ghi log vào
  logs\startup.log; gỡ bằng cách xoá shortcut trong shell:startup.
- build_exe.bat: đóng gói EXE; hỏi trước khi cài PyInstaller; không nhúng
  settings/managed/log/APK/ZIP.
- package_windows.py: tạo ZIP + SHA-256 trong dist/; không copy vào static/.

--------------------------------------------------------------------------------
4. LƯU Ý BẢO MẬT
--------------------------------------------------------------------------------
- Không dùng mật khẩu mặc định/PIN cũ.
- Không mở cổng trực tiếp ra Internet; dùng VPN hoặc Cloudflare Tunnel kèm
  lớp xác thực bổ sung.
- Không tắt xác thực chứng chỉ TLS của Telegram.
- Kiểm tra lại: /api/health, đăng nhập admin/viewer, camera online, Telegram test.

================================================================================
Chi tiết: README.md và docs\SECURITY.md
================================================================================
