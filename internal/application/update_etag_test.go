package application

// Update-check source tests against LOCAL fixture servers:
// 1) manifest parse: latest.json shape → UpdateCheck (update claimed only
//    when the tag is newer; missing tagName is a friendly error);
// 2) fallback path: NO manifest anywhere → the API+ETag flow answers —
//    first call caches body+ETag, the second takes the 304 branch (GitHub
//    does not count 304s against the 60 req/hour budget);
// 3) API rate-limited → the error carries the reset minutes.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

const fixtureReleaseBody = `{"tag_name":"v9.9.9","html_url":"https://example.com/r","body":"notes",
	"assets":[{"name":"KafkaExplorer_Setup_9.9.9.exe","size":123,"browser_download_url":"https://example.com/dl"}]}`

const fixtureManifest = `{"tagName":"v9.9.9","notes":"manifest notes","assetName":"KafkaExplorer_Setup_9.9.9.exe","assetSize":456,"assetSHA256":"abc123"}`

func TestParseManifest(t *testing.T) {
	got, err := parseManifest("0.2.0", "owner/repo", []byte(fixtureManifest))
	if err != nil {
		t.Fatalf("parseManifest: %v", err)
	}
	if got.Latest != "9.9.9" || !got.HasUpdate || got.AssetName != "KafkaExplorer_Setup_9.9.9.exe" || got.AssetSize != 456 {
		t.Fatalf("manifest parse wrong: %+v", got)
	}
	if got.URL != "https://github.com/owner/repo/releases/tag/v9.9.9" {
		t.Fatalf("release URL wrong: %s", got.URL)
	}
	if got.AssetSha256 != "abc123" {
		t.Fatalf("manifest sha not carried: %q", got.AssetSha256)
	}
	notUpd, err := parseManifest("9.9.9", "owner/repo", []byte(fixtureManifest))
	if err != nil {
		t.Fatalf("parseManifest same: %v", err)
	}
	if notUpd.HasUpdate {
		t.Fatalf("same version must not claim update: %+v", notUpd)
	}
	if _, err := parseManifest("0.2.0", "owner/repo", []byte(`{"assetName":"x"}`)); err == nil || !strings.Contains(err.Error(), "tagName") {
		t.Fatalf("missing tagName should error: %v", err)
	}
}

func TestUpdateCheckFallbackToAPIAndEtag(t *testing.T) {
	// API server: first call 200+ETag, later calls 304 (cache hit path).
	var apiHits int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&apiHits, 1)
		w.Header().Set("Content-Type", "application/json")
		switch n {
		case 1:
			w.Header().Set("ETag", `"xyz"`)
			_, _ = w.Write([]byte(fixtureReleaseBody))
		default:
			if r.Header.Get("If-None-Match") == "" {
				t.Errorf("api call %d missing If-None-Match", n)
			}
			w.WriteHeader(http.StatusNotModified)
		}
	}))
	defer api.Close()

	// Static world: the manifest routes all 404 → Check falls back to API.
	svc := NewUpdateService("0.2.0")
	svc.baseURL = api.URL

	first, err := svc.Check(t.Context(), "owner/repo")
	if err != nil {
		t.Fatalf("first check via fallback: %v", err)
	}
	if !first.HasUpdate || first.Latest != "9.9.9" {
		t.Fatalf("fallback result wrong: %+v", first)
	}
	second, err := svc.Check(t.Context(), "owner/repo")
	if err != nil {
		t.Fatalf("second check (304 path): %v", err)
	}
	if second.Latest != first.Latest {
		t.Fatalf("cached result diverged: %+v vs %+v", first, second)
	}
}

func TestUpdateCheckRateLimitMessage(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-RateLimit-Reset", "2000000000")
		w.WriteHeader(http.StatusForbidden)
	}))
	defer api.Close()

	svc := NewUpdateService("0.2.0")
	svc.baseURL = api.URL
	_, err := svc.Check(t.Context(), "owner/repo")
	if err == nil {
		t.Fatal("expected rate-limit error")
	}
	if !strings.Contains(err.Error(), "分钟") {
		t.Fatalf("error should carry the reset minutes: %v", err)
	}
}
