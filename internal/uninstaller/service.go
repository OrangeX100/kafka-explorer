//go:build windows

// Package uninstaller backs the custom uninstaller UI (cmd/uninstaller):
// it reads the install facts Inno recorded, runs the real unins000.exe
// silently, wipes the data dir on request, and schedules the wrapper's
// own deletion. All user-facing errors are classified and actionable per
// the friendly-errors policy.
package uninstaller

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// arpKey is the Add/Remove Programs entry Inno Setup wrote for this app
// (AppId from build/installer/installer.iss — keep the two in sync).
const arpKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\{A314C01E-B626-4FFB-97AC-4260A28648CD}_is1`

// appMutex is the Wails single-instance lock the app holds while running
// (UniqueID + "-sim", see internal/app/bootstrap.go).
const appMutex = `wails-app-com.kafkaexplorer.app-sim`

// dataDir is the per-user data folder the checkbox offers to remove.
const dataDir = `%APPDATA%\KafkaExplorer`

// Info is the install snapshot the UI renders on load.
type Info struct {
	AppPath    string `json:"appPath"`
	Version    string `json:"version"`
	AppRunning bool   `json:"appRunning"` // true → the 卸载 button stays disabled
}

// Service is the wails service bound to the uninstaller window.
type Service struct {
	// pendingSelfDelete records the install dir to clean up once the
	// process exits: the wrapper exe is locked while the done state waits
	// for the user's 关闭 click, so the deletion CANNOT run at uninstall
	// completion (a 1s-delayed cmd fires while the exe is still locked).
	pendingSelfDelete string
	emit              func(topic string, data ...any) // wails events, wired by main
}

func New() *Service { return &Service{} }

// SetEmitter wires the wails event emitter (bootstrap owns the app) so
// the service can stream real uninstall progress to the UI.
func (s *Service) SetEmitter(emit func(topic string, data ...any)) {
	s.emit = emit
}

// uninstallProgress watches Inno's /LOG and streams a deterministic bar:
// the uninstall log writes one "Deleting file:" line per removed file,
// and "Uninstallation process succeeded" ends the run.
type uninstallProgress struct {
	emit     func(topic string, data ...any)
	logPath  string
	deadline time.Time
}

func (p *uninstallProgress) run() {
	defer func() {
		if p.emit != nil {
			p.emit("uninstall:progress", map[string]any{"pct": 100, "done": true})
		}
	}()
	seen := -1
	for time.Now().Before(p.deadline) {
		time.Sleep(300 * time.Millisecond)
		data, err := os.ReadFile(p.logPath)
		if err != nil {
			continue
		}
		text := string(data)
		done := strings.Contains(text, "Uninstallation process succeeded")
		deleted := strings.Count(text, "Deleting file:")
		// The uninstall log has no total up front (it's the reverse of
		// install: no file list) — scale against the app's ~6 files by
		// normalizing deleted/6 into 5..95, then jump to 100 on done.
		pct := 5 + 90*deleted/6
		if pct > 95 {
			pct = 95
		}
		if done {
			pct = 100
		}
		if pct != seen {
			seen = pct
			if p.emit != nil {
				p.emit("uninstall:progress", map[string]any{"pct": pct, "done": done})
			}
		}
		if done || strings.Contains(text, "Log closed.") {
			return
		}
	}
}

// Info reads the install facts Inno wrote at install time. appPath is
// empty when the app is not installed (wrapper launched stray).
func (s *Service) Info() Info {
	var info Info
	k, err := registry.OpenKey(registry.CURRENT_USER, arpKey, registry.QUERY_VALUE)
	if err != nil {
		return info
	}
	defer k.Close()
	appPath, _, _ := k.GetStringValue("Inno Setup: App Path")
	version, _, _ := k.GetStringValue("DisplayVersion")
	info.AppPath = appPath
	info.Version = version
	info.AppRunning = appRunning()
	return info
}

// appRunning reports whether the main app holds its single-instance lock.
func appRunning() bool {
	names := []string{
		appMutex,
	}
	for _, name := range names {
		// CreateMutex RETURNS A VALID HANDLE even when the mutex already
		// exists (err = ERROR_ALREADY_EXISTS). The handle must be closed in
		// EVERY branch: a leaked one keeps the mutex object alive, so after
		// the app quits appRunning() would still report true — and each
		// UI poll leaked another handle, pinning it forever.
		h, err := windows.CreateMutex(nil, false, windows.StringToUTF16Ptr(name))
		already := err == windows.ERROR_ALREADY_EXISTS
		if h != 0 {
			windows.CloseHandle(h)
		}
		if already {
			return true
		}
	}
	return false
}

// Uninstall runs the real Inno uninstaller silently (files, shortcuts and
// the ARP entry), optionally wipes the data dir, and schedules this
// wrapper exe's own deletion — it is locked while running, so a detached
// cmd removes it (and the now-empty install dir) after we exit.
func (s *Service) Uninstall(deleteData bool) error {
	if appRunning() {
		// race guard: the UI disables the button on a running app, but the
		// user could launch the app between the check and this call
		return fmt.Errorf("Kafka Explorer 正在运行。请先完全退出应用（包括托盘图标），再执行卸载。")
	}
	appPath := s.installPath()
	if appPath == "" {
		return fmt.Errorf("未找到 Kafka Explorer 的卸载信息，它可能已经被卸载。")
	}
	unins := filepath.Join(appPath, "unins000.exe")
	if _, err := os.Stat(unins); err != nil {
		return fmt.Errorf("未找到卸载程序 unins000.exe，它可能已经被卸载。")
	}

	// /LOG feeds the real progress bar: the UI shows how far the actual
	// file removal got instead of a fake marquee.
	logPath := filepath.Join(os.TempDir(), "KafkaExplorer_Uninstall.log")
	watcher := &uninstallProgress{emit: s.emit, logPath: logPath, deadline: time.Now().Add(20 * time.Minute)}
	if s.emit != nil {
		go watcher.run()
	}
	cmd := exec.Command(unins, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LOG="+logPath)
	cmd.Dir = appPath
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("卸载程序执行失败（可能是文件被占用）。请关闭杀毒软件的实时防护后重试，或手动运行安装目录中的 unins000.exe。")
	}
	os.Remove(logPath)

	if deleteData {
		appdata := os.Getenv("APPDATA")
		if appdata != "" {
			_ = os.RemoveAll(filepath.Join(appdata, "KafkaExplorer"))
		}
	}

	s.pendingSelfDelete = appPath
	return nil
}

// installPath reads where Inno put the app ("" when unknown).
func (s *Service) installPath() string {
	k, err := registry.OpenKey(registry.CURRENT_USER, arpKey, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	v, _, err := k.GetStringValue("Inno Setup: App Path")
	if err != nil {
		return ""
	}
	return v
}

// CleanupAfterExit schedules the self-deletion. The commands live in a
// temp .cmd script: passing them as cmd /C arguments breaks on the
// classic quote-stripping rule (paths with spaces + `&` chains), which is
// exactly why an earlier inline attempt silently deleted nothing.
func (s *Service) CleanupAfterExit() {
	if s.pendingSelfDelete == "" {
		return
	}
	self, err := os.Executable()
	if err != nil {
		return
	}
	script := filepath.Join(os.TempDir(), "ke_uninstall_cleanup.cmd")
	// escalating retries: antivirus scanners can hold a fresh exe for
	// several seconds after the process exits, so a single del is not enough
	body := "@echo off\r\n" +
		"ping -n 2 127.0.0.1 > nul\r\n" +
		"del /q \"" + self + "\" >nul 2>&1\r\n" +
		"if exist \"" + self + "\" ping -n 5 127.0.0.1 > nul\r\n" +
		"del /q \"" + self + "\" >nul 2>&1\r\n" +
		"if exist \"" + self + "\" ping -n 10 127.0.0.1 > nul\r\n" +
		"del /q \"" + self + "\" >nul 2>&1\r\n" +
		"rmdir /q \"" + s.pendingSelfDelete + "\" >nul 2>&1\r\n"
	if err := os.WriteFile(script, []byte(body), 0o644); err != nil {
		return
	}
	detached := exec.Command(os.Getenv("WINDIR")+`\System32\cmd.exe`, "/C", script)
	detached.SysProcAttr = hideWindow()
	_ = detached.Start()
}
