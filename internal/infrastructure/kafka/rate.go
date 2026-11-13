package kafka

import (
	"context"
	"fmt"
	"time"

	"kafkaexplorer/internal/domain"
)

// RateScanWindow describes where the Visualization scan starts.
// ByOffset=false: timestamp anchor — scan from the log start, bucket only
// records within [FromMs, now] (records older than FromMs clamp to bucket
// 0, preserving the historical full-scan behavior).
// ByOffset=true: offset anchor — per partition, scan forward FROM
// FromOffset to the log end and count only records at offset >= FromOffset;
// the bucket window is derived from the scanned records themselves.
// TopicRateHistogram builds a messages-per-time-bucket histogram for a
// topic . Kafka stores no rate history, so this
// is a bounded scan via the same paged browse path as the messages view —
// maxRecords caps huge topics.
func (c *Client) TopicRateHistogram(ctx context.Context, topic string, win domain.RateScanWindow, bucketCount int, partitionID int32) (outBuckets []domain.RateBucket, outScanned int64, outErr error) {
	if bucketCount <= 0 || bucketCount > 120 {
		outErr = fmt.Errorf("桶数必须在 1~120 之间")
		return
	}
	const maxRecords = 100_000
	const pageSize = 500

	details, err := c.adm.ListTopicsWithInternal(ctx)
	if err != nil {
		outErr = fmt.Errorf("读取主题分区失败: %w", err)
		return
	}
	td, ok := details[topic]
	if !ok || td.Err != nil || len(td.Partitions) == 0 {
		// No readable partitions: empty (non-nil) buckets, never a null
		// array across the wails boundary.
		outBuckets = make([]domain.RateBucket, bucketCount)
		return
	}

	now := time.Now().UnixMilli()

	// Offset mode: forward scan FROM FromOffset per partition; records below
	// the start offset are filtered (data-loss repositioning may land the
	// consumer earlier). The bucket window derives from the scanned records
	// (first timestamp → now), so an out-of-range offset yields an EMPTY
	// histogram instead of pretending the whole log matched.
	if win.ByOffset {
		type rec struct {
			ts, off int64
		}
		var recs []rec
		for _, pd := range td.Partitions {
			if partitionID >= 0 && pd.Partition != partitionID {
				continue
			}
			partition := pd.Partition
			// The anchor ADVANCES page by page: the first page starts at
			// FromOffset, every following page continues from the previous
			// page's NextAnchor. Re-sending the fixed FromOffset re-read the
			// same first window until the maxRecords cap (the histogram
			// counted one page's records ~200× while everything past it went
			// uncounted — see the 044 review round).
			anchor := win.FromOffset
			for {
				page, err := c.BrowsePage(ctx, domain.BrowseRequest{
					Topic:       topic,
					Partition:   &partition,
					Direction:   "forward",
					Limit:       pageSize,
					StartOffset: &anchor,
				})
				if err != nil {
					outErr = fmt.Errorf("扫描分区 %d 失败: %w", partition, err)
					return
				}
				for i := range page.Messages {
					msg := &page.Messages[i]
					if msg.Offset < win.FromOffset {
						continue // repositioned earlier than requested start
					}
					recs = append(recs, rec{ts: time.Time(msg.Timestamp).UnixMilli(), off: msg.Offset})
				}
				if page.Exhausted || page.NextAnchor == nil {
					break
				}
				if int64(len(recs)) >= maxRecords || ctx.Err() != nil {
					break
				}
				anchor = *page.NextAnchor
			}
		}
		outScanned = int64(len(recs))
		if outScanned == 0 {
			// Empty scan (offset beyond log end): a flat 1-second window ending
			// now — the x-axis stays sane instead of using an offset as
			// milliseconds (the old FromOffset%1_000_000 was exactly that).
			outBuckets = make([]domain.RateBucket, bucketCount)
			now2 := time.Now().UnixMilli()
			for i := range outBuckets {
				outBuckets[i].StartMs = now2 - 1000 + 1000*int64(i)/int64(bucketCount)
			}
			return
		}
		minTs := recs[0].ts
		maxTs := recs[len(recs)-1].ts
		if maxTs < minTs {
			maxTs = minTs
		}
		span := maxTs - minTs
		if span <= 0 {
			span = 1
		}
		buckets := make([]domain.RateBucket, bucketCount)
		bucketWidth := span / int64(bucketCount)
		if bucketWidth < 1 {
			bucketWidth = 1
		}
		for i := range buckets {
			buckets[i].StartMs = minTs + (span*int64(i))/int64(bucketCount)
		}
		for _, r := range recs {
			idx := int((r.ts - minTs) / bucketWidth)
			if idx < 0 {
				idx = 0
			}
			if idx >= bucketCount {
				idx = bucketCount - 1
			}
			buckets[idx].Count++
		}
		outBuckets = buckets
		return
	}

	// Timestamp mode (unchanged historical behavior): scan from the log
	// start, records older than win.FromMs clamp to bucket 0.
	span := now - win.FromMs
	if span <= 0 {
		span = 1
	}
	bucketWidth := span / int64(bucketCount)
	if bucketWidth < 1 {
		bucketWidth = 1
	}
	buckets := make([]domain.RateBucket, bucketCount)
	for i := range buckets {
		buckets[i].StartMs = win.FromMs + (span*int64(i))/int64(bucketCount)
	}

	var scanned int64
	for _, pd := range td.Partitions {
		if partitionID >= 0 && pd.Partition != partitionID {
			continue // user filtered to a single partition
		}
		partition := pd.Partition
		// Same anchor-advance contract as the offset mode: the first page
		// starts at the log start (no explicit anchor), every following page
		// continues from the previous page's NextAnchor — without this the
		// scan re-read page one until the record cap.
		var anchor *int64
		for {
			req := domain.BrowseRequest{
				Topic:     topic,
				Partition: &partition,
				Direction: "forward",
				Limit:     pageSize,
			}
			if anchor != nil {
				req.StartOffset = anchor
			}
			page, err := c.BrowsePage(ctx, req)
			if err != nil {
				outErr = fmt.Errorf("扫描分区 %d 失败: %w", partition, err)
				return
			}
			for i := range page.Messages {
				msg := &page.Messages[i]
				ts := time.Time(msg.Timestamp).UnixMilli()
				idx := int((ts - win.FromMs) / bucketWidth)
				if idx < 0 {
					idx = 0
				}
				if idx >= bucketCount {
					idx = bucketCount - 1
				}
				buckets[idx].Count++
				scanned++
			}
			if page.Exhausted || page.NextAnchor == nil {
				break
			}
			if scanned >= maxRecords || ctx.Err() != nil {
				outBuckets, outScanned = buckets, scanned
				return
			}
			anchor = page.NextAnchor
		}
	}
	outBuckets, outScanned = buckets, scanned
	return
}
