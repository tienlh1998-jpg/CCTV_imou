# -*- coding: utf-8 -*-
"""Fixture server cho test: chạy Bottle trong process trên 127.0.0.1:18080.

Dùng chung bởi test_security (WSGI in-process) và ui_smoke (HTTP thật).
Không start AlarmManager, không gọi camera/Telegram/FFmpeg.
"""

import socket
import threading
import unittest
from wsgiref.simple_server import make_server

import support


def setUpModule():
    support.ensure_app()


class InProcessServer:
    """Context manager chạy Bottle trên 127.0.0.1:port (mặc định 18080)."""

    def __init__(self, port: int = support.TEST_PORT):
        self.port = port
        self.server = None
        self.thread = None

    def __enter__(self):
        app_module = support.ensure_app()
        from bottle import default_app
        self.server = make_server(
            "127.0.0.1", self.port, default_app(),
            server_class=app_module.ThreadedWSGIServer,
        )
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       daemon=True, name="CCTVTestHTTPServer")
        self.thread.start()
        return f"http://127.0.0.1:{self.port}"

    def __exit__(self, exc_type, exc, tb):
        self.stop()
        return False

    def stop(self):
        if self.server is not None:
            try:
                self.server.shutdown()
            except Exception:
                pass
            try:
                self.server.server_close()
            except Exception:
                pass
            self.server = None
        if self.thread is not None:
            self.thread.join(timeout=5)
            self.thread = None


def port_available(port: int = support.TEST_PORT) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


class BaseSecurityTest(unittest.TestCase):
    """Base class: reset auth/data state trước mỗi test."""

    @classmethod
    def setUpClass(cls):
        support.ensure_app()

    def setUp(self):
        support.reset_auth_state()
        support.reset_data_state()


class ServerFixtureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        support.ensure_app()

    def setUp(self):
        support.reset_auth_state()

    def test_server_starts_on_18080(self):
        if not port_available(support.TEST_PORT):
            self.skipTest(f"Cổng {support.TEST_PORT} đang bận")
        with InProcessServer() as base_url:
            self.assertEqual(base_url, f"http://127.0.0.1:{support.TEST_PORT}")
            import urllib.request
            with urllib.request.urlopen(base_url + "/api/health", timeout=5) as response:
                self.assertEqual(response.status, 200)
                body = response.read().decode("utf-8")
                self.assertIn('"ok": true', body)
                self.assertNotIn("Python/", response.headers.get("Server", ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
