package wails

import (
	"context"
	"sync"
	"time"

	"go.uber.org/zap"

	"kafkaexplorer/internal/application"
	"kafkaexplorer/internal/domain"
)

// KsqlDbHandler exposes ksqlDB servers, statements and streaming queries.
// Query rows stream to the frontend over wails events (channel
// "ksql:rows:{requestId}", batches) with a completion event
// "ksql:done:{requestId}". Event delivery is the right channel here: rows
// arrive at human-reading rate (a few per second on our test surfaces),
// far below the high-frequency threshold that would demand a data socket.
type KsqlDbHandler struct {
	svc     *application.KsqlDbService
	secrets domain.SecretStore
	log     *zap.Logger
	emit    func(topic string, data ...any)

	mu      sync.Mutex
	cancels map[string]context.CancelFunc
}

func NewKsqlDbHandler(svc *application.KsqlDbService, secrets domain.SecretStore, log *zap.Logger) *KsqlDbHandler {
	return &KsqlDbHandler{svc: svc, secrets: secrets, log: log, cancels: map[string]context.CancelFunc{}}
}

// SetEmitter wires the wails event emitter (bootstrap owns the app).
func (h *KsqlDbHandler) SetEmitter(emit func(topic string, data ...any)) {
	h.emit = emit
}

type KsqlDbSaveInput struct {
	Server   domain.KsqlDbServer `json:"server"`
	Password string              `json:"password,omitempty"`
}

func (h *KsqlDbHandler) List(ctx context.Context) ([]domain.KsqlDbServer, error) {
	return h.svc.List(ctx)
}

func (h *KsqlDbHandler) Save(ctx context.Context, in KsqlDbSaveInput) (domain.KsqlDbServer, error) {
	h.log.Info("ksqldb save", zap.String("name", in.Server.Name), zap.String("url", in.Server.URL))
	saved, err := h.svc.Save(ctx, in.Server)
	if err != nil {
		return domain.KsqlDbServer{}, err
	}
	if in.Password != "" && saved.ID != "" {
		ref := "ksqldb-" + saved.ID
		if err := h.secrets.Set("kafka-explorer", ref, in.Password); err != nil {
			return domain.KsqlDbServer{}, err
		}
		saved.SecretRef = ref
		saved, err = h.svc.Save(ctx, saved)
		if err != nil {
			return domain.KsqlDbServer{}, err
		}
	}
	return saved, nil
}

func (h *KsqlDbHandler) Delete(ctx context.Context, id string) error {
	h.log.Info("ksqldb delete", zap.String("id", id))
	return h.svc.Delete(ctx, id)
}

// Test verifies an unsaved form; Ping in the add dialog.
func (h *KsqlDbHandler) Test(ctx context.Context, url, username, password string) (string, string, string, error) {
	return h.svc.Test(ctx, url, username, password)
}

func (h *KsqlDbHandler) Info(ctx context.Context, serverID string) (string, string, string, error) {
	return h.svc.Info(ctx, serverID)
}

func (h *KsqlDbHandler) Exec(ctx context.Context, serverID, ksql string) (domain.KsqlExecResult, error) {
	return h.svc.Exec(ctx, serverID, ksql)
}

// Query launches a streaming query in the background. Returns immediately;
// rows arrive via "ksql:rows:{requestID}" batches and "ksql:done:{requestID}"
// terminates the sequence. Push queries keep streaming until Cancel.
func (h *KsqlDbHandler) Query(serverID, sql, requestID string) error {
	// Hard TTL: a webview reload loses the requestID so Cancel can never
	// arrive — without this cap the stream (and its goroutine) would run
	// until process exit.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	h.mu.Lock()
	h.cancels[requestID] = cancel
	h.mu.Unlock()

	go func() {
		defer func() {
			cancel()
			h.mu.Lock()
			delete(h.cancels, requestID)
			h.mu.Unlock()
		}()

		start := time.Now()
		rows := 0
		batch := make([][]any, 0, 64)
		flush := func(final bool) {
			if len(batch) == 0 && !final {
				return
			}
			if h.emit != nil {
				// Global topics + id in the payload: the frontend keeps ONE
				// subscription across queries and filters by its own id.
				h.emit("ksql:rows", map[string]any{"id": requestID, "rows": batch, "final": final})
			}
			batch = make([][]any, 0, 64)
		}
		err := h.svc.Query(ctx, serverID, sql, func(header []string, row []any) error {
			// row == nil carries the streaming column header (push queries
			// name their columns in the stream's first meta line).
			if row == nil {
				if len(header) > 0 && h.emit != nil {
					h.emit("ksql:columns", map[string]any{"id": requestID, "columns": header})
				}
				return nil
			}
			rows++
			batch = append(batch, row)
			if len(batch) >= 64 {
				flush(false)
			}
			return nil
		})
		flush(true)
		elapsed := time.Since(start).Milliseconds()
		if h.emit != nil {
			payload := map[string]any{"id": requestID, "rowCount": rows, "elapsedMs": elapsed}
			if err != nil {
				payload["error"] = err.Error()
			}
			h.emit("ksql:done", payload)
		}
		h.log.Info("ksqldb query finished", zap.String("id", requestID), zap.Int64("elapsedMs", elapsed), zap.Int("rows", rows), zap.Error(err))
	}()
	return nil
}

// Cancel stops a running streaming query. Cancelling a finished id is a
// no-op.
func (h *KsqlDbHandler) Cancel(requestID string) {
	h.mu.Lock()
	cancel, ok := h.cancels[requestID]
	h.mu.Unlock()
	if ok {
		cancel()
	}
}
