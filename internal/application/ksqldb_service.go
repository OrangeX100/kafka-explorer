package application

import (
	"context"
	"fmt"

	"kafkaexplorer/internal/domain"
	"kafkaexplorer/internal/infrastructure/ksqldb"
)

// KsqlDbService manages saved ksqlDB servers and runs statements/queries
// against them. Secrets ride the OS credential store, same as Connect.
type KsqlDbService struct {
	store   *ksqldbStore
	secrets domain.SecretStore
}

type ksqldbStore struct {
	db interface {
		ListKsqlDbServers(ctx context.Context) ([]domain.KsqlDbServer, error)
		SaveKsqlDbServer(ctx context.Context, s domain.KsqlDbServer) (domain.KsqlDbServer, error)
		DeleteKsqlDbServer(ctx context.Context, id string) error
	}
}

func NewKsqlDbService(dbw interface {
	ListKsqlDbServers(ctx context.Context) ([]domain.KsqlDbServer, error)
	SaveKsqlDbServer(ctx context.Context, s domain.KsqlDbServer) (domain.KsqlDbServer, error)
	DeleteKsqlDbServer(ctx context.Context, id string) error
}, secrets domain.SecretStore) *KsqlDbService {
	return &KsqlDbService{store: &ksqldbStore{db: dbw}, secrets: secrets}
}

func (s *KsqlDbService) List(ctx context.Context) ([]domain.KsqlDbServer, error) {
	return s.store.db.ListKsqlDbServers(ctx)
}

func (s *KsqlDbService) Save(ctx context.Context, in domain.KsqlDbServer) (domain.KsqlDbServer, error) {
	if err := in.Validate(); err != nil {
		return domain.KsqlDbServer{}, err
	}
	if in.ID == "" {
		in.ID = newID()
	}
	return s.store.db.SaveKsqlDbServer(ctx, in)
}

func (s *KsqlDbService) Delete(ctx context.Context, id string) error {
	return s.store.db.DeleteKsqlDbServer(ctx, id)
}

func (s *KsqlDbService) clientFor(ctx context.Context, serverID string) (*ksqldb.Client, error) {
	servers, err := s.List(ctx)
	if err != nil {
		return nil, err
	}
	for _, sv := range servers {
		if sv.ID == serverID {
			return ksqldb.New(sv.URL, sv.Username, s.storedPassword(sv.SecretRef)), nil
		}
	}
	return nil, fmt.Errorf("ksqldb server %s: %w", serverID, domain.ErrNotFound)
}

func (s *KsqlDbService) storedPassword(ref string) string {
	if ref == "" || s.secrets == nil {
		return ""
	}
	if pass, err := s.secrets.Get("kafka-explorer", ref); err == nil {
		return pass
	}
	return ""
}

// Test verifies an unsaved form (inline credentials allowed).
func (s *KsqlDbService) Test(ctx context.Context, url, username, password string) (version, serviceID, status string, err error) {
	return ksqldb.New(url, username, password).Info(ctx)
}

// Info returns the saved server's /info.
func (s *KsqlDbService) Info(ctx context.Context, serverID string) (version, serviceID, status string, err error) {
	c, err := s.clientFor(ctx, serverID)
	if err != nil {
		return "", "", "", err
	}
	return c.Info(ctx)
}

// Exec runs one statement batch (SHOW/DESCRIBE/TERMINATE/CREATE/...).
func (s *KsqlDbService) Exec(ctx context.Context, serverID, ksql string) (domain.KsqlExecResult, error) {
	c, err := s.clientFor(ctx, serverID)
	if err != nil {
		return domain.KsqlExecResult{}, err
	}
	return c.Exec(ctx, ksql)
}

// Query runs one push/pull query on /query-stream, delivering rows through
// onRow. Push queries run until ctx is cancelled — that is the stop button,
// not an error.
func (s *KsqlDbService) Query(ctx context.Context, serverID, sql string, onRow ksqldb.RowHandler) error {
	c, err := s.clientFor(ctx, serverID)
	if err != nil {
		return err
	}
	return c.QueryStream(ctx, sql, onRow)
}
