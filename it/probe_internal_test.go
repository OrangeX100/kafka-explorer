//go:build integration

package it

import (
	"context"
	"testing"
	"time"

	"kafkaexplorer/internal/infrastructure/kafka"
)

func TestInternalTopicCounts(t *testing.T) {
	conn := newConn(t)
	pool := kafka.NewPool(nopRepo{conn}, nopSecrets{})
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	client, err := kafka.Open(ctx, conn, "", nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer client.Close()
	_ = pool
	topics, err := client.ListTopics(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for _, tp := range topics {
		if tp.Name == "__consumer_offsets" || tp.Name == "__share_group_state" {
			t.Logf("internal topic %s: messageCount=%d partitions=%d", tp.Name, tp.MessageCount, tp.Partitions)
			if tp.MessageCount == 0 {
				t.Errorf("internal topic %s messageCount = 0, want > 0", tp.Name)
			}
		}
	}
}
