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
		return UpdateCheck{}, fmt.Errorf("%w: 更新源 %s 尚无发布版本（releases 为空）", domain.ErrNotFound, repo)
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

// versionLess reports whether a < b comparing leading numeric triples
// ("0.1.0-dev" → 0.1.0; "v1.2.3" → 1.2.3). Non-numeric residue after the
// third component is ignored, so pre-release suffixes never compare.
func versionLess(a, b string) bool {
	as, bs := semverTriple(a), semverTriple(b)
	for i := 0; i < 3; i++ {
		if as[i] != bs[i] {
			return as[i] < bs[i]
		}
	}
	return false
}

func semverTriple(v string) [3]int {
	var out [3]int
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	for i, part := range strings.SplitN(v, ".", 3) {
		if i >= 3 {
			break
		}
		n, ok := leadingInt(part)
		if !ok {
			break
		}
		out[i] = n
	}
	return out
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
