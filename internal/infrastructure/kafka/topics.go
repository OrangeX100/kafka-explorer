package kafka

import (
	"sort"
	"context"
	"fmt"
	"sync"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kmsg"

	"kafkaexplorer/internal/domain"
)

// ListTopics returns all topics with message counts (one metadata + one
// offsets round-trip). The count is log end MINUS log start: deleted or
// expired records lower the start offset, so a watermark-only sum would
// report messages that no longer exist.
func (c *Client) ListTopics(ctx context.Context) ([]domain.TopicSummary, error) {
	details, err := c.adm.ListTopicsWithInternal(ctx)
	if err != nil {
		return nil, mapErr(err)
	}
	// Fetch offsets per explicit topic name: kadm's zero-topic offsets call
	// rides cached broker metadata, which omits internal topics — their rows
	// would all report "0 msg" even with hundreds of committed offsets.
	names := make([]string, 0, len(details))
	for _, td := range details {
		if td.Err == nil && len(td.Partitions) > 0 {
			names = append(names, td.Topic)
		}
	}
	ends, err := c.adm.ListEndOffsets(ctx, names...)
	if err != nil {
		return nil, mapErr(err)
	}
	starts, err := c.adm.ListStartOffsets(ctx, names...)
	if err != nil {
		return nil, mapErr(err)
	}

	out := make([]domain.TopicSummary, 0, len(details))
	for _, td := range details.Sorted() {
		// A just-deleted topic lingers in broker metadata for a while, either
		// with UNKNOWN_TOPIC_OR_PARTITION or as a bare name with zero
		// partitions (a real topic can never have 0 partitions). Skip both —
		// listing a ghost "0P · RF0" row is worse than a momentary stale list.
		if td.Err != nil || len(td.Partitions) == 0 {
			continue
		}
		sum := domain.TopicSummary{
			Name:       td.Topic,
			Partitions: int32(len(td.Partitions)), //nolint:gosec // partition counts are small
			// Protected semantics: the broker's IsInternal flag alone misses
			// ecosystem topics (_schemas etc.) created as normal topics.
			Internal: td.IsInternal || domain.IsProtectedTopic(td.Topic),
		}
		// Replication factor = replicas of any partition (P0 by construction).
		for _, pd := range td.Partitions {
			sum.ReplicationFactor = int16(len(pd.Replicas)) //nolint:gosec // bounded by cluster size
			break
		}
		// Sum (end - start) across the topic's partitions.
		for _, lo := range ends[td.Topic] {
			if lo.Err != nil {
				continue // end-offset failed for one partition; count the rest
			}
			n := lo.Offset
			if so, ok := starts.Lookup(td.Topic, lo.Partition); ok && so.Err == nil && so.Offset <= n {
				n -= so.Offset
			}
			sum.MessageCount += n
		}
		out = append(out, sum)
	}
	return out, nil
}

// TopicDetail returns per-partition layout plus effective topic config.
// The four underlying calls are independent — they run concurrently, which
// cuts topic-open latency from 4 serial round-trips to ~1. A config failure
// degrades to an empty config list; the other three are fatal.
func (c *Client) TopicDetail(ctx context.Context, topic string) (domain.TopicDetail, error) {
	var (
		wg                    sync.WaitGroup
		details               kadm.TopicDetails
		ends, starts          kadm.ListedOffsets
		rawConfigs            *kmsg.DescribeConfigsResponse
		errMeta, errEnd       error
		errStart, errConf     error
	)
	// Configs go through raw kmsg: kadm.Config drops ReadOnly/IsDefault/
	// Documentation, which the config panel needs (read-only marking was
	// wrongly derived from ConfigSource before — default != read-only).
	wg.Add(4)
	go func() { defer wg.Done(); details, errMeta = c.adm.ListTopics(ctx, topic) }()
	go func() { defer wg.Done(); ends, errEnd = c.adm.ListEndOffsets(ctx, topic) }()
	go func() { defer wg.Done(); starts, errStart = c.adm.ListStartOffsets(ctx, topic) }()
	go func() {
		defer wg.Done()
		req := kmsg.NewPtrDescribeConfigsRequest()
		req.IncludeSynonyms = true      // for the default-value display in the edit dialog
		req.IncludeDocumentation = true // English-mode description fallback
		req.Resources = []kmsg.DescribeConfigsRequestResource{
			{ResourceType: kmsg.ConfigResourceTypeTopic, ResourceName: topic},
		}
		rawConfigs, errConf = req.RequestWith(ctx, c.kgo)
	}()
	wg.Wait()

	if errMeta != nil {
		return domain.TopicDetail{}, mapErr(errMeta)
	}
	if errEnd != nil {
		return domain.TopicDetail{}, mapErr(errEnd)
	}
	if errStart != nil {
		return domain.TopicDetail{}, mapErr(errStart)
	}

	td, ok := details[topic]
	if !ok {
		return domain.TopicDetail{}, fmt.Errorf("topic %s: %w", topic, domain.ErrNotFound)
	}

	detail := domain.TopicDetail{
		TopicSummary: domain.TopicSummary{
			Name:       td.Topic,
			Partitions: int32(len(td.Partitions)), //nolint:gosec // partition counts are small
			// Same protected semantics as ListTopics.
			Internal: td.IsInternal || domain.IsProtectedTopic(td.Topic),
		},
		PartitionList: make([]domain.PartitionSummary, 0, len(td.Partitions)),
		// Non-nil even when DescribeConfigs fails (config pane renders an
		// empty table instead of crashing on [...null]).
		Config: []domain.ConfigEntry{},
	}
	for p, pd := range td.Partitions {
		if pd.Err != nil {
			continue
		}
			ps := domain.PartitionSummary{
				ID:     p,
				Leader: pd.Leader,
				// Defensive copies: nil replicas/ISR from metadata would
				// marshal as JSON null and the tables index into them.
				// []int32{} (not nil-append) keeps the empty case non-nil.
				Replicas: append([]int32{}, pd.Replicas...),
				ISR:      append([]int32{}, pd.ISR...),
			}
		if lo, ok := ends.Lookup(topic, p); ok && lo.Err == nil {
			ps.LogEnd = lo.Offset
			ps.MessageCount = lo.Offset
		}
		if lo, ok := starts.Lookup(topic, p); ok && lo.Err == nil {
			ps.LogStart = lo.Offset
			ps.MessageCount = ps.LogEnd - ps.LogStart
		}
		detail.PartitionList = append(detail.PartitionList, ps)
		if len(pd.Replicas) > 0 {
			detail.ReplicationFactor = int16(len(pd.Replicas)) //nolint:gosec // bounded by cluster size
		}
	}
	// Map iteration order is random; the partition picker reads this list in
	// order, so sort by ID or the dropdown shuffles between reloads.
	sort.Slice(detail.PartitionList, func(i, j int) bool {
		return detail.PartitionList[i].ID < detail.PartitionList[j].ID
	})

	if errConf == nil {
		for _, rc := range rawConfigs.Resources {
			if rc.ErrorCode != 0 {
				continue // config list degrades to empty; layout still renders
			}
			for _, cfg := range rc.Configs {
				value := ""
				if cfg.Value != nil {
					value = *cfg.Value
				}
				doc := ""
				if cfg.Documentation != nil {
					doc = *cfg.Documentation
				}
				// Default value from the synonyms: the DEFAULT_CONFIG entry
				// is what a revert restores; non-overridden configs are
				// their own default. Synonyms require IncludeSynonyms on
				// the describe request.
				defaultValue := value
				if cfg.Source == kmsg.ConfigSourceDynamicTopicConfig {
					for _, syn := range cfg.ConfigSynonyms {
						if syn.Source == kmsg.ConfigSourceDefaultConfig && syn.Value != nil {
							defaultValue = *syn.Value
							break
						}
					}
				}
				detail.Config = append(detail.Config, domain.ConfigEntry{
					Name:      cfg.Name,
					Value:     value,
					// The broker's own flag. Previously this was derived from
					// ConfigSource, which marked every default-valued config
					// read-only (default != immutable).
					ReadOnly:  cfg.ReadOnly,
					// The raw IsDefault flag can stay false after an
					// override is deleted (kmsg: "replaced in favor of
					// Source"); Source is authoritative for "is this
					// topic-level override still in effect".
					Default:   cfg.Source != kmsg.ConfigSourceDynamicTopicConfig,
					Sensitive: cfg.IsSensitive,
					Doc:       doc,

					DefaultValue: defaultValue,
				})
			}
		}
	}
	return detail, nil
}

// CreateTopic creates a topic; configs may be nil.
func (c *Client) CreateTopic(ctx context.Context, name string, partitions int32, replicationFactor int16, configs map[string]*string) error {
	resp, err := c.adm.CreateTopic(ctx, partitions, replicationFactor, configs, name)
	if err != nil {
		return mapErr(err)
	}
	if resp.Err != nil {
		return mapErr(fmt.Errorf("create topic %s: %w", name, resp.Err))
	}
	return nil
}

// DeleteTopic deletes the topic. Irreversible; the UI confirms first.
func (c *Client) DeleteTopic(ctx context.Context, name string) error {
	resp, err := c.adm.DeleteTopic(ctx, name)
	if err != nil {
		return mapErr(err)
	}
	if resp.Err != nil {
		return mapErr(fmt.Errorf("delete topic %s: %w", name, resp.Err))
	}
	return nil
}

// IncreasePartitions grows a topic's partition count to target. Kafka only
// ever allows GROWING a topic (shrinkage is a wire-level rejection), so the
// live count is fetched first and a shrink attempt gets a friendly error
// before any request leaves the client. The broker chooses the replica
// assignment for the new partitions (fine-grained reassignment is out of
// scope for this path).
func (c *Client) IncreasePartitions(ctx context.Context, topic string, target int32) error {
	if target < 1 {
		return fmt.Errorf("%w: 目标分区数必须为正数，收到 %d", domain.ErrInvalid, target)
	}
	md, err := c.adm.Metadata(ctx, topic)
	if err != nil {
		return mapErr(err)
	}
	t, ok := md.Topics[topic]
	if !ok {
		return fmt.Errorf("%w: 主题 %s 不存在", domain.ErrInvalid, topic)
	}
	if t.Err != nil {
		return mapErr(fmt.Errorf("fetch topic %s: %w", topic, t.Err))
	}
	current := int32(len(t.Partitions))
	if target <= current {
		return fmt.Errorf("%w: 目标分区数 %d 必须大于当前分区数 %d（Kafka 不允许减少分区）", domain.ErrInvalid, target, current)
	}
	resps, err := c.adm.UpdatePartitions(ctx, int(target), topic)
	if err != nil {
		return mapErr(err)
	}
	for _, r := range resps {
		if r.Err != nil {
			return mapErr(fmt.Errorf("increase partitions on %s to %d: %w", topic, target, r.Err))
		}
	}
	return nil
}

// AlterTopicConfig sets topic configs; a nil value sends an explicit
// DELETE op, removing the topic-level override so the broker default
// applies again.
func (c *Client) AlterTopicConfig(ctx context.Context, topic string, entries map[string]*string) error {
	alters := make([]kadm.AlterConfig, 0, len(entries))
	for k, v := range entries {
		op := kadm.SetConfig
		if v == nil {
			op = kadm.DeleteConfig
		}
		alters = append(alters, kadm.AlterConfig{Op: op, Name: k, Value: v})
	}
	resps, err := c.adm.AlterTopicConfigs(ctx, alters, topic)
	if err != nil {
		return mapErr(err)
	}
	for _, r := range resps {
		if r.Err != nil {
			return mapErr(fmt.Errorf("alter config on %s: %w", topic, r.Err))
		}
	}
	return nil
}

// DeleteRecordsBefore truncates each partition of topic up to (excluding)
// offset. Irreversible; the UI confirms first.
func (c *Client) DeleteRecordsBefore(ctx context.Context, topic string, offset int64, partitions []int32) error {
	details, err := c.adm.ListTopics(ctx, topic)
	if err != nil {
		return mapErr(err)
	}
	td, ok := details[topic]
	if !ok {
		return fmt.Errorf("topic %s: %w", topic, domain.ErrNotFound)
	}
	selected := partitions
	if len(selected) == 0 {
		for p := range td.Partitions {
			selected = append(selected, p)
		}
	}
	offsets := kadm.Offsets{}
	for _, p := range selected {
		offsets[topic] = map[int32]kadm.Offset{}
		offsets[topic][p] = kadm.Offset{Topic: topic, Partition: p, At: offset}
	}
	resps, err := c.adm.DeleteRecords(ctx, offsets)
	if err != nil {
		return mapErr(err)
	}
	resps.Each(func(r kadm.DeleteRecordsResponse) {
		if r.Err != nil {
			err = mapErr(fmt.Errorf("delete records %s-%d: %w", r.Topic, r.Partition, r.Err))
		}
	})
	return err
}
