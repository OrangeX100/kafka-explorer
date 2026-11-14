package kafka

import "github.com/twmb/franz-go/pkg/kgo"

// manualAwarePartitioner honors a record's pre-set partition while keeping
// franz-go's default sticky/key behavior for everything else.
//
// franz-go's default partitioner NEVER reads Record.Partition — it always
// computes from the key (or sticks), so a produce call that asks for a
// specific partition was silently re-routed. Records produced without a
// partition are marked Partition = -1 (see Client.Produce) and fall through
// to the wrapped default behavior.
type manualAwarePartitioner struct {
	inner kgo.Partitioner
}

func (p *manualAwarePartitioner) ForTopic(topic string) kgo.TopicPartitioner {
	return &manualAwareTopicPartitioner{p.inner.ForTopic(topic)}
}

type manualAwareTopicPartitioner struct {
	inner kgo.TopicPartitioner
}

func (p *manualAwareTopicPartitioner) ForTopic(topic string) kgo.TopicPartitioner {
	return p
}

func (p *manualAwareTopicPartitioner) Partition(r *kgo.Record, n int) int {
	if r.Partition >= 0 {
		return int(r.Partition) // explicit user choice
	}
	return p.inner.Partition(r, n)
}

// RequiresConsistency: an explicitly-partitioned record MUST report true
// even when keyless. kgo's doPartition maps the partitioner's return value
// through writablePartitions (index → partition) when RequiresConsistency
// is false, so a keyless "partition 6" used to land on the 7th WRITABLE
// partition (silent misroute) or fail outright when 6 ≥ len(writable).
// RequiresConsistency=true maps through all partitions, where the returned
// value IS the partition number — matching what Partition() returns above.
func (p *manualAwareTopicPartitioner) RequiresConsistency(r *kgo.Record) bool {
	if r.Partition >= 0 {
		return true
	}
	return p.inner.RequiresConsistency(r)
}
