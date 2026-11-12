package application

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

// Locks the route-expansion rule: only GitHub release-download URLs get
// mirror candidates (the accelerator path form is prefix + full URL);
// anything else is used as-is.
func TestDownloadCandidates(t *testing.T) {
	gh := "https://github.com/OrangeX100/kafka-explorer/releases/download/v0.2.0/KafkaExplorer_Setup_0.2.0.exe"
	got := downloadCandidates(gh)
	if len(got) != 3 {
		t.Fatalf("github url: got %d candidates, want 3", len(got))
	}
	if got[0] != gh || got[1] != "https://ghfast.top/"+gh || got[2] != "https://gh-proxy.com/"+gh {
		t.Fatalf("github candidates wrong: %v", got)
	}
	other := "https://mirror.example.com/setup.exe"
	got = downloadCandidates(other)
	if len(got) != 1 || got[0] != other {
		t.Fatalf("non-github url must stay single-route: %v", got)
	}
}

// tryRoute must abandon a route that never sends the first byte within
// the slow-start window — the very failure CN networks produce against
// direct GitHub, and the reason the mirror fallback exists.
func TestTryRouteAbandonsDeadRoute(t *testing.T) {
	slowStartWindow = 800 * time.Millisecond
	stallTimeout = 800 * time.Millisecond
	defer func() { slowStartWindow = 8 * time.Second; stallTimeout = 15 * time.Second }()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(2 * time.Second) // far beyond slowStartWindow
		w.Write([]byte("late"))
	}))
	defer srv.Close()

	s := &UpdateService{}
	u, _ := url.Parse(srv.URL)
	_ = u
	cancelled := make(chan struct{})
	started := time.Now()
	_, err := s.tryRoute(context.Background(), srv.URL+"/asset.exe", 4, "unused.part",
		func(Progress) {}, cancelled)
	if err == nil {
		t.Fatal("dead route was not abandoned")
	}
	if time.Since(started) > 3*time.Second {
		t.Fatalf("abandon took too long: %v", time.Since(started))
	}
}

// A healthy route must complete: the happy path of the route runner.
func TestTryRouteCompletes(t *testing.T) {
	body := make([]byte, 1<<20) // 1MB, above slowStartBytes
	for i := range body {
		body[i] = byte(i % 251)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write(body)
	}))
	defer srv.Close()

	s := &UpdateService{}
	part := t.TempDir() + "/part"
	_, err := s.tryRoute(context.Background(), srv.URL, int64(len(body)), part,
		func(Progress) {}, make(chan struct{}))
	if err != nil {
		t.Fatalf("healthy route failed: %v", err)
	}
}
