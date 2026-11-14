package application

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

	"kafkaexplorer/internal/buildinfo"
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
	cancelled := make(chan struct{})
	started := time.Now()
	_, err := s.tryRoute(context.Background(), srv.URL+"/asset.exe", 4, "unused.part", "",
		func(Progress) {}, cancelled)
	if err == nil {
		t.Fatal("dead route was not abandoned")
	}
	if time.Since(started) > 3*time.Second {
		t.Fatalf("abandon took too long: %v", time.Since(started))
	}
}

// A healthy route must complete: the happy path of the route runner, with
// its sidecar served by the same fixture (the .sha256 request is the asset
// URL + ".sha256").
func TestTryRouteCompletes(t *testing.T) {
	body := make([]byte, 1<<20) // 1MB, above slowStartBytes
	for i := range body {
		body[i] = byte(i % 251)
	}
	sum := sha256.Sum256(body)
	sidecar := hex.EncodeToString(sum[:]) + "  part"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".sha256") {
			_, _ = w.Write([]byte(sidecar))
			return
		}
		w.Write(body)
	}))
	defer srv.Close()

	s := &UpdateService{}
	part := t.TempDir() + "/part"
	_, err := s.tryRoute(context.Background(), srv.URL+"/asset.exe", int64(len(body)), part, "",
		func(Progress) {}, make(chan struct{}))
	if err != nil {
		t.Fatalf("healthy route failed: %v", err)
	}
}

// TestStageUpdateHousekeepingOnlyTouchesOurArtifacts pins the 045 narrowing:
// the pre-download cleanup removes ONLY release-asset shaped installers and
// .part leftovers — the old wipe-everything pass silently deleted anything
// else the user parked in DataDir/updates.
func TestStageUpdateHousekeepingOnlyTouchesOurArtifacts(t *testing.T) {
	payload := []byte("housekeeping payload")
	sum := sha256.Sum256(payload)
	manifestSHA := hex.EncodeToString(sum[:])
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(payload)
	}))
	defer srv.Close()

	dir, err := updatesDir()
	if err != nil {
		t.Fatalf("updates dir: %v", err)
	}
	_ = os.MkdirAll(dir, 0o755)
	keep := filepath.Join(dir, "user-notes.txt")
	oldSetup := filepath.Join(dir, stagedSetupPrefix+"9.9.9.exe")
	strayPart := filepath.Join(dir, "leftover.part")
	if err := os.WriteFile(keep, []byte("keep me"), 0o600); err != nil {
		t.Fatalf("seed keep file: %v", err)
	}
	if err := os.WriteFile(oldSetup, []byte("old"), 0o600); err != nil {
		t.Fatalf("seed old setup: %v", err)
	}
	if err := os.WriteFile(strayPart, []byte("stray"), 0o600); err != nil {
		t.Fatalf("seed stray part: %v", err)
	}
	defer os.Remove(keep)

	svc := &UpdateService{}
	staged, err := svc.StageUpdate(t.Context(), srv.URL+"/KafkaExplorer_Setup_0.0.0-test.exe", int64(len(payload)), manifestSHA, func(Progress) {}, make(chan struct{}))
	if err != nil {
		t.Fatalf("stage: %v", err)
	}
	defer os.Remove(staged)

	if _, err := os.Stat(keep); err != nil {
		t.Fatal("REGRESSION: user file in updates dir was deleted by housekeeping")
	}
	if _, err := os.Stat(oldSetup); !os.IsNotExist(err) {
		t.Fatal("old staged setup was not housekept")
	}
	if _, err := os.Stat(strayPart); !os.IsNotExist(err) {
		t.Fatal("stray .part was not housekept")
	}
	if _, err := os.Stat(staged); err != nil {
		t.Fatalf("newly staged installer missing: %v", err)
	}
}

// TestDefaultAssetURLGuard pins the production download anchor. Host prefix
// only (dev builds): any github repo passes, every lookalike/scheme trick
// fails closed. Repo pin (release builds): buildinfo.UpdateRepo — stamped at
// build time and unreachable from the renderer — refuses OTHER repos even
// when the renderer pairs its own URL with a matching self-supplied digest
// (045 regression round: host-prefix alone was not a trust anchor).
func TestDefaultAssetURLGuard(t *testing.T) {
	old := buildinfo.UpdateRepo
	buildinfo.UpdateRepo = ""
	defer func() { buildinfo.UpdateRepo = old }()

	if err := defaultAssetURLGuard("https://github.com/o/r/releases/download/v1/x.exe"); err != nil {
		t.Fatalf("plain github asset must pass host pinning: %v", err)
	}
	for _, bad := range []string{
		"http://github.com/o/r/x.exe",             // not https
		"https://github.com.evil.com/x.exe",       // lookalike host
		"https://evil.com/?x=https://github.com/", // query smuggling
		"https://github.com@evil.com/o/r/x.exe",   // userinfo trick (authority is evil.com)
		"https://github.com/",                     // prefix without a release path
	} {
		if err := defaultAssetURLGuard(bad); err == nil {
			t.Fatalf("non-github/lookalike URL must be refused: %q", bad)
		}
	}

	// Release-build repo pin.
	buildinfo.UpdateRepo = "OrangeX100/kafka-explorer"
	if err := defaultAssetURLGuard("https://github.com/OrangeX100/kafka-explorer/releases/download/v1/KafkaExplorer_Setup_1.exe"); err != nil {
		t.Fatalf("own-repo asset must pass: %v", err)
	}
	if err := defaultAssetURLGuard("https://github.com/attacker/x/releases/download/v1/KafkaExplorer_Setup_9.9.9.exe"); err == nil {
		t.Fatal("REGRESSION: another repo must be refused — the renderer must not aim the install pipeline elsewhere")
	}

	// Dev builds (empty stamp) intentionally keep host-only pinning.
	buildinfo.UpdateRepo = ""
	if err := defaultAssetURLGuard("https://github.com/attacker/x/releases/download/v1/x.exe"); err != nil {
		t.Fatalf("dev builds keep host-only pinning: %v", err)
	}
}
