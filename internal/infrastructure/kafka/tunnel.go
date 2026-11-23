package kafka

// SSH tunnel support: brokers on private networks are reached through an
// SSH jump host. One ssh.Client multiplexes every forwarder; each broker
// address (seed list AND advertised listeners from metadata) gets a lazily
// created 127.0.0.1:<random> listener, and the kgo dialer remaps broker
// addresses onto those listeners. Without the remap the client would dial
// advertised addresses directly and bypass the tunnel entirely — the reason
// a plain SSH -L port-forward breaks with multi-broker clusters.
//
// Host key policy is trust-on-first-use: the jump host's first-seen
// public-key fingerprint is recorded (via the onHostKey callback, which
// persists it in the connection row); a later connect with a different
// fingerprint fails hard instead of continuing — a silent accept would make
// the MITM window permanent.

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	gossh "golang.org/x/crypto/ssh"

	"kafkaexplorer/internal/domain"
	"kafkaexplorer/internal/fsutil"
)

// sshDialTimeout bounds the broker-channel open in handleLocalConn: a
// blackholed broker behind the jump host otherwise hangs ~127s in the jump
// host's kernel SYN retries, outside any of our deadlines (0.4.21 review P2-6).
const sshDialTimeout = 15 * time.Second

// fingerprintSHA256 renders a public key the way OpenSSH's known_hosts
// fingerprint column does.
func fingerprintSHA256(key gossh.PublicKey) string {
	sum := sha256.Sum256(key.Marshal())
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

// TunnelManager owns one connection's SSH session and its forwarders.
type TunnelManager struct {
	cfg    domain.TunnelSettings
	secret string // password or key passphrase, resolved at open time
	// onHostKey persists a first-seen fingerprint (nil = in-memory only,
	// which is what unit tests use).
	onHostKey func(fingerprint string) error

	mu       sync.Mutex
	client   *gossh.Client
	forwards map[string]*localForward
	closed   bool
}

type localForward struct {
	ln     net.Listener
	target string
}

// NewTunnelManager builds a manager for one connection's tunnel settings.
func NewTunnelManager(cfg domain.TunnelSettings, secret string, onHostKey func(fingerprint string) error) *TunnelManager {
	return &TunnelManager{
		cfg:       cfg,
		secret:    secret,
		onHostKey: onHostKey,
		forwards:  map[string]*localForward{},
	}
}

// hostKeyCallback implements the TOFU policy described above.
func (t *TunnelManager) hostKeyCallback() gossh.HostKeyCallback {
	return func(_ string, _ net.Addr, key gossh.PublicKey) error {
		fp := fingerprintSHA256(key)
		t.mu.Lock()
		stored := t.cfg.HostKey
		t.mu.Unlock()
		if stored == "" {
			if t.onHostKey != nil {
				if err := t.onHostKey(fp); err != nil {
					return fmt.Errorf("记录 SSH 主机指纹失败: %w", err)
				}
			}
			t.mu.Lock()
			t.cfg.HostKey = fp
			t.mu.Unlock()
			return nil
		}
		if stored != fp {
			return fmt.Errorf("SSH 主机指纹发生变化（记录 %s，本次 %s）。这可能意味着跳板机被重装或正在被中间人攻击；确认安全后请删除旧指纹重新信任", stored, fp)
		}
		return nil
	}
}

// authMethods builds the SSH auth list for the configured auth type.
func (t *TunnelManager) authMethods() ([]gossh.AuthMethod, error) {
	if t.cfg.Auth == domain.TunnelAuthKey {
		// 16MB 帽：私钥从不需要更大（045 round-5 安全回归）。
		raw, err := fsutil.ReadFileCapped(t.cfg.KeyPath, 16<<20)
		if err != nil {
			return nil, fmt.Errorf("读取 SSH 私钥失败: %w", err)
		}
		var signer gossh.Signer
		if t.secret != "" {
			signer, err = gossh.ParsePrivateKeyWithPassphrase(raw, []byte(t.secret))
		} else {
			signer, err = gossh.ParsePrivateKey(raw)
		}
		if err != nil {
			return nil, fmt.Errorf("解析 SSH 私钥失败（口令错误或格式不支持）: %w", err)
		}
		return []gossh.AuthMethod{gossh.PublicKeys(signer)}, nil
	}
	if t.secret == "" {
		return nil, fmt.Errorf("SSH 隧道密码未配置")
	}
	return []gossh.AuthMethod{gossh.Password(t.secret)}, nil
}

// ensureSSH dials the jump host once and reuses the session.
func (t *TunnelManager) ensureSSH() (*gossh.Client, error) {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil, fmt.Errorf("SSH 隧道已关闭")
	}
	if t.client != nil {
		c := t.client
		t.mu.Unlock()
		return c, nil
	}
	t.mu.Unlock()

	auth, err := t.authMethods()
	if err != nil {
		return nil, err
	}
	cfg := &gossh.ClientConfig{
		User:            t.cfg.User,
		Auth:            auth,
		HostKeyCallback: t.hostKeyCallback(),
		Timeout:         10 * time.Second,
	}
	addr := fmt.Sprintf("%s:%d", t.cfg.Host, t.cfg.EffectivePort())
	client, err := gossh.Dial("tcp", addr, cfg)
	if err != nil {
		return nil, fmt.Errorf("SSH 连接 %s 失败: %w", addr, err)
	}
	t.mu.Lock()
	// Another goroutine may have dialed while we were out here — keep the
	// winner, close the loser. Close() may ALSO have run while the dial was
	// in flight (closed=true, client=nil): hanging the fresh session on a
	// closed manager would leak it until process exit — close it here.
	if t.closed {
		t.mu.Unlock()
		client.Close()
		return nil, fmt.Errorf("SSH 隧道已关闭")
	}
	if t.client != nil {
		winner := t.client
		t.mu.Unlock()
		client.Close()
		return winner, nil
	}
	t.client = client
	t.mu.Unlock()
	// Lifecycle watcher: when the SSH session dies (network blip, server
	// restart), clear the cached client so the NEXT ensureSSH re-dials
	// instead of handing out a corpse forever. Without this the tunnel had
	// NO recovery — every forwarded connection kept failing until the user
	// evicted the pooled client. Pointer-matched: a superseded/closed client
	// never clears a newer one, and Close() nils t.client first, so teardown
	// stays race-free.
	go func() {
		_ = client.Wait()
		t.mu.Lock()
		if t.client == client {
			t.client = nil
		}
		t.mu.Unlock()
	}()
	return client, nil
}

// ensureForward creates (or returns) the local listener for one broker
// address. The listener lives until Close; retries dial the same port.
func (t *TunnelManager) ensureForward(target string) (string, error) {
	if _, _, err := net.SplitHostPort(target); err != nil {
		return "", fmt.Errorf("broker 地址 %q 不是 host:port", target)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return "", fmt.Errorf("SSH 隧道已关闭")
	}
	if f, ok := t.forwards[target]; ok {
		return f.ln.Addr().String(), nil
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("创建本地转发端口失败: %w", err)
	}
	f := &localForward{ln: ln, target: target}
	t.forwards[target] = f
	go t.acceptLoop(f)
	return ln.Addr().String(), nil
}

func (t *TunnelManager) acceptLoop(f *localForward) {
	for {
		local, err := f.ln.Accept()
		if err != nil {
			return // listener closed by Close
		}
		go t.handleLocalConn(local, f.target)
	}
}

// handleLocalConn pipes one accepted TCP connection through an SSH
// direct-tcpip channel to the broker target. The channel open is bounded:
// client.Dial lets the JUMP HOST dial the broker — a blackholed broker IP
// used to hang here through the jump host's kernel SYN retries (~127s on
// Linux), unaffectable by any kgo/page deadline on our side (0.4.21
// review P2-6).
func (t *TunnelManager) handleLocalConn(local net.Conn, target string) {
	client, err := t.ensureSSH()
	if err != nil {
		local.Close()
		return
	}
	type dialResult struct {
		conn net.Conn
		err  error
	}
	ch := make(chan dialResult, 1)
	go func() {
		conn, err := client.Dial("tcp", target)
		ch <- dialResult{conn, err}
	}()
	var remote net.Conn
	select {
	case res := <-ch:
		if res.err != nil {
			local.Close()
			return
		}
		remote = res.conn
	case <-time.After(sshDialTimeout):
		// Timed out waiting for the jump host: close the local leg so the
		// kgo-side read fails immediately instead of hanging past its own
		// deadlines. The late channel open (if the jump host eventually
		// answers) is reaped by a second bounded wait — an unbounded <-ch
		// here would strand this goroutine forever on a blackholed target
		// (0.4.21 二轮评审 P3).
		local.Close()
		select {
		case res := <-ch:
			if res.conn != nil {
				res.conn.Close()
			}
		case <-time.After(30 * time.Second):
			// goroutine 与 channel 一并放弃（泄漏面封顶为单个 goroutine）
		}
		return
	}
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(remote, local); done <- struct{}{} }()
	go func() { _, _ = io.Copy(local, remote); done <- struct{}{} }()
	<-done
	_ = remote.Close()
	_ = local.Close()
	<-done
}

// DialKafka is the kgo dialer: every broker address is remapped onto its
// local forwarder. TLS (if configured) applies on top of the returned conn
// by franz-go itself, so the tunnel stays transparent to the SASL/TLS stack.
func (t *TunnelManager) DialKafka(ctx context.Context, network, address string) (net.Conn, error) {
	if network != "tcp" {
		return nil, fmt.Errorf("不支持的网络的类型 %q（Kafka 连接应为 tcp）", network)
	}
	// Establish the SSH session BEFORE returning the local conn — otherwise
	// an auth/handshake failure surfaces as a silently-closed conn
	// mid-transfer instead of a dial error, and the TOFU fingerprint would
	// race the dial (the unit tests caught both).
	if _, err := t.ensureSSH(); err != nil {
		return nil, err
	}
	localAddr, err := t.ensureForward(address)
	if err != nil {
		return nil, err
	}
	var d net.Dialer
	// 尊重调用方 ctx：kgo 的页/请求截止要能取消本地拨号（旧代码丢 ctx 用
	// context.Background()，取消传导在这里断链——评审 P2-6 同族）
	return d.DialContext(ctx, "tcp", localAddr)
}

// Close tears down all forwarders and the SSH session.
func (t *TunnelManager) Close() {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return
	}
	t.closed = true
	forwards := make([]*localForward, 0, len(t.forwards))
	for _, f := range t.forwards {
		forwards = append(forwards, f)
	}
	t.forwards = map[string]*localForward{}
	client := t.client
	t.client = nil
	t.mu.Unlock()
	for _, f := range forwards {
		_ = f.ln.Close()
	}
	if client != nil {
		_ = client.Close()
	}
}
