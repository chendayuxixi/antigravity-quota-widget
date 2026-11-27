@echo off
title Antigravity Quota & Token Widget Installer
node "%~dp0install.js" %*
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Installation failed! Make sure Antigravity is fully closed and Node.js is installed.
    pause
    exit /b 1
)
echo.
pause
