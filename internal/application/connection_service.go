// Package application holds the use-case services. They orchestrate domain
// types and infrastructure ports, own validation, and know nothing about
// wails or the UI.
package application

import (
	"context"
	"fmt"
	"strings"
	"time"

	"kafkaexplorer/internal/domain"
	"kafkaexplorer/internal/infrastructure/kafka"
)

// ConnectionService manages saved cluster connections.
type ConnectionService struct {
	repo    domain.ConnectionRepository
	secrets domain.SecretStore
	pool    *kafka.Pool
}

func NewConnectionService(repo domain.ConnectionRepository, secrets domain.SecretStore, pool *kafka.Pool) *ConnectionService {
	return &ConnectionService{repo: repo, secrets: secrets, pool: pool}
}

func (s *ConnectionService) List(ctx context.Context) ([]domain.Connection, error) {
	return s.repo.List(ctx)
}

// SaveInput carries the connection plus the optional passwords. Passwords
// are write-only: they go to the SecretStore and are never echoed back.
type SaveInput struct {
	Connection domain.Connection `json:"connection"`
	// Password empty + existing secret => keep old password (edit without retyping).
	Password string `json:"password,omitempty"`
	// TunnelPassword is the SSH password (auth=password) or key passphrase
	// (auth=key — optional, unencrypted keys skip it).
	TunnelPassword string `json:"tunnelPassword,omitempty"`
}

func (s *ConnectionService) Save(ctx context.Context, in SaveInput) (domain.Connection, error) {
	c := in.Connection
	if c.ID == "" {
		c.ID = newID()
	}
	now := time.Now()
	existing, err := s.repo.Get(ctx, c.ID)
	if err == nil {
		c.CreatedAt = existing.CreatedAt
		c.SecretRef = existing.SecretRef
	} else {
		created := domain.FlexTime(now)
		c.CreatedAt = &created
	}
	// Editing a mechanism that needs a password with neither a new password
	// nor a previously stored one would silently produce a broken connection.
	if c.NeedsPassword() && in.Password == "" && c.SecretRef == "" {
		return domain.Connection{}, fmt.Errorf("%w: password is required for mechanism %s", domain.ErrInvalid, c.Security)
	}
	// Names are the user's handle for a connection (lists, switcher, search),
	// so duplicates are rejected up front — case and surrounding spaces
	// ignored, and the connection being edited is excluded from the check.
	all, err := s.repo.List(ctx)
	if err != nil {
		return domain.Connection{}, fmt.Errorf("list connections: %w", err)
	}
	name := strings.TrimSpace(c.Name)
	for _, o := range all {
		if o.ID != c.ID && strings.TrimSpace(o.Name) == name {
			return domain.Connection{}, fmt.Errorf("%w: 连接名称 %q 已存在", domain.ErrConflict, name)
		}
	}
	// Assign the secret reference BEFORE validation: domain.Validate requires
	// it for password mechanisms, and a fresh connection gets one here.
	if c.NeedsPassword() && c.SecretRef == "" {
		c.SecretRef = "conn-" + c.ID
	}
	if err := c.Validate(); err != nil {
		return domain.Connection{}, err
	}

	if c.NeedsPassword() {
		if in.Password != "" {
			if err := s.secrets.Set(secretService, c.SecretRef, in.Password); err != nil {
				return domain.Connection{}, fmt.Errorf("store password: %w", err)
			}
		}
	} else if c.SecretRef != "" {
		// Mechanism no longer needs a password: remove the stale secret.
		_ = s.secrets.Delete(secretService, c.SecretRef)
		c.SecretRef = ""
	}

	// Tunnel secret: password auth requires one; key auth stores a
	// passphrase only when the user typed one. Disabling the tunnel or
	// switching auth removes the stale entry.
	if c.Tunnel.Enabled && in.TunnelPassword != "" {
		if c.Tunnel.SecretRef == "" {
			c.Tunnel.SecretRef = "conn-tunnel-" + c.ID
		}
		if err := s.secrets.Set(secretService, c.Tunnel.SecretRef, in.TunnelPassword); err != nil {
			return domain.Connection{}, fmt.Errorf("store tunnel password: %w", err)
		}
	} else if !c.Tunnel.Enabled && c.Tunnel.SecretRef != "" {
		_ = s.secrets.Delete(secretService, c.Tunnel.SecretRef)
		c.Tunnel.SecretRef = ""
	}
	if c.Tunnel.Enabled && c.Tunnel.TunnelNeedsSecret() && c.Tunnel.SecretRef == "" {
		return domain.Connection{}, fmt.Errorf("%w: SSH 隧道使用密码认证但未填写密码", domain.ErrInvalid)
	}

	updated := domain.FlexTime(now)
	c.UpdatedAt = &updated
	if err := s.repo.Save(ctx, c); err != nil {
		return domain.Connection{}, err
	}
	// Security-relevant fields may have changed: drop the pooled client.
	s.pool.Evict(c.ID)
	return c, nil
}

// Disconnect drops the pooled client for a connection (pooled
// 断开连接): sockets and memory are freed; the saved config stays and the
// next use reconnects.
func (s *ConnectionService) Disconnect(_ context.Context, id string) {
	s.pool.Evict(id)
}

// Ping probes a connection's real broker reachability through the POOLED
// client (no re-dial when healthy). The sidebar's green dot is driven by
// this — "session open" alone would keep a dead cluster green forever.
func (s *ConnectionService) Ping(ctx context.Context, id string) error {
	client, err := s.pool.Acquire(ctx, id)
	if err != nil {
		return err
	}
	pctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	_, err = client.Test(pctx)
	return err
}

// CloneConnection duplicates a saved connection under a new unique name,
// copying its password into an independent secret so later edits on either
// copy stay separate. Returns the new connection (the UI opens it in the
// editor for renaming).
func (s *ConnectionService) CloneConnection(ctx context.Context, id, newName string) (domain.Connection, error) {
	src, err := s.repo.Get(ctx, id)
	if err != nil {
		return domain.Connection{}, err
	}
	clone := src
	clone.ID = newID()
	clone.Name = strings.TrimSpace(newName)
	clone.CreatedAt = nil
	clone.UpdatedAt = nil
	// Pre-assign the secret ref (mirroring Save) so the password-required
	// validation passes without a plaintext password, then copy the source's
	// password into the clone's own secret: later edits on either copy stay
	// independent.
	clone.SecretRef = ""
	if clone.NeedsPassword() {
		clone.SecretRef = "conn-" + clone.ID
		if src.SecretRef != "" {
			if pw, err := s.secrets.Get(secretService, src.SecretRef); err == nil && pw != "" {
				if err := s.secrets.Set(secretService, clone.SecretRef, pw); err != nil {
					return domain.Connection{}, fmt.Errorf("copy password: %w", err)
				}
			}
		}
	}
	if _, err := s.Save(ctx, SaveInput{Connection: clone}); err != nil {
		return domain.Connection{}, err
	}
	saved, err := s.repo.Get(ctx, clone.ID)
	if err != nil {
		return domain.Connection{}, err
	}
	return saved, nil
}

func (s *ConnectionService) Delete(ctx context.Context, id string) error {
	conn, err := s.repo.Get(ctx, id)
	if err != nil {
		return err
	}
	if conn.SecretRef != "" {
		_ = s.secrets.Delete(secretService, conn.SecretRef)
	}
	s.pool.Evict(id)
	return s.repo.Delete(ctx, id)
}

// TestResult reports a real login attempt, mirroring the classic desktop tool's
// "test connection": it dials, authenticates and lists brokers.
type TestResult struct {
	Success   bool     `json:"success"`
	Brokers   []string `json:"brokers,omitempty"`
	Error     string   `json:"error,omitempty"`
	ElapsedMs int64    `json:"elapsedMs"`
}

func (s *ConnectionService) Test(ctx context.Context, conn domain.Connection, password, tunnelPassword string) TestResult {
	start := time.Now()
	// passwords are the form's typed values for unsaved connections; empty
	// means the stored credential should be used. Never logged, never stored.
	brokers, err := kafka.TestConnection(ctx, conn, s.secrets, password, tunnelPassword)
	result := TestResult{ElapsedMs: time.Since(start).Milliseconds()}
	if err != nil {
		result.Error = ExplainError(err)
		return result
	}
	result.Success = true
	result.Brokers = brokers
	return result
}

// newID is a tiny uniqueness helper; crypto randomness is unnecessary for
// config rows (no security property depends on unpredictability).
func newID() string {
	return fmt.Sprintf("%d-%04d", time.Now().UnixMilli(), time.Now().UnixNano()%10000)
}

const secretService = "kafka-explorer"
