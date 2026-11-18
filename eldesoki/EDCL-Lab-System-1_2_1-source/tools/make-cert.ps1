# EDCL Lab System - create a self-signed HTTPS certificate for the central LAN server.
# STATUS: written only - NEVER executed on Windows. Test it on the server PC before relying on it.
# Needs Windows PowerShell 5.1 (.NET Framework 4.7.2+, i.e. Windows 10/11 / Server 2019+) or PowerShell 7. No OpenSSL needed.
#
# Output (in -OutDir, default <project>\certs):  key.pem  (PRIVATE KEY - keep secret)   cert.pem  (public certificate)
# Use:   node server\cli.js start --data D:\EDCL-Server-Data --port 8443 --tls-key certs\key.pem --tls-cert certs\cert.pem
#
# Examples:
#   powershell -ExecutionPolicy Bypass -File tools\make-cert.ps1
#   powershell -ExecutionPolicy Bypass -File tools\make-cert.ps1 -DnsName edcl-server,edcl-server.lab.local -IpAddress 192.168.1.20
#   powershell -ExecutionPolicy Bypass -File tools\make-cert.ps1 -Trust        # also trust it on THIS PC (current user)
#
# Clients must trust cert.pem, otherwise they will show certificate errors. Copy cert.pem (NEVER key.pem) to each client PC and import it
# into "Trusted Root Certification Authorities" (or run this script's -Trust on that PC with -ImportOnly -CertFile <path>).
param(
  [string[]]$DnsName,                       # extra server names clients will use (the computer name, FQDN and localhost are always included)
  [string[]]$IpAddress,                     # extra IP addresses clients will use (this PC's own IPv4 addresses and 127.0.0.1 are always included)
  [string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'certs'),
  [int]$Days = 730,                         # validity; renew (re-run with -Force) before it expires, then redistribute cert.pem
  [switch]$Force,                           # overwrite existing files (the old ones are first copied to *.old-<timestamp>)
  [switch]$Trust,                           # import the certificate into the CURRENT USER's Trusted Root store on this PC
  [switch]$ImportOnly,                      # with -Trust: do not create anything, just import an existing certificate file (client PCs)
  [string]$CertFile,                        # with -ImportOnly: path of the cert.pem to import
  [string]$GrantRead                        # account that will RUN the server if it is not you, e.g. "NT AUTHORITY\SYSTEM" or "DOMAIN\svc-edcl"
)
$ErrorActionPreference = 'Stop'

function Import-TrustedCert([string]$pemPath) {
  $c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList (Resolve-Path $pemPath).Path
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store -ArgumentList 'Root', 'CurrentUser'
  $store.Open('ReadWrite'); try { $store.Add($c) } finally { $store.Close() }
  Write-Output "Trusted for the current user: $($c.Subject)  thumbprint $($c.Thumbprint)  (Windows may have asked you to confirm)."
  Write-Output 'Note: Chrome/Edge/.NET use this store. Electron apps use it too. Firefox keeps its own store.'
}

if ($ImportOnly) {
  if (-not $Trust) { Write-Error '-ImportOnly needs -Trust.'; exit 1 }
  if (-not $CertFile -or -not (Test-Path $CertFile)) { Write-Error 'Give -CertFile <path to cert.pem>.'; exit 1 }
  Import-TrustedCert $CertFile; exit 0
}

if ($Days -lt 1 -or $Days -gt 3650) { Write-Error '-Days must be between 1 and 3650.'; exit 1 }

# ---- names that go into the certificate (Subject Alternative Names) ----
$dns = New-Object System.Collections.Generic.List[string]; $ips = New-Object System.Collections.Generic.List[string]
$dns.Add('localhost'); $dns.Add($env:COMPUTERNAME.ToLower())
try { $fq = [System.Net.Dns]::GetHostEntry('').HostName.ToLower(); if ($fq -and -not $dns.Contains($fq)) { $dns.Add($fq) } } catch { }
foreach ($n in @($DnsName)) { if ($n -and -not $dns.Contains($n.Trim().ToLower())) { $dns.Add($n.Trim().ToLower()) } }
$ips.Add('127.0.0.1')
try {
  foreach ($a in [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName())) {
    if ($a.AddressFamily -eq 'InterNetwork' -and -not $a.ToString().StartsWith('169.254.') -and -not $ips.Contains($a.ToString())) { $ips.Add($a.ToString()) }
  }
} catch { }
foreach ($i in @($IpAddress)) {
  $p = $null; if (-not $i -or -not [System.Net.IPAddress]::TryParse($i.Trim(), [ref]$p)) { Write-Error "Not a valid IP address: '$i'"; exit 1 }
  if (-not $ips.Contains($p.ToString())) { $ips.Add($p.ToString()) }
}

# ---- do not overwrite silently ----
$keyPath = Join-Path $OutDir 'key.pem'; $certPath = Join-Path $OutDir 'cert.pem'
if ((Test-Path $keyPath) -or (Test-Path $certPath)) {
  if (-not $Force) { Write-Error "key.pem / cert.pem already exist in $OutDir. Nothing was changed. Re-run with -Force to replace them (the old files are kept as *.old-<time>)."; exit 1 }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  foreach ($f in @($keyPath, $certPath)) { if (Test-Path $f) { Move-Item $f ($f + '.old-' + $stamp) } }
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# ---- DER helpers (PKCS#1 RSA private key, so no OpenSSL / newer .NET is required) ----
function Der-Len([int]$n) {
  if ($n -lt 128) { return ,([byte[]]@([byte]$n)) }
  $b = New-Object System.Collections.Generic.List[byte]; while ($n -gt 0) { $b.Insert(0, [byte]($n -band 0xFF)); $n = $n -shr 8 }
  return ,([byte[]](@([byte](0x80 -bor $b.Count)) + $b.ToArray()))
}
function Der-Int([byte[]]$v) {
  $i = 0; while ($i -lt $v.Length - 1 -and $v[$i] -eq 0) { $i++ }
  $t = New-Object byte[] ($v.Length - $i); [Array]::Copy($v, $i, $t, 0, $t.Length)
  if ($t[0] -band 0x80) { $t = [byte[]](@([byte]0) + $t) }
  return ,([byte[]](@([byte]0x02) + (Der-Len $t.Length) + $t))
}
function Der-Seq([byte[]]$body) { return ,([byte[]](@([byte]0x30) + (Der-Len $body.Length) + $body)) }
function To-Pem([byte[]]$der, [string]$label) {
  $b64 = [Convert]::ToBase64String($der); $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append("-----BEGIN $label-----`n")
  for ($i = 0; $i -lt $b64.Length; $i += 64) { [void]$sb.Append($b64.Substring($i, [Math]::Min(64, $b64.Length - $i)) + "`n") }
  [void]$sb.Append("-----END $label-----`n"); return $sb.ToString()
}

# ---- create key + self-signed certificate (in memory; nothing is put in the Windows certificate store) ----
$rsa = [System.Security.Cryptography.RSA]::Create(2048)
try {
  $cn = $dns[1]
  $req = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest -ArgumentList "CN=$cn, O=EDCL Lab System", $rsa, ([System.Security.Cryptography.HashAlgorithmName]::SHA256), ([System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $san = New-Object System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder
  foreach ($d in $dns) { $san.AddDnsName($d) }
  foreach ($i in $ips) { $san.AddIpAddress([System.Net.IPAddress]::Parse($i)) }
  $req.CertificateExtensions.Add($san.Build())
  $req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension -ArgumentList $false, $false, 0, $true))
  $req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509KeyUsageExtension -ArgumentList ([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]'DigitalSignature,KeyEncipherment'), $true))
  $eku = New-Object System.Security.Cryptography.OidCollection; [void]$eku.Add((New-Object System.Security.Cryptography.Oid -ArgumentList '1.3.6.1.5.5.7.3.1', 'Server Authentication'))
  $req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension -ArgumentList $eku, $false))
  $req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension -ArgumentList $req.PublicKey, $false))
  $cert = $req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddDays($Days))

  # private key -> PKCS#1 "RSA PRIVATE KEY" PEM
  $p = $rsa.ExportParameters($true)
  $keyDer = Der-Seq ([byte[]](@() + (Der-Int ([byte[]]@(0))) + (Der-Int $p.Modulus) + (Der-Int $p.Exponent) + (Der-Int $p.D) + (Der-Int $p.P) + (Der-Int $p.Q) + (Der-Int $p.DP) + (Der-Int $p.DQ) + (Der-Int $p.InverseQ)))
  $enc = New-Object System.Text.ASCIIEncoding   # ASCII, no BOM, LF line ends
  [System.IO.File]::WriteAllText($keyPath, (To-Pem $keyDer 'RSA PRIVATE KEY'), $enc)
  [System.IO.File]::WriteAllText($certPath, (To-Pem $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert) 'CERTIFICATE'), $enc)
} finally { $rsa.Dispose() }

# ---- lock the private key down to the current user (+ optional service account) ----
try {
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls $keyPath /inheritance:r /grant:r "${me}:(R,W)" | Out-Null
  if ($GrantRead) { & icacls $keyPath /grant "${GrantRead}:(R)" | Out-Null }
  if ($LASTEXITCODE -ne 0) { throw "icacls exit code $LASTEXITCODE" }
} catch { Write-Warning "Could not restrict permissions on key.pem ($_). Restrict it manually: only the account that runs the server may read it." }

# ---- sanity check: files were written ----
if (-not (Test-Path $keyPath) -or -not (Test-Path $certPath) -or (Get-Item $keyPath).Length -lt 500) { Write-Error 'Certificate files were not written correctly.'; exit 1 }

Write-Output "Certificate created:  $certPath"
Write-Output "Private key created:  $keyPath   (SECRET - never copy it to client PCs, never put it in the project ZIP / git)"
Write-Output "Valid until:          $($cert.NotAfter.ToString('yyyy-MM-dd'))   Thumbprint (SHA-1): $($cert.Thumbprint)"
Write-Output "SHA-256 of cert.pem:  $((Get-FileHash $certPath -Algorithm SHA256).Hash)"
Write-Output "Names in certificate: DNS = $($dns -join ', ')   IP = $($ips -join ', ')"
Write-Output 'Clients MUST connect using one of these names/IPs, otherwise the certificate is rejected.'
Write-Output ''
Write-Output 'Start the server:'
Write-Output "  node server\cli.js start --data D:\EDCL-Server-Data --port 8443 --tls-key `"$keyPath`" --tls-cert `"$certPath`""
Write-Output 'Client PCs: copy cert.pem only, then run:  powershell -ExecutionPolicy Bypass -File tools\make-cert.ps1 -ImportOnly -Trust -CertFile <path>\cert.pem'
if ($Trust) { Import-TrustedCert $certPath }
