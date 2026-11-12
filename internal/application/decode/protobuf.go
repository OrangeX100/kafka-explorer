package decode

// Confluent-framed Protobuf decoding: the registry stores the schema as a
// base64-encoded FileDescriptorSet and the wire payload is a raw protobuf
// message (no field framing), so decoding needs a dynamic message built
// from the descriptor. Uses google.golang.org/protobuf only — no protoc
// or generated types.

import (
	"encoding/base64"
	"encoding/json"
	"fmt"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"

	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/dynamicpb"
)

// decodeProtobufJSON renders one Confluent-framed Protobuf payload as
// JSON. schemaB64 is the registry's schema field: base64 of a serialized
// FileDescriptorSet. The first message type in the set is the message
// used (Confluent registers one subject per message; multi-message files
// are rare and the UI notes the convention).
func decodeProtobufJSON(payload []byte, schemaB64 string) Result {
	raw, err := base64.StdEncoding.DecodeString(schemaB64)
	if err != nil {
		return Result{Format: "protobuf", Error: "protobuf schema 不是合法的 FileDescriptorSet base64 文本"}
	}
	var fds descriptorpb.FileDescriptorSet
	if err := proto.Unmarshal(raw, &fds); err != nil {
		return Result{Format: "protobuf", Error: fmt.Sprintf("解析 FileDescriptorSet 失败: %v", err)}
	}
	files, err := protodesc.NewFiles(&fds)
	if err != nil {
		return Result{Format: "protobuf", Error: fmt.Sprintf("构建描述符失败: %v", err)}
	}
	md, err := firstMessageDesc(files)
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

// firstMessageDesc returns the first message descriptor found across the
// descriptor set's files.
func firstMessageDesc(files *protoregistry.Files) (protoreflect.MessageDescriptor, error) {
	var found protoreflect.MessageDescriptor
	files.RangeFiles(func(fd protoreflect.FileDescriptor) bool {
		ms := fd.Messages()
		for i := 0; i < ms.Len(); i++ {
			found = ms.Get(i)
			return false // stop ranging
		}
		return true // keep looking (proto-only files carry no messages)
	})
	if found == nil {
		return nil, fmt.Errorf("描述集中没有消息类型")
	}
	return found, nil
}
