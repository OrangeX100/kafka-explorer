package kafka

import (
	"context"
	"fmt"
	"sort"
	"strconv"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kmsg"

	"kafkaexplorer/internal/domain"
)

// ListBrokers returns the cluster's brokers.
func (c *Client) ListBrokers(ctx context.Context) ([]domain.BrokerSummary, error) {
	md, err := c.adm.Metadata(ctx)
	if err != nil {
		return nil, mapErr(err)
	}
	out := make([]domain.BrokerSummary, 0, len(md.Brokers))
	for _, b := range md.Brokers {
		var rack string
		if b.Rack != nil {
			rack = *b.Rack
		}
		out = append(out, domain.BrokerSummary{ID: b.NodeID, Host: b.Host, Port: b.Port, Rack: rack})
	}
	return out, nil
}

// AlterBrokerConfig sets or clears one broker's dynamic configs. A nil
// value sends the explicit DELETE op (override removed, cluster default
// applies again). Static (restart-only) configs are rejected by the broker
// with a descriptive error, which is surfaced verbatim.
func (c *Client) AlterBrokerConfig(ctx context.Context, brokerID int32, entries map[string]*string) error {
	alters := make([]kadm.AlterConfig, 0, len(entries))
	for k, v := range entries {
		op := kadm.SetConfig
		if v == nil {
			op = kadm.DeleteConfig
		}
		alters = append(alters, kadm.AlterConfig{Op: op, Name: k, Value: v})
	}
	resps, err := c.adm.AlterBrokerConfigs(ctx, alters, brokerID)
	if err != nil {
		return mapErr(err)
	}
	for _, r := range resps {
		if r.Err != nil {
			return mapErr(fmt.Errorf("alter broker %d config: %w", brokerID, r.Err))
		}
	}
	return nil
}

// BrokerDetail returns one broker's dynamic + default configs.
func (c *Client) BrokerDetail(ctx context.Context, brokerID int32) (domain.BrokerDetail, error) {
	brokers, err := c.ListBrokers(ctx)
	if err != nil {
		return domain.BrokerDetail{}, err
	}
	detail := domain.BrokerDetail{
		// Non-nil even when the config list comes back empty (the config
		// pane renders an empty table instead of crashing on null).
		Configs: []domain.ConfigEntry{},
	}
	for _, b := range brokers {
		if b.ID == brokerID {
			detail.BrokerSummary = b
			break
		}
	}
	if detail.Host == "" {
		return domain.BrokerDetail{}, fmt.Errorf("broker %d: %w", brokerID, domain.ErrNotFound)
	}

	// Broker configs ride the DescribeConfigs admin API with a broker resource.
	req := kmsg.NewPtrDescribeConfigsRequest()
	req.IncludeSynonyms = true     // default-value display in the edit dialog
	req.IncludeDocumentation = true // English-mode description fallback
	req.Resources = []kmsg.DescribeConfigsRequestResource{
		{ResourceType: kmsg.ConfigResourceTypeBroker, ResourceName: strconv.Itoa(int(brokerID))},
	}
	resp, err := req.RequestWith(ctx, c.kgo)
	if err != nil {
		return domain.BrokerDetail{}, mapErr(err)
	}
	for _, res := range resp.Resources {
		if res.ErrorCode != 0 {
			return domain.BrokerDetail{}, mapErr(fmt.Errorf("describe broker configs: %w", kerr.ErrorForCode(res.ErrorCode)))
		}
		for _, cfg := range res.Configs {
			value := ""
			if cfg.Value != nil {
				value = *cfg.Value
			}
			doc := ""
			if cfg.Documentation != nil {
				doc = *cfg.Documentation
			}
			// Default value from synonyms (what a revert restores).
			defaultValue := value
			if cfg.Source == kmsg.ConfigSourceDynamicBrokerConfig {
				for _, syn := range cfg.ConfigSynonyms {
					if syn.Source == kmsg.ConfigSourceDefaultConfig && syn.Value != nil {
						defaultValue = *syn.Value
						break
					}
				}
			}
			detail.Configs = append(detail.Configs, domain.ConfigEntry{
				Name:      cfg.Name,
				Value:     value,
				ReadOnly:  cfg.ReadOnly,
				Sensitive: cfg.IsSensitive,
				Doc:       doc,
				// ConfigSource 4=STATIC_BROKER (restart-only), 5=DEFAULT →
				// treat as default. Dynamic overrides read as 覆盖 in the UI.
				Default: cfg.Source == 4 || cfg.Source == 5,

				DefaultValue: defaultValue,
			})
		}
	}
	sort.Slice(detail.Configs, func(i, j int) bool { return detail.Configs[i].Name < detail.Configs[j].Name })
	return detail, nil
}

// ListLogDirs returns per-broker log directory usage.
func (c *Client) ListLogDirs(ctx context.Context) ([]domain.LogDir, error) {
	req := kmsg.NewPtrDescribeLogDirsRequest()
	// nil topics = all
	resp, err := req.RequestWith(ctx, c.kgo)
	if err != nil {
		return nil, mapErr(err)
	}
	out := make([]domain.LogDir, 0, len(resp.Dirs))
	for _, ld := range resp.Dirs {
		dir := domain.LogDir{
			Path:        ld.Dir,
			Topics:      []domain.LogDirTopic{},
			TotalBytes:  uint64(ld.TotalBytes),  //nolint:gosec // broker reports non-negative
			UsableBytes: uint64(ld.UsableBytes), //nolint:gosec // broker reports non-negative
		}
		for _, t := range ld.Topics {
			for _, p := range t.Partitions {
				dir.Topics = append(dir.Topics, domain.LogDirTopic{
					Topic:     t.Topic,
					Partition: p.Partition,
					SizeBytes: uint64(p.Size), //nolint:gosec // broker reports non-negative
					OffsetLag: p.OffsetLag,
				})
			}
		}
		out = append(out, dir)
	}
	return out, nil
}

// ListACLs returns all ACL entries (any principal, any resource).
func (c *Client) ListACLs(ctx context.Context) ([]domain.ACL, error) {
	req := kmsg.NewPtrDescribeACLsRequest()
	// kmsg zero values are 0 = UNKNOWN, which the broker REJECTS by closing
	// the connection (IllegalArgumentException in DescribeAclsRequest.parse).
	// Listing "everything" means every filter at its ANY value.
	req.ResourceType = kmsg.ACLResourceTypeAny
	req.Operation = kmsg.ACLOperationAny
	req.PermissionType = kmsg.ACLPermissionTypeAny
	req.ResourcePatternType = kmsg.ACLResourcePatternTypeAny
	resp, err := req.RequestWith(ctx, c.kgo)
	if err != nil {
		return nil, mapErr(err)
	}
	out := make([]domain.ACL, 0, len(resp.Resources))
	for _, res := range resp.Resources {
		for _, acl := range res.ACLs {
			out = append(out, domain.ACL{
				Principal:      acl.Principal,
				Host:           acl.Host,
				Operation:      acl.Operation.String(),
				PermissionType: acl.PermissionType.String(),
				ResourceType:   res.ResourceType.String(),
				ResourceName:   res.ResourceName,
				PatternType:    res.ResourcePatternType.String(),
			})
		}
	}
	return out, nil
}

// CreateACL adds one access control entry.
func (c *Client) CreateACL(ctx context.Context, acl domain.ACL) error {
	req := kmsg.NewPtrCreateACLsRequest()
	op := kmsg.NewCreateACLsRequestCreation()
	op.Principal = acl.Principal
	op.Host = acl.Host
	op.Operation = aclOpCode(acl.Operation)
	op.PermissionType = aclPermCode(acl.PermissionType)
	op.ResourceType = aclResCode(acl.ResourceType)
	op.ResourceName = acl.ResourceName
	op.ResourcePatternType = aclPatternCode(acl.PatternType)
	req.Creations = []kmsg.CreateACLsRequestCreation{op}
	resp, err := req.RequestWith(ctx, c.kgo)
	if err != nil {
		return mapErr(err)
	}
	for _, e := range resp.Results {
		if e.ErrorCode != 0 {
			return mapErr(fmt.Errorf("create acl: %s", derefStr(e.ErrorMessage)))
		}
	}
	return nil
}

// DeleteACL removes matching entries.
func (c *Client) DeleteACL(ctx context.Context, acl domain.ACL) error {
	req := kmsg.NewPtrDeleteACLsRequest()
	f := kmsg.NewDeleteACLsRequestFilter()
	principal, host, name := acl.Principal, acl.Host, acl.ResourceName
	f.Principal = &principal
	f.Host = &host
	f.Operation = aclOpCode(acl.Operation)
	f.PermissionType = aclPermCode(acl.PermissionType)
	f.ResourceType = aclResCode(acl.ResourceType)
	f.ResourceName = &name
	f.ResourcePatternType = aclPatternCode(acl.PatternType)
	req.Filters = []kmsg.DeleteACLsRequestFilter{f}
	resp, err := req.RequestWith(ctx, c.kgo)
	if err != nil {
		return mapErr(err)
	}
	for _, e := range resp.Results {
		if e.ErrorCode != 0 {
			return mapErr(fmt.Errorf("delete acl: %s", derefStr(e.ErrorMessage)))
		}
	}
	return nil
}

// ListQuotas returns client quota entries.
func (c *Client) ListQuotas(ctx context.Context) ([]domain.Quota, error) {
	req := kmsg.NewPtrDescribeClientQuotasRequest()
	resp, err := req.RequestWith(ctx, c.kgo)
	if err != nil {
		return nil, mapErr(err)
	}
	out := make([]domain.Quota, 0, len(resp.Entries))
	for _, e := range resp.Entries {
		entity := map[string]string{}
		for _, kv := range e.Entity {
			name := ""
			if kv.Name != nil {
				name = *kv.Name
			}
			entity[kv.Type] = name // "" = the wildcard default entity
		}
		values := map[string]float64{}
		for _, v := range e.Values {
			values[v.Key] = v.Value
		}
		out = append(out, domain.Quota{Entity: entity, Values: values})
	}
	return out, nil
}

// AlterQuota upserts (or deletes when value is nil) one quota value.
func (c *Client) AlterQuota(ctx context.Context, entity map[string]string, key string, value *float64) error {
	req := kmsg.NewPtrAlterClientQuotasRequest()
	entry := kmsg.NewAlterClientQuotasRequestEntry()
	for t, n := range entity {
		name := n
		ev := kmsg.AlterClientQuotasRequestEntryEntity{Type: t, Name: &name}
		entry.Entity = append(entry.Entity, ev)
	}
	ops := kmsg.NewAlterClientQuotasRequestEntryOp()
	ops.Key = key
	if value != nil {
		ops.Value = *value
		ops.Remove = false
	} else {
		ops.Remove = true
	}
	entry.Ops = []kmsg.AlterClientQuotasRequestEntryOp{ops}
	req.Entries = []kmsg.AlterClientQuotasRequestEntry{entry}
	resp, err := req.RequestWith(ctx, c.kgo)
	if err != nil {
		return mapErr(err)
	}
	for _, e := range resp.Entries {
		if e.ErrorCode != 0 {
			return mapErr(fmt.Errorf("alter quota: %s", derefStr(e.ErrorMessage)))
		}
	}
	return nil
}

// DeleteConsumerGroup removes an empty group (broker rejects non-empty).
func (c *Client) DeleteConsumerGroup(ctx context.Context, group string) error {
	resp, err := c.adm.DeleteGroup(ctx, group)
	if err != nil {
		return mapErr(err)
	}
	if resp.Err != nil {
		return mapErr(fmt.Errorf("delete group %s: %w", group, resp.Err))
	}
	return nil
}

// --- enum mapping helpers (kmsg codes by name, keeping the domain string API) ---

func aclOpCode(name string) kmsg.ACLOperation {
	switch name {
	case "ANY":
		return kmsg.ACLOperationAny
	case "ALL":
		return kmsg.ACLOperationAll
	case "READ":
		return kmsg.ACLOperationRead
	case "WRITE":
		return kmsg.ACLOperationWrite
	case "CREATE":
		return kmsg.ACLOperationCreate
	case "DELETE":
		return kmsg.ACLOperationDelete
	case "ALTER":
		return kmsg.ACLOperationAlter
	case "DESCRIBE":
		return kmsg.ACLOperationDescribe
	case "CLUSTER_ACTION":
		return kmsg.ACLOperationClusterAction
	case "DESCRIBE_CONFIGS":
		return kmsg.ACLOperationDescribeConfigs
	case "ALTER_CONFIGS":
		return kmsg.ACLOperationAlterConfigs
	case "IDEMPOTENT_WRITE":
		return kmsg.ACLOperationIdempotentWrite
	default:
		return kmsg.ACLOperationAny
	}
}

func aclPermCode(name string) kmsg.ACLPermissionType {
	if name == "DENY" {
		return kmsg.ACLPermissionTypeDeny
	}
	return kmsg.ACLPermissionTypeAllow
}

func aclResCode(name string) kmsg.ACLResourceType {
	switch name {
	case "ANY":
		return kmsg.ACLResourceTypeAny
	case "TOPIC":
		return kmsg.ACLResourceTypeTopic
	case "GROUP":
		return kmsg.ACLResourceTypeGroup
	case "CLUSTER":
		return kmsg.ACLResourceTypeCluster
	case "TRANSACTIONAL_ID":
		return kmsg.ACLResourceTypeTransactionalId
	case "DELEGATION_TOKEN":
		return kmsg.ACLResourceTypeDelegationToken
	case "USER":
		return kmsg.ACLResourceTypeUser
	default:
		return kmsg.ACLResourceTypeAny
	}
}

func aclPatternCode(name string) kmsg.ACLResourcePatternType {
	switch name {
	case "LITERAL":
		return kmsg.ACLResourcePatternTypeLiteral
	case "PREFIXED":
		return kmsg.ACLResourcePatternTypePrefixed
	case "ANY":
		return kmsg.ACLResourcePatternTypeAny
	case "MATCH":
		return kmsg.ACLResourcePatternTypeMatch
	default:
		return kmsg.ACLResourcePatternTypeLiteral
	}
}

func derefStr(s *string) string {
	if s == nil {
		return "unknown error"
	}
	return *s
}
