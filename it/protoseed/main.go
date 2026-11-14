//go:build ignore

// protoseed seeds a REAL Schema Registry + topic with Confluent-framed
// PROTOBUF records so message decode has live protobuf data. Offline CLI:
//
//	go run ./it/protoseed/main.go -registry http://localhost:8081 \
//	    -brokers localhost:9092 -topic proto-probe-value -count 20
//
// Steps: register the .proto source text on subject <topic>-value with
// schemaType PROTOBUF (the observed registry stores protobuf schemas as
// source text; a base64 FileDescriptorSet round-trips as empty) → build
// the matching descriptor in memory to encode records → produce records
// framed with the returned schema id (Confluent wire: 0x00 + BE uint32 id
// + protobuf bytes).
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
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/dynamicpb"
)

// probeProtoText is both the registered schema and the in-memory
// descriptor's source of truth.
const probeProtoText = `syntax = "proto3";
package probe;

message ProtoEvent {
  int64 id = 1;
  string name = 2;
  double score = 3;
}
`

func main() {
	registry := flag.String("registry", "http://localhost:8081", "schema registry url")
	brokers := flag.String("brokers", "localhost:9092", "kafka seed brokers")
	topic := flag.String("topic", "proto-probe-value", "value-topic name (subject <topic>-value)")
	count := flag.Int("count", 20, "records to produce")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// 1. build the descriptor for Message ProtoEvent {int64 id, string name,
	//    double score} entirely in memory
	fdp := &descriptorpb.FileDescriptorProto{
		Name:    proto.String("probe.proto"),
		Package: proto.String("probe"),
		MessageType: []*descriptorpb.DescriptorProto{{
			Name: proto.String("ProtoEvent"),
			Field: []*descriptorpb.FieldDescriptorProto{
				{Name: proto.String("id"), Number: proto.Int32(1), Type: descriptorpb.FieldDescriptorProto_TYPE_INT64.Enum(), Label: descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum()},
				{Name: proto.String("name"), Number: proto.Int32(2), Type: descriptorpb.FieldDescriptorProto_TYPE_STRING.Enum(), Label: descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum()},
				{Name: proto.String("score"), Number: proto.Int32(3), Type: descriptorpb.FieldDescriptorProto_TYPE_DOUBLE.Enum(), Label: descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum()},
			},
		}},
	}
	fds := &descriptorpb.FileDescriptorSet{File: []*descriptorpb.FileDescriptorProto{fdp}}

	// 2. register the .proto text with schemaType PROTOBUF
	subject := *topic + "-value"
	schemaID, err := registerProto(ctx, *registry, subject, probeProtoText)
	must(err)
	fmt.Printf("protobuf schema registered: subject=%s id=%d\n", subject, schemaID)

	// 3. encode + produce records with the returned schema id
	files, err := protodesc.NewFiles(fds)
	must(err)
	var md protoreflect.MessageDescriptor
	files.RangeFiles(func(fd protoreflect.FileDescriptor) bool {
		ms := fd.Messages()
		for i := 0; i < ms.Len(); i++ {
			md = ms.Get(i)
			return false
		}
		return true
	})
	if md == nil {
		must(fmt.Errorf("描述集中没有消息类型"))
	}

	cl, err := kgo.NewClient(
		kgo.SeedBrokers(strings.Split(*brokers, ",")...),
		kgo.AllowAutoTopicCreation(),
	)
	must(err)
	defer cl.Close()
	time.Sleep(2 * time.Second)

	for i := 0; i < *count; i++ {
		msg := dynamicpb.NewMessage(md)
		setInt(msg, "id", int64(i))
		setString(msg, "name", fmt.Sprintf("proto-%03d", i))
		setDouble(msg, "score", float64(i)*0.5)
		payload, err := proto.Marshal(msg)
		must(err)
		// STANDARD Confluent SerDes frame: magic + schema id + message
		// indexes ([0] top-level = single 0x00) + message bytes. The old
		// frame here omitted the indexes — it was a non-standard shape the
		// decoder happened to accept, which masked the missing-indexes bug
		// until the 044 review round.
		value := make([]byte, 0, 6+len(payload))
		value = append(value, 0x00)
		value = binary.BigEndian.AppendUint32(value, uint32(schemaID))
		value = append(value, 0x00) // message indexes: [0] top-level
		value = append(value, payload...)
		rec := &kgo.Record{Topic: *topic, Key: []byte(fmt.Sprintf("pk-%03d", i)), Value: value}
		if err := cl.ProduceSync(ctx, rec).FirstErr(); err != nil {
			panic(fmt.Sprintf("produce %d: %v", i, err))
		}
	}
	fmt.Printf("done: %d Confluent-framed PROTOBUF records -> %s\n", *count, *topic)
}

func registerProto(ctx context.Context, base, subject, schema string) (int, error) {
	body, _ := json.Marshal(map[string]any{
		"schemaType": "PROTOBUF",
		"schema":     schema,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		base+"/subjects/"+subject+"/versions", strings.NewReader(string(body)))
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
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.ID == 0 {
		return 0, fmt.Errorf("register %s: HTTP %d", subject, resp.StatusCode)
	}
	return out.ID, nil
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func setInt(msg protoreflect.Message, name string, v int64) {
	f := msg.Descriptor().Fields().ByName(protoreflect.Name(name))
	msg.Set(f, protoreflect.ValueOfInt64(v))
}

func setString(msg protoreflect.Message, name string, v string) {
	f := msg.Descriptor().Fields().ByName(protoreflect.Name(name))
	msg.Set(f, protoreflect.ValueOfString(v))
}

func setDouble(msg protoreflect.Message, name string, v float64) {
	f := msg.Descriptor().Fields().ByName(protoreflect.Name(name))
	msg.Set(f, protoreflect.ValueOfFloat64(v))
}
