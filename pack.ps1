<#
.SYNOPSIS
    Build the dsh desktop app for distribution, tuned for the
    smallest possible artifacts, and collect them flat into .\pack, one file
    per type, told apart by the file name.

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
      3. The installer uses solid LZMA compression for the app and desktop
         plugins. It detects Node.js/npm and WebView2, then downloads only
         missing components selected on its checkbox page. Portable retains
         its complete runtime. Both distributions exclude DSH.

    After a successful build the artifacts are COPIED flat into .\pack - no
    per-type subfolders - named dsh-desktop-v<version>-<type>-win-<arch>
    (single omits the <type> segment and its dash):

      pack\dsh-desktop-vX.Y.Z-portable-win-x64.zip    portable ZIP with Node.js/npm and WebView2
      pack\dsh-desktop-vX.Y.Z-installer-win-x64.exe   compact installer with optional online runtimes
      pack\dsh-desktop-vX.Y.Z-win-x64.exe             single-file distribution

    The <arch> segment follows -Arch (default All builds both x64 and x86 in
    one run; Host builds only the rustc host architecture), and the version
    from tauri.conf.json. Every portable architecture gets Node.js/npm and WebView2,
    pinned by tools\offline-runtime.json (x64) and tools\offline-runtime-x86.json
    (x86). Installers download these verified assets only when needed and selected.
    DSH and its dependencies are not bundled; startup reuses an existing
    installation or installs DSH through npm. Old artifacts of the
    same type are replaced on every run - across architectures - so the folder
    always holds exactly the artifacts of the last build - stale versions
    cannot accumulate next to the current one. Other files in .\pack are left
    alone. The originals under src-tauri\target\ are untouched.

    Generating the installer needs makensis (NSIS 3.x): the copy tauri already
    installed under %LOCALAPPDATA%\tauri\NSIS is preferred, then PATH. An
    uncompressed application TAR lets NSIS apply solid LZMA compression;
    the system tar.exe extracts it with support for long paths.

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

.PARAMETER Arch
    All (default): build x64 AND x86 in one run, collecting both sets into the
    output folder. Host: build only the rustc host architecture, classic
    target\release layout. x64 / x86: build only that architecture; when it
    differs from the host, cargo cross-builds with --target and the artifacts
    come from target\<triple>\release. A cross target needs `rustup target add
    <triple>` once beforehand.

.PARAMETER Jobs
    Maximum concurrent rustc processes, as in dev.ps1. Defaults to a quarter of
    the logical cores, clamped to 1..4.

.PARAMETER Priority
    Process priority for the build tree: Idle, BelowNormal (default), Normal.

.PARAMETER SkipBundle
    Skip the generated installer. Portable includes Node.js/npm and WebView2;
    single uses the system runtime. Neither includes DSH.

.PARAMETER Clean
    Run `cargo clean --release` first, so the reported sizes come from a full
    rebuild rather than reusing cached artifacts.

.PARAMETER OutDir
    The folder the artifacts are collected into, relative to the repository
    root. Defaults to `pack`.

.EXAMPLE
    .\pack.ps1
    Build x64 and x86, then collect portable ZIPs, installers, and singles
    for both architectures into .\pack.

.EXAMPLE
    .\pack.ps1 -SkipBundle
    Build portable and single, without an installer.

.EXAMPLE
    .\pack.ps1 -Arch x86
    Cross-build only the x86 artifacts (pack\dsh-desktop-vX.Y.Z-*-win-x86.*;
    needs `rustup target add i686-pc-windows-msvc` once beforehand).

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

    [ValidateSet('All', 'Host', 'x64', 'x86')]
    [string]$Arch = 'All',

    [switch]$SkipBundle,
    [switch]$Clean,

    [ValidateSet('All', 'Portable', 'Single')]
    [string]$Target = 'All',

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

foreach ($tool in @('node', 'cargo', 'rustc')) {
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

# ── resolve the architectures to build ──────────────────────────────────────
# All (default) builds x64 AND x86 in one run. Host builds only the rustc host
# architecture with the classic target\release layout; a forced architecture
# that differs from the host cross-builds with --target, which moves that
# build tree to target\<triple>\release.
$hostTriple = [string]((& rustc -vV) | Where-Object { $_ -like 'host:*' })
# The host line looks like "host: x86_64-pc-windows-msvc"; keep the arch word.
$hostPart = ($hostTriple -split ':', 2)[1]
$hostArchToken = if ($hostPart) { ($hostPart.Trim() -split '-')[0] } else { '' }
$hostArch = switch -Regex ([string]$hostArchToken) {
    '^(x86_64|amd64)$' { 'x64' }
    '^(i[3-6]86|x86)$' { 'x86' }
    default { throw "未支持的构建架构：$hostTriple" }
}
# Captured before the loop: PowerShell variables are case-insensitive, and the
# per-architecture loop below reuses $arch.
$requestedArch = $Arch
$archList = switch ($requestedArch) {
    'All'  { @('x64', 'x86') }
    'Host' { @($hostArch) }
    default { @($requestedArch) }
}
# One-time cross-target check, before any build starts.
foreach ($archCandidate in $archList) {
    if ($archCandidate -eq $hostArch) { continue }
    $tripleCandidate = if ($archCandidate -eq 'x64') { 'x86_64-pc-windows-msvc' } else { 'i686-pc-windows-msvc' }
    if (-not (Get-Command rustup -ErrorAction SilentlyContinue)) {
        throw "交叉构建到 $archCandidate 需要 rustup 安装目标 $tripleCandidate，但未找到 rustup。"
    }
    $installedTargets = & rustup target list --installed
    if ($installedTargets -notcontains $tripleCandidate) {
        throw "尚未安装 Rust 目标 $tripleCandidate，请先运行：  rustup target add $tripleCandidate"
    }
}

# Validate the architecture selection BEFORE wiping anything with -Clean.
if ($Clean) {
    Write-Host '清理旧的 release 构建产物……' -ForegroundColor DarkGray
    & cargo clean --release --manifest-path (Join-Path $root 'src-tauri\Cargo.toml')
    if ($LASTEXITCODE -ne 0) { Write-Error 'cargo clean 失败。'; exit 1 }
}

# Every architecture needs its own runtime: the payload carries native
# binaries (node.exe, the fixed WebView2 runtime), so an x64 payload cannot
# serve an x86 build. Each recipe is pinned separately and cached by digest, so
# a rebuilt architecture never re-downloads the other one's assets.
$runtimeRoots = @{}
$runtimeTool = Join-Path $root 'tools\prepare-offline-runtime.mjs'
if ($Target -ne 'Single') {
    Write-Host '准备 Node.js/npm 与 WebView2（首次在构建机下载，以后复用校验后的缓存）……' -ForegroundColor Cyan
    New-Item -ItemType Directory -Path (Join-Path $root 'src-tauri\target') -Force | Out-Null
    foreach ($runtimeArch in $archList) {
        Write-Host "  准备 $runtimeArch 离线环境……" -ForegroundColor DarkGray
        $runtimeResult = Join-Path $root "src-tauri\target\offline-runtime-$runtimeArch-result.json"
        & node $runtimeTool $runtimeResult --arch $runtimeArch
        if ($LASTEXITCODE -ne 0) { throw "离线环境准备失败（$runtimeArch），未替换现有产物。" }
        $runtimeRoots[$runtimeArch] = (Get-Content -LiteralPath $runtimeResult -Raw | ConvertFrom-Json).root
    }
}

Write-Host ''
Write-Host '  dsh desktop 打包' -ForegroundColor Cyan
Write-Host "  项目        $root"
Write-Host "  输出类型    $Target"
if ($Target -ne 'Single') { Write-Host '  便携模式    内置 Node.js、npm 与固定版 WebView2；不包含 DSH' }
Write-Host "  目标架构    $($archList -join '、')（本机 $hostArch）"
Write-Host "  构建配置    release（体积优化：opt-level=z）"
Write-Host "  编译并发    $Jobs 个 rustc（共 $([Environment]::ProcessorCount) 逻辑核心）"
if ($Target -eq 'Single') { Write-Host '  打包        仅 single 单文件 exe' }
elseif ($SkipBundle) { Write-Host '  打包        跳过安装包' -ForegroundColor Yellow }
else { Write-Host '  打包        含精简安装包（LZMA 压缩，运行环境按需联网安装）' }
Write-Host "  产物收集    $OutDir（文件名区分类型：portable / installer / single）"
Write-Host '  提示：RUSTFLAGS 变化后的第一次构建会全量重编依赖，之后为增量。' -ForegroundColor DarkGray
Write-Host ''

# ── collect the artifacts flat into .\<OutDir>, named by type ───────────────
#
# One artifact file per type and architecture, told apart by the file name
# (dsh-desktop-v<version>-<type>-win-<arch>; single omits the <type> segment).
# Old artifacts of the same type are replaced on every run - across
# architectures - so a stale version next to the current one is exactly how
# someone ends up distributing the wrong file. Anything else in $OutDir is
# never touched.
function Format-Size($bytes) {
    if ($null -eq $bytes) { '大小未知' }
    elseif ($bytes -ge 1MB) { '{0:N2} MB' -f ($bytes / 1MB) }
    else { '{0:N1} KB' -f ($bytes / 1KB) }
}

# Reading an artifact's size back is a REPORTING step that runs after the file
# has been published, so it must never become the step that ends a finished
# run - the same shape of failure this script repairs below. An unreadable
# artifact is reported as "size unknown" instead.
function Get-ArtifactSize([string]$path) {
    try { return (Get-Item -LiteralPath $path -ErrorAction Stop).Length }
    catch { return $null }
}

$packRoot = Join-Path $root $OutDir
New-Item -ItemType Directory -Path $packRoot -Force | Out-Null

# Version comes from tauri.conf.json; the architecture list was resolved above.
$conf = Get-Content -LiteralPath $tauriConf -Raw | ConvertFrom-Json
$version = [string]$conf.version
if ([string]::IsNullOrEmpty($version)) { throw "tauri.conf.json 缺少 version 字段：$tauriConf" }
# productName names the installer, its shortcut and its Add/Remove entry; it is
# also the exe's FileDescription and ProductName through tauri-build.
$productName = [string]$conf.productName
if ([string]::IsNullOrEmpty($productName)) { $productName = 'dsh desktop' }
# The same exe resource takes CompanyName from bundle.publisher, and the
# Add/Remove entry shows that name too, so both read one field.
$publisher = [string]$conf.bundle.publisher
if ([string]::IsNullOrEmpty($publisher)) { $publisher = $productName }

function Resolve-OutputPath([string]$path) {
    $full = [IO.Path]::GetFullPath($path)
    $base = [IO.Path]::GetFullPath($packRoot).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝操作输出目录之外的路径：$full"
    }
    return $full
}

# Deleting a staging tree is the one job PowerShell's own file provider cannot
# do here: the offline runtime ships node_modules paths longer than MAX_PATH
# (270 characters in this repository), robocopy and tar create and read them
# happily, but Remove-Item cannot even resolve them - and with
# $ErrorActionPreference = 'Stop' a single such file turned an ALREADY
# SUCCESSFUL build into a failed run: the artifact had been published, then the
# cleanup threw, so everything after it - the installer and the single exe
# - was never collected, while the staging folder stayed in the output folder.
# Remove-StagingTree deletes through the \\?\ long-path prefix, falls back to
# robocopy /MIR when even that is refused, and only ever WARNS: leftover
# temporary litter must never cost a finished build. Only paths inside the
# output folder are accepted.
function Remove-StagingTree([string]$path) {
    try { $full = Resolve-OutputPath $path }
    catch {
        # Refusing a path is reported, not escalated: throwing here would
        # replace the in-flight error and could abort a finished run.
        Write-Host "  警告：拒绝清理输出目录之外的路径：$path" -ForegroundColor Yellow
        return
    }
    if (-not (Test-Path -LiteralPath $full)) { return }
    try {
        Remove-Item -LiteralPath "\\?\$full" -Recurse -Force -ErrorAction Stop
        return
    } catch {
        Write-Host "  临时项直删失败，改用 robocopy 兜底：$($_.Exception.Message)" -ForegroundColor DarkGray
    }
    try {
        # Mirroring an empty folder over the target deletes what Remove-Item
        # cannot reach; the emptied root is then removed normally. /XJ keeps the
        # mirror from following a junction out of the staging tree.
        $emptyStage = Join-Path $packRoot ('.empty-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $emptyStage -Force | Out-Null
        & robocopy.exe $emptyStage $full /MIR /XJ /R:0 /W:0 /NFL /NDL /NJH /NJS /NP | Out-Null
        Remove-Item -LiteralPath "\\?\$emptyStage" -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath "\\?\$full" -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        # Left to the check below: a cleanup failure is never fatal.
    }
    if (Test-Path -LiteralPath "\\?\$full") {
        Write-Host "  警告：临时项未能完全删除，请手动清理：$full" -ForegroundColor Yellow
    }
}

# Artifacts published during THIS run (one per arch iteration): the cross-arch
# stale cleanup below must never delete them.
$publishedThisRun = New-Object 'System.Collections.Generic.List[string]'

function Publish-OutputFile([string]$stage, [string]$name, [string]$stalePattern) {
    $stage = Resolve-OutputPath $stage
    $destination = Resolve-OutputPath (Join-Path $packRoot $name)
    # Publish first, then replace the same type's old artifacts: a failed move
    # must never cost the previous artifacts. Other types, unrelated files,
    # and anything published earlier in THIS run are never touched.
    Move-Item -LiteralPath $stage -Destination $destination -Force
    $publishedThisRun.Add($destination)
    foreach ($old in @(Get-ChildItem -LiteralPath $packRoot -File -ErrorAction SilentlyContinue |
            Where-Object { -not ($publishedThisRun -contains $_.FullName) -and $_.Name -match $stalePattern })) {
        # A stale file that refuses to go warns instead of aborting the run:
        # the fresh artifact is already in place.
        try { Remove-Item -LiteralPath $old.FullName -Force -ErrorAction Stop }
        catch { Write-Host "  警告：旧产物删除失败，请手动处理：$($old.FullName)" -ForegroundColor Yellow }
    }
    return $destination
}

# The installer has its own compressed app payload and optional online runtimes.
. (Join-Path $root 'tools\build-installer.ps1')

# Litter from a run that was interrupted (Ctrl+C, crash) or that died in its
# cleanup. Only the GUID-named staging entries this script itself creates, and
# only directly inside the output folder, are ever touched.
$staleStagingPattern = '^\.(portable|archive|installer|single|empty)-[0-9a-f]{32}(\.zip|\.exe)?$'
Get-ChildItem -LiteralPath $packRoot -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match $staleStagingPattern } |
    ForEach-Object {
        Write-Host "  清理上次运行遗留的临时项：$($_.Name)" -ForegroundColor DarkGray
        Remove-StagingTree $_.FullName
    }

$collected = @()

foreach ($arch in $archList) {
    $targetTriple = if ($arch -eq $hostArch) { $null } elseif ($arch -eq 'x64') { 'x86_64-pc-windows-msvc' } else { 'i686-pc-windows-msvc' }
    # This architecture's own offline runtime; every architecture has one.
    $archRuntimeRoot = $runtimeRoots[$arch]
    # Cross builds keep their tree under target\<triple>\release.
    $releaseDir = if ($targetTriple) { Join-Path $root "src-tauri\target\$targetTriple\release" } else { Join-Path $root 'src-tauri\target\release' }
    $exePath = Join-Path $releaseDir 'deepseek-harness-desktop.exe'
    $exeName = Split-Path $exePath -Leaf
    $portableZipName = "dsh-desktop-v$version-portable-win-$arch.zip"
    $singleName = "dsh-desktop-v$version-win-$arch.exe"

    # This binary supports both the strict portable runtime and the installer's
    # persisted selection of system/downloaded components. DSH is installed separately.
    $bundleArgs = @('--no-bundle', '--features', 'offline')
    if ($targetTriple) { $bundleArgs += @('--target', $targetTriple) }

    # ── run this architecture's portable build ──────────────────────────────
    if ($Target -ne 'Single') {
        Write-Host "构建 $arch portable（含 Node.js/npm 与 WebView2，不含 DSH）……" -ForegroundColor Cyan
        $exitCode = 0
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
        if ($exitCode -ne 0) {
            Write-Host ''
            Write-Host "打包失败（$arch，退出码 $exitCode）。" -ForegroundColor Red
            exit $exitCode
        }
    }

    # ── collect this architecture's portable ZIP ────────────────────────────
    if ($Target -ne 'Single') {
        if (-not (Test-Path $exePath)) { throw "未找到构建产物：$exePath" }
        $portableStage = Join-Path $packRoot ('.portable-' + [guid]::NewGuid().ToString('N'))
        $archiveStage = Join-Path $packRoot ('.archive-' + [guid]::NewGuid().ToString('N') + '.zip')
        try {
            # Assemble and verify first; a failed run leaves the previous artifacts intact.
            New-Item -ItemType Directory -Path $portableStage -Force | Out-Null
            Copy-Item -Path $exePath -Destination $portableStage -Force
            # The exe loads plugins relative to its resource directory. Copy exactly the
            # installer resource map, so a portable folder works outside this checkout.
            $portableBase = [IO.Path]::GetFullPath($portableStage) + [IO.Path]::DirectorySeparatorChar
            $resourceMap = $conf.bundle.resources
            foreach ($resource in $resourceMap.PSObject.Properties) {
                $resourceSource = [IO.Path]::GetFullPath((Join-Path (Join-Path $root 'src-tauri') $resource.Name))
                $resourceTarget = [IO.Path]::GetFullPath((Join-Path $portableStage $resource.Value))
                if (-not $resourceTarget.StartsWith($portableBase, [StringComparison]::OrdinalIgnoreCase)) {
                    throw "Portable resource escapes output directory: $($resource.Value)"
                }
                New-Item -ItemType Directory -Path (Split-Path $resourceTarget -Parent) -Force | Out-Null
                Copy-Item -LiteralPath $resourceSource -Destination $resourceTarget -Force
            }
            # 两种产物都必须包含 Node.js/npm 与 WebView2，缺少时停止打包。
            if ([string]::IsNullOrEmpty($archRuntimeRoot)) {
                throw "$arch 的离线运行环境路径为空，拒绝生成不完整的 portable 包。"
            }
            if (-not (Test-Path -LiteralPath (Join-Path $archRuntimeRoot 'runtime.json'))) {
                throw "离线运行环境不完整（缺少 runtime.json）：$archRuntimeRoot"
            }
            $runtimeDestination = Join-Path $portableStage 'runtime'
            & robocopy.exe $archRuntimeRoot $runtimeDestination /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
            if ($LASTEXITCODE -ge 8) { throw "复制内置环境失败（robocopy $LASTEXITCODE）。" }
            & node $runtimeTool --verify $runtimeDestination
            if ($LASTEXITCODE -ne 0) { throw '复制后的运行环境校验失败，未替换现有产物。' }
            # 压缩前最后一道自检：载荷真的在暂存目录里。
            if (-not (Test-Path -LiteralPath (Join-Path $runtimeDestination 'runtime.json'))) {
                throw '暂存目录里没有 runtime\runtime.json，未替换现有产物。'
            }
            Write-Host "压缩 $arch portable 包……"
            & (Join-Path $env:SystemRoot 'System32\tar.exe') -a -cf $archiveStage -C $portableStage .
            if ($LASTEXITCODE -ne 0) { throw 'portable ZIP 压缩失败，未替换现有产物。' }
            # The unpacked folder is only a staging area now; the ZIP is the artifact.
            $archivePath = Publish-OutputFile $archiveStage $portableZipName '^dsh-desktop-v.+?-portable(-thin)?-win-(x64|x86)\.zip$'
            $collected += @{ Kind = '便携版 ZIP'; Path = $archivePath; Size = (Get-ArtifactSize $archivePath) }
        } finally {
            # A failed run must not leave GUID-named staging litter in the output;
            # a failing cleanup must not cost the run its remaining artifacts.
            Remove-StagingTree $portableStage
            Remove-StagingTree $archiveStage
        }
    }

    # ── generate this architecture's compact online installer ────────────────
    if (-not $SkipBundle -and $Target -ne 'Single') {
        # Only the application and plugins are embedded; the runtime manifest
        # provides pinned checksums for optional downloads on the user's machine.
        $installerPath = New-PortableInstaller -Arch $arch -Version $version -ProductName $productName `
            -Publisher $publisher -ExeName $exeName -AppExe $exePath -RuntimeManifest (Join-Path $archRuntimeRoot 'runtime.json')
        $collected += @{ Kind = '安装包    '; Path = $installerPath; Size = (Get-ArtifactSize $installerPath) }
    }

    # ── build and collect this architecture's single exe ────────────────────
    if ($Target -ne 'Portable') {
        Write-Host "构建 $arch single 单文件版（内置桌面插件，使用系统运行环境）……"
        $singleArgs = @('--no-bundle', '--features', 'single')
        if ($targetTriple) { $singleArgs += @('--target', $targetTriple) }
        try {
            Push-Location $root
            & node $tauriJs build @singleArgs
            if ($LASTEXITCODE -ne 0) { throw 'single 构建失败；已有分发产物已保留。' }
        } finally { Pop-Location }
        if (-not (Test-Path -LiteralPath $exePath)) { throw "未找到 single 构建产物：$exePath" }
        $singleStage = Join-Path $packRoot ('.single-' + [guid]::NewGuid().ToString('N') + '.exe')
        try {
            Copy-Item -LiteralPath $exePath -Destination $singleStage -Force
            # single omits the <type> segment; the lookaheads keep this pattern from
            # ever eating an installer/portable file even with a dashed version.
            $singlePath = Publish-OutputFile $singleStage $singleName '^dsh-desktop-v(?:(?!-installer)(?!-portable).)+-win-(x64|x86)\.exe$'
            $collected += @{ Kind = '单文件 exe'; Path = $singlePath; Size = (Get-ArtifactSize $singlePath) }
        } finally {
            Remove-StagingTree $singleStage
        }
    }
}

# ── report ──────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '  打包完成，产物已收集：' -ForegroundColor Green
if ($Target -ne 'Single') {
    Write-Host '  portable ZIP 包含 Node.js、npm、固定版 WebView2；所有分发包均不包含 DSH 及其依赖。'
    Write-Host '  启动时检测已有 DSH，缺少时通过 npm 联网安装；支持在应用内更新 DSH。'
    if ($archList -contains 'x86') {
        Write-Host '  x86 用 Node.js 22 与 x86 版 WebView2。' -ForegroundColor DarkGray
    }
    Write-Host '  PowerShell 7 和 Git 按目标电脑已有安装提供，不随包携带。'
    if (-not $SkipBundle) {
        Write-Host '  安装包使用 LZMA 压缩；检测到已有组件时取消勾选并禁用，缺失组件默认勾选、联网安装。'
    }
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
