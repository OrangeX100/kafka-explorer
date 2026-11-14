package wails

// System update staging + install (Windows): the About page drives these
// after a successful CheckUpdate that carried a setup asset.
//
// StageUpdate runs the download in the background and reports progress on
// the wails event `system:update:progress` ({bytes,total,done,failed}) —
// human-reading rate ticks (150ms), well below the WS-threshold class.
// InstallStaged spawns the silent-setup waiter and then quits the app; the
// waiter installs and (optionally) relaunches.
//
// TWO hard rules learned the hard way (044 review round):
//   - The background download must NOT derive from the wails call ctx: the
//     binding-call processor defers cancel() when the METHOD RETURNS
//     (wails alpha2.117 messageprocessor_call.go), so a ctx-derived goroutine
//     dies instantly and the download silently no-ops. Cancellation travels
//     only through h.cancel (stop button / supersede) via context.WithoutCancel.
//   - The renderer never names the install candidate. The handler remembers
//     what IT staged (path + SHA-256, recorded only from a successful staging
//     of the current generation); InstallStaged re-verifies dir/name/digest
//     before spawning the waiter. A compromised webview can at most press
//     "install" on what the app itself downloaded.

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"

	"go.uber.org/zap"

	"kafkaexplorer/internal/application"
)

// stagedAssetNameRe pins the install candidate to the release workflow's
// asset naming. The path lives in DataDir/updates and this shape — anything
// else the handler remembers is not ours to execute.
var stagedAssetNameRe = regexp.MustCompile(`^KafkaExplorer_Setup_[^/\\<>:"|?*]+\.exe$`)

// StageUpdate downloads the setup for repo in the background. requestID
// tags the progress events so the frontend filters its own stream.
// manifestSha is the digest embedded in latest.json (preferred — it rode
// the metadata download already); empty falls back to the .sha256 sidecar.
func (h *SystemHandler) StageUpdate(ctx context.Context, repo string, assetURL string, assetSize int64, manifestSha, requestID string) error {
	if runtime.GOOS != "windows" {
		return fmt.Errorf("自动更新当前仅支持 Windows")
	}
	h.mu.Lock()
	// Re-entry guard: a second download supersedes the first — both would
	// write the SAME <name>.part file and corrupt each other. Cancelling the
	// old registration makes its goroutine abort, clean up and exit.
	if h.cancel != nil {
		h.cancel()
	}
	h.stageGen++
	gen := h.stageGen
	// See the file-header hard rule: derive from WithoutCancel, never from
	// the call ctx — the call ctx dies when this method returns.
	runCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	h.cancel = cancel
	// A new stage invalidates any remembered install candidate: its staged
	// file gets housekept away by this download anyway.
	h.stagedPath, h.stagedSHA = "", ""
	h.mu.Unlock()

	go func() {
		defer func() {
			cancel()
			h.mu.Lock()
			// Clear OUR registration only: after a supersede, h.cancel is the
			// newer stage's cancel and must survive this goroutine's exit.
			if h.stageGen == gen {
				h.cancel = nil
			}
			h.mu.Unlock()
		}()
		staged, err := h.update.StageUpdate(runCtx, assetURL, assetSize, manifestSha, func(p application.Progress) {
			if h.emit != nil {
				h.emit("system:update:progress", map[string]any{
					"id": requestID, "bytes": p.Bytes, "total": p.Total,
					"route": p.Route, "failed": false,
				})
			}
		}, runCtx.Done())
		failed := err != nil
		stagedPath := staged
		if err == nil && staged == "" {
			// cancelled: done carries failed=false with an EMPTY staged
			// path — the frontend maps that exact pair to idle (AboutSection
			// done handler); it must NOT be read as a staged success.
			failed = false
		}
		if err != nil && staged == "" {
			stagedPath = ""
		}
		if err == nil && staged != "" {
			// Record the install candidate for InstallStaged. Recording is
			// generation-gated: a supersede that landed mid-download must
			// not re-arm a candidate for a generation that already lost.
			if sha, shaErr := h.update.SHA256File(staged); shaErr == nil {
				h.mu.Lock()
				if h.stageGen == gen {
					h.stagedPath, h.stagedSHA = staged, sha
				}
				h.mu.Unlock()
			} else {
				// No digest → the install gate could not verify → do not arm.
				h.log.Warn("staged installer digest unavailable; install candidate not armed",
					zap.String("id", requestID), zap.Error(shaErr))
				h.mu.Lock()
				if h.stageGen == gen {
					h.stagedPath, h.stagedSHA = "", ""
				}
				h.mu.Unlock()
			}
		}
		if h.emit != nil {
			payload := map[string]any{
				"id": requestID, "bytes": int64(0), "total": int64(0),
				"failed": failed, "staged": stagedPath,
				"error": errorText(err),
			}
			h.emit("system:update:done", payload)
		}
		h.log.Info("update stage finished",
			zap.String("id", requestID), zap.Bool("failed", failed),
			zap.String("staged", stagedPath), zap.Error(err))
	}()
	return nil
}

// CancelUpdate stops an in-flight stage download.
func (h *SystemHandler) CancelUpdate() {
	h.mu.Lock()
	cancel := h.cancel
	h.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// InstallStaged launches the silent-setup waiter; the caller then quits the
// app (quit chain injected by bootstrap). relaunch restarts the app after
// the installer finishes. The install candidate is the handler's OWN
// remembered staging — the renderer only presses the button.
func (h *SystemHandler) InstallStaged(relaunch bool) error {
	path, err := h.verifyStaged()
	if err != nil {
		return err
	}
	h.log.Info("update install", zap.String("path", path), zap.Bool("relaunch", relaunch))
	if err := h.update.WriteWaiter(path, relaunch); err != nil {
		return err
	}
	if h.quit != nil {
		h.quit()
	}
	return nil
}

// verifyStaged re-checks the remembered candidate: existence (the waiter's
// Start-Process would otherwise fail only AFTER this process quit), the
// app-owned updates dir + release asset name shape, and a fresh digest match
// (the file could have been touched between staging and install).
func (h *SystemHandler) verifyStaged() (string, error) {
	h.mu.Lock()
	path, want := h.stagedPath, h.stagedSHA
	h.mu.Unlock()
	if path == "" || want == "" {
		return "", fmt.Errorf("尚未暂存安装包，请先检查更新并下载")
	}
	if st, statErr := os.Stat(path); statErr != nil || st.IsDir() {
		return "", fmt.Errorf("暂存的安装包不存在或已被清理，请重新检查更新并下载")
	}
	dir, dirErr := h.update.UpdatesDir()
	if dirErr != nil {
		return "", fmt.Errorf("定位暂存目录失败: %w", dirErr)
	}
	if filepath.Clean(filepath.Dir(path)) != filepath.Clean(dir) ||
		!stagedAssetNameRe.MatchString(filepath.Base(path)) {
		return "", fmt.Errorf("暂存路径校验失败，请重新检查更新并下载")
	}
	got, err := h.update.SHA256File(path)
	if err != nil || got != want {
		return "", fmt.Errorf("暂存安装包校验失败，请重新检查更新并下载")
	}
	return path, nil
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
