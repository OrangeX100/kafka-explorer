// Package buildinfo carries the build-stamped identity of the binary.
// It lives BELOW the application layer so both the app bootstrap and the
// wails handlers can read it without an import cycle (internal/app
// imports presentation/wails, so wails can never import internal/app).
//
// Values are injected at build time via -ldflags (see the Taskfile build
// task); a plain `go build` keeps the dev defaults.
package buildinfo

// Version is the semantic version, e.g. "0.1.0" or "0.1.0-dev".
var Version = "0.1.0-dev"

// Commit is the short git revision the binary was built from ("" in dev builds).
var Commit = ""

// UpdateRepo is the default GitHub "owner/repo" the auto-update check
// queries when the user has not set one in settings ("" = update check
// off). Stamped at build time via -ldflags so release builds ship with
// their own release repo while dev builds stay quiet.
var UpdateRepo = ""
