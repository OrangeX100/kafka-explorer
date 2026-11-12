package decode

// Confluent-framed Protobuf decoding: the wire payload is a raw protobuf
// message (no field framing), so decoding needs a dynamic message built
// from the registry's schema. Registries differ in HOW they store protobuf
// schemas and GET /schemas/ids/{id} simply returns whatever was stored:
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

// decodeProtobufJSON renders one Confluent-framed Protobuf payload as
// JSON. schema is the registry's schema field for the record's schema id.
// The schema's own file's first message is the message used (registries
// conventionally register one subject per message).
func decodeProtobufJSON(ctx context.Context, payload []byte, schema string) Result {
	if isProtoText(schema) {
		fds, err := compileProtoText(ctx, schema)
		if err != nil {
			return Result{Format: "protobuf", Error: fmt.Sprintf("解析 .proto 文本失败: %v", err)}
		}
		return decodeProtobufFDSetJSON(payload, fds, compiledEntry)
	}
	var fds descriptorpb.FileDescriptorSet
	if _, err := decodeFDSet(schema, &fds); err != nil {
		return Result{Format: "protobuf", Error: err.Error()}
	}
	return decodeProtobufFDSetJSON(payload, &fds, entryFile(&fds))
}

// decodeProtobufFDSetJSON builds a dynamic message from the descriptor
// set, unmarshals the wire payload and renders it as pretty JSON.
// entryName selects which file carries the schema's own message (when
// empty, the first message anywhere in the set is used).
func decodeProtobufFDSetJSON(payload []byte, fds *descriptorpb.FileDescriptorSet, entryName string) Result {
	files, err := protodesc.NewFiles(fds)
	if err != nil {
		return Result{Format: "protobuf", Error: fmt.Sprintf("构建描述符失败: %v", err)}
	}
	md, err := firstMessageDesc(files, entryName)
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
