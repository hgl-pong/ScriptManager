@echo off
rem ScriptManager launcher. Keep this file ASCII-only: it starts the Node server
rem (server\app.js) in a hidden window. The server opens an Edge app window itself.
setlocal
if not exist "%~dp0logs" mkdir "%~dp0logs"
start "" /b node "%~dp0server\app.js" 1>"%~dp0logs\server.log" 2>&1
endlocal
