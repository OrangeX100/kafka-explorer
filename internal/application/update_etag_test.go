package application

// Update-check rate-limit fix, exercised against a LOCAL fixture server:
// 1) the first check caches the body + ETag;
// 2) the second check sends If-None-Match and takes the 304 path — GitHub
//    does not count 304s against the 60 req/hour budget, so repeated
//    "check update" clicks stay free;
// 3) a 403 without quota still surfaces the reset minutes.

import (
	"net/http"
	"strings"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestUpdateCheckEtagCache(t *testing.T) {
	body := []byte(`{"tag_name":"v9.9.9","html_url":"https://example.com/r","body":"notes",
		"assets":[{"name":"KafkaExplorer_Setup_9.9.9.exe","size":123,"browser_download_url":"https://example.com/dl"}]}`)
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&hits, 1)
		w.Header().Set("Content-Type", "application/json")
		switch n {
		case 1:
			w.Header().Set("ETag", `"abc123"`)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(body)
		default:
			if r.Header.Get("If-None-Match") != `"abc123"` {
				t.Errorf("request %d missing If-None-Match", n)
			}
			w.WriteHeader(http.StatusNotModified)
		}
	}))
	defer srv.Close()

	svc := NewUpdateService("0.2.0")
	svc.baseURL = srv.URL

	first, err := svc.Check(t.Context(), "owner/repo")
	if err != nil {
		t.Fatalf("first check: %v", err)
	}
	if !first.HasUpdate || first.AssetURL != "https://example.com/dl" {
		t.Fatalf("first result wrong: %+v", first)
	}

	second, err := svc.Check(t.Context(), "owner/repo")
	if err != nil {
		t.Fatalf("second check (304 path): %v", err)
	}
	if second.Latest != first.Latest || second.AssetURL != first.AssetURL {
		t.Fatalf("cached result diverged: %+v vs %+v", first, second)
	}
	if atomic.LoadInt32(&hits) != 2 {
		t.Fatalf("expected 2 server hits, got %d", hits)
	}
}

func TestUpdateCheckRateLimitMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-RateLimit-Reset", "2000000000")
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	svc := NewUpdateService("0.2.0")
	svc.baseURL = srv.URL
	_, err := svc.Check(t.Context(), "owner/repo")
	if err == nil {
		t.Fatal("expected rate-limit error")
	}
	if !strings.Contains(err.Error(), "分钟") {
		t.Fatalf("error should carry the reset minutes: %v", err)
	}
}
