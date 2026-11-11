package application

import (
	"context"
	"fmt"

	"kafkaexplorer/internal/domain"
	"kafkaexplorer/internal/infrastructure/kafka"
)

// TopicService lists and manages topics on a connected cluster.
type TopicService struct {
	pool *kafka.Pool
}

func NewTopicService(pool *kafka.Pool) *TopicService { return &TopicService{pool: pool} }

func (s *TopicService) List(ctx context.Context, connectionID string) ([]domain.TopicSummary, error) {
	client, err := s.pool.Acquire(ctx, connectionID)
	if err != nil {
		return nil, err
	}
	return client.ListTopics(ctx)
}

func (s *TopicService) Detail(ctx context.Context, connectionID, topic string) (domain.TopicDetail, error) {
	client, err := s.pool.Acquire(ctx, connectionID)
	if err != nil {
		return domain.TopicDetail{}, err
	}
	return client.TopicDetail(ctx, topic)
}

// CreateTopicInput is the create form payload.
type CreateTopicInput struct {
	ConnectionID      string             `json:"connectionId"`
	Name              string             `json:"name"`
	Partitions        int32              `json:"partitions"`
	ReplicationFactor int16              `json:"replicationFactor"`
	Configs           map[string]*string `json:"configs,omitempty"`
}

func (s *TopicService) Create(ctx context.Context, in CreateTopicInput) error {
	if in.Name == "" {
		return fmt.Errorf("%w: topic name is required", domain.ErrInvalid)
	}
	if in.Partitions < 1 {
		return fmt.Errorf("%w: partitions must be >= 1", domain.ErrInvalid)
	}
	if in.ReplicationFactor < 1 {
		return fmt.Errorf("%w: replication factor must be >= 1", domain.ErrInvalid)
	}
	client, err := s.pool.Acquire(ctx, in.ConnectionID)
	if err != nil {
		return err
	}
	return client.CreateTopic(ctx, in.Name, in.Partitions, in.ReplicationFactor, in.Configs)
}

func (s *TopicService) Delete(ctx context.Context, connectionID, topic string) error {
	// Server-side echo of the UI guard: the presentation layer blocks the
	// button, this refuses the call itself (scripted/API callers included).
	// Checked before Acquire so a bad name costs no pool round-trip.
	switch tier := domain.ProtectedTopicTierOf(topic); tier {
	case domain.TopicTierKafka:
		return fmt.Errorf("「%s」是 Kafka 系统保留主题（存储消费组偏移等集群关键数据），删除会导致集群功能损坏，已阻止。如确需清理请使用 Kafka 命令行工具", topic)
	case domain.TopicTierEcosystem:
		return fmt.Errorf("「%s」由外部服务托管（如 Schema Registry / Kafka Connect），存储该服务的全部关键数据，删除会导致服务数据丢失，已阻止。如确需清理请通过该服务自身的 API 操作", topic)
	}
	client, err := s.pool.Acquire(ctx, connectionID)
	if err != nil {
		return err
	}
	return client.DeleteTopic(ctx, topic)
}

// AlterConfigInput applies incremental config changes to a topic.
type AlterConfigInput struct {
	ConnectionID string             `json:"connectionId"`
	Topic        string             `json:"topic"`
	Values       map[string]*string `json:"values"` // nil value = revert to default
}

func (s *TopicService) AlterConfig(ctx context.Context, in AlterConfigInput) error {
	if len(in.Values) == 0 {
		return fmt.Errorf("%w: no config changes supplied", domain.ErrInvalid)
	}
	// Config mutation is destructive on protected topics too (flipping
	// cleanup.policy on _schemas corrupts the registry) — same tier guard
	// as Delete/Produce/DeleteRecords.
	switch tier := domain.ProtectedTopicTierOf(in.Topic); tier {
	case domain.TopicTierKafka:
		return fmt.Errorf("「%s」是 Kafka 系统保留主题，配置由集群自身管理，已阻止修改", in.Topic)
	case domain.TopicTierEcosystem:
		return fmt.Errorf("「%s」由外部服务托管（如 Schema Registry / Kafka Connect），配置由该服务自身管理，已阻止修改", in.Topic)
	}
	client, err := s.pool.Acquire(ctx, in.ConnectionID)
	if err != nil {
		return err
	}
	return client.AlterTopicConfig(ctx, in.Topic, in.Values)
}
