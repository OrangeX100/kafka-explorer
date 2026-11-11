package application

import (
	"context"
	"encoding/base64"
	"fmt"

	"kafkaexplorer/internal/application/decode"
	"kafkaexplorer/internal/domain"
)

// Local-schema library lives on SchemaRegistryService (one handler surface
// for the whole registry module): local schema management — offline
// schemas kept in the app database for decoding when no registry is wired.
// The registryStore's wrapped DBWrapper carries the local_schemas repo.

func (s *SchemaRegistryService) ListLocalSchemas(ctx context.Context) ([]domain.LocalSchema, error) {
	return s.store.db.ListLocalSchemas(ctx)
}

func (s *SchemaRegistryService) SaveLocalSchema(ctx context.Context, schema domain.LocalSchema) (domain.LocalSchema, error) {
	if err := schema.Validate(); err != nil {
		return domain.LocalSchema{}, err
	}
	if schema.ID == "" {
		schema.ID = newID()
	}
	if schema.SchemaType == "" {
		schema.SchemaType = "AVRO"
	}
	return s.store.db.SaveLocalSchema(ctx, schema)
}

func (s *SchemaRegistryService) DeleteLocalSchema(ctx context.Context, id string) error {
	return s.store.db.DeleteLocalSchema(ctx, id)
}

// DecodeLocal decodes one base64 record payload against a local schema —
// the offline answer to Confluent-framed values when no registry connection
// is configured. Only Avro decodes today; other types are named, not faked.
func (s *SchemaRegistryService) DecodeLocal(ctx context.Context, schemaType, schema, payloadBase64 string) (domain.DecodeResult, error) {
	raw, err := base64.StdEncoding.DecodeString(payloadBase64)
	if err != nil {
		return domain.DecodeResult{}, fmt.Errorf("payload 不是合法的 base64: %w", err)
	}
	switch schemaType {
	case "AVRO", "":
		return decode.DecodeWithSchema(raw, schema), nil
	default:
		return domain.DecodeResult{}, fmt.Errorf("本地解码目前仅支持 Avro（收到 %s）", schemaType)
	}
}
