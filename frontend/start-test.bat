@echo off
REM Double-click this file (Windows) to start the staff test.
setlocal enabledelayedexpansion
cd /d "%~dp0"
echo ================================================
echo    Attendance App  -  Staff Test Launcher
echo ================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed yet.
  echo   1^) Go to  https://nodejs.org
  echo   2^) Download the big green 'LTS' button and install it.
  echo   3^) Then double-click this file again.
  echo.
  pause
  exit /b
)

if not exist .env (
  echo   Paste your DEPLOYED backend address ^(from the Emergent Deploy button^).
  echo   Example:  https://your-app.emergent.host
  echo.
  set /p "URL=  Backend address: "
  > .env echo EXPO_PUBLIC_BACKEND_URL=!URL!
  echo   Saved.
  echo.
)

if not exist node_modules (
  echo   Setting up for the first time ^(about 2-3 minutes^)... please wait.
  call npm install
  echo.
)

echo   Starting! A QR code will appear below in a moment.
echo   ^>^> On each phone: open 'Expo Go' and scan this QR code. ^<^<
echo   Keep this window OPEN during your test. Close it to stop.
echo.
call npx expo start --tunnel --go
