param()
# Posts the exact message tao's `handle_os_dragging` posts for a stale drag:
# WM_NCLBUTTONDOWN (HTCAPTION) with the cursor position packed as POINTS,
# while no mouse button is held. On an unguarded window DefWindowProc enters
# the modal move loop on the next pump; with the guard the subclass swallows it.
$src = @'
using System;
using System.Runtime.InteropServices;
public class SP {
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X; public int Y; }
}
'@
Add-Type -TypeDefinition $src

$app = Get-Process deepseek-harness-desktop -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $app) { Write-Error 'no app window'; exit 1 }
$h = $app.MainWindowHandle

$p = New-Object SP+P
[SP]::GetCursorPos([ref]$p) | Out-Null
# POINTS: x in the low 16 bits, y in the high 16 (tao packs the same way).
$lp = [IntPtr]((($p.Y -band 0xFFFF) -shl 16) -bor ($p.X -band 0xFFFF))

# WM_NCLBUTTONDOWN = 0x00A1, HTCAPTION = 2
[SP]::PostMessage($h, 0x00A1, [IntPtr]2, $lp) | Out-Null
Write-Output "posted stale WM_NCLBUTTONDOWN to hwnd $h at $($p.X),$($p.Y)"
