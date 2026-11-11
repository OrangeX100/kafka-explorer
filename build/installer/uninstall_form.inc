// Shared uninstall options form (single styled window), included
// by uninstaller.iss (the shipped wrapper - the primary uninstall UI) and
// installer.iss (fallback when someone runs unins000.exe directly).
//
// Scaling model (measured on a 200%-DPI machine): CreateCustomForm scales
// its own ClientWidth/Height params to the current DPI, but CHILD CONTROL
// coordinates stay raw pixels. So the layout is authored against the
// 420x250 base grid and every child coordinate goes through U() below,
// which derives the form's real scale factor from its rendered width.
// Font.Size needs no scaling (points are DPI-aware already).
//
// Needs these [CustomMessages] keys: UninstallOptionsTitle, Subtitle,
// DeleteDataCheckbox, UninstallFrom, OptionsOk, OptionsCancel.
// Needs these globals: OptionsOk (set by OkBtnClick / CancelBtnClick).

var
  OptionsOk: Boolean;   // set by button OnClick: TSetupForm.ModalResult
                        // is not readable from PascalScript
  WorkingG: Boolean;    // true between 卸载 click and the done state: the
                        // flat panels have no Enabled greying, so clicks
                        // are ignored through this flag
  FormG: TSetupForm;    // one window lives across both modal loops
  OkPanelG, CancelPanelG: TPanel;
  ChkG: TNewCheckBox;
  ProgressG: TNewProgressBar;
  DetailG: TNewStaticText;

// base-grid units -> real pixels for the current DPI
function U(N: Integer): Integer;
begin
  Result := Round(N * FormG.ClientWidth / 420);
  if Result < N then
    Result := N;   // never smaller than authored (96dpi floor)
end;

procedure OkBtnClick(Sender: TObject);
begin
  if WorkingG then
    Exit;
  OptionsOk := True;
  FormG.Close;   // panels have no ModalResult; close the modal by hand
end;

procedure CancelBtnClick(Sender: TObject);
begin
  if WorkingG then
    Exit;
  OptionsOk := False;
  FormG.Close;
end;

// flat push button: one TPanel, solid fill, centered caption
procedure MakeFlatButton(Panel: TPanel; const Caption: String;
  BackColor, TextColor: TColor);
begin
  Panel.Parent := FormG;
  // VCL themes ignore Panel.Color unless the themed background is optged out
  Panel.ParentBackground := False;
  Panel.Color := BackColor;
  Panel.BevelOuter := bvNone;
  Panel.Caption := Caption;
  Panel.Alignment := taCenter;
  Panel.Font.Size := 10;
  Panel.Font.Color := TextColor;
  Panel.Font.Style := [fsBold];
  Panel.Cursor := crHand;
end;

// builds the window; LogoPath is {tmp}\... (wrapper) or {app}\... (fallback)
procedure BuildUninstallWindow(const LogoPath, AppPath: String);
var
  Logo: TBitmapImage;
  Title, Sub, FromLbl, PathLbl: TNewStaticText;
begin
  FormG := CreateCustomForm(420, 250, False, False);
  FormG.Caption := '{#AppName} ' + CustomMessage('UninstallOptionsTitle');
  FormG.Color := clWhite;

  Logo := TBitmapImage.Create(FormG);
  Logo.Parent := FormG;
  // empty LogoPath = file missing on an old install; layout still holds
  if LogoPath <> '' then
  begin
    Logo.Bitmap.LoadFromFile(LogoPath);
    Logo.Left := U(30);
    Logo.Top := U(60);
    Logo.Width := U(110);
    Logo.Height := U(110);
    Logo.Stretch := True;
  end;

  Title := TNewStaticText.Create(FormG);
  Title.Parent := FormG;
  Title.Left := U(163);
  Title.Top := U(22);
  Title.Caption := '{#AppName}';
  Title.Font.Size := 16;
  Title.Font.Style := [fsBold];
  Title.Font.Color := $1A1A1A;

  Sub := TNewStaticText.Create(FormG);
  Sub.Parent := FormG;
  Sub.Left := U(165);
  Sub.Top := U(68);
  Sub.Caption := CustomMessage('Subtitle');
  Sub.Font.Size := 10;
  Sub.Font.Color := $6E6E6E;

  ChkG := TNewCheckBox.Create(FormG);
  ChkG.Parent := FormG;
  ChkG.Left := U(165);
  ChkG.Top := U(106);
  ChkG.Width := U(240);
  ChkG.Height := U(24);   // fixed height: the auto height clips CJK text
  ChkG.Caption := CustomMessage('DeleteDataCheckbox');
  ChkG.Font.Size := 10;

  FromLbl := TNewStaticText.Create(FormG);
  FromLbl.Parent := FormG;
  FromLbl.Left := U(165);
  FromLbl.Top := U(146);
  FromLbl.Caption := CustomMessage('UninstallFrom');
  FromLbl.Font.Size := 10;
  FromLbl.Font.Color := $6E6E6E;

  PathLbl := TNewStaticText.Create(FormG);
  PathLbl.Parent := FormG;
  PathLbl.Left := U(165);
  PathLbl.Top := U(170);
  PathLbl.Caption := AppPath;   // {app} is uninitialized under the
                                // wrapper (CreateAppDir=no)
  PathLbl.Font.Size := 10;
  PathLbl.Font.Color := $FF8C4F;   // accent RGB(79,140,255)

  DetailG := TNewStaticText.Create(FormG);
  DetailG.Parent := FormG;
  DetailG.Left := U(165);
  DetailG.Top := U(206);
  DetailG.Width := U(240);
  DetailG.Visible := False;

  // flat buttons: accent blue primary, light gray cancel; no ActiveControl
  // (a focused checkbox draws an ugly dotted rectangle around its label)
  OkPanelG := TPanel.Create(FormG);
  MakeFlatButton(OkPanelG, CustomMessage('OptionsOk'), $FF8C4F, clWhite);
  OkPanelG.Left := FormG.ClientWidth - U(118);
  OkPanelG.Top := FormG.ClientHeight - U(46);
  OkPanelG.Width := U(104);
  OkPanelG.Height := U(30);
  OkPanelG.OnClick := @OkBtnClick;

  CancelPanelG := TPanel.Create(FormG);
  MakeFlatButton(CancelPanelG, CustomMessage('OptionsCancel'), $EFEFEF, $444444);
  CancelPanelG.Left := OkPanelG.Left - U(112);
  CancelPanelG.Top := OkPanelG.Top;
  CancelPanelG.Width := OkPanelG.Width;
  CancelPanelG.Height := OkPanelG.Height;
  CancelPanelG.OnClick := @CancelBtnClick;

  ProgressG := TNewProgressBar.Create(FormG);
  ProgressG.Parent := FormG;
  ProgressG.Left := U(165);
  ProgressG.Top := FormG.ClientHeight - U(26);
  ProgressG.Width := U(240);
  ProgressG.Height := U(10);
  ProgressG.Visible := False;
  ProgressG.Style := npbstMarquee;
end;
