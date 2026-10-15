# Loaded by pack.ps1; uses its validated output paths and publishing helpers.
function Resolve-Makensis {
    foreach ($candidate in @(
            (Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe'),
            (Join-Path $env:ProgramFiles 'NSIS\makensis.exe'))) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    $command = Get-Command 'makensis.exe' -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw '找不到 makensis（NSIS 3.x），请安装 NSIS 或先执行一次 tauri 构建。'
}

function New-PortableInstaller {
    param(
        [Parameter(Mandatory)][string]$Arch,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$ProductName,
        [Parameter(Mandatory)][string]$Publisher,
        [Parameter(Mandatory)][string]$ExeName,
        [Parameter(Mandatory)][string]$AppExe,
        [Parameter(Mandatory)][string]$RuntimeManifest
    )
    $makensis = Resolve-Makensis
    $stage = Join-Path $packRoot ('.installer-' + [guid]::NewGuid().ToString('N'))
    try {
        $core = Join-Path $stage 'app'
        New-Item -ItemType Directory -Path $core -Force | Out-Null
        Copy-Item -LiteralPath $AppExe -Destination (Join-Path $core $ExeName)
        $manifest = @{}
        $manifest[$ExeName] = (Get-FileHash -LiteralPath $AppExe -Algorithm SHA256).Hash
        foreach ($resource in $conf.bundle.resources.PSObject.Properties) {
            $source = [IO.Path]::GetFullPath((Join-Path (Join-Path $root 'src-tauri') $resource.Name))
            $destination = [IO.Path]::GetFullPath((Join-Path $core $resource.Value))
            if (-not $destination.StartsWith($core + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '安装资源路径超出暂存目录' }
            New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
            Copy-Item -LiteralPath $source -Destination $destination
            $manifest[$resource.Value] = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
        }
        $appManifest = Join-Path $stage 'app-manifest.json'
        [IO.File]::WriteAllText($appManifest, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        $archive = Join-Path $stage 'app.tar'
        & (Join-Path $env:SystemRoot 'System32\tar.exe') -cf $archive -C $core .
        if ($LASTEXITCODE -ne 0) { throw '安装包应用资源归档失败' }

        $recipeName = if ($Arch -eq 'x64') { 'offline-runtime.json' } else { 'offline-runtime-x86.json' }
        $recipe = Get-Content -LiteralPath (Join-Path $root "tools\$recipeName") -Raw | ConvertFrom-Json
        $runtime = Get-Content -LiteralPath $RuntimeManifest -Raw | ConvertFrom-Json
        if ($runtime.arch -ne $Arch) { throw '安装组件架构与运行时清单不一致' }
        foreach ($name in @('node', 'webview2')) {
            $digest = $runtime.archives.$name.sha256
            if ($digest -notmatch '^[a-fA-F0-9]{64}$') { throw "缺少 $name 的下载校验摘要" }
            $recipe.assets.$name | Add-Member -MemberType NoteProperty -Name sha256 -Value $digest -Force
        }
        $recipeFile = Join-Path $stage 'runtime-recipe.json'
        [IO.File]::WriteAllText($recipeFile, ($recipe | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
        $outFile = Join-Path $stage 'installer.exe'
        $tokens = @{
            '@@PRODUCT_NAME@@' = $ProductName; '@@EXE_NAME@@' = $ExeName
            '@@INSTALL_DIR@@' = 'dsh-desktop'; '@@VERSION@@' = $Version
            '@@PUBLISHER@@' = $Publisher; '@@ARCH@@' = $Arch
            '@@REG_KEY@@' = 'Software\dsh-desktop'
            '@@UNINSTALL_KEY@@' = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\dsh-desktop'
            '@@ESTIMATED_KB@@' = [string][int]((Get-ChildItem -LiteralPath $core -File -Recurse | Measure-Object Length -Sum).Sum / 1KB)
            '@@APP_TAR@@' = $archive; '@@APP_MANIFEST@@' = $appManifest
            '@@RUNTIME_HELPER@@' = Join-Path $root 'tools\installer-runtime.ps1'
            '@@RUNTIME_RECIPE@@' = $recipeFile; '@@OUTFILE@@' = $outFile
        }
        $script = Get-Content -LiteralPath (Join-Path $root 'tools\installer.nsi') -Raw -Encoding UTF8
        foreach ($token in $tokens.Keys) { $script = $script.Replace($token, ([string]$tokens[$token]).Replace('$', '$$')) }
        if ($script -match '@@[A-Z_]+@@') { throw "安装脚本存在未替换的占位符：$($Matches[0])" }
        $scriptFile = Join-Path $stage 'installer.nsi'
        [IO.File]::WriteAllText($scriptFile, $script, (New-Object Text.UTF8Encoding($true)))
        Write-Host "生成 $Arch 精简安装包（LZMA 压缩，Node.js / WebView2 按需联网下载）……"
        & $makensis '/V2' $scriptFile
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outFile)) { throw 'NSIS 安装包构建失败；已保留原有产物。' }
        Publish-OutputFile $outFile "dsh-desktop-v$Version-installer-win-$Arch.exe" '^dsh-desktop-v.+?-installer-win-(x64|x86)\.exe$'
    } finally { Remove-StagingTree $stage }
}
