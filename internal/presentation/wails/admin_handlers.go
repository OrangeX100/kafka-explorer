package wails

import (
	"context"
	"fmt"
	"strings"

	"go.uber.org/zap"
	wailsapp "github.com/wailsapp/wails/v3/pkg/application"

	"kafkaexplorer/internal/application"
	"kafkaexplorer/internal/application/decode"
	"kafkaexplorer/internal/domain"
)

// AdminHandler exposes brokers, log dirs, ACLs, quotas, cluster diff and
// group deletion. Security-relevant mutations carry decision logs.
type AdminHandler struct {
	svc *application.AdminService
	log *zap.Logger
}

func NewAdminHandler(svc *application.AdminService, log *zap.Logger) *AdminHandler {
	return &AdminHandler{svc: svc, log: log}
}

func (h *AdminHandler) ListBrokers(ctx context.Context, connectionID string) ([]domain.BrokerSummary, error) {
	return h.svc.ListBrokers(ctx, connectionID)
}

func (h *AdminHandler) BrokerDetail(ctx context.Context, connectionID string, brokerID int32) (domain.BrokerDetail, error) {
	return h.svc.BrokerDetail(ctx, connectionID, brokerID)
}

func (h *AdminHandler) AlterBrokerConfig(ctx context.Context, in domain.AlterBrokerConfigInput) error {
	h.log.Info("broker config alter",
		zap.String("connection", in.ConnectionID),
		zap.Int32("broker", in.BrokerID),
	)
	return h.svc.AlterBrokerConfig(ctx, in)
}

func (h *AdminHandler) IncreasePartitions(ctx context.Context, connectionID, topic string, target int32) error {
	// Growing a topic changes downstream message routing — decision log.
	h.log.Info("partitions increase",
		zap.String("connection", connectionID),
		zap.String("topic", topic),
		zap.Int32("target", target),
	)
	return h.svc.IncreasePartitions(ctx, connectionID, topic, target)
}

func (h *AdminHandler) ListLogDirs(ctx context.Context, connectionID string) ([]domain.LogDir, error) {
	return h.svc.ListLogDirs(ctx, connectionID)
}

func (h *AdminHandler) ListACLs(ctx context.Context, connectionID string) ([]domain.ACL, error) {
	return h.svc.ListACLs(ctx, connectionID)
}

func (h *AdminHandler) CreateACL(ctx context.Context, connectionID string, acl domain.ACL) error {
	h.log.Info("acl create",
		zap.String("connection", connectionID),
		zap.String("principal", acl.Principal),
		zap.String("operation", acl.Operation),
		zap.String("resource", acl.ResourceType+":"+acl.ResourceName),
		zap.String("permission", acl.PermissionType),
	)
	return h.svc.CreateACL(ctx, connectionID, acl)
}

func (h *AdminHandler) DeleteACL(ctx context.Context, connectionID string, acl domain.ACL) error {
	h.log.Info("acl delete",
		zap.String("connection", connectionID),
		zap.String("principal", acl.Principal),
		zap.String("resource", acl.ResourceType+":"+acl.ResourceName),
	)
	return h.svc.DeleteACL(ctx, connectionID, acl)
}

func (h *AdminHandler) ListQuotas(ctx context.Context, connectionID string) ([]domain.Quota, error) {
	return h.svc.ListQuotas(ctx, connectionID)
}


// DescribeQuorum exposes the KRaft quorum status. ZooKeeper clusters answer
// UNSUPPORTED_VERSION — translate into the friendly "not KRaft" guidance.
func (h *AdminHandler) DescribeQuorum(ctx context.Context, connectionId string) (application.QuorumInfo, error) {
	info, err := h.svc.DescribeQuorum(ctx, connectionId)
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "UNSUPPORTED_VERSION") || strings.Contains(msg, "code 35") {
			return application.QuorumInfo{}, fmt.Errorf("%w: 该集群未启用 KRaft 模式（或 Broker 版本过低），无法查询 Quorum 状态", domain.ErrUnavailable)
		}
		return application.QuorumInfo{}, err
	}
	return info, nil
}

func (h *AdminHandler) AlterQuota(ctx context.Context, connectionID string, entity map[string]string, key string, value *float64) error {
	h.log.Info("quota alter",
		zap.String("connection", connectionID),
		zap.Any("entity", entity),
		zap.String("key", key),
		zap.Bool("remove", value == nil),
	)
	return h.svc.AlterQuota(ctx, connectionID, entity, key, value)
}

func (h *AdminHandler) DeleteConsumerGroup(ctx context.Context, connectionID, group string) error {
	h.log.Info("consumer group delete", zap.String("connection", connectionID), zap.String("group", group))
	return h.svc.DeleteConsumerGroup(ctx, connectionID, group)
}

func (h *AdminHandler) ClusterDiff(ctx context.Context, connectionA, connectionB string) (domain.ClusterDiff, error) {
	return h.svc.ClusterDiff(ctx, connectionA, connectionB)
}

// SchemaRegistryHandler exposes registry connections and subject browsing.
type SchemaRegistryHandler struct {
	svc     *application.SchemaRegistryService
	secrets domain.SecretStore
	log     *zap.Logger
}

func NewSchemaRegistryHandler(svc *application.SchemaRegistryService, secrets domain.SecretStore, log *zap.Logger) *SchemaRegistryHandler {
	return &SchemaRegistryHandler{svc: svc, secrets: secrets, log: log}
}

func (h *SchemaRegistryHandler) List(ctx context.Context) ([]domain.SchemaRegistry, error) {
	return h.svc.List(ctx)
}

func (h *SchemaRegistryHandler) Save(ctx context.Context, in RegistrySaveInput) (domain.SchemaRegistry, error) {
	h.log.Info("registry save", zap.String("name", in.Registry.Name), zap.String("url", in.Registry.URL))
	saved, err := h.svc.Save(ctx, in.Registry)
	if err != nil {
		return domain.SchemaRegistry{}, err
	}
	// Basic-auth password rides the OS credential store, same as SASL.
	if in.Password != "" && saved.ID != "" {
		ref := "registry-" + saved.ID
		if err := h.secrets.Set("kafka-explorer", ref, in.Password); err != nil {
			return domain.SchemaRegistry{}, err
		}
		saved.SecretRef = ref
		_, err = h.svc.Save(ctx, saved) // persist the ref
		if err != nil {
			return domain.SchemaRegistry{}, err
		}
	}
	return saved, nil
}

func (h *SchemaRegistryHandler) Delete(ctx context.Context, id string) error {
	h.log.Info("registry delete", zap.String("id", id))
	return h.svc.Delete(ctx, id)
}

func (h *SchemaRegistryHandler) Test(ctx context.Context, r domain.SchemaRegistry, password string) (string, error) {
	return h.svc.Test(ctx, r, password)
}

func (h *SchemaRegistryHandler) Subjects(ctx context.Context, registryID string) ([]domain.SchemaSubject, error) {
	return h.svc.Subjects(ctx, registryID)
}

func (h *SchemaRegistryHandler) Versions(ctx context.Context, registryID, subject string) ([]domain.SchemaVersion, error) {
	return h.svc.Versions(ctx, registryID, subject)
}

func (h *SchemaRegistryHandler) Compatibility(ctx context.Context, registryID, subject, schema, schemaType string) (domain.CompatibilityCheck, error) {
	return h.svc.Compatibility(ctx, registryID, subject, schema, schemaType)
}

// ValidateSchema runs the local precheck only (no registry contact) — the
// UI calls it before compat check and registration.
func (h *SchemaRegistryHandler) ValidateSchema(ctx context.Context, schemaType, schema string) error {
	return decode.ValidateSchema(schemaType, schema)
}

func (h *SchemaRegistryHandler) RegisterSchema(ctx context.Context, registryID, subject, schema, schemaType string) (application.SchemaRegisterResult, error) {
	// Registering a schema adds a version to the registry — decision log.
	h.log.Info("schema register",
		zap.String("registry", registryID),
		zap.String("subject", subject),
		zap.String("type", schemaType),
	)
	return h.svc.RegisterSchema(ctx, registryID, subject, schema, schemaType)
}

func (h *SchemaRegistryHandler) DeleteSubject(ctx context.Context, registryID, subject string, permanent bool) error {
	h.log.Info("registry subject delete", zap.String("registry", registryID), zap.String("subject", subject), zap.Bool("permanent", permanent))
	return h.svc.DeleteSubject(ctx, registryID, subject, permanent)
}

func (h *SchemaRegistryHandler) DeleteVersion(ctx context.Context, registryID, subject string, version int, permanent bool) (int, error) {
	h.log.Info("registry version delete", zap.String("registry", registryID), zap.String("subject", subject), zap.Int("version", version), zap.Bool("permanent", permanent))
	return h.svc.DeleteVersion(ctx, registryID, subject, version, permanent)
}

func (h *SchemaRegistryHandler) CompatibilityVersion(ctx context.Context, registryID, subject string, version int, schema, schemaType string) (domain.CompatibilityCheck, error) {
	return h.svc.CompatibilityVersion(ctx, registryID, subject, version, schema, schemaType)
}

func (h *SchemaRegistryHandler) SetSubjectConfig(ctx context.Context, registryID, subject, level string) error {
	return h.svc.SetSubjectConfig(ctx, registryID, subject, level)
}

func (h *SchemaRegistryHandler) GlobalConfig(ctx context.Context, registryID string) (domain.GlobalConfig, error) {
	return h.svc.GlobalConfig(ctx, registryID)
}

func (h *SchemaRegistryHandler) SetGlobalConfig(ctx context.Context, registryID, level string) error {
	return h.svc.SetGlobalConfig(ctx, registryID, level)
}

// --- local (offline) schema library ---

func (h *SchemaRegistryHandler) ListLocalSchemas(ctx context.Context) ([]domain.LocalSchema, error) {
	return h.svc.ListLocalSchemas(ctx)
}

func (h *SchemaRegistryHandler) SaveLocalSchema(ctx context.Context, schema domain.LocalSchema) (domain.LocalSchema, error) {
	return h.svc.SaveLocalSchema(ctx, schema)
}

func (h *SchemaRegistryHandler) DeleteLocalSchema(ctx context.Context, id string) error {
	return h.svc.DeleteLocalSchema(ctx, id)
}

func (h *SchemaRegistryHandler) DecodeLocal(ctx context.Context, schemaType, schema, payloadBase64 string) (domain.DecodeResult, error) {
	return h.svc.DecodeLocal(ctx, schemaType, schema, payloadBase64)
}

// RegistrySaveInput carries the registry plus an optional inline password
// (write-only, like the connection form).
type RegistrySaveInput struct {
	Registry domain.SchemaRegistry `json:"registry"`
	Password string               `json:"password,omitempty"`
}

// GenerateHandler exposes the data generator and message import/export.
type GenerateHandler struct {
	gen *application.GenerateService
	io  *application.MessageIOService
	log *zap.Logger
}

func NewGenerateHandler(gen *application.GenerateService, io *application.MessageIOService, log *zap.Logger) *GenerateHandler {
	return &GenerateHandler{gen: gen, io: io, log: log}
}

func (h *GenerateHandler) Generate(ctx context.Context, in domain.GenerateInput) (domain.GenerateResult, error) {
	h.log.Info("data generate",
		zap.String("connection", in.ConnectionID),
		zap.String("topic", in.Topic),
		zap.Int("count", in.Count),
		zap.String("format", in.Format),
	)
	return h.gen.Generate(ctx, in)
}

func (h *GenerateHandler) Export(ctx context.Context, in domain.ExportMessagesInput) (string, error) {
	h.log.Info("messages export",
		zap.String("connection", in.ConnectionID),
		zap.String("topic", in.Topic),
		zap.String("format", in.Format),
	)
	return h.io.Export(ctx, in)
}

func (h *GenerateHandler) Import(ctx context.Context, in domain.GenerateInput) (domain.GenerateResult, error) {
	h.log.Info("messages import",
		zap.String("connection", in.ConnectionID),
		zap.String("topic", in.Topic),
	)
	return h.io.Import(ctx, in)
}

// SettingsHandler exposes user preferences plus the one-file full backup
// (connections, registries, connect, ksqlDB, local schemas, preferences).
type SettingsHandler struct {
	svc    *application.SettingsService
	backup *application.BackupService
	log    *zap.Logger
}

func NewSettingsHandler(svc *application.SettingsService, backup *application.BackupService, log *zap.Logger) *SettingsHandler {
	return &SettingsHandler{svc: svc, backup: backup, log: log}
}

func (h *SettingsHandler) Get(ctx context.Context) (application.Settings, error) {
	return h.svc.Get(ctx)
}

func (h *SettingsHandler) Save(ctx context.Context, in application.Settings) (application.Settings, error) {
	return h.svc.Save(ctx, in)
}

// ExportBackup opens a save dialog through the caller-injected picker (same
// pattern as ConnectionHandler.ExportConnections) and writes the backup.
func (h *SettingsHandler) ExportBackup(ctx context.Context) (string, error) {
	return h.backup.ExportAll(ctx, func(ctx context.Context) (string, error) {
		return promptSingleSelection(wailsapp.Get().Dialog.SaveFile().
			SetMessage("导出所有配置").
			SetFilename("kafka-explorer-backup.json").
			AddFilter("JSON", "*.json").
			PromptForSingleSelection())
	})
}

// ImportBackup merges a backup file into the current configuration.
func (h *SettingsHandler) ImportBackup(ctx context.Context, path string) (application.BackupCounts, error) {
	h.log.Info("settings import backup", zap.String("path", path))
	return h.backup.ImportAll(ctx, path)
}
