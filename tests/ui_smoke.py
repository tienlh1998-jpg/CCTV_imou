# -*- coding: utf-8 -*-
"""HTTP smoke test cho CCTV Vision Hub.

Chạy: python_env\\tools\\python.exe tests\\ui_smoke.py

Start app.py thật ở 127.0.0.1:18080 với settings/managed tạm, không AlarmManager,
không camera/Telegram/FFmpeg. Không render JS/DOM (notCovered).
"""

import http.cookiejar
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_DIR not in sys.path:
    sys.path.insert(0, PROJECT_DIR)
sys.path.insert(0, os.path.join(PROJECT_DIR, "tests"))

import support  # noqa: E402

BASE_URL = f"http://127.0.0.1:{support.TEST_PORT}"
RESULTS = []


class Result:
    def __init__(self, status, headers, body):
        self.status = int(status)
        self.headers = {str(key).lower(): value for key, value in (headers or [])}
        self.body = body or b""

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    def json(self):
        return json.loads(self.text)


class HttpClient:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf = ""

    def request(self, method, path, json_data=None, headers=None):
        data = None
        request_headers = dict(headers or {})
        if json_data is not None:
            data = json.dumps(json_data, ensure_ascii=False).encode("utf-8")
            request_headers.setdefault("Content-Type", "application/json")
        request = urllib.request.Request(BASE_URL + path, data=data,
                                         headers=request_headers, method=method)
        try:
            response = self.opener.open(request, timeout=20)
        except urllib.error.HTTPError as exc:
            response = exc
        body = response.read()
        return Result(response.status if hasattr(response, "status") else response.code,
                      list(response.headers.items()), body)

    def get(self, path, **kwargs):
        return self.request("GET", path, **kwargs)

    def post(self, path, **kwargs):
        return self.request("POST", path, **kwargs)


def record(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))
    print(("PASS  " if ok else "FAIL  ") + name + (f"  ({detail})" if detail else ""))


def login(client: HttpClient, username: str, password: str):
    response = client.post("/api/auth/login",
                           json_data={"username": username, "password": password})
    if response.status == 200:
        client.csrf = response.json().get("csrf_token", "")
    return response


def csrf_headers(client: HttpClient) -> dict:
    return {"X-CSRF-Token": client.csrf}


def port_available(port: int) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def wait_for_health(timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(BASE_URL + "/api/health", timeout=2) as response:
                if response.status == 200:
                    return True
        except Exception:
            time.sleep(0.4)
    return False


def main() -> int:
    if not port_available(support.TEST_PORT):
        print(f"NOT_COVERED: cổng {support.TEST_PORT} đang bận, không chạy ui_smoke.")
        return 2

    temp_dir = tempfile.mkdtemp(prefix="cctv-smoke-")
    support.prepare_config(temp_dir)
    env = support.build_env(temp_dir)
    log_path = os.path.join(temp_dir, "server.log")
    log_handle = open(log_path, "w", encoding="utf-8")

    process = subprocess.Popen(
        [sys.executable, os.path.join(PROJECT_DIR, "app.py")],
        cwd=PROJECT_DIR, env=env, stdout=log_handle, stderr=subprocess.STDOUT,
    )

    try:
        if not wait_for_health():
            log_handle.close()
            with open(log_path, "r", encoding="utf-8", errors="ignore") as handle:
                print("----- server log -----")
                print(handle.read()[-4000:])
            print("FAIL: server không khởi động trong 30s")
            return 1

        health = HttpClient().get("/api/health")
        payload = health.json()
        record("health 200 + mode=test + ffmpeg tắt",
               health.status == 200 and payload.get("mode") == "test"
               and payload["ffmpeg"]["available"] is False,
               f"status={health.status}")
        record("Server header không lộ Python/WSGIServer",
               "python" not in health.headers.get("server", "").lower()
               and "wsgiserver" not in health.headers.get("server", "").lower(),
               health.headers.get("server", "<absent>"))

        client = HttpClient()
        index = client.get("/")
        record("/ trả 200 và có CSP", index.status == 200
               and "script-src 'self'" in index.headers.get("content-security-policy", ""))
        record("/manifest.json 200", client.get("/manifest.json").status == 200)
        record("/sw.js 200", client.get("/sw.js").status == 200)

        css_asset = client.get("/static/css/app.css?v=2.0.1")
        js_asset = client.get("/static/js/core.js?v=2.0.1")
        css_type = css_asset.headers.get("content-type", "").lower()
        js_type = js_asset.headers.get("content-type", "").lower()
        record("CSS/JS tĩnh có MIME đúng (nosniff-safe)",
               css_asset.status == 200 and js_asset.status == 200
               and css_type.startswith("text/css")
               and (js_type.startswith("application/javascript")
                    or js_type.startswith("text/javascript")),
               f"css={css_type}, js={js_type}")

        me = client.get("/api/auth/me")
        record("auth/me anonymous", me.status == 200 and me.json().get("authenticated") is False)

        wrong = login(HttpClient(), "admin", "Sai-Mat-Khau-2026")
        record("login sai trả 401", wrong.status == 401)

        admin = HttpClient()
        login_response = login(admin, "admin", support.ADMIN_PASSWORD)
        set_cookie_values = [value for key, value in login_response.headers.items()
                             if key.lower() == "set-cookie"]
        cookie_ok = any("httponly" in value.lower() and "samesite=strict" in value.lower()
                        for value in set_cookie_values)
        record("login admin 200 + cookie HttpOnly/SameSite + có CSRF + không token JSON",
               login_response.status == 200 and bool(admin.csrf)
               and "token" not in login_response.json() and cookie_ok,
               f"status={login_response.status}, cookie={cookie_ok}")

        me_admin = admin.get("/api/auth/me")
        record("auth/me admin", me_admin.status == 200
               and me_admin.json().get("authenticated") is True
               and me_admin.json().get("role") == "admin")

        status = admin.get("/api/system/status")
        record("system/status 200, không lộ secret",
               status.status == 200 and "telegram_bot_token" not in status.text
               and support.CAMERA_PASSWORD not in status.text)

        cameras = admin.get("/api/managed/cameras")
        record("managed/cameras 200, không có password",
               cameras.status == 200 and '"password"' not in cameras.text
               and cameras.json().get("count", 0) >= 1)

        no_csrf = admin.post("/api/settings", json_data={})
        record("POST settings thiếu CSRF → 403", no_csrf.status == 403)
        settings = admin.post("/api/settings", json_data={}, headers=csrf_headers(admin))
        record("POST settings có CSRF → 200", settings.status == 200)

        scan = admin.get("/api/scan")
        record("scan fixture 200, không raw_info",
               scan.status == 200 and scan.json().get("count", 0) >= 1
               and "raw_info" not in scan.text)

        format_response = admin.post("/api/storage/format",
                                     json_data={"ip": "10.255.254.1", "confirm": "FORMAT"},
                                     headers=csrf_headers(admin))
        record("storage/format test mode → 503", format_response.status == 503)
        reboot = admin.post("/api/reboot",
                            json_data={"ips": [support.CAMERA_IP], "confirm": True},
                            headers=csrf_headers(admin))
        record("reboot test mode → 503", reboot.status == 503)
        alarm_test = admin.post("/api/alarm/test", json_data={},
                                headers=csrf_headers(admin))
        record("alarm/test test mode → 503", alarm_test.status == 503)

        viewer_disabled = login(HttpClient(), "viewer", support.VIEWER_PASSWORD)
        record("viewer login chưa bật → 403", viewer_disabled.status == 403)

        set_viewer = admin.post("/api/auth/change_password", json_data={
            "target": "viewer", "current_password": support.ADMIN_PASSWORD,
            "new_password": support.VIEWER_PASSWORD,
        }, headers=csrf_headers(admin))
        record("admin đặt mật khẩu viewer → 200", set_viewer.status == 200)

        admin2 = HttpClient()
        record("admin đăng nhập lại sau revoke",
               login(admin2, "admin", support.ADMIN_PASSWORD).status == 200)

        viewer = HttpClient()
        viewer_login = login(viewer, "viewer", support.VIEWER_PASSWORD)
        record("viewer login 200", viewer_login.status == 200
               and viewer_login.json().get("role") == "viewer")
        record("viewer system/status 200", viewer.get("/api/system/status").status == 200)
        record("viewer managed/cameras 200", viewer.get("/api/managed/cameras").status == 200)
        record("viewer settings → 403", viewer.get("/api/settings").status == 403)
        ptz = viewer.post("/api/ptz", json_data={}, headers=csrf_headers(viewer))
        record("viewer ptz → 403", ptz.status == 403)

        record("GET /api/admin/login → 404",
               admin2.get("/api/admin/login").status == 404)
        record("static ZIP cũ → 404",
               admin2.get("/static/CCTVVisionHub_Windows.zip").status == 404)
        record("static APK cũ → 404",
               admin2.get("/static/CCTVVisionHub.apk").status == 404)
        record("download APK chưa đăng nhập → 401",
               HttpClient().get("/download/app.apk").status == 401)

        media = viewer.get(f"/api/stream/mjpeg?ip={support.CAMERA_IP}")
        media_code = ""
        try:
            media_code = media.json()["error"]["code"]
        except Exception:
            media_code = ""
        record("media test mode → 503 (TEST_MODE_BLOCKED/FFMPEG_UNAVAILABLE)",
               media.status == 503 and media_code in ("TEST_MODE_BLOCKED", "FFMPEG_UNAVAILABLE"),
               f"status={media.status}, code={media_code}")

        logout = admin2.post("/api/auth/logout", json_data={},
                             headers=csrf_headers(admin2))
        record("logout → 200", logout.status == 200)

    finally:
        try:
            process.terminate()
            process.wait(timeout=10)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass
        log_handle.close()
        try:
            import shutil
            shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception:
            pass

    failures = [item for item in RESULTS if not item[1]]
    print("\n" + "=" * 70)
    print(f"TỔNG: {len(RESULTS)} check, {len(RESULTS) - len(failures)} PASS, {len(failures)} FAIL")
    if failures:
        print("FAIL: " + ", ".join(item[0] for item in failures))
    print("notCovered: render DOM/JS, 7 view, responsive, accessibility, fake camera backend.")
    print("=" * 70)
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
