package application

import (
	"bufio"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"text/template"
	"time"

	"kafkaexplorer/internal/application/decode"
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
	pool    *kafka.Pool
	decoder registrySchemaFetcher // nil = exports stay raw-text only
	// progress fires during file imports (done, failed, total lines) — the
	// wails layer bridges it to app events so the UI shows a live counter.
	progress func(done, failed, total int)
}

func NewMessageIOService(pool *kafka.Pool) *MessageIOService { return &MessageIOService{pool: pool} }

// SetSchemaFetcher wires the registry lookup used by schema-aware exports.
func (s *MessageIOService) SetSchemaFetcher(f registrySchemaFetcher) { s.decoder = f }

// SetProgress wires the import progress callback (nil = silent).
func (s *MessageIOService) SetProgress(f func(done, failed, total int)) { s.progress = f }

// exportPartitions resolves which partitions to walk: an explicit
// non-negative partition is honored, everything else (nil or -1) means ALL
// partitions, ids ascending.
func (s *MessageIOService) exportPartitions(ctx context.Context, client *kafka.Client, in domain.ExportMessagesInput) ([]int32, error) {
	if in.Partition != nil && *in.Partition >= 0 {
		return []int32{*in.Partition}, nil
	}
	return client.TopicPartitionIDs(ctx, in.Topic)
}

// exportWalk walks the From..To window per partition (cursors are
// per-partition by contract) and emits one rendered output line per record.
// Streaming by callback: ExportToFile writes as it goes, so a large export
// never buffers fully in RAM — the previous version accumulated every line
// (up to the 1M cap) before writing, despite its comment claiming otherwise.
func (s *MessageIOService) exportWalk(ctx context.Context, in domain.ExportMessagesInput, emit func(string) error) (int, error) {
	client, err := s.pool.Acquire(ctx, in.ConnectionID)
	if err != nil {
		return 0, err
	}
	partitions, err := s.exportPartitions(ctx, client, in)
	if err != nil {
		return 0, err
	}
	// Schema-aware rows: resolve through the SAME per-connection registry
	// binding the browse path uses (adapter carries the connection id).
	var registry decode.RegistryClient
	if in.Decoded && s.decoder != nil {
		registry = decodeAdapter{in.ConnectionID, s.decoder}
	}
	const limit = 500
	const maxLines = 1_000_000 // hard cap: a runaway export must not eat RAM
	written := 0
	for _, partition := range partitions {
		var anchor int64 = in.From
		for {
			page, err := client.BrowsePage(ctx, domain.BrowseRequest{
				ConnectionID: in.ConnectionID, Topic: in.Topic, Partition: &partition,
				StartOffset: &anchor, Direction: "forward", Limit: limit,
			})
			if err != nil {
				return written, err
			}
			for _, m := range page.Messages {
				// To is OPTIONAL (nil = export to the end) — the dialog's default
				// empty field sends null. Dereferencing it unconditionally
				// panicked on the primary export path.
				if in.To != nil && m.Offset > *in.To {
					break
				}
				if err := emit(exportRow(ctx, m, in.Format, registry)); err != nil {
					return written, err
				}
				written++
			}
			if in.To != nil && page.NextAnchor != nil && *page.NextAnchor > *in.To {
				return written, nil // the window closed inside this page
			}
			if page.Exhausted || page.NextAnchor == nil {
				break
			}
			if written > maxLines {
				return written, fmt.Errorf("%w: export exceeds 1M records", domain.ErrInvalid)
			}
			anchor = *page.NextAnchor
		}
	}
	return written, nil
}

// Export returns the selected window as raw text in the requested format
// (jsonl = one JSON object per line; csv = key,value,timestamp,partition,offset).
// Text is returned to the wails layer (which owns the clipboard) for the
// in-app copy path.
func (s *MessageIOService) Export(ctx context.Context, in domain.ExportMessagesInput) (string, error) {
	var lines []string
	if _, err := s.exportWalk(ctx, in, func(line string) error {
		lines = append(lines, line)
		return nil
	}); err != nil {
		return "", err
	}
	return renderExport(lines, in.Format), nil
}

// ExportToFile streams the same window into a file (path chosen by the
// user via the native save dialog) and returns the record count. Rows are
// written incrementally so a large export never buffers fully in RAM.
func (s *MessageIOService) ExportToFile(ctx context.Context, in domain.ExportMessagesInput, path string) (int64, error) {
	f, err := os.Create(path)
	if err != nil {
		return 0, fmt.Errorf("创建导出文件失败: %w", err)
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	if in.Format == "csv" {
		if _, err := w.WriteString(csvHeader + "\n"); err != nil {
			return 0, err
		}
	}
	count, err := s.exportWalk(ctx, in, func(line string) error {
		_, werr := w.WriteString(line + "\n")
		return werr
	})
	if ferr := w.Flush(); err == nil {
		err = ferr
	}
	return int64(count), err
}

func exportRow(ctx context.Context, m domain.Message, format string, registry decode.RegistryClient) string {
	key, _ := decodeText(m.Key)
	value, _ := decodeText(m.Value)
	if format == "csv" {
		return csvRecord([]string{key, value, m.Timestamp.Time().Format(time.RFC3339), fmt.Sprint(m.Partition), fmt.Sprint(m.Offset)})
	}
	// jsonl: keep the wire shape, embed decoded strings for readability.
	row := map[string]any{
		"topic": m.Topic, "partition": m.Partition, "offset": m.Offset,
		"timestamp": m.Timestamp.Time().Format(time.RFC3339Nano),
		"key":       key, "value": value, "valueSize": m.ValueSize,
	}
	// Schema-aware rows: decodedValue carries the decoder's rendering when
	// the payload is a framed schema type (Avro/Protobuf/JSON-Schema);
	// plain text/JSON payloads don't need a second copy of themselves.
	if registry != nil {
		if raw, err := base64DecodeBytes(value); err == nil && len(raw) > 0 {
			res := decode.DecodeValue(ctx, raw, "auto", registry)
			if res.Error == "" && res.Format != "text" {
				row["decodedValue"] = res.Text
				row["format"] = res.Format
			}
		}
	}
	b, _ := json.Marshal(row)
	return string(b)
}

const csvHeader = "key,value,timestamp,partition,offset"

func renderExport(lines []string, format string) string {
	if format == "csv" {
		lines = append([]string{csvHeader}, lines...)
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

// maxImportFile bounds a payload file before it hits memory (a 64 MB JSONL
// file is ~100k+ records — the produce loop is the real budget anyway).
const maxImportFile = 64 << 20

// ImportFromFile produces every record in a JSONL file (path from the
// native open dialog). Best-effort per line: good lines land, bad lines
// are collected with their 1-based line number; progress fires through the
// wired callback so the UI shows a live counter on long files.
func (s *MessageIOService) ImportFromFile(ctx context.Context, in domain.ImportFileInput) (domain.ImportFileResult, error) {
	info, err := os.Stat(in.Path)
	if err != nil {
		return domain.ImportFileResult{}, fmt.Errorf("读取导入文件失败: %w", err)
	}
	if info.Size() > maxImportFile {
		return domain.ImportFileResult{}, fmt.Errorf("导入文件过大（%d MB），上限 64 MB", info.Size()/(1<<20))
	}
	payload, err := os.ReadFile(in.Path)
	if err != nil {
		return domain.ImportFileResult{}, fmt.Errorf("读取导入文件失败: %w", err)
	}
	lines := strings.Split(strings.ReplaceAll(string(payload), "\r\n", "\n"), "\n")
	total := 0
	for _, line := range lines {
		if strings.TrimSpace(line) != "" {
			total++
		}
	}
	client, err := s.pool.Acquire(ctx, in.ConnectionID)
	if err != nil {
		return domain.ImportFileResult{}, err
	}
	start := time.Now()
	res := domain.ImportFileResult{}
	emit := func() {
		if s.progress != nil {
			s.progress(res.Produced, res.Failed, total)
		}
	}
	for i, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var rec domain.ImportedMessage
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			res.Failed++
			res.FailedLines = append(res.FailedLines, domain.ImportLineError{Line: i + 1, Error: fmt.Sprintf("不是合法的 JSON：%v", err)})
			emit()
			continue
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
		prod, err := client.Produce(ctx, in.Topic, rec.Partition, key, value, headers)
		if err != nil {
			res.Failed++
			res.FailedLines = append(res.FailedLines, domain.ImportLineError{Line: i + 1, Error: err.Error()})
			emit()
			continue
		}
		if res.FirstOffset == nil {
			off := prod.Offset
			res.FirstOffset = &off
		}
		res.Produced++
		// throttle: one event per 50 records keeps the UI live without spam
		if res.Produced%50 == 0 || res.Produced+res.Failed == total {
			emit()
		}
	}
	res.ElapsedMs = time.Since(start).Milliseconds()
	emit()
	return res, nil
}
