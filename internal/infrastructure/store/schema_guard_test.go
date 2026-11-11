package store_test

import (
	"path/filepath"
	"strings"
	"testing"

	"kafkaexplorer/internal/infrastructure/store"
)

// Schema security guard (governance rule 3): passwords live in the OS
// credential store only. A column that looks like a secret in any migration
// is a build failure — this is how the "secret never lands in SQLite" rule
// survives future migrations written under deadline pressure.
func TestSchemaNeverContainsSecretColumns(t *testing.T) {
	forbidden := []string{
		"password", "passwd", "secret_", "token", "passphrase",
		"private_key", "credential", "api_key",
	}
	// Whitelist: secret_ref is a *reference* to the credential store, not a
	// secret itself. Explicit, reviewed, with a reason — same spirit as the
	// exemption registry in audit-structure.
	allowed := map[string]string{
		"secret_ref": "pointer to OS credential store entry, no secret bytes",
	}

	migrations, err := store.MigrationSources()
	if err != nil {
		t.Fatalf("load migration sources: %v", err)
	}
	for _, m := range migrations {
		lower := strings.ToLower(m.Body)
		for _, bad := range forbidden {
			if !strings.Contains(lower, bad) {
				continue
			}
			// The substring matched; check whether every occurrence is a
			// whitelisted column definition or a comment.
			lines := strings.Split(lower, "\n")
			for i, line := range lines {
				if !strings.Contains(line, bad) {
					continue
				}
				ok := false
				for w, reason := range allowed {
					if strings.Contains(line, w) {
						ok = true
						_ = reason // reasons live in the map for reviewers
						break
					}
				}
				if strings.Contains(line, "--") {
					ok = true // comment lines explain, they do not store
				}
				if !ok {
					t.Errorf("migration %s line %d contains forbidden secret column pattern %q: %s",
						filepath.Base(m.Name), i+1, bad, strings.TrimSpace(line))
				}
			}
		}
	}
}
