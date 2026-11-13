package application

// Locks the checksum route-aggregation semantics: a 404 on ONE route is not
// proof of absence — the downgrade only triggers when EVERY route confirms
// absence, and any hard failure beats a downgrade.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchChecksumMixed404AndFailure(t *testing.T) {
	// direct: 404 (hijacked/unconfigured); mirror: unreachable — the mixed
	// case must NOT downgrade to size-only.
	direct := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer direct.Close()
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer down.Close()

	urls := []string{direct.URL + "/a.exe.sha256", down.URL + "/a.exe.sha256"}
	want, status := fetchExpectedChecksum(context.Background(), urls)
	if status != checksumFailed || want != "" {
		t.Fatalf("mixed 404+failure must hard-fail, got %q/%v", want, status)
	}
}

func TestFetchChecksumAll404IsMissing(t *testing.T) {
	a := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer a.Close()
	b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer b.Close()

	_, status := fetchExpectedChecksum(context.Background(), []string{a.URL + "/s", b.URL + "/s"})
	if status != checksumMissing {
		t.Fatalf("all-404 should be checksumMissing, got %v", status)
	}
}

func TestFetchChecksumMirrorRescues(t *testing.T) {
	// direct 404 + mirror serving a VALID digest → the digest wins (the
	// hijacked-404 case the aggregation fix exists for).
	digest := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	direct := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer direct.Close()
	mirror := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(digest + "  a.exe\n"))
	}))
	defer mirror.Close()

	want, status := fetchExpectedChecksum(context.Background(), []string{direct.URL + "/s", mirror.URL + "/s"})
	if status != checksumOK || want != digest {
		t.Fatalf("mirror must rescue a 404 direct: %q/%v", want, status)
	}
}
