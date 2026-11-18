# Backs up the application's data folder BEFORE installing a new build or running migrations.
# STATUS: written and syntax-checked only - NEVER executed on Windows. Close the EDCL Lab System first.
$src = Join-Path $env:APPDATA 'EDCL Lab System'
if (-not (Test-Path $src)) { Write-Error "Data folder not found: $src"; exit 1 }
if (Get-Process -Name 'EDCL Lab System' -ErrorAction SilentlyContinue) { Write-Error 'Close the application first.'; exit 1 }
$dstDir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'EDCL Backups'
New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
$dst = Join-Path $dstDir ('userdata-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
Compress-Archive -Path (Join-Path $src '*') -DestinationPath $dst -CompressionLevel Optimal
$h = (Get-FileHash $dst -Algorithm SHA256).Hash
Write-Output "Backup written: $dst"; Write-Output "SHA256: $h"
Write-Output 'To restore: close the app, rename the current data folder, expand this zip into a new folder named EDCL Lab System under %APPDATA%.'
