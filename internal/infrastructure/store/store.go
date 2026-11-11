// Package store persists application settings in SQLite.
// Driver: ncruces/go-sqlite3 (WASM, no CGO) so Windows builds need no C
// toolchain. Secrets never land here — see schema_guard_test.go.
package store

import (
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	// The ncruces driver embeds the SQLite WASM runtime itself; a separate
	// embed import is not needed (it would only trigger a lint warning).
	_ "github.com/ncruces/go-sqlite3/driver"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// MigrationSource exposes one migration's identity and body so tests can
// inspect the schema without opening a database.
type MigrationSource struct {
	Name string
	Body string
}

// MigrationSources returns every embedded migration ordered by version.
func MigrationSources() ([]MigrationSource, error) {
	files, err := fs.Glob(migrationFS, "migrations/*.sql")
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	out := make([]MigrationSource, 0, len(files))
	for _, name := range files {
		body, err := migrationFS.ReadFile(name)
		if err != nil {
			return nil, err
		}
		out = append(out, MigrationSource{Name: name, Body: string(body)})
	}
	return out, nil
}

// Open opens (creating if needed) the database and applies pending migrations.
func Open(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	// Single writer process; busy timeout avoids transient SQLITE_BUSY when
	// the UI hammers settings while a background write is flushing.
	if _, err := db.Exec(`PRAGMA busy_timeout=3000`); err != nil {
		db.Close()
		return nil, fmt.Errorf("set busy timeout: %w", err)
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// migrate applies pending migrations in a transaction each, tracking the
// current version via PRAGMA user_version. fail-safe: a failed migration
// leaves the database untouched (rollback), so the app can retry on next start.
func migrate(db *sql.DB) error {
	current, err := userVersion(db)
	if err != nil {
		return err
	}
	files, err := fs.Glob(migrationFS, "migrations/*.sql")
	if err != nil {
		return fmt.Errorf("list migrations: %w", err)
	}
	sort.Strings(files)

	for i, name := range files {
		version := i + 1
		if version <= current {
			continue
		}
		sqlBytes, err := migrationFS.ReadFile(name)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}
		tx, err := db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration %s: %w", name, err)
		}
		if _, err := tx.Exec(string(sqlBytes)); err != nil {
			tx.Rollback()
			return fmt.Errorf("apply migration %s: %w", name, err)
		}
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version=%d`, version)); err != nil {
			tx.Rollback()
			return fmt.Errorf("bump user_version to %d: %w", version, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration %s: %w", name, err)
		}
	}
	return nil
}

func userVersion(db *sql.DB) (int, error) {
	var v int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return 0, fmt.Errorf("read user_version: %w", err)
	}
	return v, nil
}

// QuoteLite is only for identifiers we construct ourselves from a fixed set.
// Never use it on user input.
func QuoteLite(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}
