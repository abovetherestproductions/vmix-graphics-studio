@echo off
setlocal
title vMix Graphics Studio - Installer

REM ---------------------------------------------------------------------------
REM  Double-click this file to install the vMix Graphics Studio.
REM
REM  It asks Windows for administrator permission (needed to register the
REM  background service), then runs the installer alongside it.
REM
REM  Safe to run more than once - if something fails partway through, just
REM  double-click it again.
REM ---------------------------------------------------------------------------

echo.
echo   vMix Graphics Studio - Installer
echo   ================================
echo.

REM --- the PowerShell installer must be sitting next to this file ------------
if not exist "%~dp0Install-VmixGraphics.ps1" (
    echo   PROBLEM: Install-VmixGraphics.ps1 is missing.
    echo.
    echo   This file needs to stay together with the other files it came with.
    echo   Copy the whole folder onto this computer, then double-click
    echo   INSTALL.cmd again from inside that folder.
    echo.
    pause
    exit /b 1
)

REM --- re-launch with administrator rights if we don't have them -------------
net session >nul 2>&1
if errorlevel 1 (
    echo   Asking Windows for permission to install...
    echo   Please click YES on the prompt that appears.
    echo.
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" >nul 2>&1
    if errorlevel 1 (
        echo   Permission was refused, so the installer cannot continue.
        echo.
        echo   Try again and click YES, or ask whoever manages this computer
        echo   to run it for you.
        echo.
        pause
    )
    exit /b
)

REM --- run the real installer ------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-VmixGraphics.ps1"
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
    echo.
    echo   The installer stopped before it finished.
    echo   Send the messages above to your studio contact.
    echo.
    pause
)

exit /b %RC%
