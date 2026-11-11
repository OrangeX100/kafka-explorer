package application

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"kafkaexplorer/internal/domain"
)

// Connection import/export . The wire file
// carries NO secrets — passwords live in the OS credential store and are
// never serialized; SASL entries land passwordless and the import report
// says so honestly.

// connectionFile is the on-disk envelope. Kind guards against importing an
// arbitrary JSON file as connections.
type connectionFile struct {
	Kind        string              `json:"kind"`
	Version     int                 `json:"version"`
	ExportedAt  string              `json:"exportedAt"`
	Connections []domain.Connection `json:"connections"`
}

const connectionFileKind = "kafka-explorer-connections"

// SetPinned toggles the list-ordering pin. A view preference — no pooled
// client eviction, no timestamp bump.
func (s *ConnectionService) SetPinned(ctx context.Context, id string, pinned bool) error {
	return s.repo.SetPinned(ctx, id, pinned)
}

// ExportConnections opens a save dialog through the caller-supplied picker,
// serializes every saved connection (minus secrets), and writes the file.
// pickSave is injected so the service stays testable and UI-framework free.
func (s *ConnectionService) ExportConnections(ctx context.Context, pickSave func(ctx context.Context) (string, error)) (string, error) {
	all, err := s.repo.List(ctx)
	if err != nil {
		return "", fmt.Errorf("list connections: %w", err)
	}
	if len(all) == 0 {
		return "", fmt.Errorf("没有可导出的连接")
	}
	// Secrets never leave the credential store: strip ID (regenerated on
	// import), SecretRef and timestamps; keep everything the user typed.
	stripped := make([]domain.Connection, 0, len(all))
	for _, c := range all {
		c.ID = ""
		c.SecretRef = ""
		c.CreatedAt = nil
		c.UpdatedAt = nil
		stripped = append(stripped, c)
	}
	path, err := pickSave(ctx)
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil // cancelled — not an error, just nothing to report
	}
	payload, err := json.MarshalIndent(connectionFile{
		Kind:        connectionFileKind,
		Version:     1,
		ExportedAt:  time.Now().Format(time.RFC3339),
		Connections: stripped,
	}, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		return "", fmt.Errorf("写入导出文件: %w", err)
	}
	return path, nil
}

// ImportResult summarizes one import run: how many entries landed, how many
// were skipped as unreadable, and how many need a password typed in (the
// file never carries one).
type ImportResult struct {
	Imported     int      `json:"imported"`
	Skipped      int      `json:"skipped"`
	NeedPassword []string `json:"needPassword,omitempty"`
}

// ImportConnections reads a previously exported file and saves every entry.
// Name conflicts get a numbered suffix instead of failing the batch — an
// import is a bulk restore, not a silent overwrite. SASL entries are saved
// passwordless and listed in NeedPassword.
func (s *ConnectionService) ImportConnections(ctx context.Context, path string) (ImportResult, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ImportResult{}, fmt.Errorf("读取导入文件: %w", err)
	}
	var file connectionFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return ImportResult{}, fmt.Errorf("文件不是合法的 JSON: %w", err)
	}
	if file.Kind != connectionFileKind {
		return ImportResult{}, fmt.Errorf("这不是本应用导出的连接文件（缺少 %s 标识）", connectionFileKind)
	}
	all, err := s.repo.List(ctx)
	if err != nil {
		return ImportResult{}, fmt.Errorf("list connections: %w", err)
	}
	taken := map[string]bool{}
	for _, c := range all {
		taken[strings.TrimSpace(c.Name)] = true
	}

	var result ImportResult
	for _, c := range file.Connections {
		name := strings.TrimSpace(c.Name)
		if name == "" || strings.TrimSpace(c.Bootstrap) == "" {
			result.Skipped++
			continue
		}
		// Numbered suffix on conflict: "name (2)", "name (3)" …
		base := name
		for n := 2; taken[name]; n++ {
			name = fmt.Sprintf("%s (%d)", base, n)
		}
		taken[name] = true
		c.ID = newID()
		c.Name = name
		c.CreatedAt = nil
		c.UpdatedAt = nil
		needPw := false
		if c.NeedsPassword() {
			// Pre-assign the ref so validation passes; the keyring stays
			// empty until the user edits the connection and types it.
			c.SecretRef = "conn-" + c.ID
			needPw = true
		}
		if err := c.Validate(); err != nil {
			result.Skipped++
			continue
		}
		if _, err := s.Save(ctx, SaveInput{Connection: c}); err != nil {
			result.Skipped++
			continue
		}
		result.Imported++
		if needPw {
			result.NeedPassword = append(result.NeedPassword, name)
		}
	}
	return result, nil
}
