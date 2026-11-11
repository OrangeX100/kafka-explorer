; Kafka Explorer setup (Inno Setup 6).
;
; Per-user install ({localappdata}) with PrivilegesRequired=lowest: no UAC
; prompt, and the silent self-update (see update/install in the Go app)
; never needs elevation — the same trade prior tools made. The WebView2
; runtime check runs before the file copy; without it a fresh Windows 10
; machine would install a browser that cannot start.

#define AppName "Kafka Explorer"
#define AppExe "kafka-explorer.exe"
#define AppId "{{A314C01E-B626-4FFB-97AC-4260A28648CD}"

#ifndef SourceExe
#define SourceExe "..\..\bin\kafka-explorer.exe"
#endif

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#Version}
DefaultDirName={localappdata}\{#AppName}
DefaultGroupName={#AppName}
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}
; beta.1 -> 0.2.0.1 so Explorer's version column sorts prereleases
VersionInfoVersion={#VersionInfoVersion}
VersionInfoTextVersion={#Version}
VersionInfoCompany=Kafka Explorer contributors
VersionInfoDescription=Kafka Explorer - Kafka 集群可视化管理工具 安装程序
VersionInfoCopyright=Copyright (C) 2026 Kafka Explorer contributors
VersionInfoProductName={#AppName}
OutputDir=..\..\bin\installer
OutputBaseFilename=KafkaExplorer_Setup_{#Version}
SetupIconFile=..\windows\kafka_icon.ico
WizardImageFile=wizard_sidebar.png
WizardSmallImageFile=wizard_small.png
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
; The setup front-end passes /DIR explicitly (user's chosen path). Without
; this, Inno IGNORES /DIR whenever a previous install of the same AppId
; exists and silently reinstalls into the old location instead.
UsePreviousAppDir=no
; DISTRIBUTION MODEL: the downloaded KafkaExplorer_Setup.exe IS the Wails
; front-end (cmd/setup, built by the installer task AFTER this engine is
; compiled — the task copies the engine into cmd/setup/engine/ where
; go:embed bakes it into the front-end, so the release is ONE exe). The
; front-end shows the styled window, extracts the engine and runs it
; silently with /VERYSILENT /DIR=... (with AV-escape fallbacks ending in
; a one-click .cmd — see cmd/setup/service.go). A user double-clicking
; the extracted engine exe directly still gets the (styled) Inno wizard
; as a fallback. DisableDirPage=no keeps that page functional.
DisableDirPage=no

[Languages]
Name: "chinese"; MessagesFile: "Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
chinese.CreateDesktopIcon=创建桌面快捷方式(&D)
english.CreateDesktopIcon=Create a &desktop shortcut
chinese.WebView2Missing=检测到系统缺少 WebView2 运行时（应用界面依赖它）。%n%n安装程序将自动下载并安装，需要联网，请稍候。
english.WebView2Missing=The WebView2 Runtime required by this app is missing.%n%nThe setup will now download and install it automatically (internet connection required).
chinese.WebView2Downloading=正在下载 WebView2 运行时，请稍候…
chinese.WebView2Failed=WebView2 运行时安装失败（错误 %1）。%n%n请访问 https://developer.microsoft.com/microsoft-edge/webview2 手动安装后重试。
english.WebView2Downloading=Downloading the WebView2 runtime, please wait…
english.WebView2Failed=WebView2 runtime installation failed (error %1).%n%nInstall it manually from https://developer.microsoft.com/microsoft-edge/webview2 and retry.
chinese.LaunchAfterInstall=安装完成后运行 Kafka Explorer(&R)
english.LaunchAfterInstall=&Launch Kafka Explorer after install
; keys shared with uninstaller.iss through uninstall_form.inc
chinese.UninstallOptionsTitle=卸载
chinese.Subtitle=集群可视化管理工具
chinese.DeleteDataCheckbox=同时删除用户数据
chinese.UninstallFrom=卸载自
chinese.OptionsOk=卸载
chinese.OptionsCancel=取消
english.UninstallOptionsTitle=Uninstall
english.Subtitle=Kafka cluster visualization
english.DeleteDataCheckbox=Also delete user data
english.UninstallFrom=Uninstall from
english.OptionsOk=Uninstall
english.OptionsCancel=Cancel

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "Languages\ChineseSimplified.isl"; DestDir: "{app}\Languages"; Flags: ignoreversion
; loaded by the uninstaller's options form (built from uninstall_logo.bmp)
Source: "uninstall_logo.bmp"; DestDir: "{app}"; Flags: ignoreversion
; custom uninstaller front-end (see uninstaller.iss): ARP + Start-menu
; 卸载 open this; the real unins000.exe stays for silent runs
Source: "..\..\bin\installer\KafkaExplorer_Uninstall.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{app}\KafkaExplorer_Uninstall.exe"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchAfterInstall}"; Flags: nowait postinstall skipifsilent

[Code]
#include "uninstall_form.inc"
#include "setup_style.inc"

const
  WebView2Key = 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  BootstrapperUrl = 'https://go.microsoft.com/fwlink/?linkid=2124701';
  BootstrapperName = 'MicrosoftEdgeWebView2RuntimeInstaller.exe';

// Uninstall fallback: the styled options form (shared with the custom
// uninstaller via uninstall_form.inc) shows when someone runs unins000.exe
// directly instead of the wrapper. The wrapper (KafkaExplorer_Uninstall.exe)
// is the primary uninstall UI — see uninstaller.iss. Deletion still runs at
// usPostUninstall, so cancelling anywhere never touches the data dir;
// silent uninstalls (the self-update flow) skip the form and keep the data.
var
  DeleteDataOnUninstall: Boolean;

// the shared form (uninstall_form.inc) defines OptionsOk/OkBtnClick/etc.
procedure ShowUninstallOptions();
begin
  // the bmp ships from this version on; an uninstall of an install made
  // by an older build must not die on a missing file
  if FileExists(ExpandConstant('{app}\uninstall_logo.bmp')) then
    BuildUninstallWindow(ExpandConstant('{app}\uninstall_logo.bmp'),
      ExpandConstant('{app}'))
  else
    BuildUninstallWindow('', ExpandConstant('{app}'));   // no logo, layout holds
  OptionsOk := False;
  FormG.ShowModal;
  if OptionsOk then
    DeleteDataOnUninstall := ChkG.Checked
  else
    Abort;   // close/X ends the whole uninstall before anything is touched
  FormG.Free;
end;

// ARP redirect note: Inno writes its ARP key AFTER every script hook
// (even DeinitializeSetup — verified with SaveStringToFile markers), so
// the UninstallString→wrapper override cannot live here. The Go app does
// it at startup instead: see internal/app/uninstall_registry_windows.go.

procedure InitializeUninstallProgressForm();
begin
  // keep the progress window in the same voice as the options form
  UninstallProgressForm.Caption := '{#AppName} ' + CustomMessage('UninstallOptionsTitle');
  UninstallProgressForm.PageNameLabel.Caption := CustomMessage('UninstallOptionsTitle');
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
  Step: TUninstallStep;
begin
  Step := CurUninstallStep;
  if Step = usAppMutexCheck then
  begin
    if UninstallSilent() then
      DeleteDataOnUninstall := False   // silent (self-update): always keep
    else
      ShowUninstallOptions();
  end;
  if (Step = usPostUninstall) and DeleteDataOnUninstall then
  begin
    DataDir := ExpandConstant('{userappdata}') + '\KafkaExplorer';
    if DirExists(DataDir) then
      DelTree(DataDir, True, True, True);
  end;
end;

var
  WebV2PageDone: Boolean;

// WebView2 present? The registry key under EdgeUpdate exists once the
// runtime (bundled or per-app) is installed; evergreen installs keep it
// under both HKLM and HKCU depending on who installed it.
function WebView2Installed(): Boolean;
begin
  Result :=
    RegKeyExists(HKEY_LOCAL_MACHINE, WebView2Key) or
    RegKeyExists(HKEY_CURRENT_USER, WebView2Key);
end;

// Download via PowerShell: zero extra plugins, present on every Windows
// (same trick as the silent-update waiter below the Go app uses).
procedure WebV2Install();
var
  Tmp: String;
  Code: Integer;
begin
  Tmp := ExpandConstant('{tmp}\') + BootstrapperName;
  WizardForm.StatusLabel.Caption := CustomMessage('WebView2Downloading');
  Exec(
    ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -Command ' +
      '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; ' +
      'Invoke-WebRequest -Uri ''' + BootstrapperUrl + ''' -OutFile ''' + Tmp + ''' -UseBasicParsing',
    ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, Code);
  WizardForm.StatusLabel.Caption := '';
  if (Code = 0) and FileExists(Tmp) then
  begin
    Exec(Tmp, '/silent /install', ExpandConstant('{tmp}'),
      SW_SHOW, ewWaitUntilTerminated, Code);
    if Code <> 0 then
      MsgBox(FmtMessage(CustomMessage('WebView2Failed'), [IntToStr(Code)]),
        mbCriticalError, MB_OK);
  end else
    MsgBox(FmtMessage(CustomMessage('WebView2Failed'), [IntToStr(Code)]),
      mbCriticalError, MB_OK);
  DeleteFile(Tmp);
  WebV2PageDone := True;
end;

// PrepareToInstall runs before files are copied; returning a non-empty
// string aborts the normal flow — we install WebView2 and continue by
// restarting the wizard (standard wails-bootstrapper pattern).
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  WebV2PageDone := False;
  if not WebView2Installed() then
  begin
    if MsgBox(CustomMessage('WebView2Missing'), mbConfirmation, MB_YESNO) = IDYES then
    begin
      WebV2Install();
      if not WebView2Installed() then
        Result := CustomMessage('WebView2Failed');
    end
    else
      Result := CustomMessage('WebView2Missing');
  end;
end;
