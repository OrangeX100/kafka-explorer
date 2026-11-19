package main

import (
	"os"
	"strconv"
	"path/filepath"
	"regexp"
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

// TestProbeBaseVersionInContract: the update-flow probe builds a debug
// binary stamped ONE VERSION BELOW the published latest, so the version
// string lives in THREE places (action.yml, update-flow.spec.ts comments,
// set_version.py reach). This contract pins the action.yml + spec refs so
// the next set_version.py bump (which rewrites 0.4.N everywhere via the
// shared regexes) cannot leave a stale base behind — a stale base makes
// the debug build version == published latest and the update-chain probe
// silently skips while CI stays green.
func TestProbeBaseVersionInContract(t *testing.T) {
	// 1. Taskfile VERSION default is the source of truth
	taskfile, err := os.ReadFile("Taskfile.yml")
	if err != nil {
		t.Fatalf("read Taskfile.yml: %v", err)
	}
	reTask := regexp.MustCompile(`VERSION: '\{\{\.VERSION \| default "(\d+\.\d+\.\d+)"\}\}'`)
	m := reTask.FindStringSubmatch(string(taskfile))
	if m == nil {
		t.Fatal("Taskfile.yml: no VERSION default found")
	}
	base := m[1]

	// 2. update-flow.spec.ts: skip hint + retry annotation reference the
	//    base version (the version BELOW base is what the debug build
	//    must carry; assert the spec no longer mentions the PREVIOUS base)
	spec, err := os.ReadFile("frontend/e2e/tests/update-flow.spec.ts")
	if err != nil {
		t.Fatalf("read update-flow.spec.ts: %v", err)
	}
	// parse base "0.4.11" → previous "0.4.10"
	parts := strings.Split(base, ".")
	minor, err := strconv.Atoi(parts[1])
	if err != nil {
		t.Fatalf("parse base minor: %v", err)
	}
	prevBase := parts[0] + "." + itoa(minor-1) + "." + parts[2]
	if strings.Contains(string(spec), prevBase) {
		t.Errorf("update-flow.spec.ts still references the PREVIOUS probe base %s — "+
			"bump it to %s (set_version.py should have done this)", prevBase, prevBase)
	}

	// 3. action.yml must stamp the base-1 version for the debug build
	action, err := os.ReadFile(".github/actions/e2e-probe/action.yml")
	if err != nil {
		t.Fatalf("read action.yml: %v", err)
	}
	if strings.Contains(string(action), prevBase) {
		t.Errorf("e2e-probe/action.yml still references the PREVIOUS probe base %s — "+
			"the CI debug build would equal the published latest and the "+
			"update-chain probe would silently skip", prevBase)
	}
}

func itoa(n int) string {
	return strings.TrimSpace(strconv.Itoa(n))
}
