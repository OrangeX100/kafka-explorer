package domain

import (
	"strings"
	"time"
)

// FlexTime tolerates absent, empty, or malformed timestamps in JSON.
//
// Plain time.Time rejects `""` outright, which broke the new-connection
// form: the frontend sends createdAt:"" for unsaved connections and the
// request died during argument binding, before Kafka was ever contacted.
// Degradation rule: anything unparseable becomes the zero time instead of
// rejecting the whole record — timestamps are metadata here, not data the
// business logic depends on.
type FlexTime time.Time

func (t *FlexTime) UnmarshalJSON(data []byte) error {
	s := strings.Trim(string(data), `"`)
	if s == "" || s == "null" {
		*t = FlexTime(time.Time{})
		return nil
	}
	parsed, err := time.Parse(time.RFC3339, s)
	if err != nil {
		*t = FlexTime(time.Time{})
		return nil
	}
	*t = FlexTime(parsed)
	return nil
}

// MarshalJSON emits "" for the zero time so the frontend's `createdAt:
// string` contract holds and a round-trip (read form -> save) re-parses.
func (t FlexTime) MarshalJSON() ([]byte, error) {
	tt := time.Time(t)
	if tt.IsZero() {
		return []byte(`""`), nil
	}
	return []byte(`"` + tt.Format(time.RFC3339) + `"`), nil
}

// Time returns the wrapped value for code that needs time.Time semantics.
func (t FlexTime) Time() time.Time { return time.Time(t) }
