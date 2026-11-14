package wails

// Regression tests for the StageUpdate handler (044/045 review rounds):
// re-entry guard, call-ctx independence (wails cancels the binding-call
// context when the method returns), and the InstallStaged verification
// gate that refuses to trust the renderer with an install path.

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
	dir, err := appdirUpdatesDir()
	if err != nil {
		t.Fatalf("data dir: %v", err)
	}
	dest := filepath.Join(dir, "b.exe")
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

// appdirUpdatesDir resolves the real staged-installer directory (test
// helper mirroring the wails test suite's process-global dir usage).
func appdirUpdatesDir() (string, error) {
	return application.NewUpdateService("t", zap.NewNop()).UpdatesDir()
}

// TestStageUpdateSurvivesCallCtxCancellation pins the 045 P0-1 fix: wails
// cancels a binding call's context the moment the method RETURNS, so a
// download goroutine that derives from it dies instantly and the UI sees a
// silent cancel. The call ctx here is cancelled right after StageUpdate
// returns — exactly the production sequence — and the download must still
// complete and arm the install candidate.
func TestStageUpdateSurvivesCallCtxCancellation(t *testing.T) {
	payload := []byte("call-ctx independence payload")
	sum := sha256.Sum256(payload)
	manifestSHA := hex.EncodeToString(sum[:])
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(payload)
	}))
	defer srv.Close()

	var donePayload map[string]any
	h := NewSystemHandler(application.NewUpdateService("0.4.5", zap.NewNop()), zap.NewNop())
	h.SetEmitter(func(topic string, data ...any) {
		if topic != "system:update:done" || len(data) == 0 {
			return
		}
		if m, ok := data[0].(map[string]any); ok && m["id"] == "r1" {
			donePayload = m
		}
	})

	callCtx, callCancel := context.WithCancel(context.Background())
	if err := h.StageUpdate(callCtx, "o/r", srv.URL+"/KafkaExplorer_Setup_0.4.5.exe", int64(len(payload)), manifestSHA, "r1"); err != nil {
		t.Fatalf("stage: %v", err)
	}
	callCancel() // the wails processor does this on method return

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if donePayload != nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if donePayload == nil {
		t.Fatal("done event never arrived")
	}
	if failed, _ := donePayload["failed"].(bool); failed {
		t.Fatalf("download failed under a cancelled call ctx: %v", donePayload["error"])
	}
	staged, _ := donePayload["staged"].(string)
	if staged == "" {
		t.Fatal("REGRESSION (P0-1): download died with the call ctx — done reported the cancelled pair")
	}
	defer os.Remove(staged)

	// The candidate must also be ARMED for InstallStaged (digest recorded).
	if h.stagedPath == "" || h.stagedSHA == "" {
		t.Fatal("install candidate was not armed after a successful stage")
	}
	got, err := h.update.SHA256File(h.stagedPath)
	if err != nil || got != h.stagedSHA {
		t.Fatalf("armed digest mismatch: %v vs %v (%v)", got, h.stagedSHA, err)
	}
}

// TestInstallStagedWithoutCandidate: the renderer presses install without a
// staged download — refuse, never spawn a waiter.
func TestInstallStagedWithoutCandidate(t *testing.T) {
	h := NewSystemHandler(application.NewUpdateService("0.4.5", zap.NewNop()), zap.NewNop())
	if err := h.InstallStaged(false); err == nil {
		t.Fatal("install without a staged candidate must be rejected")
	} else if !strings.Contains(err.Error(), "尚未暂存") {
		t.Fatalf("friendly no-candidate error expected, got: %v", err)
	}
}

// TestVerifyStagedMatrix pins the four gates: existence, the app-owned
// updates dir + release asset name shape, and a fresh digest match. A
// compromised renderer can only ever press "install" — anything it names
// or plants outside this shape is refused here.
func TestVerifyStagedMatrix(t *testing.T) {
	dir, err := appdirUpdatesDir()
	if err != nil {
		t.Fatalf("updates dir: %v", err)
	}
	_ = os.MkdirAll(dir, 0o755)
	payload := []byte("verify-matrix payload")
	sum := sha256.Sum256(payload)
	goodSHA := hex.EncodeToString(sum[:])

	outside := filepath.Join(t.TempDir(), "KafkaExplorer_Setup_9.9.9.exe")
	_ = os.WriteFile(outside, payload, 0o600)
	misnamed := filepath.Join(dir, "evil.exe")
	_ = os.WriteFile(misnamed, payload, 0o600)
	defer os.Remove(misnamed)
	tampered := filepath.Join(dir, "KafkaExplorer_Setup_9.9.9-tampered.exe")
	_ = os.WriteFile(tampered, []byte("tampered"), 0o600)
	defer os.Remove(tampered)
	valid := filepath.Join(dir, "KafkaExplorer_Setup_9.9.9.exe")
	_ = os.WriteFile(valid, payload, 0o600)
	defer os.Remove(valid)

	cases := []struct {
		name      string
		path, sha string
		wantErr   string
	}{
		{"missing file", filepath.Join(dir, "KafkaExplorer_Setup_gone.exe"), goodSHA, "不存在"},
		{"outside updates dir", outside, goodSHA, "暂存路径校验失败"},
		{"wrong asset name", misnamed, goodSHA, "暂存路径校验失败"},
		{"digest mismatch", tampered, goodSHA, "校验失败"},
		{"valid candidate", valid, goodSHA, ""},
	}
	for _, tc := range cases {
		h := NewSystemHandler(application.NewUpdateService("0.4.5", zap.NewNop()), zap.NewNop())
		h.stagedPath, h.stagedSHA = tc.path, tc.sha
		got, err := h.verifyStaged()
		if tc.wantErr == "" {
			if err != nil {
				t.Fatalf("%s: unexpected error %v", tc.name, err)
			}
			if got != tc.path {
				t.Fatalf("%s: path = %q", tc.name, got)
			}
			continue
		}
		if err == nil {
			t.Fatalf("%s: expected refusal, got %q", tc.name, got)
		}
		if !strings.Contains(err.Error(), tc.wantErr) {
			t.Fatalf("%s: error %q does not mention %q", tc.name, err.Error(), tc.wantErr)
		}
	}
}
