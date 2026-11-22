package application

// Staging and installing an update: download the setup exe into the data
// directory, verify its size, then hand over to a hidden PowerShell that
// waits for this process to exit and runs the Inno Setup installer
// silently (the proven silent-install pattern: values travel through
// environment variables so no path needs quoting; the setup is the same
// one the user would have run by hand, so rollback is "old version still
// installed").

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"

	"kafkaexplorer/internal/appdir"
	"kafkaexplorer/internal/buildinfo"
	"kafkaexplorer/internal/domain"
)

// Progress is one download-tick payload, in bytes. Route names the
// transfer route currently serving the bytes (direct / mirror host) so the
// UI can show which channel the update is coming through.
type Progress struct {
	Bytes int64  `json:"bytes"`
	Total int64  `json:"total"`
	Route string `json:"route,omitempty"`
}

// updatesDir keeps staged installers together: staging writes
// <name>.part and renames on success, so a finished file is always whole.
func updatesDir() (string, error) {
	dir, err := appdir.DataDir()
	if err != nil {
		return "", err
	}
	p := filepath.Join(dir, "updates")
	if err := os.MkdirAll(p, 0o755); err != nil {
		return "", err
	}
	return p, nil
}

// stagedSetupPrefix is the release workflow's installer asset naming; the
// housekeeping pass and the install-path name gate both key on it.
const stagedSetupPrefix = "KafkaExplorer_Setup_"

// downloadMirrors are public read-only accelerators for GitHub release
// downloads, tried automatically after the direct route stalls — the
// user never configures anything. Purely additive candidates: the direct
// URL is always tried first, so networks with good GitHub access are
// unaffected.
var downloadMirrors = []string{
	"https://ghfast.top/",
	"https://gh-proxy.com/",
}

// cnMirrorOrigin is OUR OWN Tencent-server static mirror (nginx, port
// 18080; set up 2026-11-22 after gh-proxy 403'd mid-download and every
// public accelerator proved ephemeral — 8 of 9 instances dead or
// rate-limited in one evening's probe). Domestic users get ~520KB/s
// direct instead of praying to free mirrors. The URL is constructed
// INTERNALLY from the guarded github assetURL's base name — never
// renderer-supplied — and the release workflow is the only writer of
// that path (SSH credentials live in Actions secrets). The final
// SHA-256 digest gate still anchors integrity against the
// github-fetched manifest, so transport (plain HTTP) cannot tamper.
const cnMirrorOrigin = "http://110.40.185.78:18080"

// cnCandidateURL maps a guarded github release URL to the CN server
// mirror path (same file name under /releases/).
func cnCandidateURL(assetURL string) string {
	i := strings.LastIndex(assetURL, "/")
	if i < 0 || !strings.HasPrefix(assetURL, "https://github.com/") {
		return ""
	}
	return cnMirrorOrigin + "/releases/" + assetURL[i+1:]
}

// stripCNCandidates keeps the cn server OUT of manifest/sidecar fetches:
// the github-fetched manifest is the integrity ANCHOR of the whole update
// chain — whoever controlled the CN host could otherwise serve a fake
// manifest paired with a fake digest and pass every gate. The CN server
// only ever delivers installer BYTES that the github-side manifest
// already digests.
func stripCNCandidates(cands []string) []string {
	out := make([]string, 0, len(cands))
	for _, c := range cands {
		if !strings.HasPrefix(c, cnMirrorOrigin+"/") {
			out = append(out, c)
		}
	}
	return out
}

// Download source preference (Settings.UpdateSource): "auto" keeps the
// historical direct-first order, "mirrorFirst" puts the domestic
// accelerators ahead of github.com (user request 2026-11-22: CN links
// stall on the direct route and the old failover discarded downloaded
// bytes), "direct" pins github.com. Unknown values clamp to "auto".
const (
	DownloadSourceAuto        = "auto"
	DownloadSourceMirrorFirst = "mirrorFirst"
	DownloadSourceDirect      = "direct"
)

// downloadCandidates expands the asset URL into the ordered list of
// routes to try for the given source preference. Only GitHub
// release-download URLs get mirrors (the accelerator path form is
// prefix + full original URL).
func downloadCandidates(assetURL string, source string) []string {
	const ghPrefix = "https://github.com/"
	if !strings.HasPrefix(assetURL, ghPrefix) {
		return []string{assetURL}
	}
	direct := assetURL
	cn := cnCandidateURL(assetURL)
	var mirrored []string
	for _, m := range downloadMirrors {
		mirrored = append(mirrored, m+assetURL)
	}
	switch source {
	case DownloadSourceMirrorFirst:
		// domestic-first: own server, accelerators, direct last
		if cn != "" {
			return append(append([]string{cn}, mirrored...), direct)
		}
		return append(append([]string{}, mirrored...), direct)
	case DownloadSourceDirect:
		return []string{direct}
	default: // auto and anything unknown: direct, then OUR server, then accelerators
		if cn != "" {
			return append([]string{direct, cn}, mirrored...)
		}
		return append([]string{direct}, mirrored...)
	}
}

// segState is the cross-route resume ledger for one .part file: which of
// the fixed segments are already on disk. The segment layout is derived
// from (total, segN, segLen) — identical for every route — so the next
// candidate can pick up exactly where the failed one stopped instead of
// restarting a 50 MB download from byte 0 (user report 2026-11-22). The
// final SHA-256 digest gate remains the integrity anchor: a corrupted
// "done" segment fails it and the whole download re-runs.
type segState struct {
	URL    string `json:"url"`
	Total  int64  `json:"total"`
	SegN   int64  `json:"segN"`
	SegLen int64  `json:"segLen"`
	Done   []bool `json:"done"`
}

func segStatePath(part string) string { return part + ".segstate" }

// loadSegState returns the ledger only when it matches THIS asset and the
// segment layout this run computes; anything else (foreign URL, size
// change, corrupted JSON, length drift) means fresh download.
func loadSegState(path, url string, total, segN, segLen int64, partSize int64) *segState {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var st segState
	if json.Unmarshal(raw, &st) != nil || st.URL != url || st.Total != total ||
		st.SegN != segN || st.SegLen != segLen || int64(len(st.Done)) != segN {
		return nil
	}
	// Crash window: Truncate(total) preallocates the file, so a "done"
	// ledger over a MISSING/truncated part (crash before the bytes landed)
	// would skip every segment and fail the digest. Trust the ledger only
	// when the part file is already at full size.
	if st, err := os.Stat(path[:len(path)-len(".segstate")]); err != nil || st.Size() != total {
		return nil
	}
	return &st
}

func saveSegState(path string, st *segState) {
	raw, err := json.Marshal(st)
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, raw, 0o600) != nil {
		return
	}
	_ = os.Rename(tmp, path) // same dir: atomic on Windows
}

// assetURLGuard gates where the staging pipeline may download from.
// Production pins release assets to github.com: the manifest already
// constructs release-download URLs server-side, and the mirrors in
// downloadCandidates are prefixes ON TOP of a github URL — a compromised
// renderer must not be able to aim download-and-install at its own server
// (the digest gate alone is not an anchor: the renderer also supplies
// manifestSha, so it could pair its own URL with the matching digest).
//
// Release builds additionally pin the REPO via buildinfo.UpdateRepo (stamped
// at build time, unreachable from the renderer): the host prefix alone lets
// a compromised webview aim the pipeline at ANY github repo with its own
// digest. Dev builds stamp "" and keep host-only pinning.
var assetURLGuard = defaultAssetURLGuard

func defaultAssetURLGuard(assetURL string) error {
	// Parse-then-compare, NOT strings.HasPrefix: dot-segment paths
	// ("/releases/download/../../../../attacker/…") pass any prefix check
	// while GitHub's edge resolves them server-side to the ATTACKER's asset
	// (verified: 302 to the real file). url.Parse does not normalize, so the
	// segments must be validated by hand.
	u, err := url.Parse(assetURL)
	if err != nil || u.Scheme != "https" || u.Hostname() != "github.com" {
		return fmt.Errorf("%w: 更新包地址不受支持（仅支持 GitHub 发布下载链接），已中止安装", domain.ErrInvalid)
	}
	segs := strings.Split(u.Path, "/")
	for _, s := range segs[1:] {
		if s == "." || s == ".." {
			return fmt.Errorf("%w: 更新包地址包含非法路径段，已中止安装", domain.ErrInvalid)
		}
	}
	// Only the release-download shape is ever consumed; anything else would
	// stage a junk file and die at the install name gate — refuse here so
	// the error lands at the responsible boundary.
	if len(segs) < 6 || segs[3] != "releases" || segs[4] != "download" {
		return fmt.Errorf("%w: 更新包地址不是发布下载链接，已中止安装", domain.ErrInvalid)
	}
	// Release builds pin the REPO (stamped at build time, unreachable from
	// the renderer): the host prefix alone would let a compromised webview
	// aim the pipeline at ANY github repo with its own digest. Dev builds
	// stamp "" and keep host-only pinning.
	if repo := buildinfo.UpdateRepo; repo != "" {
		if segs[1] != pathSegment(repo, 0) || segs[2] != pathSegment(repo, 1) {
			return fmt.Errorf("%w: 更新包地址与本应用的发布仓库（%s）不一致，已中止安装", domain.ErrInvalid, repo)
		}
	}
	return nil
}

// pathSegment extracts segment i of "owner/repo" (missing → impossible value).
func pathSegment(repo string, i int) string {
	parts := strings.Split(repo, "/")
	if i >= len(parts) {
		return "\x00none"
	}
	return parts[i]
}

// SetAssetURLGuardForTests swaps the guard — tests stage from httptest
// fixtures. nil admits every URL. Test-only: production code never calls
// this; the restore func must be deferred by every caller.
func SetAssetURLGuardForTests(g func(string) error) (restore func()) {
	if g == nil {
		g = func(string) error { return nil }
	}
	old := assetURLGuard
	assetURLGuard = g
	return func() { assetURLGuard = old }
}

// StageUpdate downloads the setup asset into DataDir/updates with
// progress ticks. cancelled is polled between chunks — closing it is the
// stop button, and the .part file + resume ledger are kept so a later
// retry continues from where it stopped. Direct GitHub downloads that
// stall or crawl (typical on CN
// networks) automatically fall through to the built-in mirrors: the user
// sees one progress bar and never picks a route.
func (s *UpdateService) StageUpdate(ctx context.Context, assetURL string, assetSize int64, manifestSHA string, source string, progress func(Progress), cancelled <-chan struct{}) (string, error) {
	if source != DownloadSourceMirrorFirst && source != DownloadSourceDirect {
		source = DownloadSourceAuto
	}
	if runtime.GOOS != "windows" {
		return "", fmt.Errorf("%w: 自动更新当前仅支持 Windows", domain.ErrInvalid)
	}
	if assetURL == "" {
		return "", fmt.Errorf("%w: 该发布版本未附带安装包，请从发布页手动下载", domain.ErrInvalid)
	}
	if err := assetURLGuard(assetURL); err != nil {
		return "", err
	}
	dir, err := updatesDir()
	if err != nil {
		return "", err
	}
	name := assetNameFromURL(assetURL)
	dest := filepath.Join(dir, name)
	part := dest + ".part"

	// Housekeeping: previous staged installers and stray .part files used to
	// accumulate ~50 MB per released version forever — the updates dir had no
	// cleanup anywhere. Only OUR artifacts are removed (release-asset shaped
	// installers and .part leftovers); anything else the user parked in this
	// directory must survive. Best-effort: a file still locked by an
	// in-flight install simply survives until the next round.
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if e.IsDir() || e.Name() == name || e.Name() == name+".part" || e.Name() == name+".part.segstate" {
				continue
			}
			base := e.Name()
			isSetup := strings.HasPrefix(base, stagedSetupPrefix) && strings.HasSuffix(base, ".exe")
			isPart := strings.HasSuffix(base, ".part")
			isState := strings.HasSuffix(base, ".segstate")
			// saveSegState 崩在 WriteFile 与 Rename 之间的孤儿（.tmp 后缀
			// 不匹配上面两条，会无限积累）
			isStateTmp := strings.HasSuffix(base, ".segstate.tmp")
			if !isSetup && !isPart && !isState && !isStateTmp {
				continue
			}
			_ = os.Remove(filepath.Join(dir, base))
		}
	}

	// Cross-route resume ledger: kept alongside the .part across route
	// failovers (and across stop/retry) so a half-finished download
	// continues instead of restarting from byte 0. Cleaned on success.
	state := segStatePath(part)
	var lastErr error
	for _, route := range downloadCandidates(assetURL, source) {
		// routeErr must NOT shadow the cancellation checks below: the old
		// code read the (always-nil) updatesDir error here, so a cancel was
		// treated as success and the TRUNCATED .part got renamed into the
		// installer. routeErr carries tryRoute's real outcome — including
		// errCancelled, which tryRoute now ALWAYS returns on cancellation.
		_, routeErr := s.tryRoute(ctx, route, assetSize, part, manifestSHA, source, progress, cancelled)
		if routeErr == errCancelled || ctx.Err() != nil {
			// Stop button: keep the .part + ledger — the next attempt
			// resumes where this stopped instead of restarting.
			return "", nil // stop button: not an error
		}
		if routeErr == nil {
			if err := os.Rename(part, dest); err != nil {
				os.Remove(part)
				_ = os.Remove(state)
				return "", fmt.Errorf("暂存安装包失败: %w", err)
			}
			_ = os.Remove(state)
			// Backfill the size when the manifest carried none: tryRoute
			// learns ContentLength on its own copy of the parameter, so the
			// final progress tick would otherwise report 0/0.
			if assetSize <= 0 {
				if st, statErr := os.Stat(dest); statErr == nil {
					assetSize = st.Size()
				}
			}
			progress(Progress{Bytes: assetSize, Total: assetSize})
			return dest, nil
		}
		// Failover: KEEP the .part when the ledger exists — the next
		// candidate resumes its remaining segments. No ledger (fresh
		// start, size mismatch, single-stream fallback) means nothing
		// resumable: clean the truncated file as before.
		if _, stErr := os.Stat(state); stErr != nil {
			os.Remove(part)
		}
		lastErr = routeErr // remember; the next route gets a chance
	}
	if lastErr != nil {
		return "", lastErr
	}
	return "", fmt.Errorf("%w: 所有下载通道均失败，请检查网络后重试，或到发布页手动下载", domain.ErrUnavailable)
}

// probeRangeSupport asks the route for HTTP Range support with a 1-byte
// probe (10s bound). Returns the full Content-Length when the answer is a
// 206 Partial Content carrying a parseable Content-Range. 200 means the
// server ignored the Range header — caller falls back to single-stream.
func probeRangeSupport(ctx context.Context, assetURL string) (int64, bool) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, assetURL, nil)
	if err != nil {
		return 0, false
	}
	req.Header.Set("User-Agent", "kafka-explorer-updater")
	req.Header.Set("Range", "bytes=0-0")
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return 0, false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != http.StatusPartialContent {
		return 0, false // 200: server ignored the Range header
	}
	// Content-Range: bytes 0-0/TOTAL
	cr := resp.Header.Get("Content-Range")
	i := strings.LastIndexByte(cr, '/')
	if i < 0 || i == len(cr)-1 {
		return 0, false
	}
	total, err := strconv.ParseInt(cr[i+1:], 10, 64)
	if err != nil || total <= 0 {
		return 0, false
	}
	return total, true
}

// Segment download tuning: 8 connections, at least 1MB per segment (fewer
// segments for small files). 429 handling: segment attempts back off with a
// short sleep before the retry, and the route loop already falls through to
// the next route when this one exhausts its attempts.
const (
	segConnections = 8
	segMinSize     = 1 << 20
	segAttempts    = 3
)

// downloadSegments fetches the asset as segN parallel ranged segments
// written into the preallocated file at their offsets (WriteAt is safe for
// concurrent non-overlapping ranges). Each segment retries up to
// segAttempts times from its own progress offset; a segment watchdog
// cancels an attempt that stops delivering for stallTimeout. The caller's
// size + SHA gates still run on the merged file.
func (s *UpdateService) downloadSegments(routeCtx context.Context, assetURL, part string, total int64, routeLabel string, progress func(Progress), cancelled <-chan struct{}) error {
	segN := total / segMinSize
	if segN > segConnections {
		segN = segConnections
	}
	if segN < 1 {
		segN = 1
	}
	partFile, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("创建临时文件失败: %w", err)
	}
	defer partFile.Close()
	if err := partFile.Truncate(total); err != nil {
		return fmt.Errorf("预分配临时文件失败: %w", err)
	}

	segLen := (total + segN - 1) / segN
	// Resume ledger: a previous route's completed segments stay on disk —
	// pick them up instead of re-downloading (final digest gate anchors
	// integrity; layout is derived from total/segN/segLen so it matches
	// across routes).
	statePath := segStatePath(part)
	var partSz int64
	if st, err := os.Stat(part); err == nil {
		partSz = st.Size()
	}
	prev := loadSegState(statePath, assetURL, total, segN, segLen, partSz)
	doneSeg := make([]bool, int(segN))
	// segN is int64; make needs int — safe: segN ≤ segConnections
	var resumed int64
	if prev != nil {
		doneSeg = prev.Done
		for i := int64(0); i < segN; i++ {
			if doneSeg[i] {
				start := i * segLen
				end := start + segLen - 1
				if end > total-1 {
					end = total - 1
				}
				resumed += end - start + 1
			}
		}
	}
	ledger := &segState{URL: assetURL, Total: total, SegN: segN, SegLen: segLen, Done: doneSeg}
	var ledgerMu sync.Mutex
	saveLedger := func() {
		ledgerMu.Lock()
		defer ledgerMu.Unlock()
		saveSegState(statePath, ledger)
	}

	var got atomic.Int64
	got.Store(resumed)
	segCtx, segCancel := context.WithCancel(routeCtx)
	defer segCancel()

	done := make(chan error, segN)
	for i := int64(0); i < segN; i++ {
		if ledger.Done[i] {
			done <- nil // resumed from the ledger: nothing to fetch
			continue
		}
		start := i * segLen
		end := start + segLen - 1
		if end > total-1 {
			end = total - 1
		}
		go func() {
			err := downloadOneSegment(segCtx, assetURL, partFile, start, end, &got, cancelled)
			if err == nil {
				ledgerMu.Lock()
				ledger.Done[i] = true
				ledgerMu.Unlock()
				saveLedger()
			}
			done <- err
		}()
	}
	// progress ticker: aggregate the segments' shared counter
	go func() {
		ticker := time.NewTicker(150 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-segCtx.Done():
				return
			case <-cancelled:
				return
			case <-ticker.C:
				progress(Progress{Bytes: got.Load(), Total: total, Route: routeLabel})
			}
		}
	}()
	// stall watchdog: no aggregate progress for stallTimeout while
	// incomplete → cancel everything, the route fails (next route tries)
	go func() {
		last, lastT := int64(0), time.Now()
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-segCtx.Done():
				return
			case <-cancelled:
				return
			case <-t.C:
				g := got.Load()
				if g != last {
					last = g
					lastT = time.Now()
					continue
				}
				if g < total && time.Since(lastT) > stallTimeout {
					segCancel()
					return
				}
			}
		}
	}()

	var firstErr error
	for i := int64(0); i < segN; i++ {
		if err := <-done; err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if firstErr != nil {
		// 用户取消（cancelled 通道关闭）→ 静默归零；否则即使段返回
		// errCancelled/context.Canceled 也降级为 errSlowRoute——那是
		// stall watchdog 的 segCancel，不是用户取消：吞掉它会让镜像
		// 回退永不触发，进度条冻结后静默归 idle（045 round-6 P1）。
		if stopRequested(cancelled) {
			return errCancelled
		}
		if firstErr == errCancelled || errors.Is(firstErr, context.Canceled) {
			return errSlowRoute
		}
		return fmt.Errorf("分段下载失败: %w", firstErr)
	}
	return nil
}

// downloadOneSegment streams one Range window into partFile at absolute
// offsets, retrying from its own progress up to segAttempts times. A
// per-attempt watchdog cancels an attempt that stops delivering for
// stallTimeout; when the attempts are exhausted the segment reports
// errSlowRoute (the route loop falls through to the next route).
func downloadOneSegment(ctx context.Context, assetURL string, f *os.File, start, end int64, got *atomic.Int64, cancelled <-chan struct{}) error {
	offset := start
	for attempt := 1; attempt <= segAttempts; attempt++ {
		if offset > end {
			return nil // segment complete
		}
		attemptCtx, attemptCancel := context.WithCancel(ctx)
		// per-attempt stall watchdog: no segment-local progress for
		// stallTimeout → cancel this attempt (retried from offset)
		var aGot atomic.Int64
		go func() {
			t := time.NewTicker(time.Second)
			defer t.Stop()
			last, lastT := int64(0), time.Now()
			for {
				select {
				case <-attemptCtx.Done():
					return
				case <-cancelled:
					return
				case <-t.C:
					g := aGot.Load()
					if g != last {
						last, lastT = g, time.Now()
						continue
					}
					if time.Since(lastT) > stallTimeout {
						attemptCancel()
						return
					}
				}
			}
		}()

		req, err := http.NewRequestWithContext(attemptCtx, http.MethodGet, assetURL, nil)
		if err != nil {
			attemptCancel()
			return err
		}
		req.Header.Set("User-Agent", "kafka-explorer-updater")
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", offset, end))
		resp, err := (&http.Client{}).Do(req)
		if err != nil {
			attemptCancel()
			if ctx.Err() != nil || stopRequested(cancelled) {
				return errCancelled
			}
			// ctx-aware backoff：取消可即时唤醒（旧 time.Sleep 不可中断，
			// 用户取消延迟最多 ~6s——045 round-6 P4）
			select {
			case <-ctx.Done():
				return errCancelled
			case <-time.After(time.Duration(attempt) * time.Second):
			}
			continue
		}
		// 可重试的服务端状态：429（8 并发更容易触发 CDN 限流）与 5xx 走
		// 退避后重试同段；其余非 206（200=忽略 Range、404）才是"该路由
		// 不支持分段"。旧代码把 429 也归到后者，整条路由被白白放弃——
		// 注释"covers 429"与实现不符（外部评审指出）。退避用 ctx-aware
		// select（外部评审 round-6：裸 time.Sleep 让取消延迟最多 ~6s）。
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
			resp.Body.Close()
			attemptCancel()
			select {
			case <-ctx.Done():
				return errCancelled
			case <-cancelled:
				return errCancelled
			case <-time.After(time.Duration(attempt) * 2 * time.Second):
			}
			continue
		}
		if resp.StatusCode != http.StatusPartialContent {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
			resp.Body.Close()
			attemptCancel()
			return errSlowRoute // this route can't serve ranges after all
		}
		// 起点与长度校验（外部评审 round-6）：Content-Range 头声明的起点
		// 必须等于本段请求的 offset——同长度但错起点的响应此前会通过长度
		// 校验把错位字节写进文件（覆盖相邻段窗口）。缺头或错位 → 换路由。
		if cr := resp.Header.Get("Content-Range"); cr != "" {
			var segStart, segEnd int64
			if _, err := fmt.Sscanf(cr, "bytes %d-%d/", &segStart, &segEnd); err != nil || segStart != offset || segEnd != end {
				_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
				resp.Body.Close()
				attemptCancel()
				return errSlowRoute
			}
		} else if resp.ContentLength > 0 && offset+resp.ContentLength-1 != end {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
			resp.Body.Close()
			attemptCancel()
			return errSlowRoute
		}

		buf := make([]byte, 64*1024)
		var segErr error
	readLoop:
		for segErr == nil {
			select {
			case <-cancelled:
				segErr = errCancelled
			case <-attemptCtx.Done():
				segErr = errSlowRoute // stalled: retried from offset below
			default:
			}
			if segErr != nil {
				break readLoop
			}
			n, rerr := resp.Body.Read(buf)
			if n > 0 {
				if _, werr := f.WriteAt(buf[:n], offset); werr != nil {
					segErr = werr
				} else {
					offset += int64(n)
					got.Add(int64(n))
				}
			}
			if segErr == nil && rerr == io.EOF {
				resp.Body.Close()
				attemptCancel()
				return nil // segment complete
			}
			if segErr == nil && rerr != nil {
				segErr = rerr
			}
		}
		resp.Body.Close()
		attemptCancel()
		if segErr == errCancelled || ctx.Err() != nil || stopRequested(cancelled) {
			return errCancelled
		}
		if segErr == errSlowRoute {
			continue // stalled attempt: retry from offset (attempts left)
		}
		if segErr != nil {
			return segErr // write error etc. — real failure
		}
		if offset > end {
			return nil
		}
		// EOF before end without error: truncated — retry from offset
	}
	return errSlowRoute
}

// slowStart is how long a route gets to prove itself: below this rate
// after slowStartWindow the route is abandoned for the next one.
var (
	slowStartBytes  = int64(64 << 10)  // 64KB
	slowStartWindow = 8 * time.Second  // a route gets this long to prove itself
	stallTimeout    = 15 * time.Second // no bytes at all for this long → dead route
)

// tryRoute downloads one route into part (no rename). Errors are
// classified for the fallback chain: start/cancel errors and stalls are
// retryable on the next route.
func (s *UpdateService) tryRoute(ctx context.Context, assetURL string, assetSize int64, part string, manifestSHA string, source string, progress func(Progress), cancelled <-chan struct{}) (string, error) {
	// routeCtx is cancelled by the watchdog (stall/slow-start) and tears
	// down the in-flight request; the deferred cancel cleans up after a
	// healthy completion. The watchdog starts BEFORE the request: a dead
	// route never returns response headers, and Do would block forever if
	// the watchdog only started afterwards.
	routeCtx, routeCancel := context.WithCancel(ctx)
	defer routeCancel()

	// human-facing route label: mirror host for prefixed URLs, "direct" for
	// the plain github.com one
	routeLabel := "直连"
	if i := strings.Index(assetURL, "https://github.com/"); i > 0 {
		routeLabel = assetURL[:i] // the mirror prefix, e.g. https://ghfast.top/
	}

	// Multi-connection segmented download (045 round-5 F1): probe Range
	// support first; a supported route downloads as 8 parallel ranged
	// segments (server-side aria2 measured 50MB/45s vs single-stream
	// ~30KB/s on the same link). Unsupported Range falls back to the
	// legacy single-stream path below, unchanged.
	segTotal, rangeOK := probeRangeSupport(routeCtx, assetURL)
	if rangeOK {
		if assetSize <= 0 {
			assetSize = segTotal
		}
		if segTotal != assetSize {
			// Manifest/route size disagreement: the layout ledger is void.
			os.Remove(part)
			_ = os.Remove(segStatePath(part))
			return "", fmt.Errorf("下载通道返回的大小与发布信息不一致（%d ≠ %d）", segTotal, assetSize)
		}
		if err := s.downloadSegments(routeCtx, assetURL, part, assetSize, routeLabel, progress, cancelled); err != nil {
			// KEEP part + ledger: the next candidate resumes the missing
			// segments (2026-11-22 — the old unconditional Remove here is
			// what restarted half-finished downloads from byte 0).
			switch {
			case err == errCancelled || ctx.Err() != nil || stopRequested(cancelled):
				return "", errCancelled
			case errors.Is(err, errSlowRoute):
				return "", errSlowRoute
			default:
				return "", fmt.Errorf("%w: 下载中断，请检查网络后重试", domain.ErrUnavailable)
			}
		}
		// fall through to the shared gates below (single-stream tail)
	} else {

		// Single-stream cannot honor a segment ledger: start clean.
		_ = os.Remove(segStatePath(part))
		var got atomic.Int64
		lastNano := atomic.Int64{}
		started := time.Now()

		watchdogTick := func() { progress(Progress{Bytes: got.Load(), Total: assetSize, Route: routeLabel}) }
		ticker := time.NewTicker(150 * time.Millisecond)
		defer ticker.Stop()
		watchdogDone := make(chan struct{})
		go func() {
			defer close(watchdogDone)
			for {
				select {
				case <-routeCtx.Done():
					return
				case <-cancelled:
					return
				case <-ticker.C:
					watchdogTick()
					g := got.Load()
					sinceStart := time.Since(started)
					switch {
					case g == 0 && sinceStart > slowStartWindow:
						routeCancel() // never produced a byte: dead route
						return
					case g > 0 && g < slowStartBytes && sinceStart > slowStartWindow:
						routeCancel() // crawling: under 64KB in the whole window
						return
					case g > 0 && g >= slowStartBytes && time.Since(time.Unix(0, lastNano.Load())) > stallTimeout:
						routeCancel() // bytes stopped moving mid-download
						return
					}
				}
			}
		}()

		req, err := http.NewRequestWithContext(routeCtx, http.MethodGet, assetURL, nil)
		if err != nil {
			return "", err
		}
		req.Header.Set("User-Agent", "kafka-explorer-updater")
		resp, err := (&http.Client{}).Do(req)
		if err != nil {
			if ctx.Err() != nil || stopRequested(cancelled) {
				return "", errCancelled // cancellation is NEVER a nil-error success
			}
			return "", errSlowRoute // this route is unreachable: try the next
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return "", fmt.Errorf("下载通道返回异常状态 %d", resp.StatusCode)
		}
		if assetSize <= 0 && resp.ContentLength > 0 {
			assetSize = resp.ContentLength
		}

		partFile, err := os.Create(part)
		if err != nil {
			return "", fmt.Errorf("创建临时文件失败: %w", err)
		}
		done := make(chan error, 1)

		go func() {
			buf := make([]byte, 64*1024)
			for {
				select {
				case <-cancelled:
					done <- errCancelled
					return
				case <-routeCtx.Done():
					done <- routeCtx.Err()
					return
				default:
				}
				n, rerr := resp.Body.Read(buf)
				if n > 0 {
					if _, werr := partFile.Write(buf[:n]); werr != nil {
						done <- werr
						return
					}
					got.Add(int64(n))
					lastNano.Store(time.Now().UnixNano())
				}
				if rerr == io.EOF {
					done <- nil
					return
				}
				if rerr != nil {
					done <- rerr
					return
				}
			}
		}()

		werr := <-done
		partFile.Close()
		if werr != nil {
			os.Remove(part)
			if werr == errCancelled || ctx.Err() != nil || stopRequested(cancelled) {
				return "", errCancelled // stop button: the CALLER maps this to a silent no-op
			}
			if werr == errSlowRoute || errors.Is(werr, context.Canceled) {
				return "", errSlowRoute // watchdog/parent cancelled: next route
			}
			return "", fmt.Errorf("%w: 下载中断，请检查网络后重试", domain.ErrUnavailable)
		}
	} // legacy single-stream path (no Range support)

	// Cancellation race: the body hit EOF at the same moment the user pressed
	// stop. The staged file is discarded all the same — a "download finished"
	// racing a "stop" resolves to stopped.
	if stopRequested(cancelled) || ctx.Err() != nil {
		os.Remove(part)
		return "", errCancelled
	}
	// Size gate: the release metadata promised a byte count; a truncated
	// download must not become the installer.
	if assetSize > 0 {
		st, statErr := os.Stat(part)
		if statErr != nil || st.Size() != assetSize {
			os.Remove(part)
			gotSize := int64(-1)
			if statErr == nil {
				gotSize = st.Size()
			}
			return "", fmt.Errorf("下载不完整（%d/%d 字节），请重试", gotSize, assetSize)
		}
	}
	// SHA-256 gate: verification uses the manifest-embedded digest first
	// (downloaded together with the release metadata), then the .sha256
	// sidecar over the mirror chain. If NEITHER is obtainable the install
	// hard-fails — a silent size-only pass would let a same-size tampered
	// file through, and a missing checksum is not something to shrug off.
	want := strings.ToLower(strings.TrimSpace(manifestSHA))
	if want == "" {
		sidecar, status := fetchExpectedChecksum(ctx, stripCNCandidates(downloadCandidates(assetURL+".sha256", source)))
		switch status {
		case checksumOK:
			want = sidecar
		case checksumMissing:
			// legacy release without a sidecar: keep the legacy size-only
			// downgrade — but the decision is logged, not silent ("say so in
			// the log" promise from the checksumMissing comment). nil logger
			// (bare &UpdateService{} in tests) must not panic here.
			if s.log != nil {
				s.log.Warn("安装包校验文件缺失（legacy 发布），仅按文件大小校验后放行",
					zap.String("asset", assetURL))
			}
			return part, nil
		default: // unreachable or malformed: hard fail
			os.Remove(part)
			return "", fmt.Errorf("完整性校验文件获取失败，为安全起见已中止安装。请到发布页手动下载，或稍后重试")
		}
	}
	digest, err := fileSHA256(part)
	if err != nil {
		os.Remove(part)
		return "", fmt.Errorf("读取已下载文件失败: %w", err)
	}
	if digest != want {
		// The ledger MUST die with the part: a poisoned ledger (mirror
		// delivered same-size stale bytes, or a crash between Truncate and
		// the bytes landing) would make every route/retry skip download via
		// "all segments done" and fail the SHA gate again — a permanent
		// immediate-failure loop with a misleading attribution
		// (review 2026-11-22 P1-1/P2-2).
		os.Remove(part)
		_ = os.Remove(segStatePath(part))
		return "", fmt.Errorf("安装包校验失败（SHA-256 不匹配），文件可能不完整或被篡改。请到发布页手动下载，或稍后重试")
	}
	return part, nil
}

func assetNameFromURL(url string) string {
	// Path segment only: a bare host:port URL (test fixtures) ends in a
	// colon, which Windows filenames forbid — strip the scheme/host and
	// sanitize whatever remains so Rename never gets an illegal name.
	if i := strings.LastIndex(url, "/"); i >= 0 {
		url = url[i+1:]
	}
	replaced := strings.Map(func(r rune) rune {
		switch r {
		case ':', '*', '?', '"', '<', '>', '|', '\\':
			return '_'
		}
		return r
	}, url)
	if replaced == "" {
		replaced = "download"
	}
	return replaced
}

// WriteWaiter spawns the hidden PowerShell that waits for this process to
// exit, then runs the staged setup silently and (optionally) relaunches the
// app. All values travel through environment variables — no path quoting.
// Installer failures are written to update_waiter.err.log in the data dir:
// a silent installer that dies must leave a trace the user can find.
func (s *UpdateService) WriteWaiter(setupPath string, relaunch bool) error {
	appPath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("定位应用失败: %w", err)
	}
	dir, err := appdir.DataDir()
	if err != nil {
		return err
	}
	script := filepath.Join(dir, "update_waiter.ps1")
	logFile := filepath.Join(dir, "update_waiter.err.log")
	// The wait loop MUST tolerate a missing PID: this app usually exits
	// BEFORE PowerShell finishes starting — a bare Get-Process throws a
	// non-terminating error that $ErrorActionPreference='Stop' escalates,
	// killing the waiter before a single byte is installed, with no log
	// (measured on this machine: nonexistent PID → script exits 1).
	// SilentlyContinue keeps the loop semantics: not-found = "go install".
	// logFile is embedded in a single-quoted PS string — a path containing '
	// (e.g. a username) must be escaped by doubling, or the script breaks.
	body := waiterScriptBody(logFile)
	// UTF-8 BOM: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI (GBK on
	// zh-CN systems), which would mangle the non-ASCII timeout note.
	if err := os.WriteFile(script, append([]byte("\xef\xbb\xbf"), []byte(body)...), 0o600); err != nil {
		return fmt.Errorf("写入等待脚本失败: %w", err)
	}
	relaunchFlag := "0"
	if relaunch {
		relaunchFlag = "1"
	}
	return launchDetachedFn(
		filepath.Join(systemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		// MUST be split argv: one folded string makes PowerShell parse the
		// whole "-NoProfile … -File …" as a COMMAND and exit 1 before running
		// a single line (044 review round: this killed every in-app install).
		waiterArgs(script),
		map[string]string{
			"KE_UPDATE_PID":      fmt.Sprint(os.Getpid()),
			"KE_UPDATE_SETUP":    setupPath,
			"KE_UPDATE_APP":      appPath,
			"KE_UPDATE_RELAUNCH": relaunchFlag,
		},
	)
}

// launchDetachedFn lets tests intercept the REAL call site (WriteWaiter):
// the 044 folded-argv bug lived at that call site, not inside
// launchDetached itself — pinning only the helper would survive a
// regression that inlines a folded string back into WriteWaiter.
var launchDetachedFn = launchDetached

// waiterArgs builds the waiter's argv in split form — pinned by a test that
// intercepts WriteWaiter's actual launch call, because a folded string
// fails silently.
func waiterArgs(script string) []string {
	return []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script}
}

func systemRoot() string {
	if root := os.Getenv("SystemRoot"); root != "" {
		return root
	}
	return `C:\Windows`
}

// waiterScriptBody builds the waiter PowerShell script. The traps are baked
// in here rather than at the call site so a regression test can pin them:
// (1) Get-Process carries -ErrorAction SilentlyContinue — the app usually
// exits BEFORE PowerShell starts, and without the flag the not-found error
// escalates under $ErrorActionPreference='Stop' and kills the waiter
// silently (no install, no log); (2) logFile is embedded in a single-quoted
// PS string, so a path containing ' (e.g. a username like O'Brien) must be
// escaped by doubling or the script fails to parse; (3) the wait loop has a
// HARD DEADLINE — Windows recycles PIDs aggressively, so after the app exits
// another process can take over the waited-on PID and the waiter would
// otherwise wait forever (app closed, nothing installs, no log); (4) the
// staged installer and the script itself are removed after a successful
// install, so DataDir/updates stops growing by ~50 MB per released version;
// (5) Start-Process -Wait does NOT throw on a non-zero installer exit — the
// exit code must be checked explicitly, or a failed silent install deletes
// the staged setup and relaunches as if it had succeeded (no err.log, no
// trace). On failure the staged setup is KEPT for a retry and nothing
// relaunches; the script also stays on disk (exit 1 skips the self-delete)
// so a failed run leaves a diagnosable scene.
func waiterScriptBody(logFile string) string {
	psLogFile := strings.ReplaceAll(logFile, "'", "''")
	logRef := "'" + psLogFile + "'"
	return "$ErrorActionPreference = 'Stop'\n" +
		"$waitFor = [int]$env:KE_UPDATE_PID\n" +
		"$deadline = (Get-Date).AddMinutes(10)\n" +
		"while (Get-Process -Id $waitFor -ErrorAction SilentlyContinue) {\n" +
		"  if ((Get-Date) -gt $deadline) {\n" +
		"    '等待应用退出超时（PID 可能已被其他进程复用），继续安装' | Out-File -FilePath " + logRef + " -Encoding utf8 -Append\n" +
		"    break\n" +
		"  }\n" +
		"  Start-Sleep -Milliseconds 100\n" +
		"}\n" +
		"try {\n" +
		"  $p = Start-Process -FilePath $env:KE_UPDATE_SETUP -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/CLOSEAPPLICATIONS','/SP-' -Wait -PassThru -ErrorAction Stop\n" +
		"  if ($p.ExitCode -ne 0) {\n" +
		"    \"安装器退出码 $($p.ExitCode)（安装失败）。暂存安装包已保留，可重试或手动运行。\" | Out-File -FilePath " + logRef + " -Encoding utf8 -Append\n" +
		"    exit 1\n" +
		"  }\n" +
		"  if ($env:KE_UPDATE_RELAUNCH -eq '1') { Start-Process -FilePath $env:KE_UPDATE_APP }\n" +
		"  Remove-Item -Path $env:KE_UPDATE_SETUP -ErrorAction SilentlyContinue\n" +
		"} catch {\n" +
		"  $_ | Out-File -FilePath " + logRef + " -Encoding utf8 -Append\n" +
		"}\n" +
		"Remove-Item -Path $PSCommandPath -ErrorAction SilentlyContinue\n"
}

// checksumStatus distinguishes "EVERY route confirmed this release has no
// sidecar at all" (legacy downgrade — a deliberate decision, logged) from
// "we could not fetch it" (hard fail). A single 404 among mixed failures is
// NOT proof of absence: a hijacked direct route returning 404 while a
// mirror would serve the real sidecar must NOT trigger the downgrade.
type checksumStatus int

const (
	checksumMissing checksumStatus = iota // every route answered 404
	checksumOK                            // digest parsed successfully
	checksumFailed                        // unreachable / malformed: hard fail, never silently pass
)

// fetchExpectedChecksum downloads <asset>.sha256 over the mirror chain and
// returns the hex digest it carries.
func fetchExpectedChecksum(ctx context.Context, urls []string) (string, checksumStatus) {
	var lastErr error
	sawMissing := false
	for _, url := range urls {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return "", checksumFailed
		}
		req.Header.Set("User-Agent", "kafka-explorer-updater")
		resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		resp.Body.Close()
		if resp.StatusCode == http.StatusNotFound {
			sawMissing = true // this route has no sidecar; keep trying the others
			continue
		}
		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("HTTP %d", resp.StatusCode)
			continue
		}
		line := strings.TrimSpace(string(body))
		if i := strings.IndexAny(line, " 	"); i > 0 {
			line = line[:i]
		}
		if len(line) != 64 {
			return "", checksumFailed
		}
		return strings.ToLower(line), checksumOK
	}
	if sawMissing && lastErr == nil {
		// every route confirmed absence: legacy release, logged downgrade
		return "", checksumMissing
	}
	return "", checksumFailed
}

// fileSHA256 hex-digests a file on disk.
func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Route-quality sentinels: a stalled/crawling route asks the caller to
// try the next download route (mirrors), distinct from user cancellation.
var errSlowRoute = fmt.Errorf("route too slow or stalled")

// stopRequested reports whether the user pressed the stop button (the
// cancelled channel is closed). Distinct from ctx cancellation: the parent
// ctx stays alive across a user stop, and the two mean different things to
// the staging flow (silent no-op vs route fallback).
func stopRequested(cancelled <-chan struct{}) bool {
	select {
	case <-cancelled:
		return true
	default:
		return false
	}
}
