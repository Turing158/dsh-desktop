!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!define PRODUCT_NAME "@@PRODUCT_NAME@@"
!define EXE_NAME "@@EXE_NAME@@"
!define UNINSTALL_KEY "@@UNINSTALL_KEY@@"

Name "@@PRODUCT_NAME@@"
OutFile "@@OUTFILE@@"
InstallDir "$LOCALAPPDATA\@@INSTALL_DIR@@"
InstallDirRegKey HKCU "@@REG_KEY@@" "InstallDir"
RequestExecutionLevel user
Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 32
SetDatablockOptimize on
ShowInstDetails show
ShowUninstDetails show

ReserveFile "@@RUNTIME_HELPER@@"
ReserveFile "@@RUNTIME_RECIPE@@"
ReserveFile "@@APP_MANIFEST@@"
!insertmacro MUI_RESERVEFILE_LANGDLL

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\@@EXE_NAME@@"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!define MUI_FINISHPAGE_RUN_TEXT "运行 @@PRODUCT_NAME@@"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom RuntimePageCreate RuntimePageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Var NativeSystem
Var PowerShell
Var RuntimePage
Var NodeCheckbox
Var WebViewCheckbox
Var NodeSelected
Var WebViewSelected
Var NodeAvailable
Var WebViewAvailable
Var NodeVersion
Var WebViewVersion
Var LastDirectory
Var Result

Function .onInit
  StrCpy $NativeSystem "$SYSDIR"
  ${If} ${RunningX64}
    StrCpy $NativeSystem "$WINDIR\Sysnative"
  ${Else}
    StrCmp "@@ARCH@@" "x64" 0 +3
      MessageBox MB_ICONSTOP|MB_OK "此安装包需要 64 位 Windows，请使用 x86 安装包。"
      Abort
  ${EndIf}
  StrCpy $PowerShell "$NativeSystem\WindowsPowerShell\v1.0\powershell.exe"
  StrCpy $NodeSelected 1
  StrCpy $WebViewSelected 1
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=installer-runtime.ps1" "@@RUNTIME_HELPER@@"
  File "/oname=runtime-recipe.json" "@@RUNTIME_RECIPE@@"
  File "/oname=app-manifest.json" "@@APP_MANIFEST@@"
FunctionEnd

Function ProbeRuntime
  nsExec::ExecToLog '"$PowerShell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-runtime.ps1" -Action Probe -InstallDir "$INSTDIR" -StateFile "$PLUGINSDIR\runtime-state.ini" -Architecture "@@ARCH@@"'
  Pop $Result
  ${If} $Result != 0
    SetErrorLevel 1
    IfSilent +2
      MessageBox MB_ICONSTOP|MB_OK "无法检测运行环境，请确认 Windows PowerShell 可用后重试。"
    Abort
  ${EndIf}
  ReadINIStr $NodeAvailable "$PLUGINSDIR\runtime-state.ini" "Node" "Available"
  ReadINIStr $NodeVersion "$PLUGINSDIR\runtime-state.ini" "Node" "Version"
  ReadINIStr $WebViewAvailable "$PLUGINSDIR\runtime-state.ini" "WebView" "Available"
  ReadINIStr $WebViewVersion "$PLUGINSDIR\runtime-state.ini" "WebView" "Version"
  ${If} $NodeAvailable == 1
    StrCpy $NodeSelected 0
  ${EndIf}
  ${If} $WebViewAvailable == 1
    StrCpy $WebViewSelected 0
  ${EndIf}
FunctionEnd

Function RuntimePageCreate
  !insertmacro MUI_HEADER_TEXT "选择运行环境" "检测已有环境，仅下载并安装勾选的缺失组件。"
  ${If} $LastDirectory != $INSTDIR
    StrCpy $NodeSelected 1
    StrCpy $WebViewSelected 1
    StrCpy $LastDirectory $INSTDIR
  ${EndIf}
  Call ProbeRuntime
  nsDialogs::Create 1018
  Pop $RuntimePage
  ${If} $RuntimePage == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 8u 100% 14u "安装 Node.js（含 npm，需要 22 或更高版本）"
  Pop $NodeCheckbox
  ${NSD_SetState} $NodeCheckbox $NodeSelected
  ${If} $NodeAvailable == 1
    EnableWindow $NodeCheckbox 0
    ${NSD_CreateLabel} 12u 27u 95% 20u "已检测到 Node.js $NodeVersion 和 npm，无需重复安装。"
  ${Else}
    ${NSD_CreateLabel} 12u 27u 95% 20u "未检测到可用的 Node.js/npm，勾选后联网下载安装。"
  ${EndIf}
  Pop $0
  ${NSD_CreateCheckbox} 0 61u 100% 14u "安装 Microsoft Edge WebView2 Runtime"
  Pop $WebViewCheckbox
  ${NSD_SetState} $WebViewCheckbox $WebViewSelected
  ${If} $WebViewAvailable == 1
    EnableWindow $WebViewCheckbox 0
    ${NSD_CreateLabel} 12u 80u 95% 20u "已检测到 WebView2 $WebViewVersion，无需重复安装。"
  ${Else}
    ${NSD_CreateLabel} 12u 80u 95% 20u "未检测到 WebView2 Runtime，勾选后联网下载安装。"
  ${EndIf}
  Pop $0
  ${NSD_CreateLabel} 0 117u 100% 32u "新增组件仅供此应用使用。若取消勾选缺失组件，请自行安装后再启动应用。dsh 将在首次启动时按需安装。"
  Pop $0
  GetFunctionAddress $0 RuntimePageLeave
  nsDialogs::OnBack $0
  nsDialogs::Show
FunctionEnd

Function RuntimePageLeave
  ${NSD_GetState} $NodeCheckbox $NodeSelected
  ${NSD_GetState} $WebViewCheckbox $WebViewSelected
FunctionEnd

Section "@@PRODUCT_NAME@@"
  IfSilent 0 +2
    Call ProbeRuntime
  IfFileExists "$INSTDIR\@@EXE_NAME@@" 0 AppStopped
  ClearErrors
  FileOpen $0 "$INSTDIR\@@EXE_NAME@@" a
  IfErrors ExeInUse
  FileClose $0
  Goto AppStopped
ExeInUse:
  SetErrorLevel 1
  IfSilent +2
    MessageBox MB_ICONEXCLAMATION|MB_OK "@@PRODUCT_NAME@@ 正在运行，请先退出它，然后重新安装。"
  Abort
AppStopped:
  IfFileExists "$NativeSystem\tar.exe" 0 InstallationFailed
  CreateDirectory "$INSTDIR"
  SetOutPath "$PLUGINSDIR"
  File "/oname=app.tar" "@@APP_TAR@@"
  DetailPrint "正在安装 @@PRODUCT_NAME@@……"
  nsExec::ExecToLog '"$NativeSystem\tar.exe" -xf "$PLUGINSDIR\app.tar" -C "$INSTDIR"'
  Pop $Result
  StrCmp $Result "0" 0 InstallationFailed
  nsExec::ExecToLog '"$PowerShell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-runtime.ps1" -Action VerifyApp -InstallDir "$INSTDIR"'
  Pop $Result
  StrCmp $Result "0" 0 InstallationFailed

  ${If} $NodeSelected == 1
    DetailPrint "正在下载并安装 Node.js/npm……"
    nsExec::ExecToLog '"$PowerShell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-runtime.ps1" -Action InstallNode -InstallDir "$INSTDIR" -Architecture "@@ARCH@@"'
    Pop $Result
    StrCmp $Result "0" 0 InstallationFailed
  ${EndIf}
  ${If} $WebViewSelected == 1
    DetailPrint "正在下载并安装 WebView2 Runtime……"
    nsExec::ExecToLog '"$PowerShell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-runtime.ps1" -Action InstallWebView -InstallDir "$INSTDIR" -Architecture "@@ARCH@@"'
    Pop $Result
    StrCmp $Result "0" 0 InstallationFailed
  ${EndIf}
  nsExec::ExecToLog '"$PowerShell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-runtime.ps1" -Action SaveConfig -InstallDir "$INSTDIR" -Architecture "@@ARCH@@" -NodeSelected $NodeSelected -WebViewSelected $WebViewSelected'
  Pop $Result
  StrCmp $Result "0" 0 InstallationFailed
  SetOutPath "$INSTDIR"
  CreateDirectory "$SMPROGRAMS\@@PRODUCT_NAME@@"
  CreateShortCut "$SMPROGRAMS\@@PRODUCT_NAME@@\@@PRODUCT_NAME@@.lnk" "$INSTDIR\@@EXE_NAME@@" "" "$INSTDIR\@@EXE_NAME@@" 0
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "@@REG_KEY@@" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "@@UNINSTALL_KEY@@" "DisplayName" "@@PRODUCT_NAME@@"
  WriteRegStr HKCU "@@UNINSTALL_KEY@@" "DisplayVersion" "@@VERSION@@"
  WriteRegStr HKCU "@@UNINSTALL_KEY@@" "Publisher" "@@PUBLISHER@@"
  WriteRegStr HKCU "@@UNINSTALL_KEY@@" "DisplayIcon" "$INSTDIR\@@EXE_NAME@@"
  WriteRegStr HKCU "@@UNINSTALL_KEY@@" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "@@UNINSTALL_KEY@@" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "@@UNINSTALL_KEY@@" "NoModify" 1
  WriteRegDWORD HKCU "@@UNINSTALL_KEY@@" "NoRepair" 1
  WriteRegDWORD HKCU "@@UNINSTALL_KEY@@" "EstimatedSize" @@ESTIMATED_KB@@
  Goto InstallationDone
InstallationFailed:
  SetErrorLevel 1
  IfSilent +2
    MessageBox MB_ICONSTOP|MB_OK "安装未完成。请查看详细输出，确认网络连接、磁盘空间及运行环境后重试。"
  Abort
InstallationDone:
SectionEnd

Section "Uninstall"
  StrCpy $NativeSystem "$SYSDIR"
  ${If} ${RunningX64}
    StrCpy $NativeSystem "$WINDIR\Sysnative"
  ${EndIf}
  SetOutPath "$TEMP"
  Delete "$INSTDIR\uninstall.exe"
  nsExec::ExecToLog '"$NativeSystem\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Remove-Item -LiteralPath $\"\\?\$INSTDIR$\" -Recurse -Force -ErrorAction SilentlyContinue"'
  Pop $0
  Delete "$SMPROGRAMS\@@PRODUCT_NAME@@\@@PRODUCT_NAME@@.lnk"
  RMDir "$SMPROGRAMS\@@PRODUCT_NAME@@"
  DeleteRegKey HKCU "@@UNINSTALL_KEY@@"
  DeleteRegKey HKCU "@@REG_KEY@@"
  RMDir /r "$INSTDIR"
  IfFileExists "$INSTDIR\@@EXE_NAME@@" 0 UninstallDone
  SetErrorLevel 1
  IfSilent +2
    MessageBox MB_ICONEXCLAMATION|MB_OK "部分文件未能删除（可能因为程序仍在运行）。请手动删除目录：$INSTDIR"
UninstallDone:
SectionEnd
