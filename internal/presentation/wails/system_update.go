package wails

// System update staging + install (Windows): the About page drives these
// after a successful CheckUpdate that carried a setup asset.
//
// StageUpdate runs the download in the background and reports progress on
// the wails event `system:update:progress` ({bytes,total,done,failed}) —
// human-reading rate ticks (150ms), well below the WS-threshold class.
// InstallStaged spawns the silent-setup waiter and then quits the app; the
// waiter installs and (optionally) relaunches.

import (
	"context"
	"fmt"
	"runtime"

	"go.uber.org/zap"

	"kafkaexplorer/internal/application"
)

// StageUpdate downloads the setup for repo in the background. requestID
// tags the progress events so the frontend filters its own stream.
// manifestSha is the digest embedded in latest.json (preferred — it rode
// the metadata download already); empty falls back to the .sha256 sidecar.
func (h *SystemHandler) StageUpdate(ctx context.Context, repo string, assetURL string, assetSize int64, manifestSha, requestID string) error {
	if runtime.GOOS != "windows" {
		return fmt.Errorf("自动更新当前仅支持 Windows")
	}
	ctx, cancel := context.WithCancel(ctx)
	h.mu.Lock()
	h.cancel = cancel
	h.mu.Unlock()

	go func() {
		defer func() {
			cancel()
			h.mu.Lock()
			h.cancel = nil
			h.mu.Unlock()
		}()
		staged, err := h.update.StageUpdate(ctx, assetURL, assetSize, manifestSha, func(p application.Progress) {
			if h.emit != nil {
				h.emit("system:update:progress", map[string]any{
					"id": requestID, "bytes": p.Bytes, "total": p.Total,
					"route": p.Route, "failed": false,
				})
			}
		}, ctx.Done())
		failed := err != nil
		stagedPath := staged
		if err == nil && staged == "" {
			failed = false // cancelled — frontend resets via the empty id-less done
		}
		if err != nil && staged == "" {
			stagedPath = ""
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
// the installer finishes.
func (h *SystemHandler) InstallStaged(stagedPath string, relaunch bool) error {
	h.log.Info("update install", zap.String("path", stagedPath), zap.Bool("relaunch", relaunch))
	if err := h.update.WriteWaiter(stagedPath, relaunch); err != nil {
		return err
	}
	if h.quit != nil {
		h.quit()
	}
	return nil
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
