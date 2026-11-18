# EDCL Lab System 1.0.15 - setup guide (Windows 10/11, 64-bit)
**Status:** the scripts below were syntax-checked but have NOT been run on Windows. The program itself is the lab's Electron 35.7.5 runtime; this build was tested on Linux only. Try it on a test PC first.
## Option A - run without installing
Unzip the whole package, open `win-unpacked\EDCL Lab System.exe`.
## Option B - install for the current user (recommended)
1. Unzip the whole package to a normal folder (not inside a zip viewer). 2. Double-click `setup\Install-EDCL.cmd` (or run `setup\install.ps1`). 3. Setup first **backs up your existing data** to `Documents\EDCL Backups\userdata-before-setup-<date>.zip` (and stops if that fails), keeps the old program folder as `...\EDCL Lab System.previous`, copies the program to `%LOCALAPPDATA%\Programs\EDCL Lab System`, creates Desktop and Start-menu shortcuts. 4. Start from the shortcut. Windows SmartScreen may warn because the exe is not code-signed ("More info" > "Run anyway" if your IT policy allows).
## Data and backups
Data stays in `%APPDATA%\EDCL Lab System` and is never changed by setup. Backups: `Documents\EDCL Backups` (manual) and `...\Auto` (automatic, newest 15).
## Update / rollback
Install the new package the same way; to go back, close the app, delete the program folder, rename `EDCL Lab System.previous` back, and if needed restore the data zip (see HANDOVER/ROLLBACK).
## Uninstall
`setup\uninstall.ps1` removes the program and shortcuts, keeps data and backups.
## New in 1.0.15 - Fillable Forms (PDF)
Menu "Fillable Forms": import a PDF template (kept unchanged, SHA-256 shown), create a form for an employee (optionally linked to a training record, competency assessment or authorization), type into native PDF fields or place text boxes anywhere (also on scanned PDFs, with optional OCR to help find labels), save revisions (each a separate completed copy), reopen, print or export. Word (DOCX/DOC) forms are NOT supported yet.
