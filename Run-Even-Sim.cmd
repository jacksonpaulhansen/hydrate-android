@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%run-even-sim.ps1"

if not exist "%PS1%" (
  echo [even-g2] Missing script: "%PS1%"
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [even-g2] run-even-sim.ps1 exited with code %EXIT_CODE%
  pause
)

exit /b %EXIT_CODE%
