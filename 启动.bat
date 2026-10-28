@echo off
rem Chinese-named shortcut for double-click. Real logic lives in run.bat
rem (ASCII filename, because cmd.exe parses UTF-8 batch files unreliably).
call "%~dp0run.bat" %*
