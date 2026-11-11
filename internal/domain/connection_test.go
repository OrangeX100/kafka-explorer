package domain

import (
	"errors"
	"testing"
	"time"
)

func TestConnectionValidate(t *testing.T) {
	base := func(mutate func(*Connection)) Connection {
		c := Connection{
			Name:      "local",
			Bootstrap: "localhost:9092",
			Security:  SecurityNone,
		}
		mutate(&c)
		return c
	}

	t.Run("valid minimal", func(t *testing.T) {
		if err := base(func(*Connection) {}).Validate(); err != nil {
			t.Errorf("unexpected error: %v", err)
		}
	})

	t.Run("empty name invalid", func(t *testing.T) {
		err := base(func(c *Connection) { c.Name = " " }).Validate()
		if !errors.Is(err, ErrInvalid) {
			t.Errorf("want ErrInvalid, got %v", err)
		}
	})

	t.Run("bootstrap entries", func(t *testing.T) {
		if err := base(func(c *Connection) {
			c.Bootstrap = "a:9092, b:9093 ,c:9094"
		}).Validate(); err != nil {
			t.Errorf("multi-entry with spaces should pass, got %v", err)
		}
		err := base(func(c *Connection) { c.Bootstrap = "localhost" }).Validate()
		if !errors.Is(err, ErrInvalid) {
			t.Errorf("host without port should fail, got %v", err)
		}
		err = base(func(c *Connection) { c.Bootstrap = "host:notaport" }).Validate()
		if !errors.Is(err, ErrInvalid) {
			t.Errorf("bad port should fail, got %v", err)
		}
	})

	t.Run("password mechanisms require secret ref", func(t *testing.T) {
		err := base(func(c *Connection) { c.Security = SecuritySASLScram512 }).Validate()
		if !errors.Is(err, ErrInvalid) {
			t.Errorf("scram without secretRef should fail, got %v", err)
		}
		ok := base(func(c *Connection) {
			c.Security = SecuritySASLScram512
			c.SecretRef = "conn-1"
		})
		if err := ok.Validate(); err != nil {
			t.Errorf("scram with secretRef should pass, got %v", err)
		}
	})

	t.Run("tls without ca is fine, timestamps not part of validation", func(t *testing.T) {
		c := base(func(c *Connection) { c.TLS.Enabled = true })
		created := FlexTime(time.Now())
		c.CreatedAt = &created
		if err := c.Validate(); err != nil {
			t.Errorf("tls-only config should pass, got %v", err)
		}
	})
}

func TestNeedsPassword(t *testing.T) {
	for _, m := range []SecurityMechanism{SecuritySASLPlain, SecuritySASLScram, SecuritySASLScram512} {
		if !(Connection{Security: m}).NeedsPassword() {
			t.Errorf("mechanism %s should need a password", m)
		}
	}
	if (Connection{Security: SecurityNone}).NeedsPassword() {
		t.Errorf("none should not need a password")
	}
}
