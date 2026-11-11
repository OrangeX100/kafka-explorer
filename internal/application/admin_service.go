package application

import (
	"context"
	"fmt"

	"kafkaexplorer/internal/domain"
	"kafkaexplorer/internal/infrastructure/kafka"
	"kafkaexplorer/internal/infrastructure/registry"
	"kafkaexplorer/internal/infrastructure/store"
)

// AdminService exposes broker/ACL/quota administration.
type AdminService struct {
	pool *kafka.Pool
}

func NewAdminService(pool *kafka.Pool) *AdminService { return &AdminService{pool: pool} }

func (s *AdminService) ListBrokers(ctx context.Context, connectionID string) ([]domain.BrokerSummary, error) {
	client, err := s.pool.Acquire(ctx, connectionID)
	if err != nil {
		return nil, err
	}
	return client.ListBrokers(ctx)
}

func (s *AdminService) BrokerDetail(ctx context.Context, connectionID string, brokerID int32) (domain.BrokerDetail, error) {
	client, err := s.pool.Acquire(ctx, connectionID)
	if err != nil {
		return domain.BrokerDetail{}, err
	}
	return client.BrokerDetail(ctx, brokerID)
}

// AlterBrokerConfig changes one broker's dynamic configs via the shared
// pool client. Values map entries with nil delete the override.
func (s *AdminService) AlterBrokerConfig(ctx context.Context, in domain.AlterBrokerConfigInput) error {
	client, err := s.pool.Acquire(ctx, in.ConnectionID)
	if err != nil {
		return err
	}
	return client.AlterBrokerConfig(ctx, in.BrokerID, in.Values)
}

func (s *AdminService) ListLogDirs(ctx context.Context, connectionID string) ([]domain.LogDir, error) {
	client, err := s.pool.Acquire(ctx, connectionID)
	if err != nil {
		return nil, err
	}
	return client.ListLogDirs(ctx)
}

func (s *AdminService) ListACLs(ctx context.Context, connectionID string) ([]domain.ACL, error) {
	client, err := s.pool.Acquire(ctx, connectionID)
	if err != nil {
		return nil, err
	}
	return client.ListACLs(ctx)
}

// CreateACL decision-logs in the wails handler (irreversible security change).
func (s *AdminService) CreateACL(ctx context.Context, connectionID string, acl domain.ACL) error {
	client, err := s.pool.Acquire(ctx, connectionID)
	if err != nil {
		return err
	}
	return client.CreateACL(ctx, acl)
}

func (s *AdminService) DeleteACL(ctx context.Context, connectionID string, acl domain.ACL) error {
	client, err := s.pool.Acquire(ctx, connectionID)
	if err != nil {
		return err
	}
	return client.DeleteACL(ctx, acl)
}

// TopicRateHistogram builds the Visualization data for a topic: record
// counts bucketed by timestamp since fromMs. Bounded scan (see kafka).
func (s *TopicService) TopicRateHistogram(ctx context.Context, connectionID, topic string, win domain.RateScanWindow, buckets int, partitionID int32) ([]domain.RateBucket, int64, error) {
	client, err := s.pool.Acquire(ctx, connectionID)
	if err != nil {
		return nil, 0, err
	}
	return client.TopicRateHistogram(ctx, topic, win, buckets, partitionID)
}

// QuorumInfo/QuorumVoter are re-exported here so the wails handler (and the
// generated bindings) see them through the application package.
type QuorumInfo = domain.QuorumInfo
type QuorumVoter = domain.QuorumVoter

// DescribeQuorum reads the KRaft metadata quorum status. ZooKeeper clusters
// and old brokers answer UNSUPPORTED_VERSION — the handler translates that
// into friendly guidance instead of a raw error.
func (s *AdminService) DescribeQuorum(ctx context.Context, connectionID string) (domain.QuorumInfo, error) {
	client, err := s.pool.Acquire(ctx, connectionID)
	if err != nil {
		return domain.QuorumInfo{}, err
	}
	return client.DescribeQuorum(ctx)
}

func (s *AdminService) ListQuotas(ctx context.Context, connectionID string) ([]domain.Quota, error) {
	client, err := s.pool.Acquire(ctx, connectionID)
	if err != nil {
		return nil, err
	}
	return client.ListQuotas(ctx)
}

func (s *AdminService) AlterQuota(ctx context.Context, connectionID string, entity map[string]string, key string, value *float64) error {
	client, err := s.pool.Acquire(ctx, connectionID)
	if err != nil {
		return err
	}
	return client.AlterQuota(ctx, entity, key, value)
}

func (s *AdminService) DeleteConsumerGroup(ctx context.Context, connectionID, group string) error {
	client, err := s.pool.Acquire(ctx, connectionID)
	if err != nil {
		return err
	}
	return client.DeleteConsumerGroup(ctx, group)
}

// ClusterDiff compares topic sets and layouts of two connections.
func (s *AdminService) ClusterDiff(ctx context.Context, connectionA, connectionB string) (domain.ClusterDiff, error) {
	clientA, err := s.pool.Acquire(ctx, connectionA)
	if err != nil {
		return domain.ClusterDiff{}, fmt.Errorf("cluster A: %w", err)
	}
	clientB, err := s.pool.Acquire(ctx, connectionB)
	if err != nil {
		return domain.ClusterDiff{}, fmt.Errorf("cluster B: %w", err)
	}
	topicsA, err := clientA.ListTopics(ctx)
	if err != nil {
		return domain.ClusterDiff{}, fmt.Errorf("cluster A topics: %w", err)
	}
	topicsB, err := clientB.ListTopics(ctx)
	if err != nil {
		return domain.ClusterDiff{}, fmt.Errorf("cluster B topics: %w", err)
	}
	setA := map[string]domain.TopicSummary{}
	setB := map[string]domain.TopicSummary{}
	for _, tp := range topicsA {
		setA[tp.Name] = tp
	}
	for _, tp := range topicsB {
		setB[tp.Name] = tp
	}
	diff := domain.ClusterDiff{
		TopicsOnlyInA: []string{},
		TopicsOnlyInB: []string{},
		Both:          []domain.TopicPairDiff{},
	}
	for name := range setA {
		if _, ok := setB[name]; !ok {
			diff.TopicsOnlyInA = append(diff.TopicsOnlyInA, name)
			continue
		}
		a, b := setA[name], setB[name]
		diff.Both = append(diff.Both, domain.TopicPairDiff{
			Topic:          name,
			PartitionsA:    a.Partitions,
			PartitionsB:    b.Partitions,
			PartitionMatch: a.Partitions == b.Partitions,
		})
	}
	for name := range setB {
		if _, ok := setA[name]; !ok {
			diff.TopicsOnlyInB = append(diff.TopicsOnlyInB, name)
		}
	}
	sortStrings(diff.TopicsOnlyInA)
	sortStrings(diff.TopicsOnlyInB)
	sortPairDiffs(diff.Both)
	return diff, nil
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

func sortPairDiffs(s []domain.TopicPairDiff) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j].Topic < s[j-1].Topic; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// SchemaRegistryService manages saved registry connections and subject browsing.
type SchemaRegistryService struct {
	store   *registryStore
	secrets domain.SecretStore
}

func NewSchemaRegistryService(db *store.DBWrapper, secrets domain.SecretStore) *SchemaRegistryService {
	return &SchemaRegistryService{store: newRegistryStore(db), secrets: secrets}
}

func (s *SchemaRegistryService) List(ctx context.Context) ([]domain.SchemaRegistry, error) {
	return s.store.list(ctx)
}

func (s *SchemaRegistryService) Save(ctx context.Context, r domain.SchemaRegistry) (domain.SchemaRegistry, error) {
	if err := r.Validate(); err != nil {
		return domain.SchemaRegistry{}, err
	}
	// Empty ID = new entry. Generate here so repeated creations never
	// collide on the "" primary key (which would silently overwrite the
	// previous insert).
	if r.ID == "" {
		r.ID = newID()
	}
	return s.store.save(ctx, r)
}

func (s *SchemaRegistryService) Delete(ctx context.Context, id string) error {
	return s.store.delete(ctx, id)
}

func (s *SchemaRegistryService) client(r domain.SchemaRegistry, password string) *registry.Client {
	pass := password
	if pass == "" && r.SecretRef != "" && s.secrets != nil {
		// The stored ref is the ONLY durable record of the password (the DB
		// never holds secrets), so every client build must resolve it.
		if p, err := s.secrets.Get("kafka-explorer", r.SecretRef); err == nil {
			pass = p
		}
	}
	return registry.New(r.URL, r.Username, pass)
}

// Test verifies a registry (unsaved form allowed, password passed inline).
func (s *SchemaRegistryService) Test(ctx context.Context, r domain.SchemaRegistry, password string) (string, error) {
	if err := r.Validate(); err != nil {
		return "", err
	}
	return s.client(r, password).TestConnection(ctx)
}

// Subjects lists subjects with their latest version info.
func (s *SchemaRegistryService) Subjects(ctx context.Context, registryID string) ([]domain.SchemaSubject, error) {
	r, err := s.store.get(ctx, registryID)
	if err != nil {
		return nil, err
	}
	c := s.client(r, "")
	names, err := c.ListSubjects(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]domain.SchemaSubject, 0, len(names))
	for _, n := range names {
		sub, err := c.GetSubject(ctx, n)
		if err != nil {
			// one broken subject must not blank the whole list
			out = append(out, domain.SchemaSubject{Name: n})
			continue
		}
		out = append(out, sub)
	}
	return out, nil
}

// Versions returns all versions of one subject.
func (s *SchemaRegistryService) Versions(ctx context.Context, registryID, subject string) ([]domain.SchemaVersion, error) {
	r, err := s.store.get(ctx, registryID)
	if err != nil {
		return nil, err
	}
	return s.client(r, "").ListVersions(ctx, subject)
}

// Compatibility checks a candidate schema against a subject's latest.
func (s *SchemaRegistryService) Compatibility(ctx context.Context, registryID, subject, schema, schemaType string) (domain.CompatibilityCheck, error) {
	r, err := s.store.get(ctx, registryID)
	if err != nil {
		return domain.CompatibilityCheck{}, err
	}
	return s.client(r, "").CheckCompatibility(ctx, subject, schema, schemaType)
}

// DeleteSubject removes a subject. Soft delete keeps versions resolvable
// under ?deleted=true; permanent removes storage entirely.
func (s *SchemaRegistryService) DeleteSubject(ctx context.Context, registryID, subject string, permanent bool) error {
	r, err := s.store.get(ctx, registryID)
	if err != nil {
		return err
	}
	return s.client(r, "").DeleteSubject(ctx, subject, permanent)
}

// DeleteVersion removes one version of a subject (soft unless permanent).
func (s *SchemaRegistryService) DeleteVersion(ctx context.Context, registryID, subject string, version int, permanent bool) (int, error) {
	r, err := s.store.get(ctx, registryID)
	if err != nil {
		return 0, err
	}
	return s.client(r, "").DeleteVersion(ctx, subject, version, permanent)
}

// SetSubjectConfig sets one subject's compatibility level. The level
// whitelist lives here (not the client) so an invalid pick fails before
// any HTTP round trip.
func (s *SchemaRegistryService) SetSubjectConfig(ctx context.Context, registryID, subject, level string) error {
	if !validCompatLevel(level) {
		return fmt.Errorf("无效的兼容性级别 %q（可选 BACKWARD/FORWARD/FULL 及其 _TRANSITIVE/NONE）", level)
	}
	r, err := s.store.get(ctx, registryID)
	if err != nil {
		return err
	}
	return s.client(r, "").SetSubjectConfig(ctx, subject, level)
}

// GlobalConfig reads the registry-wide compatibility level.
func (s *SchemaRegistryService) GlobalConfig(ctx context.Context, registryID string) (domain.GlobalConfig, error) {
	r, err := s.store.get(ctx, registryID)
	if err != nil {
		return domain.GlobalConfig{}, err
	}
	return s.client(r, "").GetGlobalConfig(ctx)
}

// SetGlobalConfig sets the registry-wide compatibility level.
func (s *SchemaRegistryService) SetGlobalConfig(ctx context.Context, registryID, level string) error {
	if !validCompatLevel(level) {
		return fmt.Errorf("无效的兼容性级别 %q（可选 BACKWARD/FORWARD/FULL 及其 _TRANSITIVE/NONE）", level)
	}
	r, err := s.store.get(ctx, registryID)
	if err != nil {
		return err
	}
	return s.client(r, "").SetGlobalConfig(ctx, level)
}

// CompatibilityVersion checks a candidate schema against one exact version
// of a subject (version<=0 = latest).
func (s *SchemaRegistryService) CompatibilityVersion(ctx context.Context, registryID, subject string, version int, schema, schemaType string) (domain.CompatibilityCheck, error) {
	r, err := s.store.get(ctx, registryID)
	if err != nil {
		return domain.CompatibilityCheck{}, err
	}
	return s.client(r, "").CheckCompatibilityVersion(ctx, subject, version, schema, schemaType)
}

func validCompatLevel(level string) bool {
	switch level {
	case "BACKWARD", "BACKWARD_TRANSITIVE", "FORWARD", "FORWARD_TRANSITIVE",
		"FULL", "FULL_TRANSITIVE", "NONE":
		return true
	}
	return false
}

// SchemaByID resolves a Confluent schema id to (schema, type) — the lookup
// behind Avro value decoding.
func (s *SchemaRegistryService) SchemaByID(ctx context.Context, registryID string, id int) (string, string, error) {
	r, err := s.store.get(ctx, registryID)
	if err != nil {
		return "", "", err
	}
	return s.client(r, "").SchemaByID(ctx, id)
}
