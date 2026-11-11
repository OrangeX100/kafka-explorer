package store_test

import (
	"path/filepath"
	"testing"

	"kafkaexplorer/internal/infrastructure/store"
)

// Migration continuity (governance rule 1): versions must be dense and end
// exactly at user_version after applying. Gaps mean a misnumbered migration
// or one that never got applied — both silent data-layout drift.
func TestMigrationsAreDenseAndApplied(t *testing.T) {
	sources, err := store.MigrationSources()
	if err != nil {
		t.Fatalf("list migrations: %v", err)
	}
	if len(sources) == 0 {
		t.Fatal("no migrations found")
	}
	for i, m := range sources {
		base := filepath.Base(m.Name)
		wantPrefix := pad(i + 1) + "_"
		if len(base) < 5 || base[:5] != wantPrefix {
			t.Errorf("migration %d is named %s, want prefix %s (dense numbering)", i+1, base, wantPrefix)
		}
	}

	// Apply to a fresh temp database: user_version must equal len(sources).
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open+apply migrations: %v", err)
	}
	defer db.Close()
	var version int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatalf("read user_version: %v", err)
	}
	if version != len(sources) {
		t.Errorf("user_version = %d, want %d", version, len(sources))
	}
}

// Applying migrations twice must be a no-op (idempotent reopen).
func TestReopenDoesNotReapply(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	db1, err := store.Open(path)
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	var connectionsTable string
	if err := db1.QueryRow(
		`SELECT name FROM sqlite_master WHERE type='table' AND name='connections'`,
	).Scan(&connectionsTable); err != nil {
		t.Fatalf("connections table missing after first open: %v", err)
	}
	db1.Close()

	db2, err := store.Open(path)
	if err != nil {
		t.Fatalf("second open: %v", err)
	}
	defer db2.Close()
	var version int
	if err := db2.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatalf("read user_version: %v", err)
	}
	// Must equal the migration count, whatever it now is — pinning a literal
	// here would break on every new migration (caught exactly that way).
	var want int
	sources, err := store.MigrationSources()
	if err != nil {
		t.Fatalf("list migrations: %v", err)
	}
	want = len(sources)
	if version != want {
		t.Errorf("after reopen user_version = %d, want %d", version, want)
	}
}

func pad(v int) string {
	s := "000" + string(rune('0'+v/100%10)) + string(rune('0'+v/10%10)) + string(rune('0'+v%10))
	return s[len(s)-4:]
}
