package application

import (
	"context"
	"time"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"kafkaexplorer/internal/domain"
	"kafkaexplorer/internal/infrastructure/kafka"
	"kafkaexplorer/internal/infrastructure/store"
)

// openTestDB builds a real sqlite-backed service (same as the app boot path)
// on a throwaway file; no native dialogs are touched — pickSave is injected.
func openTestDB(t *testing.T) *ConnectionService {
	t.Helper()
	dbpath := filepath.Join(t.TempDir(), "test.db")
	db, err := store.Open(dbpath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	pool := kafka.NewPool(nil, nil)
	repo := store.NewConnectionRepo(db)
	return NewConnectionService(repo, nil, pool)
}

func saveConn(t *testing.T, svc *ConnectionService, name, bootstrap string) {
	t.Helper()
	_, err := svc.Save(context.Background(), SaveInput{Connection: domain.Connection{
		Name:      name,
		Bootstrap: bootstrap,
		Security:  domain.SecurityNone,
	}})
	if err != nil {
		t.Fatal(err)
	}
}

func TestExportImportRoundTrip(t *testing.T) {
	svc := openTestDB(t)
	saveConn(t, svc, "prod", "broker-a:9092")
	saveConn(t, svc, "dev", "broker-b:9093,broker-c:9094")
	ctx := context.Background()

	// Export through the injected picker; the file must carry NO secrets
	// (there are none here, but SecretRef/ID/timestamps must be stripped).
	path := filepath.Join(t.TempDir(), "out.json")
	got, err := svc.ExportConnections(ctx, func(context.Context) (string, error) { return path, nil })
	if err != nil || got != path {
		t.Fatalf("export: %v %q", err, got)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var file connectionFile
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if file.Kind != connectionFileKind || len(file.Connections) != 2 {
		t.Fatalf("file %+v", file)
	}
	for _, c := range file.Connections {
		if c.ID != "" || c.SecretRef != "" || c.CreatedAt != nil {
			t.Fatalf("secret/identity leak: %+v", c)
		}
	}

	// Import into the same service (fresh DB via second instance) — names
	// collide, so both get numbered suffixes.
	svc2 := openTestDB(t)
	saveConn(t, svc2, "prod", "other:9092")
	res, err := svc2.ImportConnections(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if res.Imported != 2 || res.Skipped != 0 {
		t.Fatalf("import result %+v", res)
	}
	list, _ := svc2.List(ctx)
	names := map[string]bool{}
	for _, c := range list {
		names[c.Name] = true
	}
	if !names["prod"] || !names["prod (2)"] || !names["dev"] {
		t.Fatalf("expected numbered suffixes, got %v", names)
	}
}

func TestImportRejectsForeignFile(t *testing.T) {
	svc := openTestDB(t)
	path := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(path, []byte(`{"hello":"world"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := svc.ImportConnections(context.Background(), path)
	if err == nil {
		t.Fatal("expected kind rejection")
	}
}

func TestImportReportsPasswordlessSASL(t *testing.T) {
	svc := openTestDB(t)
	path := filepath.Join(t.TempDir(), "in.json")
	src, _ := json.Marshal(connectionFile{
		Kind:    connectionFileKind,
		Version: 1,
		Connections: []domain.Connection{{
			Name:      "sasl-cluster",
			Bootstrap: "b:9092",
			Security:  domain.SecuritySASLScram,
			Username:  "alice",
		}},
	})
	if err := os.WriteFile(path, src, 0o600); err != nil {
		t.Fatal(err)
	}
	res, err := svc.ImportConnections(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if res.Imported != 1 || len(res.NeedPassword) != 1 || res.NeedPassword[0] != "sasl-cluster" {
		t.Fatalf("result %+v", res)
	}
}

func TestSetPinnedReordersList(t *testing.T) {
	svc := openTestDB(t)
	saveConn(t, svc, "alpha", "a:9092")
	saveConn(t, svc, "beta", "b:9092")
	ctx := context.Background()
	list, _ := svc.List(ctx)
	if list[0].Name != "alpha" {
		t.Fatalf("baseline order %v", list[0].Name)
	}
	if err := svc.SetPinned(ctx, list[1].ID, true); err != nil {
		t.Fatal(err)
	}
	list, _ = svc.List(ctx)
	if list[0].Name != "beta" || !list[0].Pinned {
		t.Fatalf("pinned-first violated: %v %+v", list[0].Name, list[0])
	}
	// Pinning must not bump UpdatedAt (view preference, not a config edit).
	if list[0].UpdatedAt != nil && list[1].UpdatedAt != nil && time.Time(*list[0].UpdatedAt).After(time.Time(*list[1].UpdatedAt)) {
		t.Fatalf("pin bumped timestamp: %v vs %v", list[0].UpdatedAt, list[1].UpdatedAt)
	}
}
