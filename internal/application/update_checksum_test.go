package application

// Regression tests for fetchExpectedChecksum's aggregation rule — the 0.4.2
// fix. A single 404 among mixed failures is NOT proof of absence: only when
// EVERY route answers 404 does the legacy size-only downgrade apply, and any
// other failure combination is a hard fail. This matrix locks the exact
// classification so a refactor cannot re-open the "hijacked direct route
// returns 404 → silent downgrade" hole.

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"go.uber.org/zap"
)

// checksumFixtureServer answers each request by its ?case= query: "404"
// (route has no sidecar), "err" (abrupt connection close → transport
// error), "ok" (valid 64-hex sidecar), "bad" (malformed 63-hex body),
// "upper" (uppercase valid digest).
func checksumFixtureServer() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("case") {
		case "404":
			http.NotFound(w, r)
		case "err":
			hj, canHijack := w.(http.Hijacker)
			if !canHijack {
				http.Error(w, "no hijack", http.StatusInternalServerError)
				return
			}
			conn, _, hijackErr := hj.Hijack()
			if hijackErr == nil {
				_ = conn.Close() // abrupt close: the client sees a transport error
			}
		case "ok":
			fmt.Fprint(w, strings.Repeat("a", 64))
		case "bad":
			fmt.Fprint(w, strings.Repeat("a", 63))
		case "upper":
			fmt.Fprint(w, strings.ToUpper(strings.Repeat("b", 64)))
		}
	}))
}

func TestFetchExpectedChecksumAggregation(t *testing.T) {
	srv := checksumFixtureServer()
	defer srv.Close()
	route := func(c string) string { return srv.URL + "/x.sha256?case=" + c }

	cases := []struct {
		name   string
		routes []string
		status checksumStatus
		want   string
	}{
		{"all routes 404 → legacy downgrade (absence proven)", []string{route("404"), route("404"), route("404")}, checksumMissing, ""},
		{"404 then transport error → hard fail (mixed is NOT absence)", []string{route("404"), route("err")}, checksumFailed, ""},
		{"transport error first, then 404s → hard fail", []string{route("err"), route("404"), route("404")}, checksumFailed, ""},
		{"all transport errors → hard fail", []string{route("err"), route("err")}, checksumFailed, ""},
		{"404 then a valid sidecar → normal verification", []string{route("404"), route("ok")}, checksumOK, strings.Repeat("a", 64)},
		{"malformed 63-hex body → hard fail", []string{route("bad")}, checksumFailed, ""},
		{"uppercase digest → normalized to lowercase", []string{route("upper")}, checksumOK, strings.Repeat("b", 64)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, status := fetchExpectedChecksum(context.Background(), tc.routes)
			if status != tc.status {
				t.Fatalf("status = %d, want %d", status, tc.status)
			}
			if got != tc.want {
				t.Fatalf("digest = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestStageUpdateLegacyNoSidecarDowngrades pins the END-TO-END legacy path:
// a release with no sidecar anywhere stages with size-only verification —
// and the decision is logged (nil logger would panic; production always
// carries one).
func TestStageUpdateLegacyNoSidecarDowngrades(t *testing.T) {
	const total = int64(512)
	payload := make([]byte, total)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".sha256") {
			http.NotFound(w, r) // every route (only direct here) confirms absence
			return
		}
		_, _ = w.Write(payload)
	}))
	defer srv.Close()

	svc := NewUpdateService("0.4.2", zap.NewNop())
	staged, err := svc.StageUpdate(t.Context(), srv.URL+"/asset.exe", total, "", func(Progress) {}, make(chan struct{}))
	if err != nil {
		t.Fatalf("legacy downgrade must stage successfully, got: %v", err)
	}
	if staged == "" {
		t.Fatal("legacy downgrade returned no path")
	}
	if st, statErr := os.Stat(staged); statErr != nil || st.Size() != total {
		t.Fatalf("staged file wrong (size %v err %v)", func() any {
			if statErr == nil {
				return st.Size()
			}
			return -1
		}(), statErr)
	}
	_ = os.Remove(staged)
}

// TestStageUpdateMalformedSidecarHardFails pins the mirror case: a sidecar
// that answers 200 with garbage is "verification unobtainable" — the install
// must abort, never fall back to size-only.
func TestStageUpdateMalformedSidecarHardFails(t *testing.T) {
	const total = int64(64)
	payload := make([]byte, total)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".sha256") {
			fmt.Fprint(w, "short") // 200 but not a 64-hex digest
			return
		}
		_, _ = w.Write(payload)
	}))
	defer srv.Close()

	svc := NewUpdateService("0.4.2", zap.NewNop())
	_, err := svc.StageUpdate(t.Context(), srv.URL+"/asset.exe", total, "", func(Progress) {}, make(chan struct{}))
	if err == nil {
		t.Fatal("malformed sidecar must abort the install")
	}
	if !strings.Contains(err.Error(), "完整性校验") {
		t.Fatalf("hard-fail error should say so: %v", err)
	}
}

// TestWaiterScriptBodyPinsTheTwoTraps: the race-proof Get-Process flag and
// the single-quote escaping of the embedded log path (a broken script here
// meant "app quits, nothing installs, nothing logged").
func TestWaiterScriptBodyPinsTheTwoTraps(t *testing.T) {
	body := waiterScriptBody(`C:\Users\o'brien\AppData\update_waiter.err.log`)
	if !strings.Contains(body, "Get-Process -Id $waitFor -ErrorAction SilentlyContinue") {
		t.Fatal("REGRESSION: wait loop lost the SilentlyContinue race guard")
	}
	if !strings.Contains(body, `o''brien`) {
		t.Fatalf("REGRESSION: log path quotes not doubled: %q", body)
	}
	if strings.Contains(body, `o'brien'`) {
		t.Fatal("escaped quote leaked into the embedded path")
	}
}
