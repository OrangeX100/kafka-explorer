package app

// pickRegistryFor resolves WHICH saved registry decodes a connection's
// schema ids: the registry bound to that connection wins; otherwise the
// first unbound (global) registry keeps one-registry setups working; when
// every registry is bound to other connections, nil — the caller must
// surface a friendly error instead of silently decoding against a wrong
// registry (same schema id, different clusters = different payloads).

import (
	"kafkaexplorer/internal/domain"
)

func pickRegistryFor(registries []domain.SchemaRegistry, connectionID string) *domain.SchemaRegistry {
	for i := range registries {
		if registries[i].ConnectionID == connectionID {
			return &registries[i]
		}
	}
	for i := range registries {
		if registries[i].ConnectionID == "" {
			return &registries[i]
		}
	}
	return nil
}
