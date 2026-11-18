# Bring the Kafka Explorer app window to the foreground.
#
# THE root cause of every "random" probe hang: when the app window is in the
# background, WebView2 throttles its render pipeline (requestAnimationFrame
# stops), and Playwright's actionability check — stable = same bounding box
# across two rAF frames — waits forever. evaluate() keeps working, so the
# failure looks like a mysterious click timeout while fills still succeed.
#
# Called from frontend/e2e/tests/helpers.ts (ensureForeground).
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class KeFg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
"@
$p = Get-Process kafka-explorer-cdp -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) {
  [KeFg]::ShowWindow($p.MainWindowHandle, 9) | Out-Null  # SW_RESTORE
  [KeFg]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
}
