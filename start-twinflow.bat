@echo off
rem Starts the TwinFlow server on this PC. Keep this window open while using the app.
cd /d "%~dp0"
echo TwinFlow starting... open http://localhost:8123
echo On your phone (same Wi-Fi): use this PC's IP, e.g. http://172.20.10.7:8123
"C:\Program Files\nodejs\node.exe" serve.mjs
pause
