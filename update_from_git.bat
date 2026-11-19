@echo off
chcp 65001 >nul
title CCTV Vision Hub - Update from Git
color 0a
cd /d "%~dp0"

echo =================================================================
echo        CCTV VISION HUB - CAP NHAT TU GIT VA KHOI DONG LAI
echo =================================================================
echo.

echo [*] Dang keo ma nguon moi nhat tu GitHub...
git pull origin main

echo.
echo [*] Dang dung tien trinh cu va khoi dong lai chay ngam...
taskkill /f /im python.exe /fi "WINDOWTITLE eq CCTV*" >nul 2>&1
taskkill /f /im pythonw.exe >nul 2>&1
timeout /t 2 >nul

if exist "cctv_silent_starter.vbs" (
    start "" cctv_silent_starter.vbs
    echo [OK] Da khoi dong lai chay ngam thanh cong!
) else (
    start "" run_windows.bat
    echo [OK] Da khoi dong lai qua run_windows.bat!
)

echo.
echo =================================================================
echo [OK] HOAN TAT! Truy cap: http://127.0.0.1:8080 de kiem tra.
echo =================================================================
timeout /t 5
