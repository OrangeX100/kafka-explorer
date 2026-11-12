// Package decode turns raw record bytes into readable text: JSON
// pretty-print, Confluent wire-format payloads (magic 0x0 + 4-byte schema
// id + payload) resolved through a Schema Registry connection — Avro via
// hamba/avro, JSON Schema via pretty-print, Protobuf via dynamic messages
// from the registry's FileDescriptorSet — plus container decompression
// (gzip/snappy/lz4/zstd) ahead of the format probes.
package decode

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"

	"github.com/hamba/avro/v2"

	"kafkaexplorer/internal/domain"
)

// RegistryClient is the slice of the registry client the decoder needs.
type RegistryClient interface {
	SchemaByID(ctx context.Context, id int) (string, string, error) // schema, type, error
}

// Result reports what a decode pass produced. It is domain.DecodeResult
// aliased so the wire shape has one definition.
type Result = domain.DecodeResult

// DecodeValue decodes record value bytes according to the chosen strategy.
// auto: decompress safe containers, then try Confluent framing (needs
// registry; routes by the registered schema type), then JSON pretty, then
// fall back to UTF-8 text.
func DecodeValue(ctx context.Context, raw []byte, mode string, registry RegistryClient) Result {
	switch mode {
	case "text":
		return Result{Format: "text", Text: string(raw)}
	case "json":
		return prettyJSON(raw)
	case "avro":
		return decodeConfluent(ctx, raw, registry)
	default: // auto
		if isConfluentFramed(raw) {
			if r := decodeConfluent(ctx, raw, registry); r.Error == "" {
				return r
			}
		}
		// compressed containers: decompress and re-run the probes on the
		// inner bytes (gzip→inner JSON lands here as pretty JSON); the
		// annotation names the codec so the origin stays visible
		if inner, codec, ok := decompressContainer(raw); ok {
			inner2 := DecodeValue(ctx, inner, "auto", registry)
			if inner2.Error == "" && inner2.Format != "text" {
				return Result{Format: inner2.Format, Text: containerNote(codec, inner) + "\n" + inner2.Text}
			}
		}
		if r := prettyJSON(raw); r.Format == "json" {
			return r
		}
		return Result{Format: "text", Text: string(raw)}
	}
}

// isConfluentFramed checks the wire magic: 0x00 + 4-byte big-endian
// schema id + at least one payload byte. The magic is shared by all three
// Confluent schema types (Avro/JSON/Protobuf) — the registered schema
// type, not the magic, decides the decoder.
func isConfluentFramed(raw []byte) bool {
	return len(raw) > 5 && raw[0] == 0x00
}

// decodeConfluent resolves the schema id through the registry and routes
// by the registered schema type.
func decodeConfluent(ctx context.Context, raw []byte, registry RegistryClient) Result {
	if registry == nil {
		return Result{Format: "avro", Error: "no schema registry connection for this cluster"}
	}
	if len(raw) < 5 || raw[0] != 0x00 {
		return Result{Format: "avro", Error: "not Confluent-framed (missing magic byte)"}
	}
	schemaID := int(binary.BigEndian.Uint32(raw[1:5]))
	schemaStr, schemaType, err := registry.SchemaByID(ctx, schemaID)
	if err != nil {
		return Result{Format: "avro", Error: fmt.Sprintf("schema %d: %v", schemaID, err)}
	}
	payload := raw
	if len(payload) > 5 {
		payload = payload[5:] // strip Confluent framing
	}
	switch schemaType {
	case "JSON":
		return prettyJSON(payload)
	case "PROTOBUF":
		return decodeProtobufJSON(ctx, payload, schemaStr)
	default: // AVRO — ResolveBySchema semantics; framed or bare share a path
		return DecodeWithSchema(raw, schemaStr)
	}
}

// DecodeWithSchema decodes record bytes against a caller-supplied schema —
// the offline (local schema library) path, no registry involved. The
// Confluent wire header (magic 0x00 + schema id) is stripped when present,
// so framed and bare payloads share one code path.
//
// Evolution case: the schema carries fields the payload predates (a NEWER
// schema against OLDER records — the registry would resolve the exact
// version by id, but offline decoding only has the user's pick). Those
// trailing reads hit EOF, so on EOF we retry once with default-carrying
// fields pruned, which is exactly the older schema shape.
func DecodeWithSchema(raw []byte, schemaStr string) Result {
	if len(raw) > 5 && raw[0] == 0x00 {
		raw = raw[5:] // strip Confluent framing; payload follows
	}
	parsed, err := avro.Parse(schemaStr)
	if err != nil {
		return Result{Format: "avro", Error: fmt.Sprintf("parse schema: %v", err)}
	}
	var value any
	dec := avro.NewDecoderForSchema(parsed, bytes.NewReader(raw))
	if err := dec.Decode(&value); err != nil {
		trimmed, ok := pruneDefaultedFields(schemaStr)
		if !ok {
			return Result{Format: "avro", Error: fmt.Sprintf("decode payload: %v", err)}
		}
		parsed2, perr := avro.Parse(trimmed)
		if perr != nil {
			return Result{Format: "avro", Error: fmt.Sprintf("decode payload: %v", err)}
		}
		dec2 := avro.NewDecoderForSchema(parsed2, bytes.NewReader(raw))
		var value2 any
		if derr := dec2.Decode(&value2); derr != nil {
			return Result{Format: "avro", Error: fmt.Sprintf("decode payload: %v", err)}
		}
		value = value2
	}
	// Normalize through JSON so any Go type renders readably.
	asJSON, err := json.Marshal(value)
	if err != nil {
		return Result{Format: "avro", Text: fmt.Sprintf("%v", value)}
	}
	var indented map[string]any
	if json.Unmarshal(asJSON, &indented) == nil {
		pretty, _ := json.MarshalIndent(indented, "", "  ")
		return Result{Format: "avro", Text: string(pretty)}
	}
	return Result{Format: "avro", Text: string(asJSON)}
}

func prettyJSON(raw []byte) Result {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return Result{Format: "text", Text: string(raw)}
	}
	pretty, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return Result{Format: "text", Text: string(raw)}
	}
	return Result{Format: "json", Text: string(pretty)}
}

// pruneDefaultedFields strips top-level record fields that carry a default —
// the schema shape the payload predates. Returns ok=false when nothing can
// be pruned (not a record, no defaulted fields), so the caller keeps the
// original error.
func pruneDefaultedFields(schemaStr string) (string, bool) {
	var node struct {
		Type   string `json:"type"`
		Fields []struct {
			Name    string          `json:"name"`
			Default json.RawMessage `json:"default"`
		} `json:"fields"`
	}
	if err := json.Unmarshal([]byte(schemaStr), &node); err != nil || node.Type != "record" {
		return "", false
	}
	kept := 0
	for _, f := range node.Fields {
		if len(f.Default) == 0 {
			kept++
		}
	}
	if kept == len(node.Fields) || kept == 0 {
		return "", false
	}
	var raw map[string]any
	if err := json.Unmarshal([]byte(schemaStr), &raw); err != nil {
		return "", false
	}
	fields, _ := raw["fields"].([]any)
	var filtered []any
	for _, f := range fields {
		fm, _ := f.(map[string]any)
		if _, has := fm["default"]; !has {
			filtered = append(filtered, f)
		}
	}
	raw["fields"] = filtered
	out, err := json.Marshal(raw)
	if err != nil {
		return "", false
	}
	return string(out), true
}

// registryAdapter adapts the REST registry client to RegistryClient.
type registryAdapter struct {
	fetch func(ctx context.Context, id int) (string, string, error)
}

func (a registryAdapter) SchemaByID(ctx context.Context, id int) (string, string, error) {
	return a.fetch(ctx, id)
}

// NewRegistryDecoder wraps the infrastructure registry client by ID lookup
// closure. Returns nil when registryID is empty (no registry configured).
func NewRegistryDecoder(fetch func(ctx context.Context, id int) (string, string, error)) RegistryClient {
	if fetch == nil {
		return nil
	}
	return registryAdapter{fetch: fetch}
}
