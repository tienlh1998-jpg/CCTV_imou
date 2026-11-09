# -*- coding: utf-8 -*-
"""Test support cho CCTV Vision Hub: môi trường temp, WSGI client, fixture.

Tất cả test chạy ở chế độ test, dùng file cấu hình tạm trong %TEMP%,
không đọc/ghi settings.json hoặc managed_cameras.json thật, không gọi camera/Telegram.
"""

import atexit
import io
import json
import os
import shutil
import sys
import tempfile
import urllib.parse
from http.cookies import SimpleCookie

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_DIR not in sys.path:
    sys.path.insert(0, PROJECT_DIR)

ADMIN_PASSWORD = "Test-Admin-Password-2026"
VIEWER_PASSWORD = "Test-Viewer-Password-2026"
CAMERA_PASSWORD = "Test-Camera-Pass-2026"
CAMERA_IP = "10.255.255.10"
CAMERA_IP_2 = "10.255.255.11"
TEST_PORT = 18080

_CCTV_KEYS = [key for key in os.environ if key.startswith("CCTV_")]


def write_json(path: str, payload) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)


def managed_fixture() -> list:
    return [
        {
            "id": "cam_10_255_255_10",
            "name": "Camera Test 10",
            "ip": CAMERA_IP,
            "http_port": 80,
            "tcp_port": 37777,
            "rtsp_port": 554,
            "username": "testuser",
            "password": CAMERA_PASSWORD,
            "model": "IPC-TEST",
            "mac": "AA:BB:CC:DD:EE:10",
            "serial": "TEST00010",
            "firmware": "1.0.0",
            "group": "Test",
            "vlan": "VLAN 255",
            "vlan_id": "255",
            "alarm_armed": True,
            "alarm_enabled": True,
            "status": "online",
            "is_solar": False,
            "vendor": "Dahua/Imou",
            "rtsp_path": "",
            "last_seen": "2026-11-05 10:00:00",
            "note": "fixture",
        },
        {
            "id": "cam_10_255_255_11",
            "name": "Camera Test 11",
            "ip": CAMERA_IP_2,
            "http_port": 80,
            "tcp_port": 37777,
            "rtsp_port": 554,
            "username": "admin",
            "password": CAMERA_PASSWORD,
            "model": "IPC-TEST",
            "mac": "AA:BB:CC:DD:EE:11",
            "serial": "TEST00011",
            "firmware": "1.0.0",
            "group": "Test",
            "vlan": "VLAN 255",
            "vlan_id": "255",
            "alarm_armed": True,
            "alarm_enabled": True,
            "status": "unknown",
            "is_solar": False,
            "vendor": "Dahua/Imou",
            "rtsp_path": "",
            "last_seen": "2026-11-05 10:00:00",
            "note": "fixture",
        },
    ]


def settings_fixture() -> dict:
    return {
        "schema_version": 2,
        "scan_timeout": 1.5,
        "last_subnets": "10.255.255.0/24",
        "deep_scan": True,
        "selected_vlans": [],
        "company_vlans": [
            {"vlan": "255", "subnet": "10.255.255.0/24", "label": "Test VLAN"}
        ],
        "telegram_enabled": False,
        "telegram_schedule_enabled": True,
        "telegram_schedule_start": "18:00",
        "telegram_schedule_end": "07:00",
        "telegram_cooldown_seconds": 60,
        "telegram_ai_filter_human": True,
        "telegram_armed_cameras": [],
        "telegram_storage_alerts": False,
        "telegram_storage_check_interval": 60,
        "alarm_startup_grace_seconds": 15,
    }


def prepare_config(temp_dir: str, settings: dict = None, managed: list = None) -> dict:
    os.makedirs(temp_dir, exist_ok=True)
    for sub in ("recordings", "snapshots", "data"):
        os.makedirs(os.path.join(temp_dir, sub), exist_ok=True)
    settings_path = os.path.join(temp_dir, "settings.json")
    managed_path = os.path.join(temp_dir, "managed_cameras.json")
    write_json(settings_path, settings_fixture() if settings is None else settings)
    write_json(managed_path, managed_fixture() if managed is None else managed)
    return {"settings": settings_path, "managed": managed_path}


def build_env(temp_dir: str, *, port: int = TEST_PORT, admin_password=ADMIN_PASSWORD,
              extra: dict = None) -> dict:
    env = dict(os.environ)
    for key in list(env):
        if key.startswith("CCTV_"):
            env.pop(key)
    env.update({
        "CCTV_TEST_MODE": "1",
        "CCTV_DISABLE_ALARMS": "1",
        "CCTV_DISABLE_TELEGRAM": "1",
        "CCTV_DISABLE_FFMPEG": "1",
        "CCTV_DISABLE_BROWSER": "1",
        "CCTV_NO_BROWSER": "1",
        "CCTV_SETTINGS_FILE": os.path.join(temp_dir, "settings.json"),
        "CCTV_MANAGED_FILE": os.path.join(temp_dir, "managed_cameras.json"),
        "CCTV_BOOTSTRAP_FILE": os.path.join(temp_dir, "data", "bootstrap_admin.txt"),
        "CCTV_AUDIT_LOG": os.path.join(temp_dir, "audit.jsonl"),
        "CCTV_RECORDINGS_DIR": os.path.join(temp_dir, "recordings"),
        "CCTV_SNAPSHOTS_DIR": os.path.join(temp_dir, "snapshots"),
        "CCTV_ALLOWED_STORAGE_ROOTS": temp_dir,
        "CCTV_ALLOW_EXTERNAL_STORAGE": "1",
        "CCTV_HOST": "127.0.0.1",
        "CCTV_PORT": str(port),
        "CCTV_TEST_SCAN_FIXTURE": os.path.join(PROJECT_DIR, "tests", "fixtures", "scan_devices.json"),
    })
    if admin_password is not None:
        env["CCTV_ADMIN_PASSWORD"] = admin_password
    if extra:
        env.update({str(key): str(value) for key, value in extra.items()})
    return env


# -- Môi trường dùng chung cho test in-process ----------------------------------

TEST_DIR = tempfile.mkdtemp(prefix="cctv-test-")
prepare_config(TEST_DIR)
ENV = build_env(TEST_DIR)
for _key in _CCTV_KEYS:
    os.environ.pop(_key, None)
os.environ.update(ENV)

_APP = None


def ensure_app():
    """Import app một lần sau khi env test đã được đặt."""
    global _APP
    if _APP is None:
        import app as app_module
        _APP = app_module
    return _APP


def reset_auth_state() -> None:
    """Đưa auth về trạng thái xác định giữa các test (chỉ trong temp settings)."""
    import auth as auth_module
    app_module = ensure_app()
    manager = app_module.AUTH
    manager.login_limiter.reset()
    manager.login_attempt_limiter.reset()
    auth_module.reset_rate_limiters()
    manager.sessions.revoke_all()
    manager.update_hash("admin", auth_module.hash_password(ADMIN_PASSWORD), bootstrap=True)
    manager.clear_viewer_password()


def reset_data_state() -> None:
    app_module = ensure_app()
    with app_module._CACHED_DEVICES_LOCK:
        app_module.CACHED_DEVICES = []
    with app_module._EPHEMERAL_LOCK:
        app_module._EPHEMERAL_CREDENTIALS.clear()


@atexit.register
def _cleanup():
    try:
        shutil.rmtree(TEST_DIR, ignore_errors=True)
    except Exception:
        pass


# -- WSGI client ---------------------------------------------------------------

class Response:
    def __init__(self, status_line: str, headers: list, body: bytes):
        self.status_line = status_line
        self.status_code = int(str(status_line).split()[0])
        self.header_list = list(headers or [])
        self.headers = {str(key).lower(): value for key, value in self.header_list}
        self.body = body or b""
        self.set_cookie_headers = [
            value for key, value in self.header_list if str(key).lower() == "set-cookie"
        ]

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    def json(self):
        return json.loads(self.body.decode("utf-8"))


class Client:
    def __init__(self, remote_addr: str = "127.0.0.1", host: str = None,
                 port: int = TEST_PORT):
        self.remote_addr = remote_addr
        self.host = host or f"127.0.0.1:{port}"
        self.port = port
        self.cookies: dict[str, str] = {}

    def _update_cookies(self, set_cookie_headers) -> None:
        for raw in set_cookie_headers:
            cookie = SimpleCookie()
            try:
                cookie.load(raw)
            except Exception:
                continue
            for key, morsel in cookie.items():
                if str(morsel.get("max-age", "")) == "0" or morsel.value == "":
                    self.cookies.pop(key, None)
                else:
                    self.cookies[key] = morsel.value

    def request(self, method: str, path: str, *, json_data=None, data=None,
                headers: dict = None, host: str = None, remote_addr: str = None,
                content_type: str = None, cookie_override: dict = None) -> Response:
        from bottle import default_app

        app_module = ensure_app()
        split = urllib.parse.urlsplit(path)
        path_info = urllib.parse.unquote(split.path) or "/"
        query = split.query

        body = b""
        request_headers = {"Host": host or self.host}
        if json_data is not None:
            body = json.dumps(json_data, ensure_ascii=False).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        elif data is not None:
            body = data.encode("utf-8") if isinstance(data, str) else data
            if content_type:
                request_headers["Content-Type"] = content_type
            elif body:
                request_headers["Content-Type"] = "application/json"
        if headers:
            request_headers.update(headers)

        jar = self.cookies if cookie_override is None else cookie_override
        if jar:
            request_headers["Cookie"] = "; ".join(f"{key}={value}" for key, value in jar.items())

        environ = {
            "REQUEST_METHOD": method.upper(),
            "SCRIPT_NAME": "",
            "PATH_INFO": path_info,
            "QUERY_STRING": query,
            "SERVER_NAME": "127.0.0.1",
            "SERVER_PORT": str(self.port),
            "SERVER_PROTOCOL": "HTTP/1.1",
            "REMOTE_ADDR": remote_addr or self.remote_addr,
            "wsgi.version": (1, 0),
            "wsgi.url_scheme": "http",
            "wsgi.input": io.BytesIO(body),
            "wsgi.errors": sys.stderr,
            "wsgi.multithread": False,
            "wsgi.multiprocess": False,
            "wsgi.run_once": False,
            "CONTENT_LENGTH": str(len(body)),
            "CONTENT_TYPE": request_headers.get("Content-Type", ""),
        }
        for key, value in request_headers.items():
            if key.lower() == "host":
                environ["HTTP_HOST"] = value
            elif key.lower() in ("content-type", "content-length"):
                continue
            else:
                environ["HTTP_" + key.upper().replace("-", "_")] = str(value)

        captured = {}

        def start_response(status, response_headers, exc_info=None):
            captured["status"] = status
            captured["headers"] = response_headers

        result = default_app()(environ, start_response)
        chunks = []
        for chunk in result:
            chunks.append(chunk if isinstance(chunk, bytes) else str(chunk).encode("utf-8"))
        if hasattr(result, "close"):
            try:
                result.close()
            except Exception:
                pass
        response = Response(captured.get("status", "500 Internal Server Error"),
                            captured.get("headers", []), b"".join(chunks))
        self._update_cookies(response.set_cookie_headers)
        return response

    def get(self, path, **kwargs):
        return self.request("GET", path, **kwargs)

    def post(self, path, **kwargs):
        return self.request("POST", path, **kwargs)

    def put(self, path, **kwargs):
        return self.request("PUT", path, **kwargs)

    def delete(self, path, **kwargs):
        return self.request("DELETE", path, **kwargs)


def login(client: Client, username: str = "admin", password: str = ADMIN_PASSWORD):
    response = client.post("/api/auth/login", json_data={"username": username, "password": password})
    csrf = ""
    if response.status_code == 200:
        try:
            csrf = response.json().get("csrf_token", "")
        except Exception:
            csrf = ""
    return response, csrf


def admin_client(remote_addr: str = "10.90.0.1"):
    client = Client(remote_addr=remote_addr)
    response, csrf = login(client)
    if response.status_code != 200:
        raise RuntimeError(f"Không đăng nhập được admin trong test: {response.status_code} {response.text}")
    return client, csrf


def enable_viewer_directly() -> None:
    import auth as auth_module
    app_module = ensure_app()
    app_module.AUTH.update_hash("viewer", auth_module.hash_password(VIEWER_PASSWORD))


def viewer_client(remote_addr: str = "10.90.0.2"):
    enable_viewer_directly()
    client = Client(remote_addr=remote_addr)
    response, csrf = login(client, "viewer", VIEWER_PASSWORD)
    if response.status_code != 200:
        raise RuntimeError(f"Không đăng nhập được viewer trong test: {response.status_code} {response.text}")
    return client, csrf
