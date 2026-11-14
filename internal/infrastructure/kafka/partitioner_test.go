package kafka

import (
	"testing"

	"github.com/twmb/franz-go/pkg/kgo"
)

// TestManualAwareRequiresConsistency pins the 045 partitioner fix: kgo's
// doPartition maps the partitioner's return through writablePartitions
// (index → partition) when RequiresConsistency is false, so an explicitly
// partitioned KEYLESS record with RequiresConsistency=false wrote to the
// Nth WRITABLE partition instead of partition N (silent misroute), or
// failed outright when the partition number exceeded the writable count.
func TestManualAwareRequiresConsistency(t *testing.T) {
	// Mirror the production wiring (client.go).
	tp := (&manualAwarePartitioner{inner: kgo.StickyKeyPartitioner(nil)}).ForTopic("t")

	if !tp.RequiresConsistency(&kgo.Record{Partition: 6}) {
		t.Fatal("REGRESSION: explicit partition with nil key must require consistency")
	}
	if tp.RequiresConsistency(&kgo.Record{Partition: -1}) {
		// Record{} zero value carries Partition=0 (a VALID explicit
		// partition) — "no partition" is marked -1 by Client.Produce.
		t.Fatal("keyless partitionless (-1) record must defer to the inner partitioner (sticky → false)")
	}
	if !tp.RequiresConsistency(&kgo.Record{Key: []byte("k")}) {
		t.Fatal("keyed record must require consistency (sticky semantics)")
	}
}
