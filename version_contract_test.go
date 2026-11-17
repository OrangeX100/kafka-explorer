package main_test

// 版本号一致性契约（045 round-5：发布第十次仍要人肉追改三处版本号）。
// scripts/set_version.py 是唯一写入口；本测试保证任何一处漏改在门禁就
// 被抓，而不是在发布产物里出现"版本号不一致"。
//
// 覆盖位置（set_version.py 的写入集）：
//   Taskfile.yml build/installer 两个任务的 VERSION/VERSIONINFOVERSION 默认值
//   frontend/package.json  version
//   build/versioninfo.json StringFileInfo.FileVersion / ProductVersion

import (
	"encoding/json"
	"os"
	"regexp"
	"testing"
)

func readMust(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(raw)
}

func extractVersion(t *testing.T, s string, label string) string {
	t.Helper()
	re := regexp.MustCompile(`default "(\d+\.\d+\.\d+)"`)
	m := re.FindStringSubmatch(s)
	if m == nil {
		t.Fatalf("%s: no VERSION default found", label)
	}
	return m[1]
}

func TestVersionStampsConsistent(t *testing.T) {
	taskfile := readMust(t, "Taskfile.yml")
	versions := map[string]bool{}

	// Taskfile 里两处 build/installer 默认 VERSION 必须一致
	re := regexp.MustCompile(`VERSION: '\{\{\.VERSION \| default "(\d+\.\d+\.\d+)"\}\}'`)
	for _, m := range re.FindAllStringSubmatch(taskfile, -1) {
		versions[m[1]] = true
	}
	if len(versions) != 1 {
		t.Fatalf("Taskfile 中 VERSION 默认值出现多个不同值: %v", versions)
	}
	var version string
	for v := range versions {
		version = v
	}

	// VERSIONINFOVERSION 默认 = version + ".0"
	re2 := regexp.MustCompile(`VERSIONINFOVERSION: '\{\{\.VERSIONINFOVERSION \| default "(\d+\.\d+\.\d+)\.0"\}\}'`)
	m2 := re2.FindStringSubmatch(taskfile)
	if m2 == nil {
		t.Fatal("Taskfile 中找不到 VERSIONINFOVERSION 默认值")
	}
	if m2[1] != version {
		t.Fatalf("VERSIONINFOVERSION %s 与 VERSION %s 不一致", m2[1], version)
	}

	// frontend/package.json
	pkgRaw := readMust(t, "frontend/package.json")
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal([]byte(pkgRaw), &pkg); err != nil {
		t.Fatalf("parse package.json: %v", err)
	}
	if pkg.Version != version {
		t.Fatalf("frontend/package.json version %s ≠ Taskfile %s", pkg.Version, version)
	}

	// build/versioninfo.json（字符串版本；数值版本 build 时生成）
	viRaw := readMust(t, "build/versioninfo.json")
	for _, field := range []string{"FileVersion", "ProductVersion"} {
		re3 := regexp.MustCompile(`"` + field + `": "(\d+\.\d+\.\d+)"`)
		m3 := re3.FindStringSubmatch(viRaw)
		if m3 == nil {
			t.Fatalf("versioninfo.json 缺少 %s", field)
		}
		if m3[1] != version {
			t.Fatalf("versioninfo.json %s %s ≠ Taskfile %s", field, m3[1], version)
		}
	}

	t.Logf("版本一致性 OK: %s（Taskfile + package.json + versioninfo.json）", version)
}

// set_version.py 的正则必须能命中当前 Taskfile 形态——脚本失效等于退回
// 人肉追改。与 TestVersionStampsConsistent 互补：那个防"漏改一处"，
// 这个防"脚本本身失效"。
func TestSetVersionScriptRegexHitsTaskfile(t *testing.T) {
	taskfile := readMust(t, "Taskfile.yml")
	re := regexp.MustCompile(`VERSION: '\{\{\.VERSION \| default "\d+\.\d+\.\d+"\}\}'`)
	if !re.MatchString(taskfile) {
		t.Fatal("set_version.py 的替换正则无法命中当前 Taskfile 形态——脚本需同步更新")
	}
}
