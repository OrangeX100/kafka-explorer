// Package kafka wraps franz-go (kgo + kadm) behind a small surface the
// application layer can use without knowing Kafka client details.
//
// One Client per saved connection, pooled by Pool. Secrets are passed in at
// open time and never cached: the pool calls Secrets.Get on every open so a
// password changed in the OS credential store takes effect on the next dial.
package kafka

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/sasl/plain"
	"github.com/twmb/franz-go/pkg/sasl/scram"

	"kafkaexplorer/internal/domain"
)

const clientID = "kafka-explorer"

// Client is a pooled wrapper around kgo/kadm for one connection.
// opts keeps the connection's security options so throwaway browse/page
// clients (BrowsePage/Find) reuse the exact same configuration — a page
// client without seed brokers polls forever and returns empty pages
// (real bug found by the integration probe).
type Client struct {
	kgo  *kgo.Client
	adm  *kadm.Client
	opts []kgo.Opt
	// browsePool: one dedicated client per (topic/partition) being paged.
	// A single shared client is UNSAFE for this: fetch responses already
	// buffered from the previous partition come back after repositioning
	// and PollRecords serves them as the new partition's data (the
	// "click smoke-test, see probe's 33 records" bug). Per-partition
	// clients isolate that state; LRU caps the count.
	browseMu    sync.Mutex
	browsePool  map[string]*kgo.Client
	browseOrder []string // LRU order, oldest first
	// boundsCache: topic -> (starts, ends, expires). resolveAnchor needs
	// both bound sets on every page; a 5s TTL turns pagination from 2 extra
	// round-trips per page into 0 while staying fresh for a GUI session.
	boundsMu    sync.Mutex
	boundsCache map[string]boundsEntry
}

type boundsEntry struct {
	starts  map[int32]int64
	ends    map[int32]int64
	expires time.Time
}

// Open dials the cluster. It does not retry: the caller surfaces failures.
func Open(ctx context.Context, conn domain.Connection, password string) (*Client, error) {
	opts, err := clientOpts(conn, password)
	if err != nil {
		return nil, err
	}
	kc, err := kgo.NewClient(opts...)
	if err != nil {
		return nil, mapErr(fmt.Errorf("create kafka client: %w", err))
	}
	// NewClient connects lazily; force one metadata round-trip so callers get
	// a real dial/auth error here instead of on their first operation.
	testCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if _, err := kadm.NewClient(kc).Metadata(testCtx); err != nil {
		kc.Close()
		return nil, mapErr(fmt.Errorf("connect: %w", err))
	}
	return &Client{kgo: kc, adm: kadm.NewClient(kc), opts: opts}, nil
}

func (c *Client) Close() {
	if c == nil {
		return
	}
	for _, pc := range c.browsePool {
		pc.Close()
	}
	c.browsePool = nil
	c.browseOrder = nil
	if c.kgo != nil {
		c.kgo.Close()
	}
}

const browsePoolLimit = 6

// BrowseClientFor returns the dedicated client for one topic/partition,
// creating it positioned at anchor. Same-key callers reposition via
// Remove+Add (Add alone does not reset an assigned partition's offset).
// The browseMu is held until the returned unlock runs: reposition + poll
// stay serialized, and poll responses can only belong to this partition.
func (c *Client) BrowseClientFor(topic string, partition int32, anchor int64) (*kgo.Client, func(), error) {
	c.browseMu.Lock()
	if c.browsePool == nil {
		c.browsePool = map[string]*kgo.Client{}
	}
	key := fmt.Sprintf("%s/%d", topic, partition)

	pc, ok := c.browsePool[key]
	if ok {
		// LRU touch + reposition.
		for i, k := range c.browseOrder {
			if k == key {
				c.browseOrder = append(c.browseOrder[:i], c.browseOrder[i+1:]...)
				break
			}
		}
		c.browseOrder = append(c.browseOrder, key)
		pc.RemoveConsumePartitions(map[string][]int32{topic: {partition}})
		pc.AddConsumePartitions(map[string]map[int32]kgo.Offset{
			topic: {partition: kgo.NewOffset().At(anchor)},
		})
		return pc, c.browseMu.Unlock, nil
	}

	pc, err := kgo.NewClient(copyOpts(c.opts,
		kgo.ConsumePartitions(map[string]map[int32]kgo.Offset{
			topic: {partition: kgo.NewOffset().At(anchor)},
		}),
		kgo.DisableFetchSessions(),
	)...)
	if err != nil {
		c.browseMu.Unlock()
		return nil, nil, mapErr(fmt.Errorf("create browse client: %w", err))
	}
	c.browsePool[key] = pc
	c.browseOrder = append(c.browseOrder, key)

	// Evict the oldest beyond the cap (its records state dies with it).
	for len(c.browseOrder) > browsePoolLimit {
		oldest := c.browseOrder[0]
		c.browseOrder = c.browseOrder[1:]
		if old, exists := c.browsePool[oldest]; exists {
			old.Close()
			delete(c.browsePool, oldest)
		}
	}
	return pc, c.browseMu.Unlock, nil
}

// Test performs a metadata round-trip and returns the broker list.
func (c *Client) Test(ctx context.Context) ([]string, error) {
	md, err := c.adm.Metadata(ctx)
	if err != nil {
		return nil, mapErr(err)
	}
	out := make([]string, 0, len(md.Brokers))
	for _, b := range md.Brokers { // already sorted by node id
		out = append(out, fmt.Sprintf("%s:%d(b%d)", b.Host, b.Port, b.NodeID))
	}
	return out, nil
}

// clientOpts translates a domain.Connection into franz-go options.
// Kept exported-within-package so Browse's temporary page clients use the
// exact same security configuration as the pooled client.
func clientOpts(conn domain.Connection, password string) ([]kgo.Opt, error) {
	brokers := strings.Split(conn.Bootstrap, ",")
	clean := make([]string, 0, len(brokers))
	for _, b := range brokers {
		if b = strings.TrimSpace(b); b != "" {
			clean = append(clean, b)
		}
	}
	if len(clean) == 0 {
		return nil, fmt.Errorf("%w: bootstrap address list is empty", domain.ErrInvalid)
	}
	opts := []kgo.Opt{
		kgo.SeedBrokers(clean...),
		kgo.ClientID(clientID),
		// A GUI tool must not hang forever on a slow broker; the services
		// layer applies shorter per-operation deadlines on top of this.
		kgo.RequestTimeoutOverhead(5 * time.Second),
		// kadm's list calls serve kgo's CACHED metadata (RequestCached-
		// Metadata). The 5-minute default made freshly created topics
		// invisible and deleted topics linger as ghosts in the topic list —
		// an admin GUI needs near-fresh metadata instead.
		kgo.MetadataMaxAge(10 * time.Second),
		// Honor the produce dialog's explicit partition choice while
		// keeping the default sticky/key behavior for auto partitioning.
		kgo.RecordPartitioner(&manualAwarePartitioner{inner: kgo.StickyKeyPartitioner(nil)}),
	}

	if conn.NeedsPassword() {
		auth := func(context.Context) (scram.Auth, error) {
			return scram.Auth{User: conn.Username, Pass: password}, nil
		}
		switch conn.Security {
		case domain.SecuritySASLPlain:
			opts = append(opts, kgo.SASL(plain.Plain(func(ctx context.Context) (plain.Auth, error) {
				return plain.Auth{User: conn.Username, Pass: password}, nil
			})))
		case domain.SecuritySASLScram:
			opts = append(opts, kgo.SASL(scram.Sha256(auth)))
		case domain.SecuritySASLScram512:
			opts = append(opts, kgo.SASL(scram.Sha512(auth)))
		}
	}

	if conn.TLS.Enabled {
		cfg := &tls.Config{
			InsecureSkipVerify: conn.TLS.InsecureSkipVerify, //nolint:gosec // explicit user opt-in for self-signed clusters
			MinVersion:         tls.VersionTLS12,
		}
		if conn.TLS.CACertPath != "" {
			pem, err := os.ReadFile(conn.TLS.CACertPath)
			if err != nil {
				return nil, fmt.Errorf("%w: read CA cert: %v", domain.ErrInvalid, err)
			}
			pool := x509.NewCertPool()
			if !pool.AppendCertsFromPEM(pem) {
				return nil, fmt.Errorf("%w: CA cert file has no usable certificate", domain.ErrInvalid)
			}
			cfg.RootCAs = pool
		}
		if conn.TLS.ClientCertPath != "" && conn.TLS.ClientKeyPath != "" {
			pair, err := tls.LoadX509KeyPair(conn.TLS.ClientCertPath, conn.TLS.ClientKeyPath)
			if err != nil {
				return nil, fmt.Errorf("%w: load client key pair: %v", domain.ErrInvalid, err)
			}
			cfg.Certificates = []tls.Certificate{pair}
		}
		opts = append(opts, kgo.DialTLSConfig(cfg))
	}
	return opts, nil
}

// mapErr converts client-specific errors into the typed domain errors the
// presentation layer knows how to explain to users. Network failures are
// reduced to a factual Chinese sentence (what failed, which address) — the
// frontend classifies them and attaches per-category how-to-fix hints, so raw
// syscall noise ("connectex: No connection could be made …") never reaches a
// user.
func mapErr(err error) error {
	if err == nil {
		return nil
	}
	var ke *kerr.Error
	if errors.As(err, &ke) {
		switch ke.Code {
		case kerr.SaslAuthenticationFailed.Code:
			return fmt.Errorf("%w: %s", domain.ErrUnauthorized, ke.Message)
		case kerr.UnknownTopicOrPartition.Code:
			return fmt.Errorf("%w: %s", domain.ErrNotFound, ke.Message)
		case kerr.TopicAuthorizationFailed.Code, kerr.GroupAuthorizationFailed.Code, kerr.ClusterAuthorizationFailed.Code:
			return fmt.Errorf("%w: %s", domain.ErrUnauthorized, ke.Message)
		}
	}
	var de *net.DNSError
	if errors.As(err, &de) {
		return fmt.Errorf("%w: 无法解析主机名 %s（请检查地址拼写与 DNS）", domain.ErrUnavailable, de.Name)
	}
	var oe *net.OpError
	if errors.As(err, &oe) {
		// Best-effort address: dial errors carry the resolved TCPAddr.
		addr := ""
		if oe.Addr != nil {
			addr = oe.Addr.String()
		}
		switch {
		case isConnRefused(oe.Err):
			return fmt.Errorf("%w: %s 连接被拒绝（端口未开放或被防火墙/安全组拦截）", domain.ErrUnavailable, addr)
		case isTimeoutErr(oe.Err) || errors.Is(err, context.DeadlineExceeded):
			return fmt.Errorf("%w: %s 连接超时（网络不可达，或端口被防火墙/安全组拦截）", domain.ErrUnavailable, addr)
		case isTLSErr(oe.Err):
			return fmt.Errorf("%w: %s TLS 握手失败（请确认 broker 端口是否启用 TLS、证书是否受信任）", domain.ErrUnavailable, addr)
		}
		return fmt.Errorf("%w: %s %s 失败（%v）", domain.ErrUnavailable, addr, oe.Op, oe.Err)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%w: 操作超时", domain.ErrUnavailable)
	}
	return err
}

// isConnRefused matches ECONNREFUSED across platforms (Linux errno and the
// Windows WSAECONNREFUSED alias), falling back to the message text because
// Windows dial failures carry vendor phrasing ("actively refused").
func isConnRefused(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "refused") || strings.Contains(msg, "拒绝")
}

func isTimeoutErr(err error) bool {
	if err == nil {
		return false
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return true
	}
	return errors.Is(err, os.ErrDeadlineExceeded) || os.IsTimeout(err)
}

// isTLSErr recognizes TLS-layer failures inside a wrapped OpError. The tls
// package does not export a single sentinel, so this keys off the message
// prefix; raw TCP noise never starts with "tls:".
func isTLSErr(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.HasPrefix(msg, "tls:") || strings.Contains(msg, "certificate") || strings.Contains(msg, "x509")
}
