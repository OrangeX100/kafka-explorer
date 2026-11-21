// Kafka Explorer custom uninstaller: a minimal Wails app that shows the
// Self-drawn window (logo, delete-data checkbox, big blue 卸载 button)
// and drives internal/uninstaller to run the real unins000.exe silently.
// The main installer ships this exe to {app} and the app repoints the ARP
// UninstallString here at startup (internal/app/uninstall_registry_windows.go).
//
//go:build windows

package main

import (
	"embed"

	"github.com/wailsapp/wails/v3/pkg/application"
	"kafkaexplorer/internal/closeguard"
	"kafkaexplorer/internal/uninstaller"
)

//go:embed all:assets
var assets embed.FS

func main() {
	// NOTE: no CDP debug gate here (unlike the main app and the setup
	// front-end) — the uninstaller flow has no probe needing one. If a
	// probe ever needs to drive this window, port the double-gate from
	// cmd/setup/main.go first.
	winOptions := application.WindowsOptions{}

	app := application.New(application.Options{
		Name:    "Kafka Explorer Uninstaller",
		Windows: winOptions,
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		// silent uninstaller: no logging setup, no tray, no single-instance
		// redirect — this process IS the second instance by definition.
	})
	svc := uninstaller.New()

	// Alt+F4 / taskbar close bypasses the frontend's disabled-✕ guard and
	// would orphan the silent unins000.exe mid-run (progress watcher dead,
	// ARP entry half-removed). The window-level filter refuses WM_CLOSE
	// while an uninstall is in flight — see internal/closeguard.
	closeguard.Guard("Kafka Explorer 卸载", svc.Busy)

	app.RegisterService(application.NewService(svc))
	// wails events stream real uninstall progress to the UI
	svc.SetEmitter(func(topic string, data ...any) { app.Event.Emit(topic, data...) })

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: "Kafka Explorer 卸载",
		URL:   "/",
		// Dialog size; fixed (no resize grip on a form window)
		Width:            680,
		Height:           480,
		DisableResize:    true,
		Frameless:        true, // custom titlebar in index.html (--wails-draggable)
		InitialPosition:  application.WindowCentered,
		BackgroundColour: application.RGBA{Red: 0xFF, Green: 0xFF, Blue: 0xFF, Alpha: 1},
	})

	// self-delete must run AFTER the process exits (the exe is unlocked
	// then) — app.Run returns when the window closes
	_ = app.Run()
	svc.CleanupAfterExit()
}
