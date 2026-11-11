package domain

// QuorumInfo is the KRaft metadata quorum status (DescribeQuorum,
// KIP-853). Voters replicate the metadata log; observers only fetch it
// (e.g. broker-only nodes in a combined KRaft cluster).
type QuorumInfo struct {
	LeaderID           int32         `json:"leaderId"`
	LeaderEpoch        int32         `json:"leaderEpoch"`
	HighWatermark      int64         `json:"highWatermark"`
	ControllerEndpoint string        `json:"controllerEndpoint"`
	Voters             []QuorumVoter `json:"voters"`
}

type QuorumVoter struct {
	ReplicaID    int32  `json:"replicaId"`
	Role         string `json:"role"` // "voter" | "observer"
	LogEndOffset int64  `json:"logEndOffset"`
	LastFetchMs  int64  `json:"lastFetchMs"` // -1 = leader or unknown
	Synced       bool   `json:"synced"`
	IsLeader     bool   `json:"isLeader"`
}

// RateBucket is one time slice of a topic rate histogram (Visualization).
// RateScanWindow describes where the Visualization scan starts.
// ByOffset=false: timestamp anchor — records older than FromMs clamp to
// bucket 0 (historical full-scan behavior).
// ByOffset=true: offset anchor — per partition, scan forward FROM
// FromOffset; the bucket window derives from the scanned records.
type RateScanWindow struct {
	FromMs     int64 `json:"fromMs"`
	FromOffset int64 `json:"fromOffset"`
	ByOffset   bool  `json:"byOffset"`
}

type RateBucket struct {
	StartMs int64 `json:"startMs"`
	Count   int64 `json:"count"`
}
