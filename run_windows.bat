@echo off
chcp 65001 >nul
title CCTV Vision Hub - Giam Sat Camera
color 0b
setlocal EnableExtensions

cd /d "%~dp0"

echo =================================================================
echo        CCTV VISION HUB - KHOI DONG TREN WINDOWS
echo =================================================================
echo.

set "PYTHON_EXE=%~dp0python_env\tools\python.exe"
if not exist "%PYTHON_EXE%" set "PYTHON_EXE=python"

:: 1. Kiem tra Python (khong tu cai, khong chay ngam khi thieu)
"%PYTHON_EXE%" --version >nul 2>&1
if errorlevel 1 (
    echo [!] LOI: Khong tim thay Python 3.
    echo     - Da kiem tra: %~dp0python_env\tools\python.exe
    echo     - Va lenh "python" trong PATH.
    echo.
    echo [i] Cach khac phuc:
    echo     1. Cai Python 3.11 tu https://www.python.org/downloads/
    echo     2. TICH CHON "Add python.exe to PATH" khi cai dat.
    echo     3. Mo lai cua so nay va chay lai run_windows.bat.
    echo.
    pause
    exit /b 1
)

:: 2. Kiem tra thu vien, hoi truoc khi cai
"%PYTHON_EXE%" -c "import bottle, requests, PIL, urllib3, certifi" >nul 2>&1
if errorlevel 1 (
    echo [!] Thieu thu vien Python: bottle, requests, Pillow, urllib3, certifi.
    echo [i] Lenh cai dat:
    echo     "%PYTHON_EXE%" -m pip install -r requirements.txt
    echo.
    choice /c YN /n /m "Cai dat ngay bay gio? (Y/N): "
    if errorlevel 2 (
        echo [!] Da huy. Khong chay ung dung khi thieu thu vien.
        pause
        exit /b 1
    )
    "%PYTHON_EXE%" -m pip install -r requirements.txt
    if errorlevel 1 (
        echo [!] Cai dat that bai. Kiem tra ket noi mang/quyen pip.
        pause
        exit /b 1
    )
)

:: 3. Kiem tra FFmpeg (BAT BUOC cho video/audio/snapshot/ghi hinh)
where ffmpeg >nul 2>&1
if errorlevel 1 (
    echo [!] CANH BAO: Khong tim thay FFmpeg trong PATH.
    echo     FFmpeg la BAT BUOC de xem live view, nghe audio, chup snapshot
    echo     va ghi hinh. Khong co FFmpeg thi /api/health se bao "degraded".
    echo.
    echo [i] Cai tren Windows:
    echo     winget install Gyan.FFmpeg
    echo     hoac tai https://ffmpeg.org/download.html va them thu muc bin vao PATH.
    echo.
    choice /c YN /n /m "Coi tiep khoi dong? (Y/N): "
    if errorlevel 2 (
        echo [!] Da huy. Hay cai FFmpeg roi chay lai.
        pause
        exit /b 1
    )
) else (
    echo [OK] Da tim thay FFmpeg.
)

:: 4. Bien moi truong (khong hardcode cong)
if not defined CCTV_HOST set "CCTV_HOST=0.0.0.0"
if not defined CCTV_PORT set "CCTV_PORT=8080"
if not defined CCTV_SETTINGS_FILE set "CCTV_SETTINGS_FILE=%CD%\settings.json"
if not defined CCTV_MANAGED_FILE set "CCTV_MANAGED_FILE=%CD%\managed_cameras.json"
if not defined CCTV_BOOTSTRAP_FILE set "CCTV_BOOTSTRAP_FILE=%CD%\data\bootstrap_admin.txt"
if not defined CCTV_APP_LOG set "CCTV_APP_LOG=%CD%\logs\app.log"
if not defined CCTV_AUDIT_LOG set "CCTV_AUDIT_LOG=%CD%\logs\audit.jsonl"
if not exist "logs" mkdir "logs"

echo.
echo [*] Python : "%PYTHON_EXE%"
echo [*] Server : %CCTV_HOST%:%CCTV_PORT%
echo     - May tinh nay : http://127.0.0.1:%CCTV_PORT%
echo     - Mang LAN     : http://^<IP_MAY_TINH^>:%CCTV_PORT%
echo.
if "%CCTV_HOST%"=="0.0.0.0" (
    echo [!] Server lang nghe 0.0.0.0 - chi dung trong LAN tin cay,
    echo     KHONG mo cong nay truc tiep ra Internet.
    echo.
)
echo [i] Lan dau chay: xem file bootstrap admin: %CCTV_BOOTSTRAP_FILE%
echo [i] Trinh duyet se tu dong mo khi /api/health tra 200 (toi da 20 giay).
echo [i] Nhan Ctrl+C de dung he thong.
echo =================================================================
echo.

:: 5. Mo trinh duyet sau khi health san sang (khong chan server)
where powershell >nul 2>&1
if not errorlevel 1 (
    start "" /b powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$u='http://127.0.0.1:%CCTV_PORT%/api/health'; for($i=0;$i -lt 20;$i++){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 2; if($r.StatusCode -eq 200){ Start-Process 'http://127.0.0.1:%CCTV_PORT%/'; break } } catch {}; Start-Sleep -Seconds 1 }"
)

:: 6. Khoi chay app.py (khong an; log do app ghi vao logs/)
"%PYTHON_EXE%" app.py
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo [!] May chu da dung voi ma loi %EXIT_CODE%.
    echo [i] Xem logs\app.log va logs\audit.jsonl de biet chi tiet.
    pause
)
exit /b %EXIT_CODE%

