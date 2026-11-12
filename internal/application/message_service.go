package application

import (
	"context"
	"encoding/base64"
	"fmt"

	"kafkaexplorer/internal/application/decode"
	"kafkaexplorer/internal/domain"
	"kafkaexplorer/internal/infrastructure/kafka"
)

// decodeAdapter bridges the fetcher signature to the decode package. It
// carries the connection id of the browse request so the fetcher can pick
// the registry bound to THAT cluster (connection-level binding).
type decodeAdapter struct {
	connID string
	f      registrySchemaFetcher
}

func (a decodeAdapter) SchemaByID(ctx context.Context, id int) (string, string, error) {
	if a.f == nil {
		return "", "", fmt.Errorf("no schema registry connection for this cluster")
	}
	return a.f(ctx, a.connID, id)
}

func base64DecodeBytes(s string) ([]byte, error) {
	if s == "" {
		return nil, nil
	}
	return base64.StdEncoding.DecodeString(s)
}

// MessageService browses, finds, produces and deletes records.
type MessageService struct {
	pool    *kafka.Pool
	decoder registrySchemaFetcher
}

// registrySchemaFetcher resolves a Confluent schema id to (schema, type)
// for one connection (the caller's connection id routes the registry).
type registrySchemaFetcher func(ctx context.Context, connectionID string, id int) (string, string, error)

// SetSchemaFetcher wires the registry lookup used by value decoding
// (nil = decoding falls back to JSON/text only).
func (s *MessageService) SetSchemaFetcher(f registrySchemaFetcher) {
	s.decoder = f
}

func NewMessageService(pool *kafka.Pool) *MessageService { return &MessageService{pool: pool} }

type BrowseResult struct {
	Page       domain.BrowsePage `json:"page"`
	NextOffset *int64            `json:"nextOffset,omitempty"`
	Exhausted  bool              `json:"exhausted"`
}

func (s *MessageService) Browse(ctx context.Context, req domain.BrowseRequest) (BrowseResult, error) {
	client, err := s.pool.Acquire(ctx, req.ConnectionID)
	if err != nil {
		return BrowseResult{}, err
	}
	page, err := client.BrowsePage(ctx, req)
	if err != nil {
		return BrowseResult{}, err
	}
	// Value decode: enrich each message with a readable rendering. A decode
	// failure is reported per-message (Error field), never fails the page.
	var fetcher registrySchemaFetcher
	if s.decoder != nil && req.Decode == "auto" {
		fetcher = s.decoder
	}
	// A nil fetcher must surface as a nil RegistryClient — wrapping it in the
	// adapter struct would panic on the first Avro-shaped value (magic byte
	// 0x00, e.g. every __consumer_offsets record) instead of degrading.
	var registry decode.RegistryClient
	if fetcher != nil {
		registry = decodeAdapter{req.ConnectionID, fetcher}
	}
	for i := range page.Messages {
		raw, decErr := base64DecodeBytes(page.Messages[i].Value)
		if decErr != nil {
			continue
		}
		result := decode.DecodeValue(ctx, raw, req.Decode, registry)
		page.Messages[i].Decoded = &result
	}
	return BrowseResult{Page: page, NextOffset: page.NextAnchor, Exhausted: page.Exhausted}, nil
}

// FindResult adds how many records the search actually examined, so the UI
// can say "scanned 42,000 records, 3 matches" instead of implying completion.
type FindResult struct {
	BrowseResult
	Scanned int `json:"scanned"`
}

func (s *MessageService) Find(ctx context.Context, req domain.FindRequest) (FindResult, error) {
	if req.Partition == nil {
		// P1: search is per-partition (cursor protocol limitation, see dev doc).
		p := int32(0) //nolint:gosec // default partition
		req.Partition = &p
	}
	client, err := s.pool.Acquire(ctx, req.ConnectionID)
	if err != nil {
		return FindResult{}, err
	}
	page, scanned, err := client.Find(ctx, req)
	if err != nil {
		return FindResult{}, err
	}
	return FindResult{BrowseResult: BrowseResult{Page: page, NextOffset: page.NextAnchor, Exhausted: page.Exhausted}, Scanned: scanned}, nil
}

// ProduceInput is the send-message form payload. Key/value arrive as base64
// strings (the frontend encodes); an empty string means empty bytes, an
// absent field means null key/value respectively.
type ProduceInput struct {
	ConnectionID string                 `json:"connectionId"`
	Topic        string                 `json:"topic"`
	Partition    *int32                 `json:"partition,omitempty"` // nil = let the client choose
	Key          *string                `json:"key,omitempty"`
	Value        *string                `json:"value,omitempty"`
	Headers      []domain.MessageHeader `json:"headers,omitempty"`
}

func (s *MessageService) Produce(ctx context.Context, in ProduceInput) (kafka.ProduceResult, error) {
	if in.Topic == "" {
		return kafka.ProduceResult{}, fmt.Errorf("%w: topic is required", domain.ErrInvalid)
	}
	// Server-side echo of the UI guard: writing into a protected topic
	// corrupts the owning service's storage (a hand-written record in
	// _schemas desyncs Schema Registry; a stray record in
	// __consumer_offsets desyncs the group coordinator).
	switch tier := domain.ProtectedTopicTierOf(in.Topic); tier {
	case domain.TopicTierKafka:
		return kafka.ProduceResult{}, fmt.Errorf("「%s」是 Kafka 系统保留主题，其内容由集群自身写入，已阻止发送消息", in.Topic)
	case domain.TopicTierEcosystem:
		return kafka.ProduceResult{}, fmt.Errorf("「%s」由外部服务托管（如 Schema Registry / Kafka Connect），其内容由该服务自身写入，已阻止发送消息", in.Topic)
	}
	client, err := s.pool.Acquire(ctx, in.ConnectionID)
	if err != nil {
		return kafka.ProduceResult{}, err
	}
	var key, value []byte
	if in.Key != nil {
		key, err = b64OrRaw(*in.Key)
		if err != nil {
			return kafka.ProduceResult{}, err
		}
	}
	if in.Value != nil {
		value, err = b64OrRaw(*in.Value)
		if err != nil {
			return kafka.ProduceResult{}, err
		}
	}
	return client.Produce(ctx, in.Topic, in.Partition, key, value, in.Headers)
}

type DeleteRecordsInput struct {
	ConnectionID string  `json:"connectionId"`
	Topic        string  `json:"topic"`
	Offset       int64   `json:"offset"`
	Partitions   []int32 `json:"partitions,omitempty"` // empty = all
}

// DeleteRecords truncates the topic up to (excluding) the offset.
// Irreversible — the presentation layer must confirm first, and the call is
// logged at info level for the decision log.
func (s *MessageService) DeleteRecords(ctx context.Context, in DeleteRecordsInput) error {
	// Server-side echo of the UI guard: truncating a protected topic
	// destroys coordinator/registry state that compaction is supposed to
	// manage — no legitimate user-level reason to do it here.
	switch tier := domain.ProtectedTopicTierOf(in.Topic); tier {
	case domain.TopicTierKafka:
		return fmt.Errorf("「%s」是 Kafka 系统保留主题，已阻止删除记录（清理策略由集群压缩机制管理）", in.Topic)
	case domain.TopicTierEcosystem:
		return fmt.Errorf("「%s」由外部服务托管（如 Schema Registry / Kafka Connect），已阻止删除记录（历史清理由该服务自身管理）", in.Topic)
	}
	client, err := s.pool.Acquire(ctx, in.ConnectionID)
	if err != nil {
		return err
	}
	return client.DeleteRecordsBefore(ctx, in.Topic, in.Offset, in.Partitions)
}

// b64OrRaw accepts base64 (contract default) and falls back to treating the
// input as raw text, so curl-style debug calls still work.
func b64OrRaw(s string) ([]byte, error) {
	if s == "" {
		return []byte{}, nil
	}
	if decoded, err := base64.StdEncoding.DecodeString(s); err == nil {
		return decoded, nil
	}
	return []byte(s), nil
}
