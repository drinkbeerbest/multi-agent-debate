@echo off
rem One-click launcher. ASCII only on purpose: cmd.exe parses UTF-8 batch
rem files as ANSI and garbles non-ASCII text.
cd /d "%~dp0"

if not exist "%~dp0scripts\launch.ps1" goto :fallback

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1" %*
if errorlevel 1 (
    echo.
    echo [WARN] launch script exited with code %errorlevel% - check the output above.
    pause
)
goto :end

:fallback
rem If the launch script is missing, fall back to node so the service still starts.
echo [WARN] scripts\launch.ps1 not found - starting node directly.
if "%~1"=="" (
    node server.js
) else (
    set "PORT=%~1"
    node server.js
)

:end
