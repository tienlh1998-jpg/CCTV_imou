# Hậu kiểm sau workflow làm lại giao diện & bảo mật

Ngày: 2026-11-05  
Phạm vi: các lỗi mức cao còn lại sau kiểm duyệt cuối của workflow.

## 1. Các lỗi đã sửa thêm

| Lỗi kiểm duyệt cuối | Trạng thái | Thay đổi |
|---|---|---|
| Đổi IP hàng loạt không lưu IP mới vào `managed_cameras.json` | Đã sửa | `app.py` cập nhật hồ sơ NVR sau mỗi kết quả static IP thành công; trả `managed_updated` / `managed_errors`; có test `BatchIpTests`. |
| `scripts/build_apk.sh` hardcode `storepass`/`keypass` và tải tool từ Google/GitHub | Đã xoá | Xoá script legacy; thêm invariant `V29` quét `scripts/` và các file build cho mẫu keystore hardcode/tải tool runtime. |
| `CCTV_SECRETS_FILE` được quảng bá nhưng chưa triển khai | Đã triển khai | `app.py` đọc secret file, fail-closed nếu thiếu/hỏng, secret là read-only, không ghi ngược vào `settings.json`; API trả `SECRETS_MANAGED_EXTERNALLY` khi cố ghi secret; có test `ExternalSecretsTests`. |
| `/api/alarm/status` báo `armed=true` khi AlarmManager bị tắt | Đã sửa | Trả `running`, `disabled`, và `armed=false` khi dịch vụ không chạy. |
| AlarmManager vẫn start khi `CCTV_TEST_MODE=1` thiếu `CCTV_DISABLE_ALARMS` | Đã sửa | Test mode không bao giờ start AlarmManager. |
| `alarm_manager.py` không fallback thư mục snapshot | Đã sửa | Fallback `snapshots/` trong project và tự tạo thư mục; lỗi ghi ảnh được ghi log, không làm mất cảnh báo. |
| Nuốt lỗi cập nhật `managed_cameras.json` sau khi đổi mật khẩu camera | Đã sửa | Trả `managed_update_error` cho từng camera và `managed_sync_failed` ở cấp response. |
| Tài liệu reset admin sai (`CCTV_ADMIN_PASSWORD` không có tác dụng khi đã có hash) | Đã sửa | `docs/SECURITY.md` mô tả quy trình reset có kiểm soát (dừng service, xoá hash/bootstrap, đặt env/bootstrap file). |
| Lệnh test trong README sai | Đã sửa | Dùng `python -m unittest discover -s tests -v` + chạy riêng `verify_project.py` / `ui_smoke.py`. |
| README/AGY mô tả module không tồn tại và profile `hostnet` không có | Đã sửa | Cập nhật kiến trúc theo file thật; ghi rõ Docker bridge không quét LAN. |
| `CCTV_APP_LOG` được mô tả nhưng app không ghi log | Đã sửa | `app.py` thêm FileHandler khi biến `CCTV_APP_LOG` được đặt. |
| File rác `m[1]))` ở thư mục project | Đã xoá | File rỗng do lệnh shell của agent tạo ra. |

## 2. Kiểm thử sau sửa

```text
python -m unittest discover -s tests -v   -> 72 tests OK
python tests/verify_project.py            -> 48/48 PASS
node --check static/js/core.js ...        -> 9 file, 0 lỗi
```

## 3. Lỗi còn lại (từ kiểm duyệt cuối)

Các mục sau chưa được sửa trong đợt hậu kiểm này; xem bảng "Vấn đề bảo mật và trạng thái xử lý" (87 mục) và báo cáo workflow:

- APK v2 chưa có; `/download/app.apk` trả `APK_NOT_AVAILABLE` (UI đã báo rõ).
- Test harness chưa có fake camera/Telegram success path; các luồng media/PTZ/storage/batch chưa được nghiệm thu end-to-end.
- `auth_failed` chưa được set trong `managed_manager.sync_cameras_health`.
- Một số thao tác camera vẫn dùng cổng 80 thay vì `http_port` đã cấu hình (`app.py`, `onvif_manager.py`).
- Audit chưa phủ format/reboot/batch-ip/name/privacy/siren và chưa rotate audit log.
- PWA chỉ đăng ký Service Worker trên HTTPS/localhost; LAN HTTP không có offline.
- APK/Android vẫn `allowBackup=true`, `usesCleartextTraffic=true`; APK debug cũ đã xoá.

## 4. Việc vận hành bắt buộc

1. Mở `data/bootstrap_admin.txt` trên máy chủ, đăng nhập `admin` bằng mật khẩu khởi tạo.
2. Đổi mật khẩu admin mạnh ngay trong **Cài đặt → Tài khoản & phiên**. Ứng dụng tự xoá file bootstrap sau khi đổi.
3. Mật khẩu cũ `Admin@1998` đã bị vô hiệu hoá.
4. Cài FFmpeg (`winget install Gyan.FFmpeg`) để bật live view/audio/snapshot/ghi hình.
5. Rotate Telegram bot token và mật khẩu camera nếu file ZIP cũ từng bị phát tán.
6. Bảo vệ/loại bỏ các bản backup cũ (`CCTVVISIONHUB_BACKUP_USB`, `CCTVVisionHub_Windows.zip`, ...) vì chúng có thể chứa secret cũ.
7. Không mở cổng 8080 trực tiếp ra Internet; dùng VPN hoặc Cloudflare Access.
