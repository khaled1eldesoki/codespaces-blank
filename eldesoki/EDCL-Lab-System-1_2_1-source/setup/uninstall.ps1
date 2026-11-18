# Removes the program folder and shortcuts. Data in %APPDATA%\EDCL Lab System is KEPT. STATUS: syntax-checked only; never executed on Windows.
param([string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\EDCL Lab System'))
if (Get-Process -Name 'EDCL Lab System' -ErrorAction SilentlyContinue) { Write-Error 'Close the EDCL Lab System first.'; exit 1 }
foreach ($d in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) { $l = Join-Path $d 'EDCL Lab System.lnk'; if (Test-Path $l) { Remove-Item $l } }
if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir; Write-Output "Removed $InstallDir" }
Write-Output 'Your data folder %APPDATA%\EDCL Lab System and your backups were NOT deleted.'
