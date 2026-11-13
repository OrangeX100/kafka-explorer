package wails

// Regression tests for the StageUpdate handler's re-entry guard and the
// InstallStaged existence gate (0.4.1/0.4.2 review round).

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"

	"kafkaexplorer/internal/appdir"
	"kafkaexplorer/internal/application"
)

// TestStageUpdateReentryCancelsPrevious: a second StageUpdate must
// supersede the first — both would otherwise write the SAME <name>.part
// file and corrupt each other. Supersede is observable server-side: the
// slow route's request context gets cancelled.
func TestStageUpdateReentryCancelsPrevious(t *testing.T) {
	firstCancelled := make(chan struct{})
	firstSeen := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(firstSeen) // the request is IN FLIGHT from here on
		<-r.Context().Done()
		close(firstCancelled)
	}))
	defer slow.Close()

	payload := make([]byte, 4)
	sum := sha256.Sum256(payload)
	manifestSHA := hex.EncodeToString(sum[:]) // embed the digest: no sidecar fetch needed
	fast := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(payload)
	}))
	defer fast.Close()

	h := NewSystemHandler(application.NewUpdateService("0.4.2", zap.NewNop()), zap.NewNop())
	if err := h.StageUpdate(context.Background(), "o/r", slow.URL+"/a.exe", 1<<20, "", "r1"); err != nil {
		t.Fatalf("first stage: %v", err)
	}
	// Wait until the first request actually reached the server: cancelling
	// before the request is sent would make the supersede unobservable.
	select {
	case <-firstSeen:
	case <-time.After(2 * time.Second):
		t.Fatal("first download never reached the server")
	}
	if err := h.StageUpdate(context.Background(), "o/r", fast.URL+"/b.exe", int64(len(payload)), manifestSHA, "r2"); err != nil {
		t.Fatalf("second stage: %v", err)
	}

	select {
	case <-firstCancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("REGRESSION: re-entry did not cancel the superseded download")
	}

	// The superseding download completes into the REAL updates dir — poll,
	// assert, and clean the artifact up (project precedent: the staging
	// tests share the process-global directory and clean what they create).
	dir, err := appdir.DataDir()
	if err != nil {
		t.Fatalf("data dir: %v", err)
	}
	dest := filepath.Join(dir, "updates", "b.exe")
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, statErr := os.Stat(dest); statErr == nil {
			_ = os.Remove(dest)
			_ = os.Remove(dest + ".part")
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("superseding download never completed")
}

// TestInstallStagedRejectsMissingFile: the existence gate must fail NOW
// with an actionable message — the old path spawned a waiter whose
// Start-Process would die after this process quit, leaving only an err.log.
func TestInstallStagedRejectsMissingFile(t *testing.T) {
	h := NewSystemHandler(application.NewUpdateService("0.4.2", zap.NewNop()), zap.NewNop())
	if err := h.InstallStaged(filepath.Join(t.TempDir(), "missing.exe"), false); err == nil {
		t.Fatal("missing staged file must be rejected before spawning a waiter")
	} else if !strings.Contains(err.Error(), "不存在") {
		t.Fatalf("friendly existence error expected, got: %v", err)
	}
}
