package application

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"strings"
	"text/template"
	"time"

	"kafkaexplorer/internal/domain"
	"kafkaexplorer/internal/infrastructure/kafka"
)

// GenerateService produces batches of synthetic test messages
// (test data generator).
type GenerateService struct {
	pool *kafka.Pool
}

func NewGenerateService(pool *kafka.Pool) *GenerateService { return &GenerateService{pool: pool} }

// Generate renders the template per record and produces synchronously.
// Template context: .Index (1-based), .Timestamp (unix ms), .Topic.
func (s *GenerateService) Generate(ctx context.Context, in domain.GenerateInput) (domain.GenerateResult, error) {
	if in.Count < 1 || in.Count > 100_000 {
		return domain.GenerateResult{}, fmt.Errorf("%w: count must be 1..100000", domain.ErrInvalid)
	}
	if in.Topic == "" {
		return domain.GenerateResult{}, fmt.Errorf("%w: topic is required", domain.ErrInvalid)
	}
	tmplSrc := in.Template
	if strings.TrimSpace(tmplSrc) == "" {
		// Sensible default: a JSON record varying by index and time.
		tmplSrc = `{"id":{{.Index}},"ts":{{.Timestamp}},"payload":"sample message {{.Index}}"}`
	}
	tmpl, err := template.New("gen").Parse(tmplSrc)
	if err != nil {
		return domain.GenerateResult{}, fmt.Errorf("%w: bad template: %v", domain.ErrInvalid, err)
	}
	client, err := s.pool.Acquire(ctx, in.ConnectionID)
	if err != nil {
		return domain.GenerateResult{}, err
	}

	start := time.Now()
	first := int64(-1)
	for i := 1; i <= in.Count; i++ {
		var buf bytes.Buffer
		if err := tmpl.Execute(&buf, map[string]any{
			"Index":     i,
			"Timestamp": time.Now().UnixMilli(),
			"Topic":     in.Topic,
		}); err != nil {
			return domain.GenerateResult{}, fmt.Errorf("render template at %d: %w", i, err)
		}
		key := []byte(fmt.Sprintf("%s-%d", in.KeyPrefix, i))
		if in.KeyPrefix == "" {
			key = []byte(fmt.Sprintf("gen-%d", i))
		}
		res, err := client.Produce(ctx, in.Topic, nil, key, buf.Bytes(), nil)
		if err != nil {
			return domain.GenerateResult{Produced: i - 1, FirstOffset: first, ElapsedMs: time.Since(start).Milliseconds()},
				fmt.Errorf("produce %d/%d: %w", i, in.Count, err)
		}
		if first < 0 {
			first = res.Offset
		}
	}
	return domain.GenerateResult{Produced: in.Count, FirstOffset: first, ElapsedMs: time.Since(start).Milliseconds()}, nil
}

// MessageIOService imports and exports message batches.
type MessageIOService struct {
	pool *kafka.Pool
}

func NewMessageIOService(pool *kafka.Pool) *MessageIOService { return &MessageIOService{pool: pool} }

// Export returns the selected window as raw text in the requested format
// (jsonl = one JSON object per line; csv = key,value,timestamp,partition,offset).
// Text is returned to the wails layer (which owns the file dialog) instead of
// the service touching the filesystem.
func (s *MessageIOService) Export(ctx context.Context, in domain.ExportMessagesInput) (string, error) {
	client, err := s.pool.Acquire(ctx, in.ConnectionID)
	if err != nil {
		return "", err
	}
	partition := int32(0) //nolint:gosec // default partition
	if in.Partition != nil {
		partition = *in.Partition
	}
	// Anchor at From and page forward until To (inclusive) or exhaustion.
	var anchor int64 = in.From
	var lines []string
	limit := 500
	for {
		page, err := client.BrowsePage(ctx, domain.BrowseRequest{
			ConnectionID: in.ConnectionID, Topic: in.Topic, Partition: &partition,
			StartOffset: &anchor, Direction: "forward", Limit: limit,
		})
		if err != nil {
			return "", err
		}
		for _, m := range page.Messages {
			// To is OPTIONAL (nil = export to the end) — the dialog's default
			// empty field sends null. Dereferencing it unconditionally
			// panicked on the primary export path.
			if in.To != nil && m.Offset > *in.To {
				return renderExport(lines, in.Format), nil
			}
			lines = append(lines, exportRow(m, in.Format))
		}
		if page.Exhausted || page.NextAnchor == nil {
			break
		}
		if len(lines) > 1_000_000 { // hard cap: a runaway export must not eat RAM
			return "", fmt.Errorf("%w: export exceeds 1M records", domain.ErrInvalid)
		}
		anchor = *page.NextAnchor
	}
	return renderExport(lines, in.Format), nil
}

func exportRow(m domain.Message, format string) string {
	key, _ := decodeText(m.Key)
	value, _ := decodeText(m.Value)
	if format == "csv" {
		return csvRecord([]string{key, value, m.Timestamp.Time().Format(time.RFC3339), fmt.Sprint(m.Partition), fmt.Sprint(m.Offset)})
	}
	// jsonl: keep the wire shape, embed decoded strings for readability.
	b, _ := json.Marshal(map[string]any{
		"topic": m.Topic, "partition": m.Partition, "offset": m.Offset,
		"timestamp": m.Timestamp.Time().Format(time.RFC3339Nano),
		"key":       key, "value": value, "valueSize": m.ValueSize,
	})
	return string(b)
}

func renderExport(lines []string, format string) string {
	if format == "csv" {
		lines = append([]string{"key,value,timestamp,partition,offset"}, lines...)
	}
	return strings.Join(lines, "\n")
}

func csvRecord(fields []string) string {
	var b strings.Builder
	w := csv.NewWriter(&b)
	_ = w.Write(fields)
	w.Flush()
	return strings.TrimRight(b.String(), "\r\n")
}

func decodeText(b64 string) (string, bool) {
	if b64 == "" {
		return "", true
	}
	raw, err := base64Decode(b64)
	if err != nil {
		return "", false
	}
	return raw, true
}

// ImportFile produces the parsed records of an import payload.
func (s *MessageIOService) Import(ctx context.Context, in domain.GenerateInput) (domain.GenerateResult, error) {
	// Reuse the generator's count/topic fields; Template carries the JSONL payload.
	client, err := s.pool.Acquire(ctx, in.ConnectionID)
	if err != nil {
		return domain.GenerateResult{}, err
	}
	start := time.Now()
	first := int64(-1)
	count := 0
	for i, line := range strings.Split(strings.ReplaceAll(in.Template, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var rec domain.ImportedMessage
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			return domain.GenerateResult{Produced: count, FirstOffset: first, ElapsedMs: time.Since(start).Milliseconds()},
				fmt.Errorf("%w: line %d is not valid JSON: %v", domain.ErrInvalid, i+1, err)
		}
		var key, value []byte
		if rec.Key != nil {
			key = []byte(*rec.Key)
		}
		if rec.Value != nil {
			value = []byte(*rec.Value)
		}
		headers := make([]domain.MessageHeader, 0, len(rec.Headers))
		for hk, hv := range rec.Headers {
			headers = append(headers, domain.MessageHeader{Key: hk, Value: encodeB64([]byte(hv))})
		}
		res, err := client.Produce(ctx, in.Topic, rec.Partition, key, value, headers)
		if err != nil {
			return domain.GenerateResult{Produced: count, FirstOffset: first, ElapsedMs: time.Since(start).Milliseconds()},
				fmt.Errorf("import line %d: %w", i+1, err)
		}
		if first < 0 {
			first = res.Offset
		}
		count++
	}
	return domain.GenerateResult{Produced: count, FirstOffset: first, ElapsedMs: time.Since(start).Milliseconds()}, nil
}
