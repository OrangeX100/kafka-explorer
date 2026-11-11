package kafka

import (
	"context"
	"fmt"
	"sync"
	"time"


	"kafkaexplorer/internal/domain"
)

// Pool keeps one open Client per connection and re-dials lazily.
// Open failures are NOT cached: a transient broker outage must not turn into
// a permanently poisoned pool entry.
type Pool struct {
	mu      sync.Mutex
	clients map[string]*entry
	repo    domain.ConnectionRepository
	secrets domain.SecretStore
}

type entry struct {
	client *Client
}

func NewPool(repo domain.ConnectionRepository, secrets domain.SecretStore) *Pool {
	return &Pool{clients: map[string]*entry{}, repo: repo, secrets: secrets}
}

// Acquire returns an open client for the connection. The returned client is
// shared; callers must not close it — release ownership stays with the pool.
// The entry is resolved entirely under the lock: reading the map again after
// acquire raced with Evict/CloseAll (map-read crash or nil-entry deref).
func (p *Pool) Acquire(ctx context.Context, connectionID string) (*Client, error) {
	e, err := p.acquire(ctx, connectionID)
	if err != nil {
		return nil, err
	}
	return e.client, nil
}

func (p *Pool) acquire(ctx context.Context, connectionID string) (*entry, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if e, ok := p.clients[connectionID]; ok {
		return e, nil
	}
	conn, err := p.repo.Get(ctx, connectionID)
	if err != nil {
		return nil, err
	}
	var password string
	if conn.NeedsPassword() {
		// Fetched fresh on every open: never cached, never logged.
		if password, err = p.secrets.Get(keyringService, conn.SecretRef); err != nil {
			return nil, fmt.Errorf("load stored password: %w", err)
		}
	}
	c, err := Open(ctx, conn, password)
	if err != nil {
		return nil, err
	}
	e := &entry{client: c}
	p.clients[connectionID] = e
	return e, nil
}

// Evict closes and forgets the pooled client (after config changes).
func (p *Pool) Evict(connectionID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if e, ok := p.clients[connectionID]; ok {
		delete(p.clients, connectionID)
		e.client.Close()
	}
}

// CloseAll shuts every pooled client (app shutdown path).
func (p *Pool) CloseAll() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for id, e := range p.clients {
		e.client.Close()
		delete(p.clients, id)
	}
}

// keyringService matches app/service names in the credential store. It lives
// here so both the pool and the page-client path share one constant.
const keyringService = "kafka-explorer"

// TestConnection is a standalone helper for the connection form: it opens a
// throwaway client (never pooled) and returns the broker list.
// providedPassword serves unsaved connections whose typed password is not in
// the credential store yet; empty means "load the stored one".
func TestConnection(ctx context.Context, conn domain.Connection, secrets domain.SecretStore, providedPassword string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var password string
	if conn.NeedsPassword() {
		if providedPassword != "" {
			password = providedPassword
		} else {
			var err error
			if password, err = secrets.Get(keyringService, conn.SecretRef); err != nil {
				return nil, fmt.Errorf("load stored password: %w", err)
			}
		}
	}
	c, err := Open(ctx, conn, password)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	return c.Test(ctx)
}
