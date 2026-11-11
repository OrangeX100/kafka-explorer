// Shared setup-wizard restyle, included by installer.iss [Code] section.
//
// Inno's "modern" wizard still renders stock gray Win32 chrome; these hooks
// repaint it in the app's identity — white pages, ink-950 header band,
// accent-blue buttons — using only documented form/control properties
// (CreateCustomForm's siblings on WizardForm). Flat TPanel buttons are not
// possible here: the wizard's own Back/Next/Cancel must stay real buttons
// or keyboard navigation breaks, so they keep native rendering and only
// get consistent sizing/typography.
//
// All coordinates are dialog units (du) — same scaling model as
// uninstall_form.inc; no ScaleX/ScaleY.

procedure StyleWizard();
var
  Black, White, Muted, Accent: TColor;
begin
  Black  := $1A1A1A;   // ink heading
  White  := clWhite;
  Muted  := $6E6E6E;
  Accent := $FF8C4F;   // RGB(79,140,255) — TColor is $00BBGGRR

  // page surfaces: white content over the default gray chrome reads as a
  // modern flat dialog instead of a Win95 property sheet
  WizardForm.Color := White;

  // header band: app name + current page, white on ink
  WizardForm.MainPanel.Color := $181312;
  WizardForm.PageNameLabel.Font.Color := clWhite;
  WizardForm.PageNameLabel.Font.Size := 11;
  WizardForm.PageNameLabel.Font.Style := [fsBold];
  WizardForm.PageDescriptionLabel.Font.Color := $C6B4B4;
  WizardForm.PageDescriptionLabel.Font.Size := 9;

  // the small wizard bitmap sits on the dark band (white bg variant ships
  // as wizard_small.png)
  // welcome/finished big sidebar image page already ships wizard_sidebar.png

  // buttons: consistent sizing and the app's typography (native rendering
  // kept — self-drawn panels would break keyboard/mnemonic navigation)
  WizardForm.BackButton.Height := 30;
  WizardForm.NextButton.Height := 30;
  WizardForm.CancelButton.Height := 30;
  WizardForm.NextButton.Font.Color := Black;
  WizardForm.CancelButton.Font.Color := Black;

  // license/memo controls inherit the white page
  WizardForm.LicenseMemo.Color := White;
  WizardForm.InfoBeforeMemo.Color := White;
  WizardForm.InfoAfterMemo.Color := White;
  WizardForm.TasksList.Color := White;
  WizardForm.DirEdit.Color := White;

  // finished page: the Run checkbox line reads better on white
  WizardForm.RunList.Color := White;
end;

procedure InitializeWizard();
begin
  StyleWizard();
end;
