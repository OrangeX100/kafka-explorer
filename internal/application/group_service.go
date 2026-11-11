package application

import (
	"context"

	"kafkaexplorer/internal/domain"
	"kafkaexplorer/internal/infrastructure/kafka"
)

// ConsumerGroupService lists groups and manages offset resets.
type ConsumerGroupService struct {
	pool *kafka.Pool
}

func NewConsumerGroupService(pool *kafka.Pool) *ConsumerGroupService {
	return &ConsumerGroupService{pool: pool}
}

func (s *ConsumerGroupService) List(ctx context.Context, connectionID string) ([]domain.ConsumerGroupSummary, error) {
	client, err := s.pool.Acquire(ctx, connectionID)
	if err != nil {
		return nil, err
	}
	return client.ListGroups(ctx)
}

func (s *ConsumerGroupService) Detail(ctx context.Context, connectionID, group, topic string) (domain.ConsumerGroupDetail, error) {
	client, err := s.pool.Acquire(ctx, connectionID)
	if err != nil {
		return domain.ConsumerGroupDetail{}, err
	}
	return client.GroupDetail(ctx, group, topic)
}

// ResetResult returns the per-partition plan. With DryRun the offsets were
// NOT committed; the frontend shows the plan and re-calls with DryRun=false
// to apply. Both calls are decision-logged in the wails handler.
func (s *ConsumerGroupService) ResetOffset(ctx context.Context, t domain.OffsetResetTarget) ([]domain.OffsetResetPlan, error) {
	client, err := s.pool.Acquire(ctx, t.ConnectionID)
	if err != nil {
		return nil, err
	}
	return client.ResetOffset(ctx, t)
}

// ---- Share groups (KIP-932) ----

func (s *ConsumerGroupService) ListShareGroups(ctx context.Context, connectionID string) ([]domain.ShareGroupSummary, error) {
	client, err := s.pool.Acquire(ctx, connectionID)
	if err != nil {
		return nil, err
	}
	return client.ListShareGroups(ctx)
}

func (s *ConsumerGroupService) ShareGroupDetail(ctx context.Context, connectionID, group string) (domain.ShareGroupDetail, error) {
	client, err := s.pool.Acquire(ctx, connectionID)
	if err != nil {
		return domain.ShareGroupDetail{}, err
	}
	return client.ShareGroupDetail(ctx, group)
}

// AlterShareGroupOffset moves a share start offset. The broker rejects this
// while the group is actively consuming; that error surfaces to the UI as-is.
func (s *ConsumerGroupService) AlterShareGroupOffset(ctx context.Context, t domain.ShareGroupAlterTarget) error {
	client, err := s.pool.Acquire(ctx, t.ConnectionID)
	if err != nil {
		return err
	}
	return client.AlterShareGroupOffset(ctx, t)
}

// DeleteShareGroupOffsets clears share start offsets for the given topics,
// forgetting the group's delivery progress on them.
func (s *ConsumerGroupService) DeleteShareGroupOffsets(ctx context.Context, connectionID, group string, topics []string) error {
	client, err := s.pool.Acquire(ctx, connectionID)
	if err != nil {
		return err
	}
	return client.DeleteShareGroupOffsets(ctx, group, topics)
}
