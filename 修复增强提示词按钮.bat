@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ZCode enhance - maintenance
python "%~dp0tools\menu.py" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  pause
)
exit /b %RC%
