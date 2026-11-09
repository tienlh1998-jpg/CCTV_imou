#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CCTV Vision Hub — đóng gói PyInstaller (Windows).

- Chỉ nhúng mã nguồn, templates, asset an toàn và package `dahua/`.
- KHÔNG nhúng settings.json, managed_cameras.json, log, ZIP, APK hay static/download.
- Không tự cài PyInstaller khi chưa được xác nhận.
- Không chạy như một phần của package phát hành (file này không nằm trong ZIP).

Cách dùng:
    python build_windows.py
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DIST_DIR = BASE_DIR / "dist"
BUILD_DIR = BASE_DIR / "build"
ICON_ICO = BASE_DIR / "static" / "icons" / "favicon.ico"

# Chỉ các asset này được nhúng vào EXE. Tuyệt đối không nhúng cả thư mục static
# vì có thể kéo theo APK/ZIP cũ hoặc file cấu hình.
SAFE_STATIC_DIRS = ("static/css", "static/js", "static/icons")
SAFE_STATIC_FILES = ("static/manifest.json", "static/sw.js", "static/offline.html")


def _add_data_arg(source: Path, dest: str) -> str:
    return f"--add-data={source}{os.pathsep}{dest}"


def _safe_data_args() -> list[str]:
    args: list[str] = []
    if (BASE_DIR / "templates").is_dir():
        args.append(_add_data_arg(BASE_DIR / "templates", "templates"))
    if (BASE_DIR / "dahua").is_dir():
        args.append(_add_data_arg(BASE_DIR / "dahua", "dahua"))
    for rel in SAFE_STATIC_DIRS:
        path = BASE_DIR / rel
        if path.is_dir():
            args.append(_add_data_arg(path, rel.replace("\\", "/")))
    for rel in SAFE_STATIC_FILES:
        path = BASE_DIR / rel
        if path.is_file():
            args.append(_add_data_arg(path, str(Path(rel).parent).replace("\\", "/")))
    return args


def _ensure_pyinstaller() -> bool:
    try:
        import PyInstaller  # noqa: F401
        return True
    except ImportError:
        pass
    print("[!] Chua cai PyInstaller.")
    print(f"[i] Lenh cai dat: {sys.executable} -m pip install pyinstaller")
    try:
        answer = input("Cai dat PyInstaller ngay? (Y/N): ").strip().lower()
    except EOFError:
        answer = ""
    if answer != "y":
        print("[!] Da huy. Khong thay doi moi truong Python.")
        return False
    result = subprocess.run([sys.executable, "-m", "pip", "install", "pyinstaller"])
    return result.returncode == 0


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build() -> int:
    print("===============================================================")
    print("      DONG GOI CCTV VISION HUB CHO WINDOWS (.EXE)")
    print("===============================================================")

    if not (BASE_DIR / "app.py").is_file():
        print("[!] Khong tim thay app.py.")
        return 1

    if not _ensure_pyinstaller():
        return 1

    for folder in (DIST_DIR, BUILD_DIR):
        if folder.exists():
            shutil.rmtree(folder, ignore_errors=True)

    hidden_imports = [
        "--hidden-import=bottle",
        "--hidden-import=requests",
        "--hidden-import=urllib3",
        "--hidden-import=certifi",
        "--hidden-import=PIL",
        "--hidden-import=PIL.Image",
        "--hidden-import=PIL.ImageDraw",
        "--hidden-import=wsgiref",
        "--hidden-import=wsgiref.simple_server",
        "--hidden-import=socketserver",
    ]

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--windowed",
        "--name=CCTVVisionHub",
    ]
    if ICON_ICO.is_file():
        cmd.append(f"--icon={ICON_ICO}")
    cmd.extend(_safe_data_args())
    cmd.extend(hidden_imports)
    cmd.append(str(BASE_DIR / "app.py"))

    print("[*] Lenh PyInstaller:")
    print("    " + " ".join(cmd))
    result = subprocess.run(cmd, cwd=str(BASE_DIR))
    if result.returncode != 0:
        print(f"[!] PyInstaller that bai voi ma {result.returncode}")
        return result.returncode

    exe_path = DIST_DIR / "CCTVVisionHub" / "CCTVVisionHub.exe"
    if not exe_path.is_file():
        print(f"[!] Khong thay file {exe_path}")
        return 1

    print("\n[OK] DONG GOI THANH CONG!")
    print(f"[i] Thu muc ung dung: {exe_path.parent}")
    print(f"[i] File chay chinh : {exe_path}")
    print(f"[i] SHA-256         : {_sha256(exe_path)}")
    print("\n[!] Khi phan phoi: KHONG copy settings.json / managed_cameras.json / log /")
    print("    recordings / snapshots / python_env vao thu muc dist.")
    print("[i] Ung dung se tao cau hinh va bootstrap admin khi chay lan dau.")
    return 0


if __name__ == "__main__":
    raise SystemExit(build())
