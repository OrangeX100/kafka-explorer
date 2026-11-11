// Package appdir resolves the per-user data locations. It sits BELOW the
// presentation layer so wails handlers can show these paths without
// importing internal/app (which imports the handlers — the arrow only
// points one way).
package appdir

import (
	"os"
	"path/filepath"
)

// DataDir returns %APPDATA%/KafkaExplorer (Windows) or
// ~/.local/share/KafkaExplorer, creating it when missing.
func DataDir() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	p := filepath.Join(dir, "KafkaExplorer")
	if err := os.MkdirAll(p, 0o755); err != nil {
		return "", err
	}
	return p, nil
}

// DatabasePath is the SQLite settings database inside DataDir.
func DatabasePath() (string, error) {
	dir, err := DataDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "settings.db"), nil
}

// LogFile is the zap log inside DataDir.
func LogFile() (string, error) {
	dir, err := DataDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "kafka-explorer.log"), nil
}
