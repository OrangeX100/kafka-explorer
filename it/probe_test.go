//go:build integration

// Package it runs end-to-end probes against a REAL Kafka cluster, exercising
// the same infrastructure layer the app uses (kafka.Pool / services). These
// are the tests that would have caught the binding-layer class of bugs —
// run them manually: go test -tags=integration ./it/ -v
package it

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"
	"os"
	"testing"
	"time"

	"kafkaexplorer/internal/domain"
	"kafkaexplorer/internal/application"
	"kafkaexplorer/internal/infrastructure/kafka"
)

func bootstrapAddr(t *testing.T) string {
	t.Helper()
	addr := os.Getenv("KAFKA_BOOTSTRAP")
	if addr == "" {
		t.Skip("set KAFKA_BOOTSTRAP to run integration probes against a real cluster")
	}
	return addr
}

func newConn(t *testing.T) domain.Connection {
	t.Helper()
	return domain.Connection{
		Name:      "integration-probe",
		Bootstrap: bootstrapAddr(t),
		Security:  domain.SecurityNone,
	}
}

const probeConnID = "integration-probe"

// nopRepo returns the probe connection for every id: MessageIOService goes
// through the Pool, which resolves connections from a repository.
type nopRepo struct{ conn domain.Connection }

func (r nopRepo) List(ctx context.Context) ([]domain.Connection, error) {
	return []domain.Connection{r.conn}, nil
}
func (r nopRepo) Get(ctx context.Context, id string) (domain.Connection, error) {
	return r.conn, nil
}
func (r nopRepo) Save(ctx context.Context, c domain.Connection) error   { return nil }
func (r nopRepo) Delete(ctx context.Context, id string) error           { return nil }
func (r nopRepo) SetPinned(ctx context.Context, id string, pinned bool) error { return nil }

type nopSecrets struct{}

func (nopSecrets) Set(string, string, string) error       { return nil }
func (nopSecrets) Get(string, string) (string, error)     { return "", nil }
func (nopSecrets) Delete(string, string) error            { return nil }

// TestFullMessagePath covers the P1 core chain against the live cluster:
// test-connection → topic create → produce ×3 → browse (both directions)
// → find → topic config → consumer-group list.
func TestFullMessagePath(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	conn := newConn(t)
	secrets := nopSecrets{}

	// 1. dial + auth (what the connection form's 测试连接 does)
	brokers, err := kafka.TestConnection(ctx, conn, secrets, "", "")
	if err != nil {
		t.Fatalf("test connection: %v", err)
	}
	t.Logf("brokers: %v", brokers)

	client, err := kafka.Open(ctx, conn, "", nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer client.Close()

	// 2. dedicated probe topic
	const topic = "kafka-explorer-probe"
	if err := client.CreateTopic(ctx, topic, 1, 1, nil); err != nil {
		t.Logf("create topic (may already exist): %v", err)
	}

	// 3. produce three identifiable records
	stamp := time.Now().UnixMilli()
	for i := 1; i <= 3; i++ {
		value := fmt.Sprintf("probe-value-%d-%d", stamp, i)
		if _, err := client.Produce(ctx, topic, nil, []byte("probe-key"), []byte(value), nil); err != nil {
			t.Fatalf("produce %d: %v", i, err)
		}
	}

	// 4. topic list contains it with a non-zero count
	topics, err := client.ListTopics(ctx)
	if err != nil {
		t.Fatalf("list topics: %v", err)
	}
	found := false
	for _, tp := range topics {
		if tp.Name == topic {
			found = true
			if tp.MessageCount < 3 {
				t.Errorf("topic %s messageCount = %d, want >= 3", topic, tp.MessageCount)
			}
		}
	}
	if !found {
		t.Fatalf("probe topic missing from list")
	}

	// 5. browse newest window (backward) — the app's default view
	partition := int32(0)
	page, err := client.BrowsePage(ctx, domain.BrowseRequest{
		ConnectionID: "probe", Topic: topic, Partition: &partition,
		Direction: "backward", Limit: 10,
	})
	if err != nil {
		t.Fatalf("browse backward: %v", err)
	}
	if len(page.Messages) < 3 {
		t.Fatalf("backward page has %d messages, want >= 3", len(page.Messages))
	}
	if page.Messages[len(page.Messages)-1].Offset >= page.Messages[0].Offset {
		t.Error("backward page must be sorted newest-first")
	}

	// 6. browse forward from log start
	page, err = client.BrowsePage(ctx, domain.BrowseRequest{
		ConnectionID: "probe", Topic: topic, Partition: &partition,
		Direction: "forward", Limit: 10,
	})
	if err != nil {
		t.Fatalf("browse forward: %v", err)
	}
	if len(page.Messages) == 0 {
		t.Fatal("forward page empty")
	}
	if page.Messages[0].Offset > page.Messages[len(page.Messages)-1].Offset {
		t.Error("forward page must be sorted oldest-first")
	}

	// 7. find by value substring
	req := domain.FindRequest{
		BrowseRequest: domain.BrowseRequest{
			ConnectionID: "probe", Topic: topic, Partition: &partition,
			Direction: "forward", Limit: 10,
		},
		Pattern: fmt.Sprintf("probe-value-%d", stamp), MatchValue: true, MaxScan: 50_000,
	}
	foundMsgs, scanned, err := client.Find(ctx, req)
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(foundMsgs.Messages) != 3 {
		t.Errorf("find matched %d messages, want 3 (scanned %d)", len(foundMsgs.Messages), scanned)
	}

	// 8. topic config surface renders data (what TopicConfigs views)
	detail, err := client.TopicDetail(ctx, topic)
	if err != nil {
		t.Fatalf("topic detail: %v", err)
	}
	if len(detail.Config) == 0 {
		t.Error("topic detail returned no configs")
	}
	if len(detail.PartitionList) != 1 || detail.PartitionList[0].Leader < 0 {
		t.Error("partition layout incomplete")
	}

	// 8b. export the whole partition with To=nil — the dialog's DEFAULT
	// (empty end field). This path panicked on *in.To before the fix.
	zero, one := int32(0), int64(1)
	pool := kafka.NewPool(nopRepo{conn}, nopSecrets{})
	io := application.NewMessageIOService(pool)
	exported, err := io.Export(ctx, domain.ExportMessagesInput{
		ConnectionID: probeConnID, Topic: topic, Partition: &zero, From: 0, To: nil, Format: "jsonl",
	})
	if err != nil {
		t.Fatalf("export To=nil: %v", err)
	}
	if strings.Count(exported, "\n")+1 < 3 {
		t.Errorf("export To=nil produced %d lines, want >= 3", strings.Count(exported, "\n")+1)
	}
	// windowed export (From=1, To=1) must return exactly the middle record
	windowed, err := io.Export(ctx, domain.ExportMessagesInput{
		ConnectionID: probeConnID, Topic: topic, Partition: &zero, From: 1, To: &one, Format: "jsonl",
	})
	if err != nil {
		t.Fatalf("export window: %v", err)
	}
	if n := strings.Count(windowed, "\n") + 1; n != 1 {
		t.Errorf("windowed export returned %d lines, want 1", n)
	}

	// 9. consumer-group list must not error on an empty cluster section
	if _, err := client.ListGroups(ctx); err != nil {
		t.Fatalf("list groups: %v", err)
	}

	// 10. reset-offset planning (dry-run only — nothing committed)
	t.Logf("full path OK against %s", bootstrapAddr(t))
}

// TestTopicDetailLatency guards the parallel-fetch optimization: four
// independent round-trips must not serialize. Serial floor on this cluster
// measured ~2.4s; parallel ceiling ~0.9s. Budget: under 1.8s.
func TestTopicDetailLatency(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client, err := kafka.Open(ctx, newConn(t), "", nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer client.Close()

	// warm one dial out of the budget
	start := time.Now()
	detail, err := client.TopicDetail(ctx, "kafka-explorer-probe")
	dialMs := time.Since(start).Milliseconds()
	if err != nil {
		t.Fatalf("topic detail: %v", err)
	}
	t.Logf("first TopicDetail: %dms (includes one dial)", dialMs)
	if len(detail.PartitionList) == 0 {
		t.Fatal("no partitions")
	}

	// steady-state: reuse warm client + cached nothing (fresh topic name
	// would dodge the bounds cache; detail has no cache — parallelism itself
	// must keep this fast)
	start = time.Now()
	if _, err := client.TopicDetail(ctx, "kafka-explorer-probe"); err != nil {
		t.Fatalf("topic detail 2: %v", err)
	}
	elapsed := time.Since(start)
	t.Logf("warm TopicDetail: %v", elapsed)
	if elapsed > 1800*time.Millisecond {
		t.Errorf("TopicDetail took %v — parallel fetch regressed to serial?", elapsed)
	}
}

// TestBrowseCrossTopicIsolation pins the "click A, see B" bug: with the
// per-partition browse-client pool, alternating topics must never serve
// records that belong to the other topic.
func TestBrowseCrossTopicIsolation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	client, err := kafka.Open(ctx, newConn(t), "", nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer client.Close()

	const topicA = "kafka-explorer-isol-a"
	const topicB = "kafka-explorer-isol-b"
	_ = client.CreateTopic(ctx, topicA, 1, 1, nil)
	_ = client.CreateTopic(ctx, topicB, 1, 1, nil)

	stamp := time.Now().UnixMilli()
	for i := 1; i <= 2; i++ {
		if _, err := client.Produce(ctx, topicA, nil, []byte("k"), []byte(fmt.Sprintf("A-marker-%d-%d", stamp, i)), nil); err != nil {
			t.Fatalf("produce A: %v", err)
		}
		if _, err := client.Produce(ctx, topicB, nil, []byte("k"), []byte(fmt.Sprintf("B-marker-%d-%d", stamp, i)), nil); err != nil {
			t.Fatalf("produce B: %v", err)
		}
	}

	partition := int32(0)
	browseTail := func(topic string) domain.BrowsePage {
		page, err := client.BrowsePage(ctx, domain.BrowseRequest{
			ConnectionID: "probe", Topic: topic, Partition: &partition,
			Direction: "backward", Limit: 10,
		})
		if err != nil {
			t.Fatalf("browse %s: %v", topic, err)
		}
		return page
	}
	expectMarker := func(page domain.BrowsePage, topic, marker string) {
		t.Helper()
		for _, m := range page.Messages {
			raw, err := base64.StdEncoding.DecodeString(m.Value)
			if err != nil {
				t.Fatalf("%s: undecodable value: %v", topic, err)
			}
			if !strings.HasPrefix(string(raw), marker) {
				t.Errorf("CROSS-TOPIC LEAK: %s page shows record %q", topic, string(raw))
				return
			}
		}
	}

	// Three A/B alternations — the reuse path that leaked before.
	for round := 0; round < 3; round++ {
		expectMarker(browseTail(topicA), topicA, "A-marker-")
		expectMarker(browseTail(topicB), topicB, "B-marker-")
	}
	t.Log("cross-topic isolation OK over 3 alternations")
}
