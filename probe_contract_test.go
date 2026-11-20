package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// TestNoTestFixmeInProbes: test.fixme silently skips a probe AND doesn't
// count as a failure — the release gate promise "探针不过不发版" would be
// void for any known-bug test marked fixme (an infinite release pass while
// the bug stays open). The import UNKNOWN_TOPIC bug is the live example.
// fixme is allowed ONLY with an explicit GitHub issue annotation already
// pushing the fix; the scan below fails on any bare usage.
func TestNoBareTestFixmeInProbes(t *testing.T) {
	dir := "frontend/e2e/tests"
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read %s: %v", dir, err)
	}
	re := regexp.MustCompile(`test\.fixme\(`)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".spec.ts") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		for i, line := range strings.Split(string(data), "\n") {
			if re.MatchString(line) {
				t.Errorf("%s:%s: bare test.fixme found — a fixme silently skips "+
					"the probe and voids the release gate. Either fix the bug and "+
					"restore test(, or track it with an OPEN issue annotation and "+
					"record it in docs/ (release notes must list it). Line: %s",
					path, strconv.Itoa(i+1), strings.TrimSpace(line))
			}
		}
	}
}

// lastReleasedVersion returns the newest and second-newest release tags.
// The probe base must equal the one BEFORE newest — EXCEPT inside the
// release window (bump committed, tag not yet pushed), where set_version
// has already advanced it to newest. Tags carry a "v" prefix.
func lastReleasedVersion(t *testing.T) (newest, second string) {
	out, err := exec.Command("git", "tag", "--sort=-creatordate").Output()
	if err != nil {
		t.Fatalf("git tag: %v", err)
	}
	var seen []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		v := strings.TrimPrefix(strings.TrimSpace(line), "v")
		if v == "" {
			continue
		}
		dup := false
		for _, s := range seen {
			if s == v {
				dup = true
				break
			}
		}
		if !dup {
			seen = append(seen, v)
		}
	}
	if len(seen) < 2 {
		// FAIL, not skip: a tag-less checkout (CI shallow clone without
		// fetch-tags, or a clone that pruned tags) is exactly the environment
		// where this contract must not silently evaporate — it skipped for
		// its entire first CI round that way (checkout defaults to
		// fetch-depth: 1 / fetch-tags: false → ZERO tags on the runner).
		t.Fatalf("release tag 不足两个，无法确定探针基准——契约必须红而不是静默跳过。" +
			"CI: checkout 已配 fetch-tags: true（ci.yml gate）；本地: git fetch --tags")
	}
	return seen[0], seen[1]
}

// TestProbeBaseVersionInContract: the update-flow probe builds a debug
// binary stamped with the PREVIOUS RELEASE (one below the published
// latest), so it discovers the current latest as an update. The stamp lives
// in TWO places that must move together on every release:
//   - .github/actions/e2e-probe/action.yml  (CI debug-build ldflags)
//   - frontend/e2e/tests/update-flow.spec.ts (skip-hint/annotation refs)
//
// set_version.py keeps them in sync at bump time (old version becomes the
// new base). This contract pins both to the second-newest release tag so a
// forgotten bump fails HERE instead of silently skipping the update-chain
// probe in CI while the gate stays green.
func TestProbeBaseVersionInContract(t *testing.T) {
	newest, base := lastReleasedVersion(t)

	// current in-development version must not be used as the probe base —
	// the debug build would equal the published latest and discover nothing
	taskfile, err := os.ReadFile("Taskfile.yml")
	if err != nil {
		t.Fatalf("read Taskfile.yml: %v", err)
	}
	reTask := regexp.MustCompile(`VERSION: '\{\{\.VERSION \| default "(\d+\.\d+\.\d+)"\}\}'`)
	m := reTask.FindStringSubmatch(string(taskfile))
	if m == nil {
		t.Fatal("Taskfile.yml: no VERSION default found")
	}
	if m[1] == base {
		t.Fatalf("探针基准 == 当前版本 %s——debug 构建将发现不了任何更新。"+
			"set_version.py 应在 bump 时把基准改为旧版本", base)
	}

	// action.yml: the CI debug-build stamp must be exactly the base
	action, err := os.ReadFile(".github/actions/e2e-probe/action.yml")
	if err != nil {
		t.Fatalf("read action.yml: %v", err)
	}
	reStamp := regexp.MustCompile(`buildinfo\.Version=(\d+\.\d+\.\d+)`)
	stamp := reStamp.FindStringSubmatch(string(action))
	if stamp == nil {
		t.Fatal("action.yml: no buildinfo.Version stamp found")
	}
	if stamp[1] != base && stamp[1] != newest {
		t.Errorf("e2e-probe/action.yml 探针基准 = %s，应为上一发布版 %s"+
			"（发版窗口内允许 %s）——基准过期会让更新链探针静默 skip 而 CI 仍绿",
			stamp[1], base, newest)
	}

	// update-flow.spec.ts: the PROBE_BASE constant must equal the base. The
	// discover assertion derives from this constant, so a stale constant
	// makes the probe assert a version nobody builds (live example: the
	// stamp moved 0.4.10→0.4.11 while a baked-in assertion still said
	// 0.4.10 — CI e2e failed on a PERFECTLY healthy discover render).
	spec, err := os.ReadFile("frontend/e2e/tests/update-flow.spec.ts")
	if err != nil {
		t.Fatalf("read update-flow.spec.ts: %v", err)
	}
	reBase := regexp.MustCompile(`PROBE_BASE = "(\d+\.\d+\.\d+)"`)
	hint := reBase.FindStringSubmatch(string(spec))
	if hint == nil {
		t.Fatal("update-flow.spec.ts: no PROBE_BASE constant found")
	}
	// Release-window tolerance: set_version.py advances the base to the OLD
	// version the moment a bump happens (0.4.12→0.4.13 writes base=0.4.12),
	// while the newest TAG is still the previous release (0.4.12) until the
	// release commit is tagged — so between "bump" and "tag" the contract
	// must accept BOTH the second-newest tag AND the newest tag. Outside
	// that window a stale base (older than second-newest) stays a failure.
	if hint[1] != base && hint[1] != newest {
		t.Errorf("update-flow.spec.ts PROBE_BASE = %s，应为上一发布版 %s"+
			"（发版窗口内允许 %s）（断言与 skip-hint 都从它派生）",
			hint[1], base, newest)
	}
	// A version literal baked INTO the assertion itself is the drift class
	// that broke the e2e job above — the assertion template must derive
	// from PROBE_BASE, never restate a version. Any literal occurrence of
	// the assertion text with a real digit reintroduces exactly that.
	if re := regexp.MustCompile(`当前版本 0\.`); re.MatchString(string(spec)) {
		t.Errorf("update-flow.spec.ts 断言内出现硬编码版本字面量（当前版本 0.x）——" +
			"应从 PROBE_BASE 常量派生，禁止在断言里写死版本")
	}
}

/*
*
// TestSetupUninstallerSysoCarryVersion: the setup/uninstaller syso files
carry PE VERSIONINFO metadata ONLY if their versioninfo json uses the
FLAT StringFileInfo format goversioninfo expects. The nested
"040904B0" table was silently skipped for years — no FileDescription,
no version, a bare-metadata exe that scores high on AV heuristics
(the exact problem the syso pipeline was built to prevent). This pins
the fix: both syso must embed the current Taskfile version (UTF-16).
*/
func TestSetupUninstallerSysoCarryVersion(t *testing.T) {
	taskfile, err := os.ReadFile("Taskfile.yml")
	if err != nil {
		t.Fatalf("read Taskfile.yml: %v", err)
	}
	reTask := regexp.MustCompile(`VERSION: '\{\{\.VERSION \| default "(\d+\.\d+\.\d+)"\}\}'`)
	m := reTask.FindStringSubmatch(string(taskfile))
	if m == nil {
		t.Fatal("Taskfile.yml: no VERSION default found")
	}
	ver := m[1]
	verUTF16 := utf16Encode(ver)
	for _, f := range []string{
		"cmd/setup/setup_windows.syso",
		"cmd/uninstaller/uninstall_windows.syso",
	} {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		if !bytes.Contains(data, verUTF16) {
			t.Errorf("%s 不含版本 %s（UTF-16）——VERSIONINFO 资源缺失或过期；"+
				"重跑 Taskfile installer 的 goversioninfo 步骤，并确认对应 "+
				"versioninfo json 是扁平 StringFileInfo 结构", f, ver)
		}
	}
}

// utf16Encode encodes an ASCII-safe version string to UTF-16-LE bytes.
func utf16Encode(s string) []byte {
	var b []byte
	for _, r := range s {
		b = append(b, byte(r), byte(r>>8))
	}
	return b
}
