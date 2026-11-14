package decode

// Confluent-framed Protobuf decoding: after the 5-byte magic+schema-id
// header the wire carries EITHER a raw protobuf message (legacy/privately
// produced writers) OR the standard SerDes message-indexes frame followed
// by the message bytes — decodeProtobufJSON tries bare first and falls
// back to stripping the indexes, so both writers decode. Decoding needs a
// dynamic message built from the registry's schema. Registries differ in
// HOW they store protobuf schemas and GET /schemas/ids/{id} simply returns
// whatever was stored:
//   - base64 of a serialized FileDescriptorSet (Confluent SR with the
//     kafka-protobuf-serializer family)
//   - .proto source text (several third-party registries; observed in the
//     wild where base64 input round-trips as empty)
// So the decoder accepts both: text is detected by its protobuf syntax
// (braces/semicolons — byte sequences base64 never contains) and compiled
// with protocompile; everything else goes down the FileDescriptorSet path.
// Uses google.golang.org/protobuf + bufbuild/protocompile only — no
// protoc or generated types.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/bufbuild/protocompile"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"

	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/dynamicpb"
)

// compiledEntry is the in-memory file name the registry's .proto text is
// compiled under; the resolver serves the schema at exactly this path.
const compiledEntry = "registry-schema.proto"

// isProtoText tells the two storage formats apart: .proto source always
// carries at least one of braces/semicolons, byte sequences base64 never
// produces.
func isProtoText(schema string) bool {
	return strings.ContainsAny(schema, "{};")
}

// compileProtoText compiles .proto source text into a descriptor set.
// Well-known imports (google/protobuf/*.proto) resolve from embedded
// descriptors; imports of other schema files cannot be resolved from one
// registry string and are reported as a friendly error. Dependencies are
// emitted first (post-order) — protodesc.NewFiles requires a file's
// imports registered before the file itself.
func compileProtoText(ctx context.Context, source string) (*descriptorpb.FileDescriptorSet, error) {
	resolver := protocompile.ResolverFunc(func(path string) (protocompile.SearchResult, error) {
		if path == compiledEntry {
			return protocompile.SearchResult{Source: strings.NewReader(source)}, nil
		}
		return protocompile.SearchResult{}, fmt.Errorf("schema 引用了导入 %q，注册中心未随 schema 提供该文件", path)
	})
	compiler := protocompile.Compiler{Resolver: protocompile.WithStandardImports(resolver)}
	compiled, err := compiler.Compile(ctx, compiledEntry)
	if err != nil {
		return nil, err
	}
	fdps := make([]*descriptorpb.FileDescriptorProto, 0, len(compiled))
	seen := map[string]bool{}
	var collect func(fd protoreflect.FileDescriptor)
	collect = func(fd protoreflect.FileDescriptor) {
		if fd == nil || seen[fd.Path()] {
			return
		}
		seen[fd.Path()] = true
		imps := fd.Imports()
		for i := 0; i < imps.Len(); i++ {
			collect(imps.Get(i).FileDescriptor) // field, not method
		}
		fdps = append(fdps, protodesc.ToFileDescriptorProto(fd))
	}
	for _, f := range compiled {
		collect(f)
	}
	return &descriptorpb.FileDescriptorSet{File: fdps}, nil
}

// decodeFDSet decodes the base64 payload into fds. Kept separate so both
// the decoder and the schema validator share the exact acceptance rules.
func decodeFDSet(schemaB64 string, fds *descriptorpb.FileDescriptorSet) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(schemaB64)
	if err != nil {
		return nil, fmt.Errorf("protobuf schema 不是合法的 FileDescriptorSet base64 文本")
	}
	if err := proto.Unmarshal(raw, fds); err != nil {
		return nil, fmt.Errorf("解析 FileDescriptorSet 描述集失败: %v", err)
	}
	return raw, nil
}

// entryFile returns the descriptor set's own (first) file name —
// serializers put the schema's file first, and it carries the message the
// payload was written with.
func entryFile(fds *descriptorpb.FileDescriptorSet) string {
	if n := len(fds.GetFile()); n > 0 {
		return fds.GetFile()[0].GetName()
	}
	return ""
}

// decodeProtobufJSON renders one Confluent-framed Protobuf payload as JSON.
// schema is the registry's schema field for the record's schema id.
// The schema's own file's first message is the message used (registries
// conventionally register one subject per message), unless the wire carries
// a message-index path pointing elsewhere.
//
// Wire order — bare first, then the Confluent message-indexes frame: the
// caller hands us the bytes AFTER the 5-byte magic+schema-id header, and
// two writers exist in the wild. Standard Confluent SerDes append a
// message-indexes section (a zigzag-varint array; a top-level message
// encodes as the single byte 0x00) which proto.Unmarshal rejects outright
// ("invalid field number") — the 044-round blind spot that failed EVERY
// standard SerDes-produced Protobuf record. Legacy / privately produced
// writers put the raw message right after the header. Trying bare first
// keeps those working; a bare parse ALWAYS fails on index-framed bytes
// (the array terminator 0x00 is field number 0), so the fallback cannot
// misfire on a truly index-framed payload.
func decodeProtobufJSON(ctx context.Context, payload []byte, schema string) Result {
	fds, entry, err := resolveProtobufSchema(ctx, schema)
	if err != nil {
		return Result{Format: "protobuf", Error: err.Error()}
	}
	bare := decodeProtobufFDSetJSON(payload, fds, entry, nil)
	if bare.Error == "" {
		return bare
	}
	indexes, body, ok := stripConfluentIndexes(payload)
	if !ok {
		return bare // not an indexes frame: the bare error is the real one
	}
	return decodeProtobufFDSetJSON(body, fds, entry, indexes)
}

// resolveProtobufSchema compiles/decodes the registry's schema (either
// storage format) once so both wire attempts share the descriptor set.
func resolveProtobufSchema(ctx context.Context, schema string) (*descriptorpb.FileDescriptorSet, string, error) {
	if isProtoText(schema) {
		fds, err := compileProtoText(ctx, schema)
		if err != nil {
			return nil, "", fmt.Errorf("解析 .proto 文本失败: %v", err)
		}
		return fds, compiledEntry, nil
	}
	var fds descriptorpb.FileDescriptorSet
	if _, err := decodeFDSet(schema, &fds); err != nil {
		return nil, "", err
	}
	return &fds, entryFile(&fds), nil
}

// stripConfluentIndexes splits a Confluent message-indexes frame into the
// index path and the raw protobuf bytes that follow it. ok=false means the
// bytes are not an indexes frame (malformed, or already bare) — callers
// keep the bare-payload error.
//
// Spec: each index is a zigzag varint and the array ends at the first 0
// varint — which doubles as the whole encoding for the top-level [0] case
// (single 0x00 byte, message follows immediately).
func stripConfluentIndexes(payload []byte) ([]int, []byte, bool) {
	if len(payload) == 0 {
		return nil, payload, false
	}
	indexes, n, ok := readZigzagVarints(payload)
	if !ok || len(indexes) == 0 {
		return nil, payload, false
	}
	return indexes, payload[n:], true
}

// readZigzagVarints decodes zigzag varints until the 0 terminator (which is
// consumed) and returns the decoded values plus the number of bytes
// consumed. The top-level [0] shortcut is normalized: a leading 0 varint
// reports exactly [0]. ok=false on truncation or oversized varints.
func readZigzagVarints(b []byte) ([]int, int, bool) {
	var out []int
	consumed := 0
	for {
		v, n, ok := readZigzagVarint(b[consumed:])
		if !ok {
			return nil, 0, false
		}
		consumed += n
		if v == 0 {
			if len(out) == 0 {
				out = []int{0} // [0] shortcut: the terminator IS the index
			}
			return out, consumed, true
		}
		out = append(out, int(v))
	}
}

// readZigzagVarint decodes one zigzag-encoded varint: value and byte count.
func readZigzagVarint(b []byte) (int64, int, bool) {
	var u uint64
	var shift uint
	for i, byteVal := range b {
		if i >= 10 { // a varint never exceeds 10 bytes
			return 0, 0, false
		}
		u |= uint64(byteVal&0x7F) << shift
		if byteVal&0x80 == 0 {
			return int64(u>>1) ^ -int64(u&1), i + 1, true
		}
		shift += 7
	}
	return 0, 0, false // truncated varint
}

// decodeProtobufFDSetJSON builds a dynamic message from the descriptor
// set, unmarshals the wire payload and renders it as pretty JSON.
// entryName selects which file carries the schema's own message (when
// empty, the first message anywhere in the set is used). indexes is the
// Confluent wire's message-index path (nil = first message).
func decodeProtobufFDSetJSON(payload []byte, fds *descriptorpb.FileDescriptorSet, entryName string, indexes []int) Result {
	files, err := protodesc.NewFiles(fds)
	if err != nil {
		return Result{Format: "protobuf", Error: fmt.Sprintf("构建描述符失败: %v", err)}
	}
	md, err := messageDescFor(files, entryName, indexes)
	if err != nil {
		return Result{Format: "protobuf", Error: err.Error()}
	}
	msg := dynamicpb.NewMessage(md)
	if err := proto.Unmarshal(payload, msg); err != nil {
		return Result{Format: "protobuf", Error: fmt.Sprintf("protobuf 解码失败: %v", err)}
	}
	asJSON, err := protojson.MarshalOptions{EmitUnpopulated: true}.Marshal(msg)
	if err != nil {
		return Result{Format: "protobuf", Error: fmt.Sprintf("转 JSON 失败: %v", err)}
	}
	var indented map[string]any
	if json.Unmarshal(asJSON, &indented) == nil {
		pretty, _ := json.MarshalIndent(indented, "", "  ")
		return Result{Format: "protobuf", Text: string(pretty)}
	}
	return Result{Format: "protobuf", Text: string(asJSON)}
}

// messageDescFor resolves the message descriptor the wire's index path
// points at. nil indexes (and the [0] shortcut) keep the historic "entry
// file's first message" behavior; a deeper path navigates the entry file's
// top-level messages, then nested types in order — that is the Confluent
// index semantics ([1,0] = second top-level message, its first nested type).
func messageDescFor(files *protoregistry.Files, entryName string, indexes []int) (protoreflect.MessageDescriptor, error) {
	if len(indexes) == 0 || (len(indexes) == 1 && indexes[0] == 0) {
		return firstMessageDesc(files, entryName)
	}
	fd, err := files.FindFileByPath(entryName)
	if err != nil {
		return nil, fmt.Errorf("无法定位 schema 文件 %q 以解析消息索引 %v", entryName, indexes)
	}
	ms := fd.Messages()
	if indexes[0] < 0 || indexes[0] >= ms.Len() {
		return nil, fmt.Errorf("消息索引 %v 超出 schema 的消息范围", indexes)
	}
	cur := ms.Get(indexes[0])
	for _, idx := range indexes[1:] {
		ns := cur.Messages() // nested message types, in declaration order
		if idx < 0 || idx >= ns.Len() {
			return nil, fmt.Errorf("消息索引 %v 超出 schema 的消息范围", indexes)
		}
		cur = ns.Get(idx)
	}
	return cur, nil
}

// firstMessageDesc returns the schema's own message descriptor: the
// entry file's first message, falling back to the first message across
// all files (sets without a resolvable entry or entry-less files).
func firstMessageDesc(files *protoregistry.Files, entryName string) (protoreflect.MessageDescriptor, error) {
	if entryName != "" {
		if fd, err := files.FindFileByPath(entryName); err == nil {
			if md := firstMsgInFile(fd); md != nil {
				return md, nil
			}
		}
	}
	var found protoreflect.MessageDescriptor
	files.RangeFiles(func(fd protoreflect.FileDescriptor) bool {
		if md := firstMsgInFile(fd); md != nil {
			found = md
			return false // stop ranging
		}
		return true // keep looking (proto-only files carry no messages)
	})
	if found == nil {
		return nil, fmt.Errorf("描述集中没有消息类型")
	}
	return found, nil
}

func firstMsgInFile(fd protoreflect.FileDescriptor) protoreflect.MessageDescriptor {
	ms := fd.Messages()
	for i := 0; i < ms.Len(); i++ {
		return ms.Get(i)
	}
	return nil
}
