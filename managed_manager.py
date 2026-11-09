"""
Managed Cameras Manager - Quản trị Danh sách Camera Cố định (NVR / VMS Style).
Chức năng:
- Lưu trữ hồ sơ camera vĩnh viễn vào managed_cameras.json (atomic + lock).
- Không hardcode mật khẩu camera mặc định.
- Kiểm tra kết nối & giám sát sức khỏe thiết bị (Heartbeat / Ping Worker).
- Phân nhóm khu vực và cấu hình báo động độc lập từng kênh.
- `public_view()` loại bỏ mật khẩu và các trường nhạy cảm trước khi trả API.
"""

import os
import json
import time
import socket
import logging
import threading
import datetime
import concurrent.futures
from typing import Optional

from onvif_manager import get_device_full_details

logger = logging.getLogger("managed_manager")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MANAGED_FILE = os.path.abspath(os.environ.get("CCTV_MANAGED_FILE") or os.path.join(BASE_DIR, "managed_cameras.json"))
MANAGED_LOCK = threading.RLock()

TEST_MODE = str(os.environ.get("CCTV_TEST_MODE", "")).strip().lower() in {"1", "true", "yes", "on"}
DISABLE_ENRICHMENT = TEST_MODE or str(
    os.environ.get("CCTV_DISABLE_CAMERA_ENRICHMENT", "")
).strip().lower() in {"1", "true", "yes", "on"}

_VALID_STATUS = {"online", "offline", "auth_failed", "solar_sleep", "unknown"}
_alarm_state_defaulted = False


def _secure_permissions(path: str) -> None:
    if os.name != "posix":
        return
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def normalise_status(value) -> str:
    status = str(value or "").strip().lower().replace(" ", "_").replace("-", "_")
    aliases = {
        "online": "online",
        "offline": "offline",
        "auth_failed": "auth_failed",
        "authentication_failed": "auth_failed",
        "solar_sleep": "solar_sleep",
        "unknown": "unknown",
    }
    return aliases.get(status, "unknown")


def _armed_value(camera: dict, set_default_flag: bool = False) -> bool:
    global _alarm_state_defaulted
    armed = camera.get("alarm_armed")
    enabled = camera.get("alarm_enabled")
    if armed is not None and enabled is None:
        return bool(armed)
    if enabled is not None and armed is None:
        return bool(enabled)
    if armed is not None and enabled is not None:
        return bool(armed and enabled)
    if set_default_flag:
        _alarm_state_defaulted = True
    return True


def alarm_state_defaulted() -> bool:
    return _alarm_state_defaulted


def load_managed_cameras() -> list[dict]:
    """Đọc danh sách camera quản lý từ tệp JSON (thread-safe)."""
    with MANAGED_LOCK:
        if os.path.exists(MANAGED_FILE):
            try:
                with open(MANAGED_FILE, "r", encoding="utf-8") as handle:
                    data = json.load(handle)
                if isinstance(data, list):
                    for camera in data:
                        value = _armed_value(camera, set_default_flag=True)
                        camera["alarm_armed"] = value
                        camera["alarm_enabled"] = value
                    return data
            except Exception as exc:
                logger.error("[ManagedManager] Lỗi đọc %s: %s", MANAGED_FILE, exc)
        return []


def save_managed_cameras(cameras: list[dict]) -> bool:
    """Ghi danh sách camera (atomic replace + lock)."""
    with MANAGED_LOCK:
        try:
            for camera in cameras:
                value = _armed_value(camera)
                camera["alarm_armed"] = value
                camera["alarm_enabled"] = value
                camera["status"] = normalise_status(camera.get("status"))
            parent = os.path.dirname(os.path.abspath(MANAGED_FILE))
            if parent:
                os.makedirs(parent, exist_ok=True)
            temp_file = f"{MANAGED_FILE}.tmp"
            with open(temp_file, "w", encoding="utf-8") as handle:
                json.dump(cameras, handle, indent=2, ensure_ascii=False)
            os.replace(temp_file, MANAGED_FILE)
            _secure_permissions(MANAGED_FILE)
            return True
        except Exception as exc:
            logger.error("[ManagedManager] Lỗi ghi %s: %s", MANAGED_FILE, exc)
            return False


def get_managed_camera(cam_id_or_ip: str) -> Optional[dict]:
    """Tìm camera theo ID hoặc IP."""
    target = str(cam_id_or_ip).strip()
    for camera in load_managed_cameras():
        if camera.get("id") == target or camera.get("ip") == target:
            return camera
    return None


def generate_cam_id(ip: str, mac: str = "") -> str:
    if mac:
        clean_mac = "".join(char for char in mac.lower() if char in "0123456789abcdef")
        if len(clean_mac) >= 6:
            return f"cam_{clean_mac}"
    return f"cam_{ip.replace('.', '_')}"


def public_view(camera: dict, is_admin: bool = True) -> dict:
    """Loại bỏ password/alarm_enabled/raw_info; viewer ẩn username/note/rtsp_path."""
    output = {
        key: value for key, value in (camera or {}).items()
        if key not in {"password", "alarm_enabled", "raw_info"}
    }
    output["status"] = normalise_status((camera or {}).get("status"))
    output["alarm_armed"] = _armed_value(camera or {})
    output["has_password"] = bool(str((camera or {}).get("password") or "").strip())
    if not is_admin:
        for key in ("username", "note", "rtsp_path"):
            output.pop(key, None)
    return output


def add_managed_camera(data: dict) -> dict:
    """Thêm mới hoặc cập nhật camera theo IP/ID. Không tự điền mật khẩu mặc định."""
    ip = str(data.get("ip", "")).strip()
    if not ip:
        return {"ok": False, "error": "Thiếu địa chỉ IP của camera!"}

    with MANAGED_LOCK:
        cameras = load_managed_cameras()
        mac = str(data.get("mac", "") or "").strip()
        cam_id = data.get("id") or generate_cam_id(ip, mac)

        existing_idx = None
        for index, camera in enumerate(cameras):
            if camera.get("id") == cam_id or camera.get("ip") == ip:
                existing_idx = index
                break

        now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        password = str(data.get("password") or "").strip()
        if existing_idx is not None and not password:
            password = str(cameras[existing_idx].get("password") or "")
        if not password:
            logger.warning(
                "[ManagedManager] Camera %s được lưu không có mật khẩu; "
                "stream/PTZ sẽ yêu cầu credential tạm.", ip
            )

        new_camera = {
            "id": cam_id,
            "name": (str(data.get("name") or data.get("model") or f"Camera {ip}").strip())[:64],
            "ip": ip,
            "http_port": int(data.get("http_port") or 80),
            "tcp_port": int(data.get("tcp_port") or 37777),
            "rtsp_port": int(data.get("rtsp_port") or 554),
            "username": (str(data.get("username") or "admin").strip())[:64] or "admin",
            "password": password,
            "model": (str(data.get("model") or "IPC").strip())[:64],
            "mac": mac,
            "serial": str(data.get("serial", "") or "").strip(),
            "firmware": str(data.get("firmware", "") or "").strip(),
            "group": (str(data.get("group") or "Mặc định").strip())[:32],
            "vlan": str(data.get("vlan") or f"VLAN {ip.split('.')[2] if '.' in ip else ''}"),
            "vlan_id": str(data.get("vlan_id") or (ip.split('.')[2] if '.' in ip else "")),
            "alarm_armed": bool(data.get("alarm_armed", data.get("alarm_enabled", True))),
            "alarm_enabled": bool(data.get("alarm_armed", data.get("alarm_enabled", True))),
            "status": normalise_status(data.get("status") or "unknown"),
            "is_solar": bool(data.get("is_solar", False)),
            "vendor": (str(data.get("vendor") or "Dahua/Imou").strip())[:32],
            "rtsp_path": str(data.get("rtsp_path") or "").strip(),
            "last_seen": now_str,
            "last_updated": now_str,
            "note": str(data.get("note") or "").strip()[:500],
        }

        # Làm giàu thông tin qua ONVIF/Dahua nếu thiếu model/serial (không chạy trong test).
        if not DISABLE_ENRICHMENT and password and (
            new_camera["model"] in ("IPC", "N/A", "") or not new_camera["serial"]
        ):
            try:
                details = get_device_full_details(ip, new_camera["username"], password)
                if details.get("model") and details.get("model") != "N/A":
                    new_camera["model"] = details["model"]
                if details.get("serial") and details.get("serial") != "N/A":
                    new_camera["serial"] = details["serial"]
                if details.get("firmware") and details.get("firmware") != "N/A":
                    new_camera["firmware"] = details["firmware"]
                if details.get("mac") and not new_camera["mac"]:
                    new_camera["mac"] = details["mac"]
            except Exception:
                pass

        if existing_idx is not None:
            new_camera["created_at"] = cameras[existing_idx].get("created_at", now_str)
            cameras[existing_idx].update(new_camera)
            action_msg = f"Đã cập nhật camera: {new_camera['name']} ({ip})"
        else:
            new_camera["created_at"] = now_str
            cameras.append(new_camera)
            action_msg = f"Đã thêm mới camera: {new_camera['name']} ({ip})"

        success = save_managed_cameras(cameras)
        if success:
            return {"ok": True, "camera": new_camera, "message": action_msg}
        return {"ok": False, "error": "Không thể lưu tệp managed_cameras.json"}


def add_batch_managed_cameras(devices: list[dict], default_pwd: str = "") -> dict:
    """Thêm hàng loạt camera từ kết quả quét mạng."""
    if not devices:
        return {"ok": False, "error": "Danh sách camera trống!"}

    added_count = 0
    updated_count = 0
    errors = []

    for item in devices:
        camera_data = dict(item)
        if not camera_data.get("password") and default_pwd:
            camera_data["password"] = default_pwd
        if not camera_data.get("password"):
            existing = get_managed_camera(str(camera_data.get("ip") or ""))
            if not existing:
                errors.append(f"{camera_data.get('ip')}: CAMERA_PASSWORD_REQUIRED")
                continue
        result = add_managed_camera(camera_data)
        if result.get("ok"):
            if "thêm mới" in result.get("message", ""):
                added_count += 1
            else:
                updated_count += 1
        else:
            errors.append(f"{camera_data.get('ip')}: {result.get('error')}")

    total = added_count + updated_count
    return {
        "ok": True,
        "total": total,
        "added_count": added_count,
        "updated_count": updated_count,
        "message": f"Đã đưa {total} camera vào quản lý ({added_count} mới, {updated_count} cập nhật).",
        "errors": errors,
    }


def update_managed_camera(cam_id_or_ip: str, updates: dict) -> dict:
    """Cập nhật trường cấu hình của camera (password rỗng = giữ nguyên)."""
    with MANAGED_LOCK:
        cameras = load_managed_cameras()
        target_index = None
        for index, camera in enumerate(cameras):
            if camera.get("id") == cam_id_or_ip or camera.get("ip") == cam_id_or_ip:
                target_index = index
                break

        if target_index is None:
            return {"ok": False, "error": f"Không tìm thấy camera {cam_id_or_ip}"}

        camera = cameras[target_index]
        allowed_fields = [
            "name", "ip", "http_port", "tcp_port", "rtsp_port",
            "username", "password", "group", "note", "alarm_armed",
            "vendor", "rtsp_path", "model",
        ]
        for key in allowed_fields:
            if key in updates:
                if key == "password" and not str(updates[key]).strip():
                    continue
                camera[key] = updates[key]

        if "alarm_armed" in updates or "alarm_enabled" in updates:
            value = updates.get("alarm_armed")
            if value is None:
                value = updates.get("alarm_enabled")
            camera["alarm_armed"] = bool(value)
            camera["alarm_enabled"] = bool(value)

        camera["status"] = normalise_status(camera.get("status"))
        camera["last_updated"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        success = save_managed_cameras(cameras)
        if success:
            return {"ok": True, "camera": camera, "message": f"Đã cập nhật camera: {camera.get('name')}"}
        return {"ok": False, "error": "Lỗi lưu cấu hình camera"}


def delete_managed_camera(cam_id_or_ip: str) -> dict:
    with MANAGED_LOCK:
        cameras = load_managed_cameras()
        remaining = [
            camera for camera in cameras
            if camera.get("id") != cam_id_or_ip and camera.get("ip") != cam_id_or_ip
        ]
        if len(remaining) == len(cameras):
            return {"ok": False, "error": f"Không tìm thấy camera {cam_id_or_ip}"}
        if save_managed_cameras(remaining):
            return {"ok": True, "message": "Đã xóa camera khỏi danh sách quản lý thành công!"}
        return {"ok": False, "error": "Không thể cập nhật tệp managed_cameras.json"}


def toggle_camera_alarm(cam_id_or_ip: str, state: Optional[bool] = None) -> dict:
    with MANAGED_LOCK:
        cameras = load_managed_cameras()
        target_camera = None
        for camera in cameras:
            if camera.get("id") == cam_id_or_ip or camera.get("ip") == cam_id_or_ip:
                target_camera = camera
                break
        if not target_camera:
            return {"ok": False, "error": f"Không tìm thấy camera {cam_id_or_ip}"}

        if state is None:
            current = target_camera.get("alarm_armed")
            if current is None:
                current = target_camera.get("alarm_enabled", True)
            new_state = not bool(current)
        else:
            new_state = bool(state)

        target_camera["alarm_enabled"] = new_state
        target_camera["alarm_armed"] = new_state
        save_managed_cameras(cameras)

    status_text = "BẬT" if new_state else "TẮT"
    return {
        "ok": True,
        "id": target_camera["id"],
        "alarm_armed": new_state,
        "message": f"Đã {status_text} gác báo động cho {target_camera.get('name')}!",
    }


def test_camera_connection(ip: str, port: int = 80, username: str = "admin",
                           password: str = "", timeout: float = 2.0) -> dict:
    """Kiểm tra TCP + xác thực tài khoản camera. Không trả mật khẩu."""
    ip = str(ip).strip()
    if not ip:
        return {"ok": False, "error": "Thiếu địa chỉ IP"}

    started = time.time()
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        code = sock.connect_ex((ip, int(port)))
        latency_ms = round((time.time() - started) * 1000, 1)
        sock.close()
    except Exception as exc:
        return {"ok": False, "error": f"Lỗi kết nối mạng: {exc}"}

    if code != 0:
        return {
            "ok": False,
            "error": f"Không thể kết nối tới {ip}:{port} (Cổng đóng hoặc thiết bị ngoại tuyến).",
        }

    device_info = {}
    auth_ok = True
    try:
        device_info = get_device_full_details(ip, username, password)
        if not device_info or device_info.get("model") == "N/A":
            auth_ok = False
    except Exception as exc:
        auth_ok = False
        device_info = {"error": str(exc)}

    return {
        "ok": True,
        "ip": ip,
        "port": port,
        "ping_ms": latency_ms,
        "auth_ok": auth_ok,
        "model": device_info.get("model", "Dahua / Imou"),
        "serial": device_info.get("serial", ""),
        "firmware": device_info.get("firmware", ""),
        "message": (
            f"Kết nối thành công ({latency_ms}ms)" if auth_ok
            else f"Kết nối được cổng {port}, kiểm tra lại mật khẩu!"
        ),
    }


def sync_cameras_health(timeout: float = 1.5) -> list[dict]:
    """Ping song song toàn bộ camera đã lưu; trả danh sách đã cập nhật."""
    cameras = load_managed_cameras()
    if not cameras:
        return []

    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    def ping_camera(camera):
        ip = camera.get("ip")
        try:
            port = int(camera.get("http_port") or 80)
        except (TypeError, ValueError):
            port = 80
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        try:
            code = sock.connect_ex((ip, port))
            sock.close()
            if code == 0:
                camera["status"] = "online"
                camera["last_seen"] = now_str
            else:
                second = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                second.settimeout(timeout)
                try:
                    second_code = second.connect_ex((ip, int(camera.get("tcp_port") or 37777)))
                finally:
                    second.close()
                if second_code == 0:
                    camera["status"] = "online"
                    camera["last_seen"] = now_str
                else:
                    camera["status"] = "solar_sleep" if camera.get("is_solar") else "offline"
        except Exception:
            try:
                sock.close()
            except Exception:
                pass
            camera["status"] = "solar_sleep" if camera.get("is_solar") else "offline"
        camera["last_updated"] = now_str
        return camera

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        updated = list(executor.map(ping_camera, cameras))

    save_managed_cameras(updated)
    return updated
