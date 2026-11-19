@echo off
chcp 65001 >nul
title CCTV Vision Hub - Auto Deploy to Server
color 0b
cd /d "%~dp0"

echo =================================================================
echo        CCTV VISION HUB - AUTO DEPLOY TO SERVER (192.168.19.14)
echo =================================================================
echo.

set "SERVER_IP=192.168.19.14"
set "SERVER_USER=administrator"
set "SERVER_DIR=C:\CCTVVisionHub"

:: 1. Kiem tra xem co file nao thay doi khong
git status -s >nul 2>&1
echo [*] Buoc 1: Dang kiem tra va dong goi ma nguon...
git add .
set /p "COMMIT_MSG=Nhap noi dung cap nhat (Enter de lay mac dinh: Update CCTV Hub): "
if "%COMMIT_MSG%"=="" set "COMMIT_MSG=Update CCTV Hub"

git commit -m "%COMMIT_MSG%" >nul 2>&1

:: 2. Day len GitHub
echo [*] Buoc 2: Dang day code len GitHub...
git push origin main
if errorlevel 1 (
    echo [!] Loi: Khong the push code len GitHub. Kiem tra ket noi mang.
    pause
    exit /b 1
)
echo [OK] Code da duoc day len GitHub thanh cong!
echo.

:: 3. Ra lenh cho Server keo code va khoi dong lai
echo [*] Buoc 3: Dang ket noi sang Server %SERVER_IP% de cap nhat va restart app...
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 %SERVER_USER%@%SERVER_IP% "cd /d %SERVER_DIR% 2>nul || cd /d D:\CCTVVisionHub 2>nul; git pull origin main && taskkill /f /im python.exe /fi \"WINDOWTITLE eq CCTV*\" >nul 2>&1 & taskkill /f /im pythonw.exe >nul 2>&1 & timeout /t 2 >nul & start \"\" cctv_silent_starter.vbs"

if errorlevel 1 (
    echo.
    echo [!] Luu y: Code da len GitHub, nhung khong the ra lenh tu dong qua SSH sang Server.
    echo     (Co the do Server chua nhap mat khau SSH hoac thu muc Server khac %SERVER_DIR%)
    echo [i] Ban chi can len Server nhap dup vao file "update_from_git.bat" de keo ve nhe!
) else (
    echo.
    echo =================================================================
    echo [OK] DA HOAN TAT! Server da tu dong cap nhat va chay lai.
    echo      Ban co the vao: http://%SERVER_IP%:8080 de kiem tra.
    echo =================================================================
)

echo.
pause
