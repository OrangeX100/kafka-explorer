//go:build windows

// Package closeguard subclasses a wails window's WndProc so WM_CLOSE hits an
// application filter BEFORE the framework sees it. Why this exists: wails
// v3 alpha2.117's built-in WindowClosing handler destroys the window
// unconditionally (webview_window.go:336) and OnWindowEvent appends run
// AFTER it — there is no framework-level veto. Alt+F4 / taskbar close /
// programmatic WM_CLOSE therefore bypassed the frontend's disabled-✕ guard
// and killed the process mid-install (cleanup goroutines die, the Inno
// engine turns into an orphan, shortcut files "appear later").
//
// The guard refuses WM_CLOSE while `refuse()` reports true (native warning
// box, message swallowed) and forwards everything else to the original
// proc, so normal closing (the frontend ✕ in idle/done state) is untouched.
//
// Two windows use it today: the setup front-end and the uninstaller
// front-end ("两窗统一治理" — one implementation, no drift).
package closeguard

import (
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	user32 = syscall.NewLazyDLL("user32.dll")

	procFindWindowW       = user32.NewProc("FindWindowW")
	procGetWindowLongPtrW = user32.NewProc("GetWindowLongPtrW")
	procSetWindowLongPtrW = user32.NewProc("SetWindowLongPtrW")
	procCallWindowProcW   = user32.NewProc("CallWindowProcW")
	procMessageBoxW       = user32.NewProc("MessageBoxW")
)

const (
	wmClose       = 0x0010
	gwlWndProc    = uintptr(0xFFFFFFFFFFFFFFFC) // -4, sign-extended for 64-bit
	mbOk          = 0x00000000
	mbIconWarning = 0x00000030
)

// Guard polls for the window titled `title` (created asynchronously by the
// wails run loop) and installs the WM_CLOSE filter. refuse() runs on the
// window's message thread — keep it lock-light (an atomic/flag read).
func Guard(title string, refuse func() bool) {
	go func(title string, refuse func() bool) {
		titlePtr, err := syscall.UTF16PtrFromString(title)
		if err != nil {
			return
		}
		var hwnd uintptr
		// The webview window is created asynchronously by the app run loop;
		// poll until it exists (same pattern as the taskbar-icon fix).
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
		install(hwnd, refuse)
	}(title, refuse)
}

// per-window guard state, keyed by hwnd (the two front-ends have exactly
// one window each, but the map keeps the code honest for future reuse).
var (
	mu        sync.Mutex
	origProcs = map[uintptr]uintptr{}
	callbacks = map[uintptr]uintptr{}
)

func install(hwnd uintptr, refuse func() bool) {
	mu.Lock()
	defer mu.Unlock()
	if _, dup := origProcs[hwnd]; dup {
		return // already guarded
	}
	orig, _, _ := procGetWindowLongPtrW.Call(hwnd, gwlWndProc)
	origProcs[hwnd] = orig
	cb := syscall.NewCallback(func(hwnd, msg, wparam, lparam uintptr) uintptr {
		if msg == wmClose && refuse() {
			titlePtr, _ := syscall.UTF16PtrFromString("Kafka Explorer")
			textPtr, _ := syscall.UTF16PtrFromString(
				"操作正在进行中，无法退出。请等待完成后再关闭窗口。",
			)
			procMessageBoxW.Call(
				hwnd,
				uintptr(unsafe.Pointer(textPtr)),
				uintptr(unsafe.Pointer(titlePtr)),
				mbOk|mbIconWarning,
			)
			return 0 // swallow the close
		}
		mu.Lock()
		orig := origProcs[hwnd]
		mu.Unlock()
		ret, _, _ := procCallWindowProcW.Call(orig, hwnd, msg, wparam, lparam)
		return ret
	})
	callbacks[hwnd] = cb
	procSetWindowLongPtrW.Call(hwnd, gwlWndProc, cb)
}
