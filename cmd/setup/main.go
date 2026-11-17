// Kafka Explorer custom setup front-end: a minimal Wails app showing the
// Self-drawn install window (logo, install path, big blue 安装 button,
// working progress, done state) while the embedded real Inno installer
// runs silently underneath. File lists, shortcuts, the ARP entry and the
// uninstall log stay exactly as before — only the chrome is ours.
//
//go:build windows

package main

import (
	"embed"

	"github.com/wailsapp/wails/v3/pkg/application"
	"kafkaexplorer/internal/closeguard"
)

//go:embed all:assets
var assets embed.FS

//go:embed engine/KafkaExplorer_Engine.exe
var engineExe []byte

func main() {
	winOptions := application.WindowsOptions{}

	app := application.New(application.Options{
		Name:    "Kafka Explorer Setup",
		Windows: winOptions,
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
	})

	svc := newSetupService(engineExe)
	app.RegisterService(application.NewService(svc))
	// wails events stream real install progress to the UI (setup:progress)
	svc.SetEmitter(func(topic string, data ...any) { app.Event.Emit(topic, data...) })

	// Alt+F4 / taskbar close bypasses the frontend's disabled-✕ guard and
	// would kill the process mid-install (cleanup goroutines die, the Inno
	// engine turns into an orphan). The window-level filter refuses WM_CLOSE
	// while an install is in flight — see internal/closeguard.
	closeguard.Guard("Kafka Explorer 安装", svc.InstallInProgress)

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: "Kafka Explorer 安装",
		URL:   "/",
		// Dialog size; fixed (no resize grip on a form window)
		Width:            680,
		Height:           480,
		DisableResize:    true,
		Frameless:        true, // custom titlebar in index.html (--wails-draggable)
		InitialPosition:  application.WindowCentered,
		BackgroundColour: application.RGBA{Red: 0xFF, Green: 0xFF, Blue: 0xFF, Alpha: 1},
	})

	_ = app.Run()
}
