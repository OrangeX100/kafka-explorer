package kafka

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"

	"kafkaexplorer/internal/domain"
)

const (
	// Page fetches must finish promptly: a GUI table cannot spin forever on
	// an exhausted partition. The caller can lower this via context.
	defaultPollTimeout = 4 * time.Second

	maxPageLimit = 100_000 // server-side clamp on page size (desktop tool, own cluster)
)

// BrowsePage fetches one window of records.
//
// Pagination contract (P1): Partition must be a concrete partition for
// NextAnchor to be meaningful; partition=nil (all partitions) returns a
// single window and sets Exhausted=true. This mirrors the classic desktop tool's
// default (browse one partition, page by offset) and keeps the cursor
// protocol honest — per-partition cursors across mixed partitions are a
// P2 feature.
//
// opts are the security options for the throwaway page client; the pool
// returns them alongside its pooled client so a page uses the exact same
// security configuration without re-reading the password.
func (c *Client) BrowsePage(ctx context.Context, req domain.BrowseRequest) (domain.BrowsePage, error) {
	limit := clampLimit(req.Limit)
	if req.Partition == nil {
		return c.browseAllPartitions(ctx, req, limit)
	}
	return c.browsePartition(ctx, req, limit, *req.Partition)
}

// browsePartition repositions the shared browse client onto one partition
// and polls until the page is full, the context expires, or the partition
// ends. Reuse avoids a dial+metadata round-trip per page (measured
// 200-400ms); the client lives for the connection's lifetime.
func (c *Client) browsePartition(ctx context.Context, req domain.BrowseRequest, limit int, partition int32) (domain.BrowsePage, error) {
	anchor, err := c.resolveAnchor(ctx, req, partition, limit)
	if err != nil {
		return domain.BrowsePage{}, err
	}

	pageCtx, cancel := context.WithTimeout(ctx, defaultPollTimeout)
	defer cancel()

	// Dedicated client per topic/partition: fetch responses buffered from
	// another partition would otherwise be served as this partition's data
	// (the "click A, see B" bug). The pool holds browseMu until the page
	// is fully polled.
	pc, unlock, err := c.BrowseClientFor(req.Topic, partition, anchor)
	if err != nil {
		return domain.BrowsePage{}, err
	}
	defer unlock()

	// First-wave return: a GUI page does not need to be full. Polling until
	// the limit filled made sparse partitions wait out the whole timeout
	// ("spinner for 4s per page") — one non-empty poll ships immediately,
	// a second short poll sweeps up records already in flight.
	// Past-the-end anchors return immediately: no poll, no spinner. The
	// bounds come from resolveAnchor's (TTL-cached) round-trips.
	if ends, ok := c.cachedEnds(req.Topic); ok {
		if end, has := ends[partition]; has && anchor >= end {
			// Messages must be non-nil: null breaks the page consumers
			// (messages[0] / .length) — e.g. a jump to an offset past the
			// log end lands exactly here.
			return domain.BrowsePage{Exhausted: true, Messages: []domain.Message{}}, nil
		}
	}

	// Poll until ANY record arrives (a GUI page does not need to be full),
	// an error races the deadline, or the deadline expires. The previous
	// 300ms second-poll gave up on cold public-internet fetches and showed
	// "no messages" for partitions that had data.
	// Poll until the page is FULL, a poll round returns ZERO records (the
	// broker has nothing buffered — the log boundary or a slow broker,
	// bounded by pageCtx), or an error fires. One poll returning ANY records
	// is NOT a full page: kgo serves at most one broker fetch response per
	// round (per-partition cap FetchMaxPartitionBytes, default 1 MiB), so a
	// big-message partition yields < limit records per round — the old
	// "any records → done" loop mis-read every short round as the log end,
	// which truncated paging, rate scans AND exports (044 review round).
	var records []*kgo.Record
	var fetchErr error
	dataLoss := false
	for len(records) < limit && fetchErr == nil {
		fetches := pc.PollRecords(pageCtx, limit-len(records))
		fetched := fetches.Records()
		fetches.EachError(func(_ string, _ int32, err error) {
			// ErrDataLoss: a time-offset resolved position is older than the
			// compacted/trimmed log start — kgo already repositioned to the
			// log start; the next poll returns the surviving records. A GUI
			// page must NOT fail on this: rate scans and old-window browsing
			// both hit it. Let the loop re-poll (bounded by pageCtx).
			var dle *kgo.ErrDataLoss
			if errors.As(err, &dle) {
				dataLoss = true
				return
			}
			if fetchErr == nil {
				fetchErr = err
			}
		})
		if fetchErr != nil && pageCtx.Err() == nil && !dataLoss {
			return domain.BrowsePage{}, mapErr(fmt.Errorf("fetch %s-%d: %w", req.Topic, partition, fetchErr))
		}
		records = append(records, fetched...)
		if len(fetched) == 0 {
			// Nothing buffered this round. On a dataLoss re-poll keep
			// polling until the page deadline delivers the surviving
			// records; otherwise this round IS the boundary.
			if dataLoss && pageCtx.Err() == nil && len(records) == 0 {
				continue
			}
			break
		}
	}
	if len(records) == 0 && fetchErr == nil && dataLoss && pageCtx.Err() != nil {
		return domain.BrowsePage{Exhausted: true, Messages: []domain.Message{}}, nil
	}

	page := domain.BrowsePage{Messages: []domain.Message{}}
	forward := req.Direction != "backward"
	sort.Slice(records, func(i, j int) bool {
		if forward {
			return records[i].Offset < records[j].Offset
		}
		return records[i].Offset > records[j].Offset
	})
	for _, r := range records {
		page.Messages = append(page.Messages, toMessage(r))
	}

	// Cursor: forward continues after the last record; backward continues
	// from the resolved window start (it already points at the next,
	// older window). A short page means the log boundary was hit.
	if len(records) >= limit {
		next := anchor
		if forward {
			next = records[len(records)-1].Offset + 1
		} else {
			// A full backward window that already reaches the log end is the
			// NEWEST page — without this flag "最新" left 下一页 enabled and
			// clicking it forward-jumped past the end into an empty page
			// (the "where am I now" black hole).
			if ends, ok := c.cachedEnds(req.Topic); ok {
				// records are sorted NEWEST FIRST on backward — the window's
				// newest edge is records[0]
				if end, has := ends[partition]; has && records[0].Offset+1 >= end {
					page.Exhausted = true
					return page, nil
				}
			}
		}
		page.NextAnchor = &next
	} else {
		page.Exhausted = true
	}
	return page, nil
}

// browseAllPartitions returns one window spread across every partition,
// sorted by offset. No cursor (P1 contract above).
func (c *Client) browseAllPartitions(ctx context.Context, req domain.BrowseRequest, limit int) (domain.BrowsePage, error) {
	starts, ends, err := c.partitionBounds(ctx, req.Topic)
	if err != nil {
		return domain.BrowsePage{}, err
	}
	consume := map[string]map[int32]kgo.Offset{req.Topic: {}}
	for p := range ends {
		if starts[p] >= ends[p] {
			continue // empty partition
		}
		consume[req.Topic][p] = kgo.NewOffset().At(starts[p])
	}
	if len(consume[req.Topic]) == 0 {
		return domain.BrowsePage{Exhausted: true, Messages: []domain.Message{}}, nil
	}

	pageCtx, cancel := context.WithTimeout(ctx, defaultPollTimeout)
	defer cancel()
	// All-partitions browse is a low-frequency one-shot: a throwaway client
	// avoids polluting the per-partition LRU pool.
	pageOpts := copyOpts(c.opts, kgo.ConsumePartitions(consume), kgo.DisableFetchSessions())
	pc, err := kgo.NewClient(pageOpts...)
	if err != nil {
		return domain.BrowsePage{}, mapErr(fmt.Errorf("create browse client: %w", err))
	}
	defer pc.Close()

	page := domain.BrowsePage{Exhausted: true, Messages: []domain.Message{}}
	var records []*kgo.Record
	for len(records) < limit {
		fetches := pc.PollRecords(pageCtx, limit-len(records))
		if fetches.NumRecords() == 0 {
			break
		}
		records = append(records, fetches.Records()...)
	}
	sort.SliceStable(records, func(i, j int) bool { return records[i].Offset < records[j].Offset })
	for _, r := range records {
		page.Messages = append(page.Messages, toMessage(r))
	}
	return page, nil
}

// resolveAnchor turns the BrowseRequest into a concrete start offset.
// Precedence: explicit offset > timestamp > newest/oldest by direction.
func (c *Client) resolveAnchor(ctx context.Context, req domain.BrowseRequest, partition int32, limit int) (int64, error) {
	starts, ends, err := c.partitionBounds(ctx, req.Topic)
	if err != nil {
		return 0, err
	}
	end := ends[partition]
	start := starts[partition]
	shift := int64(limit) //nolint:gosec // limit is clamped ≤ 1000

	switch {
	case req.StartOffset != nil:
		off := *req.StartOffset
		if req.Direction == "backward" {
			// Backward from off: window is [off-limit, off).
			if off-shift < start {
				return start, nil
			}
			return off - shift, nil
		}
		if off > end {
			return end, nil
		}
		if off < start {
			// The log was already trimmed past the requested anchor
			// (compaction/retention): clamp to the earliest surviving record
			// instead of sending a negative / out-of-range fetch offset —
			// symmetric with the backward branch's `off-shift < start` clamp.
			return start, nil
		}
		return off, nil
	case req.StartTimestamp != nil:
		listed, err := c.adm.ListOffsetsAfterMilli(ctx, *req.StartTimestamp, req.Topic)
		if err != nil {
			return 0, mapErr(err)
		}
		lo, ok := listed.Lookup(req.Topic, partition)
		if !ok || lo.Err != nil {
			return 0, fmt.Errorf("resolve timestamp for %s-%d: %w", req.Topic, partition, domain.ErrNotFound)
		}
		if lo.Offset < 0 {
			return end, nil // nothing at/after that timestamp
		}
		return lo.Offset, nil
	default:
		// No anchor: backward = newest window; forward = from log start.
		if req.Direction == "backward" {
			if end-shift < start {
				return start, nil
			}
			return end - shift, nil
		}
		return start, nil
	}
}

func (c *Client) partitionBounds(ctx context.Context, topic string) (starts, ends map[int32]int64, err error) {
	c.boundsMu.Lock()
	if e, ok := c.boundsCache[topic]; ok && time.Now().Before(e.expires) {
		c.boundsMu.Unlock()
		return e.starts, e.ends, nil
	}
	c.boundsMu.Unlock()

	starts, ends, err = c.fetchPartitionBounds(ctx, topic)
	if err != nil {
		return nil, nil, err
	}
	c.boundsMu.Lock()
	if c.boundsCache == nil {
		c.boundsCache = map[string]boundsEntry{}
	}
	c.boundsCache[topic] = boundsEntry{starts: starts, ends: ends, expires: time.Now().Add(5 * time.Second)}
	c.boundsMu.Unlock()
	return starts, ends, nil
}

// fetchPartitionBounds issues the two list-offset round-trips.
func (c *Client) fetchPartitionBounds(ctx context.Context, topic string) (starts, ends map[int32]int64, err error) {
	startList, err := c.adm.ListStartOffsets(ctx, topic)
	if err != nil {
		return nil, nil, mapErr(err)
	}
	endList, err := c.adm.ListEndOffsets(ctx, topic)
	if err != nil {
		return nil, nil, mapErr(err)
	}
	starts = map[int32]int64{}
	ends = map[int32]int64{}
	for p, lo := range startList[topic] {
		if lo.Err == nil {
			starts[p] = lo.Offset
		}
	}
	for p, lo := range endList[topic] {
		if lo.Err == nil {
			ends[p] = lo.Offset
		}
	}
	if len(ends) == 0 {
		return nil, nil, fmt.Errorf("topic %s: %w", topic, domain.ErrNotFound)
	}
	return starts, ends, nil
}

func toMessage(r *kgo.Record) domain.Message {
	m := domain.Message{
		Topic:     r.Topic,
		Partition: r.Partition,
		Offset:    r.Offset,
		Timestamp: domain.FlexTime(r.Timestamp),
		ValueSize: len(r.Value),
	}
	if len(r.Key) > 0 {
		m.Key = base64.StdEncoding.EncodeToString(r.Key)
	}
	if len(r.Value) > 0 {
		m.Value = base64.StdEncoding.EncodeToString(r.Value)
	}
	for _, h := range r.Headers {
		m.Headers = append(m.Headers, domain.MessageHeader{
			Key:   h.Key,
			Value: base64.StdEncoding.EncodeToString(h.Value),
		})
	}
	return m
}

func clampLimit(n int) int {
	if n <= 0 {
		return 100
	}
	if n > maxPageLimit {
		return maxPageLimit
	}
	return n
}

// copyOpts returns a fresh slice with base plus extras. Reusing the same
// backing array across NewClient calls would be racy.
// cachedEnds returns the TTL-cached log-end map when fresh, so past-the-end
// anchors can short-circuit without a poll.
func (c *Client) cachedEnds(topic string) (map[int32]int64, bool) {
	c.boundsMu.Lock()
	defer c.boundsMu.Unlock()
	e, ok := c.boundsCache[topic]
	return e.ends, ok && time.Now().Before(e.expires)
}

// partitionKeys lists the partition ids of a consume map.
func partitionKeys(m map[int32]kgo.Offset) []int32 {
	keys := make([]int32, 0, len(m))
	for p := range m {
		keys = append(keys, p)
	}
	return keys
}

func copyOpts(base []kgo.Opt, extras ...kgo.Opt) []kgo.Opt {
	out := make([]kgo.Opt, 0, len(base)+len(extras))
	out = append(out, base...)
	return append(out, extras...)
}
