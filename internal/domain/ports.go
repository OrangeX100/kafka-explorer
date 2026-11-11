package domain

import "context"

// ConnectionRepository persists non-secret connection metadata.
// Implementations live in infrastructure/store.
type ConnectionRepository interface {
	List(ctx context.Context) ([]Connection, error)
	Get(ctx context.Context, id string) (Connection, error)
	Save(ctx context.Context, c Connection) error
	Delete(ctx context.Context, id string) error
	// SetPinned flips the list-ordering pin without touching UpdatedAt.
	SetPinned(ctx context.Context, id string, pinned bool) error
}

// SecretStore stores passwords in the OS credential store. Values are never
// written to disk by this application (schema guard test enforces the DB side
// of this rule).
type SecretStore interface {
	Set(service, ref, password string) error
	Get(service, ref string) (string, error)
	Delete(service, ref string) error
}
