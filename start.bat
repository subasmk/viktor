@echo off
cd /d %~dp0
rem C: may be nearly full: when a D: drive exists, keep VIKTOR config, voice state
rem and Electron's caches on D: instead of %APPDATA%.
if exist D:\ (
  set VIKTOR_DATA_DIR=D:\viktor-data
  npm start -- "--user-data-dir=D:\viktor-data\electron"
) else (
  npm start
)
