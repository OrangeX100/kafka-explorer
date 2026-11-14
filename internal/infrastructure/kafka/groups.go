package kafka

import (
	"context"
	"fmt"
	"sort"

	"github.com/twmb/franz-go/pkg/kadm"

	"kafkaexplorer/internal/domain"
)

// ListGroups returns every consumer group with state and total lag.
func (c *Client) ListGroups(ctx context.Context) ([]domain.ConsumerGroupSummary, error) {
	listed, err := c.adm.ListGroups(ctx)
	if err != nil {
		return nil, mapErr(err)
	}
	// Share groups live on their own page (Lag/OffsetFetch does not apply to
	// them), so the consumer list excludes them.
	names := make([]string, 0, len(listed))
	for g, l := range listed {
		if l.ProtocolType == "share" {
			continue
		}
		names = append(names, g)
	}
	sort.Strings(names)
	if len(names) == 0 {
		return []domain.ConsumerGroupSummary{}, nil
	}

	lags, err := c.adm.Lag(ctx, names...)
	if err != nil {
		return nil, mapErr(err)
	}
	out := make([]domain.ConsumerGroupSummary, 0, len(names))
	for _, lag := range lags.Sorted() {
		sum := domain.ConsumerGroupSummary{
			Group:    lag.Group,
			State:    lag.State,
			Members:  len(lag.Members), //nolint:gosec // member counts are small
			Protocol: lag.ProtocolType,
			TotalLag: totalLag(lag.Lag),
			Type:     groupType(lag.ProtocolType),
		}
		out = append(out, sum)
	}
	return out, nil
}

// GroupDetail returns offsets, lag and member assignment for one group,
// optionally scoped to a single topic.
func (c *Client) GroupDetail(ctx context.Context, group, topic string) (domain.ConsumerGroupDetail, error) {
	described, err := c.adm.DescribeGroups(ctx, group)
	if err != nil {
		return domain.ConsumerGroupDetail{}, mapErr(err)
	}
	desc, ok := described[group]
	if !ok {
		return domain.ConsumerGroupDetail{}, fmt.Errorf("group %s: %w", group, domain.ErrNotFound)
	}
	if desc.Err != nil {
		return domain.ConsumerGroupDetail{}, mapErr(fmt.Errorf("describe group %s: %w", group, desc.Err))
	}

	detail := domain.ConsumerGroupDetail{
		Group:   group,
		State:   desc.State,
		Members: []domain.GroupMember{},
		Offsets: []domain.GroupPartitionOffset{},
	}
	for _, m := range desc.Members {
		gm := domain.GroupMember{
			ID:       m.MemberID,
			ClientID: m.ClientID,
			Host:     m.ClientHost,
			// Always non-nil: a nil slice marshals to JSON null and the
			// frontend's assignment.length throws (white screen). Share-group
			// members (KIP-932) carry a non-consumer assignment that fails
			// AsConsumer — exactly the row users click in 消费者组.
			Assignment: []string{},
		}
		if cons, ok := m.Assigned.AsConsumer(); ok {
			for _, t := range cons.Topics {
				for _, p := range t.Partitions {
					gm.Assignment = append(gm.Assignment, fmt.Sprintf("%s-%d", t.Topic, p))
				}
			}
			sort.Strings(gm.Assignment)
		}
		detail.Members = append(detail.Members, gm)
	}
	// One lag call gives committed + log end + per-partition lag in a
	// single shot (it issues OffsetFetch + ListOffsets internally).
	lags, err := c.adm.Lag(ctx, group)
	if err != nil {
		return domain.ConsumerGroupDetail{}, mapErr(err)
	}
	if lag, ok := lags[group]; ok {
		for t, parts := range lag.Lag {
			if topic != "" && t != topic {
				continue
			}
			for p, l := range parts {
				committed := l.Commit.At
				if l.Err != nil && l.Commit.At == 0 {
					// No committed offset yet (Err set): surface as -1.
					committed = -1
				}
				lagVal := l.Lag
				if lagVal < 0 {
					lagVal = 0 // -1 means "commit or end-offset errored"; show 0 in totals
				}
				detail.Offsets = append(detail.Offsets, domain.GroupPartitionOffset{
					Topic:     t,
					Partition: p,
					Committed: committed,
					LogEnd:    l.End.Offset,
					Lag:       lagVal,
				})
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
		detail.TotalLag += o.Lag
	}
	return detail, nil
}

// ResetOffset plans (DryRun) or applies (classic groups) an offset reset.
// Applying commits via kadm.CommitOffsets — the admin offset-alter path that
// also works while the group has no members.
func (c *Client) ResetOffset(ctx context.Context, t domain.OffsetResetTarget) ([]domain.OffsetResetPlan, error) {
	if t.Mode != "earliest" && t.Mode != "latest" && t.Mode != "absolute" && t.Mode != "timestamp" {
		return nil, fmt.Errorf("%w: unknown reset mode %q", domain.ErrInvalid, t.Mode)
	}
	if t.Mode == "absolute" && t.Absolute == nil {
		return nil, fmt.Errorf("%w: absolute mode needs an offset", domain.ErrInvalid)
	}
	if t.Mode == "timestamp" && t.Timestamp == nil {
		return nil, fmt.Errorf("%w: timestamp mode needs a timestamp", domain.ErrInvalid)
	}

	// Resolve target offsets per partition.
	var targets kadm.ListedOffsets
	var err error
	switch t.Mode {
	case "earliest":
		targets, err = c.adm.ListStartOffsets(ctx, t.Topic)
	case "latest":
		targets, err = c.adm.ListEndOffsets(ctx, t.Topic)
	case "timestamp":
		targets, err = c.adm.ListOffsetsAfterMilli(ctx, *t.Timestamp, t.Topic)
	case "absolute":
		// The offsets themselves come from t.Absolute below; this fetch only
		// enumerates the topic's partitions (each Lookup must succeed).
		targets, err = c.adm.ListEndOffsets(ctx, t.Topic)
	}
	if err != nil {
		return nil, mapErr(err)
	}
	ends, err := c.adm.ListEndOffsets(ctx, t.Topic)
	if err != nil {
		return nil, mapErr(err)
	}
	committed, err := c.adm.FetchOffsets(ctx, t.Group)
	if err != nil {
		return nil, mapErr(err)
	}

	partitions := t.Partitions
	if len(partitions) == 0 {
		for p := range targets[t.Topic] {
			partitions = append(partitions, p)
		}
	}
	sort.Slice(partitions, func(i, j int) bool { return partitions[i] < partitions[j] })

	plan := make([]domain.OffsetResetPlan, 0, len(partitions))
	// ONE inner map for the whole loop: rebuilding it per partition (the old
	// `os[t.Topic] = map…{}` inside the loop) submitted ONLY the last
	// partition to CommitOffsets — the broker reset one partition while the
	// plan reported every partition reset.
	os := kadm.Offsets{t.Topic: map[int32]kadm.Offset{}}
	for _, p := range partitions {
		target, ok := targets.Lookup(t.Topic, p)
		if !ok || target.Err != nil {
			return plan, fmt.Errorf("resolve target offset for %s-%d: %w", t.Topic, p, domain.ErrNotFound)
		}
		if t.Mode == "absolute" {
			target.Offset = *t.Absolute
		}
		var current int64 = -1
		if c0, ok := committed.Lookup(t.Topic, p); ok && c0.Err == nil {
			current = c0.At
		}
		var logEnd int64
		if lo, ok := ends.Lookup(t.Topic, p); ok && lo.Err == nil {
			logEnd = lo.Offset
		}
		plan = append(plan, domain.OffsetResetPlan{
			Partition: p,
			Committed: current,
			NewOffset: target.Offset,
			LogEnd:    logEnd,
		})
		os[t.Topic][p] = kadm.Offset{Topic: t.Topic, Partition: p, At: target.Offset}
	}

	if t.DryRun {
		return plan, nil
	}
	resps, err := c.adm.CommitOffsets(ctx, t.Group, os)
	if err != nil {
		return nil, mapErr(err)
	}
	for t0, ps := range resps {
		for p0, r := range ps {
			if r.Err != nil {
				return plan, mapErr(fmt.Errorf("commit %s-%d: %w", t0, p0, r.Err))
			}
		}
	}
	return plan, nil
}

func totalLag(lag kadm.GroupLag) int64 {
	var sum int64
	for _, parts := range lag {
		for _, l := range parts {
			if l.Lag > 0 {
				sum += l.Lag
			}
		}
	}
	return sum
}
