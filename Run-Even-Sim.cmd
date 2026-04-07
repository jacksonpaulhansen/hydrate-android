@echo off
setlocal
title Hydrate Launcher

set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%run-even-sim.ps1"

echo [even-g2] STEP: Hydrate launcher bootstrap
echo [even-g2]      Script dir: %SCRIPT_DIR%

if not exist "%PS1%" (
  echo [even-g2] ERROR: Missing script: "%PS1%"
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [even-g2] ERROR: run-even-sim.ps1 exited with code %EXIT_CODE%
  pause
)

exit /b %EXIT_CODE%
