package main_test

import (
	"os"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// Guarding the build script itself (governance rule 1): task names are
// referenced from CI, docs and developer muscle memory — renaming one is a
// breaking change and must be caught by the gate, not by a red CI run.
func TestTaskfileContract(t *testing.T) {
	raw, err := os.ReadFile("Taskfile.yml")
	if err != nil {
		t.Fatalf("read Taskfile.yml: %v", err)
	}
	var tf struct {
		Tasks map[string]struct {
			Desc string `yaml:"desc"`
			Deps []string `yaml:"deps"`
			Cmds []any `yaml:"cmds"`
		} `yaml:"tasks"`
	}
	if err := yaml.Unmarshal(raw, &tf); err != nil {
		t.Fatalf("parse Taskfile.yml: %v", err)
	}

	for _, name := range []string{"generate:bindings", "audit", "build:frontend", "build", "test", "precommit", "dev"} {
		if _, ok := tf.Tasks[name]; !ok {
			t.Errorf("required task %q missing from Taskfile.yml", name)
		}
	}

	// Resource embedding must never regress to a bare `go build`: without
	// the versioninfo/manifest syso the exe loses its AV-relevant metadata
	// (FileDescription et al — the 360 false-positive mitigation), and
	// without app_windows.syso the taskbar icon lookup (WM_SETICON on
	// resource ID 1) silently breaks. Both actually happened before this
	// test existed.
	build, ok := tf.Tasks["build"]
	if !ok {
		t.Fatal("build task missing")
	}
	var buildCmds []string
	for _, item := range build.Cmds {
		if s, isStr := item.(string); isStr {
			buildCmds = append(buildCmds, s)
		}
	}
	joined := strings.Join(buildCmds, "\n")
	for _, required := range []string{"sync_versioninfo.py", "goversioninfo", "-trimpath", "-ldflags"} {
		if !strings.Contains(joined, required) {
			t.Errorf("build task cmds missing %q — PE metadata/flags must stay wired (AV false-positive mitigation)", required)
		}
	}
	// Stale-dist guard: `task build` must refresh frontend/dist first.
	found := false
	for _, dep := range build.Deps {
		if dep == "build:frontend" {
			found = true
		}
	}
	if !found {
		t.Error("build task must depend on build:frontend — otherwise the exe embeds a stale frontend/dist")
	}
}

// The gate must run in the governance order: bindings → audits → frontend
// build → go build → go test. Parsed structurally from the YAML so wording
// changes in descriptions can never fool (or break) this check.
func TestPrecommitGateOrder(t *testing.T) {
	raw, err := os.ReadFile("Taskfile.yml")
	if err != nil {
		t.Fatalf("read Taskfile.yml: %v", err)
	}
	var tf struct {
		Tasks map[string]struct {
			Cmds []any `yaml:"cmds"`
		} `yaml:"tasks"`
	}
	if err := yaml.Unmarshal(raw, &tf); err != nil {
		t.Fatalf("parse Taskfile.yml: %v", err)
	}
	pre, ok := tf.Tasks["precommit"]
	if !ok {
		t.Fatal("precommit task missing")
	}

	var order []string
	for _, item := range pre.Cmds {
		// Taskfile cmd items are either plain strings or one-key maps
		// ("task: name" / "cmd: ..."). Only task references matter here.
		if m, isMap := item.(map[string]any); isMap {
			if ref, hasTask := m["task"].(string); hasTask {
				order = append(order, ref)
			}
		}
	}

	// build depends on build:frontend since the stale-dist incident (a
	// bare `task build` shipped the previous frontend three times) — the
	// chain therefore references build only.
	want := []string{"generate:bindings", "audit", "build", "test"}
	if len(order) != len(want) {
		t.Fatalf("precommit chains %v, want exactly %v", order, want)
	}
	for i, w := range want {
		if order[i] != w {
			t.Errorf("precommit step %d = %q, want %q (governance order)", i+1, order[i], w)
		}
	}
}
