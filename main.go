package main

import (
	"embed"
	"fmt"
	"os"

	"kafkaexplorer/internal/app"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "fatal:", err)
		os.Exit(1)
	}
}

func run() error {
	application, cleanup, err := app.Bootstrap(assets)
	if err != nil {
		return err
	}
	defer cleanup()
	return application.Run()
}
