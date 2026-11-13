package application

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"kafkaexplorer/internal/domain"
	"kafkaexplorer/internal/infrastructure/connect"
)

// ConnectService manages saved Kafka Connect endpoints (per-registry store
// pattern) and connector operations. Endpoints live in the settings DB;
// optional basic-auth secrets live in the OS credential store.
type ConnectService struct {
	store   *connectStore
	secrets domain.SecretStore
}

func NewConnectService(dbw interface {
	ListConnectClusters(ctx context.Context) ([]domain.ConnectCluster, error)
	SaveConnectCluster(ctx context.Context, c domain.ConnectCluster) (domain.ConnectCluster, error)
	DeleteConnectCluster(ctx context.Context, id string) error
}, secrets domain.SecretStore) *ConnectService {
	return &ConnectService{store: &connectStore{db: dbw}, secrets: secrets}
}

type connectStore struct {
	db interface {
		ListConnectClusters(ctx context.Context) ([]domain.ConnectCluster, error)
		SaveConnectCluster(ctx context.Context, c domain.ConnectCluster) (domain.ConnectCluster, error)
		DeleteConnectCluster(ctx context.Context, id string) error
	}
}

func (s *ConnectService) List(ctx context.Context) ([]domain.ConnectCluster, error) {
	return s.store.db.ListConnectClusters(ctx)
}

func (s *ConnectService) Save(ctx context.Context, c domain.ConnectCluster) (domain.ConnectCluster, error) {
	if err := c.Validate(); err != nil {
		return domain.ConnectCluster{}, err
	}
	if c.ID == "" {
		c.ID = newID()
	}
	return s.store.db.SaveConnectCluster(ctx, c)
}

func (s *ConnectService) Delete(ctx context.Context, id string) error {
	// Read the row first: the credential ref is only reachable from it. Row
	// first, credential after — a non-"not found" keyring failure surfaces so
	// a leftover credential never looks like a silent leak.
	clusters, err := s.store.db.ListConnectClusters(ctx)
	if err != nil {
		return err
	}
	var ref string
	for _, c := range clusters {
		if c.ID == id {
			ref = c.SecretRef
			break
		}
	}
	if err := s.store.db.DeleteConnectCluster(ctx, id); err != nil {
		return err
	}
	if ref != "" && s.secrets != nil {
		if err := s.secrets.Delete("kafka-explorer", ref); err != nil {
			return fmt.Errorf("条目已删除，但其凭据未能从系统凭据存储移除（%v）；可在系统凭据管理器中手动清理", err)
		}
	}
	return nil
}

// clusterFor builds a client for a saved endpoint id.
func (s *ConnectService) clusterFor(ctx context.Context, id string) (*connect.Client, error) {
	clusters, err := s.store.db.ListConnectClusters(ctx)
	if err != nil {
		return nil, err
	}
	for _, c := range clusters {
		if c.ID == id {
			pass, err := s.storedPassword(c.SecretRef)
			if err != nil {
				return nil, err
			}
			return connect.New(c.URL, c.Username, pass), nil
		}
	}
	return nil, fmt.Errorf("Connect 集群 %s: %w", id, domain.ErrNotFound)
}

func (s *ConnectService) Test(ctx context.Context, url, username, password string) (string, error) {
	return connect.New(url, username, password).Test(ctx)
}

// storedPassword resolves the OS credential store reference. An empty ref
// means the endpoint runs unauthenticated; an unreadable ref is an ERROR —
// swallowing it used to send an unauthenticated request whose 401 told the
// user nothing about the real cause.
func (s *ConnectService) storedPassword(ref string) (string, error) {
	if ref == "" || s.secrets == nil {
		return "", nil
	}
	pass, err := s.secrets.Get("kafka-explorer", ref)
	if err != nil {
		return "", fmt.Errorf("读取 Connect 集群凭据失败：%v（请在编辑对话框重新保存密码）", err)
	}
	return pass, nil
}

func (s *ConnectService) Connectors(ctx context.Context, clusterID string) ([]connect.ConnectorSummary, error) {
	c, err := s.clusterFor(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	return c.ListConnectors(ctx)
}

func (s *ConnectService) ConnectorDetail(ctx context.Context, clusterID, name string) (connect.ConnectorDetail, error) {
	c, err := s.clusterFor(ctx, clusterID)
	if err != nil {
		return connect.ConnectorDetail{}, err
	}
	return c.GetConnector(ctx, name)
}

func (s *ConnectService) Plugins(ctx context.Context, clusterID string) ([]string, error) {
	c, err := s.clusterFor(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	return c.ListPlugins(ctx)
}

// CreateConnectorInput is the new-connector form payload. Config carries the
// full worker config; "connector.class" selects the plugin.
type CreateConnectorInput struct {
	ConnectionID string            `json:"connectionId"`
	Name         string            `json:"name"`
	Config       map[string]string `json:"config"`
}

// CreateConnector submits a connector to the cluster. Connect's own error
// message (a 400 lists the offending config keys) is user-actionable, so it
// is surfaced verbatim behind a Chinese frame instead of being swallowed.
func (s *ConnectService) CreateConnector(ctx context.Context, in CreateConnectorInput) error {
	if strings.TrimSpace(in.Name) == "" {
		return fmt.Errorf("连接器名称不能为空")
	}
	if in.Config["connector.class"] == "" {
		return fmt.Errorf("缺少 connector.class：请选择插件")
	}
	c, err := s.clusterFor(ctx, in.ConnectionID)
	if err != nil {
		return err
	}
	if err := c.CreateConnector(ctx, strings.TrimSpace(in.Name), in.Config); err != nil {
		return createConnectorErr(in.Name, err)
	}
	return nil
}

func createConnectorErr(name string, err error) error {
	var api *connect.APIError
	if errors.As(err, &api) {
		switch api.Code {
		case http.StatusConflict:
			return fmt.Errorf("连接器「%s」已存在于该 Connect 集群，换一个名称或先删除旧连接器", name)
		case http.StatusBadRequest:
			return fmt.Errorf("Connect 拒绝了配置（%s）", api.Message)
		}
	}
	return err
}

// DeleteConnector removes a connector and its tasks from the cluster.
func (s *ConnectService) DeleteConnector(ctx context.Context, clusterID, name string) error {
	c, err := s.clusterFor(ctx, clusterID)
	if err != nil {
		return err
	}
	if err := c.DeleteConnector(ctx, name); err != nil {
		var api *connect.APIError
		if errors.As(err, &api) && api.Code == http.StatusNotFound {
			return fmt.Errorf("连接器「%s」不存在（可能已被删除），刷新列表即可", name)
		}
		return err
	}
	return nil
}

// Restart / Pause / Resume are runtime-affecting: decision logs live in the
// wails handler.
func (s *ConnectService) Restart(ctx context.Context, clusterID, name string) error {
	c, err := s.clusterFor(ctx, clusterID)
	if err != nil {
		return err
	}
	return c.RestartConnector(ctx, name)
}

// RestartTask restarts ONE failed task — the narrower fix when a single
// task is stuck while the connector itself is healthy.
func (s *ConnectService) RestartTask(ctx context.Context, clusterID, name string, taskID int) error {
	c, err := s.clusterFor(ctx, clusterID)
	if err != nil {
		return err
	}
	if err := c.RestartTask(ctx, name, taskID); err != nil {
		var api *connect.APIError
		if errors.As(err, &api) && api.Code == http.StatusNotFound {
			return fmt.Errorf("任务不存在（连接器可能已被删除或重建），刷新后重试")
		}
		return err
	}
	return nil
}

// UpdateConnector replaces a connector's config (PUT …/config). 409 means
// the cluster refused the update — most often failed tasks or a paused
// connector, so the message points the user at the pause/restart levers.
func (s *ConnectService) UpdateConnector(ctx context.Context, clusterID, name string, config map[string]string) error {
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("连接器名称不能为空")
	}
	if config["connector.class"] == "" {
		return fmt.Errorf("缺少 connector.class：配置必须保留该字段")
	}
	c, err := s.clusterFor(ctx, clusterID)
	if err != nil {
		return err
	}
	if err := c.UpdateConnectorConfig(ctx, name, config); err != nil {
		var api *connect.APIError
		if errors.As(err, &api) {
			switch api.Code {
			case http.StatusConflict:
				return fmt.Errorf("集群拒绝更新「%s」的配置：存在失败任务或连接器需先暂停后再更新（%s）", name, api.Message)
			case http.StatusBadRequest:
				return fmt.Errorf("Connect 拒绝了配置（%s）", api.Message)
			case http.StatusNotFound:
				return fmt.Errorf("连接器「%s」不存在（可能已被删除），刷新列表即可", name)
			}
		}
		return err
	}
	return nil
}

func (s *ConnectService) Pause(ctx context.Context, clusterID, name string) error {
	c, err := s.clusterFor(ctx, clusterID)
	if err != nil {
		return err
	}
	return c.PauseConnector(ctx, name)
}

func (s *ConnectService) Resume(ctx context.Context, clusterID, name string) error {
	c, err := s.clusterFor(ctx, clusterID)
	if err != nil {
		return err
	}
	return c.ResumeConnector(ctx, name)
}
