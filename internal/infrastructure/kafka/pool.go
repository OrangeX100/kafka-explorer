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
	// locks serializes open/evict per CONNECTION: dialing happens OUTSIDE the
	// map mutex, so an unreachable cluster's 8s open no longer blocks Acquire
	// and Evict for every other connection. Evict takes the same per-id lock
	// first, preserving the old "evict waits for an in-flight open" semantic.
	locks   map[string]*sync.Mutex
	repo    domain.ConnectionRepository
	secrets domain.SecretStore
}

type entry struct {
	client *Client
}

func NewPool(repo domain.ConnectionRepository, secrets domain.SecretStore) *Pool {
	return &Pool{
		clients: map[string]*entry{},
		locks:   map[string]*sync.Mutex{},
		repo:    repo,
		secrets: secrets,
	}
}

// lockFor returns the per-connection build lock, creating it on first use.
// Lock order is ALWAYS lockFor(id) → p.mu; CloseAll collects the per-id locks
// under p.mu and then takes them one by one WITHOUT holding p.mu, so the
// ordering stays consistent and no lock inversion is possible.
func (p *Pool) lockFor(connectionID string) *sync.Mutex {
	p.mu.Lock()
	defer p.mu.Unlock()
	lm, ok := p.locks[connectionID]
	if !ok {
		lm = &sync.Mutex{}
		p.locks[connectionID] = lm
	}
	return lm
}

// Acquire returns an open client for the connection. The returned client is
// shared; callers must not close it — release ownership stays with the pool.
func (p *Pool) Acquire(ctx context.Context, connectionID string) (*Client, error) {
	e, err := p.acquire(ctx, connectionID)
	if err != nil {
		return nil, err
	}
	return e.client, nil
}

func (p *Pool) acquire(ctx context.Context, connectionID string) (*entry, error) {
	// Same-connection acquires serialize (two racing acquires must not both
	// dial and double-open the cluster); different connections dial in
	// parallel — the network work happens under this per-id lock, NOT under
	// the pool-wide mutex.
	lm := p.lockFor(connectionID)
	lm.Lock()
	defer lm.Unlock()

	p.mu.Lock()
	if e, ok := p.clients[connectionID]; ok {
		p.mu.Unlock()
		return e, nil
	}
	p.mu.Unlock()

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
	var tm *TunnelManager
	if conn.Tunnel.Enabled {
		var tunnelSecret string
		if conn.Tunnel.SecretRef != "" {
			if tunnelSecret, err = p.secrets.Get(keyringService, conn.Tunnel.SecretRef); err != nil {
				return nil, fmt.Errorf("load stored tunnel secret: %w", err)
			}
		}
		// TOFU: the first successful handshake's fingerprint is persisted on
		// the connection row; later mismatches fail inside the handshake.
		tm = NewTunnelManager(conn.Tunnel, tunnelSecret, func(fp string) error {
			updated := conn
			updated.Tunnel.HostKey = fp
			return p.repo.Save(ctx, updated)
		})
	}
	c, err := Open(ctx, conn, password, tm)
	if err != nil {
		return nil, err
	}
	e := &entry{client: c}
	p.mu.Lock()
	p.clients[connectionID] = e
	p.mu.Unlock()
	return e, nil
}

// Evict closes and forgets the pooled client (after config changes). Taking
// the per-id build lock first means an open still in flight finishes and
// lands its client, which is then immediately evicted — the old
// open-under-global-lock behavior, minus the pool-wide stall.
func (p *Pool) Evict(connectionID string) {
	lm := p.lockFor(connectionID)
	lm.Lock()
	defer lm.Unlock()
	p.mu.Lock()
	e, ok := p.clients[connectionID]
	if ok {
		delete(p.clients, connectionID)
	}
	p.mu.Unlock()
	if ok {
		e.client.Close()
	}
}

// CloseAll shuts every pooled client (app shutdown path).
func (p *Pool) CloseAll() {
	p.mu.Lock()
	locks := make([]*sync.Mutex, 0, len(p.locks))
	for _, lm := range p.locks {
		locks = append(locks, lm)
	}
	p.mu.Unlock()
	// Serialize with any in-flight open, then swap the map out and close
	// everything (lm → p.mu order, same as acquire).
	for _, lm := range locks {
		lm.Lock()
		lm.Unlock()
	}
	p.mu.Lock()
	old := p.clients
	p.clients = map[string]*entry{}
	p.mu.Unlock()
	for _, e := range old {
		e.client.Close()
	}
}

// keyringService matches app/service names in the credential store. It lives
// here so both the pool and the page-client path share one constant.
const keyringService = "kafka-explorer"

// TestConnection is a standalone helper for the connection form: it opens a
// throwaway client (never pooled) and returns the broker list.
// providedPassword serves unsaved connections whose typed password is not in
// the credential store yet; empty means "load the stored one".
// providedTunnelSecret is the same for the SSH tunnel (password or key
// passphrase). The test's TOFU fingerprint stays in memory — persistence
// happens on the pooled open path.
func TestConnection(ctx context.Context, conn domain.Connection, secrets domain.SecretStore, providedPassword, providedTunnelSecret string) ([]string, error) {
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
	var tm *TunnelManager
	if conn.Tunnel.Enabled {
		tunnelSecret := providedTunnelSecret
		if tunnelSecret == "" && conn.Tunnel.SecretRef != "" {
			var err error
			if tunnelSecret, err = secrets.Get(keyringService, conn.Tunnel.SecretRef); err != nil {
				return nil, fmt.Errorf("load stored tunnel secret: %w", err)
			}
		}
		tm = NewTunnelManager(conn.Tunnel, tunnelSecret, nil)
	}
	c, err := Open(ctx, conn, password, tm)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	return c.Test(ctx)
}
