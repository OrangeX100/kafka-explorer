//go:build windows

package app

import (
	"context"
	_ "embed"
	"os"
	"syscall"
	"unsafe"

	wailsapp "github.com/wailsapp/wails/v3/pkg/application"

	"kafkaexplorer/internal/application"
)

//go:embed icons/appicon.png
var trayIcon []byte

var (
	procAnimateWindow              = user32.NewProc("AnimateWindow")
	procGetWindowLongPtrW          = user32.NewProc("GetWindowLongPtrW")
	procSetWindowLongPtrW          = user32.NewProc("SetWindowLongPtrW")
	procSetLayeredWindowAttributes = user32.NewProc("SetLayeredWindowAttributes")
)

const (
	gwlExStyle       = 0xFFFFFFF4 // GWL_EXSTYLE (-20) as uint32
	wsExLayered      = 0x00080000
	lwaAlpha         = 0x02
	awHide           = 0x00010000
	awBlend          = 0x00080000
	fadeInMs         = 180
	fadeOutMs        = 150
	trayRestoreTitle = "双击打开窗口"
)

// Tray owns the system-tray lifecycle: the ✕ button fades the window into
// the tray and only the tray menu truly quits. Double-click restores the
// window at the position it was closed at (AnimateWindow blend, no
// repositioning — the tray never relocates or hides the window).
type Tray struct {
	app  *wailsapp.App
	tray *wailsapp.SystemTray
	// settings supplies CloseToTray; a func so the current value is always
	// read at close time (the settings page can flip it mid-session).
	closeToTray func() bool
	// onQuit runs the app cleanup chain (pool/db/log) before Exit.
	onQuit func()
	// hwnd of the main window, resolved lazily once it exists.
	hwnd uintptr
}

func NewTray(app *wailsapp.App, settings *application.SettingsService, onQuit func()) *Tray {
	t := &Tray{app: app, onQuit: onQuit, closeToTray: func() bool {
		s, err := settings.Get(context.Background())
		return err == nil && s.CloseToTray
	}}

	menu := wailsapp.NewMenu()
	menu.Add("显示主窗口").OnClick(func(*wailsapp.Context) {
		t.restore()
	})
	menu.Add("退出").OnClick(func(*wailsapp.Context) {
		t.Quit()
	})

	t.tray = app.SystemTray.New()
	t.tray.SetIcon(trayIcon)
	t.tray.SetTooltip(AppName + " — " + trayRestoreTitle + "，右键菜单")
	t.tray.SetMenu(menu)
	// NO AttachWindow: wails' attached-window click handler toggles
	// visibility AND repositions the window next to the tray on every show.
	// The tray must never move or hide the window — clicks here do nothing,
	// double-click restores at the previous position (fade-in).
	t.tray.OnClick(func() {})
	t.tray.OnDoubleClick(t.restore)
	return t
}

// window returns the main window; nil-safe for early teardown.
func (t *Tray) window() wailsapp.Window {
	if w, ok := t.app.Window.GetByName("main"); ok {
		return w
	}
	return nil
}

// hwndOf resolves the main window's native handle once; cached afterwards.
func (t *Tray) hwndOf() uintptr {
	if t.hwnd != 0 {
		return t.hwnd
	}
	titlePtr, err := syscall.UTF16PtrFromString(AppName)
	if err != nil {
		return 0
	}
	h, _, _ := procFindWindowW.Call(0, uintptr(unsafe.Pointer(titlePtr)))
	t.hwnd = h
	return h
}

// ensureLayered turns on WS_EX_LAYERED with a fully-opaque alpha so
// AnimateWindow's AW_BLEND has something to animate. No visual change.
func (t *Tray) ensureLayered(hwnd uintptr) {
	ex, _, _ := procGetWindowLongPtrW.Call(hwnd, uintptr(gwlExStyle))
	if ex&wsExLayered != 0 {
		return
	}
	procSetWindowLongPtrW.Call(hwnd, uintptr(gwlExStyle), ex|wsExLayered)
	procSetLayeredWindowAttributes.Call(hwnd, 0, 255, uintptr(lwaAlpha))
}

// restore shows the window with a blend fade at its previous position.
// An already-visible window just gets focus (the tray never hides it).
func (t *Tray) restore() {
	w := t.window()
	if w == nil {
		return
	}
	if w.IsVisible() {
		w.Focus()
		return
	}
	if hwnd := t.hwndOf(); hwnd != 0 {
		t.ensureLayered(hwnd)
		// AnimateWindow shows AND blends in one call; the window keeps its
		// pre-hide position (no tray repositioning by design).
		ret, _, _ := procAnimateWindow.Call(hwnd, fadeInMs, uintptr(awBlend))
		if ret != 0 {
			w.Focus()
			return
		}
	}
	// Fallback: plain show if the native animation is unavailable.
	w.Show()
	w.Focus()
}

// CloseRequested answers the window ✕: fade-hide to tray, or truly quit
// when the user turned tray residency off in Settings.
func (t *Tray) CloseRequested() {
	if t.closeToTray() {
		t.hide()
		// First-time hint so the app never looks "lost" after ✕; the
		// frontend dedupes via localStorage.
		t.app.Event.Emit("tray:minimized")
		return
	}
	t.Quit()
}

func (t *Tray) hide() {
	w := t.window()
	if w == nil {
		return
	}
	if hwnd := t.hwndOf(); hwnd != 0 {
		t.ensureLayered(hwnd)
		if ret, _, _ := procAnimateWindow.Call(hwnd, fadeOutMs, uintptr(awHide|awBlend)); ret != 0 {
			return
		}
	}
	w.Hide()
}

// Quit tears the tray down, runs cleanup, exits.
func (t *Tray) Quit() {
	if t.tray != nil {
		// Without this the icon lingers in the tray until cursor hover.
		t.tray.Destroy()
	}
	if t.onQuit != nil {
		t.onQuit()
	}
	t.app.Quit()
	os.Exit(0)
}
