@echo off
rem Double-click to install. Needs the whole unzipped package (folders "setup" and "win-unpacked").
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause
