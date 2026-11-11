# av-whitelist.ps1 — stop antivirus false positives for the dev build.
#
# Why: kafka-explorer.exe is an unsigned, freshly compiled GUI binary.
# 360 Safe Guard (this dev box's active AV — Defender is NOT running here)
# cloud-verdicts unknown hashes on sight and has quarantined bin/kafka-
# explorer.exe outright ("Permission denied" on launch, file gone). Two
# mitigation layers:
#   1. This script: add Defender exclusions (when Defender is the active
#      AV on another machine) and print the exact 360 whitelist clicks —
#      360 personal has no public CLI for trust-zone changes.
#   2. The build itself stamps VERSIONINFO + manifest (see Taskfile build
#      task) so heuristic scoring starts from "described app", not "nameless
#      exe". For distribution, sign the binary or file whitelisting requests
#      with the vendors (360 open.soft.360.cn, Microsoft /report false positive).
#
# Run from the repo root:  powershell -ExecutionPolicy Bypass -File scripts\av-whitelist.ps1
# Elevation: the script self-elevates (UAC) because Defender exclusions
# require admin. It only ever ADDS exclusions for this project's paths.

$repo = Split-Path -Parent $PSScriptRoot
$goCache = (go env GOCACHE) 2>$null
$goPath = (go env GOPATH) 2>$null

$targets = @(
  (Join-Path $repo "bin"),        # the built exe (killed on sight before)
  $repo,                          # project dir (sources, go test temp files)
  $goCache,                       # go build cache: fresh test/binary artifacts
  (Join-Path $goPath "pkg\mod")   # module downloads (checksummed but scanned)
) | Where-Object { $_ }

# --- self-elevate once ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Not elevated — relaunching with UAC prompt..." -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $PSCommandPath
  )
  exit
}

# --- Defender (only meaningful when Defender is actually the active AV) ---
try {
  $status = Get-MpComputerStatus -ErrorAction Stop
  if ($status.AMRunningMode -and $status.AMRunningMode -ne "Not running") {
    foreach ($p in $targets) {
      Add-MpPreference -ExclusionPath $p -ErrorAction SilentlyContinue
      Write-Host "Defender exclusion added: $p" -ForegroundColor Green
    }
  } else {
    Write-Host "Defender is NOT the active AV (mode: $($status.AMRunningMode)) — no Defender changes made." -ForegroundColor Cyan
  }
} catch {
  Write-Host "Defender cmdlets unavailable ($($_.Exception.Message)) — skipping." -ForegroundColor Cyan
}

# --- 360 Safe Guard: manual whitelist (no public CLI for personal edition) ---
Write-Host @"

=== 360 安全卫士信任区（需手工，一次性） ===
误杀根因：无签名新 exe 的云查杀 verdict。把以下目录加入信任区后不再复查：
  1. 打开 360 安全卫士 → 「木马查杀」页 → 右下角「信任区」
     （或 设置 → 安全防护中心 → 信任与阻止 → 信任区）
  2. 「添加目录」，逐个加入：
$($targets | ForEach-Object { "       $_" } | Out-String)
  3. 若 exe 已被隔离：360 → 「木马查杀」→「恢复区」→ 找到 kafka-explorer.exe → 恢复并加入信任
  4. 常编译二进制可再开：设置 → 主动防御 → 开发者模式（减少对编译产物的拦截）
（菜单名随 360 版本略有差异，认关键词：信任区 / 恢复区 / 白名单）

=== 分发侧根治（正式对外发布时） ===
  - 代码签名证书（OV/EV）：签名后 AV 信誉直接建立，一劳永逸
  - 误报申诉：360 开放平台 open.soft.360.cn（文件申诉）；Microsoft 警报提交页
"@ -ForegroundColor White
