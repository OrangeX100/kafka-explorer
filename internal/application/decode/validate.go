package decode

// Schema precheck: validate a registry/local schema BEFORE it is sent
// anywhere — friendly errors with no registry round trip. The protobuf
// branch reuses the decoder's dual-format reader (Confluent base64
// FileDescriptorSet AND .proto source text, well-known imports included),
// so anything this accepts is exactly what the decoder will accept.

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/hamba/avro/v2"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/types/descriptorpb"
)

// ValidateSchema parses one schema and reports the first problem in a
// user-facing message. schemaType: AVRO (default) | JSON | PROTOBUF.
func ValidateSchema(schemaType, schema string) error {
	switch schemaType {
	case "JSON":
		var v any
		if err := json.Unmarshal([]byte(schema), &v); err != nil {
			return fmt.Errorf("JSON Schema 不是合法的 JSON 文本: %v", err)
		}
		return nil
	case "PROTOBUF":
		return validateProtobufSchema(schema)
	default: // AVRO
		if _, err := avro.Parse(schema); err != nil {
			return fmt.Errorf("Avro schema 解析失败: %v", err)
		}
		return nil
	}
}

// DecodeLocalSchema decodes one raw payload against a caller-supplied
// schema — the offline path (local schema library). Branching mirrors the
// registry decode exactly: Avro via hamba, Protobuf dual-format dynamic
// messages, JSON pretty-printed.
func DecodeLocalSchema(schemaType, schema string, payload []byte) Result {
	switch schemaType {
	case "PROTOBUF":
		return decodeProtobufJSON(context.Background(), payload, schema)
	case "JSON":
		return prettyJSON(payload)
	default: // AVRO (the framing stripper handles Confluent-wrapped values)
		return DecodeWithSchema(payload, schema)
	}
}

// validateProtobufSchema runs the schema through the same build path the
// decoder uses (text → protocompile, else base64 FDSet) and proves a
// message type comes out of it — a schema without messages can never
// decode a Confluent-framed payload.
func validateProtobufSchema(schema string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var fds descriptorpb.FileDescriptorSet
	var entry string
	if isProtoText(schema) {
		built, err := compileProtoText(ctx, schema)
		if err != nil {
			return fmt.Errorf("解析 .proto 文本失败: %v", err)
		}
		fds = *built
		entry = compiledEntry
	} else {
		if _, err := decodeFDSet(schema, &fds); err != nil {
			return err
		}
		entry = entryFile(&fds)
	}
	files, err := protodesc.NewFiles(&fds)
	if err != nil {
		return fmt.Errorf("构建描述符失败: %v", err)
	}
	if _, err := firstMessageDesc(files, entry); err != nil {
		return err
	}
	return nil
}
