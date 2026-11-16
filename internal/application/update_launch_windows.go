//go:build windows

package application

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
)

// errCancelled marks a download stopped by the stop button (distinct from
// a network failure so the UI can stay silent about it).
var errCancelled = fmtCancelled{}

type fmtCancelled struct{}

func (fmtCancelled) Error() string { return "cancelled" }

// launchDetached starts a process that must outlive this one (the update
// waiter). args MUST be split argv — exec.Command folds a single string
// containing spaces+quotes into one quoted token that PowerShell parses as
// a command, not switches (measured: exit 1 "无法将'-NoProfile'项识别为
// cmdlet", script never ran).
//
// CreationFlags: CREATE_NO_WINDOW (not DETACHED_PROCESS!) — a powershell.exe
// started with DETACHED_PROCESS exits SILENTLY before executing a single
// script line (045 round, measured: 0x8 = script never ran, 0x08000000 =
// ran; the in-app update had this SECOND invisible death stacked on top of
// the folded argv). CREATE_NEW_PROCESS_GROUP keeps it out of our Ctrl+C.
func launchDetached(program string, args []string, env map[string]string) error {
	cmd := exec.Command(program, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x08000000 | 0x00000200, // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
	}
	cmd.Env = mergeEnv(env)
	return cmd.Start()
}

// mergeEnv overlays extra onto the inherited environment BY KEY: plain
// append creates duplicate names, and Windows' GetEnvironmentVariable
// (PowerShell $env:) reads the FIRST occurrence — a gen-2 app still carrying
// gen-1's KE_UPDATE_* would silently shadow the new values and the update
// would fail after the app had already quit (045 Windows round).
func mergeEnv(extra map[string]string) []string {
	out := make([]string, 0, len(os.Environ())+len(extra))
	for _, kv := range os.Environ() {
		if i := strings.IndexByte(kv, '='); i > 0 {
			if _, ours := extra[kv[:i]]; ours {
				continue // dropped: extra overrides it below
			}
		}
		out = append(out, kv)
	}
	for k, v := range extra {
		out = append(out, k+"="+v)
	}
	return out
}

