param(
    [ValidateSet('Probe', 'VerifyApp', 'InstallNode', 'InstallWebView', 'SaveConfig')][string]$Action = 'Probe',
    [string]$InstallDir,
    [string]$StateFile,
    [ValidateSet('x64', 'x86')][string]$Architecture = 'x64',
    [string]$RecipeFile = (Join-Path $PSScriptRoot 'runtime-recipe.json'),
    [ValidateSet(0, 1)][int]$NodeSelected = 0,
    [ValidateSet(0, 1)][int]$WebViewSelected = 0
)

$ErrorActionPreference = 'Stop'

function Get-Sha256([string]$File) {
    # The installer may inherit PSModulePath from PowerShell 7. Do not rely on
    # autoloading Windows PowerShell's Get-FileHash script module.
    $stream = [IO.File]::OpenRead((Get-LongPath ([IO.Path]::GetFullPath($File))))
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose(); $hash.Dispose() }
}

function Quote-NativeArgument([string]$Value) {
    '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Invoke-Program([string]$File, [string[]]$Arguments, [int]$TimeoutSeconds = 15) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $File
    $info.Arguments = ($Arguments | ForEach-Object { Quote-NativeArgument $_ }) -join ' '
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables.Remove('NODE_OPTIONS')
    $info.EnvironmentVariables.Remove('NODE_PATH')
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            throw "操作超时：$File"
        }
        $output = $stdout.GetAwaiter().GetResult().Trim()
        $errorText = $stderr.GetAwaiter().GetResult().Trim()
        if ($process.ExitCode -ne 0) { throw "$File 退出码 $($process.ExitCode)：$errorText" }
        return $output
    } finally { $process.Dispose() }
}

function Get-RegistryValues([string]$Key, [string[]]$Names) {
    foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
        foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
            $base = $null
            $entry = $null
            try {
                $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
                $entry = $base.OpenSubKey($Key)
                if ($entry) {
                    $values = @{}
                    foreach ($name in $Names) { $values[$name] = $entry.GetValue($name) }
                    [pscustomobject]$values
                }
            } catch { } finally {
                if ($entry) { $entry.Dispose() }
                if ($base) { $base.Dispose() }
            }
        }
    }
}

function Get-NodeCandidates([string]$Directory) {
    if ($env:DSH_DESKTOP_NODE) { $env:DSH_DESKTOP_NODE }
    Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }
    Get-RegistryValues 'SOFTWARE\Node.js' @('InstallPath') | ForEach-Object {
        if ($_.InstallPath) { Join-Path $_.InstallPath 'node.exe' }
    }
    foreach ($base in @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($base) { Join-Path $base 'nodejs\node.exe' }
    }
    if ($Directory) {
        $saved = Join-Path $Directory 'runtime\installed.json'
        if (Test-Path -LiteralPath $saved) {
            try {
                $config = Get-Content -LiteralPath $saved -Raw | ConvertFrom-Json
                if ($config.nodePath) { [string]$config.nodePath }
            } catch { }
        }
        Join-Path $Directory 'runtime\node\node.exe'
    }
}

function Find-CompatibleNode([string[]]$Candidates) {
    foreach ($candidate in @($Candidates | Select-Object -Unique)) {
        if (-not $candidate -or $candidate -match '[\r\n]' -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        try {
            $version = Invoke-Program $candidate @('--version') 5
            if ($version -notmatch '^v(\d+)\.\d+\.\d+$' -or [int]$Matches[1] -lt 22) { continue }
            $directory = Split-Path $candidate -Parent
            foreach ($cli in @((Join-Path $directory 'node_modules\npm\bin\npm-cli.js'), (Join-Path $directory '..\npm\node_modules\npm\bin\npm-cli.js'))) {
                if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { continue }
                $npmVersion = Invoke-Program $candidate @($cli, '--version') 5
                if ($npmVersion -notmatch '^\d+\.\d+\.\d+') { continue }
                return [pscustomobject]@{ Available = $true; Version = $version; Path = [IO.Path]::GetFullPath($candidate) }
            }
        } catch { }
    }
    [pscustomobject]@{ Available = $false; Version = ''; Path = '' }
}

function Test-WebViewFiles([string]$Directory) {
    if (-not $Directory) { return $false }
    foreach ($file in @('msedgewebview2.exe', 'msedge.dll', 'icudtl.dat')) {
        if (-not (Test-Path -LiteralPath (Get-LongPath ([IO.Path]::GetFullPath((Join-Path $Directory $file)))) -PathType Leaf)) { return $false }
    }
    return $true
}

function Get-PeArchitecture([string]$File) {
    $reader = New-Object IO.BinaryReader([IO.File]::OpenRead((Get-LongPath ([IO.Path]::GetFullPath($File)))))
    try {
        if ($reader.ReadUInt16() -ne 0x5a4d) { return '' }
        $reader.BaseStream.Position = 0x3c
        $offset = $reader.ReadInt32()
        if ($offset -lt 64 -or $offset -gt $reader.BaseStream.Length - 6) { return '' }
        $reader.BaseStream.Position = $offset
        if ($reader.ReadUInt32() -ne 0x4550) { return '' }
        switch ($reader.ReadUInt16()) { 0x8664 { 'x64' }; 0x14c { 'x86' } }
    } finally { $reader.Dispose() }
}

function Find-WebViewRuntime([string]$Directory) {
    # The WebView2 Runtime product id is distinct from ordinary Edge.
    $entries = Get-RegistryValues 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' @('pv', 'location')
    foreach ($entry in $entries) {
        if ($entry.pv -notmatch '^\d+\.\d+\.\d+\.\d+$' -or [version]$entry.pv -le [version]'0.0.0.0') { continue }
        $locations = @($entry.location)
        foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
            if ($base) { $locations += Join-Path $base 'Microsoft\EdgeWebView\Application' }
        }
        foreach ($location in $locations) {
            if ($location -and (Test-WebViewFiles (Join-Path $location $entry.pv))) {
                return [pscustomobject]@{ Available = $true; Version = [string]$entry.pv; Path = '' }
            }
        }
    }
    if ($Directory) {
        $fixed = Join-Path $Directory 'runtime\webview2'
        if ((Test-WebViewFiles $fixed) -and (Get-PeArchitecture (Join-Path $fixed 'msedgewebview2.exe')) -eq $Architecture) {
            $version = (Get-Item -LiteralPath (Join-Path $fixed 'msedgewebview2.exe')).VersionInfo.FileVersion
            if ($version) { return [pscustomobject]@{ Available = $true; Version = $version; Path = $fixed } }
        }
    }
    [pscustomobject]@{ Available = $false; Version = ''; Path = '' }
}

function Get-RuntimeState([string]$Directory) {
    [pscustomobject]@{
        Node = Find-CompatibleNode @(Get-NodeCandidates $Directory)
        WebView = Find-WebViewRuntime $Directory
    }
}

function Write-ProbeState($State, [string]$File) {
    $lines = foreach ($name in @('Node', 'WebView')) {
        "[$name]"
        "Available=$([int]$State.$name.Available)"
        "Version=$($State.$name.Version)"
        "Path=$($State.$name.Path)"
    }
    # Unicode INI is read directly by NSIS's ReadINIStr, including non-ASCII paths.
    [IO.File]::WriteAllText($File, ($lines -join "`r`n") + "`r`n", [Text.Encoding]::Unicode)
}

function Resolve-ChildPath([string]$Base, [string]$Path) {
    $basePath = [IO.Path]::GetFullPath($Base).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($basePath, [StringComparison]::OrdinalIgnoreCase)) { throw "路径超出工作目录：$full" }
    return $full
}

function Get-LongPath([string]$Path) {
    if ($Path.StartsWith('\\?\')) { return $Path }
    if ($Path.StartsWith('\\')) { return '\\?\UNC\' + $Path.Substring(2) }
    return '\\?\' + $Path
}

function Remove-WorkTree([string]$Base, [string]$Path) {
    $full = Resolve-ChildPath $Base $Path
    if (Test-Path -LiteralPath (Get-LongPath $full)) { Remove-Item -LiteralPath (Get-LongPath $full) -Recurse -Force }
}

function Install-Component([string]$Name, [string]$Directory, $Recipe) {
    $asset = $Recipe.assets.$Name
    if (-not $asset.sha256 -or $asset.url -notmatch '^https://') { throw "缺少 $Name 的安全下载配置" }
    $runtime = Join-Path ([IO.Path]::GetFullPath($Directory)) 'runtime'
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    $stage = Join-Path $runtime ('.install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
        $archive = Join-Path $stage ([IO.Path]::GetFileName(([uri]$asset.url).AbsolutePath))
        Write-Output "正在下载 $Name $($asset.version)……"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -UseBasicParsing -Uri $asset.url -OutFile $archive -TimeoutSec 1200
        if ((Get-Sha256 $archive) -ne $asset.sha256) { throw "$Name 下载校验失败，请重试" }
        $expanded = Join-Path $stage 'expanded'
        New-Item -ItemType Directory -Path $expanded | Out-Null
        Write-Output "正在解压 $Name……"
        if ($Name -eq 'node') {
            $null = Invoke-Program (Join-Path $env:SystemRoot 'System32\tar.exe') @('-xf', $archive, '-C', $expanded) 300
        } else {
            $null = Invoke-Program (Join-Path $env:SystemRoot 'System32\expand.exe') @('-F:*', $archive, $expanded) 300
        }
        $entries = @(Get-ChildItem -LiteralPath $expanded -Force)
        $source = if ($entries.Count -eq 1 -and $entries[0].PSIsContainer) { $entries[0].FullName } else { $expanded }
        if ($Name -eq 'node') {
            [IO.File]::WriteAllText((Join-Path $source 'node_modules\npm\npmrc'), 'prefix=${APPDATA}/npm' + "`n", (New-Object Text.UTF8Encoding($false)))
            $node = Find-CompatibleNode @((Join-Path $source 'node.exe'))
            if (-not $node.Available -or $node.Version -ne "v$($asset.version)") { throw 'Node.js/npm 解压校验失败' }
        } elseif (-not (Test-WebViewFiles $source)) { throw 'WebView2 解压校验失败' }
        $destination = Resolve-ChildPath $runtime (Join-Path $runtime $Name)
        $backup = Resolve-ChildPath $runtime (Join-Path $runtime ('.previous-' + [guid]::NewGuid().ToString('N')))
        if (Test-Path -LiteralPath $destination) { Move-Item -LiteralPath (Get-LongPath $destination) -Destination (Get-LongPath $backup) }
        try { Move-Item -LiteralPath (Get-LongPath $source) -Destination (Get-LongPath $destination) }
        catch {
            if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath (Get-LongPath $backup) -Destination (Get-LongPath $destination) }
            throw
        }
        Remove-WorkTree $runtime $backup
        Write-Output "$Name 安装完成。"
    } finally { Remove-WorkTree $runtime $stage }
}

function Invoke-InstallerAction {
    if (-not $InstallDir) { throw '缺少安装目录' }
    if ($Action -eq 'VerifyApp') {
        $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'app-manifest.json') -Raw | ConvertFrom-Json
        foreach ($file in $manifest.PSObject.Properties) {
            $path = Resolve-ChildPath $InstallDir (Join-Path $InstallDir $file.Name)
            if ((Get-Sha256 $path) -ne $file.Value) { throw "应用文件校验失败：$($file.Name)" }
        }
        return
    }
    $state = Get-RuntimeState $InstallDir
    switch ($Action) {
        'Probe' { Write-ProbeState $state $StateFile }
        'InstallNode' {
            if (-not $state.Node.Available) { Install-Component 'node' $InstallDir (Get-Content -LiteralPath $RecipeFile -Raw | ConvertFrom-Json) }
        }
        'InstallWebView' {
            if (-not $state.WebView.Available) { Install-Component 'webview2' $InstallDir (Get-Content -LiteralPath $RecipeFile -Raw | ConvertFrom-Json) }
        }
        'SaveConfig' {
            if ($NodeSelected -and -not $state.Node.Available) { throw '所选 Node.js/npm 未安装成功' }
            if ($WebViewSelected -and -not $state.WebView.Available) { throw '所选 WebView2 未安装成功' }
            $runtime = Join-Path $InstallDir 'runtime'
            New-Item -ItemType Directory -Path $runtime -Force | Out-Null
            $config = @{ schema = 1; nodePath = $state.Node.Path; webview2Path = $state.WebView.Path }
            [IO.File]::WriteAllText((Join-Path $runtime 'installed.json'), ($config | ConvertTo-Json) + "`n", (New-Object Text.UTF8Encoding($false)))
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-InstallerAction; exit 0 }
    catch { Write-Output $_.Exception.Message; exit 1 }
}
