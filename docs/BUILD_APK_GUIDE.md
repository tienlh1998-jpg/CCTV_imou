# HƯỚNG DẪN TẠO & XUẤT FILE .APK CÀI ĐẶT TRỰC TIẾP CHO ANDROID

Hệ thống **CCTV Vision Hub** hoàn toàn hỗ trợ tạo file **`.apk`** độc lập để bạn tải về, gửi qua Zalo / Telegram và cài đặt trực tiếp lên bất kỳ điện thoại, máy tính bảng hoặc Android TV nào!

Dưới đây là 2 cách tạo file `.apk` dễ dàng và nhanh nhất:

---

## CÁCH 1: TẠO FILE .APK ONLINE TRONG 30 GIÂY (NHANH NHẤT - KHÔNG CẦN CÀI ĐẶT PHẦN MỀM)

Vì ứng dụng đã có sẵn chuẩn **PWA** (`manifest.json`, `sw.js` và bộ icon HD), bạn có thể sử dụng công cụ chính thức của Microsoft để xuất file `.apk` cực kỳ an toàn:

1. **Khởi chạy Cloudflare Tunnel** hoặc sử dụng IP công khai của máy chủ công ty (ví dụ: `https://cctv.tencongty.com` hoặc IP tĩnh).
2. Mở trình duyệt và truy cập trang web:  
   👉 **[PWABuilder (Microsoft)](https://www.pwabuilder.com)**
3. Nhập đường link máy chủ CCTV Hub của bạn vào ô tìm kiếm ➔ Bấm **"Start"**.
4. PWABuilder sẽ tự động đọc `manifest.json`, kiểm tra icon và xác nhận ứng dụng đạt chuẩn 100%.
5. Nhấn vào nút **"Package for Store"** ➔ Chọn mục **"Android"**.
6. Chọn xuất file **"APK Package"** ➔ Bấm **"Generate"**.
7. Tải file `.apk` về máy, gửi qua điện thoại và nhấn cài đặt ngay!

---

## CÁCH 2: XUẤT FILE .APK TỪ MÃ NGUỒN NATIVE `android/` (BẰNG ANDROID STUDIO)

Dự án đã tích hợp sẵn toàn bộ mã nguồn Android gốc trong thư mục `android/` của dự án với đầy đủ tính năng:
- **Tự động lưu và cho phép đổi IP máy chủ:** Có nút cấu hình máy chủ góc màn hình; app không hardcode IP. Người dùng nhập địa chỉ LAN (`http://<IP-máy-chủ>:8080`) hoặc link từ xa (`https://cctv.tencongty.com`).
- **Tăng tốc phần cứng (Hardware Acceleration):** Giải mã video mượt mà, không giật lag.
- **Xem video toàn màn hình (Fullscreen):** Tự động mở rộng và xoay ngang khi xem camera.
- **Hỗ trợ mạng nội bộ HTTP Cleartext:** Tương thích 100% với mạng LAN nội bộ không cần chứng chỉ SSL phức tạp.

### Các bước xuất file APK:
1. Tải và cài đặt **[Android Studio](https://developer.android.com/studio)** (miễn phí) trên máy tính Windows hoặc Linux.
2. Mở Android Studio, chọn **Open** ➔ Chọn thư mục `android` trong thư mục `CCTVAPP`.
3. Chờ Android Studio đồng bộ Gradle xong (khoảng 1 phút lần đầu).
4. Vào thanh menu trên cùng:  
   **Build ➔ Build Bundle(s) / APK(s) ➔ Build APK(s)**.
5. Sau khi build xong, Android Studio sẽ hiện thông báo ở góc dưới bên phải:  
   *`APK(s) generated successfully`* ➔ Bấm vào chữ **`locate`** để mở thư mục chứa file `.apk`:
   ```text
   android/app/build/outputs/apk/debug/app-debug.apk
   ```
6. Đổi tên file thành `CCTVVisionHub.apk` và gửi sang điện thoại để cài đặt!

---

## 3. CÁCH CÀI ĐẶT FILE .APK VÀO ĐIỆN THOẠI ANDROID
1. Gửi file `CCTVVisionHub.apk` vào điện thoại (qua cáp USB, Zalo, Telegram, Google Drive...).
2. Bấm vào file `.apk` trên điện thoại để bắt đầu cài đặt.
3. Nếu điện thoại hiện cảnh báo *"Cho phép cài đặt ứng dụng từ nguồn không xác định"*, hãy chọn **Cài đặt ➔ Bật cho phép**.
4. Mở app **CCTV Vision Hub**:
   - Lần đầu mở app, nếu chưa tìm thấy máy chủ, app sẽ hiển thị hộp thoại:
     *"Nhập địa chỉ IP máy chủ (ví dụ: http://<IP-máy-chủ>:8080)"*.
   - Nhập IP máy tính công ty của bạn và bấm **"Lưu & Kết Nối"**.
   - App sẽ ghi nhớ và tự động kết nối mỗi khi bạn mở app!
