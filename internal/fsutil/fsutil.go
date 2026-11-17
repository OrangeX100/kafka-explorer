// Package fsutil: bounded file reading shared by every path that takes a
// user-/renderer-named file. os.Stat-then-os.ReadFile has a TOCTOU window
// (the file can grow between the size check and the read, committing the
// whole growth to memory) and plain os.ReadFile has no bound at all — both
// turned into renderer-reachable OOM primitives until the 045 review added
// caps. ReadFileCapped reads through a LimitReader and rejects the file
// when it exceeds max, closing the window.
package fsutil

import (
	"fmt"
	"io"
	"os"
)

// ReadFileCapped reads at most max bytes from path. A larger file is an
// error (the caller renders a friendly message); the TOCTOU race and the
// plain unbounded read are both closed by the LimitReader.
func ReadFileCapped(path string, max int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, fmt.Errorf("文件超过 %d MB 上限", max/(1<<20))
	}
	return data, nil
}
