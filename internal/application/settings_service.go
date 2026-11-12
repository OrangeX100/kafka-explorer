package application

import (
	"context"
	"encoding/json"
	"regexp"

	"kafkaexplorer/internal/buildinfo"
	"kafkaexplorer/internal/infrastructure/store"
)

// updateRepoRe matches a GitHub "owner/repo" pair (letters, digits, dash,
// dot, underscore; no spaces or slashes beyond the one separator).
var updateRepoRe = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)

// Settings is the app's user preferences. Every field has a sensible zero
// value so a fresh install behaves like the dark dense default.
type Settings struct {
	Theme           string `json:"theme"`           // dark | light | system
	Locale          string `json:"locale"`          // zh-CN | en | system
	Density         string `json:"density"`         // compact | comfortable
	FontSize        int    `json:"fontSize"`        // UI zoom baseline, px
	FontFamily      string `json:"fontFamily"`      // CJK / base font-family key ("" = system stack)
	FontLatin       string `json:"fontLatin"`       // Latin font-family key ("" = follow the CJK stack)
	PageSize        int    `json:"pageSize"`        // message page size
	ShowInternal    bool   `json:"showInternal"`    // include __consumer_offsets etc.
	MaxScan         int    `json:"maxScan"`         // find scan budget
	UpdateRepo      string `json:"updateRepo"`      // GitHub "owner/repo" the update check queries
	AutoCheckUpdate bool   `json:"autoCheckUpdate"` // check once per app boot
	// CloseToTray: the window ✕ hides to the system tray instead of
	// quitting. Default true — a management tool keeps its pooled cluster
	// connections warm while "closed".
	CloseToTray bool `json:"closeToTray"`
}

// fontFamilies is the whitelist of allowed FontFamily keys. The frontend
// maps each key to a concrete CSS stack — storing KEYS (not raw CSS) keeps
// arbitrary strings out of the DOM style attribute.
// Open-source presets (OFL unless noted) are listed in the UI with an
// install-state badge; the whitelist accepts them whether or not they are
// installed — an uninstalled pick simply falls back down the stack.
var fontFamilies = map[string]bool{
	"": true, // system default stack
	// system-shipped CJK
	"yaHei":    true, // Microsoft YaHei
	"dengXian": true, // DengXian
	"simSun":   true, // SimSun (宋体)
	// open-source CJK
	"sourceHanSans":  true, // 思源黑体 (Source Han Sans SC / Noto Sans CJK SC, OFL)
	"sourceHanSerif": true, // 思源宋体 (Source Han Serif SC, OFL)
	"lxgwWenKai":     true, // 霞鹜文楷 (LXGW WenKai, OFL)
	"miSans":         true, // MiSans (小米, 免费商用)
	"harmonySans":    true, // HarmonyOS Sans SC (免费商用)
	"puHuiTi":        true, // 阿里巴巴普惠体 (免费商用)
	// legacy generic keys (pre split-setting): still accepted, migrated in the UI
	"serif": true, // generic serif
	"mono":  true, // monospace
	// Latin presets
	"segoe":         true, // Segoe UI (system-shipped)
	"inter":         true, // Inter (OFL)
	"roboto":        true, // Roboto (Apache-2.0)
	"openSans":      true, // Open Sans (OFL)
	"sourceSans3":   true, // Source Sans 3 (OFL)
	"jetBrainsMono": true, // JetBrains Mono (OFL, mono)
	"firaCode":      true, // Fira Code (OFL, mono)
	"cascadiaCode":  true, // Cascadia Code (OFL, mono, Win11-shipped)
}

// DefaultSettings returns the shipped defaults.
func DefaultSettings() Settings {
	return Settings{
		Theme:        "light",
		Locale:       "zh-CN",
		Density:      "compact",
		FontSize:     14,
		FontFamily:   "",
		FontLatin:    "",
		PageSize:     50, // default: 50 per page
		ShowInternal: true,
		MaxScan:      100_000,
		// Release builds stamp their public repo here (see Taskfile); a
		// user-configured repo (loaded over these defaults below) wins.
		UpdateRepo:      buildinfo.UpdateRepo,
		AutoCheckUpdate: true,
		CloseToTray:     true,
	}
}

// SettingsService persists settings server-side so preferences survive
// across machines (the localStorage copy stays as the boot-time cache).
type SettingsService struct {
	db *store.DBWrapper
}

func NewSettingsService(db *store.DBWrapper) *SettingsService {
	return &SettingsService{db: db}
}

const settingsKey = "app.settings"

// Get returns stored settings merged over defaults (absent keys keep defaults).
func (s *SettingsService) Get(ctx context.Context) (Settings, error) {
	out := DefaultSettings()
	raw, err := s.db.GetSetting(ctx, settingsKey)
	if err != nil {
		return out, err
	}
	if raw == "" {
		return out, nil
	}
	// Unmarshal into the defaults: missing JSON keys keep their default,
	// unknown keys are ignored (forward-compatible).
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return DefaultSettings(), nil // corrupt payload -> defaults, never fail the app boot
	}
	// An empty stored repo means "use the release's baked-in source" —
	// JSON keeps the stored "" over the default, so re-apply the fallback.
	if out.UpdateRepo == "" {
		out.UpdateRepo = buildinfo.UpdateRepo
	}
	return out, nil
}

// Save validates and persists the settings blob.
func (s *SettingsService) Save(ctx context.Context, in Settings) (Settings, error) {
	if in.Theme != "dark" && in.Theme != "light" && in.Theme != "system" {
		in.Theme = "light"
	}
	if in.Locale != "zh-CN" && in.Locale != "en" && in.Locale != "system" {
		in.Locale = "zh-CN"
	}
	if in.FontSize < 12 || in.FontSize > 24 {
		in.FontSize = 14
	}
	if !fontFamilies[in.FontFamily] {
		in.FontFamily = ""
	}
	if !fontFamilies[in.FontLatin] {
		in.FontLatin = ""
	}
	if in.Density != "compact" && in.Density != "comfortable" {
		in.Density = "compact"
	}
	if in.PageSize < 10 || in.PageSize > 1000000 {
		in.PageSize = 50
	}
	if in.MaxScan < 1000 || in.MaxScan > 1_000_000 {
		in.MaxScan = 100_000
	}
	// UpdateRepo: either empty (update check disabled) or a GitHub
	// "owner/repo" pair — anything else would produce a malformed API URL.
	if in.UpdateRepo != "" && !updateRepoRe.MatchString(in.UpdateRepo) {
		in.UpdateRepo = ""
	}
	raw, err := json.Marshal(in)
	if err != nil {
		return in, err
	}
	return in, s.db.SetSetting(ctx, settingsKey, string(raw))
}
