package domain

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// dtoTypes lists every DTO that crosses the wails boundary to the frontend.
// The frontend contracts type collection fields as required `T[]`; a nil Go
// slice marshals to JSON null and a `.map`/`.length` on it throws — the
// consumer-group members tab white-screened exactly this way (share-group
// members with a non-consumer assignment left Assignment nil). Adding a DTO
// here is one line; skipping the list skips the guard.
var dtoTypes = []any{
	TopicSummary{},
	TopicDetail{},
	PartitionSummary{},
	ConfigEntry{},
	Message{},
	MessageHeader{},
	ConsumerGroupSummary{},
	ConsumerGroupDetail{},
	GroupMember{},
	GroupPartitionOffset{},
	OffsetResetPlan{},
	OffsetResetTarget{},
	ShareGroupSummary{},
	ShareGroupDetail{},
	ShareMember{},
	SharePartitionOffset{},
	ShareGroupAlterTarget{},
	RateBucket{},
	RateScanWindow{},
	BrowseRequest{},
	BrowsePage{},
	FindRequest{},
	Connection{},
	ImportedMessage{},
	SchemaRegistry{},
	SchemaSubject{},
	SchemaVersion{},
	SchemaRef{},
	CompatibilityCheck{},
	GlobalConfig{},
	ConnectCluster{},
	LocalSchema{},
	ACL{},
	Quota{},
	BrokerSummary{},
	BrokerDetail{},
	LogDir{},
	LogDirTopic{},
	ClusterDiff{},
	TopicPairDiff{},
	TLSSettings{},
	QuorumInfo{},
	QuorumVoter{},
	GenerateInput{},
	GenerateResult{},
	ExportMessagesInput{},
}

// inputOnlyNullOK lists "Type.Field" pairs where null is acceptable because
// the struct only travels frontend → Go (an omitted JSON array decodes to a
// nil slice; the payload is never marshaled back).
var inputOnlyNullOK = map[string]bool{
	"OffsetResetTarget.Partitions": true, // nil = all partitions (Go-side semantics)
}

// guaranteedNonNil lists "Type.Field" pairs whose every construction site
// initializes the collection to the empty value. The zero value of a Go
// struct ALWAYS marshals slices as null (there are no field defaults), so
// this test cannot prove the guarantee — it pins the inventory instead:
// a NEW slice/map field not listed here fails the build until its
// construction sites are fixed (preferred) or it is consciously listed.
var guaranteedNonNil = map[string]bool{
	"TopicDetail.PartitionList":      true, // literal make() in kafka.TopicDetail
	"TopicDetail.Config":             true, // literal []ConfigEntry{} — survives a DescribeConfigs failure
	"PartitionSummary.Replicas":      true, // append([]int32{}, ...) in TopicDetail
	"PartitionSummary.ISR":           true, // append([]int32{}, ...) in TopicDetail
	"ConsumerGroupDetail.Members":    true, // literal [] in GroupDetail
	"ConsumerGroupDetail.Offsets":    true, // literal [] in GroupDetail
	"GroupMember.Assignment":         true, // literal []string{} — share-group members fail AsConsumer
	"ShareGroupSummary.Subscribed":   true, // append([]string{}, SubscribedTopics()...)
	"ShareGroupDetail.Members":       true, // literal [] in ShareGroupDetail
	"ShareGroupDetail.Offsets":       true, // literal [] in ShareGroupDetail
	"ShareMember.Subscribed":         true, // make+append in ShareGroupDetail
	"ShareMember.Assignment":         true, // make+append in ShareGroupDetail
	"BrowsePage.Messages":            true, // every return path initializes [] — incl. past-the-end jumps
	"Quota.Entity":                   true, // literal map in ListQuotas
	"Quota.Values":                   true, // literal map in ListQuotas
	"BrokerDetail.Configs":           true, // literal []ConfigEntry{} — survives an empty config list
	"ClusterDiff.TopicsOnlyInA":      true, // literal [] in CompareTopics
	"ClusterDiff.TopicsOnlyInB":      true, // literal [] in CompareTopics
	"ClusterDiff.Both":               true, // literal [] in CompareTopics
	"QuorumInfo.Voters":              true, // see quorum.go construction sites
}

// TestDTOZeroValueNeverMarshalsNull walks each DTO's zero-value JSON and
// fails when a slice- or map-typed field serializes as null without being
// listed in guaranteedNonNil / inputOnlyNullOK. Pointer fields may be null
// (the contract marks them optional).
func TestDTOZeroValueNeverMarshalsNull(t *testing.T) {
	for _, proto := range dtoTypes {
		typ := reflect.TypeOf(proto)
		v := reflect.New(typ).Elem()
		raw, err := json.Marshal(v.Interface())
		if err != nil {
			t.Fatalf("%s: marshal: %v", typ.Name(), err)
		}
		var tree any
		if err := json.Unmarshal(raw, &tree); err != nil {
			t.Fatalf("%s: unmarshal: %v", typ.Name(), err)
		}
		checkNullCollections(t, typ.Name(), typ, v, tree, "")
	}
}

func checkNullCollections(t *testing.T, dto string, typ reflect.Type, val reflect.Value, node any, path string) {
	t.Helper()
	for i := 0; i < typ.NumField(); i++ {
		f := typ.Field(i)
		if !f.IsExported() {
			continue
		}
		fieldPath := path + "." + f.Name
		fv := val.Field(i)
		// The JSON tree mirrors struct order under map[string]any.
		fn, _ := jsonTagName(f)
		m, ok := node.(map[string]any)
		if !ok {
			continue
		}
		nodeField, present := m[fn]
		if !present {
			continue // omitempty: absent is fine, never null
		}
		if inputOnlyNullOK[dto+fieldPath] {
			continue
		}
		switch fv.Kind() {
		case reflect.Slice, reflect.Map:
			if nodeField == nil && !guaranteedNonNil[dto+fieldPath] {
				t.Errorf("%s%s: slice/map marshaled as null — fix the construction sites, then list it in guaranteedNonNil (or inputOnlyNullOK for input-only DTOs)", dto, fieldPath)
			}
		case reflect.Struct:
			if nodeField == nil {
				continue // value struct never null; skip
			}
			checkNullCollections(t, dto, f.Type, fv, nodeField, fieldPath)
		case reflect.Ptr:
			// Optional field: null is the documented shape.
		}
	}
}

func jsonTagName(f reflect.StructField) (string, bool) {
	tag := f.Tag.Get("json")
	if tag == "" {
		return strings.ToLower(f.Name), true
	}
	parts := strings.Split(tag, ",")
	if parts[0] == "-" {
		return "", false
	}
	if parts[0] == "" {
		return strings.ToLower(f.Name), true
	}
	return parts[0], true
}
