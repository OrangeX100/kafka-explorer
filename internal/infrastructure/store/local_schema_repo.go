package store

import (
	"context"
	"time"

	"kafkaexplorer/internal/domain"
)

// --- offline local schema library ---

func (w *DBWrapper) ListLocalSchemas(ctx context.Context) ([]domain.LocalSchema, error) {
	rows, err := w.sqlDB.QueryContext(ctx, `
		SELECT id, name, schema_type, schema, created_at, updated_at
		FROM local_schemas ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.LocalSchema{}
	for rows.Next() {
		var s domain.LocalSchema
		var created, updated int64
		if err := rows.Scan(&s.ID, &s.Name, &s.SchemaType, &s.Schema, &created, &updated); err != nil {
			return nil, err
		}
		if ft := flexFromUnix(created); ft != nil {
			s.CreatedAt = *ft
		}
		if ft := flexFromUnix(updated); ft != nil {
			s.UpdatedAt = *ft
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (w *DBWrapper) SaveLocalSchema(ctx context.Context, s domain.LocalSchema) (domain.LocalSchema, error) {
	now := time.Now().Unix()
	_, err := w.sqlDB.ExecContext(ctx, `
		INSERT INTO local_schemas (id, name, schema_type, schema, created_at, updated_at)
		VALUES (?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			name=excluded.name, schema_type=excluded.schema_type, schema=excluded.schema,
			updated_at=excluded.updated_at`,
		s.ID, s.Name, s.SchemaType, s.Schema, now, now)
	return s, err
}

func (w *DBWrapper) DeleteLocalSchema(ctx context.Context, id string) error {
	_, err := w.sqlDB.ExecContext(ctx, `DELETE FROM local_schemas WHERE id = ?`, id)
	return err
}
