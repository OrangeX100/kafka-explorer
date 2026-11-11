//go:build windows

package application

import (
	"os"
	"os/exec"
	"syscall"
)

// errCancelled marks a download stopped by the stop button (distinct from
// a network failure so the UI can stay silent about it).
var errCancelled = fmtCancelled{}

type fmtCancelled struct{}

func (fmtCancelled) Error() string { return "cancelled" }

// launchDetached starts a process that must outlive this one (the update
// waiter): DETACHED_PROCESS keeps it from inheriting our console window,
// CREATE_NEW_PROCESS_GROUP isolates it from our Ctrl+C group.
func launchDetached(program, args string, env map[string]string) error {
	cmd := exec.Command(program, args)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x00000008 | 0x00000200, // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
	}
	cmd.Env = append(environ(), envPairs(env)...)
	return cmd.Start()
}

func envPairs(extra map[string]string) []string {
	out := make([]string, 0, len(extra))
	for k, v := range extra {
		out = append(out, k+"="+v)
	}
	return out
}

func environ() []string {
	return os.Environ()
}
