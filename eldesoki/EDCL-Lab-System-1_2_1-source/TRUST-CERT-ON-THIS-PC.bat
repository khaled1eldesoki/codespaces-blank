@echo off
setlocal
cd /d "%~dp0"
rem Run this on every OTHER PC (and on the server PC too). Needs cert.pem next to this file or in the certs folder.
set "CERT=%~dp0cert.pem"
if not exist "%CERT%" set "CERT=%~dp0certs\cert.pem"
if not exist "%CERT%" (echo cert.pem not found. Copy cert.pem ^(NOT key.pem^) next to this file. & pause & exit /b 1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\make-cert.ps1" -ImportOnly -Trust -CertFile "%CERT%"
if errorlevel 1 (echo FAILED. Copy the red text above and send it.) else (echo Done. Windows may have asked you to confirm.)
pause
