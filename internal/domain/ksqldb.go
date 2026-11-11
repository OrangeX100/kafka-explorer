package domain

// KsqlDbServer is one saved ksqlDB REST endpoint .
// API secrets ride the OS credential store behind SecretRef — never the DB.
type KsqlDbServer struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	URL       string `json:"url"` // http(s)://host:8088
	Username  string `json:"username,omitempty"`
	SecretRef string `json:"secretRef,omitempty"`
}

func (k KsqlDbServer) Validate() error {
	if k.Name == "" {
		return errInvalidField("name")
	}
	if len(k.URL) < 8 || (k.URL[:7] != "http://" && k.URL[:8] != "https://") {
		return errInvalidField("url must start with http:// or https://")
	}
	return nil
}

// KsqlStreamRow is one SHOW STREAMS entity row.
type KsqlStreamRow struct {
	Name       string `json:"name"`
	Topic      string `json:"topic"`
	KeyFormat  string `json:"keyFormat"`
	ValueFormat string `json:"valueFormat"`
	WindowType string `json:"windowType,omitempty"`
}

// KsqlTableRow is one SHOW TABLES entity row.
type KsqlTableRow = KsqlStreamRow

// KsqlQueryRow is one SHOW QUERIES entity row (persistent query).
type KsqlQueryRow struct {
	ID        string `json:"id"`
	QueryType string `json:"queryType"`
	Status    string `json:"status"`
	SinkName  string `json:"sinkName,omitempty"`
	SQL       string `json:"sql,omitempty"`
}

// KsqlExecResult is the merged result of one POST /ksql statement batch.
// The three SHOW families are parsed into typed rows; everything else
// (DESCRIBE EXTENDED, SET/UNSET, generic entities) lands in GenericEntity
// untouched — the UI renders it as key/value detail.
type KsqlExecResult struct {
	StatementText string            `json:"statementText"`
	QueryIDs      []string          `json:"queryIds,omitempty"`
	Warnings      []string          `json:"warnings,omitempty"`
	Streams       []KsqlStreamRow   `json:"streams,omitempty"`
	Tables        []KsqlTableRow    `json:"tables,omitempty"`
	Queries       []KsqlQueryRow    `json:"queries,omitempty"`
	Properties    map[string]string `json:"properties,omitempty"`
	GenericEntity map[string]any    `json:"genericEntity,omitempty"`
}
