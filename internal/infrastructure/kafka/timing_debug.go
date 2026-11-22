package kafka

// TEMP perf diagnostics (2026-11-22: user reports ≥5s to open _schemas).
// Env-gated (KE_TIMING=1) append-only timing trace to os.TempDir()/ke-timing.log
// — zero cost when unset. Remove once the slow-open phase is pinned.

import (
	"fmt"
	"os"
	"sync"
	"time"
)

var timingMu sync.Mutex

func timingLog(format string, args ...any) {
	if os.Getenv("KE_TIMING") == "" {
		return
	}
	timingMu.Lock()
	defer timingMu.Unlock()
	f, err := os.OpenFile(os.TempDir()+"/ke-timing.log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format("15:04:05.000"), fmt.Sprintf(format, args...))
}
