//go:build integration

package it

import (
	"context"
	"testing"
	"time"

	"kafkaexplorer/internal/domain"
	"kafkaexplorer/internal/infrastructure/kafka"
)

// TestOffsetScanSemantics: ByOffset scan starts AT FromOffset — an offset
// beyond the log end yields ZERO records (the old behavior misused the
// offset as a timestamp and returned the whole log).
func TestOffsetScanSemantics(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	client, err := kafka.Open(ctx, newConn(t), "")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer client.Close()
	partition := int32(0)
	topic := "sr-probe-value" // 60 records, offsets 0..59

	// offset 99999 beyond the log end → empty result, scanned=0
	win := domain.RateScanWindow{FromOffset: 99999, ByOffset: true}
	buckets, scanned, err := client.TopicRateHistogram(ctx, topic, win, 60, partition)
	if err != nil {
		t.Fatalf("offset 99999: %v", err)
	}
	if scanned != 0 {
		t.Fatalf("offset 99999: scanned=%d, want 0 (beyond log end)", scanned)
	}
	for _, b := range buckets {
		if b.Count != 0 {
			t.Fatalf("offset 99999: non-empty bucket %+v", b)
		}
	}

	// offset 0 → full log scanned (60 records)
	win = domain.RateScanWindow{FromOffset: 0, ByOffset: true}
	buckets, scanned, err = client.TopicRateHistogram(ctx, topic, win, 60, partition)
	if err != nil {
		t.Fatalf("offset 0: %v", err)
	}
	if scanned != 60 {
		t.Fatalf("offset 0: scanned=%d, want 60", scanned)
	}
	nonEmpty := 0
	total := int64(0)
	for _, b := range buckets {
		nonEmpty++
		total += b.Count
	}
	if total != 60 {
		t.Fatalf("offset 0: bucket total=%d, want 60", total)
	}
	t.Logf("OK: offset 0 scanned %d, offset 99999 scanned 0", scanned)
}
