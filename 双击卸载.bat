@echo off
title Antigravity Quota & Token Widget Uninstaller
node "%~dp0install.js" --uninstall %*
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Uninstall failed! Make sure Antigravity is fully closed and Node.js is installed.
    pause
    exit /b 1
)
echo.
pause
