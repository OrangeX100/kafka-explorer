package application

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"kafkaexplorer/internal/domain"
)

// UpdateCheck is the result of one update-server query. Error/absence is
// carried by the returned error, never by sentinel fields — the frontend
// classifies the error and renders the friendly guidance.
type UpdateCheck struct {
	HasUpdate bool   `json:"hasUpdate"` // latest > current
	Current   string `json:"current"`   // this binary's version
	Latest    string `json:"latest"`    // latest published tag
	URL       string `json:"url"`       // release page for the user to open/copy
	Notes     string `json:"notes"`     // release notes body (truncated)
	// Setup asset (the Inno Setup installer) when the release carries one:
	// the auto-update downloads THIS, not the page. Zero values mean the
	// release has no installer attached — the UI falls back to the URL.
	AssetURL  string `json:"assetUrl,omitempty"`
	AssetSize int64  `json:"assetSize,omitempty"`
	AssetName string `json:"assetName,omitempty"`
	// AssetSha256: the manifest-embedded digest (latest.json) — the staging
	// download verifies against it FIRST, before falling back to the .sha256
	// sidecar, and hard-fails when neither is obtainable.
	AssetSha256 string `json:"assetSha256,omitempty"`
}

// UpdateService implements the version update mechanism: query the latest
// published GitHub release of a configured repo and compare it against the
// running binary's version. The repo comes from user settings, so the
// mechanism works for any future public/internal release host on the
// GitHub API shape.
type UpdateService struct {
	current string
	client  *http.Client
	// baseURL: https://api.github.com in production; tests point it at a
	// local fixture to exercise the conditional-request flow deterministically.
	baseURL string
	// Conditional-request cache: GitHub does NOT count a 304 (If-None-Match
	// hit) against the unauthenticated 60 req/hour limit, so repeated
	// "check update" clicks stay free while a release is unchanged. Keyed
	// by repo. In-memory only — a restart spends one request, which is fine.
	mu   sync.Mutex
	etag map[string]conditionalCache
}

type conditionalCache struct {
	etag string
	body []byte
}

func NewUpdateService(currentVersion string) *UpdateService {
	return &UpdateService{
		current: currentVersion,
		// Bounded: an unreachable update server must never hang the caller
		// (the settings page shows a friendly timeout, not a frozen button).
		client:  &http.Client{Timeout: 10 * time.Second},
		etag:    map[string]conditionalCache{},
		baseURL: "https://api.github.com",
	}
}

// Check queries the latest release for repo ("owner/repo") and compares it
// semantically against the current version. Primary source is the
// release-attached latest.json manifest (a STATIC download — no GitHub API
// quota, mirrors reachable from CN); the API+ETag path stays as fallback.
func (s *UpdateService) Check(ctx context.Context, repo string) (UpdateCheck, error) {
	repo = strings.TrimSpace(repo)
	if repo == "" {
		return UpdateCheck{}, fmt.Errorf("%w: 未配置更新源，请先在设置中填写 GitHub 仓库（owner/repo）", domain.ErrInvalid)
	}
	if !updateRepoRe.MatchString(repo) {
		return UpdateCheck{}, fmt.Errorf("%w: 更新源格式不正确，应为 owner/repo（例如 your-github/kafka-explorer）", domain.ErrInvalid)
	}

	if out, manifestErr := s.checkViaManifest(ctx, repo); manifestErr == nil {
		return out, nil
	}
	// Manifest missing (releases older than the manifest era), unreachable,
	// or unparsable — the API+ETag path is the fallback.
	return s.checkViaAPI(ctx, repo)
}

// releaseManifestURL: the STATIC releases/latest/download/ redirect —
// NOT api.github.com, so it carries no rate limit.
func releaseManifestURL(repo string) string {
	return fmt.Sprintf("https://github.com/%s/releases/latest/download/latest.json", repo)
}

// checkViaManifest downloads latest.json through the mirror candidates
// (direct → ghfast → gh-proxy; a few hundred bytes, any reachable route
// answers instantly) and parses it into an UpdateCheck.
func (s *UpdateService) checkViaManifest(ctx context.Context, repo string) (UpdateCheck, error) {
	var lastErr error
	for _, u := range downloadCandidates(releaseManifestURL(repo)) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return UpdateCheck{}, err
		}
		req.Header.Set("User-Agent", "kafka-explorer-updater")
		resp, err := s.client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if readErr != nil || resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("%s: HTTP %d", u, resp.StatusCode)
			continue
		}
		out, err := parseManifest(s.current, repo, body)
		if err != nil {
			return UpdateCheck{}, err // a real manifest but bad content — no route will fix that
		}
		return out, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("无可用下载路由")
	}
	return UpdateCheck{}, lastErr
}

// releaseManifest is the on-disk shape of latest.json (generated by the
// release workflow alongside the installer).
type releaseManifest struct {
	TagName     string `json:"tagName"`
	Notes       string `json:"notes"`
	AssetName   string `json:"assetName"`
	AssetSize   int64  `json:"assetSize"`
	AssetSHA256 string `json:"assetSHA256,omitempty"`
}

func parseManifest(currentVersion, repo string, body []byte) (UpdateCheck, error) {
	var m releaseManifest
	if err := json.Unmarshal(body, &m); err != nil {
		return UpdateCheck{}, fmt.Errorf("%w: latest.json 解析失败: %v", domain.ErrUnavailable, err)
	}
	latest := strings.TrimPrefix(strings.TrimSpace(m.TagName), "v")
	if latest == "" {
		return UpdateCheck{}, fmt.Errorf("%w: latest.json 缺少 tagName", domain.ErrUnavailable)
	}
	notes := strings.TrimSpace(m.Notes)
	if len(notes) > 2000 {
		notes = notes[:2000] + "…"
	}
	out := UpdateCheck{
		HasUpdate: versionLess(currentVersion, latest),
		Current:   currentVersion,
		Latest:    latest,
		URL:       fmt.Sprintf("https://github.com/%s/releases/tag/v%s", repo, latest),
		Notes:     notes,
	}
	// The setup asset lives in the same release; the static download URL
	// rides the same mirror candidates as the manifest itself.
	if runtime.GOOS == "windows" && m.AssetName != "" {
		out.AssetName = m.AssetName
		out.AssetURL = fmt.Sprintf("https://github.com/%s/releases/download/v%s/%s", repo, latest, m.AssetName)
		out.AssetSize = m.AssetSize
		out.AssetSha256 = strings.ToLower(strings.TrimSpace(m.AssetSHA256))
	}
	return out, nil
}

// checkViaAPI is the legacy path: GitHub API + ETag conditional requests
// (304 hits cost zero of the 60 req/hour unauthenticated budget).
func (s *UpdateService) checkViaAPI(ctx context.Context, repo string) (UpdateCheck, error) {
	url := fmt.Sprintf("%s/repos/%s/releases/latest", s.baseURL, repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return UpdateCheck{}, fmt.Errorf("%w: 构造更新请求失败", domain.ErrUnavailable)
	}
	// GitHub API requires a UA; the Accept header pins the stable JSON shape.
	req.Header.Set("User-Agent", "kafka-explorer-updater")
	req.Header.Set("Accept", "application/vnd.github+json")
	// Conditional request: a 304 costs ZERO of the 60 req/hour unauthenticated
	// budget, so hammering "check update" while a release is unchanged never
	// trips the rate limit.
	s.mu.Lock()
	cached, hasCache := s.etag[repo]
	s.mu.Unlock()
	if hasCache {
		req.Header.Set("If-None-Match", cached.etag)
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return UpdateCheck{}, fmt.Errorf("%w: 无法连接更新源，请检查网络后重试", domain.ErrUnavailable)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotModified && hasCache:
		// Unchanged release: serve the cached body (no quota spent).
		return parseRelease(s.current, cached.body)
	case resp.StatusCode == http.StatusNotFound:
		// GitHub answers 404 for BOTH "no releases yet" and "private repo,
		// unauthenticated" — the latter is the normal state while the
		// project is still private.
		return UpdateCheck{}, fmt.Errorf("%w: 更新源 %s 尚无发布版本，或仓库仍为私有（转公开后即可检查）", domain.ErrNotFound, repo)
	case resp.StatusCode == http.StatusForbidden:
		// Rate limited (or blocked). X-RateLimit-Reset names the epoch the
		// window resets at — say the actual minutes instead of "later".
		msg := "更新源请求被限流"
		if reset := resp.Header.Get("X-RateLimit-Reset"); reset != "" {
			if epoch, err := strconv.ParseInt(reset, 10, 64); err == nil {
				mins := int(time.Until(time.Unix(epoch, 0)).Minutes()) + 1
				msg = fmt.Sprintf("更新源请求被限流（GitHub 对未认证请求每小时 60 次），约 %d 分钟后恢复，也可稍后重试", mins)
			}
		}
		return UpdateCheck{}, fmt.Errorf("%w: %s", domain.ErrUnavailable, msg)
	case resp.StatusCode != http.StatusOK:
		return UpdateCheck{}, fmt.Errorf("%w: 更新源返回异常状态 %d", domain.ErrUnavailable, resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return UpdateCheck{}, fmt.Errorf("%w: 读取更新源响应失败", domain.ErrUnavailable)
	}
	// Cache the body + ETag for the next conditional round-trip.
	if etag := resp.Header.Get("ETag"); etag != "" {
		s.mu.Lock()
		s.etag[repo] = conditionalCache{etag: etag, body: body}
		s.mu.Unlock()
	}
	return parseRelease(s.current, body)
}

// parseRelease turns one releases/latest JSON body into an UpdateCheck.
// Shared by the fresh-200 and the 304-cached paths so both behave identically.
func parseRelease(currentVersion string, body []byte) (UpdateCheck, error) {
	var release struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
		Body    string `json:"body"`
		Assets  []struct {
			Name               string `json:"name"`
			Size               int64  `json:"size"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(body, &release); err != nil {
		return UpdateCheck{}, fmt.Errorf("%w: 更新源响应格式异常", domain.ErrUnavailable)
	}

	latest := strings.TrimPrefix(strings.TrimSpace(release.TagName), "v")
	notes := strings.TrimSpace(release.Body)
	if len(notes) > 2000 {
		notes = notes[:2000] + "…"
	}
	out := UpdateCheck{
		HasUpdate: versionLess(currentVersion, latest),
		Current:   currentVersion,
		Latest:    latest,
		URL:       release.HTMLURL,
		Notes:     notes,
	}
	// Setup asset: name pattern matches what the installer task publishes
	// (KafkaExplorer_Setup_<version>.exe). Only on Windows — other GOOS has
	// no installer to run.
	if runtime.GOOS == "windows" {
		for _, a := range release.Assets {
			if strings.HasPrefix(a.Name, "KafkaExplorer_Setup_") && strings.HasSuffix(a.Name, ".exe") {
				out.AssetName = a.Name
				out.AssetURL = a.BrowserDownloadURL
				out.AssetSize = a.Size
				break
			}
		}
	}
	return out, nil
}

// versionLess reports whether a < b by full semver precedence:
// numeric triples first, then release > pre-release of the same triple,
// then identifier-wise pre-release comparison — so 0.2.0-beta.1 <
// 0.2.0-beta.2 < 0.2.0 all hold, and iterating betas is visible to the
// update check (the old triple-only compare called every 0.2.0-* equal).
func versionLess(a, b string) bool {
	return semverLess(parseSemver(a), parseSemver(b))
}

// semverKey is a parsed version: the numeric triple plus pre-release
// identifiers (nil = a release, which semver sorts AFTER every
// pre-release of the same triple). Build metadata ("+…") never compares.
type semverKey struct {
	triple [3]int
	pre    []string
}

func parseSemver(v string) semverKey {
	var k semverKey
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexByte(v, '+'); i >= 0 {
		v = v[:i] // build metadata is ignored for precedence
	}
	if i := strings.IndexByte(v, '-'); i >= 0 {
		k.pre = strings.Split(v[i+1:], ".")
		v = v[:i]
	}
	for i, part := range strings.SplitN(v, ".", 3) {
		n, _ := leadingInt(part)
		k.triple[i] = n
	}
	return k
}

func semverLess(a, b semverKey) bool {
	for i := 0; i < 3; i++ {
		if a.triple[i] != b.triple[i] {
			return a.triple[i] < b.triple[i]
		}
	}
	switch {
	case len(a.pre) == 0 && len(b.pre) == 0:
		return false
	case len(a.pre) == 0:
		return false // a is the release of the shared triple
	case len(b.pre) == 0:
		return true // b is the release, a is a pre-release of it
	}
	for i := 0; i < len(a.pre) && i < len(b.pre); i++ {
		anNum, aNum := leadingInt(a.pre[i])
		bnNum, bNum := leadingInt(b.pre[i])
		switch {
		case aNum && bNum:
			if anNum != bnNum {
				return anNum < bnNum
			}
		case aNum != bNum:
			return aNum // numeric identifiers sort below alphanumeric
		case a.pre[i] != b.pre[i]:
			return a.pre[i] < b.pre[i]
		}
	}
	return len(a.pre) < len(b.pre) // a prefix list sorts before a longer one
}

func leadingInt(s string) (int, bool) {
	digits := s
	// Cut at the first non-digit: "0-dev" → 0, "rc1" → 1.
	for i, r := range s {
		if r < '0' || r > '9' {
			digits = s[:i]
			break
		}
	}
	if digits == "" {
		return 0, false
	}
	n, err := strconv.Atoi(digits)
	if err != nil {
		return 0, false
	}
	return n, true
}
