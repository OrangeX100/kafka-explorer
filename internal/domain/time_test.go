package domain

import (
	"testing"
	"time"
)

func TestFlexTimeUnmarshal(t *testing.T) {
	cases := []struct {
		name  string
		json  string
		zero  bool // expect zero time
		want  string
	}{
		{"empty string tolerated", `""`, true, ""},
		{"null tolerated", `null`, true, ""},
		{"garbage degrades to zero", `"not-a-time"`, true, ""},
		{"valid rfc3339 parses", `"2026-11-02T12:00:00+08:00"`, false, "2026-11-02 12:00:00 +0800"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var ft FlexTime
			if err := ft.UnmarshalJSON([]byte(c.json)); err != nil {
				t.Fatalf("unexpected error for %s: %v", c.json, err)
			}
			if c.zero && !time.Time(ft).IsZero() {
				t.Errorf("want zero time, got %v", time.Time(ft))
			}
			if !c.zero && time.Time(ft).Format("2006-01-02 15:04:05 -0700") != c.want {
				t.Errorf("parsed %v, want %v", time.Time(ft), c.want)
			}
		})
	}
}

func TestFlexTimeMarshal(t *testing.T) {
	zero := FlexTime{}
	out, err := zero.MarshalJSON()
	if err != nil || string(out) != `""` {
		t.Errorf("zero should marshal to empty string, got %s (%v)", out, err)
	}
	valid := FlexTime(time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC))
	out, err = valid.MarshalJSON()
	if err != nil || string(out) != `"2026-11-02T12:00:00Z"` {
		t.Errorf("marshal mismatch: %s (%v)", out, err)
	}
}
