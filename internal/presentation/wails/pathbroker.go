package wails

// PathBroker turns "renderer names a path" into "renderer quotes a path the
// app itself picked". Native pick dialogs return paths to the frontend, and
// several bindings (file reads, backup/JSONL imports, exports) take a path
// parameter straight from the renderer — a compromised webview could name
// ANY file (arbitrary read via ReadTextFile, arbitrary overwrite via
// ExportToFile, arbitrary parse via the importers). The broker records the
// paths the app's OWN dialogs issued and the consumers verify membership:
// a forged path is refused before any I/O.
//
// Membership is non-consuming with a TTL: retrying an import after a
// transient error must keep working, and 10 minutes is far beyond any
// pick→use gap. Issue() garbage-collects expired entries.

import (
	"path/filepath"
	"sync"
	"time"
)

const (
	pathBrokerTTL = 10 * time.Minute
	pathBrokerMax = 16 // FIFO bound: a stale entry ages out, the newest always fits
)

type pathBroker struct {
	mu      sync.Mutex
	issued  map[string]time.Time
	order   []string
	maxLife time.Duration
}

func newPathBroker() *pathBroker {
	return &pathBroker{issued: map[string]time.Time{}, maxLife: pathBrokerTTL}
}

// Issue records a path returned by a native pick dialog. Re-issuing an
// already-tracked path refreshes its timestamp AND moves it to the back of
// the eviction order — the old code left a stale order slot that could
// evict the freshly refreshed entry (045 round-4 regression review).
func (b *pathBroker) Issue(path string) {
	if path == "" {
		return
	}
	key := filepath.Clean(path)
	now := time.Now()
	b.mu.Lock()
	defer b.mu.Unlock()
	// GC expired entries; keep order slots consistent with the map.
	kept := b.order[:0]
	for _, k := range b.order {
		ts, ok := b.issued[k]
		if ok && now.Sub(ts) <= b.maxLife {
			kept = append(kept, k)
			continue
		}
		if ok {
			delete(b.issued, k)
		}
	}
	b.order = kept
	// Drop any duplicate slot for this key, then move it to the back.
	fresh := b.order[:0]
	for _, k := range b.order {
		if k != key {
			fresh = append(fresh, k)
		}
	}
	b.order = fresh
	if len(b.order) >= pathBrokerMax {
		oldest := b.order[0]
		b.order = b.order[1:]
		delete(b.issued, oldest)
	}
	b.order = append(b.order, key)
	b.issued[key] = now
}

// Authorized reports whether the path was issued by an app-owned dialog and
// is still fresh.
func (b *pathBroker) Authorized(path string) bool {
	if path == "" {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	ts, ok := b.issued[filepath.Clean(path)]
	return ok && time.Since(ts) <= b.maxLife
}
