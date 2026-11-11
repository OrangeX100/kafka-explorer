// Package connect is a minimal Kafka Connect REST client: clusters,
// connectors, status and plugins — the standard Connect panel surface.
package connect

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	base     string
	http     *http.Client
	username string
	password string
}

// New builds a Connect REST client. Empty user/pass means unauthenticated
// (a plain Apache Kafka worker); a set pair is sent as HTTP Basic auth on
// every request (Confluent Cloud Connect: API key as user, secret as pass).
func New(url, user, pass string) *Client {
	return &Client{
		base:     strings.TrimRight(url, "/"),
		http:     &http.Client{Timeout: 10 * time.Second},
		username: user,
		password: pass,
	}
}

func (c *Client) setAuth(req *http.Request) {
	if c.username != "" || c.password != "" {
		req.SetBasicAuth(c.username, c.password)
	}
}

func (c *Client) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	c.setAuth(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("connect %d: %s", resp.StatusCode, truncate(string(data), 200))
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("decode %s: %w", path, err)
		}
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// Test verifies the Connect cluster answers and returns its version.
func (c *Client) Test(ctx context.Context) (string, error) {
	var out struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	}
	if err := c.get(ctx, "/", &out); err != nil {
		return "", err
	}
	return out.Version, nil
}

// ConnectorSummary is one connector with its current state.
type ConnectorSummary struct {
	Name   string `json:"name"`
	Type   string `json:"type"`   // source | sink
	State  string `json:"state"`  // RUNNING | FAILED | PAUSED
	Worker string `json:"worker"`
}

// ListConnectors returns every connector with expanded status.
func (c *Client) ListConnectors(ctx context.Context) ([]ConnectorSummary, error) {
	var names []string
	if err := c.get(ctx, "/connectors?expand=status", nil); err != nil {
		// Fallback: plain list then per-connector status.
		if err2 := c.get(ctx, "/connectors", &names); err2 != nil {
			return nil, err
		}
		out := make([]ConnectorSummary, 0, len(names))
		for _, n := range names {
			var st struct {
				Name   string `json:"name"`
				Connector struct {
					State  string `json:"state"`
					Type   string `json:"type"`
					Worker string `json:"worker_id"`
				} `json:"connector"`
			}
			if err := c.get(ctx, "/connectors/"+n+"/status", &st); err != nil {
				out = append(out, ConnectorSummary{Name: n, State: "UNKNOWN"})
				continue
			}
			out = append(out, ConnectorSummary{Name: st.Name, Type: st.Connector.Type, State: st.Connector.State, Worker: st.Connector.Worker})
		}
		return out, nil
	}
	// expand=status returns {name: {status: {...}}}
	var expanded map[string]struct {
		Status struct {
			Name      string `json:"name"`
			Connector struct {
				State  string `json:"state"`
				Type   string `json:"type"`
				Worker string `json:"worker_id"`
			} `json:"connector"`
		} `json:"status"`
	}
	// Re-fetch into the typed envelope (first get consumed the body).
	if err := c.get(ctx, "/connectors?expand=status", &expanded); err != nil {
		return nil, err
	}
	out := make([]ConnectorSummary, 0, len(expanded))
	for _, e := range expanded {
		out = append(out, ConnectorSummary{
			Name: e.Status.Name, Type: e.Status.Connector.Type,
			State: e.Status.Connector.State, Worker: e.Status.Connector.Worker,
		})
	}
	return out, nil
}

// ConnectorDetail adds tasks and config to the summary.
type ConnectorDetail struct {
	Name    string          `json:"name"`
	Type    string          `json:"type"`
	State   string          `json:"state"`
	Worker  string          `json:"worker"`
	Config  map[string]string `json:"config"`
	Tasks   []TaskStatus    `json:"tasks"`
}

// TaskStatus is one connector task's runtime state.
type TaskStatus struct {
	ID     int    `json:"id"`
	State  string `json:"state"`
	Worker string `json:"worker_id"`
	Trace  string `json:"trace,omitempty"`
}

// GetConnector returns one connector's full status + config. Two calls by
// necessity: /status carries tasks but NOT the config — that lives at
// /connectors/{name} (the status endpoint's config field is always absent,
// which used to render an empty config table).
func (c *Client) GetConnector(ctx context.Context, name string) (ConnectorDetail, error) {
	var st struct {
		Name      string `json:"name"`
		Connector struct {
			State  string `json:"state"`
			Type   string `json:"type"`
			Worker string `json:"worker_id"`
		} `json:"connector"`
		Tasks []struct {
			ID     int    `json:"id"`
			State  string `json:"state"`
			Worker string `json:"worker_id"`
			Trace  string `json:"trace"`
		} `json:"tasks"`
	}
	if err := c.get(ctx, "/connectors/"+name+"/status", &st); err != nil {
		return ConnectorDetail{}, err
	}
	var cfg struct {
		Config map[string]string `json:"config"`
	}
	if err := c.get(ctx, "/connectors/"+name, &cfg); err != nil {
		return ConnectorDetail{}, err
	}
	tasks := make([]TaskStatus, 0, len(st.Tasks))
	for _, t := range st.Tasks {
		tasks = append(tasks, TaskStatus{ID: t.ID, State: t.State, Worker: t.Worker, Trace: t.Trace})
	}
	if cfg.Config == nil {
		cfg.Config = map[string]string{}
	}
	return ConnectorDetail{
		Name: st.Name, Type: st.Connector.Type, State: st.Connector.State,
		Worker: st.Connector.Worker, Config: cfg.Config, Tasks: tasks,
	}, nil
}

// ListPlugins returns the installed connector plugins.
func (c *Client) ListPlugins(ctx context.Context) ([]string, error) {
	var plugins []struct {
		Class string `json:"class"`
		Type  string `json:"type"`
	}
	if err := c.get(ctx, "/connector-plugins", &plugins); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(plugins))
	for _, p := range plugins {
		out = append(out, p.Type+": "+p.Class)
	}
	return out, nil
}

// RestartConnector restarts the connector AND its tasks (KIP-745
// includeTasks=true — a plain restart only restarts the connector instance
// and leaves a failed task failed, which is not what 重启 means to a user).
// The pause/resume state lives in the config topic, so a restart preserves
// it: a paused connector stays paused after restarting (verified on 4.2).
func (c *Client) RestartConnector(ctx context.Context, name string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/connectors/"+name+"/restart?includeTasks=true", nil)
	if err != nil {
		return err
	}
	c.setAuth(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("restart %s: %d", name, resp.StatusCode)
	}
	return nil
}

// PauseConnector pauses a running connector.
func (c *Client) PauseConnector(ctx context.Context, name string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, c.base+"/connectors/"+name+"/pause", nil)
	if err != nil {
		return err
	}
	c.setAuth(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("pause %s: %d", name, resp.StatusCode)
	}
	return nil
}

// ResumeConnector resumes a paused connector.
func (c *Client) ResumeConnector(ctx context.Context, name string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, c.base+"/connectors/"+name+"/resume", nil)
	if err != nil {
		return err
	}
	c.setAuth(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("resume %s: %d", name, resp.StatusCode)
	}
	return nil
}

// APIError is a Connect REST error with the HTTP code and the server's own
// message ({"error_code":…,"message":…}) — the service layer turns it into
// user-facing copy.
type APIError struct {
	Code    int
	Message string
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("connect %d: %s", e.Code, e.Message)
	}
	return fmt.Sprintf("connect %d", e.Code)
}

// do runs one non-GET request; body may be nil. 4xx/5xx responses become
// *APIError carrying the server's message (Kafka Connect wraps failures in
// {"error_code":…,"message":…} — that text is what the user needs).
func (c *Client) do(ctx context.Context, method, path string, body any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	c.setAuth(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		var wrap struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(data, &wrap)
		return &APIError{Code: resp.StatusCode, Message: wrap.Message}
	}
	return nil
}

// CreateConnector submits a new connector; config must already carry
// "connector.class" (validated in the service layer).
func (c *Client) CreateConnector(ctx context.Context, name string, config map[string]string) error {
	return c.do(ctx, http.MethodPost, "/connectors", map[string]any{"name": name, "config": config})
}

// DeleteConnector removes a connector together with its tasks.
func (c *Client) DeleteConnector(ctx context.Context, name string) error {
	return c.do(ctx, http.MethodDelete, "/connectors/"+name, nil)
}
