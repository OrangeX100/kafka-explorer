package connect

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestBasicAuthHeader: a configured user/pass pair must reach every request
// as HTTP Basic auth (Confluent Cloud API key/secret); an unauthenticated
// client must send no Authorization header at all.
func TestBasicAuthHeader(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"4.2.0"}`))
	}))
	defer srv.Close()
	ctx := context.Background()

	c := New(srv.URL, "apikey-123", "secret-456")
	if _, err := c.Test(ctx); err != nil {
		t.Fatalf("test with auth: %v", err)
	}
	if want := "Basic YXBpa2V5LTEyMzpzZWNyZXQtNDU2"; got != want {
		t.Errorf("Authorization = %q, want %q", got, want)
	}

	// non-GET path must carry the header too
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		w.WriteHeader(200)
	}))
	defer srv2.Close()
	c2 := New(srv2.URL, "u", "p")
	if err := c2.RestartConnector(ctx, "x"); err != nil {
		t.Fatalf("restart with auth: %v", err)
	}
	if got == "" {
		t.Error("POST restart missing Authorization header")
	}

	c3 := New(srv.URL, "", "")
	if _, err := c3.Test(ctx); err != nil {
		t.Fatalf("test without auth: %v", err)
	}
	if got != "" {
		t.Errorf("unauthenticated client sent Authorization: %q", got)
	}
}
