@echo off
rem Stop the platform (double-click entry). ASCII only on purpose:
rem cmd.exe parses UTF-8 batch files as ANSI and garbles non-ASCII text.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1" %*
