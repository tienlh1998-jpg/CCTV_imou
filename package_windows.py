#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Đóng gói CCTV Vision Hub thành ZIP phát hành an toàn cho Windows.

Nguyên tắc:
- Chỉ đóng gói theo allowlist (mã nguồn chạy, templates, asset tự chứa, tài liệu phát hành).
- Tuyệt đối không đưa cấu hình thật / bí mật / log / APK / ZIP cũ vào gói.
- Không sao chép ZIP vào ``static/`` hay thư mục cha; chỉ xuất trong ``dist/``.
- Sinh kèm file SHA-256 để người vận hành kiểm tra tính toàn vẹn.

Cách dùng:
    python package_windows.py
    python package_windows.py --output-dir D:\\release
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import zipfile
from pathlib import Path
from typing import Iterable

BASE_DIR = Path(__file__).resolve().parent
VERSION = "2.0.0"
ZIP_BASENAME = f"CCTVVisionHub_Windows_{VERSION}.zip"

# Các module Python cần có trong gói chạy. File không tồn tại sẽ được bỏ qua
# (ví dụ giai đoạn chuyển tiếp chưa có module mới), nhưng app.py là bắt buộc.
RUNTIME_MODULES = (
    "app.py",
    "auth.py",              # module xác thực mới
    "security.py",          # tên module theo đặc tả kỹ thuật
    "settings_store.py",
    "credentials.py",
    "camera_urls.py",
    "camera_media.py",
    "managed_manager.py",
    "alarm_manager.py",
    "telegram_service.py",
    "scan_imou.py",
    "onvif_manager.py",
    "cctv_tray.py",
)

ROOT_FILES = (
    "requirements.txt",
    "README.md",
    "HUONG_DAN_SU_DUNG_WINDOWS.txt",
    "settings.example.json",
    "managed_cameras.example.json",
    "run_windows.bat",
    "run_windows_tray.bat",
    "install_windows_startup.bat",
)

# Thư mục được phép đóng gói (đường dẫn tương đối, có dấu / ở cuối).
ALLOWED_DIRS = (
    "templates/",
    "static/css/",
    "static/js/",
    "static/icons/",
    "dahua/",
)

# File đơn lẻ trong static được phép đóng gói.
ALLOWED_STATIC_FILES = (
    "static/manifest.json",
    "static/sw.js",
    "static/offline.html",
)

# Phòng thủ nhiều lớp: nếu các mục này lọt vào danh sách, dừng đóng gói.
FORBIDDEN_NAMES = {
    "settings.json",
    "managed_cameras.json",
    ".env",
    "python_installer.exe",
    "python_3.11.9.zip",
    "cctvvishub.apk",
    "cctvvisionhub.apk",
    "cctvvisionhub_windows.zip",
}
FORBIDDEN_PARTS = {
    "__pycache__",
    ".git",
    ".venv",
    "python_env",
    "recordings",
    "snapshots",
    "data",
    "logs",
    "backups",
    "dist",
    "build",
    "tests",
    "docs",
    "android",
    "scripts",
    ".antigravity",
    ".pytest_cache",
}
FORBIDDEN_SUFFIXES = (".log", ".zip", ".apk", ".pyc", ".pyo", ".bak", ".tmp", ".swp")

# Chỉ đóng gói các đuôi file an toàn trong thư mục được allowlist.
SAFE_SUFFIXES = {
    ".py", ".html", ".css", ".js", ".json", ".svg", ".png", ".ico",
    ".jpg", ".jpeg", ".webp", ".woff2", ".woff", ".ttf", ".txt", ".md",
}


def _is_forbidden(rel: Path) -> bool:
    parts = {p.lower() for p in rel.parts}
    if parts & FORBIDDEN_PARTS:
        return True
    name = rel.name.lower()
    if name in FORBIDDEN_NAMES:
        return True
    if name.startswith("."):
        return True
    if name.endswith(FORBIDDEN_SUFFIXES):
        return True
    return False


def _iter_dir(rel_dir: str) -> Iterable[Path]:
    """Duyệt thư mục được allowlist, bỏ file rác/không an toàn."""
    root = BASE_DIR / rel_dir
    if not root.is_dir():
        return
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(BASE_DIR)
        if _is_forbidden(rel):
            continue
        if path.suffix.lower() not in SAFE_SUFFIXES:
            continue
        yield rel


def iter_release_files() -> list[Path]:
    """Trả về danh sách tương đối các file sẽ nằm trong ZIP phát hành."""
    files: list[Path] = []

    for name in RUNTIME_MODULES:
        path = BASE_DIR / name
        if path.is_file():
            files.append(Path(name))

    if Path("app.py") not in files:
        raise SystemExit("[!] Không tìm thấy app.py — không thể đóng gói.")

    for name in ROOT_FILES:
        path = BASE_DIR / name
        if path.is_file():
            files.append(Path(name))
        elif name in {"README.md", "requirements.txt"}:
            print(f"[!] Cảnh báo: thiếu tài liệu bắt buộc {name}")

    for rel in ALLOWED_STATIC_FILES:
        if (BASE_DIR / rel).is_file():
            files.append(Path(rel))

    for rel_dir in ALLOWED_DIRS:
        files.extend(_iter_dir(rel_dir))

    # Khử trùng lặp, giữ thứ tự ổn định.
    unique: dict[str, Path] = {}
    for rel in files:
        unique[rel.as_posix()] = rel
    return [unique[key] for key in sorted(unique)]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_package(output_dir: Path | None = None) -> dict:
    """Tạo ZIP phát hành và file SHA-256. Trả về thông tin gói."""
    out_dir = Path(output_dir) if output_dir else BASE_DIR / "dist"
    out_dir.mkdir(parents=True, exist_ok=True)
    zip_path = out_dir / ZIP_BASENAME
    sha_path = out_dir / f"{ZIP_BASENAME}.sha256"

    if zip_path.exists():
        zip_path.unlink()

    files = iter_release_files()
    forbidden_found = [rel.as_posix() for rel in files if rel.name.lower() in FORBIDDEN_NAMES]
    if forbidden_found:
        raise SystemExit(f"[!] Từ chối đóng gói vì có file bí mật: {forbidden_found}")

    print(f"[*] Đang đóng gói {len(files)} tệp vào {zip_path.name} ...")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zipf:
        for rel in files:
            full = BASE_DIR / rel
            arcname = f"CCTVVisionHub/{rel.as_posix()}"
            zipf.write(full, arcname)

    # Kiểm tra hậu kiểm: ZIP không được chứa bí mật/artifact cũ.
    with zipfile.ZipFile(zip_path, "r") as zipf:
        names = zipf.namelist()
    bad = [
        name for name in names
        if Path(name).name.lower() in FORBIDDEN_NAMES
        or name.lower().endswith((".log", ".apk", ".zip", ".bak"))
        or "/python_env/" in name.lower()
        or "/__pycache__/" in name.lower()
    ]
    if bad:
        zip_path.unlink(missing_ok=True)
        raise SystemExit(f"[!] ZIP chứa file bị cấm, đã huỷ gói: {bad}")

    digest = _sha256(zip_path)
    sha_path.write_text(f"{digest}  {ZIP_BASENAME}\n", encoding="utf-8")

    size_mb = zip_path.stat().st_size / (1024 * 1024)
    print(f"[OK] Đã tạo {zip_path} ({len(files)} tệp, {size_mb:.2f} MB)")
    print(f"[OK] SHA-256: {digest}")
    print(f"[OK] File kiểm tra: {sha_path}")
    print("[i] Gói KHÔNG chứa settings.json / managed_cameras.json / log / APK / ZIP.")
    print("[i] Không có link tải công khai. Hãy phân phối gói qua kênh nội bộ an toàn.")
    print("[i] Cấu hình mẫu: settings.example.json và managed_cameras.example.json.")

    return {
        "zip_path": str(zip_path),
        "sha256_path": str(sha_path),
        "sha256": digest,
        "file_count": len(files),
        "size_bytes": zip_path.stat().st_size,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Đóng gói CCTV Vision Hub bản Windows an toàn.")
    parser.add_argument(
        "--output-dir",
        default=str(BASE_DIR / "dist"),
        help="Thư mục xuất ZIP (mặc định: ./dist). Không được trỏ vào static/.",
    )
    args = parser.parse_args(argv)

    out_dir = Path(args.output_dir).resolve()
    static_dir = (BASE_DIR / "static").resolve()
    try:
        out_dir.relative_to(static_dir)
        print("[!] Không được xuất ZIP vào static/ vì sẽ phát tán công khai.", file=sys.stderr)
        return 2
    except ValueError:
        pass

    try:
        build_package(out_dir)
    except SystemExit as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
