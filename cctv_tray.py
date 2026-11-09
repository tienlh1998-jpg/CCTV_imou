#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CCTV Vision Hub - Windows System Tray Runner
Cho phép chạy ngầm ứng dụng dưới góc màn hình (khay hệ thống cạnh đồng hồ Windows).

Lưu ý bảo mật: tray KHÔNG gọi API thay đổi trạng thái khi chưa đăng nhập.
Các thao tác quản trị phải thực hiện trong giao diện web (session + CSRF).
"""

import sys
import os
import time
import threading
import webbrowser

from PIL import Image

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(BASE_DIR)

APP_PORT = (os.environ.get("CCTV_PORT") or "8080").strip()
APP_HOST = (os.environ.get("CCTV_HOST") or "127.0.0.1").strip()
if APP_HOST in ("0.0.0.0", "::"):
    APP_HOST = "127.0.0.1"
APP_URL = f"http://{APP_HOST}:{APP_PORT}"
ICON_PATH = os.path.join(BASE_DIR, "static", "icons", "favicon.png")


def start_cctv_server():
    """Khởi chạy máy chủ app.py trong một luồng riêng."""
    try:
        import app
        app.main()
    except SystemExit:
        raise
    except Exception as exc:
        print(f"[Tray] Lỗi khi chạy server app.py: {exc}")


def open_web():
    """Mở trình duyệt web truy cập vào CCTV Hub."""
    webbrowser.open(APP_URL)


def open_alarms():
    """Mở màn hình cảnh báo; người dùng tự đăng nhập và thao tác trong UI."""
    webbrowser.open(f"{APP_URL}/#/alarms")


def main():
    server_thread = threading.Thread(target=start_cctv_server, daemon=True,
                                     name="CCTVServerThread")
    server_thread.start()

    try:
        import pystray
        from pystray import MenuItem as item
        from pystray import Menu as menu_cls
    except ImportError:
        print("[Tray] Chưa cài pystray. Đang mở trình duyệt trực tiếp...")
        time.sleep(1.5)
        open_web()
        while True:
            time.sleep(1)
        return

    if os.path.exists(ICON_PATH):
        tray_image = Image.open(ICON_PATH)
    else:
        tray_image = Image.new("RGBA", (64, 64), (6, 182, 212, 255))

    def on_quit(icon, item):
        icon.stop()
        sys.exit(0)

    menu = (
        item("Mở giao diện web", open_web, default=True),
        item("Mở màn hình cảnh báo", open_alarms),
        menu_cls.SEPARATOR,
        item("Thoát ứng dụng", on_quit),
    )

    icon = pystray.Icon("CCTVVisionHub", tray_image, "CCTV Vision Hub (24/7)", menu)
    threading.Timer(1.5, open_web).start()
    icon.run()


if __name__ == "__main__":
    main()
