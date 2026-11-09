@echo off
chcp 65001 >nul
title Cai Dat CCTV Hub Tu Dong Khoi Dong Cung Windows
color 0a
setlocal EnableExtensions

cd /d "%~dp0"

set "SCRIPT_DIR=%~dp0"
set "VBS_FILE=%SCRIPT_DIR%cctv_silent_starter.vbs"
set "RUNNER_FILE=%SCRIPT_DIR%cctv_startup_runner.bat"
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_FOLDER%\CCTVVisionHub.vbs"

echo =================================================================
echo   CAI DAT CCTV VISION HUB CHAY NGAM 24/7 KHI BAT MAY WINDOWS
echo =================================================================
echo.
echo [!] CANH BAO: Dich vu se chay nen bang tai khoan hien tai va co the
echo     truy cap camera/Telegram theo cau hinh trong settings.json.
echo     Chi cai dat tren may chu do ban quan ly.
echo.
set /p "CONFIRM=Tiep tuc cai dat? (Y/N): "
if /i not "%CONFIRM%"=="Y" (
    echo [!] Da huy. Khong thay doi gi.
    pause
    exit /b 1
)

:: 1. Tim Python (uu tien python_env, sau do PATH; luu duong dan tuyet doi)
set "PYTHONW_EXE=%SCRIPT_DIR%python_env\tools\pythonw.exe"
set "PYTHON_EXE=%SCRIPT_DIR%python_env\tools\python.exe"

if exist "%PYTHON_EXE%" goto :check_python

set "PYTHON_EXE="
set "PYTHONW_EXE="
for /f "delims=" %%P in ('where python 2^>nul') do (
    set "PYTHON_EXE=%%P"
    goto :found_python
)
goto :python_missing

:found_python
for /f "delims=" %%P in ('where pythonw 2^>nul') do (
    set "PYTHONW_EXE=%%P"
    goto :check_python
)
goto :check_python

:python_missing
echo [!] LOI: Khong tim thay Python 3 (pythonw/python).
echo     Da kiem tra python_env\tools\pythonw.exe va PATH.
echo     Cai Python 3.11 va tich chon "Add python.exe to PATH" roi thu lai.
echo     Script KHONG tu cai Python va KHONG dang ky startup khi thieu Python.
pause
exit /b 1

:check_python
"%PYTHON_EXE%" --version >nul 2>&1
if errorlevel 1 (
    echo [!] LOI: "%PYTHON_EXE%" khong chay duoc.
    pause
    exit /b 1
)

:have_python
:: Kiem tra dependency toi thieu, khong tu pip install trong startup
"%PYTHON_EXE%" -c "import bottle, requests, PIL, urllib3, certifi" >nul 2>&1
if errorlevel 1 (
    echo [!] Thieu thu vien Python. Chay lenh sau roi thu lai:
    echo     "%PYTHON_EXE%" -m pip install -r requirements.txt
    pause
    exit /b 1
)

if not exist "logs" mkdir "logs"
if not defined CCTV_HOST set "CCTV_HOST=0.0.0.0"
if not defined CCTV_PORT set "CCTV_PORT=8080"
if not defined CCTV_SETTINGS_FILE set "CCTV_SETTINGS_FILE=%SCRIPT_DIR%settings.json"
if not defined CCTV_MANAGED_FILE set "CCTV_MANAGED_FILE=%SCRIPT_DIR%managed_cameras.json"
if not defined CCTV_BOOTSTRAP_FILE set "CCTV_BOOTSTRAP_FILE=%SCRIPT_DIR%data\bootstrap_admin.txt"
if not defined CCTV_APP_LOG set "CCTV_APP_LOG=%SCRIPT_DIR%logs\app.log"
if not defined CCTV_AUDIT_LOG set "CCTV_AUDIT_LOG=%SCRIPT_DIR%logs\audit.jsonl"

set "RUN_PYTHON=%PYTHON_EXE%"
if defined PYTHONW_EXE if exist "%PYTHONW_EXE%" set "RUN_PYTHON=%PYTHONW_EXE%"

echo.
echo [*] Python : "%RUN_PYTHON%"
echo [*] Server : %CCTV_HOST%:%CCTV_PORT%
echo [*] Log    : %SCRIPT_DIR%logs\startup.log

:: 2. Tao runner (batch) de VBS goi an; runner tu ghi log startup
(
echo @echo off
echo chcp 65001 ^>nul
echo cd /d "%%~dp0"
echo if not exist "logs" mkdir "logs"
echo set "CCTV_HOST=%CCTV_HOST%"
echo set "CCTV_PORT=%CCTV_PORT%"
echo set "CCTV_SETTINGS_FILE=%CCTV_SETTINGS_FILE%"
echo set "CCTV_MANAGED_FILE=%CCTV_MANAGED_FILE%"
echo set "CCTV_BOOTSTRAP_FILE=%CCTV_BOOTSTRAP_FILE%"
echo set "CCTV_APP_LOG=%CCTV_APP_LOG%"
echo set "CCTV_AUDIT_LOG=%CCTV_AUDIT_LOG%"
echo echo [%%DATE%% %%TIME%%] Bat dau khoi dong CCTV Vision Hub ^>^> "logs\startup.log"
echo "%RUN_PYTHON%" app.py ^>^> "logs\startup.log" 2^>^&1
echo echo [%%DATE%% %%TIME%%] Tien trinh ket thuc voi ma %%ERRORLEVEL%% ^>^> "logs\startup.log"
) > "%RUNNER_FILE%"

if not exist "%RUNNER_FILE%" (
    echo [!] Khong tao duoc file runner: %RUNNER_FILE%
    pause
    exit /b 1
)

:: 3. Tao VBS chay an, goi runner
(
echo Option Explicit
echo Dim sh
echo Set sh = CreateObject^("WScript.Shell"^)
echo sh.CurrentDirectory = "%SCRIPT_DIR%"
echo sh.Run Chr^(34^) ^& "%RUNNER_FILE%" ^& Chr^(34^), 0, False
) > "%VBS_FILE%"

if not exist "%VBS_FILE%" (
    echo [!] Khong tao duoc file VBS: %VBS_FILE%
    pause
    exit /b 1
)

:: 4. Sao chep vao Startup
if not exist "%STARTUP_FOLDER%" mkdir "%STARTUP_FOLDER%" >nul 2>&1
copy /y "%VBS_FILE%" "%SHORTCUT_PATH%" >nul
if errorlevel 1 (
    echo [!] Khong ghi duoc vao thu muc Startup:
    echo     %SHORTCUT_PATH%
    echo     Kiem tra quyen ghi hoac tao shortcut thu cong.
    pause
    exit /b 1
)

echo.
echo [OK] Da dang ky CCTV Vision Hub tu khoi dong cung Windows.
echo [i] Log khoi dong: %SCRIPT_DIR%logs\startup.log
echo [i] Go bo: xoa file
echo     %SHORTCUT_PATH%
echo     va cac file cctv_silent_starter.vbs / cctv_startup_runner.bat trong thu muc du an.
echo.
echo [i] Khuyen nghi siet ACL (chay PowerShell voi quyen phu hop):
echo     icacls settings.json /inheritance:r /grant:r "%USERNAME%:(R,W)"
echo     icacls managed_cameras.json /inheritance:r /grant:r "%USERNAME%:(R,W)"
echo.
echo =================================================================
pause
