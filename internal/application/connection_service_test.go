package application

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"kafkaexplorer/internal/domain"
	"kafkaexplorer/internal/infrastructure/kafka"
	"kafkaexplorer/internal/infrastructure/store"
)

// fakeSecrets is an in-memory SecretStore for tests — it never touches the
// OS credential store.
type fakeSecrets struct {
	values map[string]string
}

func (f *fakeSecrets) Set(_, ref, password string) error {
	f.values[ref] = password
	return nil
}

func (f *fakeSecrets) Get(_, ref string) (string, error) {
	v, ok := f.values[ref]
	if !ok {
		return "", errors.New("not found")
	}
	return v, nil
}

func (f *fakeSecrets) Delete(_, ref string) error {
	delete(f.values, ref)
	return nil
}

func newTestService(t *testing.T) (*ConnectionService, *fakeSecrets) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	repo := store.NewConnectionRepo(db)
	secrets := &fakeSecrets{values: map[string]string{}}
	pool := kafka.NewPool(repo, secrets)
	t.Cleanup(pool.CloseAll)
	return NewConnectionService(repo, secrets, pool), secrets
}

func TestSavePasswordGoesToSecretStoreOnly(t *testing.T) {
	svc, secrets := newTestService(t)
	saved, err := svc.Save(context.Background(), SaveInput{
		Connection: domain.Connection{
			Name:      "prod",
			Bootstrap: "kafka1:9092",
			Security:  domain.SecuritySASLScram512,
			Username:  "admin",
		},
		Password: "s3cret!",
	})
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if saved.SecretRef == "" {
		t.Fatal("expected SecretRef to be set for password mechanisms")
	}
	if _, ok := secrets.values[saved.SecretRef]; !ok {
		t.Error("password must land in the secret store")
	}
}

func TestSaveKeepsPasswordWhenBlank(t *testing.T) {
	svc, secrets := newTestService(t)
	saved, _ := svc.Save(context.Background(), SaveInput{
		Connection: domain.Connection{Name: "prod", Bootstrap: "k1:9092", Security: domain.SecuritySASLPlain, Username: "u"},
		Password:   "old",
	})
	edited, err := svc.Save(context.Background(), SaveInput{Connection: saved})
	if err != nil {
		t.Fatalf("re-save without password: %v", err)
	}
	if edited.SecretRef != saved.SecretRef {
		t.Error("SecretRef must survive an edit without a new password")
	}
	if secrets.values[saved.SecretRef] != "old" {
		t.Error("stored password must not be overwritten by an empty input")
	}
}

func TestSaveRejectsPasswordMechanismWithoutAnyPassword(t *testing.T) {
	svc, _ := newTestService(t)
	_, err := svc.Save(context.Background(), SaveInput{
		Connection: domain.Connection{Name: "prod", Bootstrap: "k1:9092", Security: domain.SecuritySASLPlain, Username: "u"},
	})
	if !errors.Is(err, domain.ErrInvalid) {
		t.Errorf("want ErrInvalid for missing password, got %v", err)
	}
}

func TestSwitchingMechanismRemovesStaleSecret(t *testing.T) {
	svc, secrets := newTestService(t)
	saved, _ := svc.Save(context.Background(), SaveInput{
		Connection: domain.Connection{Name: "prod", Bootstrap: "k1:9092", Security: domain.SecuritySASLPlain, Username: "u"},
		Password:   "old",
	})
	saved.Security = domain.SecurityNone
	saved.Username = ""
	after, err := svc.Save(context.Background(), SaveInput{Connection: saved})
	if err != nil {
		t.Fatalf("switch to none: %v", err)
	}
	if after.SecretRef != "" {
		t.Error("SecretRef must be cleared when the mechanism no longer needs a password")
	}
	if _, ok := secrets.values[saved.SecretRef]; ok {
		t.Error("stale secret must be deleted from the secret store")
	}
}

func TestDeleteRemovesSecretToo(t *testing.T) {
	svc, secrets := newTestService(t)
	saved, _ := svc.Save(context.Background(), SaveInput{
		Connection: domain.Connection{Name: "prod", Bootstrap: "k1:9092", Security: domain.SecuritySASLPlain, Username: "u"},
		Password:   "old",
	})
	if err := svc.Delete(context.Background(), saved.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, ok := secrets.values[saved.SecretRef]; ok {
		t.Error("deleting a connection must delete its stored secret")
	}
}
