package wails

import (
	"context"

	"go.uber.org/zap"

	"kafkaexplorer/internal/application"
	"kafkaexplorer/internal/domain"
	"kafkaexplorer/internal/infrastructure/connect"
)

// ConnectHandler exposes Kafka Connect clusters and connector lifecycle.
type ConnectHandler struct {
	svc     *application.ConnectService
	secrets domain.SecretStore
	log     *zap.Logger
}

func NewConnectHandler(svc *application.ConnectService, secrets domain.SecretStore, log *zap.Logger) *ConnectHandler {
	return &ConnectHandler{svc: svc, secrets: secrets, log: log}
}

func (h *ConnectHandler) List(ctx context.Context) ([]domain.ConnectCluster, error) {
	return h.svc.List(ctx)
}

// ConnectClusterSaveInput carries the endpoint plus an optional new API
// secret; the secret itself goes to the OS credential store, only a ref is
// persisted.
type ConnectClusterSaveInput struct {
	Cluster  domain.ConnectCluster `json:"cluster"`
	Password string                `json:"password,omitempty"`
}

func (h *ConnectHandler) Save(ctx context.Context, in ConnectClusterSaveInput) (domain.ConnectCluster, error) {
	h.log.Info("connect cluster save", zap.String("name", in.Cluster.Name), zap.String("url", in.Cluster.URL))
	saved, err := h.svc.Save(ctx, in.Cluster)
	if err != nil {
		return domain.ConnectCluster{}, err
	}
	// Same discipline as registries: the secret rides the OS credential
	// store; a new empty password keeps the previous ref untouched.
	if in.Password != "" && saved.ID != "" {
		ref := "connect-" + saved.ID
		if err := h.secrets.Set("kafka-explorer", ref, in.Password); err != nil {
			return domain.ConnectCluster{}, err
		}
		saved.SecretRef = ref
		saved, err = h.svc.Save(ctx, saved)
		if err != nil {
			return domain.ConnectCluster{}, err
		}
	}
	return saved, nil
}

func (h *ConnectHandler) Delete(ctx context.Context, id string) error {
	h.log.Info("connect cluster delete", zap.String("id", id))
	return h.svc.Delete(ctx, id)
}

func (h *ConnectHandler) Test(ctx context.Context, url, username, password string) (string, error) {
	return h.svc.Test(ctx, url, username, password)
}

func (h *ConnectHandler) Connectors(ctx context.Context, clusterID string) ([]connectConnectorSummary, error) {
	return h.svc.Connectors(ctx, clusterID)
}

func (h *ConnectHandler) Detail(ctx context.Context, clusterID, name string) (connectConnectorDetail, error) {
	return h.svc.ConnectorDetail(ctx, clusterID, name)
}

func (h *ConnectHandler) Plugins(ctx context.Context, clusterID string) ([]string, error) {
	return h.svc.Plugins(ctx, clusterID)
}

func (h *ConnectHandler) CreateConnector(ctx context.Context, in application.CreateConnectorInput) error {
	h.log.Info("connector create", zap.String("cluster", in.ConnectionID), zap.String("name", in.Name))
	return h.svc.CreateConnector(ctx, in)
}

func (h *ConnectHandler) DeleteConnector(ctx context.Context, clusterID, name string) error {
	h.log.Info("connector delete", zap.String("cluster", clusterID), zap.String("name", name))
	return h.svc.DeleteConnector(ctx, clusterID, name)
}

func (h *ConnectHandler) Restart(ctx context.Context, clusterID, name string) error {
	h.log.Info("connector restart", zap.String("cluster", clusterID), zap.String("name", name))
	return h.svc.Restart(ctx, clusterID, name)
}

func (h *ConnectHandler) Pause(ctx context.Context, clusterID, name string) error {
	h.log.Info("connector pause", zap.String("cluster", clusterID), zap.String("name", name))
	return h.svc.Pause(ctx, clusterID, name)
}

func (h *ConnectHandler) Resume(ctx context.Context, clusterID, name string) error {
	h.log.Info("connector resume", zap.String("cluster", clusterID), zap.String("name", name))
	return h.svc.Resume(ctx, clusterID, name)
}


// connectConnectorSummary / connectConnectorDetail alias the infra types for
// handler returns (JSON shapes identical).
type connectConnectorSummary = connect.ConnectorSummary
type connectConnectorDetail = connect.ConnectorDetail
