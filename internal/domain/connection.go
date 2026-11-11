// Package domain holds entities, repository interfaces and typed errors.
// It must not import any third-party package: every dependency points inward.
package domain

import (
	"fmt"
	"net"
	"strconv"
	"strings"
)

// SecurityMechanism enumerates the SASL mechanisms supported in P1.
// TLS is orthogonal (see TLSSettings.Enabled) — "SASL over SSL" in other
// tools is just a mechanism plus TLS here. Kerberos (GSSAPI) is P2.
type SecurityMechanism string

const (
	SecurityNone         SecurityMechanism = "none"
	SecuritySASLPlain    SecurityMechanism = "sasl/plain"
	SecuritySASLScram    SecurityMechanism = "sasl/scram-sha256"
	SecuritySASLScram512 SecurityMechanism = "sasl/scram-sha512"
)

// TLSSettings describes a client-side TLS setup. Certificate material lives on
// disk (paths only here); the key-store password is a secret and never lands
// in this struct after load-time.
type TLSSettings struct {
	Enabled            bool   `json:"enabled"`
	CACertPath         string `json:"caCertPath,omitempty"`
	ClientCertPath     string `json:"clientCertPath,omitempty"`
	ClientKeyPath      string `json:"clientKeyPath,omitempty"`
	InsecureSkipVerify bool   `json:"insecureSkipVerify,omitempty"`
}

// Connection is the user-visible cluster connection configuration.
// Secrets (SASL password, TLS key password) are NOT fields here: they live in
// the OS credential store under SecretRef. See infra/keyring.
type Connection struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Bootstrap string            `json:"bootstrap"` // "host:port,host:port"
	Security  SecurityMechanism `json:"security"`
	Username  string            `json:"username,omitempty"` // SASL user; not a secret
	SecretRef string            `json:"secretRef,omitempty"`// keyring entry name; empty when mechanism needs no password
	TLS       TLSSettings       `json:"tls"`
	// Pinned connections sort first in the list (favorites pinning); toggling it
	// is not a content edit, so it never bumps UpdatedAt.
	Pinned bool `json:"pinned,omitempty"`
	// FlexTime (not time.Time): the new-connection form sends "" and plain
	// time.Time rejects it during JSON binding (real bug, see time.go).
	CreatedAt *FlexTime `json:"createdAt,omitempty"`
	UpdatedAt *FlexTime `json:"updatedAt,omitempty"`
}

// NeedsPassword reports whether the mechanism requires a stored password.
func (c Connection) NeedsPassword() bool {
	switch c.Security {
	case SecuritySASLPlain, SecuritySASLScram, SecuritySASLScram512:
		return true
	}
	return false
}

// Validate checks the fields the UI must always supply. Bootstrap parsing is
// deliberately strict: a wrong entry only surfaces at dial time otherwise.
func (c Connection) Validate() error {
	if strings.TrimSpace(c.Name) == "" {
		return fmt.Errorf("%w: name is required", ErrInvalid)
	}
	for _, addr := range strings.Split(c.Bootstrap, ",") {
		addr = strings.TrimSpace(addr)
		if addr == "" {
			continue
		}
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return fmt.Errorf("%w: bootstrap entry %q is not host:port", ErrInvalid, addr)
		}
		if host == "" {
			return fmt.Errorf("%w: bootstrap entry %q has empty host", ErrInvalid, addr)
		}
		if p, err := strconv.Atoi(port); err != nil || p <= 0 || p > 65535 {
			return fmt.Errorf("%w: bootstrap entry %q has invalid port", ErrInvalid, addr)
		}
	}
	if c.NeedsPassword() && strings.TrimSpace(c.SecretRef) == "" {
		return fmt.Errorf("%w: password required for mechanism %s", ErrInvalid, c.Security)
	}
	return nil
}
