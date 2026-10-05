<#
.SYNOPSIS
    Build the DeepseekHarness desktop app for distribution, tuned for the
    smallest possible artifacts, and collect them into .\pack by type.

.DESCRIPTION
    Runs `tauri build` (release profile) with every size lever this project has:

      1. RUSTFLAGS=-C opt-level=z overrides the release profile's `opt-level="s"`
         for this build only. "z" optimizes for code size rather than speed,
         which costs a little runtime but fits this shell: the UI is served by
         the dsh web server and the window is a thin WebView2 host. Cargo.toml
         stays untouched - normal development keeps its own settings.
      2. The release profile in Cargo.toml already applies the heavy levers for
         every crate: lto=true (fat LTO), codegen-units=1, panic="abort", and
         strip=true (symbols removed). This script does not restate them.
      3. The NSIS installer compresses the payload with LZMA and installs
         per-user; the bundle targets are already ["nsis"] only - no WiX MSI
         alongside it - and no updater artifacts are generated.

    After a successful build the artifacts are COPIED into .\pack, one folder
    per type:

      pack\portable\deepseek-harness-desktop.exe      the portable exe
      pack\portable\dsh-plugin\                      required plugin resources
      pack\portable\runtime\                         bundled runtime (default)
      pack\DeepseekHarness-portable-win-x64.zip       complete offline portable
      pack\single\deepseek-harness-desktop.exe        single-file distribution
      pack\installer\DeepseekHarness_*-setup.exe      the LZMA-compressed installer

    Each type's folder is replaced on every run, so it always holds exactly the
    artifacts of the last build - stale versions cannot accumulate next to the
    current one. Other files in .\pack are left alone. The originals under
    src-tauri\target\ are untouched.

    NOTE on the first run: because RUSTFLAGS differs from a plain release build,
    cargo rebuilds every dependency once when it changes. Later runs are
    incremental. Use -Clean for a from-scratch measure of the final size.

.PARAMETER Target
    All (default): build portable, single, and the NSIS installer.
    Portable: build portable and the NSIS installer, without single.
    Single: build only the single exe, without downloading offline runtimes.
    Single embeds desktop plugins and writes them to the user's app cache at
    startup. WebView2 and Node.js/npm must be installed by the user; Git uses
    the user's installation. Missing DSH is installed by the existing startup flow.

.PARAMETER PortableMode
    Offline (default): bundles Node.js, npm, DSH and its dependencies, and the
    fixed WebView2 runtime. Downloads occur on the build machine only; later
    builds verify and reuse the cache. PowerShell 7 and Git are not bundled.
    Thin: preserves the old portable which requires the recipient's runtime.
    The NSIS installer retains its existing system-runtime behavior.
    This option only controls portable; single always uses the system runtime.

.PARAMETER Jobs
    Maximum concurrent rustc processes, as in dev.ps1. Defaults to a quarter of
    the logical cores, clamped to 1..4.

.PARAMETER Priority
    Process priority for the build tree: Idle, BelowNormal (default), Normal.

.PARAMETER SkipBundle
    Skip the NSIS installer. Build portable, its ZIP, and single, including
    the complete runtime unless -PortableMode Thin is selected.

.PARAMETER Clean
    Run `cargo clean --release` first, so the reported sizes come from a full
    rebuild rather than reusing cached artifacts.

.PARAMETER OutDir
    The folder the artifacts are collected into, relative to the repository
    root. Defaults to `pack`.

.EXAMPLE
    .\pack.ps1
    Build, then collect installer and portable exe into .\pack.

.EXAMPLE
    .\pack.ps1 -SkipBundle
    Build offline portable, its ZIP, and single, without an installer.

.EXAMPLE
    .\pack.ps1 -Target Single
    Build only pack\single\deepseek-harness-desktop.exe.

.EXAMPLE
    .\pack.ps1 -Clean -Jobs 8
    From-scratch build with more parallelism, for an honest final measurement.

.NOTES
    Windows / PowerShell only. File encoding: this file MUST be saved as UTF-8
    **with BOM**, for the same reason as dev.ps1 - Windows PowerShell 5.1 reads
    BOM-less files in the ANSI code page, which mangles the Chinese messages
    below. After editing, re-apply the BOM:

        $p = 'pack.ps1'
        $t = [IO.File]::ReadAllText($p, (New-Object Text.UTF8Encoding($false)))
        [IO.File]::WriteAllText($p, $t, (New-Object Text.UTF8Encoding($true)))

    Verify with a parse that must report 0 errors:

        $errors = $null
        [Management.Automation.Language.Parser]::ParseFile(
            (Resolve-Path pack.ps1), [ref]$null, [ref]$errors)
#>

[CmdletBinding()]
param(
    [ValidateRange(1, 64)]
    [int]$Jobs,

    [ValidateSet('Idle', 'BelowNormal', 'Normal')]
    [string]$Priority = 'BelowNormal',

    [switch]$SkipBundle,
    [switch]$Clean,

    [ValidateSet('All', 'Portable', 'Single')]
    [string]$Target = 'All',

    [ValidateSet('Offline', 'Thin')]
    [string]$PortableMode = 'Offline',

    [ValidateNotNullOrEmpty()]
    [string]$OutDir = 'pack'
)

$ErrorActionPreference = 'Stop'

# ── locate the project ──────────────────────────────────────────────────────
$root = $PSScriptRoot
if ([string]::IsNullOrEmpty($root)) { $root = (Get-Location).Path }

$tauriConf = Join-Path $root 'src-tauri\tauri.conf.json'
$tauriJs = Join-Path $root 'node_modules\@tauri-apps\cli\tauri.js'

if (-not (Test-Path $tauriConf)) {
    Write-Error "找不到项目：$root 下缺少 src-tauri\tauri.conf.json。请把 pack.ps1 放在仓库根目录。"
    exit 1
}
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

# ── pick a sensible default job count ───────────────────────────────────────
if (-not $PSBoundParameters.ContainsKey('Jobs')) {
    $cores = [Environment]::ProcessorCount
    $Jobs = [Math]::Max(1, [Math]::Min(4, [Math]::Floor($cores / 4)))
}

# ── lower our own priority FIRST, as dev.ps1 does ───────────────────────────
$wanted = [System.Diagnostics.ProcessPriorityClass]::$Priority
if ($Priority -ne 'Normal') {
    try {
        $me = Get-Process -Id $PID
        $me.PriorityClass = $wanted
    } catch {
        # A priority that fails to apply is not worth failing the build over.
    }
}

$env:CARGO_BUILD_JOBS = "$Jobs"

# ── the size lever: optimize every crate for code size ──────────────────────
#
# RUSTFLAGS flags land AFTER the profile-derived rustc flags, so `-C opt-level=z`
# here overrides Cargo.toml's `opt-level = "s"` for this build only. "z" turns
# loop-invariant and inlining decisions toward size at some runtime cost, which
# is the right trade for a thin WebView2 host. Because a changed RUSTFLAGS
# invalidates cargo's cache, the first run after changing it rebuilds every
# dependency; later runs are incremental.
$env:RUSTFLAGS = "-C opt-level=z"

if ($Clean) {
    Write-Host '清理旧的 release 构建产物……' -ForegroundColor DarkGray
    & cargo clean --release --manifest-path (Join-Path $root 'src-tauri\Cargo.toml')
    if ($LASTEXITCODE -ne 0) { Write-Error 'cargo clean 失败。'; exit 1 }
}

$bundleArgs = @('--no-bundle')

$runtimeRoot = $null
$runtimeTool = Join-Path $root 'tools\prepare-offline-runtime.mjs'
if ($Target -ne 'Single' -and $PortableMode -eq 'Offline') {
    Write-Host '准备离线运行环境（首次在构建机下载，以后复用校验后的缓存）……' -ForegroundColor Cyan
    New-Item -ItemType Directory -Path (Join-Path $root 'src-tauri\target') -Force | Out-Null
    $runtimeResult = Join-Path $root 'src-tauri\target\offline-runtime-result.json'
    & node $runtimeTool $runtimeResult
    if ($LASTEXITCODE -ne 0) { throw '离线环境准备失败，未替换现有 portable。' }
    $runtimeRoot = (Get-Content -LiteralPath $runtimeResult -Raw | ConvertFrom-Json).root
    # This binary must never fall back to the recipient's Node/DSH or an install.
    $bundleArgs = @('--no-bundle', '--features', 'offline')
}

Write-Host ''
Write-Host '  DeepseekHarness 打包' -ForegroundColor Cyan
Write-Host "  项目        $root"
Write-Host "  输出类型    $Target"
if ($Target -ne 'Single') { Write-Host "  便携模式    $PortableMode" }
Write-Host "  构建配置    release（体积优化：opt-level=z）"
Write-Host "  编译并发    $Jobs 个 rustc（共 $([Environment]::ProcessorCount) 逻辑核心）"
if ($Target -eq 'Single') { Write-Host '  打包        仅 single 单文件 exe' }
elseif ($SkipBundle) { Write-Host '  打包        跳过 NSIS' -ForegroundColor Yellow }
else { Write-Host '  打包        包含 NSIS 安装包' }
Write-Host "  产物收集    $OutDir（按 portable、single、installer 分类）"
Write-Host '  提示：RUSTFLAGS 变化后的第一次构建会全量重编依赖，之后为增量。' -ForegroundColor DarkGray
Write-Host ''

# ── run ─────────────────────────────────────────────────────────────────────
$exitCode = 0
if ($Target -ne 'Single') {
    try {
        Push-Location $root
        & node $tauriJs build @bundleArgs
        $exitCode = $LASTEXITCODE
    } catch {
        Write-Host ''
        Write-Error "打包失败：$($_.Exception.Message)"
        $exitCode = 1
    } finally {
        Pop-Location
    }
}

if ($exitCode -ne 0) {
    Write-Host ''
    Write-Host "打包失败（退出码 $exitCode）。" -ForegroundColor Red
    exit $exitCode
}

# ── collect the artifacts into .\<OutDir>, one folder per type ──────────────
#
# Each type's folder is replaced wholesale, so it always reflects the LAST
# build: a stale installer next to the current one is exactly how someone ends
# up distributing the wrong file. Anything else in $OutDir is never touched.
function Format-Size([long]$bytes) {
    if ($bytes -ge 1MB) { '{0:N2} MB' -f ($bytes / 1MB) }
    else { '{0:N1} KB' -f ($bytes / 1KB) }
}

$releaseDir = Join-Path $root 'src-tauri\target\release'
$packRoot = Join-Path $root $OutDir
$portableDir = Join-Path $packRoot 'portable'
$singleDir = Join-Path $packRoot 'single'
$installerDir = Join-Path $packRoot 'installer'

function Resolve-OutputPath([string]$path) {
    $full = [IO.Path]::GetFullPath($path)
    $base = [IO.Path]::GetFullPath($packRoot).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝操作输出目录之外的路径：$full"
    }
    return $full
}

function Remove-OutputDirectory([string]$path) {
    $full = Resolve-OutputPath $path
    if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force }
}

function Move-OutputDirectory([string]$source, [string]$destination) {
    $source = Resolve-OutputPath $source
    $destination = Resolve-OutputPath $destination
    Move-Item -LiteralPath $source -Destination $destination
}

$exePath = Join-Path $releaseDir 'deepseek-harness-desktop.exe'
$bundleDir = Join-Path $releaseDir 'bundle\nsis'

$collected = @()

if ($Target -ne 'Single') {
    if (Test-Path $exePath) {
        # Assemble and verify first; a failed copy leaves the previous portable intact.
        $finalPortableDir = $portableDir
        $portableDir = Join-Path $packRoot ('.portable-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $portableDir -Force | Out-Null
        Get-ChildItem -Path $portableDir -Filter '*.exe' -ErrorAction SilentlyContinue |
            Remove-Item -Force
        Copy-Item -Path $exePath -Destination $portableDir -Force
        # The exe loads plugins relative to its resource directory. Copy exactly the
        # installer resource map, so a portable folder works outside this checkout.
        $portableBase = [IO.Path]::GetFullPath($portableDir) + [IO.Path]::DirectorySeparatorChar
        $resourceMap = (Get-Content -LiteralPath (Join-Path $root 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).bundle.resources
        foreach ($resource in $resourceMap.PSObject.Properties) {
            $resourceSource = [IO.Path]::GetFullPath((Join-Path (Join-Path $root 'src-tauri') $resource.Name))
            $resourceTarget = [IO.Path]::GetFullPath((Join-Path $portableDir $resource.Value))
            if (-not $resourceTarget.StartsWith($portableBase, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Portable resource escapes output directory: $($resource.Value)"
            }
            New-Item -ItemType Directory -Path (Split-Path $resourceTarget -Parent) -Force | Out-Null
            Copy-Item -LiteralPath $resourceSource -Destination $resourceTarget -Force
        }
        if ($runtimeRoot) {
            $runtimeDestination = Join-Path $portableDir 'runtime'
            & robocopy.exe $runtimeRoot $runtimeDestination /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
            if ($LASTEXITCODE -ge 8) { throw "复制内置环境失败（robocopy $LASTEXITCODE）。" }
            & node $runtimeTool --verify $runtimeDestination
            if ($LASTEXITCODE -ne 0) { throw '复制后的运行环境校验失败，未替换现有 portable。' }
        }
        $archiveName = if ($runtimeRoot) { 'DeepseekHarness-portable-win-x64.zip' } else { 'DeepseekHarness-portable-thin-win-x64.zip' }
        $archivePath = Join-Path $packRoot $archiveName
        $archiveStage = Join-Path $packRoot ('.archive-' + [guid]::NewGuid().ToString('N') + '.zip')
        Write-Host '压缩 portable 包……'
        & (Join-Path $env:SystemRoot 'System32\tar.exe') -a -cf $archiveStage -C $portableDir .
        if ($LASTEXITCODE -ne 0) { throw 'portable ZIP 压缩失败，未替换现有 portable。' }
        Remove-OutputDirectory $finalPortableDir
        Move-OutputDirectory $portableDir $finalPortableDir
        $portableDir = $finalPortableDir
        Move-Item -LiteralPath $archiveStage -Destination $archivePath -Force
        $collected += @{ Kind = '便携版 ZIP'; Path = $archivePath; Size = (Get-Item -LiteralPath $archivePath).Length }
        $copied = Get-ChildItem -Path $portableDir -Filter '*.exe' | Select-Object -First 1
        $collected += @{ Kind = '便携版 exe'; Path = $copied.FullName; Size = $copied.Length }
    } else {
        throw "未找到构建产物：$exePath"
    }
}

if ($Target -ne 'Portable') {
    Write-Host '构建 single 单文件版（内置桌面插件，使用系统运行环境）……'
    try {
        Push-Location $root
        & node $tauriJs build --no-bundle --features single
        if ($LASTEXITCODE -ne 0) { throw 'single 构建失败；已有分发产物已保留。' }
    } finally { Pop-Location }
    if (-not (Test-Path -LiteralPath $exePath)) { throw "未找到 single 构建产物：$exePath" }
    $singleStage = Join-Path $packRoot ('.single-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $singleStage -Force | Out-Null
    Copy-Item -LiteralPath $exePath -Destination $singleStage
    Remove-OutputDirectory $singleDir
    Move-OutputDirectory $singleStage $singleDir
    $copied = Get-Item -LiteralPath (Join-Path $singleDir 'deepseek-harness-desktop.exe')
    $collected += @{ Kind = '单文件 exe'; Path = $copied.FullName; Size = $copied.Length }
}

if (-not $SkipBundle -and $Target -ne 'Single') {
    # Always rebuild without features: never put the offline/single binary
    # into the normal NSIS package just because it was built most recently.
    Write-Host '构建原有 NSIS 安装版（沿用系统环境，非离线版）……'
    try {
        Push-Location $root
        & node $tauriJs build
        if ($LASTEXITCODE -ne 0) { throw 'NSIS 构建失败；已生成的 portable/single 已保留。' }
    } finally { Pop-Location }
    $newestInstaller = Get-ChildItem -Path $bundleDir -Filter '*.exe' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($newestInstaller) {
        New-Item -ItemType Directory -Path $installerDir -Force | Out-Null
        Get-ChildItem -Path $installerDir -Filter '*.exe' -ErrorAction SilentlyContinue |
            Remove-Item -Force
        Copy-Item -Path $newestInstaller.FullName -Destination $installerDir -Force
        $copied = Get-ChildItem -Path $installerDir -Filter '*.exe' | Select-Object -First 1
        $collected += @{ Kind = '安装包    '; Path = $copied.FullName; Size = $copied.Length }
    } else {
        Write-Host "未找到安装包：$bundleDir" -ForegroundColor Yellow
    }
}

# ── report ──────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '  打包完成，产物已收集：' -ForegroundColor Green
if ($Target -ne 'Single' -and $PortableMode -eq 'Offline') {
    Write-Host '  portable 已包含 Node.js、npm、DSH、WebView2；请分发完整 ZIP。'
    Write-Host '  PowerShell 7 和 Git 按目标电脑已有安装提供，不随包携带。'
}
if ($Target -ne 'Portable') {
    Write-Host '  single 只需分发一个 exe；桌面插件在启动时写入应用缓存。'
    Write-Host '  用户需安装 WebView2、Node.js/npm；Git 使用已有安装，缺少 DSH 时自动联网安装。'
}
foreach ($item in $collected) {
    Write-Host ("    {0}  {1}  ({2})" -f $item.Kind, $item.Path, (Format-Size $item.Size))
}
if ($collected.Count -eq 0) {
    Write-Host '    （没有任何产物被收集）' -ForegroundColor Yellow
}
Write-Host ''
exit 0
