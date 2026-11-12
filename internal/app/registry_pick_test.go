package app

import (
	"testing"

	"kafkaexplorer/internal/domain"
)

func TestPickRegistryFor(t *testing.T) {
	mk := func() []domain.SchemaRegistry {
		return []domain.SchemaRegistry{
			{ID: "bound-a", ConnectionID: "conn-a"},
			{ID: "bound-b", ConnectionID: "conn-b"},
			{ID: "global", ConnectionID: ""},
		}
	}

	// exact binding wins
	if got := pickRegistryFor(mk(), "conn-b"); got == nil || got.ID != "bound-b" {
		t.Fatalf("want bound-b, got %+v", got)
	}
	// no binding for this connection → first global
	if got := pickRegistryFor(mk(), "conn-x"); got == nil || got.ID != "global" {
		t.Fatalf("want global fallback, got %+v", got)
	}
	// nothing global and nothing bound here → nil (caller surfaces an error,
	// never silently decodes against a foreign registry)
	foreign := []domain.SchemaRegistry{
		{ID: "bound-a", ConnectionID: "conn-a"},
		{ID: "bound-b", ConnectionID: "conn-b"},
	}
	if got := pickRegistryFor(foreign, "conn-x"); got != nil {
		t.Fatalf("want nil for all-foreign bindings, got %+v", got)
	}
	// unbound-only list (the pre-binding shape) still resolves
	solo := []domain.SchemaRegistry{{ID: "solo", ConnectionID: ""}}
	if got := pickRegistryFor(solo, "any"); got == nil || got.ID != "solo" {
		t.Fatalf("want solo global, got %+v", got)
	}
}
