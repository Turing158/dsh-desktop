/**
 * TEMPORARY: capture the app's real window with PrintWindow, so a screenshot does
 * not depend on the CDP target being the right one.
 *
 * The CDP page target kept resolving to a stale error document, which is useless
 * for a visual check. Capturing the window directly sidesteps that entirely and
 * shows exactly what the user sees.
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const out = process.argv[2]
if (!out) {
  console.error('usage: node tools/_winshot.mjs <out.png>')
  process.exit(2)
}

// Use .NET through PowerShell, which can P/Invoke without a native module.
const script = `
Add-Type -AssemblyName System.Drawing
$src = @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@
Add-Type -TypeDefinition $src
$p = Get-Process | Where-Object { $_.ProcessName -eq 'deepseek-harness-desktop' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Error 'no window'; exit 1 }
$h = $p.MainWindowHandle
[void][W]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 700
$r = New-Object W+RECT
[void][W]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $ht = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
[void][W]::PrintWindow($h, $dc, 2)
$g.ReleaseHdc($dc)
$bmp.Save('${out.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "$w x $ht"
`

try {
  const result = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  console.error('[winshot] window size:', result.trim())
  console.error('[winshot] wrote', out)
} catch (error) {
  console.error('[winshot] failed:', error.message)
  process.exit(1)
}
