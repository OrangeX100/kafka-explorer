package kafka

// The fixture stands up a REAL in-process SSH server (x/crypto/ssh):
// password auth, a fixed host key, and direct-tcpip channels piped to a
// local TCP echo target. That exercises the whole tunnel path for real —
// handshake, TOFU fingerprint policy, listener lifecycle, and the
// kgo-style dialer remap — without any external environment.

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	gossh "golang.org/x/crypto/ssh"

	"kafkaexplorer/internal/domain"
)

// newHostKeySigner makes a fresh keypair; two calls give different keys so
// the TOFU mismatch test can rotate the server identity.
func newHostKeySigner(t *testing.T) gossh.Signer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate host key: %v", err)
	}
	signer, err := gossh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("signer from key: %v", err)
	}
	return signer
}

// startEchoServer returns the echo listener's address: bytes written to it
// come straight back — enough to prove a tunnel round-trip.
func startEchoServer(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("echo listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				_, _ = io.Copy(c, c)
				_ = c.Close()
			}(conn)
		}
	}()
	return ln.Addr().String()
}

// startSSHServer runs the jump host: password auth, the given host key,
// and every direct-tcpip channel proxied to target (what the requested
// broker address would reach through a real jump host).
func startSSHServer(t *testing.T, hostKey gossh.Signer, user, password, target string) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ssh listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	cfg := &gossh.ServerConfig{
		PasswordCallback: func(_ gossh.ConnMetadata, pass []byte) (*gossh.Permissions, error) {
			if string(pass) != password {
				return nil, fmt.Errorf("bad password")
			}
			return &gossh.Permissions{}, nil
		},
	}
	_ = user // the fixture accepts any user with the right password
	cfg.AddHostKey(hostKey)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go handleSSHConn(conn, cfg, target)
		}
	}()
	return ln.Addr().String()
}

func handleSSHConn(conn net.Conn, cfg *gossh.ServerConfig, target string) {
	server, chans, reqs, err := gossh.NewServerConn(conn, cfg)
	if err != nil {
		return
	}
	_ = server
	go gossh.DiscardRequests(reqs)
	for newCh := range chans {
		if newCh.ChannelType() != "direct-tcpip" {
			_ = newCh.Reject(gossh.UnknownChannelType, "unsupported")
			continue
		}
		// Payload layout (RFC 4254): hostLen+host+port+origLen+orig+origPort.
		// Parsed but the fixture proxies to its echo target regardless (the
		// "broker" behind a test jump host is the echo server).
		extra := newCh.ExtraData()
		if len(extra) < 4 {
			_ = newCh.Reject(gossh.ConnectionFailed, "bad payload")
			continue
		}
		hostLen := binary.BigEndian.Uint32(extra[:4])
		if int(hostLen)+8 > len(extra) {
			_ = newCh.Reject(gossh.ConnectionFailed, "bad payload")
			continue
		}
		up, err := net.Dial("tcp", target)
		if err != nil {
			_ = newCh.Reject(gossh.ConnectionFailed, err.Error())
			continue
		}
		ch, _, err := newCh.Accept()
		if err != nil {
			_ = up.Close()
			continue
		}
		go func() {
			done := make(chan struct{}, 2)
			go func() { _, _ = io.Copy(ch, up); done <- struct{}{} }()
			go func() { _, _ = io.Copy(up, ch); done <- struct{}{} }()
			<-done
			_ = up.Close()
			_ = ch.Close()
			<-done
		}()
	}
}

func tunnelCfg(addr string) domain.TunnelSettings {
	host, port, _ := net.SplitHostPort(addr)
	var p int
	_, _ = fmt.Sscan(port, &p)
	return domain.TunnelSettings{
		Enabled: true,
		Host:    host,
		Port:    p,
		User:    "tester",
		Auth:    domain.TunnelAuthPassword,
	}
}

func TestTunnelDialerRoundTrip(t *testing.T) {
	echo := startEchoServer(t)
	sshAddr := startSSHServer(t, newHostKeySigner(t), "tester", "p", echo)

	tm := NewTunnelManager(tunnelCfg(sshAddr), "p", nil)
	defer tm.Close()

	conn, err := tm.DialKafka(context.Background(), "tcp", "broker-1.example:9092")
	if err != nil {
		t.Fatalf("dial through tunnel: %v", err)
	}
	// Round-trip through jump host → echo proves the forwarder remap works
	// for an address that does not exist locally (what advertised listeners
	// look like behind a jump host).
	payload := []byte("ping-through-tunnel")
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write(payload); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(got) != string(payload) {
		t.Fatalf("echo mismatch: %q", got)
	}
	_ = conn.Close()

	// Second dial reuses the manager's SSH session + forwarder map.
	conn2, err := tm.DialKafka(context.Background(), "tcp", "broker-1.example:9092")
	if err != nil {
		t.Fatalf("second dial: %v", err)
	}
	_ = conn2.Close()
}

func TestTunnelTOFU(t *testing.T) {
	echo := startEchoServer(t)
	keyA := newHostKeySigner(t)
	keyB := newHostKeySigner(t)
	sshAddr := startSSHServer(t, keyA, "tester", "p", echo)

	var recorded string
	tm := NewTunnelManager(tunnelCfg(sshAddr), "p", func(fp string) error {
		recorded = fp
		return nil
	})
	conn, err := tm.DialKafka(context.Background(), "tcp", "b:9092")
	if err != nil {
		t.Fatalf("first dial: %v", err)
	}
	_ = conn.Close()
	if recorded == "" || !strings.HasPrefix(recorded, "SHA256:") {
		t.Fatalf("fingerprint not recorded: %q", recorded)
	}
	tm.Close()

	// Same key again → connects fine.
	tm2 := NewTunnelManager(func() domain.TunnelSettings {
		c := tunnelCfg(sshAddr)
		c.HostKey = recorded
		return c
	}(), "p", nil)
	defer tm2.Close()
	conn, err = tm2.DialKafka(context.Background(), "tcp", "b:9092")
	if err != nil {
		t.Fatalf("reconnect with pinned key: %v", err)
	}
	_ = conn.Close()
	tm2.Close()

	// Rotated host key → hard failure, never a silent accept.
	sshAddr2 := startSSHServer(t, keyB, "tester", "p", echo)
	tm3 := NewTunnelManager(func() domain.TunnelSettings {
		c := tunnelCfg(sshAddr2)
		c.HostKey = recorded
		return c
	}(), "p", nil)
	defer tm3.Close()
	if _, err := tm3.DialKafka(context.Background(), "tcp", "b:9092"); err == nil {
		t.Fatal("expected fingerprint mismatch to fail the dial")
	} else if !strings.Contains(err.Error(), "指纹发生变化") {
		t.Fatalf("mismatch error should explain the rotation: %v", err)
	}
}

func TestTunnelBadAuth(t *testing.T) {
	echo := startEchoServer(t)
	sshAddr := startSSHServer(t, newHostKeySigner(t), "tester", "p", echo)
	tm := NewTunnelManager(tunnelCfg(sshAddr), "WRONG", nil)
	defer tm.Close()
	if _, err := tm.DialKafka(context.Background(), "tcp", "b:9092"); err == nil {
		t.Fatal("expected wrong password to fail")
	}
}
