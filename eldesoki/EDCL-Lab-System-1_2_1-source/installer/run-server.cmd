@echo off
rem EDCL central server runner (started at boot by the "EDCL Server" scheduled task). Restarts the server if it ever stops, unless stop.flag exists.
setlocal
set "HERE=%~dp0"
set "ROOT=%ProgramData%\EDCL Server"
if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"
del "%ROOT%\stop.flag" >nul 2>nul
:loop
if exist "%ROOT%\stop.flag" exit /b 0
for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "TODAY=%%d"
"%HERE%node.exe" --no-warnings "%HERE%server\cli.js" start --config "%ROOT%\server.json" >> "%ROOT%\logs\server-%TODAY%.log" 2>&1
if exist "%ROOT%\stop.flag" exit /b 0
timeout /t 10 /nobreak >nul
goto loop
