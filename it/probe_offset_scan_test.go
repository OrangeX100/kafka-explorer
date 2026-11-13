//go:build integration

package it

import (
	"context"
	"fmt"
	"testing"
	"time"

	"kafkaexplorer/internal/domain"
	"kafkaexplorer/internal/infrastructure/kafka"
)

// TestOffsetScanSemantics: ByOffset scan starts AT FromOffset — an offset
// beyond the log end yields ZERO records (the old behavior misused the
// offset as a timestamp and returned the whole log). Self-seeding: the
// test used to depend on avroseed having left 60 records in sr-probe-value,
// which broke (scanned=0) after that topic was cleaned up between rounds.
func TestOffsetScanSemantics(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	client, err := kafka.Open(ctx, newConn(t), "", nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer client.Close()
	partition := int32(0)
	topic := "sr-probe-value"

	if err := client.CreateTopic(ctx, topic, 1, 1, nil); err != nil {
		t.Logf("create topic (may already exist): %v", err)
	}
	// Seed 60 records; expected scan size = end - start measured AFTER
	// seeding (exact regardless of what older rounds left behind).
	stamp := time.Now().UnixMilli()
	for i := 1; i <= 60; i++ {
		value := fmt.Sprintf("offsetscan-%d-%d", stamp, i)
		if _, err := client.Produce(ctx, topic, nil, []byte("k"), []byte(value), nil); err != nil {
			t.Fatalf("produce %d: %v", i, err)
		}
	}
	detail, err := client.TopicDetail(ctx, topic)
	if err != nil {
		t.Fatalf("topic detail: %v", err)
	}
	start := detail.PartitionList[0].LogStart
	end := detail.PartitionList[0].LogEnd
	inLog := end - start

	// offset beyond the log end → empty result, scanned=0
	win := domain.RateScanWindow{FromOffset: end + 99999, ByOffset: true}
	buckets, scanned, err := client.TopicRateHistogram(ctx, topic, win, 60, partition)
	if err != nil {
		t.Fatalf("offset beyond end: %v", err)
	}
	if scanned != 0 {
		t.Fatalf("offset beyond end: scanned=%d, want 0", scanned)
	}
	for _, b := range buckets {
		if b.Count != 0 {
			t.Fatalf("offset beyond end: non-empty bucket %+v", b)
		}
	}

	// offset at the log start → the full surviving log scanned
	win = domain.RateScanWindow{FromOffset: start, ByOffset: true}
	buckets, scanned, err = client.TopicRateHistogram(ctx, topic, win, 60, partition)
	if err != nil {
		t.Fatalf("offset at start: %v", err)
	}
	if scanned != inLog {
		t.Fatalf("offset at start: scanned=%d, want %d", scanned, inLog)
	}
	total := int64(0)
	for _, b := range buckets {
		total += b.Count
	}
	if total != inLog {
		t.Fatalf("offset at start: bucket total=%d, want %d", total, inLog)
	}
	t.Logf("OK: offset at start scanned %d/%d, beyond-end scanned 0", scanned, inLog)
}

// TestRateHistogramPaging pins the 044-review pagination fix: BOTH scan
// modes must ADVANCE page by page. The old code re-sent the same anchor
// every iteration, so any partition bigger than one page (500) got its
// FIRST page counted ~200× until the 100k cap — the histogram counted
// 100,000 duplicate records while everything past offset 500 went
// uncounted. The 60-record topic above could never catch it.
func TestRateHistogramPaging(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()

	client, err := kafka.Open(ctx, newConn(t), "", nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer client.Close()

	const topic = "kafka-explorer-ratescan"
	if err := client.CreateTopic(ctx, topic, 1, 1, nil); err != nil {
		t.Logf("create topic (may already exist): %v", err)
	}
	partition := int32(0)

	// Expected log size = end - start, measured BEFORE and AFTER seeding.
	logBounds := func(t *testing.T) (int64, int64) {
		t.Helper()
		detail, err := client.TopicDetail(ctx, topic)
		if err != nil {
			t.Fatalf("topic detail: %v", err)
		}
		if len(detail.PartitionList) == 0 {
			t.Fatal("no partitions")
		}
		return detail.PartitionList[0].LogStart, detail.PartitionList[0].LogEnd
	}
	startBefore, endBefore := logBounds(t)

	// Seed past one page (500) so at least two pages exist.
	const seed = 1200
	stamp := time.Now().UnixMilli()
	for i := 1; i <= seed; i++ {
		value := fmt.Sprintf("ratescan-%d-%d", stamp, i)
		if _, err := client.Produce(ctx, topic, nil, []byte("k"), []byte(value), nil); err != nil {
			t.Fatalf("produce %d: %v", i, err)
		}
	}

	startAfter, endAfter := logBounds(t)
	seededCount := endAfter - endBefore
	if seededCount < seed {
		t.Fatalf("only %d of %d seeded records landed", seededCount, seed)
	}
	fullLog := endAfter - startAfter
	t.Logf("log: start=%d end=%d (seeded %d, total %d)", startAfter, endAfter, seededCount, fullLog)

	// Offset mode from the ORIGINAL pre-seed start: the scan must walk the
	// whole log — scanned == records in [startBefore, end), bucket total
	// == scanned. With the bug scanned came out 100_000 (duplicates).
	win := domain.RateScanWindow{FromOffset: startBefore, ByOffset: true}
	buckets, scanned, err := client.TopicRateHistogram(ctx, topic, win, 60, partition)
	if err != nil {
		t.Fatalf("offset-mode scan: %v", err)
	}
	offsetModeRecords := endAfter - startBefore
	if scanned != offsetModeRecords {
		t.Fatalf("offset mode scanned=%d, want %d (pagination regressed?)", scanned, offsetModeRecords)
	}
	offsetTotal := int64(0)
	for _, b := range buckets {
		offsetTotal += b.Count
	}
	if offsetTotal != offsetModeRecords {
		t.Fatalf("offset mode bucket total=%d, want %d", offsetTotal, offsetModeRecords)
	}
	t.Logf("offset mode OK: scanned=%d, buckets=%d", scanned, offsetTotal)

	// Timestamp mode from the log start (fromMs=0 = 最早): same contract.
	winTs := domain.RateScanWindow{FromMs: 0, FromOffset: 0, ByOffset: false}
	bucketsTs, scannedTs, err := client.TopicRateHistogram(ctx, topic, winTs, 60, partition)
	if err != nil {
		t.Fatalf("timestamp-mode scan: %v", err)
	}
	if scannedTs != fullLog {
		t.Fatalf("timestamp mode scanned=%d, want %d (pagination regressed?)", scannedTs, fullLog)
	}
	tsTotal := int64(0)
	for _, b := range bucketsTs {
		tsTotal += b.Count
	}
	if tsTotal != fullLog {
		t.Fatalf("timestamp mode bucket total=%d, want %d", tsTotal, fullLog)
	}
	t.Logf("timestamp mode OK: scanned=%d, buckets=%d", scannedTs, tsTotal)
}
