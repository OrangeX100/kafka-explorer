// Package wails is the presentation adapter: thin handlers the frontend
// binds to. Business rules live in application; handlers validate ids,
// decision-log destructive operations and translate errors.
package wails

import (
	"context"

	"go.uber.org/zap"
	wailsapp "github.com/wailsapp/wails/v3/pkg/application"

	"kafkaexplorer/internal/application"
	"kafkaexplorer/internal/domain"
	"kafkaexplorer/internal/infrastructure/kafka"
)

// kafkaProduceResult is kafka.ProduceResult aliased for the handler return
// type; the underlying JSON shape is identical.
type kafkaProduceResult = kafka.ProduceResult

// ConnectionHandler exposes connection management to the UI.
type ConnectionHandler struct {
	svc  *application.ConnectionService
	log  *zap.Logger
}

func NewConnectionHandler(svc *application.ConnectionService, log *zap.Logger) *ConnectionHandler {
	return &ConnectionHandler{svc: svc, log: log}
}

func (h *ConnectionHandler) List(ctx context.Context) ([]domain.Connection, error) {
	return h.svc.List(ctx)
}

func (h *ConnectionHandler) Save(ctx context.Context, in application.SaveInput) (domain.Connection, error) {
	h.log.Info("connection save",
		zap.String("id", in.Connection.ID),
		zap.String("name", in.Connection.Name),
		zap.String("security", string(in.Connection.Security)),
		zap.Bool("passwordSet", in.Password != ""),
	)
	return h.svc.Save(ctx, in)
}

func (h *ConnectionHandler) Delete(ctx context.Context, id string) error {
	h.log.Info("connection delete", zap.String("id", id))
	return h.svc.Delete(ctx, id)
}

// Disconnect drops the pooled client (断开连接): the saved config stays and
// the next use reconnects.
func (h *ConnectionHandler) Disconnect(ctx context.Context, id string) {
	h.log.Info("connection disconnect", zap.String("id", id))
	h.svc.Disconnect(ctx, id)
}

// CloneConnection duplicates a saved connection under a new name and returns
// it; the UI opens the clone in the editor for renaming.
func (h *ConnectionHandler) CloneConnection(ctx context.Context, id, newName string) (domain.Connection, error) {
	h.log.Info("connection clone", zap.String("id", id), zap.String("newName", newName))
	return h.svc.CloneConnection(ctx, id, newName)
}

func (h *ConnectionHandler) Test(ctx context.Context, conn domain.Connection, password string) application.TestResult {
	h.log.Info("connection test",
		zap.String("name", conn.Name),
		zap.String("bootstrap", conn.Bootstrap),
		zap.Bool("passwordSet", password != ""),
	)
	return h.svc.Test(ctx, conn, password)
}

// SetPinned toggles the list-ordering pin (a view preference, not a config
// edit — no log entry needed).
func (h *ConnectionHandler) SetPinned(ctx context.Context, id string, pinned bool) error {
	return h.svc.SetPinned(ctx, id, pinned)
}

// Ping probes real broker reachability through the pooled client — drives
// the sidebar's connection dot (session-open alone would lie).
func (h *ConnectionHandler) Ping(ctx context.Context, id string) error {
	return h.svc.Ping(ctx, id)
}

// ExportConnections saves every connection (minus secrets) to a JSON file
// the user picks in a native save dialog. Returns the path, or "" on cancel.
func (h *ConnectionHandler) ExportConnections(ctx context.Context) (string, error) {
	return h.svc.ExportConnections(ctx, func(c context.Context) (string, error) {
		return promptSingleSelection(wailsapp.Get().Dialog.SaveFile().
			SetMessage("导出连接配置").
			SetFilename("kafka-explorer-connections.json").
			AddFilter("JSON", "*.json").
			PromptForSingleSelection())
	})
}

// ImportConnections reads a previously exported file; the frontend picks the
// path with the open dialog first.
func (h *ConnectionHandler) ImportConnections(ctx context.Context, path string) (application.ImportResult, error) {
	h.log.Info("connections import", zap.String("path", path))
	return h.svc.ImportConnections(ctx, path)
}

// TopicHandler exposes topic management.
type TopicHandler struct {
	svc *application.TopicService
	log *zap.Logger
}

func NewTopicHandler(svc *application.TopicService, log *zap.Logger) *TopicHandler {
	return &TopicHandler{svc: svc, log: log}
}

func (h *TopicHandler) List(ctx context.Context, connectionID string) ([]domain.TopicSummary, error) {
	return h.svc.List(ctx, connectionID)
}

func (h *TopicHandler) Detail(ctx context.Context, connectionID, topic string) (domain.TopicDetail, error) {
	return h.svc.Detail(ctx, connectionID, topic)
}

func (h *TopicHandler) Create(ctx context.Context, in application.CreateTopicInput) error {
	h.log.Info("topic create",
		zap.String("connection", in.ConnectionID),
		zap.String("topic", in.Name),
		zap.Int32("partitions", in.Partitions),
		zap.Int16("replicationFactor", in.ReplicationFactor),
	)
	return h.svc.Create(ctx, in)
}

// DeleteTopic is irreversible; decision log before acting so operators can
// prove what happened and when.
func (h *TopicHandler) DeleteTopic(ctx context.Context, connectionID, topic string) error {
	h.log.Info("topic delete", zap.String("connection", connectionID), zap.String("topic", topic))
	return h.svc.Delete(ctx, connectionID, topic)
}

// TopicRateHistogram returns the Visualization histogram (records per
// time bucket since fromMs). Bounded scan protects big topics.
func (h *TopicHandler) TopicRateHistogram(ctx context.Context, connectionId, topic string, win domain.RateScanWindow, buckets int, partitionID int32) ([]domain.RateBucket, int64, error) {
	return h.svc.TopicRateHistogram(ctx, connectionId, topic, win, buckets, partitionID)
}

func (h *TopicHandler) AlterConfig(ctx context.Context, in application.AlterConfigInput) error {
	names := make([]string, 0, len(in.Values))
	for k := range in.Values {
		names = append(names, k)
	}
	h.log.Info("topic config alter",
		zap.String("connection", in.ConnectionID),
		zap.String("topic", in.Topic),
		zap.Strings("keys", names), // values deliberately not logged (may be sensitive)
	)
	return h.svc.AlterConfig(ctx, in)
}

// MessageHandler exposes message operations.
type MessageHandler struct {
	svc *application.MessageService
	log *zap.Logger
}

func NewMessageHandler(svc *application.MessageService, log *zap.Logger) *MessageHandler {
	return &MessageHandler{svc: svc, log: log}
}

func (h *MessageHandler) Browse(ctx context.Context, req domain.BrowseRequest) (application.BrowseResult, error) {
	return h.svc.Browse(ctx, req)
}

// SetDecodeFetcher wires the Schema Registry schema-id lookup into message
// browsing (bootstrap calls this once after both services exist).
func (h *MessageHandler) SetDecodeFetcher(fetcher func(ctx context.Context, id int) (string, string, error)) {
	h.svc.SetSchemaFetcher(fetcher)
}

func (h *MessageHandler) Find(ctx context.Context, req domain.FindRequest) (application.FindResult, error) {
	return h.svc.Find(ctx, req)
}

func (h *MessageHandler) Produce(ctx context.Context, in application.ProduceInput) (kafkaProduceResult, error) {
	valueLen := 0
	if in.Value != nil {
		valueLen = len(*in.Value)
	}
	h.log.Info("message produce",
		zap.String("connection", in.ConnectionID),
		zap.String("topic", in.Topic),
		zap.Int("valueB64Chars", valueLen), // base64 length; content never logged
		zap.Int("headerCount", len(in.Headers)),
	)
	return h.svc.Produce(ctx, in)
}

// DeleteRecords is irreversible; decision log carries topic/offset/partitions.
func (h *MessageHandler) DeleteRecords(ctx context.Context, in application.DeleteRecordsInput) error {
	h.log.Info("records delete",
		zap.String("connection", in.ConnectionID),
		zap.String("topic", in.Topic),
		zap.Int64("beforeOffset", in.Offset),
		zap.Int32s("partitions", in.Partitions),
	)
	return h.svc.DeleteRecords(ctx, in)
}

// GroupHandler exposes consumer group operations.
type GroupHandler struct {
	svc *application.ConsumerGroupService
	log *zap.Logger
}

func NewGroupHandler(svc *application.ConsumerGroupService, log *zap.Logger) *GroupHandler {
	return &GroupHandler{svc: svc, log: log}
}

func (h *GroupHandler) List(ctx context.Context, connectionID string) ([]domain.ConsumerGroupSummary, error) {
	return h.svc.List(ctx, connectionID)
}

func (h *GroupHandler) Detail(ctx context.Context, connectionID, group, topic string) (domain.ConsumerGroupDetail, error) {
	return h.svc.Detail(ctx, connectionID, group, topic)
}

// ResetOffset decision-logs the plan AND the applied commit (dryRun flag),
// giving operators the full before/after trail.
func (h *GroupHandler) ResetOffset(ctx context.Context, t domain.OffsetResetTarget) ([]domain.OffsetResetPlan, error) {
	h.log.Info("offset reset",
		zap.String("connection", t.ConnectionID),
		zap.String("group", t.Group),
		zap.String("topic", t.Topic),
		zap.String("mode", t.Mode),
		zap.Bool("dryRun", t.DryRun),
	)
	return h.svc.ResetOffset(ctx, t)
}

// ---- Share groups (KIP-932) ----

func (h *GroupHandler) ListShareGroups(ctx context.Context, connectionID string) ([]domain.ShareGroupSummary, error) {
	return h.svc.ListShareGroups(ctx, connectionID)
}

func (h *GroupHandler) ShareGroupDetail(ctx context.Context, connectionID, group string) (domain.ShareGroupDetail, error) {
	return h.svc.ShareGroupDetail(ctx, connectionID, group)
}

// AlterShareGroupOffset decision-logs the moved start offset: share offset
// edits silently drop not-yet-delivered records, so the trail matters.
func (h *GroupHandler) AlterShareGroupOffset(ctx context.Context, t domain.ShareGroupAlterTarget) error {
	h.log.Info("share offset alter",
		zap.String("connection", t.ConnectionID),
		zap.String("group", t.Group),
		zap.String("topic", t.Topic),
		zap.Int32("partition", t.Partition),
		zap.Int64("startOffset", t.StartOffset),
	)
	return h.svc.AlterShareGroupOffset(ctx, t)
}

// DeleteShareGroupOffsets decision-logs which topics' delivery progress is
// being forgotten for the share group.
func (h *GroupHandler) DeleteShareGroupOffsets(ctx context.Context, connectionID, group string, topics []string) error {
	h.log.Info("share offsets delete",
		zap.String("connection", connectionID),
		zap.String("group", group),
		zap.Strings("topics", topics),
	)
	return h.svc.DeleteShareGroupOffsets(ctx, connectionID, group, topics)
}
