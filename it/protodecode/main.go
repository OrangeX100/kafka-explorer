//go:build ignore

// protodecode: offline verification of the protobuf decode path against
// a REAL registry + topic: fetch the schema id via the SR API, consume
// one Confluent-framed record, run it through the same decode functions
// the app uses, and print the decoded JSON.
//
//	go run ./it/protodecode/main.go -registry http://localhost:8081 \
//	    -brokers localhost:9092 -topic proto-text-probe-value -id 9
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"

	"kafkaexplorer/internal/application/decode"
)

func main() {
	registry := flag.String("registry", "http://localhost:8081", "schema registry url")
	brokers := flag.String("brokers", "localhost:9092", "kafka seed brokers")
	topic := flag.String("topic", "proto-probe-value", "topic name")
	schemaID := flag.Int("id", 9, "schema id to fetch")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// fetch the schema via the SR API (what the app's fetcher does)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/schemas/ids/%d", *registry, *schemaID), nil)
	req.Header.Set("Accept", "application/vnd.schemaregistry.v1+json")
	resp, err := http.DefaultClient.Do(req)
	must(err)
	var out struct {
		SchemaType string `json:"schemaType"`
		Schema     string `json:"schema"`
		ID         int    `json:"id"`
	}
	must(json.NewDecoder(resp.Body).Decode(&out))
	resp.Body.Close()
	fmt.Printf("schema: id=%d type=%s len=%d\n", out.ID, out.SchemaType, len(out.Schema))

	// consume ONE record (largest offset first)
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(strings.Split(*brokers, ",")...),
		kgo.ConsumeTopics(*topic),
		kgo.FetchMaxBytes(1 << 20),
	)
	must(err)
	defer cl.Close()

	recs := cl.PollRecords(ctx, 50)
	if recs.NumRecords() == 0 {
		fmt.Println("no records (poll timeout)")
		return
	}
	var raw []byte
	recs.EachError(func(_ string, _ int32, err error) { fmt.Println("fetch err:", err) })
	recs.EachRecord(func(r *kgo.Record) { raw = append([]byte(nil), r.Value...) })

	fmt.Printf("wire: len=%d magic=0x%02x schemaID=%d\n", len(raw), raw[0], binary.BigEndian.Uint32(raw[1:5]))

	// the app's decode path: RegistryClient-style fetch + decodeConfluent
	reg := decode.NewRegistryDecoder(func(_ context.Context, id int) (string, string, error) {
		// SR gave us the latest; answer any id with it
		return out.Schema, out.SchemaType, nil
	})
	result := decode.DecodeValue(ctx, raw, "auto", reg)
	fmt.Printf("decoded: format=%s error=%q\n", result.Format, result.Error)
	if result.Error == "" {
		fmt.Println("text head:", result.Text[:min(200, len(result.Text))])
	} else {
		panic("app decode path FAILED: " + result.Error)
	}
	fmt.Println("schema head:", out.Schema[:min(80, len(out.Schema))])
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
