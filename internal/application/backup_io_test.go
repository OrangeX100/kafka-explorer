package application

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"kafkaexplorer/internal/domain"
	"kafkaexplorer/internal/infrastructure/kafka"
	"kafkaexplorer/internal/infrastructure/store"
)

// backupFixture bundles one fully wired service set over a throwaway db.
type backupFixture struct {
	svc         *BackupService
	connections *ConnectionService
	registries  *SchemaRegistryService
	connect     *ConnectService
	ksqldb      *KsqlDbService
	settings    *SettingsService
}

func newBackupFixture(t *testing.T) *backupFixture {
	t.Helper()
	sqldb, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sqldb.Close() })
	db := store.NewWrapper(sqldb)
	pool := kafka.NewPool(nil, nil)
	conns := NewConnectionService(store.NewConnectionRepo(sqldb), nil, pool)
	registries := NewSchemaRegistryService(db, nil)
	connect := NewConnectService(db, nil)
	ksqldb := NewKsqlDbService(db, nil)
	settings := NewSettingsService(db)
	return &backupFixture{
		svc:         NewBackupService(conns, registries, connect, ksqldb, settings),
		connections: conns,
		registries:  registries,
		connect:     connect,
		ksqldb:      ksqldb,
		settings:    settings,
	}
}

func TestBackupRoundTrip(t *testing.T) {
	ctx := context.Background()
	src := newBackupFixture(t)

	if _, err := src.connections.Save(ctx, SaveInput{Connection: domain.Connection{
		Name: "prod", Bootstrap: "broker-a:9092", Security: domain.SecurityNone,
	}}); err != nil {
		t.Fatal(err)
	}
	if _, err := src.registries.Save(ctx, domain.SchemaRegistry{Name: "sr", URL: "http://sr:8081"}); err != nil {
		t.Fatal(err)
	}
	if _, err := src.connect.Save(ctx, domain.ConnectCluster{Name: "connect", URL: "http://connect:8083"}); err != nil {
		t.Fatal(err)
	}
	if _, err := src.ksqldb.Save(ctx, domain.KsqlDbServer{Name: "ksql", URL: "http://ksql:8088"}); err != nil {
		t.Fatal(err)
	}
	if _, err := src.registries.SaveLocalSchema(ctx, domain.LocalSchema{
		Name: "order", SchemaType: "AVRO", Schema: `{"type":"record"}`,
	}); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(t.TempDir(), "backup.json")
	got, err := src.svc.ExportAll(ctx, func(ctx context.Context) (string, error) { return path, nil })
	if err != nil {
		t.Fatal(err)
	}
	if got != path {
		t.Fatalf("export path = %q, want %q", got, path)
	}

	// fresh database: everything must come back through the import
	dst := newBackupFixture(t)
	counts, err := dst.svc.ImportAll(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if counts.Connections != 1 || counts.Registries != 1 || counts.ConnectClusters != 1 ||
		counts.KsqlDbServers != 1 || counts.LocalSchemas != 1 || counts.Settings != 1 || counts.Skipped != 0 {
		t.Fatalf("counts = %+v", counts)
	}

	if ns, err := dst.connections.List(ctx); err != nil || len(ns) != 1 || ns[0].Name != "prod" || ns[0].Bootstrap != "broker-a:9092" {
		t.Fatalf("connections after import: %v %v", ns, err)
	}
	if rs, err := dst.registries.List(ctx); err != nil || len(rs) != 1 || rs[0].URL != "http://sr:8081" {
		t.Fatalf("registries after import: %v %v", rs, err)
	}
	if cs, err := dst.connect.List(ctx); err != nil || len(cs) != 1 {
		t.Fatalf("connect after import: %v %v", cs, err)
	}
	if ks, err := dst.ksqldb.List(ctx); err != nil || len(ks) != 1 {
		t.Fatalf("ksqldb after import: %v %v", ks, err)
	}
	if ls, err := dst.registries.ListLocalSchemas(ctx); err != nil || len(ls) != 1 || ls[0].Schema != `{"type":"record"}` {
		t.Fatalf("local schemas after import: %v %v", ls, err)
	}
}

func TestBackupRenamesOnConflict(t *testing.T) {
	ctx := context.Background()
	src := newBackupFixture(t)
	if _, err := src.connections.Save(ctx, SaveInput{Connection: domain.Connection{
		Name: "prod", Bootstrap: "broker-src:9092", Security: domain.SecurityNone,
	}}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "backup.json")
	if _, err := src.svc.ExportAll(ctx, func(ctx context.Context) (string, error) { return path, nil }); err != nil {
		t.Fatal(err)
	}

	// target independently already has a "prod" — import must not overwrite
	dst := newBackupFixture(t)
	if _, err := dst.connections.Save(ctx, SaveInput{Connection: domain.Connection{
		Name: "prod", Bootstrap: "broker-dst:9092", Security: domain.SecurityNone,
	}}); err != nil {
		t.Fatal(err)
	}
	counts, err := dst.svc.ImportAll(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if counts.Connections != 1 {
		t.Fatalf("counts = %+v", counts)
	}
	all, err := dst.connections.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("want original + renamed import, got %d entries", len(all))
	}
	byName := map[string]string{}
	for _, c := range all {
		byName[c.Name] = c.Bootstrap
	}
	if byName["prod"] != "broker-dst:9092" || byName["prod (2)"] != "broker-src:9092" {
		t.Fatalf("conflict rename failed: %v", byName)
	}
}

func TestBackupAcceptsLegacyConnectionsFile(t *testing.T) {
	ctx := context.Background()
	legacy, err := json.Marshal(map[string]any{
		"kind":        "kafka-explorer-connections",
		"version":     1,
		"exportedAt":  "2026-11-10T00:00:00Z",
		"connections": []map[string]any{{"name": "old", "bootstrap": "old:9092", "security": "NONE"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "legacy.json")
	if err := os.WriteFile(path, legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	dst := newBackupFixture(t)
	counts, err := dst.svc.ImportAll(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if counts.Connections != 1 {
		t.Fatalf("counts = %+v", counts)
	}
}

func TestBackupRejectsForeignFile(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "foreign.json")
	if err := os.WriteFile(path, []byte(`{"hello":"world"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newBackupFixture(t).svc.ImportAll(ctx, path); err == nil {
		t.Fatal("expected foreign file to be rejected")
	}
}

func TestBackupExportEmptyErrors(t *testing.T) {
	ctx := context.Background()
	fx := newBackupFixture(t)
	_, err := fx.svc.ExportAll(ctx, func(ctx context.Context) (string, error) {
		return filepath.Join(t.TempDir(), "out.json"), nil
	})
	if err == nil {
		t.Fatal("expected empty-config export to error")
	}
}
