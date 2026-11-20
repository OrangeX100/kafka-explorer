# installer_guard_probe.ps1 — WM_CLOSE 守卫真 Inno E2E 探针（2026-11-20 整合版）。
# 完整链路：启动探针版 setup 前端（DebugFeatures=cdp + KE_DEBUG_CDP=1）→
# CDP 真点「安装/升级」→【立即】250ms 连发 WM_CLOSE（busy 窗口只有秒级——
# 分步编排的延迟会错过它，实测教训）→ 原生警告框计数（拒绝）→ 安装存活 →
# 完成后空闲态 WM_CLOSE → 正常关闭（转发）。
# 前置：bin/installer/KafkaExplorer_Setup_cdp.exe 已构建（installer 任务 +
# cdp 戳 go build）；frontend 依赖已装；本机无 9223 占用实例。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/installer_guard_probe.ps1
param(
  [string]$ProcName = "KafkaExplorer_Setup_cdp",
  [string]$Exe = "D:\视途智能\kafka-explorer\bin\installer\KafkaExplorer_Setup_cdp.exe"
)

$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int PostMessageW(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
}
"@

$script:targetPid = 0
function Get-Title([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 256
  [void][W]::GetWindowTextW($h, $sb, 256)
  $sb.ToString()
}
function Get-Class([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 256
  [void][W]::GetClassNameW($h, $sb, 256)
  $sb.ToString()
}
function Find-Main {
  $p = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) { $script:targetPid = $p.Id; return $p.MainWindowHandle }
  return [IntPtr]::Zero
}
function Find-Box {
  $script:boxHit = [IntPtr]::Zero
  $cb = [W+EnumWindowsProc]{ param($h, $l)
    [uint32]$wpid = 0
    [void][W]::GetWindowThreadProcessId($h, [ref]$wpid)
    if ($wpid -eq $script:targetPid -and (Get-Class $h) -eq "#32770" -and (Get-Title $h) -eq "Kafka Explorer") {
      $script:boxHit = $h
      return $false
    }
    return $true
  }
  [void][W]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:boxHit
}
function Log($m) { Write-Host ("[probe {0,5}s] {1}" -f [int]$sw.Elapsed.TotalSeconds, $m) }

$sw = [Diagnostics.Stopwatch]::StartNew()

# ① 启动（子进程继承 KE_DEBUG_CDP=1 → 9223）
$env:KE_DEBUG_CDP = "1"
Start-Process -FilePath $Exe

$main = [IntPtr]::Zero
while ($sw.Elapsed.TotalSeconds -lt 30 -and $main -eq [IntPtr]::Zero) {
  $main = Find-Main
  if ($main -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 200 }
}
if ($main -eq [IntPtr]::Zero) { throw "FAIL: 30s 未找到 $ProcName 主窗口" }
Log "window found (pid $script:targetPid)"

# ② CDP 真点 安装/升级（busy 从点击算起，只有秒级——后面连发要立刻跟）
$repo = Split-Path -Parent $PSScriptRoot
$clickScript = Join-Path $repo "frontend\e2e\tools\setup-guard-click.mjs"
Push-Location (Join-Path $repo "frontend")
$clickOut = & node $clickScript 2>&1 | Select-Object -Last 2
Pop-Location
Write-Host $clickOut
if (($clickOut -join "`n") -notmatch "CLICK-OK") { throw "FAIL: CDP 点击段未成功" }
Log "clicked - busy starts NOW; WM_CLOSE loop begins"

# ③ 立即连发：250ms 一次，窗口存活期内持续；警告框出现即计数并关闭
$refusals = 0
$done = $false
while ($sw.Elapsed.TotalSeconds -lt 120) {
  $main = Find-Main
  if ($main -eq [IntPtr]::Zero) { $done = $true; break }   # 安装完成且窗口已关
  [void][W]::PostMessageW($main, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  $box = Find-Box
  if ($box -ne [IntPtr]::Zero) {
    $refusals++
    Log ("refusal #{0} recorded (box shown, close swallowed)" -f $refusals)
    [void][W]::PostMessageW($box, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 300
  }
  Start-Sleep -Milliseconds 250
}
Log ("busy loop end: refusals={0} windowGone={1}" -f $refusals, $done)

# ④ 空闲转发检查：重新拉起（安装已完成→完成态/idle），WM_CLOSE 应正常关闭
$idleClosed = $false
Start-Process -FilePath $Exe
$w = [Diagnostics.Stopwatch]::StartNew()
while ($w.Elapsed.TotalSeconds -lt 30 -and (Find-Main) -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 200 }
$main = Find-Main
if ($main -ne [IntPtr]::Zero) {
  Log "idle window up — send WM_CLOSE, expect forward"
  [void][W]::PostMessageW($main, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  $w2 = [Diagnostics.Stopwatch]::StartNew()
  while ($w2.Elapsed.TotalSeconds -lt 6) {
    if ((Find-Main) -eq [IntPtr]::Zero) { $idleClosed = $true; break }
    Start-Sleep -Milliseconds 250
  }
}
Log ("idle close forwarded: {0}" -f $idleClosed)

Log ("RESULT refusals={0} idleForward={1}" -f $refusals, $idleClosed)
if ($refusals -ge 1 -and $idleClosed) { Write-Host "GUARD-PROBE PASS" } else { Write-Host "GUARD-PROBE FAIL" }
