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
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"go.uber.org/zap"

	"kafkaexplorer/internal/appdir"
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

// downloadMirrors are public read-only accelerators for GitHub release
// downloads, tried automatically after the direct route stalls — the
// user never configures anything. Purely additive candidates: the direct
// URL is always tried first, so networks with good GitHub access are
// unaffected.
var downloadMirrors = []string{
	"https://ghfast.top/",
	"https://gh-proxy.com/",
}

// downloadCandidates expands the asset URL into the ordered list of
// routes to try: direct first, then each mirror prefix. Only GitHub
// release-download URLs get mirrors (the accelerator path form is
// prefix + full original URL).
func downloadCandidates(assetURL string) []string {
	const ghPrefix = "https://github.com/"
	if !strings.HasPrefix(assetURL, ghPrefix) {
		return []string{assetURL}
	}
	out := []string{assetURL}
	for _, m := range downloadMirrors {
		out = append(out, m+assetURL)
	}
	return out
}

// StageUpdate downloads the setup asset into DataDir/updates with
// progress ticks. cancelled is polled between chunks — closing it is the
// stop button, and the .part file is removed so a later retry starts
// over. Direct GitHub downloads that stall or crawl (typical on CN
// networks) automatically fall through to the built-in mirrors: the user
// sees one progress bar and never picks a route.
func (s *UpdateService) StageUpdate(ctx context.Context, assetURL string, assetSize int64, manifestSHA string, progress func(Progress), cancelled <-chan struct{}) (string, error) {
	if runtime.GOOS != "windows" {
		return "", fmt.Errorf("%w: 自动更新当前仅支持 Windows", domain.ErrInvalid)
	}
	if assetURL == "" {
		return "", fmt.Errorf("%w: 该发布版本未附带安装包，请从发布页手动下载", domain.ErrInvalid)
	}
	dir, err := updatesDir()
	if err != nil {
		return "", err
	}
	name := assetNameFromURL(assetURL)
	dest := filepath.Join(dir, name)
	part := dest + ".part"

	var lastErr error
	for _, route := range downloadCandidates(assetURL) {
		// routeErr must NOT shadow the cancellation checks below: the old
		// code read the (always-nil) updatesDir error here, so a cancel was
		// treated as success and the TRUNCATED .part got renamed into the
		// installer. routeErr carries tryRoute's real outcome — including
		// errCancelled, which tryRoute now ALWAYS returns on cancellation.
		_, routeErr := s.tryRoute(ctx, route, assetSize, part, manifestSHA, progress, cancelled)
		if routeErr == errCancelled || ctx.Err() != nil {
			os.Remove(part)
			return "", nil // stop button: not an error
		}
		if routeErr == nil {
			if err := os.Rename(part, dest); err != nil {
				os.Remove(part)
				return "", fmt.Errorf("暂存安装包失败: %w", err)
			}
			progress(Progress{Bytes: assetSize, Total: assetSize})
			return dest, nil
		}
		os.Remove(part)
		lastErr = routeErr // remember; the next route gets a chance
	}
	if lastErr != nil {
		return "", lastErr
	}
	return "", fmt.Errorf("%w: 所有下载通道均失败，请检查网络后重试，或到发布页手动下载", domain.ErrUnavailable)
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
func (s *UpdateService) tryRoute(ctx context.Context, assetURL string, assetSize int64, part string, manifestSHA string, progress func(Progress), cancelled <-chan struct{}) (string, error) {
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
		sidecar, status := fetchExpectedChecksum(ctx, downloadCandidates(assetURL+".sha256"))
		switch status {
		case checksumOK:
			want = sidecar
		case checksumMissing:
			// legacy release without a sidecar: keep the legacy size-only
			// downgrade — but the decision is logged, not silent ("say so in
			// the log" promise from the checksumMissing comment).
			s.log.Warn("安装包校验文件缺失（legacy 发布），仅按文件大小校验后放行",
				zap.String("asset", assetURL))
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
		os.Remove(part)
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
	if err := os.WriteFile(script, []byte(body), 0o600); err != nil {
		return fmt.Errorf("写入等待脚本失败: %w", err)
	}
	relaunchFlag := "0"
	if relaunch {
		relaunchFlag = "1"
	}
	return launchDetached(
		filepath.Join(systemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		`-NoProfile -ExecutionPolicy Bypass -File "`+script+`"`,
		map[string]string{
			"KE_UPDATE_PID":      fmt.Sprint(os.Getpid()),
			"KE_UPDATE_SETUP":    setupPath,
			"KE_UPDATE_APP":      appPath,
			"KE_UPDATE_RELAUNCH": relaunchFlag,
		},
	)
}

func systemRoot() string {
	if root := os.Getenv("SystemRoot"); root != "" {
		return root
	}
	return `C:\Windows`
}

// waiterScriptBody builds the waiter PowerShell script. Two traps are baked
// in here rather than at the call site so a regression test can pin them:
// (1) Get-Process carries -ErrorAction SilentlyContinue — the app usually
// exits BEFORE PowerShell starts, and without the flag the not-found error
// escalates under $ErrorActionPreference='Stop' and kills the waiter
// silently (no install, no log); (2) logFile is embedded in a single-quoted
// PS string, so a path containing ' (e.g. a username like O'Brien) must be
// escaped by doubling or the script fails to parse.
func waiterScriptBody(logFile string) string {
	psLogFile := strings.ReplaceAll(logFile, "'", "''")
	return "$ErrorActionPreference = 'Stop'\n" +
		"$waitFor = [int]$env:KE_UPDATE_PID\n" +
		"while (Get-Process -Id $waitFor -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 100 }\n" +
		"try {\n" +
		"  Start-Process -FilePath $env:KE_UPDATE_SETUP -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/CLOSEAPPLICATIONS','/SP-' -Wait -ErrorAction Stop\n" +
		"  if ($env:KE_UPDATE_RELAUNCH -eq '1') { Start-Process -FilePath $env:KE_UPDATE_APP }\n" +
		"} catch {\n" +
		"  $_ | Out-File -FilePath '" + psLogFile + "' -Encoding utf8\n" +
		"}\n"
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
