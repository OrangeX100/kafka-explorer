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
}

// UpdateService implements the version update mechanism: query the latest
// published GitHub release of a configured repo and compare it against the
// running binary's version. The repo comes from user settings, so the
// mechanism works for any future public/internal release host on the
// GitHub API shape.
type UpdateService struct {
	current string
	client  *http.Client
}

func NewUpdateService(currentVersion string) *UpdateService {
	return &UpdateService{
		current: currentVersion,
		// Bounded: an unreachable update server must never hang the caller
		// (the settings page shows a friendly timeout, not a frozen button).
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

// Check queries the latest release for repo ("owner/repo") and compares it
// semantically against the current version.
func (s *UpdateService) Check(ctx context.Context, repo string) (UpdateCheck, error) {
	repo = strings.TrimSpace(repo)
	if repo == "" {
		return UpdateCheck{}, fmt.Errorf("%w: 未配置更新源，请先在设置中填写 GitHub 仓库（owner/repo）", domain.ErrInvalid)
	}
	if !updateRepoRe.MatchString(repo) {
		return UpdateCheck{}, fmt.Errorf("%w: 更新源格式不正确，应为 owner/repo（例如 your-github/kafka-explorer）", domain.ErrInvalid)
	}

	url := fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return UpdateCheck{}, fmt.Errorf("%w: 构造更新请求失败", domain.ErrUnavailable)
	}
	// GitHub API requires a UA; the Accept header pins the stable JSON shape.
	req.Header.Set("User-Agent", "kafka-explorer-updater")
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := s.client.Do(req)
	if err != nil {
		return UpdateCheck{}, fmt.Errorf("%w: 无法连接更新源，请检查网络后重试", domain.ErrUnavailable)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		// GitHub answers 404 for BOTH "no releases yet" and "private repo,
		// unauthenticated" — the latter is the normal state while the
		// project is still private.
		return UpdateCheck{}, fmt.Errorf("%w: 更新源 %s 尚无发布版本，或仓库仍为私有（转公开后即可检查）", domain.ErrNotFound, repo)
	case resp.StatusCode == http.StatusForbidden:
		return UpdateCheck{}, fmt.Errorf("%w: 更新源请求被限流，请稍后再试", domain.ErrUnavailable)
	case resp.StatusCode != http.StatusOK:
		return UpdateCheck{}, fmt.Errorf("%w: 更新源返回异常状态 %d", domain.ErrUnavailable, resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return UpdateCheck{}, fmt.Errorf("%w: 读取更新源响应失败", domain.ErrUnavailable)
	}
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
		HasUpdate: versionLess(s.current, latest),
		Current:   s.current,
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
