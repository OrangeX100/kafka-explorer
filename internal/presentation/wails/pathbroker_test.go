package wails

// Contract tests for the pick-path broker (045 round-4 review: the
// bootstrap comment referenced a contract test that did not exist — this
// file IS that contract, at the mechanism level; the bootstrap wiring
// itself stays visually verified because constructing a wails app in a
// unit test is not practical).

import (
	"fmt"
	"testing"
	"time"
)

func TestPathBrokerIssueAndAuthorize(t *testing.T) {
	b := newPathBroker()
	if b.Authorized("") {
		t.Fatal("empty path must never authorize")
	}
	if b.Authorized("C:\\never\\issued.txt") {
		t.Fatal("unissued path must not authorize")
	}
	b.Issue(`C:\Users\u\ picked.json`)
	if !b.Authorized(`C:\Users\u\ picked.json`) {
		t.Fatal("issued path must authorize")
	}
}

func TestPathBrokerCleanNormalization(t *testing.T) {
	b := newPathBroker()
	b.Issue(`C:\data\schema.json`)
	// Clean-equivalent spellings resolve to the same key.
	if !b.Authorized(`C:\data\.\schema.json`) {
		t.Fatal("dot-segment spelling of an issued path should normalize to the same key")
	}
}

func TestPathBrokerTTLExpiry(t *testing.T) {
	b := newPathBroker()
	b.maxLife = 30 * time.Millisecond
	b.Issue(`C:\x\f.json`)
	time.Sleep(60 * time.Millisecond)
	if b.Authorized(`C:\x\f.json`) {
		t.Fatal("expired path must not authorize")
	}
}

func TestPathBrokerFIFOEvictionMovesReissue(t *testing.T) {
	b := newPathBroker()
	b.maxLife = time.Hour
	// Fill to capacity: A first, then pathBrokerMax-1 more (order full).
	b.Issue("A")
	for i := 1; i < pathBrokerMax; i++ {
		b.Issue(fmt.Sprintf("P%02d", i))
	}
	// Re-issue A (refresh): it must MOVE to the back of the eviction order —
	// the old code kept A's stale front slot, so the next overflow evicted
	// the just-refreshed A (round-4 regression find).
	b.Issue("A")
	// One more issue overflows the cap: evicts order[0] — now "P01", NOT "A".
	b.Issue("OVERFLOW")
	if !b.Authorized("A") {
		t.Fatal("REGRESSION: re-issued A did not move to the back of the eviction order")
	}
	if !b.Authorized("OVERFLOW") {
		t.Fatal("newest entry must be authorized")
	}
	if b.Authorized("P01") {
		t.Fatal("oldest entry should have been evicted by the overflow")
	}
}

func TestPathBrokerExpiredSlotNotEvictingFresh(t *testing.T) {
	// MUST reach the eviction overflow (round-4 review: the previous version
	// of this test issued only 6 entries — far below pathBrokerMax — so the
	// ghost-slot bug it claims to pin was never exercised).
	b := newPathBroker()
	b.maxLife = time.Hour
	b.Issue("OLD")
	for i := 1; i < pathBrokerMax; i++ {
		b.Issue(fmt.Sprintf("F%02d", i))
	}
	// Age out everything, then re-fill past the cap: GC on the next Issue
	// must drop expired entries AND their order slots coherently.
	time.Sleep(60 * time.Millisecond)
	b.Issue("NEW")
	for i := 1; i < pathBrokerMax; i++ {
		b.Issue(fmt.Sprintf("N%02d", i))
	}
	// Overflow: the OLDEST fresh entry goes; NEW and the survivors stay.
	for _, p := range []string{"NEW", "N01", "N02"} {
		if !b.Authorized(p) {
			t.Fatalf("REGRESSION: %v wrongly evicted by ghost slots", p)
		}
	}
	if b.Authorized("OLD") {
		t.Fatal("expired entry must stay dead")
	}
}

func TestPathBrokerEvictionCap(t *testing.T) {
	b := newPathBroker()
	b.maxLife = time.Hour
	for i := 0; i < pathBrokerMax+3; i++ {
		b.Issue(string(rune('a'+i)) + ".txt")
	}
	count := 0
	b.mu.Lock()
	count = len(b.issued)
	b.mu.Unlock()
	if count != pathBrokerMax {
		t.Fatalf("issued map size %d exceeds cap %d", count, pathBrokerMax)
	}
}
