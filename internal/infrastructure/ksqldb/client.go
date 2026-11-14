// Package ksqldb is a minimal ksqlDB REST client: /info, /ksql statements,
// /query-stream (delimited streaming), /healthcheck — the the reference desktop tool
// ksqlDB module surface. Optional HTTP basic auth (Confluent Cloud API
// key/secret) rides every request like the Connect client.
package ksqldb

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"kafkaexplorer/internal/domain"
)

type Client struct {
	base     string
	http     *http.Client
	// streamHTTP has NO client-level timeout: http.Client.Timeout covers the
	// whole body read, so the 15s limit would kill every push query
	// (EMIT CHANGES) after exactly 15s mid-stream. QueryStream's lifetime is
	// governed by its request context (the UI's stop button / handler TTL).
	streamHTTP *http.Client
	username   string
	password   string
}

func New(url, user, pass string) *Client {
	return &Client{
		base:       strings.TrimRight(url, "/"),
		http:       &http.Client{Timeout: 15 * time.Second},
		streamHTTP: &http.Client{},
		username:   user,
		password:   pass,
	}
}

func (c *Client) setAuth(req *http.Request) {
	if c.username != "" || c.password != "" {
		req.SetBasicAuth(c.username, c.password)
	}
}

// APIError carries the HTTP code and ksqlDB's own error_message.
type APIError struct {
	Code    int
	Message string
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("ksqldb %d: %s", e.Code, e.Message)
	}
	return fmt.Sprintf("ksqldb %d", e.Code)
}

func decodeError(data []byte) string {
	// ksqlDB error bodies: {"message": "text"} for simple errors, but
	// statement errors wrap the reason in an object —
	// {"message": {"targets": [{"description": "..."}]}}. Extract the
	// description(s) so the user sees the actual syntax/plan failure.
	var wrap struct {
		Message json.RawMessage `json:"message"`
	}
	if err := json.Unmarshal(data, &wrap); err != nil || len(wrap.Message) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(wrap.Message, &s); err == nil {
		return s
	}
	var obj struct {
		Targets []struct {
			Description string `json:"description"`
		} `json:"targets"`
	}
	if err := json.Unmarshal(wrap.Message, &obj); err == nil {
		parts := make([]string, 0, len(obj.Targets))
		for _, t := range obj.Targets {
			if t.Description != "" {
				parts = append(parts, t.Description)
			}
		}
		return strings.Join(parts, "; ")
	}
	return string(wrap.Message)
}

// Info is GET /info — version + service id + server status.
func (c *Client) Info(ctx context.Context) (version, serviceID, status string, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/info", nil)
	if err != nil {
		return "", "", "", err
	}
	c.setAuth(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return "", "", "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", "", "", err
	}
	if resp.StatusCode >= 400 {
		return "", "", "", &APIError{Code: resp.StatusCode, Message: decodeError(data)}
	}
	var out struct {
		KsqlServerInfo struct {
			Version     string `json:"version"`
			KsqlServiceID string `json:"ksqlServiceId"`
			ServerStatus string `json:"serverStatus"`
		} `json:"KsqlServerInfo"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", "", "", fmt.Errorf("decode /info: %w", err)
	}
	return out.KsqlServerInfo.Version, out.KsqlServerInfo.KsqlServiceID, out.KsqlServerInfo.ServerStatus, nil
}

// Exec posts one statement batch to /ksql and merges the response items
// into a single result (multi-statement inputs are allowed by ksqlDB; the
// UI sends one statement per call, so first-non-empty wins per family).
func (c *Client) Exec(ctx context.Context, ksql string) (domain.KsqlExecResult, error) {
	body := map[string]any{"ksql": ensureTrailingSemicolon(ksql), "streamsProperties": map[string]any{}}
	raw, err := json.Marshal(body)
	if err != nil {
		return domain.KsqlExecResult{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/ksql", strings.NewReader(string(raw)))
	if err != nil {
		return domain.KsqlExecResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	c.setAuth(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return domain.KsqlExecResult{}, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return domain.KsqlExecResult{}, err
	}
	if resp.StatusCode >= 400 {
		return domain.KsqlExecResult{}, &APIError{Code: resp.StatusCode, Message: decodeError(data)}
	}

	out := domain.KsqlExecResult{Streams: []domain.KsqlStreamRow{}, Tables: []domain.KsqlTableRow{}, Queries: []domain.KsqlQueryRow{}}
	var items []struct {
		Type          string           `json:"@type"`
		StatementText string           `json:"statementText"`
		QueryID       string           `json:"queryId"`
		Warnings      []string         `json:"warnings"`
		Streams       []domain.KsqlStreamRow `json:"streams"`
		Tables        []domain.KsqlTableRow  `json:"tables"`
		Queries       []domain.KsqlQueryRow  `json:"queries"`
		Properties    map[string]any   `json:"properties"`
		Entity        map[string]any   `json:"entity"`
		Entities      []map[string]any `json:"entities"`
		SourceDescription map[string]any `json:"sourceDescription"`
	}
	if err := json.Unmarshal(data, &items); err != nil {
		return domain.KsqlExecResult{}, fmt.Errorf("decode /ksql: %w", err)
	}
	seenQueryIDs := map[string]bool{}
	for _, it := range items {
		if out.StatementText == "" {
			out.StatementText = it.StatementText
		}
		if it.QueryID != "" && !seenQueryIDs[it.QueryID] {
			seenQueryIDs[it.QueryID] = true
			out.QueryIDs = append(out.QueryIDs, it.QueryID)
		}
		out.Warnings = append(out.Warnings, it.Warnings...)
		out.Streams = append(out.Streams, it.Streams...)
		out.Tables = append(out.Tables, it.Tables...)
		out.Queries = append(out.Queries, it.Queries...)
		if len(it.Properties) > 0 {
			props := map[string]string{}
			for k, v := range it.Properties {
				props[k] = fmt.Sprint(v)
			}
			out.Properties = props
		}
		if len(it.Entities) > 0 {
			out.GenericEntity = it.Entities[0]
		} else if len(it.Entity) > 0 {
			out.GenericEntity = it.Entity
		} else if it.SourceDescription != nil {
			// DESCRIBE / DESCRIBE EXTENDED carry the detail under their own
			// key, not "entity" (verified on 8.0.0).
			out.GenericEntity = it.SourceDescription
		}
	}
	return out, nil
}

// RowHandler receives the header row (column names) once and then result
// rows as they stream in. Returning an error from the handler stops the
// stream.
type RowHandler func(header []string, row []any) error

// QueryStream POSTs to /query-stream with the delimited wire format
// (Accept: application/vnd.ksqlapi.delimited.v1): each line is a JSON
// array — the FIRST line is the column-name header, following lines are
// row values. Push queries (EMIT CHANGES) never end: the stream runs until
// the context is cancelled (the UI's 停止 button) — context cancellation is
// the normal exit, not an error.
func (c *Client) QueryStream(ctx context.Context, sql string, onRow RowHandler) error {
	body := map[string]any{"sql": sql, "properties": map[string]any{}}
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/query-stream", strings.NewReader(string(raw)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	// The delimited format is what makes line-by-line streaming possible;
	// the default JSON array would buffer the whole (endless) response.
	req.Header.Set("Accept", "application/vnd.ksqlapi.delimited.v1")
	c.setAuth(req)
	resp, err := c.streamHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return &APIError{Code: resp.StatusCode, Message: decodeError(data)}
	}

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 256*1024), 8<<20)
	headerSent := false
	for sc.Scan() {
		if ctx.Err() != nil {
			return nil // cancelled: the normal exit for push queries
		}
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		// Wire format (verified on 8.0.0): the FIRST line is a JSON OBJECT
		// {"queryId":…,"columnNames":[…],"columnTypes":[…]} — NOT an array;
		// row lines are JSON arrays of values; the closing line may be
		// {"finalMessage":…}.
		if strings.HasPrefix(line, "{") {
			var obj struct {
				ColumnNames  []string `json:"columnNames"`
				FinalMessage string   `json:"finalMessage"`
				ErrorCode    *int     `json:"errorCode"`
				Message      string   `json:"message"`
			}
			if err := json.Unmarshal([]byte(line), &obj); err != nil {
				return fmt.Errorf("decode meta line: %w", err)
			}
			// Mid-stream failure events: the server terminates the query with
			// {"errorCode":…,"message":…} (deserialization failure, task
			// restart, server-side TERMINATE). The old parse only knew
			// columnNames/finalMessage and dropped these lines — a dead
			// stream was presented to the user as a normal end (045 round).
			if obj.ErrorCode != nil {
				return &APIError{Code: *obj.ErrorCode, Message: obj.Message}
			}
			if !headerSent {
				headerSent = true
				if err := onRow(obj.ColumnNames, nil); err != nil {
					return err
				}
			}
			if obj.FinalMessage != "" {
				return nil
			}
			continue
		}
		var arr []any
		if err := json.Unmarshal([]byte(line), &arr); err != nil {
			return fmt.Errorf("decode row: %w", err)
		}
		if err := onRow(nil, arr); err != nil {
			return err
		}
	}
	// A deadline/cancel that lands while blocked in Scan surfaces as a read
	// error here — for push queries that IS the normal stop, not a failure.
	if ctx.Err() != nil {
		return nil
	}
	return sc.Err()
}

// Health is GET /healthcheck.
func (c *Client) Health(ctx context.Context) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/healthcheck", nil)
	if err != nil {
		return false, err
	}
	c.setAuth(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return false, &APIError{Code: resp.StatusCode, Message: decodeError(data)}
	}
	return true, nil
}

func ensureTrailingSemicolon(s string) string {
	t := strings.TrimSpace(s)
	if t == "" {
		return t
	}
	if strings.HasSuffix(t, ";") {
		return t
	}
	return t + ";"
}
