package wails

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"

	wailsapp "github.com/wailsapp/wails/v3/pkg/application"
	"kafkaexplorer/internal/appdir"
	"kafkaexplorer/internal/application"
	"kafkaexplorer/internal/buildinfo"
)

// promptSingleSelection normalizes a native file-dialog result: wails maps
// the dialog's Cancel button to the error `cancelled by user`
// (go-common-file-dialog/cfd.ErrorCancelled), which would otherwise surface
// as an "操作失败" toast for a perfectly normal action. Cancelling is a
// no-op — "" and no error.
func promptSingleSelection(path string, err error) (string, error) {
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "cancel") {
		return "", nil
	}
	return path, err
}

// AppInfo is the About-page payload: build identity plus the local paths a
// user may need when reporting a problem (log file, data dir).
type AppInfo struct {
	Version   string `json:"version"`   // semantic version, e.g. 0.1.0-dev
	Commit    string `json:"commit"`    // short git revision ("" in dev builds)
	GoVersion string `json:"goVersion"` // Go runtime this binary was built with
	OS        string `json:"os"`        // GOOS
	Arch      string `json:"arch"`      // GOARCH
	DataDir   string `json:"dataDir"`   // per-user data directory
	LogFile   string `json:"logFile"`   // zap log file inside DataDir
	StartedAt int64  `json:"startedAt"` // process start, unix ms
}

// SystemHandler exposes app identity and the update check. Read-only: the
// update source URL lives in Settings, passed in per call so a changed
// setting applies without restart.
type SystemHandler struct {
	update    *application.UpdateService
	log       *zap.Logger
	startedAt time.Time
	// closeTray is the tray's ✕ answer (hide vs quit); injected by bootstrap
	// AFTER handler construction (the tray itself needs the app first).
	closeTray func()
	// quit runs the full shutdown chain (tray destroy + cleanup + app quit);
	// the update install path calls it right after spawning the waiter.
	quit func()
	// emit publishes download progress to the frontend (system:update:progress).
	emit   func(topic string, data ...any)
	cancel context.CancelFunc
	// paths authorizes file paths handed back to consumers: only paths the
	// app's OWN pick dialogs issued may flow into ReadTextFile (and the other
	// handlers' import/export bindings via the shared broker). A compromised
	// webview naming an arbitrary file is refused here (045 security round).
	paths *pathBroker
	// stageGen identifies the currently registered stage download: the
	// goroutine's cleanup must only clear h.cancel when it is STILL the
	// registered one (a superseding stage owns it by then).
	stageGen int64
	// stagedPath/stagedSHA remember what THIS handler staged (set only from
	// a successful staging of the current generation). InstallStaged installs
	// THIS candidate after re-verification — the renderer never names a path.
	stagedPath string
	stagedSHA  string
	mu         sync.Mutex
}

func NewSystemHandler(update *application.UpdateService, log *zap.Logger) *SystemHandler {
	return &SystemHandler{update: update, log: log, startedAt: time.Now(), paths: newPathBroker()}
}

// SetPathBroker shares the pick-path authorization with the other handlers
// (imports/exports verify against the SAME broker the picks issued into).
// Must be called during bootstrap before any binding fires.
func (h *SystemHandler) SetPathBroker(b *pathBroker) {
	h.paths = b
}

// PathBroker exposes the shared broker for bootstrap wiring.
func (h *SystemHandler) PathBroker() *pathBroker { return h.paths }

// SetCloseTray wires the tray close branch. Optional: without it the ✕ does
// nothing (never the shipped shape).
func (h *SystemHandler) SetCloseTray(f func()) {
	h.closeTray = f
}

// SetQuit wires the full shutdown chain for the update-install path.
func (h *SystemHandler) SetQuit(f func()) {
	h.quit = f
}

// SetEmitter wires the wails event emitter (bootstrap owns the app).
func (h *SystemHandler) SetEmitter(emit func(topic string, data ...any)) {
	h.emit = emit
}

// GetAppInfo assembles the About payload. Path resolution errors surface
// as empty strings — the About page renders those as "unavailable" rather
// than failing the whole call.
func (h *SystemHandler) GetAppInfo(ctx context.Context) (AppInfo, error) {
	info := AppInfo{
		Version:   buildinfo.Version,
		Commit:    buildinfo.Commit,
		GoVersion: runtime.Version(),
		OS:        runtime.GOOS,
		Arch:      runtime.GOARCH,
		StartedAt: h.startedAt.UnixMilli(),
	}
	if dir, err := appdir.DataDir(); err == nil {
		info.DataDir = dir
		info.LogFile = filepath.Join(dir, "kafka-explorer.log")
	}
	return info, nil
}

// CheckUpdate runs one update-source query for the given "owner/repo".
func (h *SystemHandler) CheckUpdate(ctx context.Context, repo string) (application.UpdateCheck, error) {
	return h.update.Check(ctx, repo)
}

// PickOpenFile shows a native open-file dialog. Returns "" when the user
// cancels — not an error, callers treat it as a no-op. The issued path is
// registered with the path broker; file-consuming bindings verify against it.
func (h *SystemHandler) PickOpenFile(ctx context.Context, title, pattern string) (string, error) {
	dlg := wailsapp.Get().Dialog.OpenFile().SetTitle(title).CanChooseFiles(true)
	if pattern != "" {
		dlg = dlg.AddFilter("文件", pattern)
	}
	path, err := promptSingleSelection(dlg.PromptForSingleSelection())
	if err == nil && path != "" {
		h.paths.Issue(path)
	}
	return path, err
}

// ReadTextFile reads a UTF-8 text file the user just picked (schema uploads,
// import payloads). The path MUST have come from PickOpenFile — the broker
// check turns this from an arbitrary-file-read primitive into a quoted
// read (045 security round: the old comment claimed the binding was safe
// because "the path is user-picked", but nothing enforced it).
func (h *SystemHandler) ReadTextFile(ctx context.Context, path string) (string, error) {
	const maxTextFile = 8 << 20 // 8 MB: any schema or import payload fits
	if !h.paths.Authorized(path) {
		return "", fmt.Errorf("文件路径未经过应用的文件选择对话框，已拒绝读取")
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("读取文件失败：%v", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("%s 是目录，不是文件", filepath.Base(path))
	}
	if info.Size() > maxTextFile {
		return "", fmt.Errorf("文件过大（%d MB），文本读取上限 8 MB", info.Size()/(1<<20))
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("读取文件失败：%v", err)
	}
	return string(raw), nil
}

// CloseToTray is the ✕ button's backend: hide-to-tray or quit per settings.
func (h *SystemHandler) CloseToTray() {
	if h.closeTray != nil {
		h.closeTray()
	}
}

// PickSaveFile shows a native save-file dialog pre-filled with defaultName.
// "" = cancelled. The issued path is registered with the path broker;
// ExportToFile verifies against it.
func (h *SystemHandler) PickSaveFile(ctx context.Context, title, defaultName, pattern string) (string, error) {
	// alpha2 SaveFileDialog has no SetTitle - SetMessage carries the header.
	dlg := wailsapp.Get().Dialog.SaveFile().SetMessage(title).SetFilename(defaultName)
	if pattern != "" {
		dlg = dlg.AddFilter("文件", pattern)
	}
	path, err := promptSingleSelection(dlg.PromptForSingleSelection())
	if err == nil && path != "" {
		h.paths.Issue(path)
	}
	return path, err
}
