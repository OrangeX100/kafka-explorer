package domain

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

// Regression for the 2026-11-02 real-cluster incident: the new-connection
// form sent createdAt:"" and plain time.Time rejected it during JSON
// binding, so the request died before Kafka was ever contacted.
func TestConnectionBindingToleratesFreshForm(t *testing.T) {
	raw := `{"name":"x","bootstrap":"h:9092","security":"none","tls":{"enabled":false},"createdAt":"","updatedAt":""}`
	var c Connection
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		t.Fatalf("binding fresh-form connection: %v", err)
	}
	if !c.CreatedAt.Time().IsZero() || !c.UpdatedAt.Time().IsZero() {
		t.Errorf("fresh form should bind to zero timestamps, got %v/%v", c.CreatedAt, c.UpdatedAt)
	}
}

// Machine judgment so this class of accident can never return: wire DTOs
// must not declare bare time.Time / *time.Time fields — both reject "" on
// unmarshal (the exact incident). Timestamps on the wire speak FlexTime.
func TestDTOsHaveNoBareTimeFields(t *testing.T) {
	dtos := []any{
		Connection{}, TLSSettings{}, TopicSummary{}, TopicDetail{},
		PartitionSummary{}, ConfigEntry{}, MessageHeader{}, Message{},
		BrowseRequest{}, BrowsePage{}, FindRequest{},
		ConsumerGroupSummary{}, GroupMember{}, GroupPartitionOffset{},
		ConsumerGroupDetail{}, OffsetResetTarget{}, OffsetResetPlan{},
	}
	forbidden := reflect.TypeOf(time.Time{})
	seenTypes := map[reflect.Type]bool{}

	var walk func(typ reflect.Type, path string)
	walk = func(typ reflect.Type, path string) {
		switch typ.Kind() {
		case reflect.Ptr, reflect.Slice, reflect.Array, reflect.Map:
			walk(typ.Elem(), path)
		case reflect.Struct:
			if typ == forbidden {
				t.Errorf("%s uses bare time.Time — wire DTOs must use FlexTime (bare time.Time rejects \"\" on binding)", path)
				return
			}
			if seenTypes[typ] {
				return
			}
			seenTypes[typ] = true
			for i := 0; i < typ.NumField(); i++ {
				walk(typ.Field(i).Type, path+"."+typ.Field(i).Name)
			}
		}
	}

	for _, dto := range dtos {
		typ := reflect.TypeOf(dto)
		seenTypes = map[reflect.Type]bool{}
		walk(typ, typ.Name())
	}
}
