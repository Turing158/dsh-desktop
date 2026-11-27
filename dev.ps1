#requires -Version 5.1
<#
.SYNOPSIS
    Start the dsh desktop development server, or use -Web for browser preview.

.EXAMPLE
    .\dev.ps1 -Check
    Check desktop prerequisites without starting the app.

.EXAMPLE
    .\dev.ps1 -Web -Port 1530
    Serve the dsh Web UI with the desktop plugins on a local port.

.EXAMPLE
    .\dev.ps1 -DataDir '.\.runtime\profile' -Jobs 2
    Start the desktop app with a separate dsh data directory.
#>
[CmdletBinding()]
param(
    [switch]$Web,
    [switch]$Check,
    [switch]$InstallDependencies,
    [string]$DataDir,
    [ValidateRange(1024, 65535)]
    [int]$Port = 1530,
    [ValidateRange(1, 64)]
    [int]$Jobs,
    [ValidateSet('Idle', 'BelowNormal', 'Normal')]
    [string]$Priority = 'BelowNormal',
    [switch]$Release,
    [switch]$NoWatch,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

function Get-AvailableDevelopmentPort {
    param([int]$PreferredPort)

    $lastPort = [Math]::Min(65535, $PreferredPort + 99)
    for ($candidate = $PreferredPort; $candidate -le $lastPort; $candidate++) {
        $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $candidate)
        try {
            $probe.Server.ExclusiveAddressUse = $true
            $probe.Start()
            if ($candidate -ne $PreferredPort) {
                Write-Host "端口 $PreferredPort 不可用，改用 $candidate。"
            }
            return $candidate
        } catch [Net.Sockets.SocketException] {
            if ($_.Exception.SocketErrorCode -notin @('AddressAlreadyInUse', 'AccessDenied')) {
                throw
            }
        } finally {
            $probe.Stop()
        }
    }
    throw "$PreferredPort 到 $lastPort 之间没有可用端口，请使用 -Port 指定其他端口。"
}

function Assert-DesktopPrerequisites {
    foreach ($command in @('cargo.exe', 'rustc.exe')) {
        if (-not (Get-Command $command -CommandType Application -ErrorAction SilentlyContinue)) {
            throw "缺少 $command，请安装 Rust MSVC 工具链。"
        }
    }
    $rustHost = & rustc.exe -vV | Where-Object { $_ -like 'host:*' }
    if ($LASTEXITCODE -ne 0 -or $rustHost -notmatch '^host: (i686|x86_64|aarch64)-pc-windows-msvc$') {
        throw '请使用 Rust Windows MSVC 工具链。'
    }
    $sdkArch = @{ i686 = 'x86'; x86_64 = 'x64'; aarch64 = 'arm64' }[$Matches[1]]
    $component = if ($sdkArch -eq 'arm64') { 'ARM64' } else { 'x86.x64' }
    $programFiles86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    $vswhere = Join-Path $programFiles86 'Microsoft Visual Studio\Installer\vswhere.exe'
    $sdkLib = Join-Path $programFiles86 "Windows Kits\10\Lib\*\um\$sdkArch\kernel32.lib"
    if (-not (Test-Path -LiteralPath $vswhere) -or
        -not (& $vswhere -latest -products '*' -requires "Microsoft.VisualStudio.Component.VC.Tools.$component" -property installationPath) -or
        -not (Test-Path -Path $sdkLib)) {
        throw "请安装 Visual Studio C++ 生成工具和 Windows 10/11 SDK（$sdkArch）。"
    }

    $webViewKey = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($hive in @('LocalMachine', 'CurrentUser')) {
        foreach ($view in @('Registry32', 'Registry64')) {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
            $key = $null
            try {
                $key = $base.OpenSubKey($webViewKey)
                $version = if ($key) { $key.GetValue('pv') }
                if ($version -and $version -ne '0.0.0.0') { return }
            } finally {
                if ($key) { $key.Dispose() }
                $base.Dispose()
            }
        }
    }
    throw '缺少 Microsoft Edge WebView2 Runtime，请先安装。'
}

function Get-WebRuntime {
    if ($env:DSH_DESKTOP_DSH) {
        $entry = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:DSH_DESKTOP_DSH)
        if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
            throw "DSH_DESKTOP_DSH 指定的入口不存在：$entry"
        }
        return $entry
    }

    $globalModules = & npm.cmd root -g
    $entryFile = '@deepseek-ai\dsh\lib\bin.js'
    if ($LASTEXITCODE -eq 0 -and $globalModules) {
        $entry = Join-Path $globalModules $entryFile
        if (Test-Path -LiteralPath $entry -PathType Leaf) { return $entry }
    }
    $entry = Join-Path $env:APPDATA "DeepseekHarness\runtime\node_modules\$entryFile"
    if (Test-Path -LiteralPath $entry -PathType Leaf) { return $entry }

    throw '浏览器预览需要 dsh。请安装 @deepseek-ai/dsh 或通过 DSH_DESKTOP_DSH 指定入口。'
}

$root = $PSScriptRoot
$previousOutputEncoding = [Console]::OutputEncoding
$previousDshHome = $env:DSH_HOME
$previousDshBin = $env:DSH_DESKTOP_DSH_BIN
$previousJobs = $env:CARGO_BUILD_JOBS
$previousCargoProgress = $env:CARGO_TERM_PROGRESS_WHEN
$originalPriority = $null
try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($command in @('node.exe', 'npm.cmd')) {
        if (-not (Get-Command $command -CommandType Application -ErrorAction SilentlyContinue)) {
            throw "缺少 $command，请安装 Node.js 22 或更新版本。"
        }
    }
    $nodeVersion = & node.exe --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
        throw '请安装 Node.js 22 或更新版本。'
    }

    if ($Web) {
        $dshBin = Get-WebRuntime
    } else {
        Assert-DesktopPrerequisites
    }
    if ($Check) {
        Write-Host '开发环境检查通过。'
        exit 0
    }

    if ($DataDir) {
        $env:DSH_HOME = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataDir)
    }
    Push-Location -LiteralPath $root
    try {
        & npm.cmd ls --depth=0 --silent *> $null
        $tauriCli = Join-Path $root 'node_modules\@tauri-apps\cli\tauri.js'
        if ($InstallDependencies -or $LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $tauriCli -PathType Leaf)) {
            Write-Host '正在安装开发依赖…'
            $installCommand = if ($InstallDependencies -and (Test-Path -LiteralPath 'package-lock.json')) { 'ci' } else { 'install' }
            & npm.cmd $installCommand --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw "npm $installCommand 失败，退出代码 $LASTEXITCODE。" }
        }

        if ($Web) {
            & node.exe tools/build-terminal.mjs
            if ($LASTEXITCODE -ne 0) { throw "前端资源构建失败，退出代码 $LASTEXITCODE。" }
        }

        $Port = Get-AvailableDevelopmentPort -PreferredPort $Port
        $dshHomeDisplay = if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) { '~/.dsh' } else { $env:DSH_HOME }
        Write-Host "预览端口 $Port（127.0.0.1）"
        Write-Host "dsh 数据目录 $dshHomeDisplay"
        if ($Web) {
            $env:DSH_DESKTOP_DSH_BIN = $dshBin
            $patch = Join-Path $root 'dsh-plugin\desktop-notify.patch.yml'
            & node.exe --max-http-header-size=1048576 $dshBin web --patch $patch --host 127.0.0.1 --port $Port --no-open
            exit $LASTEXITCODE
        }

        if (-not $PSBoundParameters.ContainsKey('Jobs')) {
            $Jobs = [Math]::Max(1, [Math]::Min(4, [Math]::Floor([Environment]::ProcessorCount / 4)))
        }
        $env:CARGO_BUILD_JOBS = [string]$Jobs
        if ($Quiet) { $env:CARGO_TERM_PROGRESS_WHEN = 'never' }
        if ($Priority -ne 'Normal') {
            try {
                $process = Get-Process -Id $PID
                $originalPriority = $process.PriorityClass
                $process.PriorityClass = [Diagnostics.ProcessPriorityClass]::$Priority
            } catch {
                Write-Warning "无法调整编译进程优先级：$($_.Exception.Message)"
            }
        }

        Write-Host "Cargo 编译并发 $Jobs"
        $tauriArgs = @($tauriCli, 'dev', '--port', [string]$Port)
        if ($Release) { $tauriArgs += '--release' }
        if ($NoWatch) { $tauriArgs += '--no-watch' }
        & node.exe @tauriArgs
        exit $LASTEXITCODE
    } finally {
        Pop-Location
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($null -ne $originalPriority) {
        try { (Get-Process -Id $PID).PriorityClass = $originalPriority } catch { }
    }
    $env:CARGO_TERM_PROGRESS_WHEN = $previousCargoProgress
    $env:CARGO_BUILD_JOBS = $previousJobs
    $env:DSH_DESKTOP_DSH_BIN = $previousDshBin
    if ($DataDir) { $env:DSH_HOME = $previousDshHome }
    [Console]::OutputEncoding = $previousOutputEncoding
}
