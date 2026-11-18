# EDCL Lab System - setup (portable package -> per-user installation). STATUS: syntax-checked only; NEVER executed on Windows.
# Run:  right-click Install-EDCL.cmd > Run, or:  powershell -ExecutionPolicy Bypass -File setup\install.ps1
param([string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\EDCL Lab System'), [switch]$NoShortcuts, [switch]$SkipDataBackup)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot; $src = Join-Path $root 'win-unpacked'; $exe = Join-Path $src 'EDCL Lab System.exe'
if (-not (Test-Path $exe)) { Write-Error "Cannot find $exe. Keep the 'setup' and 'win-unpacked' folders together (unzip the whole package first)."; exit 1 }
if (Get-Process -Name 'EDCL Lab System' -ErrorAction SilentlyContinue) { Write-Error 'Close the EDCL Lab System first.'; exit 1 }
$log = Join-Path $env:TEMP ('edcl-setup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log'); Start-Transcript -Path $log | Out-Null
try {
  $data = Join-Path $env:APPDATA 'EDCL Lab System'
  if ((Test-Path $data) -and -not $SkipDataBackup) {                       # 1. back up existing data BEFORE touching anything
    $bk = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'EDCL Backups'; New-Item -ItemType Directory -Force -Path $bk | Out-Null
    $zip = Join-Path $bk ('userdata-before-setup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip'); Compress-Archive -Path (Join-Path $data '*') -DestinationPath $zip -CompressionLevel Optimal
    if (-not (Test-Path $zip) -or (Get-Item $zip).Length -lt 1) { throw 'Data backup failed - setup stopped, nothing was changed.' }
    Write-Output "Existing data backed up: $zip  SHA256 $((Get-FileHash $zip -Algorithm SHA256).Hash)"
  } else { Write-Output 'No existing data folder found (or backup skipped).' }
  if (Test-Path $InstallDir) { $old = $InstallDir + '.previous'; if (Test-Path $old) { Remove-Item -Recurse -Force $old }; Move-Item $InstallDir $old; Write-Output "Previous program folder kept as: $old" }   # 2. keep the last known good program folder
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  & robocopy $src $InstallDir /E /NFL /NDL /NJH /NJS /NP | Out-Null; if ($LASTEXITCODE -ge 8) { throw "File copy failed (robocopy code $LASTEXITCODE)" }
  if (-not (Test-Path (Join-Path $InstallDir 'EDCL Lab System.exe'))) { throw 'Installed files are incomplete.' }
  if (-not $NoShortcuts) { $sh = New-Object -ComObject WScript.Shell; foreach ($d in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) { $l = $sh.CreateShortcut((Join-Path $d 'EDCL Lab System.lnk')); $l.TargetPath = (Join-Path $InstallDir 'EDCL Lab System.exe'); $l.WorkingDirectory = $InstallDir; $l.Save() } }
  Write-Output "Installed to: $InstallDir"; Write-Output 'Start it from the Desktop shortcut. Your data stays in %APPDATA%\EDCL Lab System (never modified by setup). The exe is not code-signed: Windows SmartScreen may ask for confirmation.'
} finally { Stop-Transcript | Out-Null; Write-Output "Log: $log" }
