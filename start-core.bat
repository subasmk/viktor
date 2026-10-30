@echo off
rem Viktor Core - Viktor's own brain. Run this, then point Viktor's
rem Endpoint setting at http://127.0.0.1:8731/v1 (see README).
cd /d "%~dp0core"
node --version >nul 2>&1
if errorlevel 1 (
  echo Node.js is required for Viktor Core. Install it from nodejs.org and run this again.
  pause
  exit /b 1
)
echo Starting Viktor Core... settings page: http://127.0.0.1:8731/
node server.mjs
pause
