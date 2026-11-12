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

// decodeProtobufJSON renders one Confluent-framed Protobuf payload as
// JSON. schema is the registry's schema field for the record's schema id.
// The first message type in the resolved descriptor set is the message
// used (registries conventionally register one subject per message).
func decodeProtobufJSON(ctx context.Context, payload []byte, schema string) Result {
	if strings.ContainsAny(schema, "{};") {
		// .proto source text (see file comment): compile to descriptors.
		return decodeProtobufTextJSON(ctx, payload, schema)
	}
	raw, err := base64.StdEncoding.DecodeString(schema)
	if err != nil {
		return Result{Format: "protobuf", Error: "protobuf schema 不是合法的 FileDescriptorSet base64 文本"}
	}
	var fds descriptorpb.FileDescriptorSet
	if err := proto.Unmarshal(raw, &fds); err != nil {
		return Result{Format: "protobuf", Error: fmt.Sprintf("解析 FileDescriptorSet 描述集失败: %v", err)}
	}
	entry := ""
	if n := len(fds.GetFile()); n > 0 {
		entry = fds.GetFile()[0].GetName() // serializers put the schema's own file first
	}
	return decodeProtobufFDSetJSON(payload, &fds, entry)
}

// decodeProtobufTextJSON compiles .proto source text into a descriptor
// set and decodes the payload against it. Well-known imports
// (google/protobuf/*.proto) resolve from embedded descriptors; imports of
// other schema files cannot be resolved from one registry string and are
// reported as a friendly error.
func decodeProtobufTextJSON(ctx context.Context, payload []byte, source string) Result {
	const entry = "registry-schema.proto"
	resolver := protocompile.ResolverFunc(func(path string) (protocompile.SearchResult, error) {
		if path == entry {
			return protocompile.SearchResult{Source: strings.NewReader(source)}, nil
		}
		return protocompile.SearchResult{}, fmt.Errorf("schema 引用了导入 %q，注册中心未随 schema 提供该文件", path)
	})
	compiler := protocompile.Compiler{Resolver: protocompile.WithStandardImports(resolver)}
	compiled, err := compiler.Compile(ctx, entry)
	if err != nil {
		return Result{Format: "protobuf", Error: fmt.Sprintf("解析 .proto 文本失败: %v", err)}
	}
	// Dependencies first (post-order): protodesc.NewFiles requires a file's
	// imports registered before the file itself.
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
	return decodeProtobufFDSetJSON(payload, &descriptorpb.FileDescriptorSet{File: fdps}, entry)
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
