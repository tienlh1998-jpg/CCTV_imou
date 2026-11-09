#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""auth.py — Lớp xác thực và bảo mật trung tâm cho CCTV Vision Hub.

Nội dung:
- Hash mật khẩu bằng scrypt (N=32768, r=8, p=1, dklen=32) + salt ngẫu nhiên.
- Session server-side (token ngẫu nhiên, chỉ lưu SHA-256), TTL tuyệt đối 12 giờ.
- CSRF token gắn session (tính bằng HMAC từ token + secret tiến trình).
- Rate limit đăng nhập theo (IP, username), theo IP và toàn cục.
- Chính sách route trung tâm: mọi /api/* mặc định phải xác thực; phân quyền admin/viewer.
- Hook before_request/after_request: Host/Origin/CSRF, body limit, security headers.
- Migration mật khẩu plaintext -> hash, first-run bootstrap an toàn.

Module này KHÔNG import app.py (tránh vòng lặp import). App truyền callback đọc/ghi settings.
"""

from __future__ import annotations

import base64
import datetime
import functools
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import threading
import time
import urllib.parse
from collections import deque
from typing import Callable, Iterable, Optional

from bottle import HTTPResponse, request, response

# ==============================================================================
# Hằng số
# ==============================================================================

SESSION_COOKIE = "cctv_sid"
CSRF_HEADER = "X-CSRF-Token"

APP_VERSION = "2.0.0"
API_VERSION = 2

SCRYPT_N = 32768
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32
SCRYPT_MAXMEM = 64 * 1024 * 1024

_HASH_RE = re.compile(r"^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$")

PASSWORD_MIN = 10
PASSWORD_MAX = 128
CAMERA_PASSWORD_MIN = 8
CAMERA_PASSWORD_MAX = 128

# Danh sách mật khẩu phổ biến / backdoor cũ. So sánh lowercase sau khi trim.
COMMON_PASSWORDS = {
    "admin", "password", "123456", "12345678", "123456789", "1234567890",
    "1998", "admin@1998", "camera@2020", "cctv", "cctv123", "qwerty",
    "letmein", "welcome", "iloveyou", "abc123", "111111", "000000",
    "admin123", "password1", "p@ssw0rd", "root", "toor",
}

STATE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

PUBLIC = "public"
VIEWER = "viewer"
ADMIN = "admin"

CSP_POLICY = "; ".join([
    "default-src 'none'",
    "script-src 'self'",
    "script-src-attr 'none'",
    "style-src 'self'",
    "style-src-attr 'none'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
])

PERMISSIONS_POLICY = (
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), "
    "display-capture=(), idle-detection=()"
)

_HOST_RE = re.compile(r"^[A-Za-z0-9._:\-\[\]]{1,253}$")
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


# ==============================================================================
# Tiện ích chung
# ==============================================================================

def env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _b64e(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _b64d(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"), validate=True)


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def now_iso(ts: Optional[float] = None) -> str:
    ts = time.time() if ts is None else ts
    return datetime.datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds")


def secure_file_permissions(path: str) -> None:
    """Best-effort: chỉ chủ sở hữu đọc/ghi (POSIX chmod 600)."""
    if os.name != "posix":
        return
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


# ==============================================================================
# Hash mật khẩu
# ==============================================================================

def hash_password(
    password: str,
    *,
    salt: Optional[bytes] = None,
    n: int = SCRYPT_N,
    r: int = SCRYPT_R,
    p: int = SCRYPT_P,
    dklen: int = SCRYPT_DKLEN,
) -> str:
    """Trả về chuỗi ``scrypt$N$r$p$salt_b64$key_b64``."""
    if not isinstance(password, str):
        raise TypeError("password phải là str")
    salt = salt if salt is not None else secrets.token_bytes(16)
    if len(salt) < 16:
        raise ValueError("salt phải >= 16 byte")
    derived = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=n, r=r, p=p,
        dklen=dklen, maxmem=SCRYPT_MAXMEM,
    )
    return "scrypt${}${}${}${}${}".format(n, r, p, _b64e(salt), _b64e(derived))


def parse_hash(stored: str) -> Optional[dict]:
    if not isinstance(stored, str):
        return None
    match = _HASH_RE.match(stored.strip())
    if not match:
        return None
    try:
        n, r, p = int(match.group(1)), int(match.group(2)), int(match.group(3))
        salt = _b64d(match.group(4))
        key = _b64d(match.group(5))
    except Exception:
        return None
    if n < 16384 or n > 1048576 or r < 1 or r > 32 or p < 1 or p > 16:
        return None
    if len(salt) < 16 or len(key) < 16:
        return None
    return {"n": n, "r": r, "p": p, "salt": salt, "key": key}


def verify_password(password: str, stored: str) -> tuple[bool, bool]:
    """So sánh constant-time. Trả ``(ok, needs_rehash)``."""
    parsed = parse_hash(stored)
    if not parsed or not isinstance(password, str):
        return False, False
    try:
        derived = hashlib.scrypt(
            password.encode("utf-8"), salt=parsed["salt"], n=parsed["n"],
            r=parsed["r"], p=parsed["p"], dklen=len(parsed["key"]),
            maxmem=SCRYPT_MAXMEM,
        )
    except Exception:
        return False, False
    ok = hmac.compare_digest(derived, parsed["key"])
    needs_rehash = ok and (
        parsed["n"] != SCRYPT_N or parsed["r"] != SCRYPT_R
        or parsed["p"] != SCRYPT_P or len(parsed["key"]) != SCRYPT_DKLEN
    )
    return ok, needs_rehash


_DUMMY_HASH: Optional[str] = None
_DUMMY_LOCK = threading.Lock()


def dummy_verify(password: str) -> None:
    """Chạy scrypt giả để cân bằng thời gian khi username không tồn tại."""
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        with _DUMMY_LOCK:
            if _DUMMY_HASH is None:
                _DUMMY_HASH = hash_password("cctv-dummy-password-not-a-real-secret")
    verify_password(password, _DUMMY_HASH)


def is_common_password(password: str) -> bool:
    return password.strip().lower() in COMMON_PASSWORDS


def validate_new_password(password: str, current_hash: str = "") -> Optional[str]:
    """Trả về thông báo lỗi tiếng Việt hoặc None nếu hợp lệ."""
    if not isinstance(password, str):
        return "Mật khẩu không hợp lệ."
    password = password.strip()
    if len(password) < PASSWORD_MIN:
        return f"Mật khẩu phải có tối thiểu {PASSWORD_MIN} ký tự."
    if len(password) > PASSWORD_MAX:
        return f"Mật khẩu không được vượt quá {PASSWORD_MAX} ký tự."
    if is_common_password(password):
        return "Mật khẩu quá phổ biến hoặc thuộc danh sách mặc định, vui lòng chọn mật khẩu khác."
    if current_hash and verify_password(password, current_hash)[0]:
        return "Mật khẩu mới không được trùng mật khẩu hiện tại."
    return None


def validate_camera_password(password: str) -> Optional[str]:
    if not isinstance(password, str):
        return "Mật khẩu camera không hợp lệ."
    if len(password) < CAMERA_PASSWORD_MIN:
        return f"Mật khẩu camera phải có tối thiểu {CAMERA_PASSWORD_MIN} ký tự."
    if len(password) > CAMERA_PASSWORD_MAX:
        return f"Mật khẩu camera không được vượt quá {CAMERA_PASSWORD_MAX} ký tự."
    return None


def generate_strong_password(length: int = 20) -> str:
    alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_!@#"
    while True:
        candidate = "".join(secrets.choice(alphabet) for _ in range(length))
        categories = sum([
            any(c.islower() for c in candidate),
            any(c.isupper() for c in candidate),
            any(c.isdigit() for c in candidate),
            any(not c.isalnum() for c in candidate),
        ])
        if categories >= 3 and not is_common_password(candidate):
            return candidate


class AuthStartupError(RuntimeError):
    """Lỗi cấu hình không thể khởi động an toàn (server nên exit mã 2)."""


# ==============================================================================
# Session store (thread-safe)
# ==============================================================================

class SessionLimitError(RuntimeError):
    pass


class SessionStore:
    def __init__(
        self,
        ttl_seconds: int = 43200,
        max_sessions: int = 500,
        max_sessions_per_user: int = 20,
        now_fn: Callable[[], float] = time.time,
    ):
        self.ttl_seconds = int(ttl_seconds)
        self.max_sessions = int(max_sessions)
        self.max_sessions_per_user = max(1, int(max_sessions_per_user))
        self._now = now_fn
        self._sessions: dict[str, dict] = {}
        self._lock = threading.RLock()
        self._csrf_secret = secrets.token_bytes(32)
        self._last_prune = 0.0

    # -- CSRF ---------------------------------------------------------------
    def _csrf_value_for(self, raw_token: str) -> str:
        digest = hmac.new(self._csrf_secret, raw_token.encode("utf-8"), hashlib.sha256).digest()
        return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")

    def csrf_token_for(self, raw_token: str) -> Optional[str]:
        if not raw_token:
            return None
        return self._csrf_value_for(raw_token)

    # -- vòng đời -----------------------------------------------------------
    def _prune_locked(self) -> None:
        now = self._now()
        expired = [key for key, rec in self._sessions.items() if now >= rec["expires_at"]]
        for key in expired:
            self._sessions.pop(key, None)
        self._last_prune = now

    def create(
        self,
        role: str,
        username: str,
        client_ip: str = "",
        user_agent: str = "",
        old_token: str = "",
    ) -> tuple[str, str, dict]:
        raw_token = secrets.token_urlsafe(32)
        csrf = self._csrf_value_for(raw_token)
        token_hash = _sha256_hex(raw_token)
        now = self._now()
        record = {
            "token_hash": token_hash,
            "role": role,
            "username": username,
            "csrf_hash": _sha256_hex(csrf),
            "created_at": now,
            "expires_at": now + self.ttl_seconds,
            "last_seen_at": now,
            "client_ip": client_ip,
            "ua_hash": _sha256_hex(user_agent or ""),
        }
        with self._lock:
            if old_token:
                self._sessions.pop(_sha256_hex(old_token), None)
            self._prune_locked()
            # Giới hạn theo từng user: một viewer không thể tích luỹ session
            # để chiếm hạn mức toàn cục và chặn admin đăng nhập.
            same_user = [
                (key, rec) for key, rec in self._sessions.items()
                if rec.get("username") == username
            ]
            if len(same_user) >= self.max_sessions_per_user:
                same_user.sort(key=lambda item: item[1].get("last_seen_at", 0))
                excess = len(same_user) - self.max_sessions_per_user + 1
                for key, _rec in same_user[:excess]:
                    self._sessions.pop(key, None)
            if len(self._sessions) >= self.max_sessions:
                raise SessionLimitError("Đã đạt giới hạn số phiên đăng nhập.")
            self._sessions[token_hash] = record
        return raw_token, csrf, dict(record)

    def get(self, raw_token: Optional[str]) -> Optional[dict]:
        if not raw_token:
            return None
        token_hash = _sha256_hex(raw_token)
        now = self._now()
        with self._lock:
            record = self._sessions.get(token_hash)
            if not record:
                return None
            if now >= record["expires_at"]:
                self._sessions.pop(token_hash, None)
                return None
            record["last_seen_at"] = now
            return dict(record)

    def csrf_valid(self, record: Optional[dict], raw_csrf: Optional[str]) -> bool:
        if not record or not raw_csrf:
            return False
        try:
            supplied = _sha256_hex(str(raw_csrf))
            return hmac.compare_digest(supplied, record.get("csrf_hash", ""))
        except Exception:
            return False

    def revoke(self, raw_token: Optional[str]) -> bool:
        if not raw_token:
            return False
        with self._lock:
            return self._sessions.pop(_sha256_hex(raw_token), None) is not None

    def revoke_all(self) -> int:
        with self._lock:
            count = len(self._sessions)
            self._sessions.clear()
            return count

    def count(self) -> int:
        with self._lock:
            self._prune_locked()
            return len(self._sessions)


# ==============================================================================
# Rate limiter
# ==============================================================================

class LoginRateLimiter:
    """Rate limit đăng nhập: 5 lần sai/5 phút/(IP+user), 20/15 phút/IP, 100/15 phút toàn cục."""

    def __init__(
        self,
        now_fn: Callable[[], float] = time.time,
        per_user_limit: int = 5,
        per_user_window: float = 300.0,
        per_ip_limit: int = 20,
        per_ip_window: float = 900.0,
        global_limit: int = 100,
        global_window: float = 900.0,
        global_block_seconds: float = 60.0,
    ):
        self._now = now_fn
        self.per_user_limit = per_user_limit
        self.per_user_window = per_user_window
        self.per_ip_limit = per_ip_limit
        self.per_ip_window = per_ip_window
        self.global_limit = global_limit
        self.global_window = global_window
        self.global_block_seconds = global_block_seconds
        self._user: dict[tuple[str, str], deque] = {}
        self._ip: dict[str, deque] = {}
        self._global: deque = deque()
        self._blocked_until = 0.0
        self._lock = threading.Lock()

    def _prune_locked(self, now: float) -> None:
        for key, bucket in list(self._user.items()):
            while bucket and now - bucket[0] > self.per_user_window:
                bucket.popleft()
            if not bucket:
                self._user.pop(key, None)
        for ip, bucket in list(self._ip.items()):
            while bucket and now - bucket[0] > self.per_ip_window:
                bucket.popleft()
            if not bucket:
                self._ip.pop(ip, None)
        while self._global and now - self._global[0] > self.global_window:
            self._global.popleft()

    def retry_after(self, client_ip: str, username: str) -> int:
        now = self._now()
        with self._lock:
            self._prune_locked(now)
            if now < self._blocked_until:
                return max(1, int(self._blocked_until - now))
            waits = []
            bucket = self._user.get((client_ip, username))
            if bucket and len(bucket) >= self.per_user_limit:
                waits.append(self.per_user_window - (now - bucket[0]))
            ip_bucket = self._ip.get(client_ip)
            if ip_bucket and len(ip_bucket) >= self.per_ip_limit:
                waits.append(self.per_ip_window - (now - ip_bucket[0]))
            return max(1, int(max(waits))) if waits else 0

    def record_failure(self, client_ip: str, username: str) -> None:
        now = self._now()
        with self._lock:
            self._prune_locked(now)
            self._user.setdefault((client_ip, username), deque()).append(now)
            self._ip.setdefault(client_ip, deque()).append(now)
            self._global.append(now)
            if len(self._global) >= self.global_limit:
                self._blocked_until = now + self.global_block_seconds

    def record_attempt(self, client_ip: str, username: str) -> None:
        """Ghi nhận *mọi* lần đăng nhập (kể cả thành công) cho bộ đếm chống lạm dụng."""
        self.record_failure(client_ip, username)

    def record_success(self, client_ip: str, username: str) -> None:
        with self._lock:
            self._user.pop((client_ip, username), None)

    def reset(self) -> None:
        with self._lock:
            self._user.clear()
            self._ip.clear()
            self._global.clear()
            self._blocked_until = 0.0


class RateLimiter:
    """Sliding-window limiter đơn giản cho endpoint (thread-safe)."""

    def __init__(self, limit: int, window: float, now_fn: Callable[[], float] = time.time):
        self.limit = int(limit)
        self.window = float(window)
        self._now = now_fn
        self._buckets: dict[str, deque] = {}
        self._lock = threading.Lock()

    def hit(self, key: str) -> tuple[bool, int]:
        now = self._now()
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = deque()
                self._buckets[key] = bucket
            while bucket and now - bucket[0] > self.window:
                bucket.popleft()
            if len(bucket) >= self.limit:
                retry = max(1, int(self.window - (now - bucket[0])))
                return False, retry
            bucket.append(now)
            return True, 0

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()


_RATE_LIMITERS: dict[str, RateLimiter] = {}
_RATE_LIMITERS_LOCK = threading.Lock()


def get_rate_limiter(name: str, limit: int, window: float) -> RateLimiter:
    with _RATE_LIMITERS_LOCK:
        limiter = _RATE_LIMITERS.get(name)
        if limiter is None:
            limiter = RateLimiter(limit, window)
            _RATE_LIMITERS[name] = limiter
        return limiter


# ==============================================================================
# Chính sách route
# ==============================================================================

class Rule:
    __slots__ = ("method", "pattern", "access", "csrf")

    def __init__(self, method: str, pattern: str, access: str, csrf: bool = False):
        self.method = method
        self.pattern = re.compile(pattern)
        self.access = access
        self.csrf = csrf


class AccessPolicy:
    """Bảng phân quyền trung tâm. Thứ tự rule quan trọng (cụ thể trước)."""

    def __init__(self, rules: Optional[Iterable[Rule]] = None):
        self._rules = list(rules) if rules is not None else default_rules()

    def classify(self, method: str, path: str) -> Optional[Rule]:
        method = method.upper()
        for rule in self._rules:
            if rule.method == method and rule.pattern.match(path):
                return rule
        return None

    def default_rule(self, method: str, path: str) -> Optional[Rule]:
        if path.startswith("/api/"):
            return Rule(method, r"^/api/.*$", VIEWER, method in STATE_METHODS)
        return None


def default_rules() -> list[Rule]:
    return [
        # Public
        Rule("GET", r"^/api/health$", PUBLIC),
        Rule("POST", r"^/api/auth/login$", PUBLIC),
        Rule("GET", r"^/api/auth/me$", PUBLIC),
        # Auth
        Rule("POST", r"^/api/auth/logout$", VIEWER, True),
        Rule("POST", r"^/api/auth/change_password$", ADMIN, True),
        # Viewer read-only
        Rule("GET", r"^/api/system/status$", VIEWER),
        Rule("GET", r"^/api/managed/cameras$", VIEWER),
        Rule("GET", r"^/api/stream/mjpeg$", VIEWER),
        Rule("GET", r"^/api/stream/audio$", VIEWER),
        Rule("GET", r"^/api/snapshot$", VIEWER),
        Rule("GET", r"^/api/record/status$", VIEWER),
        Rule("GET", r"^/api/recordings/[^/]+$", VIEWER),
        Rule("GET", r"^/api/camera/details$", VIEWER),
        Rule("GET", r"^/api/hardware/status$", VIEWER),
        Rule("GET", r"^/api/storage/info$", VIEWER),
        Rule("GET", r"^/api/storage/recordings$", VIEWER),
        Rule("GET", r"^/api/alarm/status$", VIEWER),
        Rule("GET", r"^/api/alarm/history$", VIEWER),
        Rule("GET", r"^/snapshots/.+$", VIEWER),
        Rule("GET", r"^/download/app\.apk$", VIEWER),
        # Admin
        Rule("GET", r"^/api/settings$", ADMIN),
        Rule("POST", r"^/api/settings$", ADMIN, True),
        Rule("POST", r"^/api/settings/open-folder$", ADMIN, True),
        Rule("POST", r"^/api/managed/cameras/test$", ADMIN, True),
        Rule("POST", r"^/api/managed/cameras/sync$", ADMIN, True),
        Rule("POST", r"^/api/managed/cameras/toggle-alarm$", ADMIN, True),
        Rule("POST", r"^/api/managed/cameras$", ADMIN, True),
        Rule("PUT", r"^/api/managed/cameras/[^/]+$", ADMIN, True),
        Rule("DELETE", r"^/api/managed/cameras/[^/]+$", ADMIN, True),
        Rule("POST", r"^/api/cameras/credentials$", ADMIN, True),
        Rule("DELETE", r"^/api/cameras/credentials/[^/]+$", ADMIN, True),
        Rule("GET", r"^/api/scan$", ADMIN),
        Rule("GET", r"^/api/scan/vlans$", ADMIN),
        Rule("GET", r"^/api/export$", ADMIN),
        Rule("POST", r"^/api/stream/open$", ADMIN, True),
        Rule("POST", r"^/api/record/start$", ADMIN, True),
        Rule("POST", r"^/api/record/stop$", ADMIN, True),
        Rule("POST", r"^/api/ptz$", ADMIN, True),
        Rule("POST", r"^/api/batch-ip$", ADMIN, True),
        Rule("POST", r"^/api/reboot$", ADMIN, True),
        Rule("POST", r"^/api/sync-time$", ADMIN, True),
        Rule("POST", r"^/api/batch_change_password$", ADMIN, True),
        Rule("POST", r"^/api/camera/name$", ADMIN, True),
        Rule("POST", r"^/api/hardware/privacy$", ADMIN, True),
        Rule("POST", r"^/api/hardware/tracking$", ADMIN, True),
        Rule("POST", r"^/api/hardware/siren$", ADMIN, True),
        Rule("POST", r"^/api/storage/format$", ADMIN, True),
        Rule("POST", r"^/api/storage/watchdog/check_now$", ADMIN, True),
        Rule("POST", r"^/api/alarm/toggle$", ADMIN, True),
        Rule("POST", r"^/api/alarm/test$", ADMIN, True),
        Rule("POST", r"^/api/alarm/clear_history$", ADMIN, True),
    ]


# ==============================================================================
# Request context helpers
# ==============================================================================

def get_client_ip(req=None) -> str:
    req = req or request
    remote = (req.environ.get("REMOTE_ADDR") or "0.0.0.0").strip()
    trust_proxy = env_bool("CCTV_TRUST_PROXY")
    candidate = ""
    if trust_proxy or remote in {"127.0.0.1", "::1"}:
        candidate = (req.headers.get("CF-Connecting-IP") or "").strip()
        if not candidate:
            forwarded = req.headers.get("X-Forwarded-For") or ""
            candidate = forwarded.split(",")[0].strip() if forwarded else ""
    if candidate:
        try:
            ipaddress.ip_address(candidate)
            return candidate
        except ValueError:
            pass
    return remote


def request_is_https(req=None) -> bool:
    req = req or request
    if env_bool("CCTV_HTTPS"):
        return True
    try:
        if req.urlparts.scheme == "https":
            return True
    except Exception:
        pass
    if env_bool("CCTV_TRUST_PROXY"):
        if (req.headers.get("X-Forwarded-Proto") or "").strip().lower() == "https":
            return True
    return False


def _request_id(req=None) -> str:
    req = req or request
    rid = req.environ.get("cctv.request_id")
    if rid:
        return rid
    return secrets.token_hex(12)


def _normalise_host(value: str) -> str:
    value = (value or "").strip().lower()
    if not value:
        return ""
    if value.startswith("["):
        end = value.find("]")
        if end != -1:
            return value[1:end]
    if ":" in value:
        value = value.rsplit(":", 1)[0]
    return value.strip(".")


def host_allowed(host: str, allowed: Iterable[str]) -> bool:
    normalised = _normalise_host(host)
    if not normalised or not _HOST_RE.match(normalised):
        return False
    return normalised in {h.lower() for h in allowed}


def _origin_allowed(origin: str, host: str) -> bool:
    if not origin or origin.strip().lower() == "null":
        return False
    try:
        parsed = urllib.parse.urlsplit(origin.strip())
    except Exception:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    origin_netloc = parsed.netloc.lower()
    host_lower = (host or "").lower()
    extra = [o.strip().lower().rstrip("/") for o in os.environ.get("CCTV_ALLOWED_ORIGINS", "").split(",") if o.strip()]
    if origin.strip().lower().rstrip("/") in extra:
        return True
    return origin_netloc == host_lower


def cookie_secure() -> bool:
    return request_is_https()


def set_session_cookie(raw_token: str, max_age: int) -> None:
    """Set cookie thủ công để giữ đúng chuỗi SameSite=Strict (Bottle in thường)."""
    expires = time.strftime(
        "%a, %d %b %Y %H:%M:%S GMT", time.gmtime(time.time() + int(max_age)))
    value = (
        f"{SESSION_COOKIE}={raw_token}; Path=/; Max-Age={int(max_age)}; "
        f"Expires={expires}; HttpOnly; SameSite=Strict"
    )
    if cookie_secure():
        value += "; Secure"
    response.add_header("Set-Cookie", value)


def clear_session_cookie() -> None:
    value = (
        f"{SESSION_COOKIE}=; Path=/; Max-Age=0; "
        "Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict"
    )
    if cookie_secure():
        value += "; Secure"
    response.add_header("Set-Cookie", value)


# ==============================================================================
# JSON envelope
# ==============================================================================

def error_response(
    status: int,
    code: str,
    message: str,
    details=None,
    headers: Optional[dict] = None,
) -> HTTPResponse:
    payload = {
        "ok": False,
        "error": {
            "code": code,
            "message": message,
            "details": details,
            "request_id": _request_id(),
        },
    }
    all_headers = {"Content-Type": "application/json; charset=utf-8"}
    if headers:
        all_headers.update(headers)
    return HTTPResponse(
        status=status,
        body=json.dumps(payload, ensure_ascii=False),
        headers=all_headers,
    )


def fail(status: int, code: str, message: str, details=None, headers: Optional[dict] = None):
    """Trả về HTTPResponse để dùng với ``raise``."""
    return error_response(status, code, message, details=details, headers=headers)


def json_body(max_bytes: int = 1024 * 1024) -> dict:
    raw = request.body.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise fail(413, "PAYLOAD_TOO_LARGE", "Dữ liệu gửi lên quá lớn.")
    if not raw or not raw.strip():
        return {}
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise fail(400, "VALIDATION_ERROR", "Dữ liệu JSON không hợp lệ.")
    if not isinstance(data, dict):
        raise fail(400, "VALIDATION_ERROR", "Dữ liệu gửi lên phải là JSON object.")
    return data


# ==============================================================================
# AuthManager: cấu hình hash, migration, session
# ==============================================================================

class AuthManager:
    def __init__(
        self,
        settings_getter: Callable[[], dict],
        settings_saver: Callable[[dict, list], bool],
        bootstrap_file: str = "",
        test_mode: bool = False,
        now_fn: Callable[[], float] = time.time,
    ):
        self._settings_getter = settings_getter
        self._settings_saver = settings_saver
        self.bootstrap_file = bootstrap_file
        self.test_mode = bool(test_mode)
        self._now = now_fn
        self._lock = threading.RLock()
        self._audit_lock = threading.Lock()
        default_audit = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "logs", "audit.jsonl")
        self._audit_path = os.environ.get("CCTV_AUDIT_LOG") or default_audit
        self.admin_hash = ""
        self.viewer_hash = ""
        self.bootstrap = False

        ttl = self._session_ttl_from_env()
        self.sessions = SessionStore(ttl_seconds=ttl, now_fn=now_fn)
        self.login_limiter = LoginRateLimiter(now_fn=now_fn)
        # Bộ đếm riêng cho *mọi* lần đăng nhập (kể cả thành công) để một tài khoản
        # hợp lệ không thể xoay vòng session liên tục. Ngưỡng rộng hơn bộ đếm lỗi.
        self.login_attempt_limiter = LoginRateLimiter(
            now_fn=now_fn,
            per_user_limit=20,
            per_user_window=300.0,
            per_ip_limit=120,
            per_ip_window=900.0,
            global_limit=600,
            global_window=900.0,
            global_block_seconds=60.0,
        )
        self._migrate()

    # -- cấu hình -----------------------------------------------------------
    @staticmethod
    def _session_ttl_from_env() -> int:
        raw = os.environ.get("CCTV_SESSION_TTL_SECONDS")
        if raw:
            try:
                return max(10, min(int(raw), 43200))
            except ValueError:
                pass
        return 43200

    @property
    def session_ttl(self) -> int:
        return self.sessions.ttl_seconds

    def _settings(self) -> dict:
        try:
            data = self._settings_getter()
        except AuthStartupError:
            raise
        except Exception as exc:
            raise AuthStartupError(f"Không đọc được file cấu hình: {exc}") from exc
        return dict(data) if isinstance(data, dict) else {}

    def _save(self, updates: dict, removals: list) -> None:
        try:
            ok = self._settings_saver(updates, removals)
        except Exception as exc:  # pragma: no cover - phòng hộ
            raise AuthStartupError(f"Không thể ghi file cấu hình: {exc}") from exc
        if not ok:
            raise AuthStartupError("Không thể ghi file cấu hình để lưu hash mật khẩu.")

    def _migrate(self) -> None:
        settings = self._settings()
        updates: dict = {}
        removals: list[str] = []

        if "schema_version" not in settings:
            updates["schema_version"] = 2

        admin_hash = str(settings.get("admin_password_hash") or "").strip()
        if admin_hash and parse_hash(admin_hash) is None:
            raise AuthStartupError(
                "admin_password_hash trong file cấu hình không đúng định dạng. "
                "Dừng khởi động để tránh ghi đè dữ liệu."
            )
        viewer_hash = str(settings.get("viewer_password_hash") or "").strip()
        if viewer_hash and parse_hash(viewer_hash) is None:
            raise AuthStartupError("viewer_password_hash trong file cấu hình không đúng định dạng.")

        env_admin = os.environ.get("CCTV_ADMIN_PASSWORD", "")
        legacy_plain = str(settings.get("admin_password") or "").strip()
        bootstrap = bool(settings.get("admin_password_bootstrap", False))

        if not admin_hash:
            if env_admin:
                error = validate_new_password(env_admin)
                if error:
                    raise AuthStartupError(
                        f"CCTV_ADMIN_PASSWORD quá yếu: {error} Hãy đặt mật khẩu mạnh >= {PASSWORD_MIN} ký tự."
                    )
                admin_hash = hash_password(env_admin)
                updates["admin_password_hash"] = admin_hash
                updates["admin_password_bootstrap"] = True
                bootstrap = True
            elif legacy_plain and not is_common_password(legacy_plain) and len(legacy_plain) >= PASSWORD_MIN:
                # Legacy custom password đủ mạnh: hash và xoá plaintext, buộc đổi sau.
                admin_hash = hash_password(legacy_plain)
                updates["admin_password_hash"] = admin_hash
                updates["admin_password_bootstrap"] = True
                bootstrap = True
            else:
                # Không có hash hợp lệ, hoặc plaintext là backdoor/mặc định/quá ngắn:
                # KHÔNG hash lại các giá trị này. Sinh mật khẩu mới ngẫu nhiên.
                new_password = generate_strong_password(20)
                self._write_bootstrap_file(new_password)
                admin_hash = hash_password(new_password)
                updates["admin_password_hash"] = admin_hash
                updates["admin_password_bootstrap"] = True
                bootstrap = True
                if not self.test_mode:
                    print("=" * 68)
                    print("[CCTV] ĐÃ TẠO MẬT KHẨU QUẢN TRỊ TẠM THỜI (chỉ hiển thị một lần):")
                    print(f"        {new_password}")
                    if self.bootstrap_file:
                        print(f"        Đã lưu vào: {self.bootstrap_file}")
                    print("        Hãy đăng nhập và đổi mật khẩu ngay.")
                    print("=" * 68)

        if legacy_plain or "admin_password" in settings:
            removals.append("admin_password")

        legacy_viewer = str(settings.get("viewer_password") or "").strip()
        if not viewer_hash and legacy_viewer:
            viewer_error = validate_new_password(legacy_viewer)
            if viewer_error:
                # Không bao giờ hash lại mật khẩu viewer yếu/backdoor. Viewer
                # sẽ tạm tắt cho tới khi admin đặt mật khẩu mới đủ mạnh.
                if not self.test_mode:
                    print(
                        "[CCTV] Đã bỏ viewer_password cũ vì không đạt chính sách "
                        f"mật khẩu ({viewer_error}). Đăng nhập viewer đang tắt."
                    )
            else:
                viewer_hash = hash_password(legacy_viewer)
                updates["viewer_password_hash"] = viewer_hash
        if legacy_viewer or "viewer_password" in settings:
            removals.append("viewer_password")

        if updates or removals:
            self._save(updates, removals)

        with self._lock:
            self.admin_hash = admin_hash
            self.viewer_hash = viewer_hash
            self.bootstrap = bootstrap

    # -- first-run ----------------------------------------------------------
    def _write_bootstrap_file(self, password: str) -> None:
        path = self.bootstrap_file
        if not path:
            if self.test_mode:
                return
            raise AuthStartupError(
                "Chưa cấu hình CCTV_BOOTSTRAP_FILE và không có mật khẩu admin. "
                "Hãy đặt CCTV_ADMIN_PASSWORD mạnh hoặc cấu hình file bootstrap ghi được."
            )
        try:
            parent = os.path.dirname(os.path.abspath(path))
            if parent:
                os.makedirs(parent, exist_ok=True)
            flags = os.O_CREAT | os.O_WRONLY | os.O_TRUNC
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            fd = os.open(path, flags, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(
                    "CCTV VISION HUB - MẬT KHẨU QUẢN TRỊ TẠM THỜI\n"
                    "Hãy đăng nhập và đổi mật khẩu ngay. Xoá file này sau khi đổi.\n\n"
                    f"{password}\n"
                )
            secure_file_permissions(path)
        except Exception as exc:
            raise AuthStartupError(
                f"Không thể ghi file bootstrap '{path}': {exc}. "
                "Dừng khởi động để không tạo trạng thái nửa vời."
            ) from exc

    def _delete_bootstrap_file(self) -> None:
        path = self.bootstrap_file
        if not path or not os.path.exists(path):
            return
        try:
            os.remove(path)
        except OSError:
            pass

    @property
    def first_run(self) -> bool:
        with self._lock:
            return bool(self.bootstrap)

    @property
    def viewer_login_enabled(self) -> bool:
        with self._lock:
            return bool(self.viewer_hash)

    # -- xác thực -----------------------------------------------------------
    def verify(self, username: str, password: str) -> tuple[bool, str]:
        """Trả ``(ok, reason)`` với reason ``ok|invalid|viewer_disabled``."""
        username = (username or "").strip().lower()
        if username == "admin":
            stored = self.admin_hash
        elif username == "viewer":
            if not self.viewer_hash:
                dummy_verify(password)
                return False, "viewer_disabled"
            stored = self.viewer_hash
        else:
            dummy_verify(password)
            return False, "invalid"

        if not stored:
            dummy_verify(password)
            return False, "invalid"

        ok, needs_rehash = verify_password(password, stored)
        if ok and needs_rehash:
            self.update_hash(username, hash_password(password))
        return ok, ("ok" if ok else "invalid")

    def verify_admin_password(self, password: str) -> bool:
        with self._lock:
            stored = self.admin_hash
        if not stored:
            dummy_verify(password)
            return False
        return verify_password(password, stored)[0]

    def update_hash(self, target: str, new_hash: str, bootstrap: Optional[bool] = None) -> None:
        if target == "admin":
            updates = {"admin_password_hash": new_hash}
            if bootstrap is not None:
                updates["admin_password_bootstrap"] = bool(bootstrap)
            self._save(updates, [])
            with self._lock:
                self.admin_hash = new_hash
                if bootstrap is not None:
                    self.bootstrap = bool(bootstrap)
        elif target == "viewer":
            self._save({"viewer_password_hash": new_hash}, [])
            with self._lock:
                self.viewer_hash = new_hash
        else:
            raise ValueError("target không hợp lệ")

    def clear_viewer_password(self) -> None:
        self._save({}, ["viewer_password_hash"])
        with self._lock:
            self.viewer_hash = ""

    def change_admin_password(self, current_password: str, new_password: str) -> tuple[bool, str, str, int]:
        """Đổi mật khẩu admin. Trả ``(ok, code, message, revoked_count)``."""
        if not self.verify_admin_password(current_password):
            return False, "invalid_credentials", "Mật khẩu hiện tại không chính xác.", 0
        with self._lock:
            current_hash = self.admin_hash
        error = validate_new_password(new_password, current_hash)
        if error:
            return False, "validation", error, 0
        new_hash = hash_password(new_password.strip())
        self.update_hash("admin", new_hash, bootstrap=False)
        revoked = self.sessions.revoke_all()
        self._delete_bootstrap_file()
        return True, "ok", "", revoked

    def set_viewer_password(
        self, current_admin_password: str, new_password: Optional[str], clear: bool = False
    ) -> tuple[bool, str, str, int]:
        if not self.verify_admin_password(current_admin_password):
            return False, "invalid_credentials", "Mật khẩu quản trị hiện tại không chính xác.", 0
        if clear:
            self.clear_viewer_password()
        else:
            error = validate_new_password(new_password or "")
            if error:
                return False, "validation", error, 0
            self.update_hash("viewer", hash_password((new_password or "").strip()))
        revoked = self.sessions.revoke_all()
        return True, "ok", "", revoked

    # -- audit --------------------------------------------------------------
    def audit(self, event: str, **fields) -> None:
        if not self._audit_path:
            return
        record = {"ts": now_iso(), "event": event}
        for key, value in fields.items():
            if value is None:
                continue
            record[key] = _redact_value(key, value)
        line = json.dumps(record, ensure_ascii=False) + "\n"
        try:
            with self._audit_lock:
                parent = os.path.dirname(os.path.abspath(self._audit_path))
                if parent:
                    os.makedirs(parent, exist_ok=True)
                with open(self._audit_path, "a", encoding="utf-8") as handle:
                    handle.write(line)
        except Exception:
            pass


# ==============================================================================
# Redaction (log/audit)
# ==============================================================================

_TELEGRAM_TOKEN_RE = re.compile(r"\b\d{6,}:[A-Za-z0-9_-]{20,}\b")
_RTSP_CRED_RE = re.compile(r"(rtsp://)[^/\s:@]+:[^/\s@]+@", re.IGNORECASE)


def redact_text(text: str) -> str:
    if not isinstance(text, str):
        return text
    text = _TELEGRAM_TOKEN_RE.sub("bot***", text)
    text = _RTSP_CRED_RE.sub(r"\1***:***@", text)
    text = re.sub(r"(?i)(password|pwd|token|secret)=([^&\s]+)", r"\1=***", text)
    return text


_SENSITIVE_KEYS = {"password", "new_password", "old_password", "current_password",
                   "admin_password", "telegram_bot_token", "token", "session_token"}


def _redact_value(key: str, value):
    if str(key).lower() in _SENSITIVE_KEYS:
        return "***"
    if isinstance(value, str):
        return redact_text(value)
    return value


# ==============================================================================
# Hook toàn cục
# ==============================================================================

_ACTIVE_MANAGER: Optional[AuthManager] = None
_ACTIVE_POLICY: Optional[AccessPolicy] = None
_ALLOWED_HOSTS: set[str] = set()
_HOOKS_INSTALLED = False


def configure(manager: AuthManager, policy: Optional[AccessPolicy] = None,
              allowed_hosts: Optional[Iterable[str]] = None) -> None:
    global _ACTIVE_MANAGER, _ACTIVE_POLICY, _ALLOWED_HOSTS
    _ACTIVE_MANAGER = manager
    _ACTIVE_POLICY = policy or AccessPolicy()
    if allowed_hosts is not None:
        _ALLOWED_HOSTS = {h.strip().lower() for h in allowed_hosts if h and h.strip()}


def current_manager() -> Optional[AuthManager]:
    return _ACTIVE_MANAGER


def allowed_hosts() -> set[str]:
    return _ALLOWED_HOSTS


def _client_ip_from_environ() -> str:
    return get_client_ip()


def session_key() -> str:
    token = request.get_cookie(SESSION_COOKIE)
    if token:
        return _sha256_hex(token)
    return f"ip:{_client_ip_from_environ()}"


def current_session() -> Optional[dict]:
    manager = _ACTIVE_MANAGER
    if not manager:
        return None
    return manager.sessions.get(request.get_cookie(SESSION_COOKIE))


def _body_limit_for(path: str) -> int:
    if path == "/api/auth/login":
        return 4096
    if path.startswith("/api/settings"):
        return 64 * 1024
    return 1024 * 1024


def _check_content_type_and_size(path: str) -> None:
    if request.method.upper() not in STATE_METHODS:
        return
    length_raw = request.headers.get("Content-Length")
    try:
        length = int(length_raw) if length_raw else 0
    except ValueError:
        raise fail(400, "VALIDATION_ERROR", "Content-Length không hợp lệ.")
    if length > _body_limit_for(path):
        raise fail(413, "PAYLOAD_TOO_LARGE", "Dữ liệu gửi lên quá lớn.")
    content_type = (request.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    if content_type and content_type != "application/json":
        raise fail(415, "UNSUPPORTED_MEDIA_TYPE", "Chỉ chấp nhận Content-Type: application/json.")
    if length > 0 and not content_type and path.startswith("/api/"):
        raise fail(415, "UNSUPPORTED_MEDIA_TYPE", "Chỉ chấp nhận Content-Type: application/json.")
    if length <= 0 and content_type and content_type != "application/json":
        raise fail(415, "UNSUPPORTED_MEDIA_TYPE", "Chỉ chấp nhận Content-Type: application/json.")


def _before_request_hook() -> None:
    rid = request.headers.get("X-Request-Id", "")
    if not _REQUEST_ID_RE.match(rid or ""):
        rid = secrets.token_hex(12)
    request.environ["cctv.request_id"] = rid

    if request.path.startswith("/api/") and len(request.query_string or "") > 2048:
        raise fail(400, "VALIDATION_ERROR", "Query string quá dài (tối đa 2048 ký tự).")

    host = request.headers.get("Host") or request.environ.get("HTTP_HOST") or ""
    if not host_allowed(host, _ALLOWED_HOSTS):
        if request.path.startswith("/api/") or request.path.startswith("/snapshots/") \
                or request.path.startswith("/download/"):
            raise fail(400, "HOST_NOT_ALLOWED", "Host không nằm trong allowlist của máy chủ.")
        raise HTTPResponse(
            status=400,
            body="Host không hợp lệ.",
            headers={"Content-Type": "text/plain; charset=utf-8"},
        )

    manager = _ACTIVE_MANAGER
    policy = _ACTIVE_POLICY
    if manager is None or policy is None:
        return

    path = request.path
    method = request.method.upper()

    rule = policy.classify(method, path)
    if rule is None:
        rule = policy.default_rule(method, path)
    if rule is None:
        return

    if rule.access == PUBLIC:
        if path.startswith("/api/"):
            _check_content_type_and_size(path)
        return

    raw_token = request.get_cookie(SESSION_COOKIE)
    record = manager.sessions.get(raw_token)
    if not record:
        raise fail(401, "UNAUTHENTICATED", "Bạn cần đăng nhập để thực hiện thao tác này.")
    if rule.access == ADMIN and record.get("role") != ADMIN:
        raise fail(403, "FORBIDDEN", "Bạn không có quyền thực hiện thao tác này.")

    if rule.csrf and method in STATE_METHODS:
        csrf = request.headers.get(CSRF_HEADER)
        if not manager.sessions.csrf_valid(record, csrf):
            manager.audit("csrf_failure", client_ip=get_client_ip(), path=path,
                          role=record.get("role"))
            raise fail(403, "CSRF_INVALID", "Thiếu hoặc sai CSRF token.")
        origin = request.headers.get("Origin")
        if origin is not None:
            if not _origin_allowed(origin, host):
                manager.audit("origin_mismatch", client_ip=get_client_ip(), path=path)
                raise fail(403, "ORIGIN_MISMATCH", "Origin không hợp lệ.")
        else:
            fetch_site = (request.headers.get("Sec-Fetch-Site") or "").strip().lower()
            if fetch_site not in ("", "same-origin", "none"):
                raise fail(403, "ORIGIN_MISMATCH", "Origin không hợp lệ.")

    if path.startswith("/api/"):
        _check_content_type_and_size(path)

    request.environ["cctv.session"] = record
    request.environ["cctv.session_token"] = raw_token or ""


def apply_security_headers(target) -> None:
    """Gắn security headers lên ``bottle.response`` hoặc ``HTTPResponse``.

    Error handler 404/405/413/500 trả ``HTTPResponse`` nên không đi qua
    ``after_request``; các handler đó phải gọi trực tiếp hàm này.
    """
    target.set_header("Content-Security-Policy", CSP_POLICY)
    target.set_header("X-Content-Type-Options", "nosniff")
    target.set_header("X-Frame-Options", "DENY")
    target.set_header("Referrer-Policy", "no-referrer")
    target.set_header("Permissions-Policy", PERMISSIONS_POLICY)
    target.set_header("Cross-Origin-Opener-Policy", "same-origin")
    target.set_header("Cross-Origin-Resource-Policy", "same-origin")
    target.set_header("X-Permitted-Cross-Domain-Policies", "none")
    target.set_header("X-Request-Id", _request_id())
    if request_is_https():
        target.set_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")

    path = request.path or "/"
    if path.startswith("/api/") or path == "/" or path.startswith("/snapshots/") \
            or path.startswith("/download/"):
        target.set_header("Cache-Control", "no-store, no-cache, must-revalidate")
        target.set_header("Pragma", "no-cache")
    elif path in ("/manifest.json", "/sw.js"):
        target.set_header("Cache-Control", "no-cache, must-revalidate")
    elif path.startswith("/static/"):
        target.set_header("Cache-Control", "public, max-age=3600")
    else:
        target.set_header("Cache-Control", "no-store, no-cache, must-revalidate")
        target.set_header("Pragma", "no-cache")

    if path.startswith("/api/"):
        target.set_header("X-CCTV-API-Version", str(API_VERSION))


def _after_request_hook() -> None:
    apply_security_headers(response)


def install_hooks(app) -> None:
    """Gắn hook vào Bottle app. Gọi một lần sau khi configure()."""
    global _HOOKS_INSTALLED
    app.add_hook("before_request", _before_request_hook)
    app.add_hook("after_request", _after_request_hook)
    _HOOKS_INSTALLED = True


def hooks_installed() -> bool:
    return _HOOKS_INSTALLED


# ==============================================================================
# Decorator cho route
# ==============================================================================

def _enforce_route_access(required_role: str) -> None:
    manager = _ACTIVE_MANAGER
    if manager is None:
        return
    record = request.environ.get("cctv.session")
    if record is None:
        raw_token = request.get_cookie(SESSION_COOKIE)
        record = manager.sessions.get(raw_token)
    if not record:
        raise fail(401, "UNAUTHENTICATED", "Bạn cần đăng nhập để thực hiện thao tác này.")
    if required_role == ADMIN and record.get("role") != ADMIN:
        raise fail(403, "FORBIDDEN", "Bạn không có quyền thực hiện thao tác này.")


def public(func):
    """Đánh dấu route công khai (không cần đăng nhập)."""
    func.cctv_access = PUBLIC

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        return func(*args, **kwargs)

    wrapper.cctv_access = PUBLIC
    return wrapper


def require_role(role: str):
    """Yêu cầu vai trò tối thiểu (viewer/admin). Hook trung tâm vẫn là lớp chính."""
    role = (role or "").strip().lower()
    if role not in (VIEWER, ADMIN):
        raise ValueError("role phải là viewer hoặc admin")

    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            _enforce_route_access(role)
            return func(*args, **kwargs)

        wrapper.cctv_access = role
        return wrapper

    return decorator


def rate_limit(name: str, limit: int, window: float, scope: str = "ip"):
    """Giới hạn số request theo IP hoặc theo session."""
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            key = session_key() if scope == "session" else get_client_ip()
            limiter = get_rate_limiter(name, limit, window)
            allowed, retry = limiter.hit(f"{scope}:{key}")
            if not allowed:
                manager = _ACTIVE_MANAGER
                if manager:
                    manager.audit("rate_limited", endpoint=name, client_ip=get_client_ip())
                raise fail(
                    429, "RATE_LIMITED", "Bạn thao tác quá nhanh, vui lòng thử lại sau.",
                    details={"retry_after_seconds": retry},
                    headers={"Retry-After": str(retry)},
                )
            return func(*args, **kwargs)

        return wrapper

    return decorator


def reset_rate_limiters() -> None:
    with _RATE_LIMITERS_LOCK:
        for limiter in _RATE_LIMITERS.values():
            limiter.reset()
