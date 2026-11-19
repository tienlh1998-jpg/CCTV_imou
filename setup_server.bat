@echo off
chcp 65001 >nul
title CCTV Vision Hub - Setup Server (1-Click)
color 0a
cd /d "%~dp0"

echo =================================================================
echo        CCTV VISION HUB - THIET LAP MAY CHU 24/7 (1-CLICK)
echo =================================================================
echo.

:: 1. Mo Firewall cong 8080 va ICMP Ping
echo [*] Buoc 1: Dang mo tuong lua (Firewall) cho cong 8080 va Ping...
netsh advfirewall firewall delete rule name="CCTV_VisionHub_8080" >nul 2>&1
netsh advfirewall firewall add rule name="CCTV_VisionHub_8080" dir=in action=allow protocol=TCP localport=8080 >nul
netsh advfirewall firewall add rule name="Allow ICMPv4-In" protocol=icmpv4:8,any dir=in action=allow >nul
echo [OK] Da mo cong 8080 tren Windows Firewall!
echo.

:: 2. Cai dat tu dong khoi dong ngam 24/7 cung Windows (Startup)
echo [*] Buoc 2: Dang cai dat tu dong chay ngam 24/7 cung Windows...
set "SCRIPT_DIR=%~dp0"
set "RUN_PYTHON=%SCRIPT_DIR%python_env\tools\pythonw.exe"
if not exist "%RUN_PYTHON%" set "RUN_PYTHON=%SCRIPT_DIR%python_env\tools\python.exe"

set "RUNNER_FILE=%SCRIPT_DIR%cctv_startup_runner.bat"
set "VBS_FILE=%SCRIPT_DIR%cctv_silent_starter.vbs"
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_FOLDER%\CCTVVisionHub.vbs"

if not exist "logs" mkdir "logs"

(
echo @echo off
echo chcp 65001 ^>nul
echo cd /d "%%~dp0"
echo if exist "%%~dp0ffmpeg\bin" set "PATH=%%~dp0ffmpeg\bin;%%PATH%%"
echo if not exist "logs" mkdir "logs"
echo echo [%%DATE%% %%TIME%%] Bat dau khoi dong CCTV Vision Hub ^>^> "logs\startup.log"
echo "%RUN_PYTHON%" app.py ^>^> "logs\startup.log" 2^>^&1
echo echo [%%DATE%% %%TIME%%] Tien trinh ket thuc voi ma %%ERRORLEVEL%% ^>^> "logs\startup.log"
) > "%RUNNER_FILE%"

(
echo Option Explicit
echo Dim sh
echo Set sh = CreateObject^("WScript.Shell"^)
echo sh.CurrentDirectory = "%SCRIPT_DIR%"
echo sh.Run Chr^(34^) ^& "%RUNNER_FILE%" ^& Chr^(34^), 0, False
) > "%VBS_FILE%"

if not exist "%STARTUP_FOLDER%" mkdir "%STARTUP_FOLDER%" >nul 2>&1
copy /y "%VBS_FILE%" "%SHORTCUT_PATH%" >nul
echo [OK] Da cai vao Startup thanh cong!
echo.

:: 3. Tat cac tien trinh cu va khoi dong ngam ngay lap tuc
echo [*] Buoc 3: Dang khoi dong ung dung chay ngam ngay lap tuc...
taskkill /f /im python.exe /fi "WINDOWTITLE eq CCTV*" >nul 2>&1
taskkill /f /im pythonw.exe >nul 2>&1
timeout /t 2 >nul
start "" "%VBS_FILE%"

echo.
echo =================================================================
echo [OK] DA HOAN TAT CAI DAT MAY CHU!
echo      - Ung dung dang chay ngam (khong hien cua so den).
echo      - Tu dong bat moi khi khoi dong lai server.
echo      - Dia chi truy cap: http://192.168.19.14:8080
echo =================================================================
echo.
pause
