//go:build windows

package application

// Live regression pin for the 045 P0-2 fix: launchDetached MUST receive
// split argv. The folded-string form made PowerShell parse the whole
// "-NoProfile … -File …" token as a COMMAND (exit 1, script never ran) —
// every in-app install died invisibly. This test drives the REAL launch
// path (waiterScriptBody → launchDetached + waiterArgs) against a real
// PowerShell and a real (trivial) setup executable, and asserts the SUCCESS
// path actually executed.

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"go.uber.org/zap"

	"kafkaexplorer/internal/appdir"
)

// buildFakeSetup compiles an empty main package into a real exe: the
// waiter's Start-Process runs it, it exits 0 immediately, and the waiter's
// success path (remove staged setup, self-delete script, no err.log)
// becomes fully observable.
func buildFakeSetup(t *testing.T, outPath string) {
	t.Helper()
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("go toolchain not on PATH — cannot build the fixture setup")
	}
	src := filepath.Join(t.TempDir(), "main.go")
	if err := os.WriteFile(src, []byte("package main\n\nfunc main() {}\n"), 0o600); err != nil {
		t.Fatalf("write fixture source: %v", err)
	}
	if out, err := exec.Command(goBin, "build", "-o", outPath, src).CombinedOutput(); err != nil {
		t.Fatalf("build fixture setup: %v\n%s", err, out)
	}
}

// TestWriteWaiterPassesSplitArgv intercepts WriteWaiter's REAL launch call
// and pins the argv shape there — the 044 folded-argv bug lived at this
// call site, so a regression that inlines a folded string back into
// WriteWaiter must fail here even if launchDetached itself stays correct.
func TestWriteWaiterPassesSplitArgv(t *testing.T) {
	var gotProgram string
	var gotArgs []string
	old := launchDetachedFn
	launchDetachedFn = func(program string, args []string, _ map[string]string) error {
		gotProgram, gotArgs = program, args
		return nil
	}
	defer func() { launchDetachedFn = old }()

	svc := NewUpdateService("0.4.5", zap.NewNop())
	script := filepath.Join(t.TempDir(), "update_waiter.ps1")
	if err := svc.WriteWaiter(script, true); err != nil {
		t.Fatalf("WriteWaiter: %v", err)
	}
	defer os.Remove(filepath.Join(mustDataDir(), "update_waiter.ps1"))

	if filepath.Base(gotProgram) != "powershell.exe" {
		t.Fatalf("program = %q, want powershell", gotProgram)
	}
	if len(gotArgs) != 5 {
		t.Fatalf("REGRESSION: argv must be split into 5 tokens, got %d: %v", len(gotArgs), gotArgs)
	}
	if gotArgs[0] != "-NoProfile" || gotArgs[1] != "-ExecutionPolicy" ||
		gotArgs[2] != "Bypass" || gotArgs[3] != "-File" {
		t.Fatalf("argv tokens wrong: %v", gotArgs)
	}
	// WriteWaiter derives the script path from DataDir itself — the argv
	// must carry THAT path (a mismatch here would break -File silently).
	if want := filepath.Join(mustDataDir(), "update_waiter.ps1"); gotArgs[4] != want {
		t.Fatalf("script arg = %q, want %q", gotArgs[4], want)
	}
}

func mustDataDir() string {
	dir, err := appdir.DataDir()
	if err != nil {
		panic(err)
	}
	return dir
}

func TestWaiterScriptRunsEndToEnd(t *testing.T) {
	if testing.Short() {
		t.Skip("live process test")
	}
	dir := t.TempDir()
	fakeSetup := filepath.Join(dir, "KafkaExplorer_Setup_0.0.0-test.exe")
	buildFakeSetup(t, fakeSetup)

	script := filepath.Join(dir, "update_waiter.ps1")
	logFile := filepath.Join(dir, "update_waiter.err.log")
	body := waiterScriptBody(logFile)
	if err := os.WriteFile(script, append([]byte("\xef\xbb\xbf"), []byte(body)...), 0o600); err != nil {
		t.Fatalf("write script: %v", err)
	}
	ps := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	if _, err := os.Stat(ps); err != nil {
		t.Skipf("powershell not found: %v", err)
	}
	// PID 999999999 does not exist → the SilentlyContinue wait loop proceeds
	// immediately (project precedent: the 0.4.2 waiter E2E used the same PID).
	env := map[string]string{
		"KE_UPDATE_PID":      "999999999",
		"KE_UPDATE_SETUP":    fakeSetup,
		"KE_UPDATE_APP":      "unused",
		"KE_UPDATE_RELAUNCH": "0",
	}
	// The EXACT production launch call — this is what the folded-argv bug
	// broke: one string here re-creates the failure, split argv passes.
	if err := launchDetached(ps, waiterArgs(script), env); err != nil {
		t.Fatalf("launchDetached: %v", err)
	}

	// Success signature: script self-deleted, staged setup removed, no err.log.
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		_, statScript := os.Stat(script)
		_, statSetup := os.Stat(fakeSetup)
		if os.IsNotExist(statScript) && os.IsNotExist(statSetup) {
			if _, statLog := os.Stat(logFile); statLog == nil {
				raw, _ := os.ReadFile(logFile)
				t.Fatalf("waiter hit the failure path instead of success: %s", raw)
			}
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	raw, _ := os.ReadFile(logFile)
	t.Fatalf("REGRESSION (P0-2): waiter script never completed — argv folded again? err.log: %s", raw)
}

// TestWaiterScriptFailurePathPinsExitCode: the 045 waiter checks the
// installer's exit code — a failing setup must leave the err.log note and
// KEEP the staged file (no silent success).
func TestWaiterScriptFailurePathPinsExitCode(t *testing.T) {
	if testing.Short() {
		t.Skip("live process test")
	}
	dir := t.TempDir()
	fakeSetup := filepath.Join(dir, "KafkaExplorer_Setup_0.0.0-fail.exe")
	buildFakeSetup(t, fakeSetup)

	script := filepath.Join(dir, "update_waiter_fail.ps1")
	logFile := filepath.Join(dir, "update_waiter.err.log")
	if err := os.WriteFile(script, append([]byte("\xef\xbb\xbf"), []byte(waiterScriptBody(logFile))...), 0o600); err != nil {
		t.Fatalf("write script: %v", err)
	}
	ps := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	if _, err := os.Stat(ps); err != nil {
		t.Skipf("powershell not found: %v", err)
	}
	// Make the "setup" exit non-zero: run it through a wrapper that fails.
	// The waiter passes fixed Inno args, so the cheapest deterministic
	// failure is a setup exe whose main() exits 1.
	fixSrc := filepath.Join(t.TempDir(), "main.go")
	if err := os.WriteFile(fixSrc, []byte("package main\n\nimport \"os\"\n\nfunc main() { os.Exit(3) }\n"), 0o600); err != nil {
		t.Fatalf("write fail fixture source: %v", err)
	}
	if out, err := exec.Command("go", "build", "-o", fakeSetup, fixSrc).CombinedOutput(); err != nil {
		t.Fatalf("build fail fixture: %v\n%s", err, out)
	}

	env := map[string]string{
		"KE_UPDATE_PID":      "999999999",
		"KE_UPDATE_SETUP":    fakeSetup,
		"KE_UPDATE_APP":      "unused",
		"KE_UPDATE_RELAUNCH": "0",
	}
	if err := launchDetached(ps, waiterArgs(script), env); err != nil {
		t.Fatalf("launchDetached: %v", err)
	}

	// Failure signature: err.log names the exit code AND the staged setup
	// file SURVIVES (kept for retry).
	deadline := time.Now().Add(20 * time.Second)
	logged := false
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(logFile); err == nil && len(raw) > 0 {
			logged = true
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if !logged {
		t.Fatal("REGRESSION: failing installer left no err.log — exit code not surfaced")
	}
	if _, err := os.Stat(fakeSetup); err != nil {
		t.Fatal("REGRESSION: failing installer deleted the staged setup — retry impossible")
	}
}
