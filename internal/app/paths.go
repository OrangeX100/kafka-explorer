package app

import (
	"kafkaexplorer/internal/appdir"
	"kafkaexplorer/internal/buildinfo"
)

// AppName is used for the window title, credential-store service name and
// the per-user data directory.
const AppName = "Kafka Explorer"

// AppVersion mirrors buildinfo.Version (stamped via -ldflags, see the
// Taskfile build task).
var AppVersion = buildinfo.Version

// DataDir returns %APPDATA%/KafkaExplorer (Windows) or ~/.local/share/kafka-explorer.
func DataDir() (string, error) {
	return appdir.DataDir()
}

// DatabasePath is the SQLite settings database inside DataDir.
func DatabasePath() (string, error) {
	return appdir.DatabasePath()
}
