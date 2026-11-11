//go:build ignore

// avroseed seeds a REAL Schema Registry + topic with Confluent-framed
// records so the registry module has live data to browse. Offline CLI:
//
//	go run -tags avroseed ./it/avroseed/main.go -registry http://localhost:8081 \
//	    -brokers localhost:9092 -topic sr-probe-value -count 60
//
// Steps: ensure topic → register user schema v1 (or reuse) → evolve to v2
// (email added) → produce records alternately framed with the two schema
// ids (Confluent wire: 0x00 + BE uint32 id + Avro payload).
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

	"github.com/hamba/avro/v2"
	"github.com/twmb/franz-go/pkg/kgo"
)

const userV1 = `{
  "type": "record",
  "name": "User",
  "fields": [
    {"name": "id", "type": "int"},
    {"name": "name", "type": "string"}
  ]
}`

const userV2 = `{
  "type": "record",
  "name": "User",
  "fields": [
    {"name": "id", "type": "int"},
    {"name": "name", "type": "string"},
    {"name": "email", "type": "string", "default": ""}
  ]
}`

const orderV1 = `{
  "type": "record",
  "name": "Order",
  "fields": [
    {"name": "order_id", "type": "string"},
    {"name": "amount", "type": "double"},
    {"name": "paid", "type": "boolean"}
  ]
}`

func main() {
	registry := flag.String("registry", "http://localhost:8081", "schema registry url")
	brokers := flag.String("brokers", "localhost:9092", "kafka seed brokers")
	topic := flag.String("topic", "sr-probe-value", "value-topic name (subject <topic>-value)")
	count := flag.Int("count", 60, "records to produce")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	idV1, err := register(ctx, *registry, *topic+"-value", userV1)
	must(err)
	fmt.Printf("user v1 registered: subject=%s-value id=%d\n", *topic, idV1)
	idV2, err := register(ctx, *registry, *topic+"-value", userV2)
	must(err)
	fmt.Printf("user v2 registered: id=%d\n", idV2)
	idOrder, err := register(ctx, *registry, "sr-orders-value", orderV1)
	must(err)
	fmt.Printf("order v1 registered: subject=sr-orders-value id=%d\n", idOrder)

	cl, err := kgo.NewClient(
		kgo.SeedBrokers(strings.Split(*brokers, ",")...),
		// The seed topic rarely pre-exists; franz-go refuses auto-creation
		// by default, so every ProduceSync would fail silently.
		kgo.AllowAutoTopicCreation(),
	)
	must(err)
	defer cl.Close()
	// wait for metadata / topic auto-creation
	time.Sleep(2 * time.Second)

	schemaV1 := avro.MustParse(userV1)
	schemaV2 := avro.MustParse(userV2)
	schemaOrder := avro.MustParse(orderV1)

	for i := 0; i < *count; i++ {
		var payload []byte
		var wireID uint32
		if i%5 == 4 {
			// every 5th record is an order on the orders topic shape (same
			// topic, different subject framing — decode falls back honestly)
			payload = avroEncode(schemaOrder, map[string]any{
				"order_id": fmt.Sprintf("ORD-%04d", i), "amount": float64(i) * 1.5, "paid": i%2 == 0,
			})
			wireID = uint32(idOrder)
		} else if i%3 == 2 {
			payload = avroEncode(schemaV2, map[string]any{
				"id": i, "name": fmt.Sprintf("user-%03d", i), "email": fmt.Sprintf("u%03d@example.com", i),
			})
			wireID = uint32(idV2)
		} else {
			payload = avroEncode(schemaV1, map[string]any{
				"id": i, "name": fmt.Sprintf("user-%03d", i),
			})
			wireID = uint32(idV1)
		}
		value := make([]byte, 0, 5+len(payload))
		value = append(value, 0x00)
		value = binary.BigEndian.AppendUint32(value, wireID)
		value = append(value, payload...)
		rec := &kgo.Record{Topic: *topic, Key: []byte(fmt.Sprintf("k-%03d", i)), Value: value}
		if err := cl.ProduceSync(ctx, rec).FirstErr(); err != nil {
			panic(fmt.Sprintf("produce %d: %v", i, err))
		}
		if i%20 == 0 {
			fmt.Printf("produced %d/%d\n", i, *count)
		}
	}
	fmt.Printf("done: %d Confluent-framed records -> %s\n", *count, *topic)
}

func register(ctx context.Context, base, subject, schema string) (int, error) {
	body, _ := json.Marshal(map[string]any{"schema": schema})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/subjects/"+subject+"/versions", strings.NewReader(string(body)))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/vnd.schemaregistry.v1+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	var out struct {
		ID int `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return 0, err
	}
	if out.ID == 0 {
		return 0, fmt.Errorf("register %s: unexpected response %d", subject, resp.StatusCode)
	}
	return out.ID, nil
}

func avroEncode(schema avro.Schema, value map[string]any) []byte {
	out, err := avro.Marshal(schema, value)
	must(err)
	return out
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
