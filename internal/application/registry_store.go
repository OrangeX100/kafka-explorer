package application

import (
	"context"
	"fmt"
	"sync"

	"kafkaexplorer/internal/domain"
	"kafkaexplorer/internal/infrastructure/store"
)

// registryStore persists Schema Registry connections in the app database.
// Registry URLs are non-secret; basic-auth passwords ride the OS credential
// store in a later pass — the struct never carries a Password field.
type registryStore struct {
	db *store.DBWrapper
	mu sync.Mutex
}

func newRegistryStore(db *store.DBWrapper) *registryStore { return &registryStore{db: db} }

func (s *registryStore) list(ctx context.Context) ([]domain.SchemaRegistry, error) {
	return s.db.ListRegistries(ctx)
}

func (s *registryStore) get(ctx context.Context, id string) (domain.SchemaRegistry, error) {
	all, err := s.db.ListRegistries(ctx)
	if err != nil {
		return domain.SchemaRegistry{}, err
	}
	for _, r := range all {
		if r.ID == id {
			return r, nil
		}
	}
	return domain.SchemaRegistry{}, fmt.Errorf("registry %s: %w", id, domain.ErrNotFound)
}

func (s *registryStore) save(ctx context.Context, r domain.SchemaRegistry) (domain.SchemaRegistry, error) {
	return s.db.SaveRegistry(ctx, r)
}

func (s *registryStore) delete(ctx context.Context, id string) error {
	return s.db.DeleteRegistry(ctx, id)
}
