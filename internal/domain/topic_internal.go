package domain

import "strings"

// ProtectedTopicTier classifies why a topic refuses destructive mutations
// (delete topic / produce / delete records).
type ProtectedTopicTier string

const (
	TopicTierNone      ProtectedTopicTier = ""
	TopicTierKafka     ProtectedTopicTier = "kafka"     // broker-internal (__-prefixed)
	TopicTierEcosystem ProtectedTopicTier = "ecosystem" // owned by an ecosystem service
)

// ecosystemTopics lists well-known topics that ecosystem services create as
// NORMAL topics — the broker's metadata reports IsInternal=false for them,
// yet deleting one wipes the owning service's data (deleting _schemas, for
// example, destroys every schema Schema Registry has ever registered).
// Exact names on purpose: each service lets you configure its storage topic
// name, so any prefix guess (_, connect-, …) would false-positive on
// ordinary user topics like "my-topic-back". _confluent-ksql- is the ONE
// prefix exception: ksqlDB names its internal topics
// _confluent-ksql-<service-id>... (command topic, query changelogs) and the
// service id is user-chosen, so exact matching cannot enumerate them.
var ecosystemTopics = map[string]struct{}{
	"_schemas":                     {}, // Confluent Schema Registry storage
	"connect-configs":              {}, // Kafka Connect (default names)
	"connect-offsets":              {},
	"connect-status":               {},
	"_confluent-command":           {}, // Confluent platform support topics
	"_confluent-metrics":           {},
	"_confluent-telemetry-metrics": {},
}

// ecosystemPrefixes: topic-name prefixes owned by ecosystem services —
// currently only ksqlDB's internal topic family.
var ecosystemPrefixes = []string{"_confluent-ksql-"}

// ProtectedTopicTierOf returns why the topic is protected, or TopicTierNone
// when it is an ordinary user topic.
func ProtectedTopicTierOf(name string) ProtectedTopicTier {
	if strings.HasPrefix(name, "__") {
		return TopicTierKafka
	}
	if _, ok := ecosystemTopics[name]; ok {
		return TopicTierEcosystem
	}
	for _, p := range ecosystemPrefixes {
		if strings.HasPrefix(name, p) {
			return TopicTierEcosystem
		}
	}
	return TopicTierNone
}

// IsProtectedTopic reports whether destructive mutations must be refused in
// every layer — not just the UI. Browsing and export stay unaffected.
func IsProtectedTopic(name string) bool {
	return ProtectedTopicTierOf(name) != TopicTierNone
}
