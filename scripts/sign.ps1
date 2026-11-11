# sign.ps1 — Authenticode-sign the built binary.
#
# WHY: 360-family AVs verdict unsigned binaries by cloud reputation; a
# valid signature short-circuits the heuristic entirely. Whitelisting only
# covers OUR machine — every end user would hit the same wall. This is the
# durable fix for distribution.
#
# 2026 context: since June 2023 the CA/Browser Forum requires private keys
# in FIPS 140-2 L2+ hardware for BOTH OV and EV — a plain .pfx file no
# longer exists for new certs. Pick ONE backend via -Backend:
#
#   azure    Azure Artifact Signing (formerly Trusted Signing), $9.99/mo,
#            Microsoft-managed HSM, native signtool dlib integration.
#            Requires: az login + an Artifact Signing account+profile.
#   keylocker DigiCert KeyLocker (cloud HSM, OV ~$400/yr, EV ~$1000/yr).
#            Requires DigiCert SmTools/KSP installed and CLIENT_AUTHENTICATE
#            env vars set by their setup tool.
#   token    Legacy USB-token EV cert exposed as a Windows cert store
#            certificate (SafeNet middleware etc.) — select by thumbprint.
#
# Usage examples:
#   powershell -File scripts\sign.ps1 -Backend azure   -AzureResourceGroup rg -AzureAccount ke -AzureProfile cert1
#   powershell -File scripts\sign.ps1 -Backend keylocker -CertName "Kafka Explorer"
#   powershell -File scripts\sign.ps1 -Backend token   -CertThumbprint ABC...
#
# The Taskfile `sign` task calls this with parameters from the environment.

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("azure", "keylocker", "token")]
  [string]$Backend,

  [string]$Exe = "bin\kafka-explorer.exe",

  # azure
  [string]$AzureResourceGroup,
  [string]$AzureAccount,
  [string]$AzureProfile,
  [string]$AzureEndpoint = "https://eus.codesigning.azure.net/",

  # keylocker / token
  [string]$CertName,
  [string]$CertThumbprint,

  # RFC3161 timestamp server (REQUIRED: without it the signature dies at
  # certificate expiry and old installs start warning)
  [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $Exe)) {
  Write-Error "binary not found: $Exe — run `wails3 task build` first"
}

$signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty Source
if (-not $signtool) {
  # Windows SDK location heuristics
  $kits = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending
  foreach ($k in $kits) {
    $p = Join-Path $k.FullName "x64\signtool.exe"
    if (Test-Path $p) { $signtool = $p; break }
  }
}
if (-not $signtool) { Write-Error "signtool.exe not found — install the Windows SDK" }

switch ($Backend) {
  "azure" {
    if (-not ($AzureResourceGroup -and $AzureAccount -and $AzureProfile)) {
      Write-Error "azure backend needs -AzureResourceGroup/-AzureAccount/-AzureProfile"
    }
    $dlib = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\TrustedSigning" -Filter "Azure.CodeSigning.Dlib.dll" -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1 -ExpandProperty FullName
    if (-not $dlib) { Write-Error "Azure.CodeSigning.Dlib.dll not found — install: dotnet tool install Azure.Trusted.Signing.Client" }
    & $signtool sign -fd SHA256 -tr $TimestampUrl -td SHA256 `
      -dlib $dlib `
      -dmdf (Join-Path $PSScriptRoot "sign-metadata.json") `
      $Exe
  }
  "keylocker" {
    if (-not $CertName) { Write-Error "keylocker backend needs -CertName" }
    & $signtool sign -fd SHA256 -tr $TimestampUrl -td SHA256 `
      -csp "DigiCert Signing Manager KSP" -kc $CertName `
      -n $CertName `
      $Exe
  }
  "token" {
    if (-not $CertThumbprint) { Write-Error "token backend needs -CertThumbprint" }
    & $signtool sign -fd SHA256 -tr $TimestampUrl -td SHA256 `
      -sha1 $CertThumbprint `
      $Exe
  }
}

if ($LASTEXITCODE -ne 0) { Write-Error "signtool failed ($LASTEXITCODE)" }
# verify: signature present + timestamped
Get-AuthenticodeSignature $Exe |
  Select-Object Status, StatusMessage, @{ n = "Signer"; e = { $_.SignerCertificate.Subject } } |
  Format-List
Write-Host "signed: $Exe" -ForegroundColor Green
