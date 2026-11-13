// Package registry is a minimal Confluent Schema Registry REST client.
// Only the endpoints this app needs: subjects, versions, compatibility.
package registry

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"kafkaexplorer/internal/domain"
)

type Client struct {
	base  string
	user  string
	pass  string
	http  *http.Client
}

func New(url, user, pass string) *Client {
	return &Client{
		base: strings.TrimRight(url, "/"),
		user: user,
		pass: pass,
		http: &http.Client{Timeout: 10 * time.Second},
	}
}

// raw performs one REST call and decodes the JSON envelope into out.
func (c *Client) raw(ctx context.Context, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal request: %w", err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, reader)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.schemaregistry.v1+json")
	if body != nil {
		req.Header.Set("Content-Type", "application/vnd.schemaregistry.v1+json")
	}
	if c.user != "" {
		req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(c.user+":"+c.pass)))
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode >= 400 {
		// Registry errors carry {"error_code":N,"message":"..."}; surface the
		// message AND the status (typed, so callers can branch on 409/422).
		var se struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(data, &se) == nil && se.Message != "" {
			return &RegistryAPIError{Code: resp.StatusCode, Message: se.Message}
		}
		return &RegistryAPIError{Code: resp.StatusCode, Message: truncate(string(data), 200)}
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("decode response: %w", err)
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

// esc escapes a subject name for a URL path segment. Subjects are cluster
// data — a name carrying a space, '?', '#' or '%' interpolated raw corrupted
// the request (the server routed it to the wrong path). Kafka topic names
// cannot contain '/', so PathEscape's %2F encoding is not a practical risk.
func esc(s string) string {
	return url.PathEscape(s)
}

// RegistryAPIError is a non-2xx registry response carrying the registry's
// own error text. Error() keeps the exact wording every existing caller
// prints; status-based branching uses errors.As.
type RegistryAPIError struct {
	Code    int
	Message string
}

func (e *RegistryAPIError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("registry %d: %s", e.Code, e.Message)
	}
	return fmt.Sprintf("registry %d", e.Code)
}

// TestConnection verifies the registry answers and returns an identity
// string. CP 7.x serves {"version":"7.9.2"} on GET /; CP 8.0 moved that
// payload off the root endpoint, so an empty version falls back to the
// /mode probe (READWRITE) which still proves the registry is live.
func (c *Client) TestConnection(ctx context.Context) (string, error) {
	var out struct {
		Version string `json:"version"`
	}
	if err := c.raw(ctx, http.MethodGet, "/", nil, &out); err != nil {
		return "", err
	}
	if out.Version != "" {
		return out.Version, nil
	}
	var m struct {
		Mode string `json:"mode"`
	}
	if err := c.raw(ctx, http.MethodGet, "/mode", nil, &m); err == nil && m.Mode != "" {
		return "模式 " + m.Mode, nil
	}
	return "", nil
}

// ListSubjects returns all subject names.
func (c *Client) ListSubjects(ctx context.Context) ([]string, error) {
	var out []string
	if err := c.raw(ctx, http.MethodGet, "/subjects", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// latestResponse is the /subjects/<s>/versions/latest shape.
type latestResponse struct {
	Subject    string             `json:"subject"`
	Version    int                `json:"version"`
	ID         int                `json:"id"`
	SchemaType string             `json:"schemaType"`
	References []domain.SchemaRef `json:"references"`
	Schema     string             `json:"schema"`
}

// GetSubject returns the latest version of a subject.
func (c *Client) GetSubject(ctx context.Context, subject string) (domain.SchemaSubject, error) {
	var lr latestResponse
	if err := c.raw(ctx, http.MethodGet, "/subjects/"+esc(subject)+"/versions/latest", nil, &lr); err != nil {
		return domain.SchemaSubject{}, err
	}
	out := domain.SchemaSubject{
		Name: lr.Subject, Version: lr.Version, ID: lr.ID,
		SchemaType: lr.SchemaType, Schema: lr.Schema, References: lr.References,
	}
	if out.SchemaType == "" {
		out.SchemaType = "AVRO" // registry omits the field for Avro
	}
	// Best-effort per-subject compatibility; some registries reject the
	// endpoint — degrade to "" instead of failing the whole read.
	out.Compatibility, _ = c.GetSubjectConfig(ctx, subject)
	return out, nil
}

// ListVersions returns every version of a subject.
func (c *Client) ListVersions(ctx context.Context, subject string) ([]domain.SchemaVersion, error) {
	var numbers []int
	if err := c.raw(ctx, http.MethodGet, "/subjects/"+esc(subject)+"/versions", nil, &numbers); err != nil {
		return nil, err
	}
	out := make([]domain.SchemaVersion, 0, len(numbers))
	for _, n := range numbers {
		var lr latestResponse
		path := fmt.Sprintf("/subjects/%s/versions/%d", esc(subject), n)
		if err := c.raw(ctx, http.MethodGet, path, nil, &lr); err != nil {
			return nil, err
		}
		st := lr.SchemaType
		if st == "" {
			st = "AVRO"
		}
		out = append(out, domain.SchemaVersion{Version: lr.Version, ID: lr.ID, SchemaType: st, Schema: lr.Schema})
	}
	return out, nil
}

// CheckCompatibility posts a candidate schema for a subject (latest anchor).
func (c *Client) CheckCompatibility(ctx context.Context, subject, schema, schemaType string) (domain.CompatibilityCheck, error) {
	return c.CheckCompatibilityVersion(ctx, subject, 0, schema, schemaType)
}

// DeleteSubject removes a subject. Soft delete (permanent=false) marks all
// versions deleted but still resolvable via ?deleted=true; permanent=true
// removes them from storage entirely.
func (c *Client) DeleteSubject(ctx context.Context, subject string, permanent bool) error {
	path := "/subjects/" + esc(subject)
	if permanent {
		path += "?permanent=true"
	}
	return c.raw(ctx, http.MethodDelete, path, nil, nil)
}

// DeleteVersion removes one version of a subject (soft unless permanent).
// Returns the schema id that was removed.
func (c *Client) DeleteVersion(ctx context.Context, subject string, version int, permanent bool) (int, error) {
	path := fmt.Sprintf("/subjects/%s/versions/%d", esc(subject), version)
	if permanent {
		path += "?permanent=true"
	}
	var out struct {
		ID int `json:"id"`
	}
	if err := c.raw(ctx, http.MethodDelete, path, nil, &out); err != nil {
		return 0, err
	}
	return out.ID, nil
}

// GetVersion fetches one exact version of a subject.
func (c *Client) GetVersion(ctx context.Context, subject string, version int) (domain.SchemaVersion, error) {
	var lr latestResponse
	path := fmt.Sprintf("/subjects/%s/versions/%d", esc(subject), version)
	if err := c.raw(ctx, http.MethodGet, path, nil, &lr); err != nil {
		return domain.SchemaVersion{}, err
	}
	st := lr.SchemaType
	if st == "" {
		st = "AVRO"
	}
	return domain.SchemaVersion{Version: lr.Version, ID: lr.ID, SchemaType: st, Schema: lr.Schema}, nil
}

// GetSubjectConfig returns the per-subject compatibility level. Degrades to
// "" (registry default in effect) when the subject has no explicit config.
func (c *Client) GetSubjectConfig(ctx context.Context, subject string) (string, error) {
	var cfg struct {
		CompatibilityLevel string `json:"compatibilityLevel"`
	}
	if err := c.raw(ctx, http.MethodGet, "/config/"+esc(subject), nil, &cfg); err != nil {
		return "", err
	}
	return cfg.CompatibilityLevel, nil
}

// SetSubjectConfig sets the per-subject compatibility level (PUT /config/<s>).
func (c *Client) SetSubjectConfig(ctx context.Context, subject, level string) error {
	return c.raw(ctx, http.MethodPut, "/config/"+esc(subject), map[string]string{"compatibility": level}, nil)
}

// GetGlobalConfig reads the registry-wide compatibility level.
func (c *Client) GetGlobalConfig(ctx context.Context) (domain.GlobalConfig, error) {
	var cfg domain.GlobalConfig
	if err := c.raw(ctx, http.MethodGet, "/config", nil, &cfg); err != nil {
		return domain.GlobalConfig{}, err
	}
	return cfg, nil
}

// SetGlobalConfig sets the registry-wide compatibility level.
func (c *Client) SetGlobalConfig(ctx context.Context, level string) error {
	return c.raw(ctx, http.MethodPut, "/config", map[string]string{"compatibility": level}, nil)
}

// CheckCompatibilityVersion posts a candidate schema against one exact
// version of a subject (version<=0 means latest). verbose=1 carries the
// per-rule incompatibility messages back.
func (c *Client) CheckCompatibilityVersion(ctx context.Context, subject string, version int, schema, schemaType string) (domain.CompatibilityCheck, error) {
	if schemaType == "" {
		schemaType = "AVRO"
	}
	ver := "latest"
	if version > 0 {
		ver = strconv.Itoa(version)
	}
	body := map[string]any{"schema": schema, "schemaType": schemaType}
	var out struct {
		IsCompatible bool     `json:"is_compatible"`
		Messages     []string `json:"messages"`
	}
	path := "/compatibility/subjects/" + esc(subject) + "/versions/" + ver + "?verbose=true"
	if err := c.raw(ctx, http.MethodPost, path, body, &out); err != nil {
		return domain.CompatibilityCheck{}, err
	}
	return domain.CompatibilityCheck{IsCompatible: out.IsCompatible, Messages: out.Messages}, nil
}

// RegisterSchema registers one schema version on a subject and returns the
// assigned (schema id, subject version). Empty schemaType means AVRO — the
// request then omits the field entirely, matching what every serializer
// sends. A 409/422 from the registry surfaces as a *RegistryAPIError so the
// service layer can translate it into a compatibility-conflict message.
func (c *Client) RegisterSchema(ctx context.Context, subject, schema, schemaType string) (int, int, error) {
	body := map[string]any{"schema": schema}
	if schemaType != "" && schemaType != "AVRO" {
		body["schemaType"] = schemaType
	}
	var out struct {
		ID      int `json:"id"`
		Version int `json:"version"`
	}
	if err := c.raw(ctx, http.MethodPost, "/subjects/"+esc(subject)+"/versions", body, &out); err != nil {
		return 0, 0, err
	}
	return out.ID, out.Version, nil
}

// SchemaByID resolves one schema id to (schema, type). Avro omits
// schemaType; everything else carries it explicitly.
func (c *Client) SchemaByID(ctx context.Context, id int) (string, string, error) {
	var out struct {
		SchemaType string `json:"schemaType"`
		Schema     string `json:"schema"`
	}
	if err := c.raw(ctx, http.MethodGet, fmt.Sprintf("/schemas/ids/%d", id), nil, &out); err != nil {
		return "", "", err
	}
	st := out.SchemaType
	if st == "" {
		st = "AVRO"
	}
	return out.Schema, st, nil
}
