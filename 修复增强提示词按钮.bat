@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ZCode enhance - maintenance
where python >nul 2>nul
if errorlevel 1 (
  echo 找不到 python。请先安装 Python 3.9+ 并勾选 "Add python.exe to PATH"。
  pause
  exit /b 1
)
python "%~dp0tools\menu.py" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  pause
)
exit /b %RC%
