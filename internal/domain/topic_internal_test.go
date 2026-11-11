package domain

import "testing"

// TestProtectedTopicTierOf pins the classification: broker-internal topics
// (__-prefixed) and the exact ecosystem list are protected; single-_
// lookalikes and prefixed user topics must NOT be swept in.
func TestProtectedTopicTierOf(t *testing.T) {
	cases := []struct {
		name string
		want ProtectedTopicTier
	}{
		{"__consumer_offsets", TopicTierKafka},
		{"__share_group_state", TopicTierKafka},
		{"__transaction_state", TopicTierKafka},
		{"_schemas", TopicTierEcosystem},
		{"connect-offsets", TopicTierEcosystem},
		{"_confluent-metrics", TopicTierEcosystem},
		{"_confluent-ksql-ksql-explorer-01command_topic", TopicTierEcosystem},
		{"_confluent-ksql-transient_123", TopicTierEcosystem},
		// lookalikes that must stay unprotected
		{"_my-schemas", TopicTierNone},
		{"_schemas-backup", TopicTierNone},
		{"connect-offsets-old", TopicTierNone},
		{"___triple", TopicTierKafka}, // still __-prefixed
		{"qqq", TopicTierNone},
		{"", TopicTierNone},
	}
	for _, c := range cases {
		if got := ProtectedTopicTierOf(c.name); got != c.want {
			t.Errorf("%q: got %q, want %q", c.name, got, c.want)
		}
		if want := c.want != TopicTierNone; IsProtectedTopic(c.name) != want {
			t.Errorf("%q: IsProtectedTopic=%v, want %v", c.name, !want, want)
		}
	}
}
