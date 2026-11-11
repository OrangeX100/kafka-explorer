package store

import (
	"context"
	"path/filepath"
	"testing"

	"kafkaexplorer/internal/domain"
)

// TestSecretRefSurvivesEdit pins the edit-path regression the backend review
// caught: the edit dialog never carries the secret (it lives in the OS
// credential store), so saving an edited row with an empty secret_ref must
// PRESERVE the stored reference instead of wiping it.
func TestSecretRefSurvivesEdit(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")
	sqlDB, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer sqlDB.Close()
	if err := migrate(sqlDB); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	w := NewWrapper(sqlDB)
	ctx := context.Background()

	// registries
	saved, err := w.SaveRegistry(ctx, domain.SchemaRegistry{ID: "r1", Name: "n", URL: "http://x:8081", SecretRef: "registry-r1"})
	if err != nil || saved.SecretRef != "registry-r1" {
		t.Fatalf("seed registry: %v %+v", err, saved)
	}
	if _, err := w.SaveRegistry(ctx, domain.SchemaRegistry{ID: "r1", Name: "n2", URL: "http://x2:8081"}); err != nil {
		t.Fatalf("edit registry: %v", err)
	}
	got, _ := w.ListRegistries(ctx)
	if got[0].SecretRef != "registry-r1" {
		t.Errorf("registry SecretRef wiped by edit: %+v", got[0])
	}

	// connect clusters
	if _, err := w.SaveConnectCluster(ctx, domain.ConnectCluster{ID: "c1", Name: "n", URL: "http://x:8083", SecretRef: "connect-c1"}); err != nil {
		t.Fatalf("seed connect: %v", err)
	}
	if _, err := w.SaveConnectCluster(ctx, domain.ConnectCluster{ID: "c1", Name: "n2", URL: "http://x2:8083"}); err != nil {
		t.Fatalf("edit connect: %v", err)
	}
	gotC, _ := w.ListConnectClusters(ctx)
	if gotC[0].SecretRef != "connect-c1" {
		t.Errorf("connect SecretRef wiped by edit: %+v", gotC[0])
	}

	// ksqlDB servers
	if _, err := w.SaveKsqlDbServer(ctx, domain.KsqlDbServer{ID: "k1", Name: "n", URL: "http://x:8088", SecretRef: "ksqldb-k1"}); err != nil {
		t.Fatalf("seed ksqldb: %v", err)
	}
	if _, err := w.SaveKsqlDbServer(ctx, domain.KsqlDbServer{ID: "k1", Name: "n2", URL: "http://x2:8088"}); err != nil {
		t.Fatalf("edit ksqldb: %v", err)
	}
	gotK, _ := w.ListKsqlDbServers(ctx)
	if gotK[0].SecretRef != "ksqldb-k1" {
		t.Errorf("ksqldb SecretRef wiped by edit: %+v", gotK[0])
	}
}
