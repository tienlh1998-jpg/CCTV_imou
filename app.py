#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CCTV Vision Hub - Backend Application Server (v2)

- Bottle + Python 3.11, giao diện tĩnh tự chứa.
- Mọi /api/* mặc định yêu cầu đăng nhập; phân quyền admin/viewer.
- Mật khẩu admin/viewer hash scrypt; session server-side, CSRF, rate limit.
- Mật khẩu camera không nhận qua query string, không trả qua API.
"""

import os
import sys

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import atexit
import csv
import datetime
import io
import ipaddress
import json
import logging
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
import traceback
import urllib.parse
import webbrowser
from socketserver import ThreadingMixIn
from wsgiref.simple_server import WSGIServer, WSGIRequestHandler, make_server

import bottle
from bottle import error, request, response, route, run, static_file, HTTPResponse, ServerAdapter

import auth as cctv_auth
from alarm_manager import AlarmManager
from managed_manager import (
    add_batch_managed_cameras,
    add_managed_camera,
    delete_managed_camera,
    get_managed_camera,
    load_managed_cameras,
    public_view,
    save_managed_cameras,
    sync_cameras_health,
    test_camera_connection,
    toggle_camera_alarm,
    update_managed_camera,
)
from onvif_manager import (
    batch_change_ip,
    batch_reboot_cameras,
    batch_sync_camera_time,
    change_camera_password,
    format_camera_storage,
    get_camera_hardware_status,
    get_camera_storage_info,
    get_device_full_details,
    ptz_command,
    search_camera_recordings,
    set_camera_name,
    set_camera_privacy_mode,
    set_camera_siren,
    set_smart_tracking,
)
from scan_imou import detect_company_vlans, get_local_interfaces, scan_devices
from telegram_service import test_telegram_bot

# ==============================================================================
# Cấu hình môi trường
# ==============================================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
STATIC_DIR = os.path.join(BASE_DIR, "static")

TEST_MODE = cctv_auth.env_bool("CCTV_TEST_MODE")
DISABLE_ALARMS = cctv_auth.env_bool("CCTV_DISABLE_ALARMS")
DISABLE_TELEGRAM = cctv_auth.env_bool("CCTV_DISABLE_TELEGRAM")

SETTINGS_FILE = os.path.abspath(os.environ.get("CCTV_SETTINGS_FILE") or os.path.join(BASE_DIR, "settings.json"))
SECRETS_FILE = (
    os.path.abspath(os.environ["CCTV_SECRETS_FILE"])
    if os.environ.get("CCTV_SECRETS_FILE") else ""
)
_SECRET_SETTINGS_KEYS = {
    "default_password", "telegram_bot_token", "telegram_chat_id",
    "admin_password_hash", "viewer_password_hash", "admin_password_bootstrap",
    "admin_password", "viewer_password",
}
BOOTSTRAP_FILE = os.path.abspath(
    os.environ.get("CCTV_BOOTSTRAP_FILE") or os.path.join(BASE_DIR, "data", "bootstrap_admin.txt")
)
RECORDINGS_DIR = os.path.abspath(os.environ.get("CCTV_RECORDINGS_DIR") or os.path.join(BASE_DIR, "recordings"))
SNAPSHOTS_DIR = os.path.abspath(os.environ.get("CCTV_SNAPSHOTS_DIR") or os.path.join(BASE_DIR, "snapshots"))
APK_FILE = os.path.abspath(
    os.environ.get("CCTV_APK_FILE") or os.path.join(STATIC_DIR, "download", "CCTVVisionHub-v2.apk")
)

APP_VERSION = cctv_auth.APP_VERSION
APP_STARTED_AT = time.time()


def _configure_app_log() -> None:
    path = os.environ.get("CCTV_APP_LOG") or ""
    if not path:
        return
    try:
        absolute = os.path.abspath(path)
        parent = os.path.dirname(absolute)
        if parent:
            os.makedirs(parent, exist_ok=True)
        handler = logging.FileHandler(absolute, encoding="utf-8")
        handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)s %(name)s: %(message)s"))
        root = logging.getLogger()
        root.setLevel(logging.INFO)
        root.addHandler(handler)
    except Exception as exc:
        print(f"[!] Không mở được CCTV_APP_LOG '{path}': {exc}")


_configure_app_log()

# Server header không lộ phiên bản Python/WSGIServer.
try:
    import wsgiref.simple_server as _wsgiref
    _wsgiref.ServerHandler.server_software = "CCTV"
except Exception:
    pass


class ThreadedWSGIServer(ThreadingMixIn, WSGIServer):
    daemon_threads = True

    def version_string(self):
        return "CCTV"


class CCTVRequestHandler(WSGIRequestHandler):
    """Access log có redaction query nhạy cảm (password/pwd/token/secret)."""

    _SECRET_QUERY_RE = re.compile(
        r"(?i)\b(password|pwd|pass|token|secret|auth)=([^&\s]*)")

    def log_request(self, code="-", size="-"):
        try:
            request_line = self._SECRET_QUERY_RE.sub(r"\1=***", self.requestline)
            self.log_message('"%s" %s %s', request_line, code, size)
        except Exception:
            pass


class ThreadedServer(ServerAdapter):
    def run(self, handler):
        server = make_server(
            self.host, self.port, handler,
            server_class=ThreadedWSGIServer,
            handler_class=CCTVRequestHandler,
        )
        server.serve_forever()


DEFAULT_SETTINGS = {
    "schema_version": 2,
    "default_password": "",
    "scan_timeout": 2.5,
    "default_subnet": "",
    "last_subnets": "",
    "selected_vlans": [],
    "company_vlans": [],
    "deep_scan": True,
    "recordings_dir": "",
    "snapshots_dir": "",
    "auto_reboot_on_ip_change": False,
    "telegram_enabled": False,
    "telegram_bot_token": "",
    "telegram_chat_id": "",
    "telegram_schedule_enabled": True,
    "telegram_schedule_start": "18:00",
    "telegram_schedule_end": "07:00",
    "telegram_cooldown_seconds": 60,
    "telegram_ai_filter_human": True,
    "telegram_armed_cameras": [],
    "telegram_storage_alerts": True,
    "telegram_storage_check_interval": 30,
    "alarm_startup_grace_seconds": 15,
}


# ==============================================================================
# Settings store
# ==============================================================================

_SETTINGS_LOCK = threading.RLock()


def _read_settings_file(strict: bool = False) -> dict:
    if not os.path.exists(SETTINGS_FILE):
        return {}
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if not isinstance(data, dict):
            raise ValueError("settings.json phải là JSON object")
        return data
    except Exception as exc:
        if strict:
            raise cctv_auth.AuthStartupError(
                f"File cấu hình '{SETTINGS_FILE}' bị hỏng hoặc không đọc được: {exc}. "
                "Dừng khởi động để tránh ghi đè dữ liệu."
            ) from exc
        print(f"[!] Lỗi đọc settings: {exc}")
        return {}


def _load_external_secrets() -> tuple[dict, bool]:
    """Đọc secret từ CCTV_SECRETS_FILE. File được ưu tiên hơn settings.json.

    Fail-closed: nếu biến môi trường được đặt nhưng file thiếu/hỏng, dừng khởi động
    thay vì âm thầm rơi về secret trong settings.json.
    """
    if not SECRETS_FILE:
        return {}, False
    if not os.path.isfile(SECRETS_FILE):
        raise cctv_auth.AuthStartupError(
            f"CCTV_SECRETS_FILE được đặt nhưng file '{SECRETS_FILE}' không tồn tại."
        )
    try:
        with open(SECRETS_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception as exc:
        raise cctv_auth.AuthStartupError(
            f"Không đọc được CCTV_SECRETS_FILE '{SECRETS_FILE}': {exc}"
        ) from exc
    if not isinstance(data, dict):
        raise cctv_auth.AuthStartupError("CCTV_SECRETS_FILE phải là JSON object.")
    return {key: data[key] for key in _SECRET_SETTINGS_KEYS if key in data}, True


def load_settings() -> dict:
    with _SETTINGS_LOCK:
        data = _read_settings_file(strict=False)
        merged = DEFAULT_SETTINGS.copy()
        merged.update(data)
        external, managed = _load_external_secrets()
        merged.update(external)
        merged["secrets_managed_externally"] = managed
        return merged


def save_settings(updates: dict, removals=None) -> bool:
    """Ghi atomic; ``removals`` là danh sách key cần xoá khỏi file.

    Khi dùng CCTV_SECRETS_FILE, secret là read-only: mọi thay đổi/xoá secret bị từ chối
    và secret không bao giờ bị ghi ngược vào settings.json.
    """
    removals = list(removals or [])
    with _SETTINGS_LOCK:
        external_managed = bool(SECRETS_FILE)
        if external_managed and (
            _SECRET_SETTINGS_KEYS & set(updates or {})
            or _SECRET_SETTINGS_KEYS & set(removals)
        ):
            print("[!] Từ chối ghi secret khi đang dùng CCTV_SECRETS_FILE (read-only).")
            return False
        current = load_settings()
        if updates:
            current.update(updates)
        for key in removals:
            current.pop(key, None)
        current.pop("secrets_managed_externally", None)
        if external_managed:
            for key in _SECRET_SETTINGS_KEYS:
                current.pop(key, None)
        try:
            parent = os.path.dirname(SETTINGS_FILE)
            if parent:
                os.makedirs(parent, exist_ok=True)
            temp_file = f"{SETTINGS_FILE}.tmp"
            with open(temp_file, "w", encoding="utf-8") as handle:
                json.dump(current, handle, indent=2, ensure_ascii=False)
            os.replace(temp_file, SETTINGS_FILE)
            cctv_auth.secure_file_permissions(SETTINGS_FILE)
            return True
        except Exception as exc:
            print(f"[!] Lỗi ghi settings: {exc}")
            return False


for _directory in (RECORDINGS_DIR, SNAPSHOTS_DIR):
    try:
        os.makedirs(_directory, exist_ok=True)
    except OSError:
        pass


# ==============================================================================
# FFmpeg
# ==============================================================================

def _detect_ffmpeg() -> dict:
    info = {"available": False, "path": "", "version": None, "audio_available": False}
    if cctv_auth.env_bool("CCTV_DISABLE_FFMPEG"):
        return info
    candidate = os.environ.get("CCTV_FFMPEG_PATH") or shutil.which("ffmpeg") or ""
    if not candidate:
        return info
    resolved = candidate
    if not os.path.isfile(resolved):
        resolved = shutil.which(candidate) or ""
    if not resolved or not os.path.isfile(resolved):
        return info
    try:
        proc = subprocess.run(
            [resolved, "-version"], stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=6.0,
        )
        first_line = (proc.stdout or b"").decode("utf-8", errors="ignore").splitlines()[:1]
        version = None
        if first_line:
            match = re.search(r"version\s+(\S+)", first_line[0])
            version = match.group(1) if match else "ok"
        info.update({"available": proc.returncode == 0, "path": resolved, "version": version})
    except Exception:
        info.update({"available": False, "path": resolved, "version": None})
        return info
    if info["available"]:
        try:
            enc = subprocess.run(
                [resolved, "-hide_banner", "-encoders"], stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, timeout=10.0,
            )
            info["audio_available"] = b"libmp3lame" in (enc.stdout or b"")
        except Exception:
            info["audio_available"] = False
    return info


FFMPEG = _detect_ffmpeg()


def _ffmpeg_bin() -> str:
    return FFMPEG.get("path") or "ffmpeg"


def _ffmpeg_required(capability: str = "video") -> None:
    if not FFMPEG.get("available"):
        raise cctv_auth.fail(
            503, "FFMPEG_UNAVAILABLE",
            "FFmpeg chưa được cài hoặc không chạy được. Video/snapshot tạm thời không khả dụng.",
            details={"capability": capability},
        )
    if capability == "audio" and not FFMPEG.get("audio_available"):
        raise cctv_auth.fail(
            503, "FFMPEG_UNAVAILABLE",
            "FFmpeg thiếu bộ mã hoá MP3 (libmp3lame) nên không thể phát audio.",
            details={"capability": "audio"},
        )


def _test_mode_block(message: str = "Chức năng bị chặn trong chế độ kiểm thử.") -> None:
    if TEST_MODE:
        raise cctv_auth.fail(503, "TEST_MODE_BLOCKED", message)


# ==============================================================================
# Camera helpers
# ==============================================================================

_PRIVATE_NETS = tuple(ipaddress.ip_network(value) for value in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8",
))

_CACHED_DEVICES_LOCK = threading.RLock()
CACHED_DEVICES: list = []
_SCAN_LOCK = threading.Lock()


def _is_private_ip(addr: ipaddress.IPv4Address) -> bool:
    return any(addr in network for network in _PRIVATE_NETS)


def _parse_ipv4(value) -> ipaddress.IPv4Address:
    text = str(value or "").strip()
    try:
        return ipaddress.IPv4Address(text)
    except ValueError:
        raise cctv_auth.fail(400, "INVALID_IP", "Địa chỉ IP không phải IPv4 hợp lệ.")


def _validate_private_ip(value) -> str:
    addr = _parse_ipv4(value)
    if not _is_private_ip(addr):
        raise cctv_auth.fail(400, "INVALID_IP", "Chỉ cho phép địa chỉ IPv4 nội bộ (private).")
    return str(addr)


def _managed_ips() -> set:
    try:
        return {str(cam.get("ip")) for cam in load_managed_cameras() if cam.get("ip")}
    except Exception:
        return set()


def _scope_target(value, role: str) -> str:
    """Kiểm tra phạm vi target theo vai trò (viewer chỉ camera đã quản lý)."""
    addr = _parse_ipv4(value)
    if role == cctv_auth.VIEWER:
        if not _is_private_ip(addr) or str(addr) not in _managed_ips():
            raise cctv_auth.fail(404, "CAMERA_NOT_FOUND", "Không tìm thấy camera trong danh sách quản lý.")
        return str(addr)
    if not _is_private_ip(addr) and not cctv_auth.env_bool("CCTV_ALLOW_PUBLIC_TARGETS"):
        raise cctv_auth.fail(400, "INVALID_IP", "Chỉ cho phép địa chỉ IPv4 nội bộ (private).")
    return str(addr)


def _managed_by_ip(ip: str):
    try:
        for cam in load_managed_cameras():
            if cam.get("ip") == ip:
                return cam
    except Exception:
        pass
    return None


def _role() -> str:
    record = request.environ.get("cctv.session") or cctv_auth.current_session()
    return (record or {}).get("role") or cctv_auth.VIEWER


def _session_record():
    return request.environ.get("cctv.session") or cctv_auth.current_session()


def _session_token() -> str:
    return request.get_cookie(cctv_auth.SESSION_COOKIE) or ""


# -- credential tạm theo session ------------------------------------------------

_EPHEMERAL_LOCK = threading.RLock()
_EPHEMERAL_CREDENTIALS: dict[tuple[str, str], dict] = {}
_EPHEMERAL_TTL = 1800
_EPHEMERAL_MAX_PER_SESSION = 50


def _ephemeral_key(ip: str) -> tuple[str, str]:
    return (cctv_auth.session_key(), ip)


def _ephemeral_set(ip: str, username: str, password: str) -> float:
    expires_at = time.time() + _EPHEMERAL_TTL
    with _EPHEMERAL_LOCK:
        session_key = cctv_auth.session_key()
        session_count = sum(1 for (key, _ip) in _EPHEMERAL_CREDENTIALS if key == session_key)
        existing = (session_key, ip) in _EPHEMERAL_CREDENTIALS
        if not existing and session_count >= _EPHEMERAL_MAX_PER_SESSION:
            raise cctv_auth.fail(
                429, "RATE_LIMITED",
                "Phiên này đã lưu quá nhiều mật khẩu camera tạm thời.",
                details={"retry_after_seconds": 60},
                headers={"Retry-After": "60"},
            )
        _EPHEMERAL_CREDENTIALS[(session_key, ip)] = {
            "username": username, "password": password, "expires_at": expires_at,
        }
        now = time.time()
        for key, value in list(_EPHEMERAL_CREDENTIALS.items()):
            if now >= value.get("expires_at", 0):
                _EPHEMERAL_CREDENTIALS.pop(key, None)
    return expires_at


def _ephemeral_get(ip: str):
    key = _ephemeral_key(ip)
    with _EPHEMERAL_LOCK:
        value = _EPHEMERAL_CREDENTIALS.get(key)
        if not value:
            return None
        if time.time() >= value.get("expires_at", 0):
            _EPHEMERAL_CREDENTIALS.pop(key, None)
            return None
        return dict(value)


def _ephemeral_clear_session() -> None:
    session_key = cctv_auth.session_key()
    with _EPHEMERAL_LOCK:
        for key in [k for k in _EPHEMERAL_CREDENTIALS if k[0] == session_key]:
            _EPHEMERAL_CREDENTIALS.pop(key, None)


def _ephemeral_clear_ip(ip: str) -> None:
    with _EPHEMERAL_LOCK:
        for key in [k for k in _EPHEMERAL_CREDENTIALS if k[1] == ip]:
            _EPHEMERAL_CREDENTIALS.pop(key, None)


def _resolve_credentials(
    ip: str,
    *,
    body_username: str = "",
    body_password: str = "",
    prefer_body: bool = False,
) -> tuple[str, str]:
    """Thứ tự: body override -> managed -> credential tạm -> default_password."""
    if prefer_body and body_password:
        return (body_username.strip() or (managed_username(ip) or "admin")), body_password

    cam = _managed_by_ip(ip)
    if cam and str(cam.get("password") or "").strip():
        return (str(cam.get("username") or "admin").strip() or "admin"), str(cam["password"])

    ephemeral = _ephemeral_get(ip)
    if ephemeral and ephemeral.get("password"):
        return (ephemeral.get("username") or "admin"), ephemeral["password"]

    if not prefer_body and body_password:
        return (body_username.strip() or "admin"), body_password

    default_password = str(load_settings().get("default_password") or "").strip()
    if default_password:
        return "admin", default_password

    raise cctv_auth.fail(
        409, "CAMERA_CREDENTIAL_REQUIRED",
        "Chưa có mật khẩu cho camera này. Vui lòng nhập mật khẩu hoặc cấu hình mật khẩu mặc định.",
    )


def managed_username(ip: str) -> str:
    cam = _managed_by_ip(ip)
    return str((cam or {}).get("username") or "") if cam else ""


def _reject_password_query() -> None:
    for key in request.query.keys():
        if str(key).strip().lower() in {"password", "pwd", "pass"}:
            raise cctv_auth.fail(
                400, "PASSWORD_IN_QUERY_FORBIDDEN",
                "Không được gửi mật khẩu camera trong query string.",
            )


def _get_camera_rtsp_url(
    ip: str,
    username: str = "",
    password: str = "",
    subtype="1",
    channel=1,
) -> str:
    """Xây URL RTSP theo vendor/port/path của camera đã quản lý (không hardcode admin)."""
    vendor = "Dahua/Imou"
    rtsp_port = 554
    custom_path = ""
    cam = _managed_by_ip(ip)
    if cam:
        vendor = cam.get("vendor") or vendor
        try:
            rtsp_port = int(cam.get("rtsp_port") or 554)
        except (TypeError, ValueError):
            rtsp_port = 554
        custom_path = str(cam.get("rtsp_path") or "").strip()
        if not username:
            username = str(cam.get("username") or "admin")
    else:
        with _CACHED_DEVICES_LOCK:
            for device in CACHED_DEVICES:
                if device.get("ip") == ip:
                    vendor = device.get("vendor") or vendor
                    try:
                        rtsp_port = int(device.get("rtsp_port") or 554)
                    except (TypeError, ValueError):
                        rtsp_port = 554
                    break

    user_enc = urllib.parse.quote(username or "admin")
    pwd_enc = urllib.parse.quote(str(password or ""))
    subtype_int = 0 if str(subtype) in {"0", "main", "hd"} else 1
    try:
        channel_int = int(channel)
    except (TypeError, ValueError):
        channel_int = 1
    if channel_int <= 0:
        channel_int = 1

    if custom_path:
        path = custom_path if custom_path.startswith("/") else f"/{custom_path}"
        return f"rtsp://{user_enc}:{pwd_enc}@{ip}:{rtsp_port}{path}"

    vendor_lower = vendor.lower()
    if "hikvision" in vendor_lower or "ezviz" in vendor_lower:
        channel_part = f"{channel_int}01" if subtype_int == 0 else f"{channel_int}02"
        return f"rtsp://{user_enc}:{pwd_enc}@{ip}:{rtsp_port}/Streaming/Channels/{channel_part}"
    if "tapo" in vendor_lower or "tp-link" in vendor_lower:
        stream = "stream1" if subtype_int == 0 else "stream2"
        return f"rtsp://{user_enc}:{pwd_enc}@{ip}:{rtsp_port}/{stream}"
    if "uniview" in vendor_lower or "unv" in vendor_lower:
        variant = "s0" if subtype_int == 0 else "s1"
        return f"rtsp://{user_enc}:{pwd_enc}@{ip}:{rtsp_port}/unicast/c{channel_int}/{variant}/live"
    if "yoosee" in vendor_lower or "xiongmai" in vendor_lower or vendor_lower == "xm":
        return f"rtsp://{user_enc}:{pwd_enc}@{ip}:{rtsp_port}/onvif{channel_int}"
    return (
        f"rtsp://{user_enc}:{pwd_enc}@{ip}:{rtsp_port}"
        f"/cam/realmonitor?channel={channel_int}&subtype={subtype_int}"
    )


def _alarm_rtsp_url(ip: str, username: str, password: str) -> str:
    return _get_camera_rtsp_url(ip, username=username, password=password, subtype="0", channel=1)


# ==============================================================================
# Alarm manager + device monitoring
# ==============================================================================

def get_monitoring_devices() -> list:
    try:
        managed = load_managed_cameras()
        if managed:
            active = []
            for cam in managed:
                armed = cam.get("alarm_armed")
                if armed is None:
                    armed = cam.get("alarm_enabled", True)
                if bool(armed):
                    active.append(cam)
            return active
    except Exception:
        pass
    with _CACHED_DEVICES_LOCK:
        return [
            device for device in CACHED_DEVICES
            if bool(device.get("alarm_armed", device.get("alarm_enabled", True)))
        ]


ALARM_MANAGER = AlarmManager(
    settings_getter=load_settings,
    get_cached_devices=get_monitoring_devices,
    rtsp_url_builder=_alarm_rtsp_url,
)


def _sync_alarm_listeners() -> None:
    """Chỉ đồng bộ listener khi AlarmManager thực sự chạy (không trong test/disabled)."""
    if DISABLE_ALARMS or TEST_MODE:
        return
    try:
        ALARM_MANAGER.sync_listeners()
    except Exception as exc:
        print(f"[!] Lỗi sync_listeners: {exc}")


# ==============================================================================
# Auth manager + hooks
# ==============================================================================

def _build_allowed_hosts() -> set:
    hosts = {"localhost", "127.0.0.1", "::1"}
    try:
        hosts.add(socket.gethostname().strip().lower())
    except Exception:
        pass
    try:
        for address in get_local_interfaces():
            if address:
                hosts.add(str(address).strip().lower())
    except Exception:
        pass
    for item in (os.environ.get("CCTV_ALLOWED_HOSTS") or "").split(","):
        item = item.strip().lower()
        if item:
            hosts.add(item)
    return {h for h in hosts if h}


_AUTH_INIT_ERROR = ""
AUTH = None
try:
    AUTH = cctv_auth.AuthManager(
        settings_getter=lambda: _read_settings_file(strict=True),
        settings_saver=save_settings,
        bootstrap_file=BOOTSTRAP_FILE,
        test_mode=TEST_MODE,
    )
except cctv_auth.AuthStartupError as exc:
    _AUTH_INIT_ERROR = str(exc)
    print(f"[FATAL] Không thể khởi tạo lớp xác thực: {_AUTH_INIT_ERROR}")


if AUTH is not None:
    cctv_auth.configure(
        AUTH,
        cctv_auth.AccessPolicy(),
        allowed_hosts=_build_allowed_hosts(),
    )
    cctv_auth.install_hooks(bottle.app())
else:
    # Fail closed: nếu lớp xác thực không khởi tạo được, không phục vụ bất kỳ route nào.
    @bottle.hook("before_request")
    def _fail_closed_hook():
        raise cctv_auth.fail(
            503, "SETUP_REQUIRED",
            "Máy chủ chưa được cấu hình an toàn. Kiểm tra log khởi động.",
        )


# ==============================================================================
# Utility
# ==============================================================================

def J(**payload) -> str:
    response.content_type = "application/json; charset=utf-8"
    return json.dumps({"ok": True, **payload}, ensure_ascii=False)


def _now_str() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _iso(ts: float) -> str:
    return cctv_auth.now_iso(ts)


def _data() -> dict:
    return cctv_auth.json_body()


def _csv_safe(value) -> str:
    text = "" if value is None else str(value)
    if text and text[0] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + text
    return text


def _normalise_status(value) -> str:
    status = str(value or "").strip().lower().replace(" ", "_")
    return status if status in {"online", "offline", "auth_failed", "solar_sleep", "unknown"} else "unknown"


def _storage_dir(kind: str) -> str:
    key = "recordings_dir" if kind == "recordings" else "snapshots_dir"
    value = str(load_settings().get(key) or "").strip()
    fallback = RECORDINGS_DIR if kind == "recordings" else SNAPSHOTS_DIR
    return os.path.abspath(os.path.expanduser(value or fallback))


def _directory_writable(path: str) -> bool:
    try:
        return os.path.isdir(path) and os.access(path, os.W_OK)
    except Exception:
        return False


def _disk_free_bytes(path: str):
    try:
        return int(shutil.disk_usage(path).free)
    except Exception:
        return None


def _lan_ips() -> list:
    try:
        addresses = [str(ip) for ip in get_local_interfaces() if ip]
    except Exception:
        addresses = []
    lan = [ip for ip in addresses if not ip.startswith("127.") and not ip.startswith("10.0.3.")]
    return lan or [ip for ip in addresses if not ip.startswith("127.")]


def _request_scheme() -> str:
    return "https" if cctv_auth.request_is_https() else "http"


def _lan_url() -> str:
    host = request.headers.get("Host") or request.environ.get("HTTP_HOST") or ""
    if not host:
        ips = _lan_ips()
        host = f"{ips[0]}:{os.environ.get('CCTV_PORT', '8080')}" if ips else "localhost"
    return f"{_request_scheme()}://{host}"


def _validate_scan_expression(expression: str, max_hosts: int = 1024) -> list:
    """Chỉ private IPv4, tối đa 8 biểu thức, CIDR prefix >= /22, tổng host <= max."""
    if not isinstance(expression, str) or not expression.strip():
        return []
    parts = [part.strip() for part in expression.split(",") if part.strip()]
    if len(parts) > 8:
        raise cctv_auth.fail(400, "INVALID_SUBNET", "Chỉ cho phép tối đa 8 biểu thức mạng.")
    results: list[str] = []
    for part in parts:
        hosts: list[str] = []
        if "/" in part:
            try:
                network = ipaddress.ip_network(part, strict=False)
            except ValueError:
                raise cctv_auth.fail(400, "INVALID_SUBNET", f"CIDR không hợp lệ: {part}")
            if network.version != 4 or not isinstance(network, ipaddress.IPv4Network):
                raise cctv_auth.fail(400, "INVALID_SUBNET", "Chỉ hỗ trợ IPv4.")
            if not any(network.subnet_of(allowed) for allowed in _PRIVATE_NETS):
                raise cctv_auth.fail(400, "INVALID_SUBNET", "Chỉ cho phép dải mạng nội bộ (private).")
            if network.prefixlen < 22:
                raise cctv_auth.fail(400, "INVALID_SUBNET", "Dải mạng quá lớn (tối đa 1024 host).")
            if network.num_addresses - 2 > max_hosts:
                raise cctv_auth.fail(400, "INVALID_SUBNET", "Dải mạng quá lớn (tối đa 1024 host).")
            hosts = [str(host) for host in network.hosts()]
        elif "-" in part:
            start_text, end_text = part.split("-", 1)
            start_text, end_text = start_text.strip(), end_text.strip()
            if "." not in end_text:
                end_text = ".".join(start_text.split(".")[:-1]) + "." + end_text
            try:
                start_ip = ipaddress.IPv4Address(start_text)
                end_ip = ipaddress.IPv4Address(end_text)
            except ValueError:
                raise cctv_auth.fail(400, "INVALID_SUBNET", f"Dải IP không hợp lệ: {part}")
            if not _is_private_ip(start_ip) or not _is_private_ip(end_ip):
                raise cctv_auth.fail(400, "INVALID_SUBNET", "Chỉ cho phép dải IP nội bộ.")
            if end_ip < start_ip:
                raise cctv_auth.fail(400, "INVALID_SUBNET", "Dải IP có điểm cuối nhỏ hơn điểm đầu.")
            count = int(end_ip) - int(start_ip) + 1
            if count > max_hosts:
                raise cctv_auth.fail(400, "INVALID_SUBNET", "Dải IP quá lớn (tối đa 1024 host).")
            hosts = [str(ipaddress.IPv4Address(int(start_ip) + offset)) for offset in range(count)]
        else:
            try:
                address = ipaddress.IPv4Address(part)
            except ValueError:
                raise cctv_auth.fail(400, "INVALID_SUBNET", f"IP không hợp lệ: {part}")
            if not _is_private_ip(address):
                raise cctv_auth.fail(400, "INVALID_SUBNET", "Chỉ cho phép IP nội bộ.")
            hosts = [str(address)]
        results.extend(hosts)
        if len(results) > max_hosts:
            raise cctv_auth.fail(400, "INVALID_SUBNET", "Tổng số host vượt quá 1024.")
    seen = set()
    unique = []
    for ip in results:
        if ip not in seen:
            seen.add(ip)
            unique.append(ip)
    return unique


def _load_scan_fixture() -> list:
    candidates = [os.environ.get("CCTV_TEST_SCAN_FIXTURE") or ""]
    candidates.append(os.path.join(BASE_DIR, "tests", "fixtures", "scan_devices.json"))
    for path in candidates:
        if not path or not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
            if isinstance(payload, dict):
                devices = payload.get("devices") or payload.get("data") or []
            elif isinstance(payload, list):
                devices = payload
            else:
                devices = []
            if isinstance(devices, list):
                return [dict(item) for item in devices if isinstance(item, dict)]
        except Exception as exc:
            print(f"[!] Không đọc được scan fixture '{path}': {exc}")
    return []


def _public_device(device: dict) -> dict:
    return {key: value for key, value in device.items() if key not in ("raw_info", "password")}


# ==============================================================================
# Static / PWA
# ==============================================================================

_STATIC_EXTENSIONS = {
    ".css", ".js", ".png", ".jpg", ".jpeg", ".svg", ".ico", ".webp",
    ".woff2", ".woff", ".ttf", ".html",
}


_STATIC_MIMETYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
}


def _file_response(filepath: str, root: str, extensions: set,
                   download: str = "", mimetype=None):
    if not filepath or "\x00" in filepath:
        raise cctv_auth.fail(404, "NOT_FOUND", "Không tìm thấy tài nguyên.")
    normalised = filepath.replace("\\", "/")
    parts = [part for part in normalised.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." or part.startswith(".") for part in parts):
        raise cctv_auth.fail(404, "NOT_FOUND", "Không tìm thấy tài nguyên.")
    extension = os.path.splitext(normalised)[1].lower()
    if extension not in extensions:
        raise cctv_auth.fail(404, "NOT_FOUND", "Không tìm thấy tài nguyên.")
    root_real = os.path.realpath(root)
    target = os.path.realpath(os.path.join(root_real, *parts))
    if not (target == root_real or target.startswith(root_real + os.sep)):
        raise cctv_auth.fail(404, "NOT_FOUND", "Không tìm thấy tài nguyên.")
    if not os.path.isfile(target):
        raise cctv_auth.fail(404, "NOT_FOUND", "Không tìm thấy tài nguyên.")
    if mimetype is None:
        # MIME phải khớp extension: X-Content-Type-Options: nosniff khiến trình duyệt
        # chặn CSS/JS nếu máy chủ trả text/html.
        mimetype = _STATIC_MIMETYPES.get(extension, True)
    return static_file(normalised, root=root_real, download=download or None, mimetype=mimetype)


def _static_response(filepath: str, root: str):
    if os.path.splitext(filepath)[1].lower() == ".html" and filepath.replace("\\", "/") != "offline.html":
        raise cctv_auth.fail(404, "NOT_FOUND", "Không tìm thấy tài nguyên.")
    return _file_response(filepath, root, _STATIC_EXTENSIONS)


@route("/")
@cctv_auth.public
def index():
    index_file = os.path.join(TEMPLATES_DIR, "index.html")
    if not os.path.isfile(index_file):
        raise cctv_auth.fail(500, "INTERNAL_ERROR", "Chưa có giao diện index.html.")
    return static_file("index.html", root=TEMPLATES_DIR, mimetype="text/html")


@route("/static/<filepath:path>")
@cctv_auth.public
def server_static(filepath):
    return _static_response(filepath, STATIC_DIR)


@route("/manifest.json")
@cctv_auth.public
def pwa_manifest():
    result = _file_response("manifest.json", STATIC_DIR, {".json"},
                            mimetype="application/manifest+json")
    result.set_header("Content-Type", "application/manifest+json; charset=utf-8")
    return result


@route("/sw.js")
@cctv_auth.public
def service_worker():
    result = _static_response("sw.js", STATIC_DIR)
    result.set_header("Content-Type", "application/javascript; charset=utf-8")
    result.set_header("Service-Worker-Allowed", "/")
    return result


@route("/favicon.ico")
@cctv_auth.public
def favicon():
    return _static_response("favicon.ico", os.path.join(STATIC_DIR, "icons"))


@route("/download/app.apk")
@cctv_auth.require_role(cctv_auth.VIEWER)
def download_apk():
    if not os.path.isfile(APK_FILE):
        raise cctv_auth.fail(404, "APK_NOT_AVAILABLE", "Chưa có bản APK v2 để tải.")
    return static_file(
        os.path.basename(APK_FILE), root=os.path.dirname(APK_FILE),
        download=os.path.basename(APK_FILE),
        mimetype="application/vnd.android.package-archive",
    )


# ==============================================================================
# Auth routes
# ==============================================================================

@route("/api/auth/login", method="POST")
@cctv_auth.public
def api_auth_login():
    if AUTH is None:
        raise cctv_auth.fail(503, "SETUP_REQUIRED", "Máy chủ chưa được cấu hình an toàn.")
    data = cctv_auth.json_body(4096)
    username = str(data.get("username") or "").strip().lower()
    password = str(data.get("password") or "")
    if not username or not password:
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "Thiếu username hoặc password hợp lệ.")
    if len(username) > 64 or len(password) > 128:
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "Tên đăng nhập hoặc mật khẩu không hợp lệ.")

    client_ip = cctv_auth.get_client_ip()
    retry_after = max(
        AUTH.login_limiter.retry_after(client_ip, username),
        AUTH.login_attempt_limiter.retry_after(client_ip, username),
    )
    if retry_after > 0:
        AUTH.audit("rate_limited", endpoint="auth_login", client_ip=client_ip, username=username)
        raise cctv_auth.fail(
            429, "RATE_LIMITED", "Bạn đã thử đăng nhập quá nhiều lần. Vui lòng thử lại sau.",
            details={"retry_after_seconds": retry_after},
            headers={"Retry-After": str(retry_after)},
        )

    # Đếm cả lần đăng nhập thành công: chặn việc xoay vòng session liên tục
    # bằng credential hợp lệ (mỗi lần trước đây chỉ reset bucket lỗi).
    AUTH.login_attempt_limiter.record_attempt(client_ip, username)

    ok, reason = AUTH.verify(username, password)
    if reason == "viewer_disabled":
        raise cctv_auth.fail(403, "VIEWER_LOGIN_DISABLED", "Đăng nhập viewer chưa được bật.")
    if not ok:
        AUTH.login_limiter.record_failure(client_ip, username)
        AUTH.audit("login_failure", client_ip=client_ip, username=username, result="invalid")
        raise cctv_auth.fail(401, "INVALID_CREDENTIALS", "Tên đăng nhập hoặc mật khẩu không chính xác.")

    AUTH.login_limiter.record_success(client_ip, username)
    old_token = request.get_cookie(cctv_auth.SESSION_COOKIE) or ""
    try:
        token, csrf, record = AUTH.sessions.create(
            role=username,
            username=username,
            client_ip=client_ip,
            user_agent=request.headers.get("User-Agent") or "",
            old_token=old_token,
        )
    except cctv_auth.SessionLimitError:
        raise cctv_auth.fail(503, "SERVICE_UNAVAILABLE", "Hệ thống đã đạt giới hạn phiên đăng nhập.")

    cctv_auth.set_session_cookie(token, AUTH.session_ttl)
    AUTH.audit("login_success", client_ip=client_ip, username=username, role=username)
    return J(
        role=username,
        user={
            "username": username,
            "display_name": "Quản trị viên" if username == "admin" else "Người xem",
        },
        csrf_token=csrf,
        expires_at=_iso(record["expires_at"]),
        first_run=AUTH.first_run,
    )


@route("/api/auth/me")
@cctv_auth.public
def api_auth_me():
    if AUTH is None:
        raise cctv_auth.fail(503, "SETUP_REQUIRED", "Máy chủ chưa được cấu hình an toàn.")
    token = request.get_cookie(cctv_auth.SESSION_COOKIE)
    record = AUTH.sessions.get(token) if token else None
    if not record:
        if token:
            cctv_auth.clear_session_cookie()
        return J(
            authenticated=False,
            role=None,
            first_run=AUTH.first_run,
            viewer_login_enabled=AUTH.viewer_login_enabled,
            api_version=cctv_auth.API_VERSION,
            app_version=APP_VERSION,
        )
    csrf = AUTH.sessions.csrf_token_for(token)
    return J(
        authenticated=True,
        role=record.get("role"),
        user={
            "username": record.get("username"),
            "display_name": "Quản trị viên" if record.get("role") == "admin" else "Người xem",
        },
        csrf_token=csrf,
        expires_at=_iso(record.get("expires_at", 0)),
        first_run=AUTH.first_run,
        viewer_login_enabled=AUTH.viewer_login_enabled,
        api_version=cctv_auth.API_VERSION,
        app_version=APP_VERSION,
    )


@route("/api/auth/logout", method="POST")
@cctv_auth.require_role(cctv_auth.VIEWER)
def api_auth_logout():
    if AUTH is None:
        raise cctv_auth.fail(503, "SETUP_REQUIRED", "Máy chủ chưa được cấu hình an toàn.")
    _ephemeral_clear_session()
    token = request.get_cookie(cctv_auth.SESSION_COOKIE)
    AUTH.sessions.revoke(token)
    record = request.environ.get("cctv.session") or {}
    cctv_auth.clear_session_cookie()
    response.set_header("Clear-Site-Data", '"cache", "storage"')
    AUTH.audit("logout", client_ip=cctv_auth.get_client_ip(), username=record.get("username"))
    return J()


@route("/api/auth/change_password", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
@cctv_auth.rate_limit("change_password", 5, 900, scope="session")
def api_auth_change_password():
    if AUTH is None:
        raise cctv_auth.fail(503, "SETUP_REQUIRED", "Máy chủ chưa được cấu hình an toàn.")
    data = _data()
    target = str(data.get("target") or "admin").strip().lower()
    current_password = str(data.get("current_password") or "")
    if target not in ("admin", "viewer"):
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "target phải là admin hoặc viewer.")
    if SECRETS_FILE:
        raise cctv_auth.fail(
            409, "SECRETS_MANAGED_EXTERNALLY",
            "Mật khẩu đang được quản lý bởi CCTV_SECRETS_FILE (read-only). "
            "Hãy cập nhật file secret bên ngoài rồi khởi động lại máy chủ.",
        )
    if not current_password:
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "Thiếu mật khẩu hiện tại.")

    if target == "admin":
        new_password = str(data.get("new_password") or "").strip()
        ok, code, message, revoked = AUTH.change_admin_password(current_password, new_password)
    else:
        clear_viewer = bool(data.get("clear_viewer", False))
        new_password = str(data.get("new_password") or "").strip()
        ok, code, message, revoked = AUTH.set_viewer_password(current_password, new_password, clear=clear_viewer)

    if not ok:
        if code == "invalid_credentials":
            raise cctv_auth.fail(401, "INVALID_CREDENTIALS", message)
        raise cctv_auth.fail(400, "VALIDATION_ERROR", message)

    _ephemeral_clear_session()
    cctv_auth.clear_session_cookie()
    response.set_header("Clear-Site-Data", '"cache", "storage"')
    AUTH.audit("password_change", target=target, client_ip=cctv_auth.get_client_ip())
    return J(reauth_required=True, revoked_sessions=revoked)


# ==============================================================================
# Health / system status
# ==============================================================================

@route("/api/health")
@cctv_auth.public
def api_health():
    storage = {
        "recordings_writable": _directory_writable(_storage_dir("recordings")),
        "snapshots_writable": _directory_writable(_storage_dir("snapshots")),
    }
    ffmpeg_ok = bool(FFMPEG.get("available"))
    status = "ok" if ffmpeg_ok and storage["recordings_writable"] and storage["snapshots_writable"] else "degraded"
    alarm_info = {
        "running": False, "armed": False, "grace_remaining_seconds": 0,
    }
    if not DISABLE_ALARMS and ALARM_MANAGER is not None:
        try:
            alarm_info = {
                "running": bool(getattr(ALARM_MANAGER, "_running", False)),
                "armed": bool(ALARM_MANAGER.is_armed()),
                "grace_remaining_seconds": ALARM_MANAGER.grace_remaining_seconds(),
            }
        except Exception:
            pass
    return J(
        status=status,
        api_version=cctv_auth.API_VERSION,
        app_version=APP_VERSION,
        uptime_seconds=int(time.time() - APP_STARTED_AT),
        time=_iso(time.time()),
        ffmpeg={
            "available": ffmpeg_ok,
            "version": FFMPEG.get("version"),
            "audio_available": bool(FFMPEG.get("audio_available")),
        },
        tls=cctv_auth.request_is_https(),
        alarm=alarm_info,
        storage=storage,
        mode="test" if TEST_MODE else "production",
    )


@route("/api/system/status")
@cctv_auth.require_role(cctv_auth.VIEWER)
def api_system_status():
    role = _role()
    is_admin = role == cctv_auth.ADMIN
    managed = load_managed_cameras()
    counts = {"total": len(managed), "online": 0, "offline": 0,
              "auth_failed": 0, "solar_sleep": 0, "unknown": 0, "armed": 0}
    for cam in managed:
        counts[_normalise_status(cam.get("status"))] = counts.get(_normalise_status(cam.get("status")), 0) + 1
        armed = cam.get("alarm_armed")
        if armed is None:
            armed = cam.get("alarm_enabled", True)
        if armed:
            counts["armed"] += 1

    alarm_snapshot = {"watchdog": {"states": {}, "last_run": None}, "alerts": 0,
                      "today": 0, "last_at": None}
    grace_remaining = 0
    if ALARM_MANAGER is not None:
        try:
            alarm_status = ALARM_MANAGER.get_status()
            grace_remaining = int(alarm_status.get("startup_grace_remaining_seconds") or 0)
            history = ALARM_MANAGER.get_history()
            today_prefix = datetime.date.today().isoformat()
            storage_codes = {"StorageFailure", "StorageNotExist", "StorageLowSpace"}
            storage_alerts = sum(
                1 for item in history
                if str(item.get("code") or "") in storage_codes
                or "thẻ nhớ" in str(item.get("title") or "").lower()
            )
            alarm_snapshot = {
                "watchdog": alarm_status.get("storage_watchdog", {}),
                "alerts": len(history),
                "storage_alerts": storage_alerts,
                "history_count": len(history),
                "today": sum(1 for item in history
                             if str(item.get("timestamp", "")).startswith(today_prefix)),
                "last_at": history[0].get("timestamp") if history else None,
            }
        except Exception:
            pass

    config = {"viewer_login_enabled": bool(AUTH.viewer_login_enabled) if AUTH else False}
    if is_admin:
        settings = load_settings()
        default_password = str(settings.get("default_password") or "")
        config.update({
            "telegram_configured": bool(settings.get("telegram_bot_token") and settings.get("telegram_chat_id")),
            "default_password_set": bool(default_password),
            "default_password_is_weak": bool(default_password) and (
                len(default_password) < 8 or cctv_auth.is_common_password(default_password)
            ),
            "using_bootstrap_password": bool(AUTH.first_run) if AUTH else False,
        })

    warnings = []
    if not FFMPEG.get("available"):
        warnings.append({"code": "FFMPEG_MISSING", "severity": "critical",
                         "message": "FFmpeg chưa được cài hoặc không chạy được."})
    if not _directory_writable(_storage_dir("recordings")) or not _directory_writable(_storage_dir("snapshots")):
        warnings.append({"code": "STORAGE_UNWRITABLE", "severity": "critical",
                         "message": "Thư mục ghi hình hoặc snapshot không ghi được."})
    if not cctv_auth.request_is_https():
        warnings.append({"code": "HTTP_ONLY", "severity": "warning",
                         "message": "Kết nối đang dùng HTTP, không được mã hoá."})
    if grace_remaining > 0:
        warnings.append({"code": "ALARM_GRACE_ACTIVE", "severity": "info",
                         "message": f"Hệ thống cảnh báo đang trong thời gian chờ khởi động ({grace_remaining}s)."})
    if is_admin:
        if AUTH and AUTH.first_run:
            warnings.append({"code": "BOOTSTRAP_PASSWORD", "severity": "critical",
                             "message": "Đang dùng mật khẩu quản trị tạo tự động. Hãy đổi mật khẩu ngay."})
        if config.get("default_password_is_weak"):
            warnings.append({"code": "DEFAULT_PASSWORD_WEAK", "severity": "warning",
                             "message": "Mật khẩu camera mặc định chưa được đặt hoặc quá yếu."})
        if AUTH and not AUTH.viewer_login_enabled:
            warnings.append({"code": "VIEWER_DISABLED", "severity": "info",
                             "message": "Chưa đặt mật khẩu cho tài khoản người xem."})
        if not config.get("telegram_configured"):
            warnings.append({"code": "TELEGRAM_NOT_CONFIGURED", "severity": "info",
                             "message": "Chưa cấu hình Telegram để gửi cảnh báo."})

    payload = {
        "app": {
            "version": APP_VERSION,
            "api_version": cctv_auth.API_VERSION,
            "uptime_seconds": int(time.time() - APP_STARTED_AT),
            "mode": "test" if TEST_MODE else "production",
            "started_at": _iso(APP_STARTED_AT),
        },
        "health": {
            "status": "ok" if (
                FFMPEG.get("available")
                and _directory_writable(_storage_dir("recordings"))
                and _directory_writable(_storage_dir("snapshots"))
            ) else "degraded",
            "ffmpeg": {
                "available": bool(FFMPEG.get("available")),
                "version": FFMPEG.get("version"),
                "audio_available": bool(FFMPEG.get("audio_available")),
            },
            "tls": cctv_auth.request_is_https(),
        },
        "session": {
            "role": role,
            "expires_at": _iso((_session_record() or {}).get("expires_at", 0)),
        },
        "net": {"lan_url": _lan_url(), "lan_ips": _lan_ips()},
        "cameras": counts,
        "alerts": alarm_snapshot,
        "storage": {
            "watchdog": alarm_snapshot.get("watchdog", {}),
            "alerts": alarm_snapshot.get("storage_alerts", 0),
            "disk_free_bytes": _disk_free_bytes(_storage_dir("recordings")),
        },
        "config": config,
        "limits": {
            "max_mjpeg_streams": _env_int("CCTV_MAX_MJPEG_STREAMS", 12),
            "max_mjpeg_per_session": _env_int("CCTV_MAX_MJPEG_PER_SESSION", 9),
            "max_audio_streams": _env_int("CCTV_MAX_AUDIO_STREAMS", 4),
            "max_recordings": _env_int("CCTV_MAX_RECORDINGS", 2),
            "max_recording_seconds": _env_int("CCTV_MAX_RECORDING_SECONDS", 21600),
            "max_scan_hosts": 1024,
            "session_ttl_seconds": AUTH.session_ttl if AUTH else 0,
        },
        "warnings": warnings,
    }
    if is_admin:
        payload["runtime"] = {
            "python_version": sys.version.split()[0],
            "platform": f"{os.name}",
            "ffmpeg_path": FFMPEG.get("path") or None,
        }
    return J(**payload)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


# ==============================================================================
# Settings
# ==============================================================================

_REJECTED_SETTINGS_KEYS = {
    "admin_password", "admin_password_hash", "admin_password_bootstrap",
    "viewer_password", "viewer_password_hash", "viewer_password_hash_hash",
    "schema_version", "lan_ip", "lan_ips", "lan_url", "viewer_login_enabled",
}


def _validate_storage_dir(value) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Đường dẫn không được rỗng.")
    path = os.path.abspath(os.path.expanduser(value.strip()))
    if os.path.dirname(path) == path:
        raise ValueError("Không được trỏ tới thư mục gốc ổ đĩa.")
    roots = [BASE_DIR]
    for item in (os.environ.get("CCTV_ALLOWED_STORAGE_ROOTS") or "").split(","):
        item = item.strip()
        if item:
            roots.append(os.path.abspath(item))
    inside = any(path == root or path.startswith(root + os.sep) for root in roots)
    if not inside and not cctv_auth.env_bool("CCTV_ALLOW_EXTERNAL_STORAGE"):
        raise ValueError("Thư mục phải nằm trong dự án hoặc CCTV_ALLOWED_STORAGE_ROOTS.")
    try:
        os.makedirs(path, exist_ok=True)
        probe = os.path.join(path, f".cctv_write_test_{os.getpid()}")
        with open(probe, "wb") as handle:
            handle.write(b"x")
        os.remove(probe)
    except Exception as exc:
        raise ValueError(f"Thư mục không ghi được: {exc}")
    return path


def _validate_company_vlans(value) -> list:
    if not isinstance(value, list) or len(value) > 64:
        raise ValueError("company_vlans phải là mảng tối đa 64 phần tử.")
    result = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("Mỗi VLAN phải là object.")
        subnet = str(item.get("subnet") or "").strip()
        network = ipaddress.ip_network(subnet, strict=False)
        if network.version != 4 or not any(network.subnet_of(allowed) for allowed in _PRIVATE_NETS):
            raise ValueError("Subnet VLAN phải là IPv4 private.")
        label = str(item.get("label") or "").strip()
        if len(label) > 64:
            raise ValueError("Nhãn VLAN tối đa 64 ký tự.")
        result.append({
            "vlan": str(item.get("vlan") or "").strip()[:16],
            "subnet": str(network),
            "label": label,
        })
    return result


def _validate_settings_payload(data: dict) -> tuple[dict, dict]:
    """Trả ``(updates, remove_keys)`` hoặc raise 400."""
    updates: dict = {}
    remove_keys: list[str] = []
    errors: dict[str, str] = {}

    def check_bool(key):
        if key in data and not isinstance(data[key], bool):
            errors[key] = "Phải là true/false."

    def check_int(key, low, high):
        if key in data:
            try:
                value = int(data[key])
            except (TypeError, ValueError):
                errors[key] = "Phải là số nguyên."
                return
            if value < low or value > high:
                errors[key] = f"Phải trong khoảng {low}-{high}."
                return
            updates[key] = value

    def check_str(key, low, high):
        if key in data:
            value = data[key]
            if not isinstance(value, str) or not (low <= len(value) <= high):
                errors[key] = f"Phải là chuỗi {low}-{high} ký tự."
                return
            updates[key] = value.strip()

    unknown = [key for key in data.keys() if key not in _KNOWN_SETTINGS_KEYS]
    rejected = sorted(set(data.keys()) & _REJECTED_SETTINGS_KEYS)
    if rejected:
        raise cctv_auth.fail(
            400, "VALIDATION_ERROR", "Không được ghi các khóa xác thực qua API cài đặt.",
            details={"forbidden_keys": rejected},
        )
    if unknown:
        raise cctv_auth.fail(
            400, "VALIDATION_ERROR", "Có khóa cài đặt không hợp lệ.",
            details={"unknown_keys": unknown},
        )

    for key in ("deep_scan", "auto_reboot_on_ip_change", "telegram_enabled",
                "telegram_schedule_enabled", "telegram_ai_filter_human",
                "telegram_storage_alerts", "clear_telegram_bot_token",
                "clear_telegram_chat_id", "clear_default_password"):
        check_bool(key)

    if "scan_timeout" in data:
        try:
            value = float(data["scan_timeout"])
            if value < 1.0 or value > 10.0:
                raise ValueError
            updates["scan_timeout"] = value
        except (TypeError, ValueError):
            errors["scan_timeout"] = "Phải trong khoảng 1.0-10.0."

    for key in ("default_subnet", "last_subnets"):
        if key in data:
            value = data[key]
            if not isinstance(value, str) or len(value) > 500:
                errors[key] = "Tối đa 500 ký tự."
                continue
            try:
                _validate_scan_expression(value)
            except HTTPResponse:
                errors[key] = "Dải mạng không hợp lệ hoặc quá lớn."
                continue
            updates[key] = value.strip()

    if "selected_vlans" in data:
        value = data["selected_vlans"]
        if not isinstance(value, list) or len(value) > 20 or any(
            not isinstance(item, str) or len(item) > 64 for item in value
        ):
            errors["selected_vlans"] = "Tối đa 20 phần tử, mỗi phần tử <= 64 ký tự."
        else:
            updates["selected_vlans"] = [item.strip() for item in value]

    if "company_vlans" in data:
        try:
            updates["company_vlans"] = _validate_company_vlans(data["company_vlans"])
        except Exception as exc:
            errors["company_vlans"] = str(exc)

    for key in ("recordings_dir", "snapshots_dir"):
        if key in data:
            try:
                updates[key] = _validate_storage_dir(data[key])
            except ValueError as exc:
                errors[key] = str(exc)

    for key, low, high in (
        ("telegram_cooldown_seconds", 10, 3600),
        ("telegram_storage_check_interval", 5, 1440),
        ("alarm_startup_grace_seconds", 0, 600),
    ):
        check_int(key, low, high)

    for key in ("telegram_schedule_start", "telegram_schedule_end"):
        if key in data:
            value = data[key]
            if not isinstance(value, str) or not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", value):
                errors[key] = "Định dạng HH:MM (00:00-23:59)."
            else:
                updates[key] = value

    if "telegram_armed_cameras" in data:
        value = data["telegram_armed_cameras"]
        if not isinstance(value, list) or len(value) > 256:
            errors["telegram_armed_cameras"] = "Là mảng tối đa 256 phần tử."
        else:
            cleaned = []
            valid = True
            for item in value:
                if item == "*":
                    cleaned.append(item)
                    continue
                try:
                    cleaned.append(_validate_private_ip(item))
                except HTTPResponse:
                    valid = False
                    break
            if valid:
                updates["telegram_armed_cameras"] = cleaned
            else:
                errors["telegram_armed_cameras"] = "Chỉ chấp nhận '*' hoặc IPv4 private."

    for key, low, high in (
        ("telegram_bot_token", 1, 256),
        ("telegram_chat_id", 1, 64),
        ("default_password", cctv_auth.CAMERA_PASSWORD_MIN, cctv_auth.CAMERA_PASSWORD_MAX),
    ):
        if key in data:
            value = data[key]
            if not isinstance(value, str) or len(value) > high:
                errors[key] = f"Tối đa {high} ký tự."
            elif value == "":
                continue  # rỗng = giữ nguyên
            elif len(value) < low:
                errors[key] = f"Tối thiểu {low} ký tự."
            else:
                updates[key] = value

    if data.get("clear_telegram_bot_token"):
        remove_keys.append("telegram_bot_token")
    if data.get("clear_telegram_chat_id"):
        remove_keys.append("telegram_chat_id")
    if data.get("clear_default_password"):
        remove_keys.append("default_password")

    # Chỉ lưu các key boolean hợp lệ.
    for key in ("deep_scan", "auto_reboot_on_ip_change", "telegram_enabled",
                "telegram_schedule_enabled", "telegram_ai_filter_human",
                "telegram_storage_alerts"):
        if key in data and key not in errors and isinstance(data[key], bool):
            updates[key] = data[key]

    for key in ("clear_telegram_bot_token", "clear_telegram_chat_id", "clear_default_password"):
        updates.pop(key, None)
        if key in data and not isinstance(data[key], bool):
            pass

    if errors:
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "Dữ liệu cài đặt không hợp lệ.",
                             details={"fields": errors})
    return updates, remove_keys


_KNOWN_SETTINGS_KEYS = {
    "scan_timeout", "default_subnet", "last_subnets", "selected_vlans", "company_vlans",
    "deep_scan", "recordings_dir", "snapshots_dir", "auto_reboot_on_ip_change",
    "telegram_enabled", "telegram_schedule_enabled", "telegram_schedule_start",
    "telegram_schedule_end", "telegram_cooldown_seconds", "telegram_ai_filter_human",
    "telegram_armed_cameras", "telegram_storage_alerts", "telegram_storage_check_interval",
    "alarm_startup_grace_seconds", "telegram_bot_token", "telegram_chat_id",
    "default_password", "clear_telegram_bot_token", "clear_telegram_chat_id",
    "clear_default_password",
}


def _sanitize_settings(settings: dict) -> dict:
    secret_keys = {
        "default_password", "telegram_bot_token", "telegram_chat_id",
        "admin_password", "admin_password_hash", "viewer_password",
        "viewer_password_hash", "admin_password_bootstrap",
    }
    output = {key: value for key, value in settings.items() if key not in secret_keys}
    output["lan_ip"] = (_lan_ips() or ["127.0.0.1"])[0]
    output["lan_ips"] = _lan_ips()
    output["lan_url"] = _lan_url()
    output["viewer_login_enabled"] = bool(AUTH.viewer_login_enabled) if AUTH else False
    return output


@route("/api/settings", method="GET")
@cctv_auth.require_role(cctv_auth.ADMIN)
def api_get_settings():
    settings = load_settings()
    return J(
        schema_version=2,
        settings=_sanitize_settings(settings),
        secrets={
            "default_password_set": bool(str(settings.get("default_password") or "").strip()),
            "telegram_bot_token_set": bool(str(settings.get("telegram_bot_token") or "").strip()),
            "telegram_chat_id_set": bool(str(settings.get("telegram_chat_id") or "").strip()),
        },
        secrets_managed_externally=bool(SECRETS_FILE),
    )


@route("/api/settings", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
@cctv_auth.rate_limit("settings_save", 10, 60, scope="session")
def api_save_settings():
    data = cctv_auth.json_body(64 * 1024)
    updates, remove_keys = _validate_settings_payload(data)
    if SECRETS_FILE and (
        _SECRET_SETTINGS_KEYS & set(updates or {})
        or _SECRET_SETTINGS_KEYS & set(remove_keys or [])
    ):
        raise cctv_auth.fail(
            409, "SECRETS_MANAGED_EXTERNALLY",
            "Secret đang được quản lý bởi CCTV_SECRETS_FILE (read-only). "
            "Hãy sửa file secret bên ngoài rồi khởi động lại máy chủ.",
        )
    if not save_settings(updates, remove_keys):
        raise cctv_auth.fail(500, "INTERNAL_ERROR", "Không thể lưu file cấu hình.")
    try:
        _sync_alarm_listeners()
    except Exception as exc:
        print(f"[!] Lỗi sync_listeners sau lưu cài đặt: {exc}")
    if AUTH:
        AUTH.audit("settings_update", client_ip=cctv_auth.get_client_ip(),
                   keys=sorted(updates.keys()))
    return J(settings=_sanitize_settings(load_settings()), message="Đã lưu cài đặt.")


@route("/api/settings/open-folder", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
def api_open_folder():
    _test_mode_block("Không mở thư mục trong chế độ kiểm thử.")
    data = _data()
    folder_type = str(data.get("folder") or "recordings").strip().lower()
    if folder_type not in ("recordings", "snapshots"):
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "folder phải là recordings hoặc snapshots.")
    target_dir = _storage_dir(folder_type)
    os.makedirs(target_dir, exist_ok=True)
    try:
        if sys.platform == "win32":
            os.startfile(target_dir)  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", target_dir], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            subprocess.Popen(["xdg-open", target_dir], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as exc:
        raise cctv_auth.fail(500, "INTERNAL_ERROR", f"Không mở được thư mục: {exc}")
    return J(folder=folder_type, path=target_dir, message="Đã mở thư mục.")


# ==============================================================================
# Scan / export
# ==============================================================================

@route("/api/scan", method="GET")
@cctv_auth.require_role(cctv_auth.ADMIN)
@cctv_auth.rate_limit("scan", 6, 60, scope="ip")
def api_scan():
    global CACHED_DEVICES
    started = time.time()
    subnet_param = (request.query.get("subnet") or "").strip()
    if len(subnet_param) > 500:
        raise cctv_auth.fail(400, "INVALID_SUBNET", "Chuỗi subnet tối đa 500 ký tự.")
    deep_param = (request.query.get("deep") or ("1" if load_settings().get("deep_scan", True) else "0")) == "1"
    model_param = (request.query.get("model") or "").strip().lower()
    if len(model_param) > 64:
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "Bộ lọc model tối đa 64 ký tự.")

    if subnet_param:
        targets = _validate_scan_expression(subnet_param)
    else:
        targets = _validate_scan_expression(str(load_settings().get("last_subnets") or ""))

    if TEST_MODE:
        devices = _load_scan_fixture()
        if not devices:
            raise cctv_auth.fail(
                503, "TEST_MODE_BLOCKED",
                "Chế độ kiểm thử không có fixture quét mạng (CCTV_TEST_SCAN_FIXTURE).",
            )
    else:
        if not _SCAN_LOCK.acquire(blocking=False):
            raise cctv_auth.fail(409, "SCAN_IN_PROGRESS", "Đang có một lượt quét mạng chạy.")
        try:
            try:
                devices = scan_devices(
                    timeout=float(load_settings().get("scan_timeout", 2.5)),
                    deep_scan=deep_param,
                    custom_targets=targets or None,
                    verbose=False,
                )
            except Exception as exc:
                print(f"[!] Lỗi quét mạng: {exc}")
                raise cctv_auth.fail(500, "INTERNAL_ERROR", "Lỗi khi quét mạng.")
        finally:
            _SCAN_LOCK.release()

    try:
        devices.sort(key=lambda item: [int(part) for part in str(item.get("ip", "")).split(".")])
    except Exception:
        pass

    with _CACHED_DEVICES_LOCK:
        CACHED_DEVICES = [dict(device) for device in devices]
    try:
        if not DISABLE_ALARMS:
            _sync_alarm_listeners()
    except Exception as exc:
        print(f"[!] Lỗi sync_listeners sau scan: {exc}")

    if model_param:
        devices = [
            item for item in devices
            if model_param in str(item.get("model", "")).lower()
            or model_param in str(item.get("name", "")).lower()
        ]
    clean = [_public_device(device) for device in devices]
    return J(
        count=len(clean),
        devices=clean,
        scanned_at=_iso(time.time()),
        duration_ms=int((time.time() - started) * 1000),
        targets=len(targets),
        truncated=False,
    )


@route("/api/scan/vlans", method="GET")
@cctv_auth.require_role(cctv_auth.ADMIN)
@cctv_auth.rate_limit("scan_vlans", 6, 60, scope="ip")
def api_scan_vlans():
    # Danh mục VLAN là cấu hình theo môi trường (settings.company_vlans),
    # không còn hardcode label/IP nội bộ trong source phát hành.
    configured = load_settings().get("company_vlans") or []
    if TEST_MODE:
        vlans = [{
            "vlan": str(item.get("vlan") or ""),
            "subnet": str(item.get("subnet") or ""),
            "label": str(item.get("label") or ""),
            "gateway": None,
            "is_up": True,
        } for item in configured if isinstance(item, dict)]
    else:
        try:
            raw_vlans = detect_company_vlans(configured) or []
        except Exception:
            raw_vlans = []
        vlans = [{
            "vlan": str(item.get("vlan") or ""),
            "subnet": str(item.get("subnet") or ""),
            "label": str(item.get("label") or ""),
            "gateway": item.get("gateway"),
            "is_up": bool(item.get("is_up", True)),
        } for item in raw_vlans]
    active = [item["subnet"] for item in vlans if item.get("is_up") and item.get("subnet")]
    return J(
        vlans=vlans,
        all_subnets_str=", ".join(active),
        count=len(vlans),
        scanned_at=_iso(time.time()),
    )


@route("/api/export", method="GET")
@cctv_auth.require_role(cctv_auth.ADMIN)
def api_export():
    with _CACHED_DEVICES_LOCK:
        devices = [dict(device) for device in CACHED_DEVICES]
    output = io.StringIO()
    output.write("\ufeff")
    columns = [
        ("ip", "Địa chỉ IP"), ("name", "Tên thiết bị"), ("model", "Model"),
        ("class", "Loại thiết bị"), ("mac", "Địa chỉ MAC"), ("serial", "Serial Number"),
        ("http_port", "Cổng HTTP"), ("tcp_port", "Cổng TCP"), ("gateway", "Gateway"),
        ("netmask", "Subnet Mask"), ("dhcp", "Chế độ IP"), ("firmware", "Phiên bản Firmware"),
    ]
    writer = csv.writer(output)
    writer.writerow([label for _, label in columns])
    for device in devices:
        writer.writerow([_csv_safe(device.get(key, "")) for key, _ in columns])
    filename = f"cctv_cameras_{datetime.datetime.now().strftime('%Y%m%d_%H%M')}.csv"
    result = HTTPResponse(body=output.getvalue().encode("utf-8"))
    result.set_header("Content-Type", "text/csv; charset=utf-8")
    result.set_header("Content-Disposition", f"attachment; filename={filename}")
    return result


# ==============================================================================
# Stream / snapshot / recording
# ==============================================================================

class _SlotCounter:
    def __init__(self, max_total: int, max_per_key: int = 0):
        self.max_total = max_total
        self.max_per_key = max_per_key
        self._total = 0
        self._per_key: dict[str, int] = {}
        self._lock = threading.Lock()

    def acquire(self, key: str) -> bool:
        with self._lock:
            if self._total >= self.max_total:
                return False
            if self.max_per_key and self._per_key.get(key, 0) >= self.max_per_key:
                return False
            self._total += 1
            self._per_key[key] = self._per_key.get(key, 0) + 1
            return True

    def release(self, key: str) -> None:
        with self._lock:
            self._total = max(0, self._total - 1)
            if key in self._per_key:
                self._per_key[key] -= 1
                if self._per_key[key] <= 0:
                    self._per_key.pop(key, None)


MJPEG_SLOTS = _SlotCounter(_env_int("CCTV_MAX_MJPEG_STREAMS", 12), _env_int("CCTV_MAX_MJPEG_PER_SESSION", 9))
AUDIO_SLOTS = _SlotCounter(_env_int("CCTV_MAX_AUDIO_STREAMS", 4), 1)


def _stream_response(cmd: list, mimetype: str, boundary: str, slot_key: str,
                     slots: _SlotCounter) -> HTTPResponse:
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0,
        )
    except Exception as exc:
        slots.release(slot_key)
        print(f"[!] Không khởi động được FFmpeg: {exc}")
        raise cctv_auth.fail(503, "FFMPEG_UNAVAILABLE", "Không khởi động được FFmpeg.")

    def generator():
        try:
            while True:
                chunk = proc.stdout.read(4096)
                if not chunk:
                    break
                yield chunk
        finally:
            try:
                proc.terminate()
                proc.wait(timeout=0.5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            slots.release(slot_key)

    result = HTTPResponse(body=generator())
    result.set_header("Content-Type", mimetype)
    result.set_header("Cache-Control", "no-cache, no-store, must-revalidate")
    result.set_header("Pragma", "no-cache")
    result.set_header("Expires", "0")
    return result


@route("/api/stream/mjpeg", method="GET")
@cctv_auth.require_role(cctv_auth.VIEWER)
def api_stream_mjpeg():
    _reject_password_query()
    ip = _scope_target(request.query.get("ip", ""), _role())
    subtype = (request.query.get("subtype") or "1").strip()
    channel = (request.query.get("channel") or "1").strip()
    username, password = _resolve_credentials(ip)
    _ffmpeg_required("video")
    _test_mode_block("Không mở luồng camera trong chế độ kiểm thử.")
    slot_key = cctv_auth.session_key()
    if not MJPEG_SLOTS.acquire(slot_key):
        raise cctv_auth.fail(429, "TOO_MANY_STREAMS", "Đã đạt giới hạn số luồng MJPEG.",
                             details={"retry_after_seconds": 5},
                             headers={"Retry-After": "5"})
    rtsp_url = _get_camera_rtsp_url(ip, username=username, password=password,
                                    subtype=subtype, channel=channel)
    cmd = [
        _ffmpeg_bin(), "-fflags", "nobuffer", "-flags", "low_delay",
        "-rtsp_transport", "tcp", "-i", rtsp_url, "-an",
        "-c:v", "mjpeg", "-q:v", "5", "-r", "20", "-f", "mpjpeg", "pipe:1",
    ]
    return _stream_response(cmd, "multipart/x-mixed-replace; boundary=ffmpeg",
                            "ffmpeg", slot_key, MJPEG_SLOTS)


@route("/api/stream/audio", method="GET")
@cctv_auth.require_role(cctv_auth.VIEWER)
def api_stream_audio():
    _reject_password_query()
    ip = _scope_target(request.query.get("ip", ""), _role())
    subtype = (request.query.get("subtype") or "1").strip()
    channel = (request.query.get("channel") or "1").strip()
    username, password = _resolve_credentials(ip)
    _ffmpeg_required("audio")
    _test_mode_block("Không mở luồng camera trong chế độ kiểm thử.")
    slot_key = cctv_auth.session_key()
    if not AUDIO_SLOTS.acquire(slot_key):
        raise cctv_auth.fail(429, "TOO_MANY_STREAMS", "Đã đạt giới hạn số luồng audio.",
                             details={"retry_after_seconds": 5},
                             headers={"Retry-After": "5"})
    rtsp_url = _get_camera_rtsp_url(ip, username=username, password=password,
                                    subtype=subtype, channel=channel)
    cmd = [
        _ffmpeg_bin(), "-fflags", "nobuffer", "-flags", "low_delay",
        "-rtsp_transport", "tcp", "-i", rtsp_url, "-vn", "-af", "volume=2.5",
        "-c:a", "libmp3lame", "-b:a", "64k", "-ar", "22050",
        "-flush_packets", "1", "-f", "mp3", "pipe:1",
    ]
    return _stream_response(cmd, "audio/mpeg", "audio", slot_key, AUDIO_SLOTS)


@route("/api/snapshot", method="GET")
@cctv_auth.require_role(cctv_auth.VIEWER)
@cctv_auth.rate_limit("snapshot", 30, 60, scope="session")
def api_snapshot():
    _reject_password_query()
    ip = _scope_target(request.query.get("ip", ""), _role())
    subtype = (request.query.get("subtype") or "0").strip()
    channel = (request.query.get("channel") or "1").strip()
    username, password = _resolve_credentials(ip)
    _ffmpeg_required("video")
    _test_mode_block("Không chụp ảnh camera trong chế độ kiểm thử.")
    image = _capture_snapshot(ip, username, password, subtype=subtype, channel=channel)
    if not image:
        raise cctv_auth.fail(502, "CAMERA_OPERATION_FAILED", "Không lấy được hình ảnh từ camera.")

    now_str = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"snapshot_{ip}_{now_str}_{secrets.token_hex(3)}.jpg"
    target_dir = _storage_dir("snapshots")
    try:
        os.makedirs(target_dir, exist_ok=True)
        with open(os.path.join(target_dir, filename), "wb") as handle:
            handle.write(image)
    except Exception as exc:
        print(f"[!] Không lưu được snapshot: {exc}")

    result = HTTPResponse(body=image)
    result.set_header("Content-Type", "image/jpeg")
    result.set_header("Content-Disposition", f'inline; filename="{filename}"')
    result.set_header("X-Snapshot-Filename", filename)
    return result


def _capture_snapshot(ip: str, username: str, password: str,
                      subtype: str = "0", channel="1", timeout: float = 5.0):
    if not FFMPEG.get("available"):
        return None
    rtsp_url = _get_camera_rtsp_url(ip, username=username, password=password,
                                    subtype=subtype, channel=channel)
    cmd = [
        _ffmpeg_bin(), "-rtsp_transport", "tcp", "-i", rtsp_url,
        "-vframes", "1", "-q:v", "2", "-f", "image2", "pipe:1",
    ]
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              timeout=timeout)
        if proc.returncode == 0 and proc.stdout:
            return proc.stdout
    except Exception:
        pass
    return None


# -- recordings ----------------------------------------------------------------

ACTIVE_RECORDINGS: dict[tuple[str, int], dict] = {}
RECORDINGS_LOCK = threading.RLock()
MAX_RECORDINGS = _env_int("CCTV_MAX_RECORDINGS", 2)
MAX_RECORDING_SECONDS = _env_int("CCTV_MAX_RECORDING_SECONDS", 21600)


def _recording_key(ip: str, channel: int) -> tuple[str, int]:
    return (ip, int(channel))


def _stop_recording_entry(rec: dict) -> None:
    try:
        rec["stop_event"].set()
    except Exception:
        pass
    try:
        proc = rec["proc"]
        proc.terminate()
        proc.wait(timeout=2.0)
    except Exception:
        try:
            rec["proc"].kill()
        except Exception:
            pass


def _recording_guard(key: tuple[str, int], rec: dict) -> None:
    try:
        rec["stop_event"].wait(MAX_RECORDING_SECONDS)
    except Exception:
        pass
    with RECORDINGS_LOCK:
        current = ACTIVE_RECORDINGS.get(key)
        if current is rec:
            ACTIVE_RECORDINGS.pop(key, None)
            _stop_recording_entry(rec)


@route("/api/record/start", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
@cctv_auth.rate_limit("record_start", 6, 60, scope="session")
def api_record_start():
    _test_mode_block("Không ghi hình trong chế độ kiểm thử.")
    data = _data()
    ip = _scope_target(data.get("ip", ""), _role())
    subtype = str(data.get("subtype") or "0").strip()
    try:
        channel = int(data.get("channel", 1))
    except (TypeError, ValueError):
        channel = 1
    if channel not in (1, 2):
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "channel phải là 1 hoặc 2.")
    _ffmpeg_required("video")
    username, password = _resolve_credentials(ip)
    key = _recording_key(ip, channel)
    with RECORDINGS_LOCK:
        existing = ACTIVE_RECORDINGS.get(key)
        if existing:
            raise cctv_auth.fail(
                409, "ALREADY_RECORDING", "Camera này đang được ghi hình.",
                details={"filename": existing.get("filename")},
            )
        if len(ACTIVE_RECORDINGS) >= MAX_RECORDINGS:
            raise cctv_auth.fail(429, "TOO_MANY_STREAMS", "Đã đạt giới hạn số bản ghi đồng thời.",
                                 details={"retry_after_seconds": 10},
                                 headers={"Retry-After": "10"})
        now_str = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"rec_{ip}_c{channel}_{now_str}_{secrets.token_hex(3)}.mp4"
        target_dir = _storage_dir("recordings")
        os.makedirs(target_dir, exist_ok=True)
        filepath = os.path.join(target_dir, filename)
        rtsp_url = _get_camera_rtsp_url(ip, username=username, password=password,
                                        subtype=subtype, channel=channel)
        cmd = [
            _ffmpeg_bin(), "-y", "-rtsp_transport", "tcp", "-i", rtsp_url,
            "-c", "copy", "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
            filepath,
        ]
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as exc:
            print(f"[!] Không khởi động được ghi hình: {exc}")
            raise cctv_auth.fail(503, "FFMPEG_UNAVAILABLE", "Không khởi động được FFmpeg.")
        rec = {
            "proc": proc, "filename": filename, "filepath": filepath,
            "start_time": time.time(), "ip": ip, "channel": channel,
            "started_at": now_str, "stop_event": threading.Event(),
        }
        ACTIVE_RECORDINGS[key] = rec
    threading.Thread(target=_recording_guard, args=(key, rec), daemon=True,
                     name=f"RecordGuard-{ip}-{channel}").start()
    return J(
        recording=True, filename=filename, ip=ip, channel=channel,
        started_at=now_str, max_duration_seconds=MAX_RECORDING_SECONDS,
    )


@route("/api/record/stop", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
def api_record_stop():
    _test_mode_block("Không ghi hình trong chế độ kiểm thử.")
    data = _data()
    ip = _validate_private_ip(data.get("ip", ""))
    try:
        channel = int(data.get("channel", 1))
    except (TypeError, ValueError):
        channel = 1
    key = _recording_key(ip, channel)
    with RECORDINGS_LOCK:
        rec = ACTIVE_RECORDINGS.pop(key, None)
    if not rec:
        raise cctv_auth.fail(404, "NOT_RECORDING", "Camera này hiện không ghi hình.")
    _stop_recording_entry(rec)
    duration = round(time.time() - rec["start_time"], 1)
    file_size = os.path.getsize(rec["filepath"]) if os.path.exists(rec["filepath"]) else 0
    return J(
        recording=False,
        filename=rec["filename"],
        download_url=f"/api/recordings/{rec['filename']}",
        duration_seconds=duration,
        file_size=file_size,
        ip=ip,
        channel=channel,
    )


@route("/api/record/status", method="GET")
@cctv_auth.require_role(cctv_auth.VIEWER)
def api_record_status():
    ip = (request.query.get("ip") or "").strip()
    channel_raw = (request.query.get("channel") or "1").strip()
    try:
        channel = int(channel_raw)
    except ValueError:
        channel = 1
    if ip:
        ip = _scope_target(ip, _role())
        with RECORDINGS_LOCK:
            rec = ACTIVE_RECORDINGS.get(_recording_key(ip, channel))
            if rec:
                return J(
                    is_recording=True,
                    duration=round(time.time() - rec["start_time"]),
                    filename=rec["filename"],
                    channel=channel,
                    started_at=rec["started_at"],
                    max_duration_seconds=MAX_RECORDING_SECONDS,
                )
            return J(is_recording=False, duration=0, filename="", channel=channel,
                     max_duration_seconds=MAX_RECORDING_SECONDS)
    with RECORDINGS_LOCK:
        recordings = [{
            "ip": rec["ip"],
            "channel": rec["channel"],
            "filename": rec["filename"],
            "duration": round(time.time() - rec["start_time"]),
            "started_at": rec["started_at"],
        } for rec in ACTIVE_RECORDINGS.values()]
    return J(recordings=recordings)


@route("/api/recordings/<filename>", method="GET")
@cctv_auth.require_role(cctv_auth.VIEWER)
def api_serve_recording(filename):
    if not re.match(r"^[A-Za-z0-9_.-]+\.mp4$", filename or ""):
        raise cctv_auth.fail(404, "NOT_FOUND", "Không tìm thấy bản ghi.")
    download = (request.query.get("download") or "0") == "1"
    return _file_response(
        filename, _storage_dir("recordings"), {".mp4"},
        download=filename if download else "", mimetype="video/mp4",
    )


@route("/snapshots/<filepath:path>")
@cctv_auth.require_role(cctv_auth.VIEWER)
def serve_snapshot(filepath):
    extension = os.path.splitext(filepath)[1].lower()
    if extension not in (".jpg", ".jpeg", ".png"):
        raise cctv_auth.fail(404, "NOT_FOUND", "Không tìm thấy ảnh.")
    return _file_response(filepath, _storage_dir("snapshots"), {".jpg", ".jpeg", ".png"})


# ==============================================================================
# External player
# ==============================================================================

def _find_player() -> tuple[str, str]:
    mpv_path = shutil.which("mpv")
    if mpv_path:
        return "mpv", mpv_path
    vlc_path = shutil.which("vlc")
    if sys.platform == "win32" and not vlc_path:
        for candidate in (
            r"C:\Program Files\VideoLAN\VLC\vlc.exe",
            r"C:\Program Files (x86)\VideoLAN\VLC\vlc.exe",
        ):
            if os.path.exists(candidate):
                vlc_path = candidate
                break
    if vlc_path:
        return "vlc", vlc_path
    return "", ""


@route("/api/stream/open", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
@cctv_auth.rate_limit("stream_open", 3, 60, scope="session")
def api_stream_open():
    _test_mode_block("Không mở trình phát ngoài trong chế độ kiểm thử.")
    data = _data()
    if "rtsp_url" in data:
        raise cctv_auth.fail(400, "RTSP_URL_FORBIDDEN", "Không được gửi rtsp_url trực tiếp.")
    ip = _scope_target(data.get("ip", ""), _role())
    try:
        channel = int(data.get("channel", 1))
    except (TypeError, ValueError):
        channel = 1
    camera_name = _clean_text(data.get("name") or ip, 80)
    player_name, player_path = _find_player()
    if not player_path:
        raise cctv_auth.fail(503, "PLAYER_NOT_AVAILABLE", "Không tìm thấy mpv hoặc VLC trên máy chủ.")
    username, password = _resolve_credentials(ip)
    rtsp_url = _get_camera_rtsp_url(ip, username=username, password=password,
                                    subtype="0", channel=channel)

    def launch():
        env = os.environ.copy()
        if sys.platform != "win32" and "DISPLAY" not in env:
            env["DISPLAY"] = ":0"
        try:
            if player_name == "mpv":
                cmd = [player_path, "--profile=low-latency",
                       f"--title=CCTV Vision Hub - {camera_name}",
                       "--geometry=960x540", "--", rtsp_url]
            else:
                cmd = [player_path, "--network-caching=300",
                       f"--meta-title=CCTV Vision Hub - {camera_name}", "--", rtsp_url]
            subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as exc:
            print(f"[!] Không mở được trình phát: {exc}")

    threading.Thread(target=launch, daemon=True).start()
    return J(player=player_name, message="Đã khởi chạy trình phát video.")


# ==============================================================================
# PTZ
# ==============================================================================

_PTZ_ACTIONS = {
    "stop", "up", "down", "left", "right", "stepup", "stepdown",
    "stepleft", "stepright", "setpreset", "gotopreset", "clearpreset",
}
_PTZ_CANONICAL = {
    "stop": "Stop", "up": "Up", "down": "Down", "left": "Left", "right": "Right",
    "stepup": "StepUp", "stepdown": "StepDown", "stepleft": "StepLeft",
    "stepright": "StepRight", "setpreset": "SetPreset",
    "gotopreset": "GotoPreset", "clearpreset": "ClearPreset",
}


@route("/api/ptz", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
@cctv_auth.rate_limit("ptz", 10, 1, scope="session")
def api_ptz():
    _test_mode_block("Không điều khiển PTZ trong chế độ kiểm thử.")
    data = _data()
    ip = _scope_target(data.get("ip", ""), _role())
    raw_action = str(data.get("action") or "Stop").strip()
    if raw_action.lower() not in _PTZ_ACTIONS:
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "Hành động PTZ không được hỗ trợ.")
    action = _PTZ_CANONICAL[raw_action.lower()]
    try:
        speed = int(data.get("speed", 5))
    except (TypeError, ValueError):
        speed = 5
    speed = max(1, min(8, speed))
    preset = data.get("preset")
    if action in ("SetPreset", "GotoPreset", "ClearPreset"):
        try:
            preset = int(preset)
        except (TypeError, ValueError):
            raise cctv_auth.fail(400, "VALIDATION_ERROR", "Preset phải là số từ 1 đến 8.")
        if preset < 1 or preset > 8:
            raise cctv_auth.fail(400, "VALIDATION_ERROR", "Preset phải là số từ 1 đến 8.")
    else:
        preset = None
    username, password = _resolve_credentials(ip)
    result = ptz_command(ip=ip, username=username, password=password,
                         action=action, speed=speed, preset=preset)
    if not isinstance(result, dict) or not result.get("ok"):
        message = cctv_auth.redact_text(str((result or {}).get("error") or "Camera không phản hồi."))
        raise cctv_auth.fail(502, "CAMERA_OPERATION_FAILED", message)
    payload = {key: value for key, value in result.items() if key != "ok"}
    return J(**payload)


# ==============================================================================
# Batch actions
# ==============================================================================

def _require_confirm(data: dict) -> None:
    if data.get("confirm") is not True:
        raise cctv_auth.fail(400, "CONFIRMATION_REQUIRED", "Thiếu xác nhận (confirm=true) cho thao tác này.")


def _validate_ip_list(value, max_items: int = 100) -> list:
    if not isinstance(value, list) or not value:
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "Danh sách IP không được rỗng.")
    if len(value) > max_items:
        raise cctv_auth.fail(400, "VALIDATION_ERROR", f"Tối đa {max_items} IP mỗi lần.")
    result = []
    for item in value:
        ip = _validate_private_ip(item)
        if ip not in result:
            result.append(ip)
    return result


def _credentials_map(ips: list, body_username: str = "", body_password: str = ""):
    mapping = {}
    errors = {}
    for ip in ips:
        try:
            mapping[ip] = _resolve_credentials(
                ip, body_username=body_username, body_password=body_password,
                prefer_body=bool(body_password),
            )
        except HTTPResponse as exc:
            errors[ip] = exc
    return mapping, errors


def _public_result(item: dict) -> dict:
    if not isinstance(item, dict):
        return {"ok": False, "error": "Kết quả không hợp lệ."}
    return {
        key: value for key, value in item.items()
        if "password" not in key.lower() and "token" not in key.lower()
        and key.lower() not in ("secret", "new_password")
    }


def _credential_pairs(mapping: dict) -> dict:
    """Giữ cả username lẫn password để batch dùng đúng credential đã lưu."""
    return {ip: (value[0], value[1]) for ip, value in mapping.items()}


@route("/api/batch-ip", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
@cctv_auth.rate_limit("batch_ip", 3, 60, scope="session")
def api_batch_ip():
    _test_mode_block("Không đổi IP camera trong chế độ kiểm thử.")
    data = _data()
    _require_confirm(data)
    ips = _validate_ip_list(data.get("ips"), 100)
    is_dhcp = bool(data.get("is_dhcp", False))
    start_ip = str(data.get("start_ip") or "").strip()
    netmask = str(data.get("netmask") or "255.255.255.0").strip()
    gateway = str(data.get("gateway") or "").strip() or None
    if not is_dhcp:
        if not start_ip:
            raise cctv_auth.fail(400, "VALIDATION_ERROR", "Vui lòng nhập IP bắt đầu.")
        _validate_private_ip(start_ip)
        try:
            ipaddress.IPv4Network(f"0.0.0.0/{netmask}")
        except ValueError:
            raise cctv_auth.fail(400, "VALIDATION_ERROR", "Subnet mask không hợp lệ.")
        if gateway:
            _validate_private_ip(gateway)
    body_username = _clean_text(data.get("username") or "", 64)
    body_password = str(data.get("password") or "")
    mapping, missing = _credentials_map(ips, body_username, body_password)
    if missing:
        raise cctv_auth.fail(409, "CAMERA_CREDENTIAL_REQUIRED",
                             "Một số camera chưa có mật khẩu.",
                             details={"ips": sorted(missing.keys())})
    results = batch_change_ip(
        device_ips=ips,
        is_dhcp=is_dhcp,
        start_ip=start_ip if not is_dhcp else None,
        netmask=netmask,
        gateway=gateway,
        credentials_map=_credential_pairs(mapping),
        default_password="",
    )
    success = [item for item in results if item.get("ok")]
    managed_updated = 0
    managed_errors = []
    if not is_dhcp:
        for item in success:
            old_ip = str(item.get("old_ip") or item.get("ip") or "").strip()
            new_ip = str(item.get("new_ip") or "").strip()
            if not old_ip or not new_ip or new_ip.upper() == "DHCP":
                continue
            camera = _managed_by_ip(old_ip)
            if not camera:
                continue
            update = update_managed_camera(camera.get("id") or old_ip, {"ip": new_ip})
            if update.get("ok"):
                managed_updated += 1
                item["managed_updated"] = True
            else:
                detail = update.get("error") or "Không cập nhật được hồ sơ NVR."
                item["managed_update_error"] = detail
                managed_errors.append({"old_ip": old_ip, "new_ip": new_ip, "error": detail})
    if data.get("auto_reboot") and success:
        try:
            batch_reboot_cameras([item.get("old_ip") or item.get("ip") for item in success],
                                 credentials_map=_credential_pairs(mapping), default_password="")
        except Exception as exc:
            print(f"[!] Lỗi auto reboot sau đổi IP: {exc}")
    return J(total=len(results), success_count=len(success),
             fail_count=len(results) - len(success),
             managed_updated=managed_updated,
             managed_errors=managed_errors,
             results=[_public_result(item) for item in results])


@route("/api/reboot", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
@cctv_auth.rate_limit("reboot", 3, 60, scope="session")
def api_reboot():
    _test_mode_block("Không khởi động lại camera trong chế độ kiểm thử.")
    data = _data()
    _require_confirm(data)
    ips = _validate_ip_list(data.get("ips"), 100)
    mapping, missing = _credentials_map(
        ips, _clean_text(data.get("username") or "", 64), str(data.get("password") or ""))
    if missing:
        raise cctv_auth.fail(409, "CAMERA_CREDENTIAL_REQUIRED", "Một số camera chưa có mật khẩu.",
                             details={"ips": sorted(missing.keys())})
    results = batch_reboot_cameras(ips, credentials_map=_credential_pairs(mapping),
                                   default_password="")
    success = [item for item in results if item.get("ok")]
    return J(total=len(results), success_count=len(success),
             fail_count=len(results) - len(success),
             results=[_public_result(item) for item in results])


_TIMEZONE_RE = re.compile(r"^GMT[+-]\d{2}:\d{2}$")


@route("/api/sync-time", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
@cctv_auth.rate_limit("sync_time", 3, 60, scope="session")
def api_sync_time():
    _test_mode_block("Không đồng bộ giờ camera trong chế độ kiểm thử.")
    data = _data()
    ips = _validate_ip_list(data.get("ips"), 100)
    timezone = str(data.get("timezone") or "GMT+07:00").strip()
    if not _TIMEZONE_RE.match(timezone):
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "Timezone phải có dạng GMT+07:00.")
    mapping, missing = _credentials_map(
        ips, _clean_text(data.get("username") or "", 64), str(data.get("password") or ""))
    if missing:
        raise cctv_auth.fail(409, "CAMERA_CREDENTIAL_REQUIRED", "Một số camera chưa có mật khẩu.",
                             details={"ips": sorted(missing.keys())})
    results = batch_sync_camera_time(ips, credentials_map=_credential_pairs(mapping),
                                     default_password="", timezone=timezone)
    success = [item for item in results if item.get("ok")]
    return J(total=len(results), success_count=len(success),
             fail_count=len(results) - len(success),
             synced_time=_now_str(), timezone=timezone,
             results=[_public_result(item) for item in results])


@route("/api/batch_change_password", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
@cctv_auth.rate_limit("batch_password", 3, 60, scope="session")
def api_batch_change_password():
    _test_mode_block("Không đổi mật khẩu camera trong chế độ kiểm thử.")
    data = _data()
    _require_confirm(data)
    ips = _validate_ip_list(data.get("ips"), 100)
    new_password = str(data.get("new_password") or "").strip()
    error = cctv_auth.validate_camera_password(new_password)
    if error:
        raise cctv_auth.fail(400, "VALIDATION_ERROR", error)
    username_override = _clean_text(data.get("username") or "", 64)
    old_password_override = str(data.get("old_password") or "")
    results = []
    for ip in ips:
        try:
            if old_password_override:
                username = username_override
                if not username:
                    try:
                        username = _resolve_credentials(ip)[0]
                    except HTTPResponse:
                        username = ""
                old_password = old_password_override
            else:
                username, old_password = _resolve_credentials(ip)
                username = username_override or username
            if not str(username or "").strip():
                results.append({
                    "ok": False, "ip": ip,
                    "error": "Chưa có username cho camera. Nhập username hoặc thêm camera vào NVR.",
                })
                continue
            item = change_camera_password(ip, username, old_password, new_password)
        except HTTPResponse as exc:
            item = {"ok": False, "ip": ip, "error": "Chưa có mật khẩu cho camera."}
        except Exception as exc:
            item = {"ok": False, "ip": ip, "error": cctv_auth.redact_text(str(exc))}
        if item.get("ok"):
            clear_result = _public_result(item)
            clear_result["message"] = "Đã đổi mật khẩu thành công."
            try:
                cam = _managed_by_ip(ip)
                if cam:
                    update = update_managed_camera(cam.get("id") or ip, {"password": new_password})
                    if not update.get("ok"):
                        clear_result["managed_update_error"] = (
                            "Đã đổi mật khẩu camera nhưng chưa cập nhật được hồ sơ NVR: "
                            + str(update.get("error") or "lỗi không xác định")
                        )
            except Exception as exc:
                clear_result["managed_update_error"] = (
                    "Đã đổi mật khẩu camera nhưng chưa cập nhật được hồ sơ NVR: "
                    + cctv_auth.redact_text(str(exc))
                )
            results.append(clear_result)
            _ephemeral_clear_ip(ip)
        else:
            results.append(_public_result(item))
    success = [item for item in results if item.get("ok")]
    managed_sync_failed = sum(1 for item in results if item.get("managed_update_error"))
    return J(total=len(results), success_count=len(success),
             failed_count=len(results) - len(success),
             managed_sync_failed=managed_sync_failed,
             results=results)


# ==============================================================================
# Camera details / name
# ==============================================================================

@route("/api/camera/details", method="GET")
@cctv_auth.require_role(cctv_auth.VIEWER)
def api_camera_details():
    _reject_password_query()
    ip = _scope_target(request.query.get("ip", ""), _role())
    username, password = _resolve_credentials(ip)
    _test_mode_block("Không truy vấn camera trong chế độ kiểm thử.")
    details = get_device_full_details(ip, username, password)
    with _CACHED_DEVICES_LOCK:
        for device in CACHED_DEVICES:
            if device.get("ip") == ip:
                for key in ("mac", "serial", "model", "name", "firmware",
                            "http_port", "tcp_port", "gateway", "netmask", "dhcp"):
                    if details.get(key) in (None, "N/A", "") and device.get(key):
                        details[key] = device[key]
                break
    return J(details=details)


@route("/api/camera/name", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
def api_camera_rename():
    _test_mode_block("Không đổi tên camera trong chế độ kiểm thử.")
    data = _data()
    ip = _scope_target(data.get("ip", ""), _role())
    new_name = _clean_text(data.get("name"), 64)
    if not new_name:
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "Tên camera không hợp lệ.")
    username, password = _resolve_credentials(ip)
    result = set_camera_name(ip, username, password, new_name)
    if not isinstance(result, dict) or not result.get("ok"):
        raise cctv_auth.fail(502, "CAMERA_OPERATION_FAILED",
                             cctv_auth.redact_text(str((result or {}).get("error") or "Camera từ chối thao tác.")))
    with _CACHED_DEVICES_LOCK:
        for device in CACHED_DEVICES:
            if device.get("ip") == ip:
                device["name"] = new_name
                break
    try:
        cam = _managed_by_ip(ip)
        if cam:
            update_managed_camera(cam.get("id") or ip, {"name": new_name})
    except Exception:
        pass
    return J(ip=ip, name=new_name, message="Đã đổi tên camera.")


# ==============================================================================
# Hardware features
# ==============================================================================

CAMERA_TRACKING_ACTIVE: dict[str, bool] = {}
CAMERA_TRACKING_THREADS: dict[str, threading.Thread] = {}
CAMERA_HARDWARE_CACHE: dict[str, dict] = {}


def _smart_tracking_worker(ip: str, username: str, password: str) -> None:
    """Theo dõi chuyển động bằng snapshot nội bộ (không gọi HTTP localhost)."""
    try:
        from PIL import Image, ImageChops, ImageStat
    except Exception:
        print("[!] [Smart Tracking] Thiếu Pillow, không thể phân tích chuyển động.")
        return
    print(f"[*] [Smart Tracking] Bắt đầu bám chuyển động cho {ip}")
    previous = None
    last_move = 0.0
    while CAMERA_TRACKING_ACTIVE.get(ip, False):
        try:
            payload = _capture_snapshot(ip, username, password, timeout=3.0)
            if payload and len(payload) > 1000:
                import io as _io
                current = Image.open(_io.BytesIO(payload)).convert("L").resize((160, 120))
                now = time.time()
                if previous is not None and (now - last_move) > 1.2:
                    diff = ImageChops.difference(previous, current)
                    left = ImageStat.Stat(diff.crop((0, 0, 55, 120))).mean[0]
                    middle = ImageStat.Stat(diff.crop((55, 0, 105, 120))).mean[0]
                    right = ImageStat.Stat(diff.crop((105, 0, 160, 120))).mean[0]
                    threshold = 7.0
                    if left > threshold and left > right * 1.35:
                        ptz_command(ip=ip, username=username, password=password,
                                    action="StepLeft", speed=3)
                        last_move = now
                        time.sleep(0.4)
                    elif right > threshold and right > left * 1.35:
                        ptz_command(ip=ip, username=username, password=password,
                                    action="StepRight", speed=3)
                        last_move = now
                        time.sleep(0.4)
                previous = current
        except Exception:
            pass
        time.sleep(0.7)
    print(f"[*] [Smart Tracking] Đã dừng bám chuyển động cho {ip}")


@route("/api/hardware/status", method="GET")
@cctv_auth.require_role(cctv_auth.VIEWER)
def api_hardware_status():
    _reject_password_query()
    ip = _scope_target(request.query.get("ip", ""), _role())
    username, password = _resolve_credentials(ip)
    _test_mode_block("Không truy vấn phần cứng camera trong chế độ kiểm thử.")
    status = get_camera_hardware_status(ip=ip, username=username, password=password)
    if CAMERA_TRACKING_ACTIVE.get(ip, False):
        status["tracking"] = True
    if status.get("ok"):
        CAMERA_HARDWARE_CACHE[ip] = {
            "privacy": status.get("privacy", False),
            "tracking": status.get("tracking", False),
            "siren": status.get("siren", False),
        }
    return J(**{key: value for key, value in status.items() if key != "ok"})


@route("/api/hardware/privacy", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
def api_hardware_privacy():
    _test_mode_block("Không thay đổi phần cứng camera trong chế độ kiểm thử.")
    data = _data()
    ip = _scope_target(data.get("ip", ""), _role())
    enable = bool(data.get("enable", False))
    username, password = _resolve_credentials(ip)
    result = set_camera_privacy_mode(ip=ip, username=username, password=password, enable=enable)
    if not isinstance(result, dict) or not result.get("ok"):
        raise cctv_auth.fail(502, "CAMERA_OPERATION_FAILED",
                             cctv_auth.redact_text(str((result or {}).get("error") or "Camera từ chối thao tác.")))
    CAMERA_HARDWARE_CACHE.setdefault(ip, {})["privacy"] = enable
    return J(**{key: value for key, value in result.items() if key != "ok"})


@route("/api/hardware/tracking", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
def api_hardware_tracking():
    _test_mode_block("Không thay đổi phần cứng camera trong chế độ kiểm thử.")
    data = _data()
    ip = _scope_target(data.get("ip", ""), _role())
    enable = bool(data.get("enable", False))
    username, password = _resolve_credentials(ip)
    result = set_smart_tracking(ip=ip, username=username, password=password, enable=enable)
    if not isinstance(result, dict) or not result.get("ok"):
        CAMERA_TRACKING_ACTIVE[ip] = False
        raise cctv_auth.fail(502, "CAMERA_OPERATION_FAILED",
                             cctv_auth.redact_text(str((result or {}).get("error") or "Camera từ chối thao tác.")))
    CAMERA_TRACKING_ACTIVE[ip] = enable
    if enable:
        existing = CAMERA_TRACKING_THREADS.get(ip)
        if not existing or not existing.is_alive():
            thread = threading.Thread(target=_smart_tracking_worker,
                                      args=(ip, username, password), daemon=True,
                                      name=f"SmartTracking-{ip}")
            CAMERA_TRACKING_THREADS[ip] = thread
            thread.start()
    CAMERA_HARDWARE_CACHE.setdefault(ip, {})["tracking"] = enable
    return J(**{key: value for key, value in result.items() if key != "ok"})


@route("/api/hardware/siren", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
def api_hardware_siren():
    _test_mode_block("Không thay đổi phần cứng camera trong chế độ kiểm thử.")
    data = _data()
    ip = _scope_target(data.get("ip", ""), _role())
    action = str(data.get("action") or "start").strip().lower()
    if action not in ("start", "stop"):
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "action phải là start hoặc stop.")
    if action == "start" and data.get("confirm") is not True:
        raise cctv_auth.fail(400, "CONFIRMATION_REQUIRED", "Cần xác nhận khi bật còi báo động.")
    username, password = _resolve_credentials(ip)
    result = set_camera_siren(ip=ip, username=username, password=password, action=action)
    if not isinstance(result, dict) or not result.get("ok"):
        raise cctv_auth.fail(502, "CAMERA_OPERATION_FAILED",
                             cctv_auth.redact_text(str((result or {}).get("error") or "Camera từ chối thao tác.")))
    CAMERA_HARDWARE_CACHE.setdefault(ip, {})["siren"] = (action == "start")
    return J(**{key: value for key, value in result.items() if key != "ok"})


# ==============================================================================
# Storage / SD card
# ==============================================================================

@route("/api/storage/info", method="GET")
@cctv_auth.require_role(cctv_auth.VIEWER)
def api_storage_info():
    _reject_password_query()
    ip = _scope_target(request.query.get("ip", ""), _role())
    username, password = _resolve_credentials(ip)
    _test_mode_block("Không truy vấn thẻ nhớ camera trong chế độ kiểm thử.")
    result = get_camera_storage_info(ip=ip, username=username, password=password)
    if _role() != cctv_auth.ADMIN:
        result["path"] = None
    if not isinstance(result, dict) or not result.get("ok"):
        raise cctv_auth.fail(502, "CAMERA_OPERATION_FAILED",
                             cctv_auth.redact_text(str((result or {}).get("error") or "Camera không phản hồi.")))
    return J(**{key: value for key, value in result.items() if key != "ok"})


@route("/api/storage/format", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
@cctv_auth.rate_limit("storage_format", 3, 60, scope="session")
def api_storage_format():
    _test_mode_block("Không định dạng thẻ nhớ trong chế độ kiểm thử.")
    data = _data()
    if data.get("confirm") != "FORMAT":
        raise cctv_auth.fail(400, "CONFIRMATION_REQUIRED", "Gõ FORMAT để xác nhận định dạng thẻ.")
    ip = _scope_target(data.get("ip", ""), _role())
    username, password = _resolve_credentials(ip)
    result = format_camera_storage(ip=ip, username=username, password=password)
    if not isinstance(result, dict) or not result.get("ok"):
        raise cctv_auth.fail(502, "CAMERA_OPERATION_FAILED",
                             cctv_auth.redact_text(str((result or {}).get("error") or "Camera từ chối thao tác.")))
    return J(ip=ip, message=result.get("message") or "Đã gửi lệnh định dạng thẻ.")


@route("/api/storage/recordings", method="GET")
@cctv_auth.require_role(cctv_auth.VIEWER)
def api_storage_recordings():
    _reject_password_query()
    ip = _scope_target(request.query.get("ip", ""), _role())
    date_str = (request.query.get("date") or "").strip()
    if not date_str:
        date_str = datetime.datetime.now().strftime("%Y-%m-%d")
    try:
        datetime.datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "date phải có định dạng YYYY-MM-DD.")
    username, password = _resolve_credentials(ip)
    _test_mode_block("Không truy vấn clip trên camera trong chế độ kiểm thử.")
    result = search_camera_recordings(
        ip=ip, username=username, password=password,
        start_time=f"{date_str} 00:00:00", end_time=f"{date_str} 23:59:59",
    )
    if not isinstance(result, dict) or not result.get("ok"):
        raise cctv_auth.fail(502, "CAMERA_OPERATION_FAILED",
                             cctv_auth.redact_text(str((result or {}).get("error") or "Camera không phản hồi.")))
    recordings = result.get("recordings") or []
    if _role() != cctv_auth.ADMIN:
        for clip in recordings:
            if isinstance(clip, dict):
                clip["file_path"] = None
    return J(**{key: value for key, value in result.items() if key not in ("ok", "recordings")},
             recordings=recordings)


@route("/api/storage/watchdog/check_now", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
@cctv_auth.rate_limit("watchdog", 2, 60, scope="session")
def api_storage_watchdog_check_now():
    _test_mode_block("Không quét thẻ nhớ camera trong chế độ kiểm thử.")
    data = _data()
    force_send = bool(data.get("force_send", False))
    if ALARM_MANAGER is None:
        raise cctv_auth.fail(500, "INTERNAL_ERROR", "Dịch vụ cảnh báo chưa khởi động.")
    result = ALARM_MANAGER.check_all_storage_health(force_send=force_send)
    return J(**result)


# ==============================================================================
# Alarm
# ==============================================================================

def _alarm_manager_status() -> dict:
    if ALARM_MANAGER is None or DISABLE_ALARMS:
        return {
            "ok": True, "armed": False, "running": False, "disabled": True,
            "telegram_enabled": False, "bot_configured": False,
            "schedule_enabled": True, "schedule_start": "18:00", "schedule_end": "07:00",
            "is_in_schedule": False, "cooldown_seconds": 60, "human_only": True,
            "telegram_storage_alerts": True, "telegram_storage_check_interval": 30,
            "storage_watchdog": {"states": {}, "last_run": None},
            "active_listeners": [], "listeners_count": 0, "history_count": 0,
            "startup_grace_remaining_seconds": 0,
        }
    status = ALARM_MANAGER.get_status()
    running = bool(getattr(ALARM_MANAGER, "_running", False))
    status["running"] = running
    status["disabled"] = not running
    if not running:
        status["armed"] = False
    return status


_VIEWER_ALARM_KEYS = {
    "ok", "armed", "running", "disabled", "schedule_enabled", "schedule_start",
    "schedule_end", "is_in_schedule", "cooldown_seconds", "storage_watchdog",
    "active_listeners", "listeners_count", "history_count",
    "startup_grace_remaining_seconds",
}


@route("/api/alarm/status", method="GET")
@cctv_auth.require_role(cctv_auth.VIEWER)
def api_alarm_status():
    status = _alarm_manager_status()
    if _role() != cctv_auth.ADMIN:
        status = {key: value for key, value in status.items() if key in _VIEWER_ALARM_KEYS}
    return J(**{key: value for key, value in status.items() if key != "ok"})


@route("/api/alarm/toggle", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
def api_alarm_toggle():
    data = _data()
    armed = data.get("armed")
    if not isinstance(armed, bool):
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "armed phải là true/false.")
    if armed is False and data.get("confirm") is not True:
        raise cctv_auth.fail(400, "CONFIRMATION_REQUIRED", "Cần xác nhận khi tắt chế độ gác an ninh.")
    if ALARM_MANAGER is None:
        raise cctv_auth.fail(500, "INTERNAL_ERROR", "Dịch vụ cảnh báo chưa khởi động.")
    ALARM_MANAGER.set_armed(armed)
    if AUTH:
        AUTH.audit("alarm_toggle", armed=armed, client_ip=cctv_auth.get_client_ip())
    return J(armed=armed, message="Đã BẬT chế độ gác an ninh." if armed else "Đã TẮT chế độ gác an ninh.")


@route("/api/alarm/test", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
@cctv_auth.rate_limit("alarm_test", 2, 60, scope="session")
def api_alarm_test():
    if TEST_MODE:
        # Không có mock Telegram server trong phạm vi này: tuyệt đối không gửi ra ngoài khi test.
        raise cctv_auth.fail(503, "TEST_MODE_BLOCKED", "Không gửi Telegram trong chế độ kiểm thử.")
    if DISABLE_TELEGRAM:
        raise cctv_auth.fail(503, "TELEGRAM_DISABLED", "Gửi Telegram đang bị tắt trên máy chủ.")
    data = _data()
    settings = load_settings()
    bot_token = str(settings.get("telegram_bot_token") or "").strip()
    chat_id = str(settings.get("telegram_chat_id") or "").strip()
    if not bot_token or not chat_id:
        raise cctv_auth.fail(409, "TELEGRAM_NOT_CONFIGURED",
                             "Chưa cấu hình Telegram Bot Token và Chat ID.")
    sample_photo = None
    if bool(data.get("include_snapshot", False)) and data.get("camera_id"):
        cam = get_managed_camera(str(data.get("camera_id")))
        if not cam:
            raise cctv_auth.fail(404, "CAMERA_NOT_FOUND", "Không tìm thấy camera.")
        ip = _validate_private_ip(cam.get("ip"))
        username, password = _resolve_credentials(ip)
        sample_photo = _capture_snapshot(ip, username, password)
    result = test_telegram_bot(bot_token, chat_id, sample_photo=sample_photo)
    if not result.get("ok"):
        raise cctv_auth.fail(502, "TELEGRAM_SEND_FAILED",
                             cctv_auth.redact_text(str(result.get("error") or "Gửi Telegram thất bại.")))
    return J(message="Đã gửi tin nhắn thử.", telegram={"result": result.get("result")})


def _history_item_public(item: dict) -> dict:
    file_name = item.get("snapshot_file")
    snapshot_url = None
    if file_name:
        safe_name = os.path.basename(str(file_name))
        if safe_name == file_name:
            try:
                if os.path.isfile(os.path.join(_storage_dir("snapshots"), safe_name)):
                    snapshot_url = "/snapshots/" + urllib.parse.quote(safe_name)
            except Exception:
                snapshot_url = None
    return {
        "id": item.get("id"),
        "timestamp": item.get("timestamp"),
        "ip": item.get("ip"),
        "name": item.get("name"),
        "code": item.get("code"),
        "title": item.get("title"),
        "status": item.get("status"),
        "snapshot_file": file_name,
        "snapshot_url": snapshot_url,
    }


@route("/api/alarm/history", method="GET")
@cctv_auth.require_role(cctv_auth.VIEWER)
def api_alarm_history():
    try:
        limit = max(1, min(200, int(request.query.get("limit", 50))))
        offset = max(0, int(request.query.get("offset", 0)))
    except (TypeError, ValueError):
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "limit/offset không hợp lệ.")
    status_filter = (request.query.get("status") or "").strip().lower()
    if status_filter and status_filter not in {"sent", "failed", "skipped", "suppressed"}:
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "status không hợp lệ.")
    ip_filter = (request.query.get("ip") or "").strip()
    if ip_filter:
        ip_filter = _validate_private_ip(ip_filter)
    date_filter = (request.query.get("date") or "").strip()
    if date_filter:
        try:
            datetime.datetime.strptime(date_filter, "%Y-%m-%d")
        except ValueError:
            raise cctv_auth.fail(400, "VALIDATION_ERROR", "date phải có định dạng YYYY-MM-DD.")
    history = ALARM_MANAGER.get_history() if ALARM_MANAGER else []
    filtered = []
    for item in history:
        if status_filter and item.get("status") != status_filter:
            continue
        if ip_filter and item.get("ip") != ip_filter:
            continue
        if date_filter and not str(item.get("timestamp", "")).startswith(date_filter):
            continue
        filtered.append(item)
    page = filtered[offset:offset + limit]
    return J(count=len(page), total=len(filtered),
             history=[_history_item_public(item) for item in page])


@route("/api/alarm/clear_history", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
def api_alarm_clear_history():
    data = _data()
    if data.get("confirm") is not True:
        raise cctv_auth.fail(400, "CONFIRMATION_REQUIRED", "Cần xác nhận để xoá nhật ký cảnh báo.")
    if ALARM_MANAGER:
        ALARM_MANAGER.clear_history()
    if AUTH:
        AUTH.audit("alarm_clear_history", client_ip=cctv_auth.get_client_ip())
    return J(message="Đã xóa nhật ký cảnh báo.")


# ==============================================================================
# Managed cameras
# ==============================================================================

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def _clean_text(value, max_length: int) -> str:
    text = _CONTROL_CHARS.sub("", str(value or "")).strip()
    return text[:max_length]


def _validate_camera_payload(data: dict) -> dict:
    cleaned: dict = {}
    if "ip" in data:
        cleaned["ip"] = _validate_private_ip(data["ip"])
    for key, max_length in (
        ("name", 64), ("group", 32), ("vendor", 32), ("model", 64),
        ("username", 64), ("note", 500), ("mac", 32), ("serial", 64),
        ("firmware", 64), ("vlan", 64), ("vlan_id", 16),
    ):
        if key in data:
            cleaned[key] = _clean_text(data[key], max_length)
    if "name" in cleaned and not cleaned["name"]:
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "Tên camera không được rỗng.")
    if "username" in cleaned and not cleaned["username"]:
        cleaned["username"] = "admin"
    for key in ("http_port", "tcp_port", "rtsp_port"):
        if key in data:
            try:
                port = int(data[key])
            except (TypeError, ValueError):
                raise cctv_auth.fail(400, "VALIDATION_ERROR", f"{key} không hợp lệ.")
            if port < 1 or port > 65535:
                raise cctv_auth.fail(400, "VALIDATION_ERROR", f"{key} phải trong khoảng 1-65535.")
            cleaned[key] = port
    if "password" in data:
        password = str(data["password"] or "")
        if password:
            if len(password) > cctv_auth.CAMERA_PASSWORD_MAX:
                raise cctv_auth.fail(400, "VALIDATION_ERROR", "Mật khẩu camera quá dài.")
            cleaned["password"] = password
    if "rtsp_path" in data:
        path = _clean_text(data["rtsp_path"], 200)
        if path and not path.startswith("/"):
            raise cctv_auth.fail(400, "VALIDATION_ERROR", "rtsp_path phải bắt đầu bằng '/'.")
        cleaned["rtsp_path"] = path
    if "alarm_armed" in data:
        cleaned["alarm_armed"] = bool(data["alarm_armed"])
    if "is_solar" in data:
        cleaned["is_solar"] = bool(data["is_solar"])
    return cleaned


@route("/api/managed/cameras", method="GET")
@cctv_auth.require_role(cctv_auth.VIEWER)
def api_get_managed_cameras():
    is_admin = _role() == cctv_auth.ADMIN
    cameras = [public_view(cam, is_admin=is_admin) for cam in load_managed_cameras()]
    return J(count=len(cameras), cameras=cameras)


@route("/api/managed/cameras", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
def api_add_managed_camera():
    data = _data()
    batch = data.get("batch")
    if isinstance(batch, list):
        if len(batch) > 500:
            raise cctv_auth.fail(400, "VALIDATION_ERROR", "Batch tối đa 500 camera.")
        default_password = str(data.get("default_password") or load_settings().get("default_password") or "")
        cleaned_batch = []
        for item in batch:
            if not isinstance(item, dict):
                continue
            cleaned = _validate_camera_payload(item)
            if "ip" not in cleaned:
                continue
            if not cleaned.get("password") and default_password:
                cleaned["password"] = default_password
            cleaned_batch.append(cleaned)
        result = add_batch_managed_cameras(cleaned_batch, default_pwd=default_password)
        return J(**{key: value for key, value in result.items() if key != "ok"})

    cleaned = _validate_camera_payload(data)
    if "ip" not in cleaned:
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "Thiếu địa chỉ IP camera.")
    existing = _managed_by_ip(cleaned["ip"])
    if not cleaned.get("password") and not existing:
        default_password = str(load_settings().get("default_password") or "")
        if default_password:
            cleaned["password"] = default_password
        else:
            raise cctv_auth.fail(400, "CAMERA_PASSWORD_REQUIRED",
                                 "Cần nhập mật khẩu camera hoặc đặt mật khẩu mặc định.")
    result = add_managed_camera(cleaned)
    if not result.get("ok"):
        raise cctv_auth.fail(400, "VALIDATION_ERROR", cctv_auth.redact_text(str(result.get("error"))))
    try:
        _sync_alarm_listeners()
    except Exception:
        pass
    return J(camera=public_view(result.get("camera", {}), is_admin=True),
             message=result.get("message"))


@route("/api/managed/cameras/<cam_id:path>", method="PUT")
@cctv_auth.require_role(cctv_auth.ADMIN)
def api_update_managed_camera(cam_id):
    data = _data()
    cleaned = _validate_camera_payload(data)
    result = update_managed_camera(cam_id, cleaned)
    if not result.get("ok"):
        raise cctv_auth.fail(404, "CAMERA_NOT_FOUND", cctv_auth.redact_text(str(result.get("error"))))
    try:
        _sync_alarm_listeners()
    except Exception:
        pass
    return J(camera=public_view(result.get("camera", {}), is_admin=True),
             message=result.get("message"))


@route("/api/managed/cameras/<cam_id:path>", method="DELETE")
@cctv_auth.require_role(cctv_auth.ADMIN)
def api_delete_managed_camera(cam_id):
    data = _data()
    if data.get("confirm") is not True:
        raise cctv_auth.fail(400, "CONFIRMATION_REQUIRED", "Cần xác nhận để xoá camera.")
    result = delete_managed_camera(cam_id)
    if not result.get("ok"):
        raise cctv_auth.fail(404, "CAMERA_NOT_FOUND", cctv_auth.redact_text(str(result.get("error"))))
    try:
        _sync_alarm_listeners()
    except Exception:
        pass
    return J(message=result.get("message"))


@route("/api/managed/cameras/test", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
@cctv_auth.rate_limit("managed_test", 10, 60, scope="ip")
def api_test_managed_camera():
    _test_mode_block("Không kiểm tra kết nối camera trong chế độ kiểm thử.")
    data = _data()
    ip = _validate_private_ip(data.get("ip", ""))
    try:
        port = int(data.get("port", 80))
    except (TypeError, ValueError):
        port = 80
    if port < 1 or port > 65535:
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "port phải trong khoảng 1-65535.")
    username = _clean_text(data.get("username") or "", 64) or "admin"
    password = str(data.get("password") or "")
    if password:
        if len(password) > cctv_auth.CAMERA_PASSWORD_MAX:
            raise cctv_auth.fail(400, "VALIDATION_ERROR", "Mật khẩu camera quá dài.")
    else:
        username, password = _resolve_credentials(ip)
    result = test_camera_connection(ip=ip, port=port, username=username, password=password)
    if result.get("error"):
        result["error"] = cctv_auth.redact_text(str(result["error"]))
    return J(**{key: value for key, value in result.items() if key != "ok"})


@route("/api/managed/cameras/sync", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
@cctv_auth.rate_limit("managed_sync", 3, 60, scope="session")
def api_sync_managed_health():
    _test_mode_block("Không đồng bộ sức khoẻ camera trong chế độ kiểm thử.")
    cameras = sync_cameras_health()
    return J(count=len(cameras), checked_at=_now_str(),
             cameras=[public_view(cam, is_admin=True) for cam in cameras])


@route("/api/managed/cameras/toggle-alarm", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
def api_toggle_camera_alarm():
    data = _data()
    cam_id = str(data.get("id") or "").strip()
    state = data.get("state")
    if not cam_id:
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "Thiếu ID camera.")
    if not isinstance(state, bool):
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "state phải là true/false.")
    result = toggle_camera_alarm(cam_id, state)
    if not result.get("ok"):
        raise cctv_auth.fail(404, "CAMERA_NOT_FOUND", cctv_auth.redact_text(str(result.get("error"))))
    try:
        _sync_alarm_listeners()
    except Exception:
        pass
    return J(id=result.get("id"), alarm_armed=result.get("alarm_armed"),
             message=result.get("message"))


# ==============================================================================
# Ephemeral camera credentials
# ==============================================================================

@route("/api/cameras/credentials", method="POST")
@cctv_auth.require_role(cctv_auth.ADMIN)
@cctv_auth.rate_limit("camera_credentials", 10, 60, scope="session")
def api_set_camera_credentials():
    data = _data()
    ip = _validate_private_ip(data.get("ip", ""))
    username = _clean_text(data.get("username") or "admin", 64) or "admin"
    password = str(data.get("password") or "")
    if not password or len(password) > cctv_auth.CAMERA_PASSWORD_MAX:
        raise cctv_auth.fail(400, "VALIDATION_ERROR", "Mật khẩu camera phải có 1-128 ký tự.")
    expires_at = _ephemeral_set(ip, username, password)
    if AUTH:
        AUTH.audit("credential_set", ip=ip, client_ip=cctv_auth.get_client_ip())
    return J(ip=ip, expires_at=_iso(expires_at))


@route("/api/cameras/credentials/<ip>", method="DELETE")
@cctv_auth.require_role(cctv_auth.ADMIN)
def api_delete_camera_credentials(ip):
    address = _validate_private_ip(ip)
    _ephemeral_clear_ip(address)
    return J(ip=address)


# ==============================================================================
# Error handlers
# ==============================================================================

def _wants_json() -> bool:
    path = request.path or ""
    return path.startswith("/api/") or path.startswith("/snapshots/") or path.startswith("/download/")


def _error_http_response(status: int, code: str, message: str, plain: str) -> HTTPResponse:
    """Tạo response lỗi và gắn đầy đủ security headers.

    ``HTTPResponse`` trả trực tiếp từ ``@error`` không đi qua after_request hook,
    nên nếu không gắn tại đây thì 404/405/413/500 sẽ thiếu CSP/nosniff/...
    """
    if _wants_json():
        result = cctv_auth.error_response(status, code, message)
    else:
        result = HTTPResponse(
            status=status,
            body=plain,
            headers={"Content-Type": "text/plain; charset=utf-8"},
        )
    cctv_auth.apply_security_headers(result)
    return result


@error(404)
def _handle_404(err):
    return _error_http_response(404, "NOT_FOUND", "Không tìm thấy tài nguyên.",
                                "Không tìm thấy tài nguyên.")


@error(405)
def _handle_405(err):
    return _error_http_response(405, "METHOD_NOT_ALLOWED",
                                "Phương thức HTTP không được hỗ trợ.",
                                "Phương thức HTTP không được hỗ trợ.")


@error(413)
def _handle_413(err):
    return _error_http_response(413, "PAYLOAD_TOO_LARGE", "Dữ liệu gửi lên quá lớn.",
                                "Dữ liệu gửi lên quá lớn.")


@error(500)
def _handle_500(err):
    exception = getattr(err, "exception", None)
    if exception is not None:
        formatted = "".join(traceback.format_exception(
            type(exception), exception, exception.__traceback__))
        print(cctv_auth.redact_text("[!] Lỗi máy chủ:\n" + formatted))
    return _error_http_response(500, "INTERNAL_ERROR",
                                "Máy chủ gặp lỗi. Vui lòng thử lại hoặc kiểm tra log.",
                                "Máy chủ gặp lỗi.")


# ==============================================================================
# Lifecycle
# ==============================================================================

def cleanup_all() -> None:
    with RECORDINGS_LOCK:
        for key, rec in list(ACTIVE_RECORDINGS.items()):
            ACTIVE_RECORDINGS.pop(key, None)
            _stop_recording_entry(rec)
    CAMERA_TRACKING_ACTIVE.clear()
    if ALARM_MANAGER is not None:
        try:
            ALARM_MANAGER.stop()
        except Exception:
            pass


atexit.register(cleanup_all)


def main() -> None:
    if AUTH is None:
        print("[FATAL] Không thể khởi động do lỗi cấu hình xác thực:")
        print(f"        {_AUTH_INIT_ERROR}")
        sys.exit(2)

    host = os.environ.get("CCTV_HOST", "0.0.0.0")
    try:
        port = int(os.environ.get("CCTV_PORT", "8080"))
    except ValueError:
        port = 8080

    if cctv_auth.env_bool("CCTV_MIGRATION_ONLY"):
        if not TEST_MODE:
            print("[FATAL] CCTV_MIGRATION_ONLY chỉ hợp lệ khi CCTV_TEST_MODE=1.")
            sys.exit(2)
        print("[*] Migration/validation hoàn tất.")
        return

    if TEST_MODE:
        if host not in ("127.0.0.1", "localhost", "::1") or port == 8080:
            print("[FATAL] Test mode bắt buộc CCTV_HOST=127.0.0.1 và cổng khác 8080.")
            sys.exit(2)
        print("[!] CẢNH BÁO: ĐANG CHẠY Ở CHẾ ĐỘ KIỂM THỬ (CCTV_TEST_MODE=1).")

    url = f"http://localhost:{port}"
    lan_ips = _lan_ips()
    lan_url = f"http://{lan_ips[0]}:{port}" if lan_ips else url
    print("=" * 65)
    print("      CCTV VISION HUB - LAN & MULTI-PLATFORM SERVER")
    print("=" * 65)
    print(f"[*] Máy chủ hoạt động tại : {url}")
    print(f"[*] Chia sẻ qua mạng LAN  : {lan_url}")
    print(f"[*] Cổng lắng nghe        : {port}")
    print(f"[*] FFmpeg                : {'có' if FFMPEG.get('available') else 'KHÔNG CÓ (video bị tắt)'}")
    print("=" * 65)

    if DISABLE_ALARMS:
        print("[*] AlarmManager: tắt theo CCTV_DISABLE_ALARMS=1.")
    elif TEST_MODE:
        print("[*] AlarmManager: không khởi động trong chế độ kiểm thử.")
    else:
        ALARM_MANAGER.start()

    if not TEST_MODE and not cctv_auth.env_bool("CCTV_NO_BROWSER"):
        def open_browser():
            time.sleep(1.0)
            webbrowser.open(url)
        threading.Thread(target=open_browser, daemon=True).start()

    try:
        run(host=host, port=port, server=ThreadedServer, quiet=True)
    finally:
        cleanup_all()


if __name__ == "__main__":
    main()
