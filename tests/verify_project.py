# -*- coding: utf-8 -*-
"""Invariant tĩnh cho CCTV Vision Hub.

Chạy: python_env\\tools\\python.exe tests\\verify_project.py
Exit code 0 nếu tất cả PASS, 1 nếu có FAIL.

Lưu ý: các mục frontend/đóng gói nằm ngoài phạm vi agent backend có thể FAIL
cho tới khi frontend/agent đóng gói hoàn tất; script in rõ nhóm để không hiểu nhầm.
"""

import ast
import os
import re
import sys

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

RESULTS = []


def read(path: str) -> str:
    try:
        with open(os.path.join(PROJECT_DIR, path), "r", encoding="utf-8", errors="ignore") as handle:
            return handle.read()
    except OSError:
        return ""


def exists(path: str) -> bool:
    return os.path.isfile(os.path.join(PROJECT_DIR, path))


def check(check_id: str, description: str, condition, detail: str = "", group: str = ""):
    passed = bool(condition)
    RESULTS.append({
        "id": check_id, "description": description, "passed": passed,
        "detail": detail, "group": group,
    })
    return passed


def fail_if(check_id: str, description: str, hits, group: str = "") -> None:
    hits = list(hits)
    check(check_id, description, not hits,
          "" if not hits else "vi phạm: " + ", ".join(str(item) for item in hits[:8]),
          group=group)


# ==============================================================================
# V01 file bắt buộc
# ==============================================================================

BACKEND_FILES = [
    "app.py", "auth.py", "alarm_manager.py", "telegram_service.py",
    "managed_manager.py", "cctv_tray.py",
    "tests/test_security.py", "tests/test_server.py", "tests/support.py",
    "tests/verify_project.py", "tests/ui_smoke.py",
    "tests/fixtures/scan_devices.json",
]
missing_backend = [path for path in BACKEND_FILES if not exists(path)]
check("V01a", "File backend/test bắt buộc tồn tại", not missing_backend,
      "thiếu: " + ", ".join(missing_backend), group="backend")

UI_FILES = [
    "templates/index.html", "static/css/app.css", "static/js/core.js",
    "static/js/views/dashboard.js", "static/js/views/live.js",
    "static/js/views/cameras.js", "static/js/views/scanner.js",
    "static/js/views/storage.js", "static/js/views/alarms.js",
    "static/js/views/settings.js",
]
missing_ui = [path for path in UI_FILES if not exists(path)]
check("V01b", "File giao diện mới bắt buộc tồn tại", not missing_ui,
      "thiếu (dự kiến khi frontend chưa bàn giao): " + ", ".join(missing_ui),
      group="frontend")

# ==============================================================================
# V02 AST: route có decorator public/require_role
# ==============================================================================

def _decorator_name(node) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Call):
        return _decorator_name(node.func)
    if isinstance(node, ast.Attribute):
        return node.attr
    return ""


def check_route_decorators() -> None:
    path = os.path.join(PROJECT_DIR, "app.py")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            tree = ast.parse(handle.read(), filename=path)
    except Exception as exc:
        check("V02", "Mọi route có decorator public/require_role", False, str(exc), group="backend")
        return
    routes = 0
    unmarked = []
    for node in tree.body:
        if not isinstance(node, ast.FunctionDef):
            continue
        decorator_names = [_decorator_name(item) for item in node.decorator_list]
        if "route" not in decorator_names:
            continue
        routes += 1
        if "public" not in decorator_names and "require_role" not in decorator_names:
            unmarked.append(node.name)
    check("V02", f"Mọi route ({routes}) có decorator public/require_role",
          routes > 0 and not unmarked,
          f"{routes} route; thiếu: {unmarked}", group="backend")


check_route_decorators()


# ==============================================================================
# V03 / V25 backend không còn API cũ / password trong query / new_password
# ==============================================================================

app_source = read("app.py")
auth_source = read("auth.py")

fail_if("V03", "app.py không còn route /api/admin/*",
        re.findall(r"/api/admin/[\w/*<>:.-]+", app_source), group="backend")

fail_if("V25a", "app.py không đọc password từ query",
        re.findall(r'query\.get\(\s*["\'](?:password|pwd)["\']', app_source), group="backend")

fail_if("V25b", "app.py không trả khóa new_password trong response",
        re.findall(r'["\']new_password["\']\s*:', app_source), group="backend")

fail_if("V25c", "app.py không hardcode username=\"admin\" tại call site camera",
        re.findall(r'username\s*=\s*["\']admin["\']', app_source), group="backend")

fail_if("V36", "alarm_manager.py không hardcode username=\"admin\" tại call site",
        re.findall(r'username\s*=\s*["\']admin["\']', read("alarm_manager.py")),
        group="backend")

# ==============================================================================
# V27 Telegram TLS strict
# ==============================================================================

telegram_source = read("telegram_service.py")
fail_if("V27", "telegram_service.py không tắt xác thực TLS",
        [pattern for pattern in ("CERT_NONE", "check_hostname = False", "verify=False")
         if pattern in telegram_source], group="backend")
check("V27b", "telegram_service.py hỗ trợ CCTV_CA_BUNDLE",
      "CCTV_CA_BUNDLE" in telegram_source and "CERT_REQUIRED" in telegram_source,
      group="backend")

# ==============================================================================
# V28 AlarmManager grace / canonical keys / rtsp builder
# ==============================================================================

alarm_source = read("alarm_manager.py")
alarm_ok = (
    "grace_remaining_seconds" in alarm_source
    and "telegram_cooldown_seconds" in alarm_source
    and "telegram_ai_filter_human" in alarm_source
    and "rtsp_url_builder" in alarm_source
    and "admin:{pwd_enc}" not in alarm_source
)
check("V28", "alarm_manager.py có grace, canonical keys, rtsp_url_builder, snapshot theo hãng",
      alarm_ok, group="backend")

# ==============================================================================
# V10 / V11 backdoor, default password, dữ liệu giả
# ==============================================================================

SCAN_FILES = [
    "app.py", "auth.py", "alarm_manager.py", "telegram_service.py",
    "managed_manager.py", "cctv_tray.py",
    "scan_imou.py", "onvif_manager.py",
    "templates/index.html", "static/js/core.js", "static/css/app.css",
    "README.md", "HUONG_DAN_SU_DUNG_WINDOWS.txt", "AGY_INSTRUCTIONS.md",
    "README_RESTORE_HUONG_DAN.txt", "docs/BUILD_APK_GUIDE.md",
]
forbidden_values = []
for relative in SCAN_FILES:
    if not exists(relative):
        continue
    content = read(relative)
    if relative == "auth.py":
        # Loại khỏi phép quét khối denylist mật khẩu phổ biến (đây là biện pháp phòng vệ).
        content = re.sub(r"COMMON_PASSWORDS\s*=\s*\{.*?\}", "", content, flags=re.DOTALL)
    for pattern in ("Camera@2020", "Admin@1998", '"1998"', "'1998'"):
        if pattern in content:
            forbidden_values.append(f"{relative}:{pattern}")
fail_if("V10", "Không còn backdoor/mật khẩu mặc định trong backend/UI/docs",
        forbidden_values, group="security")

# ==============================================================================
# V26 scan_imou: không còn nhánh router Ruijie/gibberish/fake solar
# ==============================================================================

scan_source = read("scan_imou.py")
V26_FORBIDDEN = (
    "get_ruijie_clients", "gibberish", "192.168.10.179", "82ACDA",
    "rejectUnauthorized", "COMPANY_VLANS",
)
fail_if("V26", "scan_imou.py không còn Ruijie/gibberish/fake solar/VLAN hardcode",
        [token for token in V26_FORBIDDEN if token in scan_source],
        group="security")
check("V26b", "gibberish_aes.js đã bị xoá khỏi cây source",
      not exists("gibberish_aes.js"), group="security")

fail_if("V26c", "onvif_manager.py không đặt mật khẩu camera trong query string (CGI fallback)",
        [token for token in ("pwdOld=", "pwd={quote(", "userManager.cgi?action=modifyPassword")
         if token in read("onvif_manager.py")], group="security")
fail_if("V36b", "onvif_manager.py/app.py không hardcode username=\"admin\" tại call site batch",
        re.findall(r'username\s*=\s*["\']admin["\']',
                   read("onvif_manager.py") + "\n" + app_source),
        group="security")

# V29: script build không được hardcode keystore hoặc tải tool runtime.
BUILD_SCRIPT_FILES = [
    "build_exe.bat", "run_windows.bat", "run_windows_tray.bat",
    "install_windows_startup.bat",
]
for root, _dirs, files in os.walk(os.path.join(PROJECT_DIR, "scripts")):
    for name in files:
        if name.endswith((".sh", ".bat", ".ps1", ".py")):
            BUILD_SCRIPT_FILES.append(
                os.path.relpath(os.path.join(root, name), PROJECT_DIR))
build_script_hits = []
for relative in BUILD_SCRIPT_FILES:
    content = read(relative)
    for pattern in ("storepass", "keypass", "rejectUnauthorized: false",
                    "dl.google.com/dl/android", "raw.githubusercontent.com"):
        if pattern in content:
            build_script_hits.append(f"{relative}:{pattern}")
fail_if("V29", "Script build không hardcode keystore hoặc tải tool runtime",
        build_script_hits, group="security")

# V30/V31: secret ngoài + batch IP cập nhật managed
check("V30", "CCTV_SECRETS_FILE được triển khai fail-closed và read-only",
      all(token in app_source for token in (
          "CCTV_SECRETS_FILE", "_load_external_secrets",
          "SECRETS_MANAGED_EXTERNALLY", "secrets_managed_externally")),
      group="security")
check("V31", "batch-ip cập nhật IP mới vào managed_cameras.json",
      "managed_updated" in app_source and "managed_errors" in app_source,
      group="security")

# ==============================================================================
# V04/V05/V06/V07/V08/V09 frontend invariants
# ==============================================================================

UI_SCAN_DIRS = ["templates", "static/js", "static/css"]


def _iter_files(*directories):
    for directory in directories:
        absolute = os.path.join(PROJECT_DIR, directory)
        if not os.path.isdir(absolute):
            continue
        for root, _dirs, files in os.walk(absolute):
            for name in files:
                if name.endswith((".html", ".js", ".css")):
                    yield os.path.relpath(os.path.join(root, name), PROJECT_DIR)


ui_text = {relative: read(relative) for relative in _iter_files(*UI_SCAN_DIRS)}

cdn_hits = []
inline_hits = []
inner_html_hits = []
localstorage_hits = []
password_url_hits = []
deeplink_hits = []

DEEP_LINK_TOKENS = [
    "view_admin", "batch_modal", "settings_admin", "settings_telegram",
    "storage_modal", "stream_solar", "theater", "view_grid", "managed_modal",
    "view_managed", "view_scanner",
]

for relative, content in ui_text.items():
    for pattern in ("cdn.", "unpkg.com", "jsdelivr", "fonts.googleapis",
                    "images.unsplash", 'src="http', "href=\"http", "url(http"):
        if pattern in content:
            cdn_hits.append(f"{relative}:{pattern}")
    if relative.endswith(".html"):
        if re.search(r"<script(?![^>]*\bsrc\s*=)[^>]*>", content, re.IGNORECASE):
            inline_hits.append(f"{relative}:inline-script")
        if re.search(r"\son[a-z]+\s*=", content, re.IGNORECASE):
            inline_hits.append(f"{relative}:inline-handler")
        if re.search(r"<style[\s>]", content, re.IGNORECASE):
            inline_hits.append(f"{relative}:style-tag")
        if re.search(r"\sstyle\s*=", content, re.IGNORECASE):
            inline_hits.append(f"{relative}:style-attr")
    if relative.endswith(".js"):
        for pattern in ("innerHTML", "outerHTML", "insertAdjacentHTML",
                        "document.write", "eval(", "new Function", 'setTimeout("', 'setInterval("'):
            if pattern in content:
                inner_html_hits.append(f"{relative}:{pattern}")
    for match in re.finditer(r"localStorage\.(?:getItem|setItem|removeItem)\(\s*['\"]([^'\"]+)", content):
        key = match.group(1)
        if ("password" in key.lower() or "token" in key.lower() or "secret" in key.lower()) \
                and not key.startswith("cctv.ui."):
            localstorage_hits.append(f"{relative}:{key}")
    if re.search(r"[?&](?:password|pwd|pass|token|secret)=", content):
        password_url_hits.append(relative)
    for token in DEEP_LINK_TOKENS:
        if token in ("theater", "view_grid"):
            # Token quá generic: chỉ coi là deep-link khi xuất hiện như query param.
            if re.search(rf"[?&#](?:{token})=", content):
                deeplink_hits.append(f"{relative}:{token}")
        elif token in content:
            deeplink_hits.append(f"{relative}:{token}")

fail_if("V04", "Không có CDN/tài nguyên ngoài trong UI", cdn_hits, group="frontend")
fail_if("V05", "Không có inline script/style/handler trong HTML", inline_hits, group="frontend")
fail_if("V06", "Không dùng innerHTML/eval/document.write trong JS", inner_html_hits, group="frontend")
fail_if("V07", "Không lưu password/token/secret vào localStorage", localstorage_hits, group="frontend")
fail_if("V08", "Không đưa password/token vào URL", password_url_hits, group="frontend")
fail_if("V09", "Không còn deep-link debug", deeplink_hits, group="frontend")

# ==============================================================================
# V12/V13 static và đóng gói
# ==============================================================================

check("V12", "Không còn static ZIP/APK cũ và log crash",
      not exists("static/CCTVVisionHub_Windows.zip")
      and not exists("static/CCTVVisionHub.apk")
      and not exists("app_crash.log") and not exists("app_test.log"),
      "còn: " + ", ".join(path for path in (
          "static/CCTVVisionHub_Windows.zip", "static/CCTVVisionHub.apk",
          "app_crash.log", "app_test.log") if exists(path)),
      group="packaging")

check("V13a", "settings.json / managed_cameras.json không nằm trong static/",
      not exists("static/settings.json") and not exists("static/managed_cameras.json"),
      group="packaging")

package_source = read("package_windows.py")
check("V13b", "package_windows.py loại settings/managed và không copy ZIP vào static",
      "settings.json" in package_source and "managed_cameras.json" in package_source
      and "STATIC_ZIP" not in package_source,
      group="packaging")

docker_source = read("Dockerfile")
check("V14a", "Dockerfile chạy non-root", re.search(r"^\s*USER\s+\S+", docker_source, re.MULTILINE),
      group="packaging")
check("V14b", "Dockerfile không COPY toàn bộ project",
      "COPY . ." not in docker_source and "COPY . /" not in docker_source,
      group="packaging")
compose_source = read("docker-compose.yml")
check("V14c", "docker-compose không dùng host network",
      not re.search(r"network_mode:\s*[\"']?host", compose_source),
      group="packaging")

ignore_text = read(".dockerignore") + "\n" + read(".gitignore")
ignore_ok = all(token in ignore_text for token in (
    "settings.json", "managed_cameras.json", "*.log", "data/", "logs/",
    "*.zip", "*.apk", "python_env/",
))
check("V15", ".dockerignore/.gitignore chặn secret và artifact", ignore_ok,
      group="packaging")

# ==============================================================================
# V16/V17 PWA
# ==============================================================================

manifest = read("static/manifest.json")
sw = read("static/sw.js")
check("V16", "manifest.json self-hosted, start_url/scope '/', lang vi",
      manifest and "http" not in manifest.replace("https://www.w3.org", "")
      and '"start_url": "/"' in manifest and '"scope": "/"' in manifest
      and '"lang": "vi"' in manifest,
      group="frontend")
check("V17", "sw.js không cache '/', '/api/', '/snapshots/', '/download/'; có skipWaiting",
      sw and all(token not in sw for token in ('"/api/"', "'/api/'", '"/snapshots/"', '"/download/"'))
      and "skipWaiting" in sw,
      group="frontend")
check("V17b", "Có static/offline.html và Service Worker dùng trang offline",
      exists("static/offline.html") and "/static/offline.html" in sw,
      group="frontend")

# ==============================================================================
# V18 viewport
# ==============================================================================

index_html = read("templates/index.html")
check("V18", "Viewport cho phép zoom", "user-scalable=no" not in index_html
      and "maximum-scale=1" not in index_html,
      group="frontend")

# ==============================================================================
# Backend hardening invariants
# ==============================================================================

check("S01", "auth.py có hash scrypt + verify constant-time",
      "hashlib.scrypt" in auth_source and "hmac.compare_digest" in auth_source,
      group="security")
check("S02", "auth.py có session TTL và cookie HttpOnly/SameSite=Strict",
      "expires_at" in auth_source and "HttpOnly; SameSite=Strict" in auth_source,
      group="security")
check("S03", "auth.py có CSRF + Origin + Host allowlist",
      all(token in auth_source for token in ("CSRF_HEADER", "ORIGIN_MISMATCH", "HOST_NOT_ALLOWED")),
      group="security")
check("S04", "auth.py có login rate limit 429 + Retry-After",
      "RATE_LIMITED" in auth_source and "Retry-After" in auth_source,
      group="security")
check("S05", "auth.py gắn security headers + CSP",
      all(token in auth_source for token in (
          "Content-Security-Policy", "X-Frame-Options", "X-Content-Type-Options",
          "Referrer-Policy", "Permissions-Policy", "frame-ancestors 'none'")),
      group="security")
check("S06", "app.py có /api/health, /api/auth/login, /api/system/status",
      all(token in app_source for token in (
          '"/api/health"', '"/api/auth/login"', '"/api/system/status"', '"/api/auth/me"')),
      group="security")
check("S07", "app.py kiểm tra FFmpeg lúc khởi động",
      "_detect_ffmpeg" in app_source and "FFMPEG_UNAVAILABLE" in app_source,
      group="security")
check("S08", "app.py hỗ trợ env test/production",
      all(token in app_source for token in (
          "CCTV_SETTINGS_FILE", "CCTV_DISABLE_ALARMS", "CCTV_PORT",
          "CCTV_HOST", "CCTV_TEST_MODE")),
      group="security")
check("S09", "app.py có JSON error handler cho 404/500",
      "@error(404)" in app_source and "@error(500)" in app_source
      and "INTERNAL_ERROR" in app_source,
      group="security")
check("S10", "managed_manager.py không còn mật khẩu mặc định Camera@2020",
      "Camera@2020" not in read("managed_manager.py"), group="security")
check("S11", "managed_manager.py lưu atomic + chmod best-effort",
      "os.replace" in read("managed_manager.py") and "_secure_permissions" in read("managed_manager.py"),
      group="security")
check("S12", "cctv_tray.py đọc CCTV_PORT và không gọi API toggle khi chưa auth",
      "CCTV_PORT" in read("cctv_tray.py") and "api/alarm/toggle" not in read("cctv_tray.py"),
      group="security")

# ==============================================================================
# Report
# ==============================================================================

def main() -> int:
    groups = {}
    for item in RESULTS:
        groups.setdefault(item["group"] or "other", []).append(item)

    failures = [item for item in RESULTS if not item["passed"]]
    for group_name in sorted(groups):
        print(f"\n[{group_name.upper()}]")
        for item in groups[group_name]:
            status = "PASS" if item["passed"] else "FAIL"
            line = f"  {status}  {item['id']:<6} {item['description']}"
            if item["detail"]:
                line += f"  ({item['detail']})"
            print(line)

    print("\n" + "=" * 78)
    print(f"TỔNG: {len(RESULTS)} check, {len(RESULTS) - len(failures)} PASS, {len(failures)} FAIL")
    if failures:
        print("FAIL: " + ", ".join(item["id"] for item in failures))
        print("Lưu ý: nhóm frontend/packaging có thể FAIL do nằm ngoài phạm vi agent backend.")
    print("=" * 78)
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
