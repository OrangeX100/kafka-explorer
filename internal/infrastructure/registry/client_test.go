package registry

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The fake registry records the last request so tests can assert method,
// path and query the real Confluent endpoints were exercised.
type fakeRegistry struct {
	lastMethod string
	lastPath   string
	lastBody   map[string]string
}

func serve(t *testing.T, handler func(fr *fakeRegistry, w http.ResponseWriter, r *http.Request)) (*Client, *fakeRegistry) {
	t.Helper()
	fr := &fakeRegistry{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.Header.Get("Accept"), "application/vnd.schemaregistry") {
			// the client must speak the Confluent content type
		} else {
			t.Errorf("missing Confluent Accept header")
		}
		var body map[string]string
		if r.Body != nil {
			raw := make([]byte, 1024)
			n, _ := r.Body.Read(raw)
			if n > 0 {
				_ = json.Unmarshal(raw[:n], &body)
			}
		}
		fr.lastBody = body
		handler(fr, w, r)
	}))
	t.Cleanup(ts.Close)
	return New(ts.URL, "", ""), fr
}

func TestGetVersion(t *testing.T) {
	c, fr := serve(t, func(fr *fakeRegistry, w http.ResponseWriter, r *http.Request) {
		fr.lastMethod, fr.lastPath = r.Method, r.URL.Path
		w.Write([]byte(`{"subject":"user-value","version":2,"id":7,"schema":"{}"}`))
	})
	v, err := c.GetVersion(context.Background(), "user-value", 2)
	if err != nil {
		t.Fatal(err)
	}
	if v.Version != 2 || v.ID != 7 || v.SchemaType != "AVRO" {
		t.Fatalf("got %+v", v)
	}
	if fr.lastPath != "/subjects/user-value/versions/2" {
		t.Fatalf("path %s", fr.lastPath)
	}
}

func TestDeleteVersionPermanentQuery(t *testing.T) {
	c, fr := serve(t, func(fr *fakeRegistry, w http.ResponseWriter, r *http.Request) {
		fr.lastMethod, fr.lastPath = r.Method, r.URL.RawQuery
		w.Write([]byte(`{"id":3}`))
	})
	id, err := c.DeleteVersion(context.Background(), "s", 3, true)
	if err != nil || id != 3 {
		t.Fatalf("err=%v id=%d", err, id)
	}
	if fr.lastMethod != "DELETE" || fr.lastPath != "permanent=true" {
		t.Fatalf("method=%s query=%q", fr.lastMethod, fr.lastPath)
	}
	if _, err := c.DeleteVersion(context.Background(), "s", 3, false); err != nil {
		t.Fatal(err)
	}
	if fr.lastPath != "" {
		t.Fatalf("soft delete must not carry permanent: %q", fr.lastPath)
	}
}

func TestDeleteSubjectPermanent(t *testing.T) {
	c, fr := serve(t, func(fr *fakeRegistry, w http.ResponseWriter, r *http.Request) {
		fr.lastPath = r.URL.RawQuery
		w.Write([]byte(`[1,2]`))
	})
	if err := c.DeleteSubject(context.Background(), "s", true); err != nil {
		t.Fatal(err)
	}
	if fr.lastPath != "permanent=true" {
		t.Fatalf("query %q", fr.lastPath)
	}
}

func TestSubjectConfigPut(t *testing.T) {
	c, fr := serve(t, func(fr *fakeRegistry, w http.ResponseWriter, r *http.Request) {
		fr.lastMethod, fr.lastPath = r.Method, r.URL.Path
		if r.Method == "PUT" {
			w.Write([]byte(`{"compatibility":"FULL"}`))
			return
		}
		w.Write([]byte(`{"compatibilityLevel":"BACKWARD"}`))
	})
	if err := c.SetSubjectConfig(context.Background(), "user-value", "FULL"); err != nil {
		t.Fatal(err)
	}
	if fr.lastMethod != "PUT" || fr.lastPath != "/config/user-value" {
		t.Fatalf("method=%s path=%s", fr.lastMethod, fr.lastPath)
	}
	if fr.lastBody["compatibility"] != "FULL" {
		t.Fatalf("body %v", fr.lastBody)
	}
	lvl, err := c.GetSubjectConfig(context.Background(), "user-value")
	if err != nil || lvl != "BACKWARD" {
		t.Fatalf("lvl=%q err=%v", lvl, err)
	}
}

func TestGlobalConfig(t *testing.T) {
	c, fr := serve(t, func(fr *fakeRegistry, w http.ResponseWriter, r *http.Request) {
		fr.lastMethod, fr.lastPath = r.Method, r.URL.Path
		if r.Method == "PUT" {
			w.Write([]byte(`{"compatibility":"NONE"}`))
			return
		}
		w.Write([]byte(`{"compatibilityLevel":"FULL_TRANSITIVE"}`))
	})
	cfg, err := c.GetGlobalConfig(context.Background())
	if err != nil || cfg.CompatibilityLevel != "FULL_TRANSITIVE" {
		t.Fatalf("cfg=%+v err=%v", cfg, err)
	}
	if err := c.SetGlobalConfig(context.Background(), "NONE"); err != nil {
		t.Fatal(err)
	}
	if fr.lastMethod != "PUT" || fr.lastPath != "/config" || fr.lastBody["compatibility"] != "NONE" {
		t.Fatalf("method=%s path=%s body=%v", fr.lastMethod, fr.lastPath, fr.lastBody)
	}
}

func TestCheckCompatibilityVersionAnchors(t *testing.T) {
	c, fr := serve(t, func(fr *fakeRegistry, w http.ResponseWriter, r *http.Request) {
		fr.lastPath = r.URL.Path
		w.Write([]byte(`{"is_compatible":false,"messages":["field 'age' added without default"]}`))
	})
	check, err := c.CheckCompatibilityVersion(context.Background(), "s", 0, "{}", "")
	if err != nil {
		t.Fatal(err)
	}
	if check.IsCompatible || len(check.Messages) != 1 {
		t.Fatalf("check %+v", check)
	}
	if !strings.HasSuffix(fr.lastPath, "/versions/latest") {
		t.Fatalf("path %s", fr.lastPath)
	}
	if _, err := c.CheckCompatibilityVersion(context.Background(), "s", 2, "{}", "AVRO"); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(fr.lastPath, "/versions/2") {
		t.Fatalf("anchored path %s", fr.lastPath)
	}
}

func TestRegistryErrorSurfaces(t *testing.T) {
	c, _ := serve(t, func(fr *fakeRegistry, w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error_code":40401,"message":"Subject not found"}`))
	})
	_, err := c.GetVersion(context.Background(), "missing", 1)
	if err == nil || !strings.Contains(err.Error(), "Subject not found") {
		t.Fatalf("expected registry message in error, got %v", err)
	}
}
