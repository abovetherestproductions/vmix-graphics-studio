@echo off
setlocal EnableDelayedExpansion
title vMix Graphics Studio - Force Start

REM ---------------------------------------------------------------------------
REM  Force the graphics studio to start.
REM
REM  Use this when the operator page will not load, or after a Windows update,
REM  or any time something is "just not responding". Safe to run any number of
REM  times - it will not damage settings, events, or uploaded workbooks.
REM
REM  It restarts the Windows service, and if the service is missing or refuses
REM  to start it falls back to running the server directly in this window.
REM ---------------------------------------------------------------------------

set "SERVICE=VmixGraphicsStudio"
set "PORT=3012"
set "ROOT=%~dp0.."
pushd "%ROOT%"

echo.
echo   vMix Graphics Studio - Force Start
echo   ==================================
echo.

REM --- must be elevated to control a service ---------------------------------
net session >nul 2>&1
if errorlevel 1 (
    echo   Asking for administrator permission...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" >nul 2>&1
    popd
    exit /b
)

REM --- 1. stop the service ---------------------------------------------------
sc query "%SERVICE%" >nul 2>&1
if not errorlevel 1 (
    echo   [1/4] Stopping the graphics service...
    net stop "%SERVICE%" >nul 2>&1
    timeout /t 3 /nobreak >nul
) else (
    echo   [1/4] No service installed - will start directly.
)

REM --- 2. clear anything still holding the port ------------------------------
REM  Orphaned node processes are the most common cause of "I updated but
REM  nothing changed" - they keep serving OLD code from the port.
echo   [2/4] Clearing port %PORT%...
set "KILLED=0"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
    if not "%%P"=="0" (
        taskkill /F /PID %%P >nul 2>&1
        if not errorlevel 1 set "KILLED=1"
    )
)
if "!KILLED!"=="1" (echo         Cleared a stale process.) else (echo         Port was already free.)
timeout /t 2 /nobreak >nul

REM --- 3. start the service --------------------------------------------------
echo   [3/4] Starting...
set "STARTED=0"
sc query "%SERVICE%" >nul 2>&1
if not errorlevel 1 (
    net start "%SERVICE%" >nul 2>&1
    timeout /t 4 /nobreak >nul
    sc query "%SERVICE%" | findstr /i "RUNNING" >nul 2>&1
    if not errorlevel 1 set "STARTED=1"
)

REM --- 4. confirm it is answering -------------------------------------------
echo   [4/4] Checking...
set "OK=0"
for /l %%i in (1,1,10) do (
    if "!OK!"=="0" (
        powershell -NoProfile -Command "try{(Invoke-WebRequest 'http://localhost:%PORT%/api/config' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 | Out-Null; exit 0}catch{exit 1}" >nul 2>&1
        if not errorlevel 1 (set "OK=1") else (timeout /t 2 /nobreak >nul)
    )
)

echo.
if "!OK!"=="1" (
    echo   SUCCESS - the graphics studio is running.
    echo   Opening the operator page...
    start "" "http://localhost:%PORT%/operator/"
    timeout /t 3 /nobreak >nul
    popd
    exit /b 0
)

REM --- fallback: run in this window so the operator can SEE the error --------
echo   The service did not come up. Starting directly so you can see why.
echo.
echo   Leave this window OPEN while you use the graphics.
echo   Closing this window will stop the graphics.
echo.
echo   ---------------------------------------------------------------
start "" "http://localhost:%PORT%/operator/"
node server.js

echo.
echo   ---------------------------------------------------------------
echo   The graphics server stopped.
echo   If there is an error above, send that text to your studio contact.
echo.
popd
pause
