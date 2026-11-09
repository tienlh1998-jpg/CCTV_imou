# -*- coding: utf-8 -*-
"""Kiểm thử bảo mật tự động cho CCTV Vision Hub.

Chạy: python_env\\tools\\python.exe -m unittest discover -s tests -v
Môi trường: CCTV_TEST_MODE=1, settings/managed tạm, không camera/Telegram/FFmpeg.
"""

import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
import unittest

import support


def _json(response):
    try:
        return response.json()
    except Exception:
        return {}


def _error_code(response) -> str:
    payload = _json(response)
    error = payload.get("error")
    return error.get("code", "") if isinstance(error, dict) else ""


class SecurityTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        support.ensure_app()

    def setUp(self):
        support.reset_auth_state()
        support.reset_data_state()


# ==============================================================================
# Unit: password hash, session, rate limiter, alarm, telegram, managed
# ==============================================================================

class PasswordHashTests(unittest.TestCase):
    def test_scrypt_format_and_verify(self):
        import auth
        stored = auth.hash_password("Abcdefghij-123")
        self.assertRegex(stored, r"^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$")
        ok, needs_rehash = auth.verify_password("Abcdefghij-123", stored)
        self.assertTrue(ok)
        self.assertFalse(needs_rehash)
        self.assertFalse(auth.verify_password("wrong-password", stored)[0])
        self.assertFalse(auth.verify_password("Abcdefghij-123", "not-a-hash")[0])

    def test_needs_rehash_when_params_change(self):
        import auth
        stored = auth.hash_password("Abcdefghij-123", n=16384)
        ok, needs_rehash = auth.verify_password("Abcdefghij-123", stored)
        self.assertTrue(ok)
        self.assertTrue(needs_rehash)

    def test_password_policy(self):
        import auth
        self.assertIsNotNone(auth.validate_new_password("short"))
        self.assertIsNotNone(auth.validate_new_password("password"))
        self.assertIsNotNone(auth.validate_new_password("Admin@1998"))
        self.assertIsNone(auth.validate_new_password("Mot-Mat-Khau-Manh-2026"))


class SessionStoreTests(unittest.TestCase):
    def test_ttl_absolute(self):
        import auth
        clock = [1000.0]
        store = auth.SessionStore(ttl_seconds=100, now_fn=lambda: clock[0])
        token, csrf, record = store.create("admin", "admin")
        self.assertIsNotNone(store.get(token))
        self.assertTrue(store.csrf_valid(record, csrf))
        self.assertTrue(store.get(token) is not None)
        clock[0] += 101
        self.assertIsNone(store.get(token))

    def test_revoke_all(self):
        import auth
        store = auth.SessionStore(ttl_seconds=100)
        store.create("admin", "admin")
        store.create("viewer", "viewer")
        self.assertEqual(store.revoke_all(), 2)
        self.assertEqual(store.count(), 0)

    def test_csrf_mismatch(self):
        import auth
        store = auth.SessionStore(ttl_seconds=100)
        _, csrf, record = store.create("admin", "admin")
        self.assertFalse(store.csrf_valid(record, "sai-token"))
        self.assertTrue(store.csrf_valid(record, csrf))

    def test_per_user_cap_evicts_oldest_and_keeps_admin_slots(self):
        import auth
        store = auth.SessionStore(ttl_seconds=100, max_sessions=500,
                                  max_sessions_per_user=3)
        for _ in range(10):
            store.create("viewer", "viewer")
        # Một viewer xoay vòng session không thể chiếm hạn mức toàn cục.
        self.assertEqual(store.count(), 3)
        token, _, _ = store.create("admin", "admin")
        self.assertIsNotNone(store.get(token))
        self.assertEqual(store.count(), 4)


class LoginRateLimiterTests(unittest.TestCase):
    def test_five_failures_then_block_and_recovery(self):
        import auth
        clock = [1000.0]
        limiter = auth.LoginRateLimiter(now_fn=lambda: clock[0])
        for _ in range(5):
            limiter.record_failure("10.0.0.9", "admin")
        self.assertGreater(limiter.retry_after("10.0.0.9", "admin"), 0)
        clock[0] += 301
        self.assertEqual(limiter.retry_after("10.0.0.9", "admin"), 0)

    def test_success_resets_user_bucket(self):
        import auth
        clock = [1000.0]
        limiter = auth.LoginRateLimiter(now_fn=lambda: clock[0])
        for _ in range(4):
            limiter.record_failure("10.0.0.10", "admin")
        limiter.record_success("10.0.0.10", "admin")
        self.assertEqual(limiter.retry_after("10.0.0.10", "admin"), 0)


class AlarmManagerTests(unittest.TestCase):
    def _manager(self, settings):
        from alarm_manager import AlarmManager
        return AlarmManager(settings_getter=lambda: settings,
                            get_cached_devices=lambda: [])

    def test_grace_period_ignores_events(self):
        settings = {
            "alarm_startup_grace_seconds": 15,
            "telegram_enabled": True,
            "telegram_ai_filter_human": True,
            "telegram_cooldown_seconds": 60,
        }
        manager = self._manager(settings)
        manager._started_at = time.time()
        manager._handle_incoming_event("10.255.255.10", {"Action": "Start", "Code": "VideoMotion"})
        self.assertEqual(manager.get_history(), [])
        self.assertGreater(manager.grace_remaining_seconds(), 0)

    def test_after_grace_event_logged_and_titles_clean(self):
        settings = {
            "alarm_startup_grace_seconds": 15,
            "telegram_enabled": False,
            "telegram_ai_filter_human": True,
            "telegram_cooldown_seconds": 60,
        }
        manager = self._manager(settings)
        manager._started_at = time.time() - 20
        manager._handle_incoming_event("10.255.255.10", {"Action": "Start", "Code": "VideoMotion"})
        history = manager.get_history()
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["status"], "skipped")
        self.assertNotIn("🏃", history[0]["title"])
        self.assertIn("chuyển động", history[0]["title"].lower())

    def test_status_maps_history_enum(self):
        from alarm_manager import AlarmManager
        self.assertEqual(AlarmManager._map_history_status("Đã gửi Telegram thành công"), "sent")
        self.assertEqual(AlarmManager._map_history_status("Lỗi Telegram: x"), "failed")
        self.assertEqual(AlarmManager._map_history_status("Bỏ qua (Chưa bật Telegram)"), "skipped")
        self.assertEqual(AlarmManager._map_history_status("Bỏ qua (Giãn cách còn 5s)"), "suppressed")

    def test_status_storage_watchdog_sanitized(self):
        manager = self._manager({"telegram_cooldown_seconds": 60})
        manager._storage_states = {
            "10.255.255.10": {
                "name": "Cam", "has_sd": True, "in_error": True,
                "error_reason": "raw error", "state": "Fail", "total_gb": 10,
                "used_gb": 5, "last_check": time.time(),
            }
        }
        states = manager.get_status()["storage_watchdog"]["states"]
        self.assertEqual(set(states["10.255.255.10"].keys()),
                         {"name", "status", "error_code", "last_check"})
        self.assertEqual(states["10.255.255.10"]["status"], "error")
        self.assertNotIn("raw error", json.dumps(states))

    def test_grace_default_is_fifteen(self):
        manager = self._manager({})
        self.assertEqual(manager.grace_seconds(), 15)


class TelegramTlsTests(unittest.TestCase):
    def test_ssl_context_is_strict(self):
        import telegram_service
        context = telegram_service._get_ssl_context()
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

    def test_no_cert_none_patterns(self):
        import telegram_service
        with open(telegram_service.__file__, "r", encoding="utf-8") as handle:
            source = handle.read()
        self.assertNotIn("CERT_NONE", source)
        self.assertNotIn("check_hostname = False", source)
        self.assertNotIn("verify=False", source)

    def test_token_redaction(self):
        import telegram_service
        text = "https://api.telegram.org/bot123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh/sendMessage"
        self.assertNotIn("123456789:", telegram_service._redact(text))


class ManagedViewTests(unittest.TestCase):
    def test_public_view_removes_secrets(self):
        import managed_manager
        camera = {
            "id": "cam_x", "ip": "10.255.255.10", "password": "secret",
            "username": "admin", "note": "n", "rtsp_path": "", "status": "Online",
            "alarm_enabled": True, "alarm_armed": True,
        }
        admin_view = managed_manager.public_view(camera, is_admin=True)
        self.assertNotIn("password", admin_view)
        self.assertNotIn("alarm_enabled", admin_view)
        self.assertTrue(admin_view["has_password"])
        self.assertEqual(admin_view["status"], "online")

        viewer_view = managed_manager.public_view(camera, is_admin=False)
        for key in ("username", "note", "rtsp_path"):
            self.assertNotIn(key, viewer_view)


# ==============================================================================
# Public routes / static / PWA
# ==============================================================================

class PublicRouteTests(SecurityTestCase):
    def test_health_public_no_cookie(self):
        response = support.Client().get("/api/health")
        self.assertEqual(response.status_code, 200)
        payload = _json(response)
        self.assertTrue(payload.get("ok"))
        self.assertIn(payload.get("status"), ("ok", "degraded"))
        self.assertEqual(payload.get("mode"), "test")
        self.assertFalse(payload["ffmpeg"]["available"])
        self.assertEqual(response.set_cookie_headers, [])
        self.assertNotIn("session", json.dumps(payload).lower())

    def test_auth_me_anonymous(self):
        response = support.Client().get("/api/auth/me")
        self.assertEqual(response.status_code, 200)
        payload = _json(response)
        self.assertFalse(payload.get("authenticated"))
        self.assertIn("viewer_login_enabled", payload)
        self.assertEqual(response.set_cookie_headers, [])

    def test_index_manifest_sw(self):
        client = support.Client()
        self.assertEqual(client.get("/").status_code, 200)
        self.assertEqual(client.get("/manifest.json").status_code, 200)
        self.assertEqual(client.get("/sw.js").status_code, 200)
        self.assertEqual(client.get("/favicon.ico").status_code, 200)

    def test_static_denies_zip_apk_and_secrets(self):
        client = support.Client()
        for path in (
            "/static/CCTVVisionHub_Windows.zip",
            "/static/CCTVVisionHub.apk",
            "/static/manifest.json",
            "/static/sw.js.map",
            "/static/../settings.json",
            "/settings.json",
            "/managed_cameras.json",
        ):
            with self.subTest(path=path):
                self.assertIn(client.get(path).status_code, (403, 404))

    def test_admin_routes_removed_even_with_admin_cookie(self):
        client, csrf = support.admin_client()
        self.assertEqual(client.get("/api/admin/verify").status_code, 404)
        for path in ("/api/admin/login", "/api/admin/logout", "/api/admin/change_password"):
            with self.subTest(path=path):
                response = client.post(path, json_data={}, headers={"X-CSRF-Token": csrf})
                self.assertEqual(response.status_code, 404, response.text)

    def test_download_apk_requires_login(self):
        self.assertEqual(support.Client().get("/download/app.apk").status_code, 401)
        client, _csrf = support.enable_viewer_and_login()
        response = client.get("/download/app.apk")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(_error_code(response), "APK_NOT_AVAILABLE")


# helper bổ sung (không phải test)
def _enable_viewer_and_login():
    support.enable_viewer_directly()
    client = support.Client(remote_addr="10.90.1.2")
    response, csrf = support.login(client, "viewer", support.VIEWER_PASSWORD)
    return client, csrf


support.enable_viewer_and_login = _enable_viewer_and_login


# ==============================================================================
# Login / session / cookie
# ==============================================================================

class AuthSessionTests(SecurityTestCase):
    def test_login_success_cookie_flags_and_no_token_in_json(self):
        client = support.Client(remote_addr="10.91.0.1")
        response, csrf = support.login(client)
        self.assertEqual(response.status_code, 200, response.text)
        payload = _json(response)
        self.assertEqual(payload.get("role"), "admin")
        self.assertTrue(csrf)
        self.assertNotIn("token", payload)
        self.assertNotIn("session_token", payload)
        self.assertTrue(response.set_cookie_headers)
        cookie = response.set_cookie_headers[0]
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        self.assertIn("Path=/", cookie)
        self.assertIn("Max-Age=43200", cookie)
        self.assertNotIn("Secure", cookie)

    def test_secure_cookie_when_https(self):
        os.environ["CCTV_HTTPS"] = "1"
        try:
            client = support.Client(remote_addr="10.91.0.2")
            response, _csrf = support.login(client)
            self.assertEqual(response.status_code, 200)
            self.assertIn("Secure", response.set_cookie_headers[0])
        finally:
            os.environ.pop("CCTV_HTTPS", None)

    def test_wrong_password_and_unknown_user_same_message(self):
        client = support.Client(remote_addr="10.91.0.3")
        wrong = client.post("/api/auth/login",
                            json_data={"username": "admin", "password": "Sai-Mat-Khau-2026"})
        self.assertEqual(wrong.status_code, 401)
        self.assertEqual(_error_code(wrong), "INVALID_CREDENTIALS")
        self.assertEqual(_json(wrong)["error"]["message"],
                         _json(support.Client(remote_addr="10.91.0.4").post(
                             "/api/auth/login",
                             json_data={"username": "khong-ton-tai", "password": "whatever"}))["error"]["message"])

    def test_login_rate_limit_429(self):
        client = support.Client(remote_addr="10.91.0.9")
        for _ in range(5):
            response = client.post("/api/auth/login",
                                   json_data={"username": "admin", "password": "Sai-Mat-Khau-2026"})
            self.assertEqual(response.status_code, 401)
        blocked = client.post("/api/auth/login",
                              json_data={"username": "admin", "password": support.ADMIN_PASSWORD})
        self.assertEqual(blocked.status_code, 429)
        self.assertEqual(_error_code(blocked), "RATE_LIMITED")
        self.assertTrue(blocked.headers.get("retry-after"))
        self.assertGreater(_json(blocked)["error"]["details"]["retry_after_seconds"], 0)

    def test_auth_me_authenticated_has_csrf(self):
        client, csrf = support.admin_client("10.91.0.5")
        response = client.get("/api/auth/me")
        self.assertEqual(response.status_code, 200)
        payload = _json(response)
        self.assertTrue(payload["authenticated"])
        self.assertEqual(payload["role"], "admin")
        self.assertTrue(payload["csrf_token"])
        self.assertNotIn("token", payload)

    def test_logout_requires_csrf_and_revokes(self):
        client, csrf = support.admin_client("10.91.0.6")
        no_csrf = client.post("/api/auth/logout", json_data={})
        self.assertEqual(no_csrf.status_code, 403)
        self.assertEqual(_error_code(no_csrf), "CSRF_INVALID")

        old_jar = dict(client.cookies)
        response = client.post("/api/auth/logout", json_data={},
                               headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200)
        reused = client.get("/api/system/status", cookie_override=old_jar)
        self.assertEqual(reused.status_code, 401)

    def test_change_password_validation_and_revoke(self):
        client, csrf = support.admin_client("10.91.0.7")
        headers = {"X-CSRF-Token": csrf}
        wrong = client.post("/api/auth/change_password", json_data={
            "target": "admin", "current_password": "sai", "new_password": "New-Admin-Pass-2026x",
        }, headers=headers)
        self.assertEqual(wrong.status_code, 401)

        weak = client.post("/api/auth/change_password", json_data={
            "target": "admin", "current_password": support.ADMIN_PASSWORD, "new_password": "short",
        }, headers=headers)
        self.assertEqual(weak.status_code, 400)

        new_password = "New-Admin-Pass-2026x"
        changed = client.post("/api/auth/change_password", json_data={
            "target": "admin", "current_password": support.ADMIN_PASSWORD,
            "new_password": new_password,
        }, headers=headers)
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertTrue(_json(changed).get("reauth_required"))
        self.assertGreaterEqual(_json(changed).get("revoked_sessions", 0), 1)

        old_login = support.Client(remote_addr="10.91.0.8")
        self.assertEqual(support.login(old_login, "admin", support.ADMIN_PASSWORD)[0].status_code, 401)

        new_client = support.Client(remote_addr="10.91.0.10")
        new_response, new_csrf = support.login(new_client, "admin", new_password)
        self.assertEqual(new_response.status_code, 200)

        # Khôi phục mật khẩu gốc cho các test sau.
        restore = new_client.post("/api/auth/change_password", json_data={
            "target": "admin", "current_password": new_password,
            "new_password": support.ADMIN_PASSWORD,
        }, headers={"X-CSRF-Token": new_csrf})
        self.assertEqual(restore.status_code, 200, restore.text)

    def test_viewer_login_disabled_then_enabled_then_cleared(self):
        self.assertEqual(support.login(support.Client(remote_addr="10.91.0.11"),
                                       "viewer", support.VIEWER_PASSWORD)[0].status_code, 403)

        admin, csrf = support.admin_client("10.91.0.12")
        set_response = admin.post("/api/auth/change_password", json_data={
            "target": "viewer", "current_password": support.ADMIN_PASSWORD,
            "new_password": support.VIEWER_PASSWORD,
        }, headers={"X-CSRF-Token": csrf})
        self.assertEqual(set_response.status_code, 200, set_response.text)

        viewer = support.Client(remote_addr="10.91.0.13")
        viewer_login, _viewer_csrf = support.login(viewer, "viewer", support.VIEWER_PASSWORD)
        self.assertEqual(viewer_login.status_code, 200)
        self.assertEqual(_json(viewer_login)["role"], "viewer")

        admin2, csrf2 = support.admin_client("10.91.0.14")
        clear_response = admin2.post("/api/auth/change_password", json_data={
            "target": "viewer", "current_password": support.ADMIN_PASSWORD,
            "clear_viewer": True,
        }, headers={"X-CSRF-Token": csrf2})
        self.assertEqual(clear_response.status_code, 200, clear_response.text)
        self.assertEqual(viewer.get("/api/system/status").status_code, 401)
        self.assertEqual(support.login(support.Client(remote_addr="10.91.0.15"),
                                       "viewer", support.VIEWER_PASSWORD)[0].status_code, 403)

    def test_password_stored_as_scrypt_not_plaintext(self):
        support.reset_auth_state()
        path = os.environ["CCTV_SETTINGS_FILE"]
        with open(path, "r", encoding="utf-8") as handle:
            settings = json.load(handle)
        self.assertNotIn("admin_password", settings)
        self.assertRegex(settings.get("admin_password_hash", ""),
                         r"^scrypt\$\d+\$\d+\$\d+\$")


# ==============================================================================
# RBAC matrix
# ==============================================================================

VIEWER_ROUTES = [
    ("GET", "/api/system/status"),
    ("GET", "/api/managed/cameras"),
    ("GET", "/api/stream/mjpeg?ip=" + support.CAMERA_IP),
    ("GET", "/api/stream/audio?ip=" + support.CAMERA_IP),
    ("GET", "/api/snapshot?ip=" + support.CAMERA_IP),
    ("GET", "/api/record/status"),
    ("GET", "/api/recordings/khong-ton-tai.mp4"),
    ("GET", "/api/camera/details?ip=" + support.CAMERA_IP),
    ("GET", "/api/hardware/status?ip=" + support.CAMERA_IP),
    ("GET", "/api/storage/info?ip=" + support.CAMERA_IP),
    ("GET", "/api/storage/recordings?ip=" + support.CAMERA_IP),
    ("GET", "/api/alarm/status"),
    ("GET", "/api/alarm/history"),
    ("GET", "/snapshots/khong-ton-tai.jpg"),
    ("GET", "/download/app.apk"),
    ("POST", "/api/auth/logout"),
]

# Bỏ logout (hành động thu hồi session) khi kiểm tra admin không bị chặn.
VIEWER_SAFE_ROUTES = [route for route in VIEWER_ROUTES if route != ("POST", "/api/auth/logout")]

ADMIN_ROUTES = [
    ("GET", "/api/settings"),
    ("POST", "/api/settings"),
    ("POST", "/api/settings/open-folder"),
    ("GET", "/api/scan"),
    ("GET", "/api/scan/vlans"),
    ("GET", "/api/export"),
    ("POST", "/api/managed/cameras"),
    ("PUT", "/api/managed/cameras/cam_x"),
    ("DELETE", "/api/managed/cameras/cam_x"),
    ("POST", "/api/managed/cameras/test"),
    ("POST", "/api/managed/cameras/sync"),
    ("POST", "/api/managed/cameras/toggle-alarm"),
    ("POST", "/api/cameras/credentials"),
    ("DELETE", "/api/cameras/credentials/10.255.255.10"),
    ("POST", "/api/stream/open"),
    ("POST", "/api/record/start"),
    ("POST", "/api/record/stop"),
    ("POST", "/api/ptz"),
    ("POST", "/api/batch-ip"),
    ("POST", "/api/reboot"),
    ("POST", "/api/sync-time"),
    ("POST", "/api/batch_change_password"),
    ("POST", "/api/camera/name"),
    ("POST", "/api/hardware/privacy"),
    ("POST", "/api/hardware/tracking"),
    ("POST", "/api/hardware/siren"),
    ("POST", "/api/storage/format"),
    ("POST", "/api/storage/watchdog/check_now"),
    ("POST", "/api/alarm/toggle"),
    ("POST", "/api/alarm/test"),
    ("POST", "/api/alarm/clear_history"),
]


class RbacTests(SecurityTestCase):
    def test_matrix_unauthenticated_401(self):
        client = support.Client(remote_addr="10.92.0.1")
        for method, path in VIEWER_ROUTES + ADMIN_ROUTES:
            with self.subTest(method=method, path=path):
                response = client.request(method, path, json_data={})
                self.assertEqual(response.status_code, 401, response.text)
                self.assertEqual(_error_code(response), "UNAUTHENTICATED")

    def test_matrix_viewer_forbidden_on_admin(self):
        viewer, csrf = support.viewer_client("10.92.0.2")
        for method, path in ADMIN_ROUTES:
            with self.subTest(method=method, path=path):
                response = viewer.request(method, path, json_data={},
                                          headers={"X-CSRF-Token": csrf})
                self.assertEqual(response.status_code, 403, response.text)
                self.assertEqual(_error_code(response), "FORBIDDEN")

    def test_matrix_admin_not_blocked(self):
        admin, csrf = support.admin_client("10.92.0.3")
        headers = {"X-CSRF-Token": csrf}
        for method, path in VIEWER_SAFE_ROUTES + ADMIN_ROUTES:
            with self.subTest(method=method, path=path):
                response = admin.request(method, path, json_data={}, headers=headers)
                if path == "/api/auth/logout":
                    continue
                self.assertNotIn(response.status_code, (401, 403, 500), response.text)

    def test_viewer_read_endpoints_allowed(self):
        viewer, _csrf = support.viewer_client("10.92.0.4")
        expected = {
            "/api/system/status": {200},
            "/api/managed/cameras": {200},
            "/api/stream/mjpeg": {503},
            "/api/stream/audio": {503},
            "/api/snapshot": {503},
            "/api/record/status": {200},
            "/api/camera/details": {503},
            "/api/hardware/status": {503},
            "/api/storage/info": {503},
            "/api/storage/recordings": {503},
            "/api/alarm/status": {200},
            "/api/alarm/history": {200},
        }
        for path, statuses in expected.items():
            query = ""
            if path in ("/api/stream/mjpeg", "/api/stream/audio", "/api/snapshot",
                        "/api/camera/details", "/api/hardware/status",
                        "/api/storage/info", "/api/storage/recordings"):
                query = "?ip=" + support.CAMERA_IP
            response = viewer.get(path + query)
            self.assertIn(response.status_code, statuses, f"{path}: {response.text}")

    def test_viewer_settings_forbidden(self):
        viewer, _csrf = support.viewer_client("10.92.0.5")
        response = viewer.get("/api/settings")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(_error_code(response), "FORBIDDEN")

    def test_viewer_cannot_use_unmanaged_ip(self):
        viewer, _csrf = support.viewer_client("10.92.0.6")
        response = viewer.get("/api/stream/mjpeg?ip=10.255.254.1")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(_error_code(response), "CAMERA_NOT_FOUND")

    def test_admin_unmanaged_requires_credentials(self):
        admin, _csrf = support.admin_client("10.92.0.7")
        response = admin.get("/api/stream/mjpeg?ip=10.255.254.1")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(_error_code(response), "CAMERA_CREDENTIAL_REQUIRED")

    def test_viewer_managed_cameras_sanitized(self):
        viewer, _csrf = support.viewer_client("10.92.0.8")
        response = viewer.get("/api/managed/cameras")
        self.assertEqual(response.status_code, 200)
        payload = _json(response)
        self.assertGreaterEqual(payload["count"], 1)
        for camera in payload["cameras"]:
            self.assertNotIn("password", camera)
            self.assertNotIn("alarm_enabled", camera)
            self.assertNotIn("username", camera)
            self.assertNotIn("note", camera)
            self.assertNotIn("rtsp_path", camera)
            self.assertTrue(camera["has_password"])

    def test_viewer_system_status_has_no_secrets(self):
        viewer, _csrf = support.viewer_client("10.92.0.9")
        response = viewer.get("/api/system/status")
        self.assertEqual(response.status_code, 200)
        text = response.text
        self.assertNotIn("telegram_bot_token", text)
        self.assertNotIn("chat_id", text)
        self.assertNotIn(support.CAMERA_PASSWORD, text)
        payload = _json(response)
        self.assertNotIn("runtime", payload)
        self.assertEqual(set(payload["config"].keys()), {"viewer_login_enabled"})


# ==============================================================================
# CSRF / Origin / Host / body
# ==============================================================================

class CsrfTests(SecurityTestCase):
    def test_missing_and_wrong_csrf(self):
        admin, _csrf = support.admin_client("10.93.0.1")
        missing = admin.post("/api/settings", json_data={})
        self.assertEqual(missing.status_code, 403)
        self.assertEqual(_error_code(missing), "CSRF_INVALID")
        wrong = admin.post("/api/settings", json_data={},
                           headers={"X-CSRF-Token": "sai-token"})
        self.assertEqual(wrong.status_code, 403)

    def test_origin_mismatch_and_match(self):
        admin, csrf = support.admin_client("10.93.0.2")
        evil = admin.post("/api/settings", json_data={},
                          headers={"X-CSRF-Token": csrf, "Origin": "http://evil.example"})
        self.assertEqual(evil.status_code, 403)
        self.assertEqual(_error_code(evil), "ORIGIN_MISMATCH")
        good = admin.post("/api/settings", json_data={},
                          headers={"X-CSRF-Token": csrf,
                                   "Origin": f"http://127.0.0.1:{support.TEST_PORT}"})
        self.assertEqual(good.status_code, 200, good.text)

    def test_sec_fetch_cross_site_without_origin(self):
        admin, csrf = support.admin_client("10.93.0.3")
        response = admin.post("/api/settings", json_data={},
                              headers={"X-CSRF-Token": csrf, "Sec-Fetch-Site": "cross-site"})
        self.assertEqual(response.status_code, 403)

    def test_host_allowlist(self):
        response = support.Client(host="evil.example").get("/api/health")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(_error_code(response), "HOST_NOT_ALLOWED")
        self.assertEqual(support.Client(host="evil.example").get("/").status_code, 400)

    def test_content_type_form_rejected(self):
        admin, csrf = support.admin_client("10.93.0.4")
        response = admin.post("/api/settings", data="{}",
                              content_type="application/x-www-form-urlencoded",
                              headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 415)

    def test_body_too_large(self):
        admin, csrf = support.admin_client("10.93.0.5")
        response = admin.post("/api/settings", data=b"x" * (1024 * 1024 + 10),
                              content_type="application/json",
                              headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 413)

    def test_invalid_json(self):
        admin, csrf = support.admin_client("10.93.0.6")
        response = admin.post("/api/settings", data="{not-json",
                              content_type="application/json",
                              headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(_error_code(response), "VALIDATION_ERROR")


# ==============================================================================
# Settings / secrets
# ==============================================================================

class SettingsTests(SecurityTestCase):
    def test_get_settings_no_secrets(self):
        admin, _csrf = support.admin_client("10.94.0.1")
        response = admin.get("/api/settings")
        self.assertEqual(response.status_code, 200)
        payload = _json(response)
        settings = payload["settings"]
        for key in ("default_password", "telegram_bot_token", "telegram_chat_id",
                    "admin_password", "admin_password_hash", "viewer_password_hash",
                    "admin_password_bootstrap"):
            self.assertNotIn(key, settings)
        self.assertEqual(set(payload["secrets"].keys()),
                         {"default_password_set", "telegram_bot_token_set", "telegram_chat_id_set"})
        self.assertNotIn(support.CAMERA_PASSWORD, response.text)

    def test_settings_unknown_and_forbidden_keys(self):
        admin, csrf = support.admin_client("10.94.0.2")
        headers = {"X-CSRF-Token": csrf}
        unknown = admin.post("/api/settings", json_data={"evil_key": 1}, headers=headers)
        self.assertEqual(unknown.status_code, 400)
        self.assertIn("evil_key", _json(unknown)["error"]["details"]["unknown_keys"])

        forbidden = admin.post("/api/settings", json_data={"admin_password": "Hacked-Password-2026"},
                               headers=headers)
        self.assertEqual(forbidden.status_code, 400)
        self.assertIn("admin_password", _json(forbidden)["error"]["details"]["forbidden_keys"])

        with open(os.environ["CCTV_SETTINGS_FILE"], "r", encoding="utf-8") as handle:
            stored = json.load(handle)
        self.assertNotIn("evil_key", stored)
        self.assertNotIn("admin_password", stored)

    def test_settings_valid_update(self):
        admin, csrf = support.admin_client("10.94.0.3")
        headers = {"X-CSRF-Token": csrf}
        response = admin.post("/api/settings", json_data={"telegram_enabled": True},
                              headers=headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(_json(response)["settings"]["telegram_enabled"])
        admin.post("/api/settings", json_data={"telegram_enabled": False}, headers=headers)

    def test_settings_rejects_invalid_storage_dir(self):
        admin, csrf = support.admin_client("10.94.0.4")
        response = admin.post("/api/settings",
                              json_data={"recordings_dir": os.environ["CCTV_SETTINGS_FILE"]},
                              headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 400)

    def test_password_in_query_forbidden(self):
        viewer, _csrf = support.viewer_client("10.94.0.5")
        response = viewer.get(f"/api/stream/mjpeg?ip={support.CAMERA_IP}&password=abc")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(_error_code(response), "PASSWORD_IN_QUERY_FORBIDDEN")

    def test_no_new_password_in_batch_response(self):
        admin, csrf = support.admin_client("10.94.0.6")
        response = admin.post("/api/batch_change_password", json_data={
            "ips": [support.CAMERA_IP], "new_password": "New-Camera-Pass-2026",
            "confirm": True,
        }, headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("new_password", response.text)
        self.assertNotIn("New-Camera-Pass-2026", response.text)


class EndpointRateLimitTests(SecurityTestCase):
    def test_scan_rate_limit_six_per_minute(self):
        admin, _csrf = support.admin_client("10.95.0.1")
        for _ in range(6):
            self.assertEqual(admin.get("/api/scan").status_code, 200)
        blocked = admin.get("/api/scan")
        self.assertEqual(blocked.status_code, 429)
        self.assertTrue(blocked.headers.get("retry-after"))
        self.assertEqual(_error_code(blocked), "RATE_LIMITED")

    def test_alarm_test_rate_limit_two_per_minute(self):
        admin, csrf = support.admin_client("10.95.0.2")
        headers = {"X-CSRF-Token": csrf}
        for _ in range(2):
            self.assertEqual(admin.post("/api/alarm/test", json_data={}, headers=headers).status_code, 503)
        blocked = admin.post("/api/alarm/test", json_data={}, headers=headers)
        self.assertEqual(blocked.status_code, 429)
        self.assertEqual(_error_code(blocked), "RATE_LIMITED")

    def test_credentials_rate_limit_ten_per_minute(self):
        admin, csrf = support.admin_client("10.95.0.3")
        headers = {"X-CSRF-Token": csrf}
        payload = {"ip": support.CAMERA_IP, "username": "admin",
                   "password": "Ephemeral-Pass-2026"}
        for _ in range(10):
            self.assertEqual(admin.post("/api/cameras/credentials",
                                        json_data=payload, headers=headers).status_code, 200)
        blocked = admin.post("/api/cameras/credentials", json_data=payload, headers=headers)
        self.assertEqual(blocked.status_code, 429)
        self.assertEqual(_error_code(blocked), "RATE_LIMITED")
        support.reset_data_state()


# ==============================================================================
# Headers
# ==============================================================================

class HeaderTests(SecurityTestCase):
    def test_security_headers(self):
        client = support.Client()
        for path in ("/", "/api/health", "/manifest.json"):
            response = client.get(path)
            headers = response.headers
            self.assertIn("default-src 'none'", headers.get("content-security-policy", ""))
            self.assertIn("script-src 'self'", headers.get("content-security-policy", ""))
            self.assertNotIn("unsafe-inline", headers.get("content-security-policy", ""))
            self.assertNotIn("unsafe-eval", headers.get("content-security-policy", ""))
            self.assertEqual(headers.get("x-content-type-options"), "nosniff")
            self.assertEqual(headers.get("x-frame-options"), "DENY")
            self.assertEqual(headers.get("referrer-policy"), "no-referrer")
            self.assertIn("camera=()", headers.get("permissions-policy", ""))
            self.assertIn("same-origin", headers.get("cross-origin-opener-policy", ""))

    def test_api_cache_control_no_store(self):
        client = support.Client()
        self.assertIn("no-store", client.get("/api/health").headers.get("cache-control", ""))
        self.assertIn("no-store", client.get("/").headers.get("cache-control", ""))

    def test_api_version_header(self):
        response = support.Client().get("/api/health")
        self.assertEqual(response.headers.get("x-cctv-api-version"), "2")
        self.assertTrue(response.headers.get("x-request-id"))

    def test_health_no_set_cookie(self):
        self.assertEqual(support.Client().get("/api/health").set_cookie_headers, [])

    def test_server_version_string_not_python(self):
        app_module = support.ensure_app()
        self.assertEqual(app_module.ThreadedWSGIServer.version_string(None), "CCTV")

    def test_error_responses_have_security_headers(self):
        client, _csrf = support.admin_client()
        for response in (client.get("/api/khong-ton-tai"),
                         client.get("/api/auth/login")):
            self.assertIn(response.status_code, (404, 405))
            headers = response.headers
            self.assertTrue(headers.get("content-security-policy"), response.status_code)
            self.assertEqual(headers.get("x-content-type-options"), "nosniff")
            self.assertEqual(headers.get("x-frame-options"), "DENY")
            self.assertEqual(headers.get("referrer-policy"), "no-referrer")
            self.assertIn("no-store", headers.get("cache-control", ""))
            self.assertTrue(headers.get("x-request-id"))


# ==============================================================================
# Migration mật khẩu (subprocess riêng)
# ==============================================================================

class MigrationSubprocessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.project_dir = support.PROJECT_DIR

    def _run(self, temp_dir, settings_payload, admin_password=None):
        support.prepare_config(temp_dir, settings=settings_payload)
        env = support.build_env(temp_dir, admin_password=admin_password,
                                extra={"CCTV_MIGRATION_ONLY": "1"})
        return subprocess.run(
            [sys.executable, os.path.join(self.project_dir, "app.py")],
            cwd=self.project_dir, env=env, capture_output=True, text=True, timeout=120,
        )

    def test_custom_plaintext_is_hashed_and_removed(self):
        import auth
        with tempfile.TemporaryDirectory(prefix="cctv-migrate-") as temp_dir:
            proc = self._run(temp_dir, {"admin_password": "Legacy-Password-2026"})
            self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
            with open(os.path.join(temp_dir, "settings.json"), "r", encoding="utf-8") as handle:
                stored = json.load(handle)
            self.assertNotIn("admin_password", stored)
            self.assertRegex(stored.get("admin_password_hash", ""), r"^scrypt\$")
            self.assertTrue(auth.verify_password("Legacy-Password-2026",
                                                 stored["admin_password_hash"])[0])

    def test_backdoor_pin_is_not_accepted(self):
        import auth
        with tempfile.TemporaryDirectory(prefix="cctv-migrate-") as temp_dir:
            proc = self._run(temp_dir, {"admin_password": "1998"})
            self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
            with open(os.path.join(temp_dir, "settings.json"), "r", encoding="utf-8") as handle:
                stored = json.load(handle)
            stored_hash = stored.get("admin_password_hash", "")
            self.assertRegex(stored_hash, r"^scrypt\$")
            self.assertFalse(auth.verify_password("1998", stored_hash)[0])
            self.assertFalse(auth.verify_password("Admin@1998", stored_hash)[0])
            bootstrap_path = os.path.join(temp_dir, "data", "bootstrap_admin.txt")
            self.assertTrue(os.path.isfile(bootstrap_path))
            with open(bootstrap_path, "r", encoding="utf-8") as handle:
                content = handle.read()
            generated = [line.strip() for line in content.splitlines() if line.strip()][-1]
            self.assertTrue(auth.verify_password(generated, stored_hash)[0])

    def test_weak_viewer_plaintext_is_not_hashed(self):
        import auth
        with tempfile.TemporaryDirectory(prefix="cctv-migrate-") as temp_dir:
            proc = self._run(temp_dir, {
                "admin_password": "Legacy-Password-2026",
                "viewer_password": "1998",
            })
            self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
            with open(os.path.join(temp_dir, "settings.json"), "r", encoding="utf-8") as handle:
                stored = json.load(handle)
            self.assertNotIn("viewer_password", stored)
            self.assertFalse(stored.get("viewer_password_hash"))
            self.assertFalse(auth.verify_password("1998", stored.get("viewer_password_hash") or "")[0])

    def test_corrupt_hash_exits_2(self):
        with tempfile.TemporaryDirectory(prefix="cctv-migrate-") as temp_dir:
            proc = self._run(temp_dir, {"admin_password_hash": "not-a-valid-hash"})
            self.assertEqual(proc.returncode, 2, proc.stderr + proc.stdout)
            with open(os.path.join(temp_dir, "settings.json"), "r", encoding="utf-8") as handle:
                stored = json.load(handle)
            self.assertEqual(stored.get("admin_password_hash"), "not-a-valid-hash")


class ExternalSecretsTests(unittest.TestCase):
    def setUp(self):
        self.app = support.ensure_app()
        self.temp_dir = tempfile.mkdtemp(prefix="cctv-secrets-")
        self.original_settings = self.app.SETTINGS_FILE
        self.original_secrets = self.app.SECRETS_FILE
        self.settings_path = os.path.join(self.temp_dir, "settings.json")
        self.secrets_path = os.path.join(self.temp_dir, "secrets.json")
        support.write_json(self.settings_path, {"scan_timeout": 2.5})
        support.write_json(self.secrets_path, {
            "telegram_bot_token": "test-token-external",
            "telegram_chat_id": "12345",
        })
        self.app.SETTINGS_FILE = self.settings_path
        self.app.SECRETS_FILE = self.secrets_path

    def tearDown(self):
        self.app.SETTINGS_FILE = self.original_settings
        self.app.SECRETS_FILE = self.original_secrets
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_external_secrets_loaded_and_secret_writes_rejected(self):
        settings = self.app.load_settings()
        self.assertEqual(settings.get("telegram_bot_token"), "test-token-external")
        self.assertTrue(settings.get("secrets_managed_externally"))
        self.assertFalse(self.app.save_settings({"telegram_bot_token": "changed"}))
        self.assertTrue(self.app.save_settings({"scan_timeout": 3.0}))
        with open(self.settings_path, "r", encoding="utf-8") as handle:
            stored = json.load(handle)
        self.assertNotIn("telegram_bot_token", stored)
        self.assertEqual(stored.get("scan_timeout"), 3.0)

    def test_missing_external_secrets_file_fails_closed(self):
        import auth
        self.app.SECRETS_FILE = os.path.join(self.temp_dir, "missing.json")
        with self.assertRaises(auth.AuthStartupError):
            self.app.load_settings()


class BatchIpTests(SecurityTestCase):
    def test_batch_ip_persists_new_ip_to_managed(self):
        app_module = support.ensure_app()
        client, csrf = support.admin_client()
        calls = []

        def fake_batch(**_kwargs):
            return [
                {"ok": True, "old_ip": support.CAMERA_IP,
                 "new_ip": "10.255.255.20", "is_dhcp": False},
                {"ok": True, "old_ip": support.CAMERA_IP_2,
                 "new_ip": "10.255.255.21", "is_dhcp": False},
            ]

        def fake_update(cam_id, updates):
            calls.append((cam_id, updates))
            return {"ok": True}

        original = (app_module.batch_change_ip, app_module._test_mode_block,
                    app_module.update_managed_camera)
        try:
            app_module.batch_change_ip = fake_batch
            app_module._test_mode_block = lambda *args, **kwargs: None
            app_module.update_managed_camera = fake_update
            response = client.post(
                "/api/batch-ip",
                json_data={
                    "ips": [support.CAMERA_IP, support.CAMERA_IP_2],
                    "start_ip": "10.255.255.20",
                    "netmask": "255.255.255.0",
                    "confirm": True,
                },
                headers={"X-CSRF-Token": csrf},
            )
        finally:
            (app_module.batch_change_ip, app_module._test_mode_block,
             app_module.update_managed_camera) = original

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], ("cam_10_255_255_10", {"ip": "10.255.255.20"}))
        self.assertEqual(calls[1], ("cam_10_255_255_11", {"ip": "10.255.255.21"}))
        self.assertEqual(response.json().get("managed_updated"), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
