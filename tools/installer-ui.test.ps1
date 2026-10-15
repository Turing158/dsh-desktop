$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$base = Join-Path $project 'src-tauri\target'
$scratch = Join-Path $base ('installer-ui-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$compiler = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class InstallerWindow {
  public static IntPtr Desktop;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct StartupInfo {
    public int cb; public string reserved; public string desktop; public string title;
    public int x,y,w,h,xchars,ychars,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] public struct ProcessInfo { public IntPtr process,thread; public int pid,tid; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateDesktop(string name,IntPtr device,IntPtr mode,uint flags,uint access,IntPtr security);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetThreadDesktop(IntPtr desktop);
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public static IntPtr OriginalDesktop;
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string directory,ref StartupInfo info,out ProcessInfo process);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  public static int Start(string app,string destination,string desktopName) {
    Desktop=CreateDesktop(desktopName,IntPtr.Zero,IntPtr.Zero,0,0x10000000,IntPtr.Zero);
    if(Desktop==IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    OriginalDesktop=GetThreadDesktop(GetCurrentThreadId());
    if(!SetThreadDesktop(Desktop)) throw new System.ComponentModel.Win32Exception();
    var start=new StartupInfo { cb=Marshal.SizeOf(typeof(StartupInfo)),desktop="WinSta0\\"+desktopName };
    ProcessInfo process;
    if(!CreateProcess(app,new StringBuilder("\""+app+"\" /D="+destination),IntPtr.Zero,IntPtr.Zero,false,0,IntPtr.Zero,null,ref start,out process)) throw new System.ComponentModel.Win32Exception();
    CloseHandle(process.thread); CloseHandle(process.process); return process.pid;
  }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumDesktopWindows(IntPtr desktop,EnumProc f,IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc f, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", EntryPoint="SendMessageW", CharSet=CharSet.Unicode)] public static extern IntPtr ReadText(IntPtr h, uint m, IntPtr w, StringBuilder text);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int mode);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
  public static string Text(IntPtr h) { var s=new StringBuilder(2048); ReadText(h,0xd,new IntPtr(s.Capacity),s); return s.ToString(); }
  public static IntPtr FindMain(int pid) {
    IntPtr result=IntPtr.Zero;
    EnumDesktopWindows(Desktop,(h,p)=>{ uint id; GetWindowThreadProcessId(h,out id); if(id==pid && GetDlgItem(h,1)!=IntPtr.Zero) result=h; return true; },IntPtr.Zero);
    return result;
  }
  public static IntPtr Find(IntPtr parent,string prefix) {
    IntPtr result=IntPtr.Zero;
    EnumChildWindows(parent,(h,p)=>{ if(Text(h).StartsWith(prefix)) result=h; return true; },IntPtr.Zero);
    return result;
  }
  public static string Dump(IntPtr parent) {
    var texts=new List<string>();
    EnumChildWindows(parent,(h,p)=>{ var s=Text(h); if(s.Length>0) texts.Add(s); return true; },IntPtr.Zero);
    return string.Join(" | ",texts);
  }
  public static void Click(IntPtr window,int id) { PostMessage(window,0x111,new IntPtr(id),GetDlgItem(window,id)); }
  static IntPtr Wait(Func<IntPtr> read,string description) {
    var deadline=DateTime.UtcNow.AddSeconds(15);
    while(DateTime.UtcNow<deadline) { var value=read(); if(value!=IntPtr.Zero) return value; System.Threading.Thread.Sleep(100); }
    throw new Exception("Timed out: "+description);
  }
  public static void RunCase(string app,string destination,int node,int webview) {
    Exception failure=null;
    var worker=new System.Threading.Thread(()=>{
      System.Diagnostics.Process process=null;
      try {
        int id=Start(app,destination,"dsh-ui-test-"+Guid.NewGuid().ToString("N"));
        process=System.Diagnostics.Process.GetProcessById(id);
        var window=Wait(()=>FindMain(id),"window");
        Wait(()=>Find(window,"欢迎使用"),"welcome page");
        Click(window,1);
        Wait(()=>Find(window,destination),"directory page");
        Click(window,1);
        var nodeBox=Wait(()=>Find(window,"安装 Node.js"),"runtime page");
        var webviewBox=Find(window,"安装 Microsoft Edge WebView2");
        var boxes=new [] {nodeBox,webviewBox}; var detected=new [] {node,webview};
        for(int i=0;i<2;i++) {
          int check=SendMessage(boxes[i],0xf0,IntPtr.Zero,IntPtr.Zero).ToInt32();
          bool enabled=IsWindowEnabled(boxes[i]);
          if(check!=1-detected[i] || enabled!=(detected[i]==0)) throw new Exception("Wrong checkbox state: "+i+" checked="+check+" enabled="+enabled);
          if(enabled) SendMessage(boxes[i],0xf1,IntPtr.Zero,IntPtr.Zero);
        }
        Click(window,3);
        Wait(()=>Find(window,destination),"directory after Back");
        Click(window,1);
        nodeBox=Wait(()=>Find(window,"安装 Node.js"),"runtime after Back");
        webviewBox=Find(window,"安装 Microsoft Edge WebView2");
        foreach(var box in new [] {nodeBox,webviewBox}) if(SendMessage(box,0xf0,IntPtr.Zero,IntPtr.Zero).ToInt32()!=0) throw new Exception("Back reset checkbox selection");
      } catch(Exception error) { failure=error; }
      finally {
        if(process!=null) { if(!process.HasExited) { process.Kill(); process.WaitForExit(); } process.Dispose(); }
        if(OriginalDesktop!=IntPtr.Zero) SetThreadDesktop(OriginalDesktop);
        if(Desktop!=IntPtr.Zero) CloseDesktop(Desktop);
      }
    });
    worker.IsBackground=true; worker.Start();
    if(!worker.Join(45000)) throw new Exception("UI worker timed out");
    if(failure!=null) throw failure;
  }
}
'@

function Wait-For([scriptblock]$Read, [string]$Description) {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $value = & $Read
        if ($value -and $value -ne [IntPtr]::Zero) { return $value }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($window) { Write-Host ([InstallerWindow]::Dump($window)) }
    throw "Timed out: $Description"
}

$helper = @'
param([string]$Action, [string]$InstallDir, [string]$StateFile, [string]$Architecture, [int]$NodeSelected, [int]$WebViewSelected)
if ($Action -eq 'Probe') {
  $text = "[Node]`r`nAvailable=NODE_AVAILABLE`r`nVersion=v24.0.0`r`nPath=`r`n[WebView]`r`nAvailable=WEBVIEW_AVAILABLE`r`nVersion=154.0.0.0`r`nPath=`r`n"
  [IO.File]::WriteAllText($StateFile,$text,[Text.Encoding]::Unicode)
}
exit 0
'@
$process = $null
try {
    $core = Join-Path $scratch 'core'
    New-Item -ItemType Directory -Path $core | Out-Null
    [IO.File]::WriteAllText((Join-Path $core 'fixture.txt'), 'UI test, never installed')
    $archive = Join-Path $scratch 'app.tar'
    & "$env:SystemRoot\System32\tar.exe" -cf $archive -C $core .
    [IO.File]::WriteAllText((Join-Path $scratch 'recipe.json'), '{}')
    [IO.File]::WriteAllText((Join-Path $scratch 'manifest.json'), '{}')
    foreach ($case in @(@(0,0), @(1,0), @(0,1), @(1,1))) {
        Write-Output "Checking Node=$($case[0]) WebView2=$($case[1])"
        $helperFile = Join-Path $scratch 'runtime.ps1'
        [IO.File]::WriteAllText($helperFile, $helper.Replace('NODE_AVAILABLE',[string]$case[0]).Replace('WEBVIEW_AVAILABLE',[string]$case[1]), (New-Object Text.UTF8Encoding($true)))
        $output = Join-Path $scratch "case-$($case[0])-$($case[1]).exe"
        $tokens = @{
            '@@PRODUCT_NAME@@'='Installer UI test'; '@@EXE_NAME@@'='fixture.exe'
            '@@UNINSTALL_KEY@@'='Software\DSH-Installer-UI-Test\Uninstall'; '@@REG_KEY@@'='Software\DSH-Installer-UI-Test'
            '@@INSTALL_DIR@@'='DSH-Installer-UI-Test'; '@@VERSION@@'='0.0.0'; '@@PUBLISHER@@'='Test'; '@@ARCH@@'='x64'
            '@@OUTFILE@@'=$output; '@@RUNTIME_HELPER@@'=$helperFile; '@@RUNTIME_RECIPE@@'=(Join-Path $scratch 'recipe.json')
            '@@APP_MANIFEST@@'=(Join-Path $scratch 'manifest.json'); '@@APP_TAR@@'=$archive; '@@ESTIMATED_KB@@'='1'
        }
        $script = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'installer.nsi') -Raw -Encoding UTF8
        foreach ($token in $tokens.Keys) { $script = $script.Replace($token, ([string]$tokens[$token]).Replace('$','$$')) }
        $scriptFile = Join-Path $scratch 'test.nsi'
        [IO.File]::WriteAllText($scriptFile,$script,(New-Object Text.UTF8Encoding($true)))
        & $compiler '/V1' $scriptFile
        if ($LASTEXITCODE -ne 0) { throw 'Fixture installer compilation failed' }
        [InstallerWindow]::RunCase($output,(Join-Path $scratch 'destination'),$case[0],$case[1])
        Write-Output "PASS actual installer controls: Node=$($case[0]) WebView2=$($case[1])"
    }
} finally {
    if ($process) { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }; $process.Dispose() }
    $full = [IO.Path]::GetFullPath($scratch)
    if (-not $full.StartsWith([IO.Path]::GetFullPath($base) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path' }
    Remove-Item -LiteralPath $full -Recurse -Force
}
