// Package keyring stores secrets in the OS credential store
// (Windows Credential Manager / macOS Keychain / Linux Secret Service).
// This is the only place passwords touch persistent storage.
package keyring

import (
	"fmt"
	"strings"

	"github.com/zalando/go-keyring"

	"kafkaexplorer/internal/domain"
)

// Store implements domain.SecretStore. Service is fixed per-app so entries
// are namespaced; ref is the per-connection secret name.
type Store struct {
	service string
}

func NewStore(service string) *Store { return &Store{service: service} }

func (s *Store) Set(_, ref, password string) error {
	if err := keyring.Set(s.service, ref, password); err != nil {
		return fmt.Errorf("keyring set %s: %w", ref, err)
	}
	return nil
}

func (s *Store) Get(_, ref string) (string, error) {
	v, err := keyring.Get(s.service, ref)
	if err != nil {
		// go-keyring's ErrNotFound wraps differently per platform; normalize.
		return "", fmt.Errorf("%w: keyring get %s: %v", domain.ErrNotFound, ref, err)
	}
	return v, nil
}

func (s *Store) Delete(_, ref string) error {
	if err := keyring.Delete(s.service, ref); err != nil {
		// A missing secret is fine: the caller's intent is achieved (go-keyring
		// reports it as ErrNotFound on every platform). Any OTHER failure —
		// daemon down, access denied — is real and must surface: swallowing
		// it would leave live credentials behind after the user deleted the
		// connection, which looks exactly like a leak from the outside.
		if !strings.Contains(strings.ToLower(err.Error()), "not found") {
			return fmt.Errorf("keyring delete %s: %w", ref, err)
		}
	}
	return nil
}
