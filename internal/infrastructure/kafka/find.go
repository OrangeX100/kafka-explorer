package kafka

import (
	"context"
	"encoding/base64"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"

	"kafkaexplorer/internal/domain"
)

// Find scans forward from the anchor until enough matches are collected or
// MaxScan records have been examined, whichever comes first. Matching runs on
// lossy UTF-8 of raw bytes: binary messages match as text — good enough for
// the search box, exact for ordinary JSON/text topics.
func (c *Client) Find(ctx context.Context, req domain.FindRequest) (domain.BrowsePage, int, error) {
	if !req.MatchKey && !req.MatchValue {
		return domain.BrowsePage{}, 0, fmt.Errorf("%w: matchKey and matchValue are both off", domain.ErrInvalid)
	}
	var re *regexp.Regexp
	if req.Regex {
		var err error
		re, err = regexp.Compile(req.Pattern)
		if err != nil {
			return domain.BrowsePage{}, 0, fmt.Errorf("%w: bad pattern: %v", domain.ErrInvalid, err)
		}
	}
	limit := clampLimit(req.Limit)
	maxScan := req.MaxScan
	if maxScan <= 0 || maxScan > maxScanRecords {
		maxScan = 100_000
	}

	partition := int32(0) //nolint:gosec // default partition for anchor resolution
	if req.Partition != nil {
		partition = *req.Partition
	}
	req.Direction = "forward"
	anchor, err := c.resolveAnchor(ctx, req.BrowseRequest, partition, clampLimit(req.BrowseRequest.Limit))
	if err != nil {
		return domain.BrowsePage{}, 0, err
	}

	pageCtx, cancel := context.WithTimeout(ctx, findTimeout)
	defer cancel()
	pc, unlock, err := c.BrowseClientFor(req.Topic, partition, anchor)
	if err != nil {
		return domain.BrowsePage{}, 0, err
	}
	defer unlock()

	// Bound the scan by the partition's end offset. Without it a no-match
	// search keeps polling past the log end until the timeout, which reads
	// as "search is slow" — with it, the scan stops exactly at the log end.
	var endOffset int64 = -1
	if _, endsMap, berr := c.partitionBounds(ctx, req.Topic); berr == nil {
		if e, ok := endsMap[partition]; ok {
			endOffset = e
		}
	}

	page := domain.BrowsePage{}
	scanned := 0
	var last *kgo.Record
	for scanned < maxScan && len(page.Messages) < limit {
		fetches := pc.PollRecords(pageCtx, 2000)
		n := fetches.NumRecords()
		if n == 0 {
			page.Exhausted = true
			break
		}
		for _, r := range fetches.Records() {
			scanned++
			last = r
			if matches(r, req, re) {
				page.Messages = append(page.Messages, toMessage(r))
				if len(page.Messages) >= limit {
					break
				}
			}
		}
		if endOffset >= 0 && last != nil && last.Offset+1 >= endOffset {
			page.Exhausted = true
			break
		}
	}
	if last != nil && !page.Exhausted && len(page.Messages) < limit && scanned < maxScan {
		// more data ahead; continue from here next round
		next := last.Offset + 1
		page.NextAnchor = &next
	}
	return page, scanned, nil
}

func matches(r *kgo.Record, req domain.FindRequest, re *regexp.Regexp) bool {
	if req.MatchKey && len(r.Key) > 0 {
		s := toText(r.Key)
		if match(s, req.Pattern, re) {
			return true
		}
	}
	if req.MatchValue && len(r.Value) > 0 {
		s := toText(r.Value)
		return match(s, req.Pattern, re)
	}
	return false
}

func toText(b []byte) string {
	return strings.ToValidUTF8(string(b), "\uFFFD")
}

func match(s, pattern string, re *regexp.Regexp) bool {
	if re != nil {
		return re.MatchString(s)
	}
	return strings.Contains(s, pattern)
}

const findTimeout = 15 * time.Second

// maxScanRecords caps the caller-supplied scan budget.
const maxScanRecords = 1_000_000

// ProduceResult reports delivery of one record.
type ProduceResult struct {
	Partition int32 `json:"partition"`
	Offset    int64 `json:"offset"`
}

// Produce sends one record synchronously (ack from broker before returning).
// The protected-topic guard lives HERE, at the only write chokepoint, not
// just in the service layer: the data generator and JSONL import call
// Produce directly and would otherwise bypass the UI-facing check.
func (c *Client) Produce(ctx context.Context, topic string, partition *int32, key, value []byte, headers []domain.MessageHeader) (ProduceResult, error) {
	switch tier := domain.ProtectedTopicTierOf(topic); tier {
	case domain.TopicTierKafka:
		return ProduceResult{}, fmt.Errorf("「%s」是 Kafka 系统保留主题，其内容由集群自身写入，已阻止发送消息", topic)
	case domain.TopicTierEcosystem:
		return ProduceResult{}, fmt.Errorf("「%s」由外部服务托管（如 Schema Registry / Kafka Connect），其内容由该服务自身写入，已阻止发送消息", topic)
	}
	// Partition -1 = "auto" for the manual-aware partitioner; an explicit
	// choice (>= 0) is honored by it instead of being re-computed.
	rec := &kgo.Record{Topic: topic, Key: key, Value: value, Partition: -1}
	if partition != nil {
		rec.Partition = *partition
	}
	for _, h := range headers {
		raw, err := base64.StdEncoding.DecodeString(h.Value)
		if err != nil {
			return ProduceResult{}, fmt.Errorf("%w: header %s is not base64", domain.ErrInvalid, h.Key)
		}
		rec.Headers = append(rec.Headers, kgo.RecordHeader{Key: h.Key, Value: raw})
	}
	ctx, cancel := context.WithTimeout(ctx, produceTimeout)
	defer cancel()
	if err := c.kgo.ProduceSync(ctx, rec).FirstErr(); err != nil {
		return ProduceResult{}, mapErr(fmt.Errorf("produce %s: %w", topic, err))
	}
	return ProduceResult{Partition: rec.Partition, Offset: rec.Offset}, nil
}

const produceTimeout = 10 * time.Second
