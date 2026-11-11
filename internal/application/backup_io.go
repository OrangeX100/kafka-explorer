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

// Full-config backup (connections + registries + connect + ksqlDB + local
// schemas + user preferences). Like the connections file, the wire format
// carries NO secrets — passwords live in the OS credential store and are
// never serialized; entries that reference one are saved passwordless and
// the import report says so honestly.

// backupFile is the on-disk envelope. Kind accepts the full-backup marker
// and, for convenience, the legacy connections-only file (only its
// connections slice is then populated).
type backupFile struct {
	Kind            string                  `json:"kind"`
	Version         int                     `json:"version"`
	ExportedAt      string                  `json:"exportedAt"`
	Settings        *Settings               `json:"settings,omitempty"`
	Connections     []domain.Connection     `json:"connections,omitempty"`
	Registries      []domain.SchemaRegistry `json:"registries,omitempty"`
	ConnectClusters []domain.ConnectCluster `json:"connectClusters,omitempty"`
	KsqlDbServers   []domain.KsqlDbServer   `json:"ksqlDbServers,omitempty"`
	LocalSchemas    []domain.LocalSchema    `json:"localSchemas,omitempty"`
}

const (
	backupFileKind       = "kafka-explorer-backup"
	legacyConnectionsKey = connectionFileKind // accepted on import
)

// BackupCounts summarizes one full import: per-collection landing counts,
// total skips, and the names that reference a password the file can't carry.
type BackupCounts struct {
	Connections     int      `json:"connections"`
	Registries      int      `json:"registries"`
	ConnectClusters int      `json:"connectClusters"`
	KsqlDbServers   int      `json:"ksqlDbServers"`
	LocalSchemas    int      `json:"localSchemas"`
	Settings        int      `json:"settings"`
	Skipped         int      `json:"skipped"`
	NeedPassword    []string `json:"needPassword,omitempty"`
}

// BackupService aggregates every persisted module behind one export/import
// pair. It reuses the per-module services so validation, ID generation and
// name-dedup rules stay in exactly one place.
type BackupService struct {
	connections *ConnectionService
	registries  *SchemaRegistryService
	connect     *ConnectService
	ksqldb      *KsqlDbService
	settings    *SettingsService
}

func NewBackupService(connections *ConnectionService, registries *SchemaRegistryService,
	connect *ConnectService, ksqldb *KsqlDbService, settings *SettingsService) *BackupService {
	return &BackupService{connections: connections, registries: registries,
		connect: connect, ksqldb: ksqldb, settings: settings}
}

// ExportAll serializes every saved entity (minus secrets) plus the user
// preferences into one file. pickSave is injected so the service stays
// testable and UI-framework free.
func (s *BackupService) ExportAll(ctx context.Context, pickSave func(ctx context.Context) (string, error)) (string, error) {
	conns, err := s.connections.List(ctx)
	if err != nil {
		return "", fmt.Errorf("list connections: %w", err)
	}
	regs, err := s.registries.List(ctx)
	if err != nil {
		return "", fmt.Errorf("list registries: %w", err)
	}
	clusters, err := s.connect.List(ctx)
	if err != nil {
		return "", fmt.Errorf("list connect clusters: %w", err)
	}
	servers, err := s.ksqldb.List(ctx)
	if err != nil {
		return "", fmt.Errorf("list ksqlDB servers: %w", err)
	}
	schemas, err := s.registries.ListLocalSchemas(ctx)
	if err != nil {
		return "", fmt.Errorf("list local schemas: %w", err)
	}
	if len(conns) == 0 && len(regs) == 0 && len(clusters) == 0 && len(servers) == 0 && len(schemas) == 0 {
		return "", fmt.Errorf("没有可导出的配置")
	}

	// Secrets never leave the credential store: strip IDs (regenerated on
	// import), SecretRefs and timestamps; keep everything the user typed.
	path, err := pickSave(ctx)
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil // cancelled — not an error, just nothing to report
	}

	settings, err := s.settings.Get(ctx)
	if err != nil {
		return "", fmt.Errorf("读取设置: %w", err)
	}

	payload, err := json.MarshalIndent(backupFile{
		Kind:            backupFileKind,
		Version:         1,
		ExportedAt:      time.Now().Format(time.RFC3339),
		Settings:        &settings,
		Connections:     stripConnections(conns),
		Registries:      stripRegistries(regs),
		ConnectClusters: stripClusters(clusters),
		KsqlDbServers:   stripServers(servers),
		LocalSchemas:    stripSchemas(schemas),
	}, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		return "", fmt.Errorf("写入导出文件: %w", err)
	}
	return path, nil
}

// ImportAll reads a full-backup file (or a legacy connections-only file)
// and merges every entry: name conflicts get a numbered suffix instead of
// failing the batch, invalid entries are skipped and counted.
func (s *BackupService) ImportAll(ctx context.Context, path string) (BackupCounts, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return BackupCounts{}, fmt.Errorf("读取备份文件: %w", err)
	}
	var file backupFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return BackupCounts{}, fmt.Errorf("文件不是合法的 JSON: %w", err)
	}
	if file.Kind != backupFileKind && file.Kind != legacyConnectionsKey {
		return BackupCounts{}, fmt.Errorf("这不是本应用导出的备份文件（缺少 %s 标识）", backupFileKind)
	}

	var counts BackupCounts

	// connections: same rules as the single-purpose import (SASL entries
	// land passwordless and are listed for re-entry).
	if len(file.Connections) > 0 {
		existing, err := s.connections.List(ctx)
		if err != nil {
			return counts, fmt.Errorf("list connections: %w", err)
		}
		taken := takenNames(len(existing), func(i int) string { return existing[i].Name })
		for _, c := range file.Connections {
			name, ok := uniqueName(c.Name, taken)
			if !ok {
				counts.Skipped++
				continue
			}
			c.ID = newID()
			c.Name = name
			c.CreatedAt = nil
			c.UpdatedAt = nil
			needPw := false
			if c.NeedsPassword() {
				c.SecretRef = "conn-" + c.ID
				needPw = true
			}
			if err := c.Validate(); err != nil {
				counts.Skipped++
				continue
			}
			if _, err := s.connections.Save(ctx, SaveInput{Connection: c}); err != nil {
				counts.Skipped++
				continue
			}
			counts.Connections++
			if needPw {
				counts.NeedPassword = append(counts.NeedPassword, name)
			}
		}
	}

	// registries / connect / ksqlDB share one shape: name + url (+ optional
	// basic-auth user whose password must be re-entered after import).
	if len(file.Registries) > 0 {
		existing, err := s.registries.List(ctx)
		if err != nil {
			return counts, fmt.Errorf("list registries: %w", err)
		}
		taken := takenNames(len(existing), func(i int) string { return existing[i].Name })
		for _, r := range file.Registries {
			name, ok := uniqueName(r.Name, taken)
			if !ok {
				counts.Skipped++
				continue
			}
			r.ID = newID()
			r.Name = name
			r.CreatedAt = domain.FlexTime{}
			r.UpdatedAt = domain.FlexTime{}
			needPw := r.Username != ""
			if err := r.Validate(); err != nil {
				counts.Skipped++
				continue
			}
			if _, err := s.registries.Save(ctx, r); err != nil {
				counts.Skipped++
				continue
			}
			counts.Registries++
			if needPw {
				counts.NeedPassword = append(counts.NeedPassword, name)
			}
		}
	}

	if len(file.ConnectClusters) > 0 {
		existing, err := s.connect.List(ctx)
		if err != nil {
			return counts, fmt.Errorf("list connect clusters: %w", err)
		}
		taken := takenNames(len(existing), func(i int) string { return existing[i].Name })
		for _, c := range file.ConnectClusters {
			name, ok := uniqueName(c.Name, taken)
			if !ok {
				counts.Skipped++
				continue
			}
			c.ID = newID()
			c.Name = name
			needPw := c.Username != ""
			if err := c.Validate(); err != nil {
				counts.Skipped++
				continue
			}
			if _, err := s.connect.Save(ctx, c); err != nil {
				counts.Skipped++
				continue
			}
			counts.ConnectClusters++
			if needPw {
				counts.NeedPassword = append(counts.NeedPassword, name)
			}
		}
	}

	if len(file.KsqlDbServers) > 0 {
		existing, err := s.ksqldb.List(ctx)
		if err != nil {
			return counts, fmt.Errorf("list ksqlDB servers: %w", err)
		}
		taken := takenNames(len(existing), func(i int) string { return existing[i].Name })
		for _, k := range file.KsqlDbServers {
			name, ok := uniqueName(k.Name, taken)
			if !ok {
				counts.Skipped++
				continue
			}
			k.ID = newID()
			k.Name = name
			needPw := k.Username != ""
			if err := k.Validate(); err != nil {
				counts.Skipped++
				continue
			}
			if _, err := s.ksqldb.Save(ctx, k); err != nil {
				counts.Skipped++
				continue
			}
			counts.KsqlDbServers++
			if needPw {
				counts.NeedPassword = append(counts.NeedPassword, name)
			}
		}
	}

	if len(file.LocalSchemas) > 0 {
		existing, err := s.registries.ListLocalSchemas(ctx)
		if err != nil {
			return counts, fmt.Errorf("list local schemas: %w", err)
		}
		taken := takenNames(len(existing), func(i int) string { return existing[i].Name })
		for _, sc := range file.LocalSchemas {
			name, ok := uniqueName(sc.Name, taken)
			if !ok {
				counts.Skipped++
				continue
			}
			sc.ID = newID()
			sc.Name = name
			sc.CreatedAt = domain.FlexTime{}
			sc.UpdatedAt = domain.FlexTime{}
			if err := sc.Validate(); err != nil {
				counts.Skipped++
				continue
			}
			if _, err := s.registries.SaveLocalSchema(ctx, sc); err != nil {
				counts.Skipped++
				continue
			}
			counts.LocalSchemas++
		}
	}

	if file.Settings != nil {
		if _, err := s.settings.Save(ctx, *file.Settings); err != nil {
			return counts, fmt.Errorf("恢复设置: %w", err)
		}
		counts.Settings = 1
	}
	return counts, nil
}

// ---- small helpers shared by the import branches ----

// takenNames builds the occupied-name set for a collection.
func takenNames(n int, name func(int) string) map[string]bool {
	taken := map[string]bool{}
	for i := 0; i < n; i++ {
		taken[strings.TrimSpace(name(i))] = true
	}
	return taken
}

// uniqueName resolves a conflict with a numbered suffix ("name (2)").
// ok is false when the trimmed name is empty (the entry gets skipped).
func uniqueName(name string, taken map[string]bool) (string, bool) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", false
	}
	base := name
	for n := 2; taken[name]; n++ {
		name = fmt.Sprintf("%s (%d)", base, n)
	}
	taken[name] = true
	return name, true
}

func stripConnections(all []domain.Connection) []domain.Connection {
	out := make([]domain.Connection, 0, len(all))
	for _, c := range all {
		c.ID = ""
		c.SecretRef = ""
		c.CreatedAt = nil
		c.UpdatedAt = nil
		out = append(out, c)
	}
	return out
}

func stripRegistries(all []domain.SchemaRegistry) []domain.SchemaRegistry {
	out := make([]domain.SchemaRegistry, 0, len(all))
	for _, r := range all {
		r.ID = ""
		r.SecretRef = ""
		r.CreatedAt = domain.FlexTime{}
		r.UpdatedAt = domain.FlexTime{}
		out = append(out, r)
	}
	return out
}

func stripClusters(all []domain.ConnectCluster) []domain.ConnectCluster {
	out := make([]domain.ConnectCluster, 0, len(all))
	for _, c := range all {
		c.ID = ""
		c.SecretRef = ""
		out = append(out, c)
	}
	return out
}

func stripServers(all []domain.KsqlDbServer) []domain.KsqlDbServer {
	out := make([]domain.KsqlDbServer, 0, len(all))
	for _, k := range all {
		k.ID = ""
		k.SecretRef = ""
		out = append(out, k)
	}
	return out
}

func stripSchemas(all []domain.LocalSchema) []domain.LocalSchema {
	out := make([]domain.LocalSchema, 0, len(all))
	for _, sc := range all {
		sc.ID = ""
		sc.CreatedAt = domain.FlexTime{}
		sc.UpdatedAt = domain.FlexTime{}
		out = append(out, sc)
	}
	return out
}
