#!/usr/bin/env bash
# =================================================================
# CCTV Vision Hub - Linux Systemd Service Installer (24/7)
# =================================================================
# Không tự cài dependency: in lệnh và chờ xác nhận.
# Không hardcode mật khẩu, không tắt xác thực TLS.
# =================================================================

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "[-] Vui lòng chạy script này với quyền root: sudo bash install_service.sh"
  exit 1
fi

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTUAL_USER="${SUDO_USER:-$USER}"
PYTHON_BIN="$(command -v python3 || true)"

if [ -z "$PYTHON_BIN" ]; then
  echo "[!] Không tìm thấy python3. Cài Python 3.11 rồi chạy lại."
  exit 1
fi

echo "================================================================="
echo "   CÀI ĐẶT DỊCH VỤ CCTV VISION HUB 24/7 (SYSTEMD SERVICE)"
echo "================================================================="
echo "[*] Thư mục ứng dụng: $CURRENT_DIR"
echo "[*] Người dùng thực thi: $ACTUAL_USER"
echo "[*] Trình thông dịch: $PYTHON_BIN"

if [ ! -f "$CURRENT_DIR/app.py" ]; then
  echo "[!] Không tìm thấy app.py trong $CURRENT_DIR"
  exit 1
fi

if [ ! -f "$CURRENT_DIR/requirements.txt" ]; then
  echo "[!] Không tìm thấy requirements.txt"
  exit 1
fi

# FFmpeg là gói hệ thống bắt buộc cho video/audio.
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[!] CẢNH BÁO: Không tìm thấy FFmpeg trong PATH."
  echo "    FFmpeg là BẮT BUỘC cho live view/audio/snapshot/ghi hình."
  echo "    Cài bằng: sudo apt-get install -y ffmpeg"
  read -r -p "Tiếp tục cài service? (Y/N): " CONTINUE_NO_FFMPEG
  case "$CONTINUE_NO_FFMPEG" in
    [Yy]*) ;;
    *) echo "[!] Đã huỷ."; exit 1 ;;
  esac
fi

# Kiểm tra dependency; hỏi trước khi cài, không dùng `|| true` che lỗi.
if ! "$PYTHON_BIN" -c "import bottle, requests, PIL, urllib3, certifi" >/dev/null 2>&1; then
  echo "[!] Thiếu thư viện Python."
  echo "[i] Lệnh cài đặt:"
  echo "    cd \"$CURRENT_DIR\" && $PYTHON_BIN -m pip install -r requirements.txt"
  read -r -p "Cài đặt ngay? (Y/N): " INSTALL_DEPS
  case "$INSTALL_DEPS" in
    [Yy]*)
      su - "$ACTUAL_USER" -c "cd '$CURRENT_DIR' && '$PYTHON_BIN' -m pip install -r requirements.txt"
      ;;
    *)
      echo "[!] Đã huỷ. Không cài service khi thiếu thư viện."
      exit 1
      ;;
  esac
fi

mkdir -p "$CURRENT_DIR/data" "$CURRENT_DIR/logs"
chown -R "$ACTUAL_USER": "$CURRENT_DIR/data" "$CURRENT_DIR/logs" 2>/dev/null || true

CCTV_HOST="${CCTV_HOST:-0.0.0.0}"
CCTV_PORT="${CCTV_PORT:-8080}"
CCTV_SETTINGS_FILE="${CCTV_SETTINGS_FILE:-$CURRENT_DIR/settings.json}"
CCTV_MANAGED_FILE="${CCTV_MANAGED_FILE:-$CURRENT_DIR/managed_cameras.json}"
CCTV_BOOTSTRAP_FILE="${CCTV_BOOTSTRAP_FILE:-$CURRENT_DIR/data/bootstrap_admin.txt}"
CCTV_APP_LOG="${CCTV_APP_LOG:-$CURRENT_DIR/logs/app.log}"
CCTV_AUDIT_LOG="${CCTV_AUDIT_LOG:-$CURRENT_DIR/logs/audit.jsonl}"

SERVICE_FILE="/etc/systemd/system/cctvapp.service"

cat > "$SERVICE_FILE" << EOF
[Unit]
Description=CCTV Vision Hub 24/7 Security & Management Daemon
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$ACTUAL_USER
WorkingDirectory="$CURRENT_DIR"
ExecStart="$PYTHON_BIN" "$CURRENT_DIR/app.py"
Restart=always
RestartSec=5s
KillSignal=SIGTERM
TimeoutStopSec=10s
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
PrivateTmp=true
Environment=PYTHONUNBUFFERED=1
Environment=CCTV_HOST=$CCTV_HOST
Environment=CCTV_PORT=$CCTV_PORT
Environment="CCTV_SETTINGS_FILE=$CCTV_SETTINGS_FILE"
Environment="CCTV_MANAGED_FILE=$CCTV_MANAGED_FILE"
Environment="CCTV_BOOTSTRAP_FILE=$CCTV_BOOTSTRAP_FILE"
Environment="CCTV_APP_LOG=$CCTV_APP_LOG"
Environment="CCTV_AUDIT_LOG=$CCTV_AUDIT_LOG"

[Install]
WantedBy=multi-user.target
EOF

echo "[*] Đã tạo tệp cấu hình tại: $SERVICE_FILE"

systemctl daemon-reload
systemctl enable cctvapp.service
systemctl restart cctvapp.service

echo ""
echo "================================================================="
echo " [OK] CÀI ĐẶT DỊCH VỤ CCTV VISION HUB THÀNH CÔNG!"
echo " [i] Dịch vụ chạy nền 24/7 và tự bật khi khởi động máy."
echo ""
echo " [i] Lần đầu chạy: đặt CCTV_ADMIN_PASSWORD mạnh hoặc đọc file"
echo "     $CCTV_BOOTSTRAP_FILE, đăng nhập rồi đổi mật khẩu ngay."
echo ""
echo " Các lệnh quản trị:"
echo "   - Xem trạng thái : sudo systemctl status cctvapp"
echo "   - Khởi động lại : sudo systemctl restart cctvapp"
echo "   - Dừng dịch vụ   : sudo systemctl stop cctvapp"
echo "   - Xem log        : journalctl -u cctvapp -f"
echo "================================================================="
