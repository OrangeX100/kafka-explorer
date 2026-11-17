package application

// Regression tests for the F1 multi-connection segmented download
// (045 round-5 F1): a Range-aware fixture must be served via parallel
// segments that reassemble byte-exactly, a Range-ignoring fixture must
// fall back to single-stream, and the produced file must pass the same
// size + SHA gates as any staged installer.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// rangeServer serves a fixture with proper Range support (206 + slices).
func rangeServer(t *testing.T, data []byte) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rng := r.Header.Get("Range")
		if rng == "" {
			w.Header().Set("Content-Length", fmt.Sprint(len(data)))
			w.Header().Set("Accept-Ranges", "bytes")
			_, _ = w.Write(data)
			return
		}
		// parse "bytes=A-B"
		var a, b int64
		if _, err := fmt.Sscanf(strings.TrimPrefix(rng, "bytes="), "%d-%d", &a, &b); err != nil {
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}
		if a < 0 || b >= int64(len(data)) || a > b {
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", a, b, len(data)))
		w.Header().Set("Content-Length", fmt.Sprint(b-a+1))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(data[a : b+1])
	}))
}

func TestTryRouteSegmentedDownload(t *testing.T) {
	// 3MB pseudo-random payload: spans multiple segments, verifiable by SHA.
	data := make([]byte, 3<<20)
	if _, err := rand.Read(data); err != nil {
		t.Fatal(err)
	}
	srv := rangeServer(t, data)
	defer srv.Close()

	manifestSHA := hex.EncodeToString(func() []byte {
		h := sha256.Sum256(data)
		return h[:]
	}())

	svc := &UpdateService{}
	staged, err := svc.StageUpdate(t.Context(), srv.URL+"/KafkaExplorer_Setup_0.4.9.exe", int64(len(data)), manifestSHA, func(Progress) {}, make(chan struct{}))
	if err != nil {
		t.Fatalf("segmented stage failed: %v", err)
	}
	defer os.Remove(staged)

	got, err := os.ReadFile(staged)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(got)
	if hex.EncodeToString(sum[:]) != manifestSHA {
		t.Fatal("reassembled file does not match the fixture digest")
	}
}

// TestTryRouteSingleStreamFallback: a server that IGNORES the Range header
// (200 + full body) must be served via the legacy single-stream path.
func TestTryRouteSingleStreamFallback(t *testing.T) {
	payload := []byte(strings.Repeat("single-stream", 1000))
	sum := sha256.Sum256(payload)
	manifestSHA := hex.EncodeToString(sum[:])
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "" {
			t.Logf("fixture: ignoring Range on purpose")
		}
		w.Header().Set("Content-Length", fmt.Sprint(len(payload)))
		_, _ = w.Write(payload) // 200, full body: Range ignored
	}))
	defer srv.Close()

	svc := &UpdateService{}
	staged, err := svc.StageUpdate(t.Context(), srv.URL+"/KafkaExplorer_Setup_0.4.9.exe", int64(len(payload)), manifestSHA, func(Progress) {}, make(chan struct{}))
	if err != nil {
		t.Fatalf("single-stream fallback failed: %v", err)
	}
	defer os.Remove(staged)
	got, _ := os.ReadFile(staged)
	if string(got) != string(payload) {
		t.Fatal("fallback content mismatch")
	}
}

func TestStripConfluentIndexesRangeProbeStillWorks(t *testing.T) {
	// sanity: the guard test hook keeps tests staging from httptest.
	restore := SetAssetURLGuardForTests(nil)
	defer restore()
	if err := assetURLGuard("http://anything/x.exe"); err != nil {
		t.Fatalf("test guard must admit all: %v", err)
	}
}
