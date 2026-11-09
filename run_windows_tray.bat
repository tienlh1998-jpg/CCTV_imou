@echo off
chcp 65001 >nul
title CCTV Vision Hub - System Tray
color 0e
setlocal EnableExtensions

cd /d "%~dp0"

echo =================================================================
echo    CCTV VISION HUB - CHAY DANG KHAY HE THONG (SYSTEM TRAY)
echo =================================================================
echo.

set "PYTHON_EXE=%~dp0python_env\tools\python.exe"
if not exist "%PYTHON_EXE%" set "PYTHON_EXE=python"

:: 1. Kiem tra Python
"%PYTHON_EXE%" --version >nul 2>&1
if errorlevel 1 (
    echo [!] LOI: Khong tim thay Python 3.
    echo     Da kiem tra python_env\tools\python.exe va lenh "python" trong PATH.
    echo     Cai Python 3.11 va tich chon "Add python.exe to PATH".
    pause
    exit /b 1
)

:: 2. Kiem tra thu vien; KHONG tu dong pip install
"%PYTHON_EXE%" -c "import pystray, PIL, bottle, requests, certifi" >nul 2>&1
if errorlevel 1 (
    echo [!] Thieu thu vien cho khay he thong.
    echo [i] Chay lenh sau de cai dat - can ket noi mang:
    echo     "%PYTHON_EXE%" -m pip install -r requirements.txt
    echo.
    echo [i] Script khong tu cai dependency de tranh thay doi moi truong ngoai y muon.
    pause
    exit /b 1
)

:: 3. Kiem tra FFmpeg (bat buoc cho video)
where ffmpeg >nul 2>&1
if errorlevel 1 (
    echo [!] CANH BAO: Khong tim thay FFmpeg. Live view/audio/ghi hinh se khong hoat dong.
    echo     Cai bang: winget install Gyan.FFmpeg
    echo.
    choice /c YN /n /m "Coi tiep? (Y/N): "
    if errorlevel 2 (
        pause
        exit /b 1
    )
)

:: 4. Bien moi truong
if not defined CCTV_HOST set "CCTV_HOST=0.0.0.0"
if not defined CCTV_PORT set "CCTV_PORT=8080"
if not defined CCTV_SETTINGS_FILE set "CCTV_SETTINGS_FILE=%CD%\settings.json"
if not defined CCTV_MANAGED_FILE set "CCTV_MANAGED_FILE=%CD%\managed_cameras.json"
if not defined CCTV_BOOTSTRAP_FILE set "CCTV_BOOTSTRAP_FILE=%CD%\data\bootstrap_admin.txt"
if not defined CCTV_APP_LOG set "CCTV_APP_LOG=%CD%\logs\app.log"
if not defined CCTV_AUDIT_LOG set "CCTV_AUDIT_LOG=%CD%\logs\audit.jsonl"
if not exist "logs" mkdir "logs"

echo [*] Dang khoi dong ung dung duoi khay he thong...
echo [i] Click chuot phai bieu tuong CCTV de mo web hoac thoat.
echo [i] Web: http://127.0.0.1:%CCTV_PORT%  (host: %CCTV_HOST%)
echo.

"%PYTHON_EXE%" cctv_tray.py
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo.
    echo [!] Ung dung dung voi ma loi %EXIT_CODE%.
    echo [i] Xem logs\app.log, logs\startup.log neu co, va logs\audit.jsonl.
    pause
)
exit /b %EXIT_CODE%
