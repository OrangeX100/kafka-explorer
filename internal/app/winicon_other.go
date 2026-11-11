//go:build !windows

// Non-Windows platforms resolve the app icon from the bundle automatically.
package app

func setWindowIcon(title string) {}
