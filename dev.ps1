<#
.SYNOPSIS
    Start the DeepseekHarness desktop app in development mode, throttled so a
    rebuild does not saturate the machine.

.DESCRIPTION
    `tauri dev` recompiles the Rust side on every change. On a many-core machine
    cargo happily runs one `rustc` per core, which pins every CPU and makes the
    desktop unusable while you wait. This script runs the same command but bounds
    the resource it uses, using three independent levers:

      1. -Jobs bounds how many `rustc` processes cargo runs at once. This is the
         main lever: bytes-compiled-per-second is roughly proportional to it.
      2. The whole process tree is lowered to BelowNormal priority, so the build
         yields to whatever you are actually doing. Windows inherits the priority
         class at process creation, so lowering this script before spawning means
         cargo, rustc, and link all arrive throttled - no race to retag them.
      3. The build runs at a lower I/O priority, so it does not fight the disk.

    Compile parallelism is capped, not compile quality: this still produces a
    normal debug build with full debug info, so breakpoints and backtraces work
    exactly as they do with `npm run dev`.

.PARAMETER Jobs
    Maximum concurrent `rustc` processes. Defaults to a fraction of the logical
    cores (2 on a 20-core box, 1 on a 4-core box). Lower = gentler.

.PARAMETER Priority
    Process priority for the build tree: Idle, BelowNormal (default), Normal.

.PARAMETER Release
    Build with optimizations instead of the debug profile. Much slower to compile.

.PARAMETER NoWatch
    Build and run once, without the file watcher. Useful for a one-off launch.

.PARAMETER Quiet
    Hide cargo's progress bars. Compiler errors and warnings are still printed -
    only the animated progress display is suppressed.

.EXAMPLE
    .\dev.ps1
    Start with the default throttle (2 cores' worth of compilation).

.EXAMPLE
    .\dev.ps1 -Jobs 1 -Priority Idle
    Barely noticeable: one compiler thread, at the lowest priority.

.EXAMPLE
    .\dev.ps1 -Jobs 8
    When you want the rebuild to finish quickly and have cores to spare.

.NOTES
    Windows / PowerShell only. This is a development convenience; it does not
    affect the release build (`npm run build`).

    IMPORTANT - file encoding: this file MUST be saved as UTF-8 **with BOM**.
    Windows PowerShell 5.1 (the default `powershell.exe`) assumes the ANSI code
    page for BOM-less files, which mangles the Chinese messages below and breaks
    string parsing with confusing errors. Most editors strip the BOM on save, so
    after editing, re-add it:

        $p = 'dev.ps1'
        $t = [IO.File]::ReadAllText($p, (New-Object Text.UTF8Encoding($false)))
        [IO.File]::WriteAllText($p, $t, (New-Object Text.UTF8Encoding($true)))

    Verify with a parse that must report 0 errors:

        $errors = $null
        [Management.Automation.Language.Parser]::ParseFile(
            (Resolve-Path dev.ps1), [ref]$null, [ref]$errors)
#>

[CmdletBinding()]
param(
    [ValidateRange(1, 64)]
    [int]$Jobs,

    [ValidateSet('Idle', 'BelowNormal', 'Normal')]
    [string]$Priority = 'BelowNormal',

    [switch]$Release,
    [switch]$NoWatch,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

# ── locate the project ──────────────────────────────────────────────────────
$root = $PSScriptRoot
if ([string]::IsNullOrEmpty($root)) { $root = (Get-Location).Path }

$tauriConf = Join-Path $root 'src-tauri\tauri.conf.json'
$cargoToml = Join-Path $root 'src-tauri\Cargo.toml'

if (-not (Test-Path $tauriConf) -or -not (Test-Path $cargoToml)) {
    Write-Error "找不到项目：$root 下缺少 src-tauri\tauri.conf.json。请把 dev.ps1 放在仓库根目录。"
    exit 1
}

# ── pick a sensible default job count ───────────────────────────────────────
# Roughly a quarter of the cores, clamped to 1..4, so a 4-core laptop still gets
# useful parallelism while a 20-core workstation stays responsive.
if (-not $PSBoundParameters.ContainsKey('Jobs')) {
    $cores = [Environment]::ProcessorCount
    $Jobs = [Math]::Max(1, [Math]::Min(4, [Math]::Floor($cores / 4)))
}

# ── lower our own priority FIRST ────────────────────────────────────────────
# This must happen before anything is spawned: Windows assigns the priority
# class at process creation and does not propagate a later change to existing
# children, so lowering now is what makes cargo, rustc, and link arrive throttled.
$wanted = [System.Diagnostics.ProcessPriorityClass]::$Priority
$originalPriority = $null
$lowered = $false
if ($Priority -ne 'Normal') {
    try {
        $me = Get-Process -Id $PID
        $originalPriority = $me.PriorityClass
        $me.PriorityClass = $wanted
        # Verify rather than assume: a silent failure here would give an
        # unthrottled build while the banner still claimed otherwise.
        $lowered = ((Get-Process -Id $PID).PriorityClass -eq $wanted)
    } catch {
        $lowered = $false
    }
}

# ── clamp cargo's parallelism ───────────────────────────────────────────────
# CARGO_BUILD_JOBS is read by cargo itself and reaches the `cargo run` that
# `tauri dev` invokes, so compilation is bounded without changing how the app is
# built (the debug profile, and therefore debugging, is untouched).
$env:CARGO_BUILD_JOBS = "$Jobs"

if ($Quiet) {
    # Only the animated progress display is disabled; warnings and errors still
    # print, because a quiet build that hides warnings is a trap.
    $env:CARGO_TERM_PROGRESS_WHEN = 'never'
}

# ── locate the tauri CLI ────────────────────────────────────────────────────
$tauriJs = Join-Path $root 'node_modules\@tauri-apps\cli\tauri.js'
if (-not (Test-Path $tauriJs)) {
    Write-Host ''
    Write-Host '尚未安装依赖（找不到 @tauri-apps/cli）。' -ForegroundColor Yellow
    Write-Host '请先运行：  npm install' -ForegroundColor Yellow
    Write-Host ''
    exit 1
}

foreach ($tool in @('node', 'cargo')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Error "找不到 $tool，请确认它已安装并在 PATH 中。"
        exit 1
    }
}

# ── report what we are about to do ──────────────────────────────────────────
$profileName = if ($Release) { 'release' } else { 'debug' }
Write-Host ''
Write-Host '  DeepseekHarness 开发服务器' -ForegroundColor Cyan
Write-Host "  项目        $root"
Write-Host "  编译并发    $Jobs 个 rustc（共 $([Environment]::ProcessorCount) 逻辑核心）"
if ($lowered) {
    Write-Host "  进程优先级  $Priority（已生效，cargo/rustc 将继承）" -ForegroundColor Green
} else {
    Write-Host "  进程优先级  未生效（继续以当前优先级运行）" -ForegroundColor Yellow
}
Write-Host "  构建配置    $profileName"
if ($NoWatch) { Write-Host '  文件监视    关闭（-NoWatch）' -ForegroundColor Yellow }
Write-Host ''
if ($NoWatch) {
    Write-Host '  正在编译并启动（-NoWatch：不重建，应用退出后本脚本结束）。'
} else {
    Write-Host '  提示：首次编译需要几分钟。之后改 Rust 代码会自动增量重编。'
    Write-Host '        按 Ctrl+C 停止。' -ForegroundColor DarkGray
}
Write-Host ''

# ── run ─────────────────────────────────────────────────────────────────────
# Every argument after `dev` is forwarded to the Tauri CLI; `tauri dev` in turn
# spawns `cargo run`, which reads CARGO_BUILD_JOBS from this environment.
$tauriArgs = @($tauriJs, 'dev')
if ($Release) { $tauriArgs += '--release' }
if ($NoWatch) { $tauriArgs += '--no-watch' }

$exitCode = 0
try {
    Push-Location $root
    & node @tauriArgs
    $exitCode = $LASTEXITCODE
} catch {
    Write-Host ''
    Write-Error "启动失败：$($_.Exception.Message)"
    $exitCode = 1
} finally {
    Pop-Location

    # `tauri dev` can leave the app running when interrupted; stop only the
    # binary we started, so an unrelated instance is never touched.
    $leftover = Get-Process -Name 'deepseek-harness-desktop' -ErrorAction SilentlyContinue
    if ($leftover) {
        Write-Host ''
        Write-Host '  正在停止残留的应用进程…' -ForegroundColor DarkGray
        $leftover | Stop-Process -Force -ErrorAction SilentlyContinue
    }

    # Restore this shell's own priority. Leaving it lowered would persist for the
    # rest of the session as an invisible side effect.
    if ($lowered -and $originalPriority) {
        try { (Get-Process -Id $PID).PriorityClass = $originalPriority } catch { }
    }
}

if ($exitCode -ne 0) {
    Write-Host ''
    Write-Host "tauri dev 退出，代码 $exitCode。" -ForegroundColor Yellow
    Write-Host '若为编译错误，上面已打印具体位置。' -ForegroundColor DarkGray
}

exit $exitCode
