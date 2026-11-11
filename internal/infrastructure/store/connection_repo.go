package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"kafkaexplorer/internal/domain"
)

// ConnectionRepo implements domain.ConnectionRepository.
type ConnectionRepo struct {
	db *sql.DB
}

func NewConnectionRepo(db *sql.DB) *ConnectionRepo { return &ConnectionRepo{db: db} }

func (r *ConnectionRepo) List(ctx context.Context) ([]domain.Connection, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, name, bootstrap, security, username, secret_ref,
		       tls_enabled, tls_ca_cert_path, tls_client_cert_path, tls_client_key_path,
		       tls_insecure_skip_verify, created_at, updated_at, pinned
		FROM connections
		ORDER BY pinned DESC, name COLLATE NOCASE`)
	if err != nil {
		return nil, fmt.Errorf("list connections: %w", err)
	}
	defer rows.Close()

	out := []domain.Connection{}
	for rows.Next() {
		c, err := scanConnection(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

func (r *ConnectionRepo) Get(ctx context.Context, id string) (domain.Connection, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, name, bootstrap, security, username, secret_ref,
		       tls_enabled, tls_ca_cert_path, tls_client_cert_path, tls_client_key_path,
		       tls_insecure_skip_verify, created_at, updated_at, pinned
		FROM connections WHERE id = ?`, id)
	c, err := scanConnection(row)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Connection{}, fmt.Errorf("connection %s: %w", id, domain.ErrNotFound)
	}
	if err != nil {
		return domain.Connection{}, err
	}
	return *c, nil
}

func (r *ConnectionRepo) Save(ctx context.Context, c domain.Connection) error {
	createdAt := unixOf(c.CreatedAt)
	updatedAt := unixOf(c.UpdatedAt)
	tlsOn := boolToInt(c.TLS.Enabled)
	insecure := boolToInt(c.TLS.InsecureSkipVerify)

	// Upsert, preserving created_at on update.
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO connections (id, name, bootstrap, security, username, secret_ref,
		       tls_enabled, tls_ca_cert_path, tls_client_cert_path, tls_client_key_path,
		       tls_insecure_skip_verify, created_at, updated_at, pinned)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			name=excluded.name, bootstrap=excluded.bootstrap, security=excluded.security,
			username=excluded.username, secret_ref=excluded.secret_ref,
			tls_enabled=excluded.tls_enabled, tls_ca_cert_path=excluded.tls_ca_cert_path,
			tls_client_cert_path=excluded.tls_client_cert_path, tls_client_key_path=excluded.tls_client_key_path,
			tls_insecure_skip_verify=excluded.tls_insecure_skip_verify, updated_at=excluded.updated_at,
			pinned=excluded.pinned`,
		c.ID, c.Name, c.Bootstrap, string(c.Security), nullIfEmpty(c.Username), nullIfEmpty(c.SecretRef),
		tlsOn, nullIfEmpty(c.TLS.CACertPath), nullIfEmpty(c.TLS.ClientCertPath), nullIfEmpty(c.TLS.ClientKeyPath),
		insecure, createdAt, updatedAt, boolToInt(c.Pinned))
	if err != nil {
		return fmt.Errorf("save connection %s: %w", c.ID, err)
	}
	return nil
}

func (r *ConnectionRepo) Delete(ctx context.Context, id string) error {
	res, err := r.db.ExecContext(ctx, `DELETE FROM connections WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete connection %s: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("connection %s: %w", id, domain.ErrNotFound)
	}
	return nil
}

type rowScanner interface{ Scan(dest ...any) error }

func scanConnection(s rowScanner) (*domain.Connection, error) {
	var (
		c                domain.Connection
		security         string
		username, ref    sql.NullString
		tlsOn, insecure  int
		ca, cert, key    sql.NullString
		created, updated int64
		pinned           int
	)
	if err := s.Scan(&c.ID, &c.Name, &c.Bootstrap, &security, &username, &ref,
		&tlsOn, &ca, &cert, &key, &insecure, &created, &updated, &pinned); err != nil {
		return nil, fmt.Errorf("scan connection: %w", err)
	}
	c.Security = domain.SecurityMechanism(security)
	c.Username = username.String
	c.SecretRef = ref.String
	c.TLS = domain.TLSSettings{
		Enabled:            tlsOn == 1,
		CACertPath:         ca.String,
		ClientCertPath:     cert.String,
		ClientKeyPath:      key.String,
		InsecureSkipVerify: insecure == 1,
	}
	c.CreatedAt = flexFromUnix(created)
	c.UpdatedAt = flexFromUnix(updated)
	c.Pinned = pinned == 1
	return &c, nil
}

// SetPinned flips the pin flag without touching updated_at — ordering is a
// view preference, not a config edit.
func (r *ConnectionRepo) SetPinned(ctx context.Context, id string, pinned bool) error {
	res, err := r.db.ExecContext(ctx, `UPDATE connections SET pinned = ? WHERE id = ?`, boolToInt(pinned), id)
	if err != nil {
		return fmt.Errorf("set pinned %s: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("connection %s: %w", id, domain.ErrNotFound)
	}
	return nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// unixOf stores zero FlexTime as 0: a year-1 timestamp in SQLite would
// confuse future date handling for no benefit.
func unixOf(t *domain.FlexTime) int64 {
	if t == nil || t.Time().IsZero() {
		return 0
	}
	return t.Time().Unix()
}

func flexFromUnix(v int64) *domain.FlexTime {
	if v == 0 {
		return nil
	}
	ft := domain.FlexTime(time.Unix(v, 0))
	return &ft
}
