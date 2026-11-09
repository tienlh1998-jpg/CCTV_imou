@echo off
chcp 65001 >nul
title Dong Goi CCTV Hub Thanh File .EXE
color 0a
setlocal EnableExtensions

cd /d "%~dp0"

echo =================================================================
echo   DONG GOI CCTV VISION HUB THANH FILE .EXE CHO WINDOWS
echo =================================================================
echo.

set "PYTHON_EXE=%~dp0python_env\tools\python.exe"
if not exist "%PYTHON_EXE%" set "PYTHON_EXE=python"

"%PYTHON_EXE%" --version >nul 2>&1
if errorlevel 1 (
    echo [!] LOI: Khong tim thay Python 3.
    echo     Da kiem tra python_env\tools\python.exe va lenh "python" trong PATH.
    echo     Cai Python 3.11 va tich chon "Add python.exe to PATH".
    pause
    exit /b 1
)

echo [i] Script se hoi truoc khi cai PyInstaller (neu thieu).
echo [i] Khong nhung settings.json, managed_cameras.json, log, ZIP hay APK vao EXE.
echo.

"%PYTHON_EXE%" build_windows.py
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo.
    echo [!] Dong goi that bai voi ma %EXIT_CODE%.
)
echo.
pause
exit /b %EXIT_CODE%
