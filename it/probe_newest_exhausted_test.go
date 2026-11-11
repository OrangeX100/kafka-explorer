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

// TestNewestPageExhausted: the newest backward page (window touching the log
// end) must carry Exhausted=true — otherwise 下一页 stays enabled and
// forward-jumps past the end into an empty page (the black hole).
func TestNewestPageExhausted(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	client, err := kafka.Open(ctx, newConn(t), "")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer client.Close()
	partition := int32(0)
	topic := "sr-probe-value"

	page, err := client.BrowsePage(ctx, domain.BrowseRequest{
		ConnectionID: probeConnID, Topic: topic, Partition: &partition,
		Direction: "backward", Limit: 10,
	})
	if err != nil {
		t.Fatalf("browse backward: %v", err)
	}
	if len(page.Messages) == 0 {
		t.Skip("topic has no records; seed first")
	}
	if len(page.Messages) < 10 {
		t.Skipf("topic has %d records (<limit 10); not a full page", len(page.Messages))
	}
	// Newest page window touches the log end: exhausted MUST be true.
	if !page.Exhausted {
		t.Fatalf("newest full page Exhausted=false (black hole); newest offset=%d", page.Messages[0].Offset)
	}
	t.Logf("OK: newest page exhausted, newest offset=%d", page.Messages[0].Offset)
	_ = fmt.Sprint
}
