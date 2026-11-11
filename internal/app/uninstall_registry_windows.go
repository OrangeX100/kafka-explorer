//go:build windows

package app

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/windows/registry"
)

// arpKey is the Add/Remove Programs entry Inno Setup wrote for this app.
// The {…} literal is the AppId from build/installer/installer.iss — keep
// the two in sync.
const arpKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\{A314C01E-B626-4FFB-97AC-4260A28648CD}_is1`

// fixUninstallRegistry repoints the ARP "Uninstall" button at the styled
// wrapper exe (build/installer/uninstaller.iss → KafkaExplorer_Uninstall.exe).
// Inno writes its own unins000.exe values AFTER every setup script hook —
// even DeinitializeSetup — so this cannot be done from the installer; the
// app fixes it on every launch instead, which also self-heals upgrades.
// Best-effort: outside a real install (dev runs, portable copies) there is
// nothing to fix, so every miss just returns.
func fixUninstallRegistry() {
	dir, err := os.Executable()
	if err != nil {
		return
	}
	dir = filepath.Dir(dir)
	// only a real install has both the Inno uninstaller and the wrapper
	unins := filepath.Join(dir, "unins000.exe")
	wrapper := filepath.Join(dir, "KafkaExplorer_Uninstall.exe")
	if _, err := os.Stat(unins); err != nil {
		return
	}
	if _, err := os.Stat(wrapper); err != nil {
		return
	}
	k, err := registry.OpenKey(registry.CURRENT_USER, arpKey, registry.SET_VALUE)
	if err != nil {
		return
	}
	defer k.Close()
	_ = k.SetStringValue("UninstallString", `"`+wrapper+`"`)
	_ = k.SetStringValue("QuietUninstallString",
		`"`+unins+`" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART`)
}
