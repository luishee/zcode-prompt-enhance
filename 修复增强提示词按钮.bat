@echo off
rem ---------------------------------------------------------------
rem ZCode enhance - maintenance entry (thin forwarder)
rem Keep this file ASCII outside the echo lines below, saved as
rem UTF-8 without BOM and CRLF: a BOM breaks line 1, a GBK/ANSI
rem re-save mangles the echoes, and LF breaks goto/label parsing.
rem The real UI text lives in tools/menu.py (see its header).
rem ---------------------------------------------------------------
chcp 65001 >nul 2>&1
title ZCode enhance - maintenance
setlocal
set "RC=1"
pushd "%~dp0" >nul 2>&1

rem Pick an interpreter by actually running it. `where python` alone is not
rem proof: the Microsoft Store app-execution-alias stub makes `where` succeed
rem while running nothing, and a same-named python.bat/python.exe in this
rem folder would shadow the real interpreter. Absolute paths first.
rem (where.exe writes its "not found" notice to stderr -> silence it, and skip
rem  anything that is not an existing file, so a localized notice can never be
rem  mistaken for a candidate path.)
set "PY="
if exist "%SystemRoot%\py.exe" (
  "%SystemRoot%\py.exe" -3 -c "import sys" >nul 2>nul && set "PY="%SystemRoot%\py.exe" -3"
)
if not defined PY (
  for /f "delims=" %%P in ('"%SystemRoot%\System32\where.exe" python.exe 2^>nul') do (
    if not defined PY (
      if exist "%%~P" (
        "%%~P" -c "import sys" >nul 2>nul && set "PY="%%~P""
      )
    )
  )
)

if not exist "%~dp0tools\menu.py" (
  echo 脚本不完整：缺少 %~dp0tools\menu.py
  echo 请把本文件和 tools 目录放在同一个文件夹里，不要只拷贝 .bat。
  goto :fail
)
if not defined PY (
  echo 找不到可用的 Python 3。请安装 Python 3.9+ 并勾选 "Add python.exe to PATH"；
  echo 若已从 Microsoft Store 安装，请在“应用执行别名”里启用 python.exe。
  echo 也可以手动运行：py -3 tools\menu.py
  goto :fail
)

%PY% "%~dp0tools\menu.py" %*
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto :exit

:fail
echo.
rem Automation (scripts / Task Scheduler): set ZCE_NO_PAUSE=1 to skip the pause.
if not defined ZCE_NO_PAUSE pause

:exit
popd >nul 2>&1
exit /b %RC%
