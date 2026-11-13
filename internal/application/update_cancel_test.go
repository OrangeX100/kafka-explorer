package application

// Regression tests for the staging cancellation fix: a user pressing stop
// used to be swallowed (the old code read an always-nil shadowed error) and
// renamed the TRUNCATED .part into the installer. Every cancellation path
// must now (a) return errCancelled up through StageUpdate's silent no-op,
// (b) leave no dest file, (c) leave no .part file.

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// slowServer sends total bytes with pauses long enough that the download is
// guaranteed still in flight when the test flips the cancel channel.
func slowServer(t *testing.T, total int64) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		chunk := make([]byte, 32*1024)
		for sent := int64(0); sent < total; sent += int64(len(chunk)) {
			if _, err := w.Write(chunk); err != nil {
				return
			}
			time.Sleep(300 * time.Millisecond) // crawl: ~100KB/s
		}
	}))
}

func stagedPaths(t *testing.T) (dest, part string, cleanup func()) {
	t.Helper()
	dir := t.TempDir()
	dest = filepath.Join(dir, "setup.exe")
	part = dest + ".part"
	return dest, part, func() {
		_ = os.Remove(dest)
		_ = os.Remove(part)
	}
}

func TestStageUpdateCancelMidDownload(t *testing.T) {
	const total = int64(1 << 20) // 1MB
	srv := slowServer(t, total)
	defer srv.Close()

	dest, part, cleanup := stagedPaths(t)
	defer cleanup()

	cancelled := make(chan struct{})
	go func() {
		time.Sleep(600 * time.Millisecond) // ~200KB downloaded, far from done
		close(cancelled)
	}()

	svc := NewUpdateService("0.2.0")
	staged, err := svc.StageUpdate(t.Context(), srv.URL, total, "", func(Progress) {}, cancelled)

	// Cancellation is a silent no-op: nil error, nil staged path.
	if err != nil {
		t.Fatalf("cancel must be a silent no-op, got error: %v", err)
	}
	if staged != "" {
		t.Fatalf("cancelled staging must return no path, got %q", staged)
	}
	// THE regression: the truncated .part must never become the installer.
	if _, statErr := os.Stat(dest); statErr == nil {
		t.Fatal("REGRESSION: truncated .part was renamed to dest on cancel")
	}
	if _, statErr := os.Stat(part); statErr == nil {
		t.Fatal(".part file was left behind after cancel")
	}
}

func TestStageUpdateCancelWhileConnecting(t *testing.T) {
	// A server that never answers: the request is in-flight (connecting/
	// waiting for headers) when the cancel fires.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(5 * time.Second) // far beyond the test's 0.5s cancel
	}))
	defer srv.Close()

	dest, part, cleanup := stagedPaths(t)
	defer cleanup()

	cancelled := make(chan struct{})
	go func() {
		time.Sleep(500 * time.Millisecond)
		close(cancelled)
	}()

	svc := NewUpdateService("0.2.0")
	svc.client = &http.Client{Timeout: 60 * time.Second}
	staged, err := svc.StageUpdate(t.Context(), srv.URL, 1<<20, "", func(Progress) {}, cancelled)

	if err != nil {
		t.Fatalf("cancel-while-connecting must be silent, got error: %v", err)
	}
	if staged != "" {
		t.Fatalf("expected no staged path, got %q", staged)
	}
	if _, statErr := os.Stat(dest); statErr == nil {
		t.Fatal("dest must not exist after connect-phase cancel")
	}
	if _, statErr := os.Stat(part); statErr == nil {
		t.Fatal(".part must not exist after connect-phase cancel")
	}
}

func TestStageUpdateCompleteStillWorks(t *testing.T) {
	// The happy path must keep its gates: full body + size match + matching
	// sidecar stages fine.
	const total = int64(1 << 20)
	full := make([]byte, total)
	sum := sha256.Sum256(full)
	sidecar := hex.EncodeToString(sum[:]) + "  asset.exe\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".sha256") {
			_, _ = w.Write([]byte(sidecar))
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(full)
	}))
	defer srv.Close()

	// dest lives in the REAL updates dir (updatesDir is process-global) —
	// assert on the returned path and clean the artifact up.
	svc := NewUpdateService("0.2.0")
	staged, err := svc.StageUpdate(t.Context(), srv.URL+"/asset.exe", total, "", func(Progress) {}, make(chan struct{}))
	if err != nil {
		t.Fatalf("complete download: %v", err)
	}
	if staged == "" {
		t.Fatal("expected a staged path")
	}
	if _, statErr := os.Stat(staged); statErr != nil {
		t.Fatalf("staged file missing: %v", statErr)
	}
	_ = os.Remove(staged)
}

func TestStageUpdateWrongSizeIsRejected(t *testing.T) {
	// Server lies short: size gate must keep rejecting even though the body
	// reached EOF (the old cancel bug class adjacent to this gate).
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(make([]byte, 100)) // promised 1MB, sent 100B
	}))
	defer srv.Close()

	dest, _, cleanup := stagedPaths(t)
	defer cleanup()

	cancelled := make(chan struct{})
	svc := NewUpdateService("0.2.0")
	_, err := svc.StageUpdate(t.Context(), srv.URL, 1<<20, "", func(Progress) {}, cancelled)
	if err == nil {
		t.Fatal("short body must be rejected by the size gate")
	}
	if !strings.Contains(err.Error(), "下载不完整") {
		t.Fatalf("size-gate error should say so: %v", err)
	}
	if _, statErr := os.Stat(dest); statErr == nil {
		t.Fatal("rejected download must not be renamed to dest")
	}
}
