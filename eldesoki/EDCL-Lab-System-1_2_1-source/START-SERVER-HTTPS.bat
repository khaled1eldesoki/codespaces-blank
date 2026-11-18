@echo off
setlocal
cd /d "%~dp0"
rem ===== EDIT THESE 3 LINES IF NEEDED =====
set "SERVER_NAME=desktop-23q31ut"
set "SERVER_IP=192.168.1.14"
set "DATA=E:\EDCL-Server-Data"
set "PORT=8443"
rem ========================================
title EDCL central server (HTTPS)
where node >nul 2>nul || (echo Node.js was not found. Install Node.js 22 or newer from nodejs.org, then run this again. & pause & exit /b 1)
if not exist "tools\make-cert.ps1" (echo tools\make-cert.ps1 not found. Run this file from the project folder. & pause & exit /b 1)
if not exist "server\cli.js" (echo server\cli.js not found. Run this file from the project folder. & pause & exit /b 1)

if not exist "certs\key.pem" goto makecert
if not exist "certs\cert.pem" goto makecert
goto havecert
:makecert
echo Creating HTTPS certificate for %SERVER_NAME% / %SERVER_IP% ...
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\make-cert.ps1" -DnsName %SERVER_NAME% -IpAddress %SERVER_IP% -Force
if errorlevel 1 (echo Certificate creation FAILED. Copy the red text above and send it. & pause & exit /b 1)
:havecert

if exist "%DATA%\edcl-central.sqlite" goto haveowner
echo.
echo First run: no database in %DATA%. Creating the owner (administrator) account.
set /p OWNER=Choose an owner username (letters/numbers, e.g. admin): 
if "%OWNER%"=="" (echo No username given. & pause & exit /b 1)
node server\cli.js init-owner %OWNER% --data "%DATA%"
if errorlevel 1 (echo Owner creation FAILED. & pause & exit /b 1)
echo.
echo WRITE DOWN the one-time password above. It is shown only once.
pause
:haveowner

netsh advfirewall firewall show rule name="EDCL server %PORT%" >nul 2>nul || netsh advfirewall firewall add rule name="EDCL server %PORT%" dir=in action=allow protocol=TCP localport=%PORT% >nul 2>nul

echo.
echo Clients connect to:  https://%SERVER_IP%:%PORT%   or   https://%SERVER_NAME%:%PORT%
echo PHONES (view only):  open  https://%SERVER_IP%:%PORT%/m/  - phone must be on the same Wi-Fi and must trust cert.pem first.
echo Keep this window open while the server is running. Close it to stop.
echo.
node server\cli.js start --data "%DATA%" --port %PORT% --wada-hours 6 --tls-key "%CD%\certs\key.pem" --tls-cert "%CD%\certs\cert.pem"
echo.
echo Server stopped.
pause
