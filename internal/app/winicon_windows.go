//go:build windows

// Taskbar/window icon: wails3 registers its window class with the generic
// IDI_APPLICATION icon, which OVERRIDES the exe resource on the taskbar.
// After the webview window exists we therefore set our embedded icon
// explicitly with WM_SETICON (big + small). goversioninfo embeds the icon
// group at resource ID 32512 (IDI_APPLICATION's well-known slot) — NOT at
// ID 1 like rsrc did; two .rsrc sections from separate syso files don't
// link, so this syso carries icon + VERSIONINFO + manifest together.
package app

import (
	"syscall"
	"time"
	"unsafe"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	procFindWindowW      = user32.NewProc("FindWindowW")
	procSendMessageW     = user32.NewProc("SendMessageW")
	procLoadImageW       = user32.NewProc("LoadImageW")
	procGetSystemMetrics = user32.NewProc("GetSystemMetrics")
	procGetModuleHandleW = kernel32.NewProc("GetModuleHandleW")
)

const (
	wmSetIcon     = 0x0080
	iconBig       = 1
	iconSmall     = 0
	imageIcon     = 1
	lrDefaultSize = 0x40
	smCxSmallIcon = 49
	smCySmallIcon = 50
	// goversioninfo puts the icon group at IDI_APPLICATION (0x7F00); the
	// exe's VERSIONINFO/manifest each take ID 1 in their own type space.
	iconResourceID = 32512
)

func setWindowIcon(title string) {
	go func() {
		titlePtr, err := syscall.UTF16PtrFromString(title)
		if err != nil {
			return
		}
		var hwnd uintptr
		// The webview window is created asynchronously by the app run loop;
		// poll until it exists.
		for i := 0; i < 60; i++ {
			h, _, _ := procFindWindowW.Call(0, uintptr(unsafe.Pointer(titlePtr)))
			if h != 0 {
				hwnd = h
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
		if hwnd == 0 {
			return
		}
		hinst, _, _ := procGetModuleHandleW.Call(0)
		hBig, _, _ := procLoadImageW.Call(
			hinst, iconResourceID, imageIcon, 0, 0, lrDefaultSize,
		)
		cx, _, _ := procGetSystemMetrics.Call(smCxSmallIcon)
		cy, _, _ := procGetSystemMetrics.Call(smCySmallIcon)
		hSmall, _, _ := procLoadImageW.Call(hinst, iconResourceID, imageIcon, cx, cy, 0)
		if hBig != 0 {
			procSendMessageW.Call(hwnd, wmSetIcon, iconBig, hBig)
		}
		if hSmall != 0 {
			procSendMessageW.Call(hwnd, wmSetIcon, iconSmall, hSmall)
		}
	}()
}
