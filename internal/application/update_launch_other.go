//go:build !windows

package application

// errCancelled marks a download stopped by the stop button.
var errCancelled = fmtCancelled{}

type fmtCancelled struct{}

func (fmtCancelled) Error() string { return "cancelled" }

// launchDetached is Windows-only; other platforms never stage an installer.
func launchDetached(program string, args []string, env map[string]string) error {
	return nil
}
