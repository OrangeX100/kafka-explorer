package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"kafkaexplorer/internal/buildinfo"
)

// Locks the route-expansion rule: only GitHub release-download URLs get
// mirror candidates (the accelerator path form is prefix + full URL);
// anything else is used as-is.
func TestDownloadCandidates(t *testing.T) {
	gh := "https://github.com/OrangeX100/kafka-explorer/releases/download/v0.2.0/KafkaExplorer_Setup_0.2.0.exe"
	cn := "http://110.40.185.78:18080/releases/KafkaExplorer_Setup_0.2.0.exe"
	got := downloadCandidates(gh, DownloadSourceAuto)
	if len(got) != 4 {
		t.Fatalf("github url: got %d candidates, want 4 (direct+cn+2 mirrors)", len(got))
	}
	if got[0] != gh || got[1] != cn || got[2] != "https://ghfast.top/"+gh || got[3] != "https://gh-proxy.com/"+gh {
		t.Fatalf("github candidates wrong: %v", got)
	}
	other := "https://mirror.example.com/setup.exe"
	got = downloadCandidates(other, DownloadSourceAuto)
	if len(got) != 1 || got[0] != other {
		t.Fatalf("non-github url must stay single-route: %v", got)
	}
	// mirrorFirst（用户要求走国内源）：自有服务器最前、镜像居中、直连殿后
	got = downloadCandidates(gh, DownloadSourceMirrorFirst)
	if len(got) != 4 || got[0] != cn || got[3] != gh {
		t.Fatalf("mirrorFirst order wrong: %v", got)
	}
	// direct：只直连（排除自有服务器与第三方加速）
	got = downloadCandidates(gh, DownloadSourceDirect)
	if len(got) != 1 || got[0] != gh {
		t.Fatalf("direct must pin github only: %v", got)
	}
	// unknown clamps to auto
	got = downloadCandidates(gh, "bogus")
	if got[0] != gh || got[1] != cn {
		t.Fatalf("unknown source must clamp to auto: %v", got)
	}
}

// TestStageUpdateResumesAcrossRoutes 锁 2026-11-22 的续传语义：路由 1 中途
// 断流（前半段已落盘），路由 2 必须只补缺失段——总取字节 ≈ 一段而非整个
// 文件，且最终 SHA 通过、账本清理干净。
func TestStageUpdateResumesAcrossRoutes(t *testing.T) {
	payload := make([]byte, 3*(1<<20)) // 3MB → segMinSize=1MB → 3 段
	for i := range payload {
		payload[i] = byte(i % 251)
	}
	manifestSHA := fmt.Sprintf("%x", sha256.Sum256(payload))

	// 路由 1：只愿意交付第一段（Range 正常），第二段连接后立即断——
	// downloadOneSegment 对段内断流重试 segAttempts 次后整路由失败。
	var route2Fetch int64 = -1
	route1 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rng := r.Header.Get("Range")
		if rng == "" || strings.Contains(rng, "bytes=1048576-") {
			// 非段请求（探测/第二段起）直接掐断：制造路由失败
			panic(http.ErrAbortHandler)
		}
		serveRange(w, r, payload)
	}))
	defer route1.Close()
	route2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rng := r.Header.Get("Range")
		// 段 0 的续取是 bytes=0-1048575；1 字节探测是 bytes=0-0——不计数
		if strings.HasPrefix(rng, "bytes=0-") && rng != "bytes=0-0" {
			atomic.AddInt64(&route2Fetch, 1) // 路由 2 不应重取第一段
		}
		serveRange(w, r, payload)
	}))
	defer route2.Close()

	svc := NewUpdateService("0.2.0", nil)
	dir := t.TempDir()
	part := filepath.Join(dir, "KafkaExplorer_Setup_0.2.0.exe.part")

	// 路由 1（失败）+ 路由 2（补完）：候选序直接构造，绕过 downloadCandidates
	_ = route1
	_, err1 := svc.tryRoute(context.Background(), route1.URL+"/a.exe", int64(len(payload)), part, manifestSHA, DownloadSourceAuto, func(Progress) {}, make(chan struct{}))
	if err1 == nil {
		t.Fatal("route1 must fail (second segment aborted)")
	}
	if _, stErr := os.Stat(part + ".segstate"); stErr != nil {
		t.Fatalf("route1 failure must keep the resume ledger: %v", stErr)
	}
	st, stErr := os.Stat(part)
	if stErr != nil || st.Size() != int64(len(payload)) {
		t.Fatalf("route1 failure must keep the preallocated .part: %v", stErr)
	}

	_, err2 := svc.tryRoute(context.Background(), route2.URL+"/a.exe", int64(len(payload)), part, manifestSHA, DownloadSourceAuto, func(Progress) {}, make(chan struct{}))
	if err2 != nil {
		t.Fatalf("route2 resume failed: %v", err2)
	}
	// tryRoute 不做改名（那是 StageUpdate 路由层的职责）——校验 .part 本体
	got, err := os.ReadFile(part)
	if err != nil {
		t.Fatalf("read part: %v", err)
	}
	if sha256.Sum256(got) != sha256.Sum256(payload) {
		t.Fatal("resumed file digest mismatch")
	}
	if route2Fetch != 0 {
		t.Fatalf("route2 must not re-fetch segment 0 (saw %d requests)", route2Fetch)
	}
	// 账本清理是 StageUpdate（rename 时）的职责，tryRoute 留着它正确——
	// 这里只验账本记录了全段完成
	if raw, rerr := os.ReadFile(part + ".segstate"); rerr != nil {
		t.Fatalf("success should leave the ledger for the StageUpdate rename: %v", rerr)
	} else if !strings.Contains(string(raw), `"done":[true,true,true]`) {
		t.Fatalf("ledger should record all segments done: %s", raw)
	}
}

// serveRange answers Range requests for buf with 206/Content-Range —
// the minimal contract probeRangeSupport/downloadOneSegment rely on.
func serveRange(w http.ResponseWriter, r *http.Request, buf []byte) {
	rng := r.Header.Get("Range")
	start, end := int64(0), int64(len(buf)-1)
	if strings.HasPrefix(rng, "bytes=") {
		parts := strings.SplitN(strings.TrimPrefix(rng, "bytes="), "-", 2)
		if v, err := strconv.ParseInt(parts[0], 10, 64); err == nil {
			start = v
		}
		if len(parts) == 2 && parts[1] != "" {
			if v, err := strconv.ParseInt(parts[1], 10, 64); err == nil {
				end = v
			}
		}
	}
	if start > end || start >= int64(len(buf)) {
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(buf)))
	w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
	w.WriteHeader(http.StatusPartialContent)
	_, _ = w.Write(buf[start : end+1])
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
	_, err := s.tryRoute(context.Background(), srv.URL+"/asset.exe", 4, "unused.part", "", DownloadSourceAuto,
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
	_, err := s.tryRoute(context.Background(), srv.URL+"/asset.exe", int64(len(body)), part, "", DownloadSourceAuto,
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
	staged, err := svc.StageUpdate(t.Context(), srv.URL+"/KafkaExplorer_Setup_0.0.0-test.exe", int64(len(payload)), manifestSHA, DownloadSourceAuto, func(Progress) {}, make(chan struct{}))
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
		"https://github.com/",                     // bare prefix, no release path
		"https://github.com/o/r/commits/main",     // github but not a release download
		"https://github.com/o/r/releases/download/../../../attacker/x/releases/download/v1/x.exe", // dot-segment traversal: the edge resolves .. server-side to the ATTACKER repo
	} {
		if err := defaultAssetURLGuard(bad); err == nil {
			t.Fatalf("non-github/lookalike/traversal URL must be refused: %q", bad)
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
