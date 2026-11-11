package kafka

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"

	"kafkaexplorer/internal/domain"
)

// shareUnsupported wraps UNSUPPORTED_VERSION failures with the two concrete
// requirements so users can act instead of decoding a Kafka error code.
func shareUnsupported(err error) error {
	if errors.Is(err, kerr.UnsupportedVersion) {
		return fmt.Errorf("此集群不支持 Share Groups（需要 Kafka 4.2+ 且 broker 开启 group.share.enable）: %w", err)
	}
	return err
}

// shareOffsetErr maps broker rejections on share offset alters/deletes to
// actionable Chinese messages; anything else passes through mapErr.
func shareOffsetErr(action string, err error) error {
	var ke *kerr.Error
	if errors.As(err, &ke) {
		switch ke {
		case kerr.NonEmptyGroup:
			return fmt.Errorf("Share 组正在被消费，无法%s（需组为 Empty）: %w", action, err)
		case kerr.UnknownTopicOrPartition:
			return fmt.Errorf("分区不存在，无法%s: %w", action, err)
		}
	}
	return mapErr(err)
}

// groupType maps the list-groups protocol type to the UI-facing group type
// (mirrors the TYPE column of kafka-groups.sh). KIP-848 consumer groups report
// protocol "consumer" just like classic ones; the reference desktop tool shows both under Consumer
// Groups, so mapping both to "classic" keeps the badge story simple.
func groupType(protocol string) string {
	switch protocol {
	case "share":
		return "share"
	case "stream":
		return "streams"
	case "connect":
		return "connect"
	case "consumer":
		return "classic"
	default:
		return protocol
	}
}

// ListShareGroups returns every share group with state, member count and the
// topic names its members subscribe to.
func (c *Client) ListShareGroups(ctx context.Context) ([]domain.ShareGroupSummary, error) {
	described, err := c.adm.DescribeShareGroups(ctx)
	if err != nil {
		return nil, shareUnsupported(mapErr(err))
	}
	out := make([]domain.ShareGroupSummary, 0, len(described))
	for _, d := range described.Sorted() {
		if d.Err != nil {
			return nil, shareUnsupported(mapErr(fmt.Errorf("describe share group %s: %w", d.GroupID, d.Err)))
		}
		sum := domain.ShareGroupSummary{
			Group:         d.GroupID,
			State:         d.GroupState,
			Members:       len(d.Members),
			CoordinatorID: d.Coordinator.NodeID,
			// Non-nil: the list row reads subscribed.length — kadm returns
			// nil for a group with no subscribed topic names.
			Subscribed: append([]string{}, d.SubscribedTopics()...),
		}
		out = append(out, sum)
	}
	return out, nil
}

// ShareGroupDetail returns members plus the per-partition share start offsets
// for one share group. LogEnd comes from the partition leaders; Lag is the
// broker-computed share lag (-1 when the broker did not provide it).
func (c *Client) ShareGroupDetail(ctx context.Context, group string) (domain.ShareGroupDetail, error) {
	described, err := c.adm.DescribeShareGroups(ctx, group)
	if err != nil {
		return domain.ShareGroupDetail{}, shareUnsupported(mapErr(err))
	}
	d, ok := described[group]
	if !ok {
		return domain.ShareGroupDetail{}, fmt.Errorf("share group %s: %w", group, domain.ErrNotFound)
	}
	if d.Err != nil {
		return domain.ShareGroupDetail{}, shareUnsupported(mapErr(fmt.Errorf("describe share group %s: %w", group, d.Err)))
	}

	detail := domain.ShareGroupDetail{
		Group:           d.GroupID,
		State:           d.GroupState,
		Assignor:        d.Assignor,
		GroupEpoch:      d.GroupEpoch,
		AssignmentEpoch: d.AssignmentEpoch,
		Members:         []domain.ShareMember{},
		Offsets:         []domain.SharePartitionOffset{},
	}
	for _, m := range d.Members {
		sm := domain.ShareMember{
			ID:          m.MemberID,
			ClientID:    m.ClientID,
			Host:        m.ClientHost,
			MemberEpoch: m.MemberEpoch,
			// Non-nil slices only: nil marshals to JSON null and the
			// frontend's .length/.map throws (white screen).
			Subscribed:  make([]string, 0, len(m.SubscribedTopicNames)),
		}
		sm.Subscribed = append(sm.Subscribed, m.SubscribedTopicNames...)
		if m.RackID != nil {
			sm.Rack = *m.RackID
		}
		sm.Assignment = make([]string, 0, len(m.Assignment))
		for t, parts := range m.Assignment {
			for p := range parts {
				sm.Assignment = append(sm.Assignment, fmt.Sprintf("%s-%d", t, p))
			}
		}
		sort.Strings(sm.Assignment)
		detail.Members = append(detail.Members, sm)
	}

	offs, err := c.adm.DescribeShareGroupOffsets(ctx, group)
	if err != nil {
		return domain.ShareGroupDetail{}, shareUnsupported(mapErr(err))
	}
	if og, ok := offs[group]; ok && og.Err != nil {
		return domain.ShareGroupDetail{}, shareUnsupported(mapErr(fmt.Errorf("describe share offsets %s: %w", group, og.Err)))
	}
	// Collect the topics we need end offsets for (leader-side LogEnd column).
	topics := make([]string, 0, 4)
	if og, ok := offs[group]; ok {
		for t := range og.Offsets {
			topics = append(topics, t)
		}
	}
	ends := kadm.ListedOffsets{}
	if len(topics) > 0 {
		if e, err := c.adm.ListEndOffsets(ctx, topics...); err == nil {
			ends = e
		}
		// End offsets are a display nicety; a lookup failure must not hide
		// the share offsets themselves, so errors above are swallowed.
	}
	if og, ok := offs[group]; ok {
		// ShareOffsets is a plain map: flatten topic→partition and sort for a
		// stable table order.
		for _, parts := range og.Offsets {
			for _, so := range parts {
				off := domain.SharePartitionOffset{
					Topic:       so.Topic,
					Partition:   so.Partition,
					StartOffset: so.StartOffset,
					Lag:         so.Lag,
				}
				if so.Err != nil {
					// Partition-level failure: keep the row, surface it via lag -1.
					off.Lag = -1
				}
				if le, ok := ends.Lookup(so.Topic, so.Partition); ok && le.Err == nil {
					off.LogEnd = le.Offset
				}
				detail.Offsets = append(detail.Offsets, off)
			}
		}
	}
	sort.Slice(detail.Offsets, func(i, j int) bool {
		if detail.Offsets[i].Topic != detail.Offsets[j].Topic {
			return detail.Offsets[i].Topic < detail.Offsets[j].Topic
		}
		return detail.Offsets[i].Partition < detail.Offsets[j].Partition
	})
	for _, o := range detail.Offsets {
		if o.Lag > 0 {
			detail.TotalLag += o.Lag
		}
	}
	return detail, nil
}

// AlterShareGroupOffset moves the share start offset of one topic-partition.
// The broker rejects the alter while the group is actively consuming.
func (c *Client) AlterShareGroupOffset(ctx context.Context, t domain.ShareGroupAlterTarget) error {
	os := kadm.Offsets{}
	os[t.Topic] = map[int32]kadm.Offset{
		t.Partition: {Topic: t.Topic, Partition: t.Partition, At: t.StartOffset},
	}
	resps, err := c.adm.AlterShareGroupOffsets(ctx, t.Group, os)
	if err != nil {
		// Group-level rejections (NON_EMPTY_GROUP etc.) come back on the
		// error return, not in the per-topic responses.
		if errors.Is(err, kerr.UnsupportedVersion) {
			return shareUnsupported(err)
		}
		return shareOffsetErr(fmt.Sprintf("修改 %s 的起始偏移", t.Topic), err)
	}
	var alterErr error
	resps.EachError(func(topic string, part int32, e error) {
		alterErr = shareOffsetErr(fmt.Sprintf("修改起始偏移 %s-%d", topic, part), e)
	})
	if alterErr != nil {
		return alterErr
	}
	return nil
}

// DeleteShareGroupOffsets clears the share start offsets for the given topics
// of one share group, forgetting the group's delivery progress on them.
func (c *Client) DeleteShareGroupOffsets(ctx context.Context, group string, topics []string) error {
	if len(topics) == 0 {
		return fmt.Errorf("%w: delete share offsets needs at least one topic", domain.ErrInvalid)
	}
	resps, err := c.adm.DeleteShareGroupOffsets(ctx, group, topics...)
	if err != nil {
		if errors.Is(err, kerr.UnsupportedVersion) {
			return shareUnsupported(err)
		}
		return shareOffsetErr(fmt.Sprintf("清除 %s 的起始偏移", group), err)
	}
	var delErr error
	resps.EachError(func(topic string, e error) {
		delErr = shareOffsetErr(fmt.Sprintf("清除 %s 的起始偏移", topic), e)
	})
	return delErr
}
