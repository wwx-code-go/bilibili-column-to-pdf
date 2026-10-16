@echo off
rem ============================================================================
rem  Pure ASCII only. A batch file containing non-ASCII bytes, or switching the
rem  console code page inside it, gets mis-parsed by cmd.exe and the following
rem  lines are corrupted. All Chinese UI text is produced by the Node program.
rem
rem  What this does:
rem    1. use the bundled portable Node in .\runtime  (if present)
rem    2. otherwise use the system Node, if it is 18 or newer
rem    3. otherwise download a portable Node into .\runtime  (one time, ~33 MB)
rem    4. start the local web UI
rem
rem  Usage:
rem    this file               start the web interface  (normal use)
rem    this file --cli         start the old command-line wizard
rem    this file --login       command-line one-time login
rem ============================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "NODE_EXE="
set "NODE_VER=v22.14.0"

rem ---- 1. bundled runtime -------------------------------------------------
if exist "runtime\node\node.exe" set "NODE_EXE=%CD%\runtime\node\node.exe"

rem ---- 2. system node (must be 18+) ---------------------------------------
if not defined NODE_EXE (
  for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODE_EXE set "CAND=%%i"
  )
  if defined CAND (
    set "MAJOR="
    for /f "tokens=1 delims=." %%v in ('"!CAND!" -v 2^>nul') do if not defined MAJOR set "MAJOR=%%v"
    set "MAJOR=!MAJOR:v=!"
    if defined MAJOR (
      if !MAJOR! GEQ 18 (
        set "NODE_EXE=!CAND!"
      ) else (
        echo   [i] System Node.js is too old ^(v!MAJOR!^), a newer one is needed.
      )
    )
  )
)

rem ---- 3. download a portable node ---------------------------------------
if not defined NODE_EXE (
  echo.
  echo   [i] Node.js was not found on this computer.
  echo       Downloading a portable copy into .\runtime  ^(~33 MB, only once^)...
  echo.
  call :install_node
  if exist "runtime\node\node.exe" set "NODE_EXE=%CD%\runtime\node\node.exe"
)

if not defined NODE_EXE (
  echo.
  echo   [x] Could not set up Node.js automatically.
  echo       Please install Node.js 18 or newer from https://nodejs.org/
  echo       and run this file again.
  echo.
  pause
  exit /b 1
)

rem ---- 4. run -------------------------------------------------------------
if /i "%~1"=="--cli"   goto cli
if /i "%~1"=="--login" goto cli

:web
"%NODE_EXE%" "app\server.mjs"
set "code=%errorlevel%"
goto report

:cli
"%NODE_EXE%" "bili2pdf.mjs" %*
set "code=%errorlevel%"
goto report

:report
echo.
if not "%code%"=="0" echo   Exit code %code% - see the message above.
pause
exit /b %code%


rem ============================================================================
:install_node
set "NODE_ZIP=%TEMP%\node-%NODE_VER%-win-x64.zip"
set "NODE_DIR=node-%NODE_VER%-win-x64"

powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -Uri 'https://nodejs.org/dist/%NODE_VER%/%NODE_DIR%.zip' -OutFile '%NODE_ZIP%' -UseBasicParsing } catch { exit 1 }"
if errorlevel 1 (
  echo   [x] Download failed. Check your network connection.
  exit /b 1
)
if not exist "%NODE_ZIP%" exit /b 1

echo   [i] Extracting...
if not exist "runtime" mkdir "runtime"
tar -xf "%NODE_ZIP%" -C "runtime"
if errorlevel 1 (
  echo   [x] Extraction failed.
  exit /b 1
)
if exist "runtime\%NODE_DIR%" (
  if exist "runtime\node" rmdir /s /q "runtime\node"
  move "runtime\%NODE_DIR%" "runtime\node" >nul
)
del "%NODE_ZIP%" >nul 2>nul
echo   [i] Node.js is ready.
exit /b 0
