param(
  [int]$x,
  [int]$y,
  [switch]$drag,
  [int]$x2,
  [int]$y2,
  [switch]$rect,
  # How long the button stays down before the move steps begin (and, for
  # -drag, after the last step before the release). The default matches a
  # quick human click; a long hold distinguishes "the IPC ran after the
  # release" from "the app never saw the button as held".
  [int]$holdms = 50
)
$src = @'
using System;
using System.Runtime.InteropServices;
public class SI {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  public const uint LEFTDOWN = 0x0002; public const uint LEFTUP = 0x0004;
}
'@
Add-Type -TypeDefinition $src
if ($rect) {
  Add-Type '
using System; using System.Runtime.InteropServices;
public class RR { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT2 q);
[StructLayout(LayoutKind.Sequential)] public struct RECT2 { public int L, T, R, B; } }'
  $app = Get-Process deepseek-harness-desktop | Select-Object -First 1
  $r = New-Object RR+RECT2
  [RR]::GetWindowRect($app.MainWindowHandle, [ref]$r) | Out-Null
  Write-Output ("{0}|{1}" -f $r.L, $r.T)
  exit 0
}
[SI]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 120
Write-Output ("down-at {0}" -f [DateTime]::Now.ToString('HH:mm:ss.fff'))
[SI]::mouse_event([SI]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds $holdms
if ($drag) {
  $steps = 12
  for ($i = 1; $i -le $steps; $i++) {
    [SI]::SetCursorPos($x + ($x2 - $x) * $i / $steps, $y + ($y2 - $y) * $i / $steps) | Out-Null
    Start-Sleep -Milliseconds 30
  }
  Start-Sleep -Milliseconds $holdms
}
Write-Output ("up-at {0}" -f [DateTime]::Now.ToString('HH:mm:ss.fff'))
[SI]::mouse_event([SI]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 150
Write-Output "clicked"
