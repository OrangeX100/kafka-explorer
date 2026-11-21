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

// TunnelAuth enumerates how the SSH jump host authenticates the user.
type TunnelAuth string

const (
	TunnelAuthPassword TunnelAuth = "password"
	TunnelAuthKey      TunnelAuth = "key"
)

// TunnelSettings describes an SSH jump host that brokers are reached
// through. The password (auth=password) or key passphrase (auth=key) is a
// secret and lives in the OS credential store behind SecretRef — never here.
//
// HostKey pins the jump host's first-seen public-key fingerprint
// (SHA-256 base64, ssh.FingerprintSHA256 format): trust-on-first-use —
// the first connect records it, later mismatches fail hard (MITM guard).
// Empty = not recorded yet.
type TunnelSettings struct {
	Enabled   bool       `json:"enabled"`
	Host      string     `json:"host,omitempty"`
	Port      int        `json:"port,omitempty"` // 0 = 22
	User      string     `json:"user,omitempty"`
	Auth      TunnelAuth `json:"auth,omitempty"` // password | key
	KeyPath   string     `json:"keyPath,omitempty"`
	SecretRef string     `json:"secretRef,omitempty"`
	HostKey   string     `json:"hostKey,omitempty"`
}

// EffectivePort resolves the SSH port default.
func (t TunnelSettings) EffectivePort() int {
	if t.Port > 0 {
		return t.Port
	}
	return 22
}

// Connection is the user-visible cluster connection configuration.
// Secrets (SASL password, TLS key password) are NOT fields here: they live in
// the OS credential store under SecretRef. See infra/keyring.
type Connection struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Bootstrap string            `json:"bootstrap"` // "host:port,host:port"
	Security  SecurityMechanism `json:"security"`
	Username  string            `json:"username,omitempty"`  // SASL user; not a secret
	SecretRef string            `json:"secretRef,omitempty"` // keyring entry name; empty when mechanism needs no password
	TLS       TLSSettings       `json:"tls"`
	// Tunnel: when enabled, every broker connection is dialed through an
	// SSH jump host (local forwarders remap advertised listener addresses).
	Tunnel TunnelSettings `json:"tunnel"`
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
	// Bootstrap must carry at least one non-empty address segment: the old
	// skip-empty-continue let "", "," and ", ," save fine and the failure
	// only surfaced in English at dial time (045 round-5 P3-1).
	hasAddr := false
	for _, addr := range strings.Split(c.Bootstrap, ",") {
		addr = strings.TrimSpace(addr)
		if addr == "" {
			continue
		}
		hasAddr = true
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
	if !hasAddr {
		return fmt.Errorf("%w: bootstrap 需要至少一个 broker 地址（host:port，多个用英文逗号分隔）", ErrInvalid)
	}
	// mTLS 证书/私钥必须成对出现：client.go 只在两者都非空时加载，单边
	// 填写会被静默丢弃，连接以"无客户端证书"发起，真因不可见（045 round-5）。
	if c.TLS.Enabled && c.TLS.ClientCertPath != "" && c.TLS.ClientKeyPath == "" {
		return fmt.Errorf("%w: 已填写客户端证书但缺少私钥路径（两者必须成对提供）", ErrInvalid)
	}
	if c.TLS.Enabled && c.TLS.ClientCertPath == "" && c.TLS.ClientKeyPath != "" {
		return fmt.Errorf("%w: 已填写私钥但缺少客户端证书路径（两者必须成对提供）", ErrInvalid)
	}
	if c.NeedsPassword() && strings.TrimSpace(c.SecretRef) == "" {
		return fmt.Errorf("%w: password required for mechanism %s", ErrInvalid, c.Security)
	}
	if err := validateTunnel(c.Tunnel); err != nil {
		return err
	}
	return nil
}

// TunnelNeedsSecret reports whether the tunnel auth needs a stored secret.
// A password is mandatory; a key passphrase is optional (unencrypted keys).
func (t TunnelSettings) TunnelNeedsSecret() bool {
	return t.Enabled && t.Auth == TunnelAuthPassword
}

func validateTunnel(t TunnelSettings) error {
	if !t.Enabled {
		return nil
	}
	if strings.TrimSpace(t.Host) == "" {
		return fmt.Errorf("%w: SSH 隧道已启用但未填写跳板机地址", ErrInvalid)
	}
	if strings.TrimSpace(t.User) == "" {
		return fmt.Errorf("%w: SSH 隧道已启用但未填写用户名", ErrInvalid)
	}
	switch t.Auth {
	case TunnelAuthPassword:
		// secret presence is enforced by the service (keyring may already
		// hold it from a previous save even when the form resends "")
	case TunnelAuthKey:
		if strings.TrimSpace(t.KeyPath) == "" {
			return fmt.Errorf("%w: SSH 隧道使用密钥认证但未填写私钥路径", ErrInvalid)
		}
	default:
		return fmt.Errorf("%w: 未知 SSH 认证方式 %q", ErrInvalid, t.Auth)
	}
	return nil
}
