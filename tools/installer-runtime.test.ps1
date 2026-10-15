$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'installer-runtime.ps1')
$project = Split-Path $PSScriptRoot -Parent
$testBase = Join-Path $project 'src-tauri\target'
$testRoot = Join-Path $testBase ('installer-runtime-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
function Assert-True($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-Fails([scriptblock]$Operation, [string]$Message) {
    $failed = $false
    try { & $Operation | Out-Null } catch { $failed = $true }
    Assert-True $failed $Message
}

try {
    & {
        function Invoke-Program([string]$File, [string[]]$Arguments) {
            if ($Arguments.Count -gt 1) { return '11.19.0' }
            if ($File -like '*old*') { return 'v20.0.0' }
            return 'v24.21.0'
        }
        $old = Join-Path $testRoot 'old\node.exe'
        $valid = Join-Path $testRoot 'valid\node.exe'
        foreach ($path in @($old, $valid)) {
            New-Item -ItemType Directory -Path (Split-Path $path -Parent) -Force | Out-Null
            [IO.File]::WriteAllText($path, 'fixture')
        }
        Assert-True (-not (Find-CompatibleNode @()).Available) 'An absent Node must remain selectable'
        Assert-True (-not (Find-CompatibleNode @($old)).Available) 'Old Node must not suppress installation'
        Assert-True (-not (Find-CompatibleNode @($valid)).Available) 'Node without npm is not a complete runtime'
        $npm = Join-Path $testRoot 'valid\node_modules\npm\bin\npm-cli.js'
        New-Item -ItemType Directory -Path (Split-Path $npm -Parent) -Force | Out-Null
        [IO.File]::WriteAllText($npm, 'fixture')
        Assert-True ((Find-CompatibleNode @($old, $valid)).Path -eq $valid) 'Compatible Node plus npm must be detected after an obsolete candidate'
    }
    & {
        $location = Join-Path $testRoot 'registered-webview'
        $versionDir = Join-Path $location '154.0.0.0'
        New-Item -ItemType Directory -Path $versionDir -Force | Out-Null
        foreach ($name in @('msedgewebview2.exe', 'msedge.dll', 'icudtl.dat')) { [IO.File]::WriteAllText((Join-Path $versionDir $name), 'fixture') }
        function Get-RegistryValues { [pscustomobject]@{ pv = '154.0.0.0'; location = $location } }
        Assert-True (Find-WebViewRuntime '').Available 'A registered, complete WebView2 must be detected'
        Remove-Item -LiteralPath (Join-Path $versionDir 'msedge.dll')
        Assert-True (-not (Find-WebViewRuntime '').Available) 'Stale WebView2 registry entries must not disable installation'
        function Get-RegistryValues { [pscustomobject]@{ pv = '0.0.0.0'; location = $location } }
        Assert-True (-not (Find-WebViewRuntime '').Available) 'An uninstalled WebView2 registration must be ignored'
    }
    & {
        $InstallDir = Join-Path $testRoot 'selection'
        $Action = 'SaveConfig'
        $NodeSelected = 0
        $WebViewSelected = 0
        function Get-RuntimeState {
            [pscustomobject]@{ Node = [pscustomobject]@{ Available = $false; Path = '' }; WebView = [pscustomobject]@{ Available = $false; Path = '' } }
        }
        Invoke-InstallerAction
        $saved = Get-Content -LiteralPath (Join-Path $InstallDir 'runtime\installed.json') -Raw | ConvertFrom-Json
        Assert-True ($saved.nodePath -eq '' -and $saved.webview2Path -eq '') 'Unchecking both components must persist system fallback'
        $NodeSelected = 1
        Assert-Fails { Invoke-InstallerAction } 'A selected component cannot be recorded as installed after a failed install'
    }
    Write-Output 'PASS runtime detection and optional-component configuration'

    & {
        # Use the already downloaded, verified archives; no system installation or network.
        function Invoke-WebRequest {
            param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile, [int]$TimeoutSec)
            $cached = Join-Path $project ('src-tauri\target\offline-runtime\downloads\' + [IO.Path]::GetFileName(([uri]$Uri).AbsolutePath))
            Copy-Item -LiteralPath $cached -Destination $OutFile
        }
        $runtime = Get-Content -LiteralPath (Join-Path $project 'src-tauri\target\offline-runtime-x64-result.json') -Raw | ConvertFrom-Json
        $manifest = Get-Content -LiteralPath (Join-Path $runtime.root 'runtime.json') -Raw | ConvertFrom-Json
        $recipe = Get-Content -LiteralPath (Join-Path $project 'tools\offline-runtime.json') -Raw | ConvertFrom-Json
        foreach ($name in @('node', 'webview2')) { $recipe.assets.$name | Add-Member -Name sha256 -MemberType NoteProperty -Value $manifest.archives.$name.sha256 -Force }
        $destination = Join-Path $testRoot 'installed app 空格'
        Install-Component 'node' $destination $recipe
        $node = Join-Path $destination 'runtime\node\node.exe'
        Assert-True (Find-CompatibleNode @($node)).Available 'Installed Node/npm must execute from paths containing spaces and Unicode'
        Assert-True ((Get-PeArchitecture $node) -eq 'x64') 'The Node archive must have the intended architecture'
        $recipe.assets.node.sha256 = '0' * 64
        Assert-Fails { Install-Component 'node' $destination $recipe } 'A corrupt download must be rejected'
        Assert-True (Find-CompatibleNode @($node)).Available 'A failed update must preserve the previous working Node'
        Install-Component 'webview2' $destination $recipe
        Assert-True (Test-WebViewFiles (Join-Path $destination 'runtime\webview2')) 'WebView2 must be complete after extraction'
        Assert-True ((Get-PeArchitecture (Join-Path $destination 'runtime\webview2\msedgewebview2.exe')) -eq 'x64') 'The WebView2 archive must have the intended architecture'
        Write-Output 'PASS verified component extraction, Unicode paths, architecture, and failed-download preservation'
    }
} finally { Remove-WorkTree $testBase $testRoot }
