"""
Alarm Manager - Module quản lý giám sát an ninh và điều phối cảnh báo tự động.
Hỗ trợ:
- Lắng nghe sự kiện từ camera Dahua/Imou qua binary RPC2 (0% CPU impact).
- Chụp snapshot 1080p tức thì qua RTSP.
- Lọc AI phát hiện người (SmartMotionHuman) hoặc chuyển động (VideoMotion).
- Lịch trình gác đêm/ngoài giờ tự động (Overnight schedule).
- Cơ chế giãn cách (anti-spam cooldown) thông minh chống dội tin nhắn.
- Gửi ảnh chụp và tin nhắn cảnh báo tới Telegram Bot.
- Lưu trữ lịch sử báo động (Audit Trail Log).
"""

import os
import re
import time
import json
import logging
import threading
import datetime
import urllib.parse
import subprocess
import uuid
from typing import Callable, Optional
from collections import deque
import concurrent.futures

from dahua.events import EventListener
import telegram_service
from onvif_manager import get_camera_storage_info

logger = logging.getLogger("alarm_manager")
logging.basicConfig(level=logging.INFO)

_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D]+"
)

DEFAULT_STARTUP_GRACE_SECONDS = 15
DEFAULT_SNAPSHOTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "snapshots")


def _safe_int(value, default: int, minimum: Optional[int] = None,
              maximum: Optional[int] = None) -> int:
    try:
        result = int(str(value).strip())
    except (TypeError, ValueError):
        return default
    if minimum is not None and result < minimum:
        result = minimum
    if maximum is not None and result > maximum:
        result = maximum
    return result


def _strip_emoji(text: str) -> str:
    return _EMOJI_RE.sub("", str(text or "")).replace("  ", " ").strip()


class AlarmManager:
    def __init__(self, settings_getter: Callable[[], dict], get_cached_devices: Callable[[], list],
                 rtsp_url_builder: Optional[Callable[..., str]] = None):
        self.settings_getter = settings_getter
        self.get_cached_devices = get_cached_devices
        self.rtsp_url_builder = rtsp_url_builder

        self.armed = True
        self._listeners: dict[str, EventListener] = {}
        self._listeners_lock = threading.Lock()
        self._last_alert_time: dict[str, float] = {}
        self._history = deque(maxlen=100)
        self._history_lock = threading.Lock()

        # Quản lý trạng thái thẻ nhớ (Storage Health Watchdog)
        self._storage_states: dict[str, dict] = {}
        self._storage_lock = threading.Lock()
        self._last_storage_watchdog_run: float = 0.0
        self._last_storage_alert_time: dict[str, float] = {}
        self._storage_watchdog_thread: Optional[threading.Thread] = None

        self._running = False
        self._maintenance_thread: Optional[threading.Thread] = None
        self._started_at: float = 0.0

    # -- startup grace ------------------------------------------------------
    def grace_seconds(self) -> int:
        try:
            settings = self.settings_getter() or {}
        except Exception:
            settings = {}
        return _safe_int(
            settings.get("alarm_startup_grace_seconds", DEFAULT_STARTUP_GRACE_SECONDS),
            DEFAULT_STARTUP_GRACE_SECONDS, 0, 600,
        )

    def grace_remaining_seconds(self) -> int:
        if not self._started_at:
            return 0
        remaining = self.grace_seconds() - int(time.time() - self._started_at)
        return max(0, remaining)

    def in_grace(self) -> bool:
        return self.grace_remaining_seconds() > 0

    def start(self):
        """Khởi động tiến trình quản trị báo động và luồng bảo trì nền."""
        if self._running:
            return
        self._running = True
        self._started_at = time.time()
        self._maintenance_thread = threading.Thread(
            target=self._maintenance_loop, daemon=True, name="AlarmManagerMaintenance")
        self._maintenance_thread.start()

        # Khởi động luồng Watchdog kiểm tra thẻ nhớ định kỳ
        self._storage_watchdog_thread = threading.Thread(
            target=self._storage_watchdog_loop, daemon=True, name="AlarmManagerStorageWatchdog")
        self._storage_watchdog_thread.start()
        logger.info(
            "[AlarmManager] Đã khởi động dịch vụ giám sát an ninh & Watchdog thẻ nhớ "
            "(grace period %ss).", self.grace_seconds())

    def stop(self):
        """Dừng toàn bộ dịch vụ và đóng các kết nối listener."""
        self._running = False
        self._started_at = 0.0
        with self._listeners_lock:
            for ip, listener in list(self._listeners.items()):
                try:
                    listener.stop()
                except Exception:
                    pass
            self._listeners.clear()
        logger.info("[AlarmManager] Đã dừng toàn bộ dịch vụ giám sát.")

    def is_armed(self) -> bool:
        return self.armed

    def set_armed(self, state: bool):
        self.armed = state
        status_str = "BẬT (ARMED)" if state else "TẮT (DISARMED)"
        logger.info(f"[AlarmManager] Chế độ giám sát báo động đã chuyển sang: {status_str}")

    def is_in_schedule(self) -> bool:
        """Kiểm tra thời điểm hiện tại có nằm trong khung giờ gác hay không."""
        settings = self.settings_getter()
        if not settings.get("telegram_schedule_enabled", True):
            # Nếu không bật lịch trình => Giám sát 24/7
            return True

        start_str = str(settings.get("telegram_schedule_start") or "18:00").strip()
        end_str = str(settings.get("telegram_schedule_end") or "07:00").strip()

        try:
            now = datetime.datetime.now().time()
            s_h, s_m = [int(p) for p in start_str.split(":")]
            e_h, e_m = [int(p) for p in end_str.split(":")]
            t_start = datetime.time(s_h, s_m)
            t_end = datetime.time(e_h, e_m)

            if t_start > t_end:
                # Ca đêm (Vd: 18:00 tối hôm trước đến 07:00 sáng hôm sau)
                return now >= t_start or now < t_end
            else:
                # Ca ngày (Vd: 08:00 sáng đến 17:00 chiều)
                return t_start <= now <= t_end
        except Exception as e:
            logger.warning(f"[AlarmManager] Lỗi kiểm tra lịch trình ({start_str}-{end_str}): {e}")
            return True

    def _maintenance_loop(self):
        """Luồng định kỳ quét thiết bị và duy trì kết nối EventListener tới các camera."""
        while self._running:
            try:
                self.sync_listeners()
            except Exception as e:
                logger.error(f"[AlarmManager] Lỗi trong maintenance loop: {e}")
            time.sleep(20)

    def sync_listeners(self):
        """Đồng bộ các kết nối lắng nghe sự kiện với danh sách camera mục tiêu."""
        # Không mở kết nối camera nếu dịch vụ chưa được start (ví dụ test mode).
        if not self._running:
            return
        if self.in_grace():
            logger.info(
                "[AlarmManager] Bỏ qua đồng bộ listener trong thời gian chờ khởi động (%ss).",
                self.grace_remaining_seconds())
            return
        settings = self.settings_getter()
        all_devices = self.get_cached_devices()
        target_ips_config = settings.get("telegram_armed_cameras", [])

        # Xác định danh sách IP cần lắng nghe
        target_devices = {}
        for dev in all_devices:
            ip = dev.get("ip")
            if not ip:
                continue
            is_armed = dev.get("alarm_armed")
            if is_armed is None:
                is_armed = dev.get("alarm_enabled", True)
            if not is_armed:
                continue
            if not target_ips_config or len(target_ips_config) == 0 or "*" in target_ips_config or ip in target_ips_config:
                target_devices[ip] = dev

        # Lấy mật khẩu kết nối camera
        default_pwd = str(settings.get("default_password") or "")

        # 1. Hủy listener cho các camera không còn nằm trong mục tiêu
        with self._listeners_lock:
            for ip in list(self._listeners.keys()):
                if ip not in target_devices:
                    try:
                        self._listeners[ip].stop()
                    except Exception:
                        pass
                    del self._listeners[ip]
                    logger.info(f"[AlarmManager] Đã ngắt listener camera {ip} (Không nằm trong danh sách gác an ninh)")

            # 2. Tìm danh sách camera cần kết nối mới
            needed = []
            for ip, dev in target_devices.items():
                listener = self._listeners.get(ip)
                is_dead = (
                    listener is None
                    or not listener._running
                    or (listener._thread and not listener._thread.is_alive())
                )
                if is_dead:
                    needed.append((
                        ip,
                        str(dev.get("username") or "admin"),
                        str(dev.get("password") or default_pwd),
                        dev.get("name") or ip,
                    ))

        if not needed:
            return

        def connect_camera(cam_info):
            ip, username, pwd, name = cam_info
            if not pwd:
                logger.debug("[AlarmManager] Bỏ qua listener %s: chưa có mật khẩu camera.", ip)
                return
            with self._listeners_lock:
                old_l = self._listeners.get(ip)
                if old_l and old_l._running and old_l._thread and old_l._thread.is_alive():
                    return
                if old_l:
                    try:
                        old_l.stop()
                    except Exception:
                        pass

            created = False
            for port in [80, 37777]:
                try:
                    new_listener = EventListener(
                        host=ip,
                        port=port,
                        timeout=2.0,
                        codes=["SmartMotionHuman", "VideoMotion", "StorageFailure", "StorageNotExist", "StorageLowSpace", "All"]
                    )
                    callback = lambda evt, cam_ip=ip: self._handle_incoming_event(cam_ip, evt)
                    new_listener.start(callback=callback, username=username, password=pwd)
                    with self._listeners_lock:
                        self._listeners[ip] = new_listener
                    logger.info(f"[AlarmManager] Kết nối thành công listener camera {ip}:{port} ({name})")
                    created = True
                    break
                except Exception as e:
                    logger.debug(f"[AlarmManager] Không thể gắn listener {ip}:{port}: {e}")

            if not created:
                logger.debug(f"[AlarmManager] Tạm thời chưa gắn được listener cho camera {ip}")

        # Chạy song song tối đa 6 luồng để không tắc nghẽn
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
            list(executor.map(connect_camera, needed))

    def _handle_incoming_event(self, ip: str, event: dict):
        """Xử lý sự kiện thời gian thực đẩy về từ camera."""
        # Bỏ qua toàn bộ sự kiện trong grace period sau khởi động để tránh cảnh báo giả.
        if self.in_grace():
            return

        action = event.get("Action", "")
        code = event.get("Code", "")

        # Chỉ kích hoạt khi sự kiện bắt đầu (Action == 'Start')
        if action != "Start":
            return

        now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        settings = self.settings_getter()

        # Tìm tên camera và kiểm tra trạng thái gác an ninh riêng
        cam_name = ip
        cam_armed = True

        all_known = []
        try:
            from managed_manager import load_managed_cameras
            all_known = load_managed_cameras()
        except Exception:
            pass
        if not all_known:
            all_known = self.get_cached_devices()

        for dev in all_known:
            if dev.get("ip") == ip:
                cam_name = dev.get("name") or dev.get("model") or ip
                is_armed = dev.get("alarm_armed")
                if is_armed is None:
                    is_armed = dev.get("alarm_enabled", True)
                cam_armed = bool(is_armed)
                break

        # TÁCH NHÁNH 1: Sự kiện lỗi phần cứng thẻ nhớ (Xử lý độc lập 24/7, không phụ thuộc lịch an ninh)
        STORAGE_CODES = {"StorageFailure", "StorageNotExist", "StorageLowSpace"}
        if code in STORAGE_CODES:
            self._handle_storage_event(ip, cam_name, code, event, now_str)
            return

        # TÁCH NHÁNH 2: Sự kiện An ninh (Phát hiện người / chuyển động)
        if code == "SmartMotionHuman":
            event_title = "Phát hiện con người"
            is_human = True
        elif code == "VideoMotion":
            event_title = "Phát hiện chuyển động"
            is_human = False
        else:
            event_title = f"Sự kiện: {code}"
            is_human = False

        # 1. Kiểm tra trạng thái ARMED (Tổng thể hệ thống)
        if not self.armed:
            self._log_history(now_str, ip, cam_name, code, event_title, "Bỏ qua (Hệ thống đang TẮT gác)", None)
            return

        # 1.1 Kiểm tra trạng thái ARMED riêng của Camera này
        if not cam_armed:
            self._log_history(now_str, ip, cam_name, code, event_title, "Bỏ qua (Đã tắt gác an ninh camera này)", None)
            return

        # 1.2 Kiểm tra danh sách giới hạn IP telegram_armed_cameras (nếu có cấu hình)
        target_ips_config = settings.get("telegram_armed_cameras", [])
        if target_ips_config and len(target_ips_config) > 0 and "*" not in target_ips_config:
            if ip not in target_ips_config:
                self._log_history(now_str, ip, cam_name, code, event_title, "Bỏ qua (IP không nằm trong danh sách gác)", None)
                return

        # 2. Kiểm tra kích hoạt Telegram trong cài đặt
        if not settings.get("telegram_enabled", False):
            self._log_history(now_str, ip, cam_name, code, event_title, "Bỏ qua (Chưa bật Telegram)", None)
            return

        # 3. Kiểm tra lịch trình (Giờ gác đêm / ngoài giờ)
        if not self.is_in_schedule():
            self._log_history(now_str, ip, cam_name, code, event_title, "Bỏ qua (Ngoài khung giờ gác)", None)
            return

        # 4. Kiểm tra bộ lọc AI người (canonical telegram_ai_filter_human, fallback alias cũ)
        human_only = settings.get("telegram_ai_filter_human",
                                  settings.get("telegram_human_only", True))
        if human_only and not is_human:
            self._log_history(now_str, ip, cam_name, code, event_title, "Bỏ qua (Chỉ lọc người)", None)
            return

        # 5. Kiểm tra thời gian giãn cách (Anti-Spam Cooldown)
        cooldown = _safe_int(
            settings.get("telegram_cooldown_seconds", settings.get("telegram_cooldown", 60)),
            60, 1, 86400,
        )
        last_time = self._last_alert_time.get(ip, 0)
        now_ts = time.time()
        if now_ts - last_time < cooldown:
            remaining = int(cooldown - (now_ts - last_time))
            self._log_history(now_str, ip, cam_name, code, event_title, f"Bỏ qua (Giãn cách còn {remaining}s)", None)
            return

        # Cập nhật thời điểm báo động mới nhất
        self._last_alert_time[ip] = now_ts

        # 6. Đưa việc chụp ảnh và gửi Telegram vào luồng riêng để không tắc nghẽn luồng nhận socket
        threading.Thread(
            target=self._process_and_send_alert,
            args=(ip, cam_name, code, event_title, now_str),
            daemon=True,
            name=f"AlertSender-{ip}"
        ).start()

    def _process_and_send_alert(self, ip: str, cam_name: str, code: str, event_title: str, now_str: str):
        """Chụp ảnh 1080p và gửi tin nhắn cảnh báo tới Telegram."""
        settings = self.settings_getter()
        bot_token = str(settings.get("telegram_bot_token") or "").strip()
        chat_id = str(settings.get("telegram_chat_id") or "").strip()

        if not bot_token or not chat_id:
            self._log_history(now_str, ip, cam_name, code, event_title, "Lỗi: Thiếu Bot Token / Chat ID", None)
            return

        # Mật khẩu / username camera (ưu tiên hồ sơ managed, fallback default)
        pwd = str(settings.get("default_password") or "")
        username = ""
        for dev in self.get_cached_devices():
            if dev.get("ip") == ip:
                if dev.get("password"):
                    pwd = str(dev.get("password"))
                if dev.get("username"):
                    username = str(dev.get("username"))
                break

        # Chụp snapshot 1080p (subtype=0)
        photo_bytes = self.capture_snapshot(ip, pwd, username=username or "admin") if pwd else None
        snap_filename = None

        if photo_bytes:
            snap_dir = str(settings.get("snapshots_dir") or "").strip() or DEFAULT_SNAPSHOTS_DIR
            try:
                os.makedirs(snap_dir, exist_ok=True)
                safe_time = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
                snap_filename = f"alarm_{ip}_{safe_time}.jpg"
                with open(os.path.join(snap_dir, snap_filename), "wb") as f:
                    f.write(photo_bytes)
            except Exception as e:
                snap_filename = None
                logger.warning(f"[AlarmManager] Lỗi lưu file snapshot cục bộ: {e}")

        # Soạn nội dung cảnh báo Telegram phong cách chuyên nghiệp
        caption = (
            f"🚨 *CẢNH BÁO AN NINH CÔNG TY* 🚨\n"
            f"━━━━━━━━━━━━━━━━━━━━\n"
            f"📹 *Camera:* `{cam_name}`\n"
            f"🌐 *IP:* `{ip}`\n"
            f"⚠️ *Sự kiện:* *{event_title}*\n"
            f"⏰ *Thời gian:* `{now_str}`\n"
            f"🛡️ *Trạng thái:* Hệ thống trực tự động 24/7\n"
            f"━━━━━━━━━━━━━━━━━━━━\n"
            f"👉 _Hình ảnh chụp trực tiếp từ ống kính HD 1080p._"
        )

        try:
            if photo_bytes:
                res = telegram_service.send_telegram_photo(
                    bot_token=bot_token,
                    chat_id=chat_id,
                    photo_bytes=photo_bytes,
                    caption=caption,
                    filename=snap_filename or "alarm_snapshot.jpg"
                )
            else:
                caption += "\n⚠️ _(Không lấy được ảnh snapshot từ luồng RTSP)_"
                res = telegram_service.send_telegram_message(
                    bot_token=bot_token,
                    chat_id=chat_id,
                    text=caption
                )

            if res.get("ok"):
                status_desc = "Đã gửi Telegram thành công ✅"
                logger.info(f"[AlarmManager] Cảnh báo gửi thành công tới Telegram: {cam_name} ({ip})")
            else:
                status_desc = f"Lỗi Telegram: {res.get('error')}"
                logger.error(f"[AlarmManager] Thất bại khi gửi Telegram: {res.get('error')}")

            self._log_history(now_str, ip, cam_name, code, event_title, status_desc, snap_filename)
        except Exception as e:
            logger.error(f"[AlarmManager] Lỗi ngoại lệ khi gửi cảnh báo: {e}")
            self._log_history(now_str, ip, cam_name, code, event_title, f"Lỗi ngoại lệ: {e}", snap_filename)

    def capture_snapshot(self, ip: str, password: str, username: str = "admin") -> Optional[bytes]:
        """Chụp snapshot độ phân giải cao qua RTSP bằng ffmpeg.

        Dùng ``rtsp_url_builder`` do app truyền vào (vendor-aware). Nếu không có
        builder, fallback URL Dahua để tương thích ngược.
        """
        if not password:
            return None
        if str(os.environ.get("CCTV_DISABLE_FFMPEG", "")).strip().lower() in {"1", "true", "yes", "on"}:
            return None
        ffmpeg_bin = os.environ.get("CCTV_FFMPEG_PATH") or "ffmpeg"
        if callable(self.rtsp_url_builder):
            try:
                rtsp_url = self.rtsp_url_builder(ip=ip, username=username, password=password)
            except TypeError:
                rtsp_url = self.rtsp_url_builder(ip, username, password)
            except Exception as exc:
                logger.error("[AlarmManager] Không tạo được RTSP URL cho %s: %s", ip, exc)
                return None
        else:
            pwd_enc = urllib.parse.quote(str(password))
            user_enc = urllib.parse.quote(str(username or "admin"))
            rtsp_url = f"rtsp://{user_enc}:{pwd_enc}@{ip}:554/cam/realmonitor?channel=1&subtype=0"

        cmd = [
            ffmpeg_bin,
            "-rtsp_transport", "tcp",
            "-i", rtsp_url,
            "-vframes", "1",
            "-q:v", "2",
            "-f", "image2",
            "pipe:1"
        ]

        try:
            proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5.0)
            if proc.returncode == 0 and proc.stdout:
                return proc.stdout
        except Exception as e:
            logger.error(f"[AlarmManager] Không thể lấy snapshot từ {ip}: {e}")
        return None

    # ==============================================================================
    # XỬ LÝ LỖI THẺ NHỚ & STORAGE HEALTH WATCHDOG
    # ==============================================================================

    def _handle_storage_event(self, ip: str, cam_name: str, code: str, event: dict, now_str: str):
        """Xử lý sự kiện lỗi phần cứng thẻ nhớ thời gian thực từ camera."""
        settings = self.settings_getter()
        if not settings.get("telegram_enabled", False) or not settings.get("telegram_storage_alerts", True):
            self._log_history(now_str, ip, cam_name, code, f"Lỗi thẻ nhớ ({code})", "Bỏ qua (Chưa bật Cảnh báo Thẻ nhớ Telegram)", None)
            return

        bot_token = str(settings.get("telegram_bot_token") or "").strip()
        chat_id = str(settings.get("telegram_chat_id") or "").strip()
        if not bot_token or not chat_id:
            self._log_history(now_str, ip, cam_name, code, f"Lỗi thẻ nhớ ({code})", "Lỗi: Chưa cấu hình Bot Token / Chat ID", None)
            return

        # Cooldown chống dội tin nhắn lỗi thẻ nhớ (tối thiểu 15 phút giữa 2 lần báo cùng 1 lỗi thẻ cho 1 camera)
        last_alert = self._last_storage_alert_time.get(ip, 0)
        now_ts = time.time()
        if now_ts - last_alert < 900:
            self._log_history(now_str, ip, cam_name, code, f"Lỗi thẻ nhớ ({code})", "Bỏ qua (Giãn cách cảnh báo thẻ nhớ 15p)", None)
            return
        self._last_storage_alert_time[ip] = now_ts

        code_desc = {
            "StorageFailure": "Lỗi phần cứng / Hỏng đọc ghi thẻ nhớ (Storage Failure)",
            "StorageNotExist": "Không tìm thấy thẻ nhớ hoặc thẻ bị rút ra (Storage Not Exist)",
            "StorageLowSpace": "Dung lượng thẻ nhớ sắp hết / Bị đầy không ghi đè được"
        }.get(code, f"Sự cố lưu trữ ({code})")

        msg = (
            f"💾 *CẢNH BÁO PHẦN CỨNG: LỖI THẺ NHỚ* 💾\n"
            f"━━━━━━━━━━━━━━━━━━━━\n"
            f"📹 *Camera:* `{cam_name}`\n"
            f"🌐 *Địa chỉ IP:* `{ip}`\n"
            f"⚠️ *Sự cố:* {code_desc}\n"
            f"🕒 *Thời gian:* {now_str}\n"
            f"💡 *Khắc phục:* Vui lòng tháo kiểm tra thẻ MicroSD vật lý hoặc thử Định dạng (Format) lại thẻ trên phần mềm.\n"
            f"━━━━━━━━━━━━━━━━━━━━\n"
            f"🤖 *Hệ thống Giám sát Phần cứng CCTV*"
        )

        threading.Thread(
            target=self._send_storage_telegram_alert,
            args=(bot_token, chat_id, msg, ip, cam_name, code, now_str),
            daemon=True,
            name=f"StorageAlertSender-{ip}"
        ).start()

    def _send_storage_telegram_alert(self, bot_token: str, chat_id: str, msg: str, ip: str, cam_name: str, code: str, now_str: str):
        try:
            res = telegram_service.send_telegram_message(bot_token=bot_token, chat_id=chat_id, text=msg)
            if res.get("ok"):
                self._log_history(now_str, ip, cam_name, code, f"Cảnh báo Thẻ nhớ ({code})", "Đã gửi Telegram thành công", None)
                logger.info(f"[AlarmManager] Đã gửi cảnh báo lỗi thẻ nhớ cho camera {ip} ({cam_name})")
            else:
                self._log_history(now_str, ip, cam_name, code, f"Cảnh báo Thẻ nhớ ({code})", f"Lỗi gửi Telegram: {res.get('error')}", None)
        except Exception as e:
            logger.error(f"[AlarmManager] Lỗi gửi tin nhắn Telegram thẻ nhớ: {e}")

    def _storage_watchdog_loop(self):
        """Tiến trình định kỳ quét kiểm tra sức khỏe thẻ nhớ toàn bộ camera (Watchdog)."""
        time.sleep(25)  # Chờ hệ thống khởi động ổn định 25s ban đầu
        while self._running:
            try:
                settings = self.settings_getter()
                if settings.get("telegram_storage_alerts", True) and settings.get("telegram_enabled", False):
                    interval_mins = _safe_int(
                        settings.get("telegram_storage_check_interval", 30), 30, 1, 1440)
                    interval_secs = max(60, interval_mins * 60)
                    now = time.time()
                    if now - self._last_storage_watchdog_run >= interval_secs:
                        self._last_storage_watchdog_run = now
                        logger.info("[AlarmManager] Bắt đầu chu kỳ quét sức khỏe thẻ nhớ định kỳ (Storage Watchdog)...")
                        self.check_all_storage_health(force_send=False)
            except Exception as e:
                logger.error(f"[AlarmManager] Lỗi trong storage watchdog loop: {e}")
            time.sleep(15)

    def check_all_storage_health(self, force_send: bool = False) -> dict:
        """Quét kiểm tra thẻ nhớ toàn bộ camera quản lý/giám sát.
        Tự động phát hiện lỗi và gửi cảnh báo về Telegram khi có sự cố mới,
        đồng thời gửi thông báo phục hồi (Recovery) khi thẻ được sửa chữa/thay mới."""
        settings = self.settings_getter()
        bot_token = str(settings.get("telegram_bot_token") or "").strip()
        chat_id = str(settings.get("telegram_chat_id") or "").strip()
        alerts_enabled = settings.get("telegram_storage_alerts", True) and settings.get("telegram_enabled", False)
        default_pwd = str(settings.get("default_password") or "")

        devices = self.get_cached_devices()
        results = []
        now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        def check_one(dev):
            ip = dev.get("ip")
            if not ip:
                return None
            pwd = str(dev.get("password") or default_pwd)
            username = str(dev.get("username") or "admin")
            name = dev.get("name") or dev.get("model") or ip
            if not pwd:
                return {
                    "ok": False, "ip": ip, "name": name, "has_sd": False,
                    "is_error": False, "state": "Unknown", "total_gb": 0,
                    "used_gb": 0, "status_text": "Chưa có mật khẩu camera",
                }

            try:
                info = get_camera_storage_info(ip=ip, username=username, password=pwd)
            except Exception as e:
                info = {"ok": False, "ip": ip, "error": str(e), "has_sd": False}

            info["name"] = name
            return info

        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            check_results = list(executor.map(check_one, devices))

        healthy_count = 0
        error_count = 0
        no_sd_count = 0

        for r in check_results:
            if not r or not r.get("ip"):
                continue
            ip = r["ip"]
            name = r.get("name", ip)
            has_sd = r.get("has_sd", False)
            state = r.get("state", "Unknown")
            is_error = bool(r.get("is_error", False))
            total_gb = r.get("total_gb", 0)
            used_gb = r.get("used_gb", 0)
            status_text = r.get("status_text", "")

            with self._storage_lock:
                prev_state = self._storage_states.get(ip, {})
                prev_in_error = prev_state.get("in_error", False)
                prev_had_sd = prev_state.get("has_sd", False)

                # Tiêu chí đánh giá lỗi thẻ nhớ:
                # 1. Có thẻ nhớ nhưng is_error=True hoặc state != "Success" hoặc total_gb <= 0
                # 2. Camera trước đó có thẻ nhớ mà giờ bị mất thẻ (has_sd=False)
                in_error = False
                error_reason = ""

                if has_sd:
                    if is_error or (state not in ["Success", "Normal"] and state != "Unknown"):
                        in_error = True
                        error_reason = f"Trạng thái: {state} | Cần kiểm tra ({status_text})"
                    elif total_gb <= 0:
                        in_error = True
                        error_reason = "Dung lượng thẻ báo 0 GB (Lỗi nhận diện phân vùng)"
                    else:
                        healthy_count += 1
                else:
                    no_sd_count += 1
                    if prev_had_sd:
                        in_error = True
                        error_reason = "Mất kết nối thẻ nhớ (Thẻ bị rơi ra hoặc tiếp xúc kém)"

                if in_error:
                    error_count += 1

                # Cập nhật trạng thái
                self._storage_states[ip] = {
                    "name": name,
                    "has_sd": has_sd,
                    "in_error": in_error,
                    "error_reason": error_reason,
                    "state": state,
                    "total_gb": total_gb,
                    "used_gb": used_gb,
                    "last_check": time.time()
                }

            results.append({
                "ip": ip,
                "name": name,
                "has_sd": has_sd,
                "in_error": in_error,
                "error_reason": error_reason,
                "state": state,
                "total_gb": total_gb,
                "used_gb": used_gb,
                "status_text": status_text
            })

            # Xử lý thông báo Telegram:
            if alerts_enabled and bot_token and chat_id:
                # 1. Phát hiện LỖI MỚI (chuyển từ không lỗi -> lỗi, hoặc force_send khi quét chủ động và phát hiện lỗi)
                if in_error and (not prev_in_error or force_send):
                    msg = (
                        f"💾 *CẢNH BÁO LỖI THẺ NHỚ CAMERA* 💾\n"
                        f"━━━━━━━━━━━━━━━━━━━━\n"
                        f"📹 *Camera:* `{name}`\n"
                        f"🌐 *Địa chỉ IP:* `{ip}`\n"
                        f"⚠️ *Sự cố:* {error_reason}\n"
                        f"📊 *Dung lượng:* {total_gb} GB (Đã dùng: {used_gb} GB)\n"
                        f"🕒 *Thời gian:* {now_str}\n"
                        f"💡 *Khắc phục:* Vui lòng kiểm tra thẻ MicroSD trên camera hoặc định dạng (Format) lại trên phần mềm.\n"
                        f"━━━━━━━━━━━━━━━━━━━━\n"
                        f"🤖 *Hệ thống Giám sát Sức khỏe CCTV*"
                    )
                    threading.Thread(
                        target=self._send_storage_telegram_alert,
                        args=(bot_token, chat_id, msg, ip, name, "StorageFailure", now_str),
                        daemon=True
                    ).start()

                # 2. KHÔI PHỤC (Trước đó lỗi, bây giờ đã hoạt động bình thường trở lại)
                elif prev_in_error and not in_error and has_sd:
                    msg = (
                        f"✅ *THẺ NHỚ CAMERA ĐÃ HOẠT ĐỘNG TRỞ LẠI* ✅\n"
                        f"━━━━━━━━━━━━━━━━━━━━\n"
                        f"📹 *Camera:* `{name}`\n"
                        f"🌐 *Địa chỉ IP:* `{ip}`\n"
                        f"🎉 *Trạng thái:* Thẻ MicroSD đã đọc/ghi bình thường!\n"
                        f"💾 *Dung lượng:* {total_gb} GB (Đã dùng: {used_gb} GB)\n"
                        f"🕒 *Thời gian:* {now_str}\n"
                        f"━━━━━━━━━━━━━━━━━━━━\n"
                        f"🤖 *Hệ thống Giám sát Sức khỏe CCTV*"
                    )
                    threading.Thread(
                        target=self._send_storage_telegram_alert,
                        args=(bot_token, chat_id, msg, ip, name, "StorageRecovered", now_str),
                        daemon=True
                    ).start()

        return {
            "ok": True,
            "timestamp": now_str,
            "total_scanned": len(results),
            "healthy": healthy_count,
            "errors": error_count,
            "no_sd": no_sd_count,
            "details": results
        }

    def _log_history(self, timestamp: str, ip: str, cam_name: str, event_code: str, event_title: str, status: str, snapshot_file: Optional[str]):
        """Ghi nhận nhật ký sự kiện vào buffer an toàn luồng."""
        item = {
            "id": f"{int(time.time()*1000)}_{uuid.uuid4().hex[:6]}",
            "timestamp": timestamp,
            "ip": ip,
            "name": cam_name,
            "code": event_code,
            "title": event_title,
            "status": status,
            "snapshot_file": snapshot_file
        }
        with self._history_lock:
            self._history.appendleft(item)

    def get_history(self) -> list:
        """Trả lịch sử đã chuẩn hoá: status enum, title không emoji."""
        with self._history_lock:
            items = list(self._history)
        output = []
        for item in items:
            clean = dict(item)
            clean["status"] = self._map_history_status(item.get("status"))
            clean["title"] = _strip_emoji(item.get("title") or "")
            output.append(clean)
        return output

    def clear_history(self):
        with self._history_lock:
            self._history.clear()

    @staticmethod
    def _map_history_status(raw_status) -> str:
        text = str(raw_status or "").lower()
        if "giãn cách" in text:
            return "suppressed"
        if "bỏ qua" in text:
            return "skipped"
        if "lỗi" in text or "thất bại" in text:
            return "failed"
        if "thành công" in text or "đã gửi" in text:
            return "sent"
        return "failed"

    def _sanitized_storage_states(self) -> dict:
        states = {}
        for ip, state in self._storage_states.items():
            if state.get("in_error"):
                status, error_code = "error", "STORAGE_ERROR"
            elif not state.get("has_sd"):
                status, error_code = "no_sd", "NO_SD"
            else:
                status, error_code = "ok", None
            last_check = state.get("last_check")
            try:
                last_check_text = datetime.datetime.fromtimestamp(last_check).strftime("%Y-%m-%d %H:%M:%S") if last_check else None
            except Exception:
                last_check_text = None
            states[ip] = {
                "name": state.get("name") or ip,
                "status": status,
                "error_code": error_code,
                "last_check": last_check_text,
            }
        return states

    def get_status(self) -> dict:
        """Trả về trạng thái hoạt động của hệ thống cảnh báo (không chứa secret)."""
        settings = self.settings_getter()
        with self._listeners_lock:
            active_ips = [
                ip for ip, listener in self._listeners.items()
                if listener._running and (listener._thread and listener._thread.is_alive())
            ]

        with self._storage_lock:
            storage_summary = {
                "states": self._sanitized_storage_states(),
                "last_run": (
                    datetime.datetime.fromtimestamp(self._last_storage_watchdog_run).strftime("%Y-%m-%d %H:%M:%S")
                    if self._last_storage_watchdog_run else None
                ),
            }

        human_only = settings.get("telegram_ai_filter_human",
                                  settings.get("telegram_human_only", True))
        cooldown = _safe_int(
            settings.get("telegram_cooldown_seconds", settings.get("telegram_cooldown", 60)),
            60, 1, 86400,
        )
        return {
            "ok": True,
            "armed": self.armed,
            "telegram_enabled": bool(settings.get("telegram_enabled", False)),
            "bot_configured": bool(settings.get("telegram_bot_token") and settings.get("telegram_chat_id")),
            "schedule_enabled": settings.get("telegram_schedule_enabled", True),
            "schedule_start": settings.get("telegram_schedule_start", "18:00"),
            "schedule_end": settings.get("telegram_schedule_end", "07:00"),
            "is_in_schedule": self.is_in_schedule(),
            "cooldown_seconds": cooldown,
            "human_only": bool(human_only),
            "telegram_storage_alerts": settings.get("telegram_storage_alerts", True),
            "telegram_storage_check_interval": _safe_int(
                settings.get("telegram_storage_check_interval", 30), 30, 1, 1440),
            "storage_watchdog": storage_summary,
            "active_listeners": active_ips,
            "listeners_count": len(active_ips),
            "history_count": len(self._history),
            "startup_grace_remaining_seconds": self.grace_remaining_seconds(),
        }
