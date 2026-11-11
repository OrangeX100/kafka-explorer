package decode

import (
	"encoding/binary"
	"testing"

	"github.com/hamba/avro/v2"
)

// Reproduce the EOF seen in DecodeLocal against a real-shaped record:
// 0x00 + BE schema id + avro-encoded User(id int, name string).
func TestDecodeWithSchemaConfluentFramed(t *testing.T) {
	schema := `{"type":"record","name":"User","fields":[{"name":"id","type":"int"},{"name":"name","type":"string"},{"name":"email","type":"string","default":""}]}`
	parsed, err := avro.Parse(schema)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := avro.Marshal(parsed, map[string]any{"id": 1, "name": "u", "email": ""})
	if err != nil {
		t.Fatal(err)
	}
	raw := make([]byte, 0, 5+len(payload))
	raw = append(raw, 0x00)
	raw = binary.BigEndian.AppendUint32(raw, 7)
	raw = append(raw, payload...)

	got := DecodeWithSchema(raw, schema)
	if got.Error != "" {
		t.Fatalf("decode error: %s", got.Error)
	}

	// Evolution: a v1 payload (id+name only) against the NEWER schema (which
	// adds email with a default) must decode via the defaulted-field prune.
	v1, err := avro.Marshal(avro.MustParse(`{"type":"record","name":"User","fields":[{"name":"id","type":"int"},{"name":"name","type":"string"}]}`), map[string]any{"id": 57, "name": "user-057"})
	if err != nil {
		t.Fatal(err)
	}
	v1raw := make([]byte, 0, 5+len(v1))
	v1raw = append(v1raw, 0x00)
	v1raw = binary.BigEndian.AppendUint32(v1raw, 1)
	v1raw = append(v1raw, v1...)
	got2 := DecodeWithSchema(v1raw, schema) // schema HAS email; payload does not
	if got2.Error != "" {
		t.Fatalf("evolution decode error: %s", got2.Error)
	}
	if !contains(got2.Text, "user-057") {
		t.Fatalf("evolution decode lost name: %s", got2.Text)
	}
	t.Logf("evolution decoded: %s", got2.Text)
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}
