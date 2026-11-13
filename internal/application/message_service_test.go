package application

// Pins the b64Strict contract (044 review round, user decision): Produce
// Key/Value are base64 ONLY. The old b64OrRaw lenient fallback reinterpreted
// invalid base64 as raw text, which silently corrupted plain text that
// happens to be valid base64 ("test" → 3 garbage bytes) and made the wire
// contract ambiguous.

import (
	"strings"
	"testing"
)

func TestB64Strict(t *testing.T) {
	// valid base64 decodes
	b, err := b64Strict("键", "aGVsbG8=")
	if err != nil {
		t.Fatalf("valid base64 rejected: %v", err)
	}
	if string(b) != "hello" {
		t.Fatalf("decoded %q, want %q", b, "hello")
	}

	// empty string = empty bytes (NOT nil — absent field is the null case)
	b, err = b64Strict("键", "")
	if err != nil {
		t.Fatalf("empty rejected: %v", err)
	}
	if b == nil || len(b) != 0 {
		t.Fatalf("empty must decode to empty non-nil bytes, got %v", b)
	}

	// invalid base64 → friendly error naming the field, never raw fallback
	_, err = b64Strict("值", "这不是 base64！！")
	if err == nil {
		t.Fatal("REGRESSION: invalid base64 silently accepted as raw text")
	}
	if !strings.Contains(err.Error(), "值") || !strings.Contains(err.Error(), "不是合法 base64") {
		t.Fatalf("error must name the field and say base64, got: %v", err)
	}
	// the friendly-errors policy: actionable hint rides the same sentence
	if !strings.Contains(err.Error(), "脚本直调请先 base64 编码") {
		t.Fatalf("error must carry the how-to-fix hint, got: %v", err)
	}
}
