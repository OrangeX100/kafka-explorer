//go:build windows

package uninstaller

import "syscall"

// hideWindow keeps the detached self-delete cmd from flashing a console.
func hideWindow() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true}
}
