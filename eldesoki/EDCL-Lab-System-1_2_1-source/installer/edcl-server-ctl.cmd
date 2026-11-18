@echo off
rem EDCL server control. Run from an elevated (Administrator) Command Prompt.
rem   edcl-server-ctl start | stop | restart | status | backup | verify FILE | restore FILE | reset-password USER | renew-certs [IP] | logs
setlocal
set "HERE=%~dp0"
set "ROOT=%ProgramData%\EDCL Server"
if /i "%1"=="start"   goto s_start
if /i "%1"=="stop"    goto s_stop
if /i "%1"=="restart" goto s_restart
if /i "%1"=="status"  goto s_status
if /i "%1"=="backup"  goto s_backup
if /i "%1"=="verify"  goto s_verify
if /i "%1"=="restore" goto s_restore
if /i "%1"=="reset-password" goto s_reset
if /i "%1"=="renew-certs" goto s_renew
if /i "%1"=="logs"    goto s_logs
echo usage: edcl-server-ctl start ^| stop ^| restart ^| status ^| backup ^| verify FILE ^| restore FILE ^| reset-password USER ^| renew-certs [IP] ^| logs
exit /b 1
:s_start
schtasks /Run /TN "EDCL Server"
exit /b
:s_stop
echo 1> "%ROOT%\stop.flag"
schtasks /End /TN "EDCL Server" >nul 2>nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*EDCL Server*cli.js*start*' -or $_.CommandLine -like '*server\\cli.js* start*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Stopped.
exit /b
:s_restart
call "%~f0" stop
timeout /t 3 /nobreak >nul
call "%~f0" start
exit /b
:s_status
schtasks /Query /TN "EDCL Server" /FO LIST | findstr /i "Status"
"%HERE%node.exe" --no-warnings "%HERE%server\cli.js" status --config "%ROOT%\server.json"
exit /b
:s_backup
"%HERE%node.exe" --no-warnings "%HERE%server\cli.js" backup --config "%ROOT%\server.json"
exit /b
:s_verify
"%HERE%node.exe" --no-warnings "%HERE%server\cli.js" verify-backup %2
exit /b
:s_restore
echo The server MUST be stopped first (edcl-server-ctl stop). The current database is kept in a pre-restore folder.
"%HERE%node.exe" --no-warnings "%HERE%server\cli.js" restore %2 --config "%ROOT%\server.json"
exit /b
:s_reset
"%HERE%node.exe" --no-warnings "%HERE%server\cli.js" reset-password %2 --config "%ROOT%\server.json"
exit /b
:s_renew
"%HERE%node.exe" --no-warnings "%HERE%server\setup-helper.js" --root "%ROOT%" --name %COMPUTERNAME% --ip %2 --owner admin
echo Restart the server now. Workstations need NO change (they trust the CA, not the server certificate).
exit /b
:s_logs
explorer "%ROOT%\logs"
exit /b
