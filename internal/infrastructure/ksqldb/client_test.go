package ksqldb

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestExecParsesShowStreams pins the /ksql envelope parsing (typed rows for
// the SHOW families) and the Authorization header passthrough.
func TestExecParsesShowStreams(t *testing.T) {
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		if r.URL.Path != "/ksql" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"@type":"streams","statementText":"SHOW STREAMS;","streams":[
			{"name":"ORDERS","topic":"orders","keyFormat":"KAFKA","valueFormat":"JSON"},
			{"name":"CLICKS","topic":"clicks","keyFormat":"KAFKA","valueFormat":"AVRO","windowType":"Tumbling"}],"warnings":[]}]`))
	}))
	defer srv.Close()
	ctx := context.Background()
	c := New(srv.URL, "key", "secret")
	res, err := c.Exec(ctx, "SHOW STREAMS")
	if err != nil {
		t.Fatalf("exec: %v", err)
	}
	if auth != "Basic a2V5OnNlY3JldA==" {
		t.Errorf("auth header = %q", auth)
	}
	if len(res.Streams) != 2 || res.Streams[0].Name != "ORDERS" || res.Streams[1].WindowType != "Tumbling" {
		t.Fatalf("streams parsed wrong: %+v", res.Streams)
	}
	if res.StatementText != "SHOW STREAMS;" {
		t.Errorf("statementText = %q", res.StatementText)
	}
}

// TestQueryStreamDelimited: the delimited wire format — first line is the
// header, following lines are rows; push-query style endless streams exit
// cleanly on context cancellation.
func TestQueryStreamDelimited(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Accept") != "application/vnd.ksqlapi.delimited.v1" {
			t.Errorf("Accept = %q", r.Header.Get("Accept"))
		}
		w.Header().Set("Content-Type", "application/vnd.ksqlapi.delimited.v1")
		f := w.(http.Flusher)
		// Real 8.0.0 wire format: the first line is a meta OBJECT with
		// columnNames; rows are arrays.
		_, _ = w.Write([]byte(`{"queryId":"t1","columnNames":["ROWTIME","NAME"],"columnTypes":["BIGINT","VARCHAR"]}` + "\n"))
		f.Flush()
		for i := 0; ; i++ {
			_, _ = w.Write([]byte(`[1700000000000,"row-` + strings.Repeat("x", i%10) + `"]` + "\n"))
			f.Flush()
			select {
			case <-r.Context().Done():
				return
			default:
			}
			// no sleep: rows stream as fast as the reader drains them
		}
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 800*1e6)
	defer cancel()
	c := New(srv.URL, "", "")
	rows := 0
	headerSeen := false
	err := c.QueryStream(ctx, "SELECT * FROM s EMIT CHANGES", func(header []string, row []any) error {
		if row == nil {
			headerSeen = len(header) == 2 && header[0] == "ROWTIME"
			return nil
		}
		rows++
		if row[1] == nil {
			t.Fatalf("row value nil: %v", row)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("query stream: %v", err)
	}
	if !headerSeen {
		t.Fatal("column header not delivered")
	}
	if rows == 0 {
		t.Fatal("no rows streamed")
	}
	// rows must parse as JSON arrays (they did in the handler); sanity: the
	// count is bounded by the 800ms window, not infinite.
	if rows > 10_000_000 {
		t.Fatalf("unbounded rows? %d", rows)
	}
}

// TestInfoAndErrorShape covers /info parsing and the APIError message carry.
func TestInfoAndErrorShape(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/info", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"KsqlServerInfo":{"version":"8.0.0","ksqlServiceId":"ksql-explorer-01","serverStatus":"RUNNING"}}`))
	})
	mux.HandleFunc("/ksql", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error_code":40001,"message":{"targets":[{"description":"Cannot find topic"}]}}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	ctx := context.Background()

	ver, sid, st, err := New(srv.URL, "", "").Info(ctx)
	if err != nil || ver != "8.0.0" || sid != "ksql-explorer-01" || st != "RUNNING" {
		t.Fatalf("info: %v %q %q %q", err, ver, sid, st)
	}

	_, err = New(srv.URL, "", "").Exec(ctx, "CREATE STREAM x WITH (kafka_topic='nope')")
	if err == nil {
		t.Fatal("expected 400 error")
	}
	if !strings.Contains(err.Error(), "ksqldb 400") {
		t.Fatalf("error shape: %v", err)
	}
	// the wrapped message may be an object — decodeError must not panic
	var api *APIError
	if ok := errorsAs(err, &api); !ok || api.Code != 400 {
		t.Fatalf("api error type: %v", err)
	}
}

func errorsAs(err error, target *(*APIError)) bool {
	for err != nil {
		if e, ok := err.(*APIError); ok {
			*target = e
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}
