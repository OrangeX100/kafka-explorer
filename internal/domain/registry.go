package domain


// ---- Schema Registry ----

// SchemaRegistry is a saved Confluent Schema Registry connection.
type SchemaRegistry struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	URL       string    `json:"url"` // http(s)://host:port
	Username  string    `json:"username,omitempty"`
	SecretRef string    `json:"secretRef,omitempty"` // basic-auth password reference
	CreatedAt FlexTime  `json:"createdAt,omitempty"`
	UpdatedAt FlexTime  `json:"updatedAt,omitempty"`
}

func (r SchemaRegistry) Validate() error {
	if r.Name == "" {
		return errInvalidField("name")
	}
	if len(r.URL) < 8 || (r.URL[:7] != "http://" && r.URL[:8] != "https://") {
		return errInvalidField("url must start with http:// or https://")
	}
	return nil
}

// SchemaSubject is one registry subject with its latest version.
type SchemaSubject struct {
	Name          string     `json:"name"`
	Version       int        `json:"version"`
	ID            int        `json:"id"`
	SchemaType    string     `json:"schemaType"` // AVRO | JSON | PROTOBUF
	Compatibility string     `json:"compatibility"`
	Schema        string     `json:"schema"` // raw schema JSON
	References    []SchemaRef `json:"references,omitempty"`
}

// SchemaRef is a named dependency between schemas.
type SchemaRef struct {
	Name    string `json:"name"`
	Subject string `json:"subject"`
	Version int    `json:"version"`
}

// SchemaVersion is one version entry of a subject.
type SchemaVersion struct {
	Version    int    `json:"version"`
	ID         int    `json:"id"`
	SchemaType string `json:"schemaType"`
	Schema     string `json:"schema"`
}

// CompatibilityCheck reports a candidate schema's compatibility with a subject.
type CompatibilityCheck struct {
	IsCompatible bool     `json:"isCompatible"`
	Messages     []string `json:"messages,omitempty"`
}

// GlobalConfig is the registry-wide configuration surface (GET/PUT /config).
type GlobalConfig struct {
	// CompatibilityLevel: BACKWARD/FORWARD/FULL (+ _TRANSITIVE) / NONE; ""
	// when the registry reports nothing.
	CompatibilityLevel string `json:"compatibilityLevel"`
}

// LocalSchema is an offline, registry-independent schema kept in the app
// database — the decode path for Confluent-framed payloads when no
// registry connection is configured .
type LocalSchema struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	SchemaType string   `json:"schemaType"` // AVRO | JSON | PROTOBUF
	Schema     string   `json:"schema"`
	References []SchemaRef `json:"references,omitempty"`
	CreatedAt  FlexTime `json:"createdAt,omitempty"`
	UpdatedAt  FlexTime `json:"updatedAt,omitempty"`
}

func (s LocalSchema) Validate() error {
	if s.Name == "" {
		return errInvalidField("name")
	}
	if s.Schema == "" {
		return errInvalidField("schema")
	}
	return nil
}

// ---- Brokers ----

// BrokerSummary is a row in the broker list.
type BrokerSummary struct {
	ID   int32  `json:"id"`
	Host string `json:"host"`
	Port int32  `json:"port"`
	Rack string `json:"rack,omitempty"`
}

// AlterBrokerConfigInput changes one broker's dynamic configs. A nil value
// deletes the override, restoring the cluster default. Static (restart-only)
// configs are rejected by the broker itself with a clear error.
type AlterBrokerConfigInput struct {
	ConnectionID string            `json:"connectionId"`
	BrokerID     int32             `json:"brokerId"`
	Values       map[string]*string `json:"values"`
}

// BrokerDetail adds config to the summary.
type BrokerDetail struct {
	BrokerSummary
	Configs []ConfigEntry `json:"configs"`
}

// LogDir is one log directory entry of a broker.
type LogDir struct {
	BrokerID  int32            `json:"brokerId"`
	Path      string           `json:"path"`
	TotalBytes uint64          `json:"totalBytes"`
	UsableBytes uint64         `json:"usableBytes"`
	Topics    []LogDirTopic    `json:"topics,omitempty"`
}

// LogDirTopic is one topic's partition footprint inside a log dir.
type LogDirTopic struct {
	Topic      string `json:"topic"`
	Partition  int32  `json:"partition"`
	SizeBytes  uint64 `json:"sizeBytes"`
	OffsetLag  int64  `json:"offsetLag,omitempty"`
}

// ---- ACLs ----

// ACL is one access control entry.
type ACL struct {
	Principal       string `json:"principal"`
	Host            string `json:"host"`
	Operation       string `json:"operation"`       // READ, WRITE, CREATE, DELETE, ALTER, DESCRIBE, ...
	PermissionType  string `json:"permissionType"`  // ALLOW | DENY
	ResourceType    string `json:"resourceType"`    // TOPIC, GROUP, CLUSTER, TRANSACTIONAL_ID
	ResourceName    string `json:"resourceName"`
	PatternType     string `json:"patternType"`     // LITERAL | PREFIXED
}

// ---- Quotas ----

// Quota is one client quota entry.
type Quota struct {
	Entity      map[string]string `json:"entity"` // user / client-id entries
	Values      map[string]float64 `json:"values"` // producer_byte_rate, consumer_byte_rate, request_percentage
}

// ---- Cluster compare ----

// ClusterDiff is the comparison result of two clusters.
type ClusterDiff struct {
	TopicsOnlyInA []string          `json:"topicsOnlyInA"`
	TopicsOnlyInB []string          `json:"topicsOnlyInB"`
	Both          []TopicPairDiff   `json:"both"`
}

// TopicPairDiff compares one topic present in both clusters.
type TopicPairDiff struct {
	Topic           string `json:"topic"`
	PartitionsA     int32  `json:"partitionsA"`
	PartitionsB     int32  `json:"partitionsB"`
	PartitionMatch  bool   `json:"partitionMatch"`
	ConfigDiffCount int    `json:"configDiffCount"`
}

// ---- Data generation ----

// GenerateInput describes a batch of test messages to produce.
type GenerateInput struct {
	ConnectionID string `json:"connectionId"`
	Topic        string `json:"topic"`
	Count        int    `json:"count"`
	Format       string `json:"format"` // "json" | "text"
	KeyPrefix    string `json:"keyPrefix,omitempty"`
	// Template: Go text/template rendered per message with .Index / .Timestamp.
	Template string `json:"template"`
}

// GenerateResult summarizes a generation run.
type GenerateResult struct {
	Produced int   `json:"produced"`
	FirstOffset int64 `json:"firstOffset"`
	ElapsedMs int64 `json:"elapsedMs"`
}

// ---- Message import/export ----

// ExportMessagesInput selects messages to export.
type ExportMessagesInput struct {
	ConnectionID string `json:"connectionId"`
	Topic        string `json:"topic"`
	Partition    *int32 `json:"partition,omitempty"`
	// From/To offset window (inclusive); To nil = to the end.
	From int64  `json:"from"`
	To   *int64 `json:"to,omitempty"`
	Format string `json:"format"` // "jsonl" | "csv"
}

// ImportedMessage is one record coming in from an import file.
type ImportedMessage struct {
	Key     *string            `json:"key,omitempty"` // plain text (not base64): files are human-authored
	Value   *string            `json:"value,omitempty"`
	Headers map[string]string  `json:"headers,omitempty"`
	Partition *int32           `json:"partition,omitempty"`
}

func errInvalidField(msg string) error { return &fieldError{msg} }

type fieldError struct{ msg string }

func (e *fieldError) Error() string { return "invalid: " + e.msg }

// ---- Kafka Connect ----

// ConnectCluster is a saved Kafka Connect REST endpoint. Optional basic
// auth (e.g. Confluent Cloud API key/secret): the secret itself lives in
// the OS credential store behind SecretRef.
type ConnectCluster struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	URL       string `json:"url"` // http(s)://host:port
	Username  string `json:"username,omitempty"`
	SecretRef string `json:"secretRef,omitempty"`
}

func (c ConnectCluster) Validate() error {
	if c.Name == "" {
		return errInvalidField("name")
	}
	if len(c.URL) < 8 || (c.URL[:7] != "http://" && c.URL[:8] != "https://") {
		return errInvalidField("url must start with http:// or https://")
	}
	return nil
}
