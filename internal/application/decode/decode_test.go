package decode

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/binary"
	"strings"
	"testing"

	"github.com/klauspost/compress/snappy"
	"github.com/klauspost/compress/zstd"
	"github.com/pierrec/lz4/v4"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/dynamicpb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// fakeRegistry answers SchemaByID from a static map — the decoder's only
// registry dependency.
type fakeRegistry map[int]struct {
	schema string
	typ    string
}

func (f fakeRegistry) SchemaByID(_ context.Context, id int) (string, string, error) {
	if v, ok := f[id]; ok {
		return v.schema, v.typ, nil
	}
	return "", "", context.Canceled
}

// framed wraps a payload in the Confluent wire header (magic + schema id).
func framed(schemaID int, payload []byte) []byte {
	out := make([]byte, 5+len(payload))
	out[0] = 0x00
	binary.BigEndian.PutUint32(out[1:5], uint32(schemaID))
	copy(out[5:], payload)
	return out
}

func TestJSONSchemaFrameDecodes(t *testing.T) {
	reg := fakeRegistry{101: {schema: `{"type":"object"}`, typ: "JSON"}}
	payload := framed(101, []byte(`{"id":1,"name":"probe"}`))
	r := DecodeValue(context.Background(), payload, "auto", reg)
	if r.Error != "" {
		t.Fatalf("error: %v", r.Error)
	}
	if r.Format != "json" {
		t.Fatalf("format = %q, want json", r.Format)
	}
	if !bytes.Contains([]byte(r.Text), []byte(`"probe"`)) {
		t.Fatalf("payload content missing: %q", r.Text)
	}
}

// TestProtobufFrameDecodes builds a real FileDescriptorSet (one message:
// id int64, name string), encodes a dynamic message, and runs the full
// Confluent-framed decode path against it.
func TestProtobufFrameDecodes(t *testing.T) {
	fdp := &descriptorpb.FileDescriptorProto{
		Name:    proto.String("probe.proto"),
		Package: proto.String("probe"),
		MessageType: []*descriptorpb.DescriptorProto{{
			Name: proto.String("Event"),
			Field: []*descriptorpb.FieldDescriptorProto{
				{Name: proto.String("id"), Number: proto.Int32(1), Type: descriptorpb.FieldDescriptorProto_TYPE_INT64.Enum(), Label: descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum()},
				{Name: proto.String("name"), Number: proto.Int32(2), Type: descriptorpb.FieldDescriptorProto_TYPE_STRING.Enum(), Label: descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum()},
			},
		}},
	}
	fds := &descriptorpb.FileDescriptorSet{File: []*descriptorpb.FileDescriptorProto{fdp}}
	fdsetBytes, err := proto.Marshal(fds)
	if err != nil {
		t.Fatalf("marshal fdset: %v", err)
	}

	files, err := protodesc.NewFiles(fds)
	if err != nil {
		t.Fatalf("build files: %v", err)
	}
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
		t.Fatal("no message in descriptor set")
	}
	msg := dynamicpb.NewMessage(md)
	setField(t, msg, "id", protoreflect.ValueOfInt64(7))
	setField(t, msg, "name", protoreflect.ValueOfString("hello"))
	payloadBytes, err := proto.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal message: %v", err)
	}

	reg := fakeRegistry{201: {schema: base64.StdEncoding.EncodeToString(fdsetBytes), typ: "PROTOBUF"}}
	r := DecodeValue(context.Background(), framed(201, payloadBytes), "auto", reg)
	if r.Error != "" {
		t.Fatalf("error: %v", r.Error)
	}
	if r.Format != "protobuf" {
		t.Fatalf("format = %q, want protobuf", r.Format)
	}
	if !bytes.Contains([]byte(r.Text), []byte(`"hello"`)) {
		t.Fatalf("decoded content missing: %q", r.Text)
	}
}

// TestProtobufTextSchemaDecodes runs the same framed decode against a
// registry that stores the schema as .proto SOURCE TEXT (the observed
// third-party registry behavior where a base64 FileDescriptorSet
// round-trips as empty). Same descriptor shape as the base64 test so the
// wire bytes are identical — only the stored schema representation
// differs. The schema also imports a well-known proto to prove embedded
// standard imports resolve.
const textSchema = `syntax = "proto3";

import "google/protobuf/timestamp.proto";

package probe;

message Event {
  int64 id = 1;
  string name = 2;
  google.protobuf.Timestamp at = 3;
}
`

func TestProtobufTextSchemaDecodes(t *testing.T) {
	fdp := &descriptorpb.FileDescriptorProto{
		Name:       proto.String("probe.proto"),
		Package:    proto.String("probe"),
		Dependency: []string{"google/protobuf/timestamp.proto"},
		MessageType: []*descriptorpb.DescriptorProto{{
			Name: proto.String("Event"),
			Field: []*descriptorpb.FieldDescriptorProto{
				{Name: proto.String("id"), Number: proto.Int32(1), Type: descriptorpb.FieldDescriptorProto_TYPE_INT64.Enum(), Label: descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum()},
				{Name: proto.String("name"), Number: proto.Int32(2), Type: descriptorpb.FieldDescriptorProto_TYPE_STRING.Enum(), Label: descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum()},
				{Name: proto.String("at"), Number: proto.Int32(3), Type: descriptorpb.FieldDescriptorProto_TYPE_MESSAGE.Enum(), Label: descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum(), TypeName: proto.String(".google.protobuf.Timestamp")},
			},
		}},
	}
	// encode-side descriptor set: the timestamp dependency must be in the
	// set (and before its dependent) for protodesc.NewFiles to link
	tsFdp := protodesc.ToFileDescriptorProto(timestamppb.File_google_protobuf_timestamp_proto)
	fds := &descriptorpb.FileDescriptorSet{File: []*descriptorpb.FileDescriptorProto{tsFdp, fdp}}
	files, err := protodesc.NewFiles(fds)
	if err != nil {
		t.Fatalf("build files: %v", err)
	}
	var md protoreflect.MessageDescriptor
	files.RangeFiles(func(fd protoreflect.FileDescriptor) bool {
		ms := fd.Messages()
		for i := 0; i < ms.Len(); i++ {
			if ms.Get(i).Name() == "Event" { // skip the timestamp dependency's messages
				md = ms.Get(i)
				return false
			}
		}
		return true
	})
	msg := dynamicpb.NewMessage(md)
	setField(t, msg, "id", protoreflect.ValueOfInt64(7))
	setField(t, msg, "name", protoreflect.ValueOfString("hello"))
	payloadBytes, err := proto.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal message: %v", err)
	}

	reg := fakeRegistry{202: {schema: textSchema, typ: "PROTOBUF"}}
	r := DecodeValue(context.Background(), framed(202, payloadBytes), "auto", reg)
	if r.Error != "" {
		t.Fatalf("error: %v", r.Error)
	}
	if r.Format != "protobuf" {
		t.Fatalf("format = %q, want protobuf", r.Format)
	}
	if !bytes.Contains([]byte(r.Text), []byte(`"hello"`)) {
		t.Fatalf("decoded content missing: %q", r.Text)
	}
}

// TestProtobufTextSchemaBroken proves a malformed .proto text schema
// reports a friendly Chinese error instead of a decode crash. Uses the
// routed mode (not auto): auto intentionally falls back to raw text on
// decode failure, which would swallow the error.
func TestProtobufTextSchemaBroken(t *testing.T) {
	reg := fakeRegistry{203: {schema: "syntax = \"proto3\"; message {{{", typ: "PROTOBUF"}}
	r := DecodeValue(context.Background(), framed(203, []byte{0x08, 0x01}), "avro", reg)
	if r.Error == "" {
		t.Fatal("expected an error for malformed proto text")
	}
	if !strings.Contains(r.Error, ".proto") {
		t.Fatalf("error should mention .proto parsing: %q", r.Error)
	}
}

func setField(t *testing.T, msg *dynamicpb.Message, name string, v protoreflect.Value) {
	t.Helper()
	f := msg.Descriptor().Fields().ByName(protoreflect.Name(name))
	if f == nil {
		t.Fatalf("field %q missing", name)
	}
	msg.Set(f, v)
}

func TestDecompressedGzipJSON(t *testing.T) {
	inner := []byte(`{"ok":true,"n":42}`)
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	w.Write(inner)
	w.Close()

	r := DecodeValue(context.Background(), buf.Bytes(), "auto", nil)
	if r.Error != "" {
		t.Fatalf("error: %v", r.Error)
	}
	if r.Format != "json" {
		t.Fatalf("format = %q, want json", r.Format)
	}
	if !bytes.Contains([]byte(r.Text), []byte("gzip 解压")) {
		t.Fatalf("container note missing: %q", r.Text)
	}
	if !bytes.Contains([]byte(r.Text), []byte(`"ok": true`)) {
		t.Fatalf("inner json missing: %q", r.Text)
	}
}

func TestDecompressCodecs(t *testing.T) {
	inner := []byte("payload-bytes")
	codecs := map[string][]byte{
		"gzip":   gzipBytes(t, inner),
		"zstd":   zstdBytes(t, inner),
		"lz4":    lz4Bytes(t, inner),
		"snappy": snappyBytes(t, inner),
	}
	for codec, raw := range codecs {
		out, name, ok := decompressContainer(raw)
		if !ok || name != codec {
			t.Fatalf("%s: ok=%v name=%q", codec, ok, name)
		}
		if !bytes.Equal(out, inner) {
			t.Fatalf("%s: round-trip mismatch: %q", codec, out)
		}
	}
}

func TestDecompressCapFallsBackToLabel(t *testing.T) {
	// 32MB of zeros compresses to a few KB but expands past the 16MB cap.
	raw := gzipBytes(t, bytes.Repeat([]byte{0}, 32<<20))
	if _, _, ok := decompressContainer(raw); ok {
		t.Fatal("cap not enforced — oversized payload decompressed")
	}
}

func gzipBytes(t *testing.T, inner []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	w.Write(inner)
	w.Close()
	return buf.Bytes()
}

func zstdBytes(t *testing.T, inner []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	w, err := zstd.NewWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	w.Write(inner)
	w.Close()
	return buf.Bytes()
}

func lz4Bytes(t *testing.T, inner []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := lz4.NewWriter(&buf)
	w.Write(inner)
	w.Close()
	return buf.Bytes()
}

func snappyBytes(t *testing.T, inner []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := snappy.NewBufferedWriter(&buf)
	w.Write(inner)
	w.Close()
	return buf.Bytes()
}

// ---- Confluent Protobuf message-indexes frames (044 review round) ----
//
// Standard Confluent SerDes append a message-indexes section after the
// 5-byte header; the pre-0.4.5 decoder fed those bytes straight into
// proto.Unmarshal and failed every standard record ("invalid field
// number" — index byte 0x00 is field number 0). These tests pin the
// bare-first-then-indexes contract.

func makeProbeFDSet(t *testing.T) (fdsB64 string, md protoreflect.MessageDescriptor) {
	t.Helper()
	return makeFDSetWithMessages(t, []*descriptorpb.DescriptorProto{{
		Name: proto.String("Event"),
		Field: []*descriptorpb.FieldDescriptorProto{
			{Name: proto.String("id"), Number: proto.Int32(1), Type: descriptorpb.FieldDescriptorProto_TYPE_INT64.Enum(), Label: descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum()},
			{Name: proto.String("name"), Number: proto.Int32(2), Type: descriptorpb.FieldDescriptorProto_TYPE_STRING.Enum(), Label: descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum()},
		},
	}})
}

func makeFDSetWithMessages(t *testing.T, msgs []*descriptorpb.DescriptorProto) (string, protoreflect.MessageDescriptor) {
	t.Helper()
	fdp := &descriptorpb.FileDescriptorProto{
		Name:        proto.String("probe.proto"),
		Package:     proto.String("probe"),
		MessageType: msgs,
	}
	fds := &descriptorpb.FileDescriptorSet{File: []*descriptorpb.FileDescriptorProto{fdp}}
	fdsetBytes, err := proto.Marshal(fds)
	if err != nil {
		t.Fatalf("marshal fdset: %v", err)
	}
	files, err := protodesc.NewFiles(fds)
	if err != nil {
		t.Fatalf("build files: %v", err)
	}
	var md protoreflect.MessageDescriptor
	files.RangeFiles(func(fd protoreflect.FileDescriptor) bool {
		ms := fd.Messages()
		if ms.Len() > 0 {
			md = ms.Get(0)
			return false
		}
		return true
	})
	if md == nil {
		t.Fatal("no message in descriptor set")
	}
	return base64.StdEncoding.EncodeToString(fdsetBytes), md
}

func buildProtoMsg(t *testing.T, md protoreflect.MessageDescriptor, id int64, name string) []byte {
	t.Helper()
	msg := dynamicpb.NewMessage(md)
	setField(t, msg, "id", protoreflect.ValueOfInt64(id))
	setField(t, msg, "name", protoreflect.ValueOfString(name))
	raw, err := proto.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal message: %v", err)
	}
	return raw
}

// TestProtobufSerDesTopLevelIndex: the standard [0] top-level frame (single
// 0x00 after the header) must decode — bare-first fails on the 0x00 byte
// and the indexes fallback carries the record.
func TestProtobufSerDesTopLevelIndex(t *testing.T) {
	fdsB64, md := makeProbeFDSet(t)
	payload := buildProtoMsg(t, md, 7, "hello")
	reg := fakeRegistry{201: {schema: fdsB64, typ: "PROTOBUF"}}
	r := DecodeValue(context.Background(), framed(201, append([]byte{0x00}, payload...)), "auto", reg)
	if r.Error != "" {
		t.Fatalf("standard SerDes [0] frame failed: %v", r.Error)
	}
	if !bytes.Contains([]byte(r.Text), []byte(`"hello"`)) {
		t.Fatalf("decoded content missing: %q", r.Text)
	}
}

// TestProtobufSerDesSecondMessageIndex: indexes [1] selects the schema's
// SECOND top-level message ([1] zigzag = 0x02, terminated by 0x00).
func TestProtobufSerDesSecondMessageIndex(t *testing.T) {
	fdsB64, _ := makeFDSetWithMessages(t, []*descriptorpb.DescriptorProto{
		{Name: proto.String("First"), Field: []*descriptorpb.FieldDescriptorProto{
			{Name: proto.String("id"), Number: proto.Int32(1), Type: descriptorpb.FieldDescriptorProto_TYPE_INT64.Enum(), Label: descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum()},
		}},
		{Name: proto.String("Event"), Field: []*descriptorpb.FieldDescriptorProto{
			{Name: proto.String("name"), Number: proto.Int32(2), Type: descriptorpb.FieldDescriptorProto_TYPE_STRING.Enum(), Label: descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum()},
		}},
	})
	reg := fakeRegistry{202: {schema: fdsB64, typ: "PROTOBUF"}}
	// Event bytes built by hand: field 2 (name) LEN "hi" = 0x12 0x02 'h' 'i'.
	// Under the FIRST message these bytes would fail (its field 2 is absent),
	// so success here proves the [1] index selected the second message.
	eventBytes := []byte{0x12, 0x02, 'h', 'i'}
	r := DecodeValue(context.Background(), framed(202, append([]byte{0x02, 0x00}, eventBytes...)), "auto", reg)
	if r.Error != "" {
		t.Fatalf("[1] index frame failed: %v", r.Error)
	}
	if !bytes.Contains([]byte(r.Text), []byte(`"hi"`)) {
		t.Fatalf("decoded content missing: %q", r.Text)
	}
}

// TestStripConfluentIndexes pins the byte-level parser directly.
func TestStripConfluentIndexes(t *testing.T) {
	cases := []struct {
		name    string
		in      []byte
		indexes []int
		body    []byte
		ok      bool
	}{
		{"top-level shortcut", []byte{0x00, 0x08, 0x01}, []int{0}, []byte{0x08, 0x01}, true},
		{"second message", []byte{0x02, 0x00, 0x08, 0x01}, []int{1}, []byte{0x08, 0x01}, true},
		{"nested path", []byte{0x02, 0x04, 0x00, 0x08, 0x01}, []int{1, 2}, []byte{0x08, 0x01}, true},
		{"empty payload", []byte{}, nil, []byte{}, false},
		{"truncated varint", []byte{0x80}, nil, []byte{0x80}, false},
		{"terminator only, no body", []byte{0x00}, []int{0}, []byte{}, true},
	}
	for _, tc := range cases {
		indexes, body, ok := stripConfluentIndexes(tc.in)
		if ok != tc.ok {
			t.Fatalf("%s: ok=%v want %v", tc.name, ok, tc.ok)
		}
		if ok {
			if len(indexes) != len(tc.indexes) {
				t.Fatalf("%s: indexes=%v want %v", tc.name, indexes, tc.indexes)
			}
			for i := range indexes {
				if indexes[i] != tc.indexes[i] {
					t.Fatalf("%s: indexes=%v want %v", tc.name, indexes, tc.indexes)
				}
			}
			if !bytes.Equal(body, tc.body) {
				t.Fatalf("%s: body=%v want %v", tc.name, body, tc.body)
			}
		}
	}
}
