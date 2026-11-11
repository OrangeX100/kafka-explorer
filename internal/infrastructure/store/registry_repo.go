package store

import (
	"context"
	"database/sql"
	"time"

	"kafkaexplorer/internal/domain"
)

// DBWrapper is the persistence facade other layers use. It wraps the raw
// *sql.DB opened by Open and hosts per-entity repos as methods so callers
// depend on one type.
type DBWrapper struct {
	sqlDB *sql.DB
}

func NewWrapper(db *sql.DB) *DBWrapper { return &DBWrapper{sqlDB: db} }

// --- schema registry connections ---

func (w *DBWrapper) ListRegistries(ctx context.Context) ([]domain.SchemaRegistry, error) {
	rows, err := w.sqlDB.QueryContext(ctx, `
		SELECT id, name, url, username, secret_ref, created_at, updated_at
		FROM schema_registries ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.SchemaRegistry{}
	for rows.Next() {
		var r domain.SchemaRegistry
		var username, secretRef sql.NullString
		var created, updated int64
		if err := rows.Scan(&r.ID, &r.Name, &r.URL, &username, &secretRef, &created, &updated); err != nil {
			return nil, err
		}
		r.Username = username.String
		r.SecretRef = secretRef.String
		if ft := flexFromUnix(created); ft != nil {
			r.CreatedAt = *ft
		}
		if ft := flexFromUnix(updated); ft != nil {
			r.UpdatedAt = *ft
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (w *DBWrapper) SaveRegistry(ctx context.Context, r domain.SchemaRegistry) (domain.SchemaRegistry, error) {
	now := time.Now().Unix()
	_, err := w.sqlDB.ExecContext(ctx, `
		INSERT INTO schema_registries (id, name, url, username, secret_ref, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			name=excluded.name, url=excluded.url,
			username=COALESCE(excluded.username, schema_registries.username),
			secret_ref=COALESCE(excluded.secret_ref, schema_registries.secret_ref),
			updated_at=excluded.updated_at`,
		r.ID, r.Name, r.URL, nullIfEmpty(r.Username), nullIfEmpty(r.SecretRef), now, now)
	return r, err
}

func (w *DBWrapper) DeleteRegistry(ctx context.Context, id string) error {
	_, err := w.sqlDB.ExecContext(ctx, `DELETE FROM schema_registries WHERE id = ?`, id)
	return err
}

// --- application settings (key/value) ---

// SetSetting upserts one settings key with a JSON payload string.
func (w *DBWrapper) SetSetting(ctx context.Context, key, value string) error {
	_, err := w.sqlDB.ExecContext(ctx, `
		INSERT INTO settings (key, value) VALUES (?,?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}

// GetSetting reads one settings key; empty string = unset (callers apply defaults).
func (w *DBWrapper) GetSetting(ctx context.Context, key string) (string, error) {
	var value string
	err := w.sqlDB.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = ?`, key).Scan(&value)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return value, err
}

// --- connect clusters ---

func (w *DBWrapper) ListConnectClusters(ctx context.Context) ([]domain.ConnectCluster, error) {
	rows, err := w.sqlDB.QueryContext(ctx, `SELECT id, name, url, username, secret_ref FROM connect_clusters ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.ConnectCluster{}
	for rows.Next() {
		var c domain.ConnectCluster
		var username, secretRef any
		if err := rows.Scan(&c.ID, &c.Name, &c.URL, &username, &secretRef); err != nil {
			return nil, err
		}
		if s, ok := username.(string); ok {
			c.Username = s
		}
		if s, ok := secretRef.(string); ok {
			c.SecretRef = s
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (w *DBWrapper) SaveConnectCluster(ctx context.Context, c domain.ConnectCluster) (domain.ConnectCluster, error) {
	_, err := w.sqlDB.ExecContext(ctx, `
		INSERT INTO connect_clusters (id, name, url, username, secret_ref) VALUES (?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name, url=excluded.url,
			username=COALESCE(excluded.username, connect_clusters.username),
			secret_ref=COALESCE(excluded.secret_ref, connect_clusters.secret_ref)`,
		c.ID, c.Name, c.URL, nullIfEmpty(c.Username), nullIfEmpty(c.SecretRef))
	return c, err
}

func (w *DBWrapper) DeleteConnectCluster(ctx context.Context, id string) error {
	_, err := w.sqlDB.ExecContext(ctx, `DELETE FROM connect_clusters WHERE id = ?`, id)
	return err
}
