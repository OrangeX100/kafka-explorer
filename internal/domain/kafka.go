package domain


// Kafka entities. Field names mirror the Kafka concepts; JSON tags are the
// contract with the frontend (mirrored by hand in shared/contracts, guarded
// by audit-dto).

// PartitionSummary is one partition of a topic.
type PartitionSummary struct {
	ID           int32     `json:"id"`
	Leader       int32     `json:"leader"`
	Replicas     []int32   `json:"replicas"`
	ISR          []int32   `json:"isr"`
	LogStart     int64     `json:"logStart"`
	LogEnd       int64     `json:"logEnd"`
	MessageCount int64     `json:"messageCount"` // logEnd - logStart
}

// TopicSummary is a row in the topics list.
type TopicSummary struct {
	Name              string             `json:"name"`
	Partitions        int32              `json:"partitions"`
	ReplicationFactor int16              `json:"replicationFactor"`
	MessageCount      int64              `json:"messageCount"`
	// Internal means PROTECTED (mutation refused): broker-internal topics
	// plus ecosystem topics (_schemas, connect-*) the broker reports as
	// normal. See ProtectedTopicTierOf.
	Internal          bool               `json:"internal"`
	CreatedAt         *FlexTime          `json:"createdAt,omitempty"` // nil when broker does not report it
}

// TopicDetail adds per-partition layout and effective config to the summary.
type TopicDetail struct {
	TopicSummary
	// PartitionList is named distinctly from the summary's Partitions count
	// so the JSON contract has no name collision between count and layout.
	PartitionList []PartitionSummary `json:"partitionList"`
	Config        []ConfigEntry      `json:"config"`
}

// ConfigEntry is one effective broker/topic configuration value.
type ConfigEntry struct {
	Name  string `json:"name"`
	Value string `json:"value"`
	// DefaultValue is the cluster/broker default behind this entry (from
	// describe synonyms), so the UI can show what a revert restores.
	DefaultValue string `json:"defaultValue"`
	Default      bool   `json:"default"`
	ReadOnly     bool   `json:"readOnly"`
	Sensitive    bool   `json:"sensitive"` // broker redacts value; render as ***
	Doc          string `json:"doc,omitempty"` // broker-provided (English) documentation
}

// MessageHeader is one key/value pair attached to a record.
type MessageHeader struct {
	Key   string `json:"key"`
	Value string `json:"value"` // base64 of raw bytes
}

// Message is one fetched record. Key/Value are base64: decode (JSON pretty,
// hex, string) happens in the frontend so the backend stays format-agnostic.
type Message struct {
	Topic     string          `json:"topic"`
	Partition int32           `json:"partition"`
	Offset    int64           `json:"offset"`
	Timestamp FlexTime        `json:"timestamp"` // FlexTime: whole wire layer speaks one time type
	Key       string          `json:"key,omitempty"`       // base64
	Value     string          `json:"value,omitempty"`     // base64
	ValueSize int              `json:"valueSize"`
	Headers   []MessageHeader `json:"headers,omitempty"`
	// Decoded carries the readable rendering of Value when the browse
	// request asked for decoding; nil otherwise.
	Decoded *DecodeResult `json:"decoded,omitempty"`
}

// DecodeResult is the outcome of one value-decode attempt.
type DecodeResult struct {
	Format string `json:"format"`
	Text   string `json:"text"`
	Error  string `json:"error,omitempty"`
}

// BrowseRequest positions a page of messages. Exactly one anchor wins
// (StartOffset > StartTimestamp > latest): mirrors the reference desktop tool behavior.
type BrowseRequest struct {
	ConnectionID   string `json:"connectionId"`
	Topic          string `json:"topic"`
	Partition      *int32 `json:"partition,omitempty"` // nil = all partitions
	StartOffset    *int64 `json:"startOffset,omitempty"`
	StartTimestamp *int64 `json:"startTimestamp,omitempty"` // unix ms
	Direction      string `json:"direction"`                // "forward" | "backward" from anchor
	Limit          int    `json:"limit"`                    // page size, clamped server-side
	Decode         string `json:"decode,omitempty"`         // auto | json | text ("" = text-only legacy)
}

// BrowsePage is one page result plus the cursor to continue from.
type BrowsePage struct {
	Messages []Message `json:"messages"`
	// NextAnchor is the offset to pass as StartOffset for the next page;
	// nil when the partition(s) are exhausted.
	NextAnchor *int64    `json:"nextAnchor,omitempty"`
	Exhausted  bool      `json:"exhausted"`
}

// FindRequest filters messages by key or value substring/regex.
type FindRequest struct {
	BrowseRequest
	Pattern   string `json:"pattern"`
	Regex     bool   `json:"regex"`
	MatchKey  bool   `json:"matchKey"`
	MatchValue bool  `json:"matchValue"`
	MaxScan   int    `json:"maxScan"` // hard cap of records scanned per request
}

// ConsumerGroupSummary is a row in the groups list.
type ConsumerGroupSummary struct {
	Group      string `json:"group"`
	State      string `json:"state"`      // Stable / Empty / Dead / ...
	Members    int    `json:"members"`
	Protocol   string `json:"protocolType"`
	TotalLag   int64  `json:"totalLag"`
	Type       string `json:"type"` // classic | consumer | share | streams | connect
}

// ---- Share groups (KIP-932, Kafka 4.2+) ----
// A share group's "offset" is the share-partition start offset: records at or
// before it count as delivered to the group.

// ShareGroupSummary is a row in the share groups list.
type ShareGroupSummary struct {
	Group         string   `json:"group"`
	State         string   `json:"state"`   // Empty / Stable / Dead / ...
	Members       int      `json:"members"`
	CoordinatorID int32    `json:"coordinatorId"`
	Subscribed    []string `json:"subscribed"` // topic names members subscribe to
}

// ShareMember is one share group member.
type ShareMember struct {
	ID          string   `json:"id"`
	ClientID    string   `json:"clientId"`
	Host        string   `json:"host"`
	Rack        string   `json:"rack,omitempty"`
	MemberEpoch int32    `json:"memberEpoch"`
	Subscribed  []string `json:"subscribed"` // topic names
	Assignment  []string `json:"assignment"` // "topic-partition" strings
}

// SharePartitionOffset is one topic-partition of a share group. StartOffset is
// the share-partition start offset; records before it are never delivered.
type SharePartitionOffset struct {
	Topic       string `json:"topic"`
	Partition   int32  `json:"partition"`
	StartOffset int64  `json:"startOffset"`
	LogEnd      int64  `json:"logEnd"`
	Lag         int64  `json:"lag"` // broker-computed; -1 when unavailable
}

// ShareGroupDetail is the full view of one share group: members plus the
// per-partition start offsets.
type ShareGroupDetail struct {
	Group           string                 `json:"group"`
	State           string                 `json:"state"`
	Assignor        string                 `json:"assignor"`
	GroupEpoch      int32                  `json:"groupEpoch"`
	AssignmentEpoch int32                  `json:"assignmentEpoch"`
	Members         []ShareMember          `json:"members"`
	Offsets         []SharePartitionOffset `json:"offsets"`
	TotalLag        int64                  `json:"totalLag"`
}

// ShareGroupAlterTarget repositions the start offset of one topic-partition of
// a share group. The group must be empty (no active share consumers).
type ShareGroupAlterTarget struct {
	ConnectionID string `json:"connectionId"`
	Group        string `json:"group"`
	Topic        string `json:"topic"`
	Partition    int32  `json:"partition"`
	StartOffset  int64  `json:"startOffset"`
}

// GroupPartitionOffset is one topic-partition of a group.
type GroupPartitionOffset struct {
	Topic     string `json:"topic"`
	Partition int32  `json:"partition"`
	Committed int64  `json:"committed"`
	LogEnd    int64  `json:"logEnd"`
	Lag       int64  `json:"lag"`
}

// ConsumerGroupDetail is the offsets view of one group.
type ConsumerGroupDetail struct {
	Group    string                   `json:"group"`
	State    string                   `json:"state"`
	Members  []GroupMember            `json:"members"`
	Offsets  []GroupPartitionOffset   `json:"offsets"`
	TotalLag int64                    `json:"totalLag"`
}

// GroupMember is one member and its assignment.
type GroupMember struct {
	ID         string   `json:"id"`
	ClientID   string   `json:"clientId"`
	Host       string   `json:"host"`
	Assignment []string `json:"assignment"` // "topic-partition" strings
}

// OffsetResetTarget selects how to reposition a group.
type OffsetResetTarget struct {
	ConnectionID string  `json:"connectionId"`
	Group        string  `json:"group"`
	Topic        string  `json:"topic"`
	Partitions   []int32 `json:"partitions"` // empty = all partitions of the topic
	Mode         string  `json:"mode"`       // earliest | latest | absolute | timestamp
	Absolute     *int64  `json:"absolute,omitempty"`  // offset (mode=absolute)
	Timestamp    *int64  `json:"timestamp,omitempty"` // unix ms (mode=timestamp)
	// DryRun returns the plan without committing. The UI must always show a
	// preview first: offset reset is irreversible.
	DryRun bool `json:"dryRun"`
}

// OffsetResetPlan is one partition's planned (or applied) reset result.
type OffsetResetPlan struct {
	Partition int32 `json:"partition"`
	Committed int64 `json:"committed"` // -1 = group never committed this partition
	NewOffset int64 `json:"newOffset"`
	LogEnd    int64 `json:"logEnd"`
}
