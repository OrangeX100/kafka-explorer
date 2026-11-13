//go:build integration

package it

// TestKsqlPushQueryOutlives15s pins the 044-review fix: QueryStream must NOT
// ride an http.Client with a client-level Timeout — that timeout covers the
// BODY READ, so the old 15s client killed every push query (EMIT CHANGES)
// mid-stream after exactly 15 seconds. After the fix the query's lifetime is
// governed by its request context only: an idle push query must still be
// open past 15s and end cleanly when the context is cancelled.
//
// Run manually: KSQLDB_URL=http://host:8088 go test -tags=integration ./it/ -run TestKsqlPushQueryOutlives15s -v

import (
	"context"
	"os"
	"testing"
	"time"

	"kafkaexplorer/internal/infrastructure/ksqldb"
)

func TestKsqlPushQueryOutlives15s(t *testing.T) {
	url := os.Getenv("KSQLDB_URL")
	if url == "" {
		t.Skip("set KSQLDB_URL (e.g. http://host:8088) to run the ksqlDB probe")
	}

	// 16s window: the buggy client dies at exactly 15s, the fixed one rides
	// until the context cancels at 16s.
	ctx, cancel := context.WithTimeout(context.Background(), 16*time.Second)
	defer cancel()

	c := ksqldb.New(url, "", "")
	onRow := func(header []string, row []any) error { return nil }

	start := time.Now()
	err := c.QueryStream(ctx, "SELECT * FROM PAGEVIEWS EMIT CHANGES;", onRow)
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("push query errored after %v: %v", elapsed, err)
	}
	if elapsed < 15*time.Second {
		t.Fatalf("push query ended after only %v — the client-level timeout bug is back (idle stream must stay open)", elapsed)
	}
	t.Logf("OK: idle push query survived %v (ctx-cancelled cleanly)", elapsed)
}
