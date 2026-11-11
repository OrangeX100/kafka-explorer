package store

import (
	"context"
	"database/sql"

	"kafkaexplorer/internal/domain"
)

// ksqlDB server persistence — same shape as connect clusters: URL and
// username are non-secret, secret_ref points into the OS credential store.
func (w *DBWrapper) ListKsqlDbServers(ctx context.Context) ([]domain.KsqlDbServer, error) {
	rows, err := w.sqlDB.QueryContext(ctx, `SELECT id, name, url, username, secret_ref FROM ksql_db_servers ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.KsqlDbServer{}
	for rows.Next() {
		var s domain.KsqlDbServer
		var username, secretRef sql.NullString
		if err := rows.Scan(&s.ID, &s.Name, &s.URL, &username, &secretRef); err != nil {
			return nil, err
		}
		s.Username = username.String
		s.SecretRef = secretRef.String
		out = append(out, s)
	}
	return out, rows.Err()
}

func (w *DBWrapper) SaveKsqlDbServer(ctx context.Context, s domain.KsqlDbServer) (domain.KsqlDbServer, error) {
	_, err := w.sqlDB.ExecContext(ctx, `
		INSERT INTO ksql_db_servers (id, name, url, username, secret_ref) VALUES (?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name, url=excluded.url,
			username=COALESCE(excluded.username, ksql_db_servers.username),
			secret_ref=COALESCE(excluded.secret_ref, ksql_db_servers.secret_ref)`,
		s.ID, s.Name, s.URL, nullIfEmpty(s.Username), nullIfEmpty(s.SecretRef))
	return s, err
}

func (w *DBWrapper) DeleteKsqlDbServer(ctx context.Context, id string) error {
	_, err := w.sqlDB.ExecContext(ctx, `DELETE FROM ksql_db_servers WHERE id = ?`, id)
	return err
}
