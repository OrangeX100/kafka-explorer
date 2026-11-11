package kafka

import (
	"context"
	"fmt"

	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kmsg"
	"kafkaexplorer/internal/domain"
)

// DescribeQuorum reads the KRaft metadata quorum status (KIP-853,
// DescribeQuorum API key 55) for the __cluster_metadata topic. Works on
// KRaft clusters; ZooKeeper clusters answer with UNSUPPORTED_VERSION (or
// UNKNOWN_SERVER_ERROR), which the caller surfaces as "not a KRaft
// cluster" guidance instead of a raw error.
func (c *Client) DescribeQuorum(ctx context.Context) (domain.QuorumInfo, error) {
	req := kmsg.NewPtrDescribeQuorumRequest()
	req.Version = 1
	t := kmsg.NewDescribeQuorumRequestTopic()
	t.Topic = "__cluster_metadata"
	p := kmsg.NewDescribeQuorumRequestTopicPartition()
	p.Partition = 0
	t.Partitions = append(t.Partitions, p)
	req.Topics = append(req.Topics, t)

	resp, err := c.kgo.Request(ctx, req)
	if err != nil {
		return domain.QuorumInfo{}, fmt.Errorf("quorum 描述失败: %w", err)
	}
	qr, ok := resp.(*kmsg.DescribeQuorumResponse)
	if !ok {
		return domain.QuorumInfo{}, fmt.Errorf("quorum 响应类型异常")
	}
	if qr.ErrorCode != 0 {
		return domain.QuorumInfo{}, fmt.Errorf("quorum 请求被拒绝 (code %d): %s", qr.ErrorCode, kerrText(qr.ErrorCode))
	}
	for _, tp := range qr.Topics {
		for _, part := range tp.Partitions {
			if part.ErrorCode != 0 {
				return domain.QuorumInfo{}, fmt.Errorf("quorum 分区查询失败 (code %d)", part.ErrorCode)
			}
			info := domain.QuorumInfo{
				LeaderID:     part.LeaderID,
				LeaderEpoch:  part.LeaderEpoch,
				HighWatermark: part.HighWatermark,
				// Non-nil even with zero voters — the null-array contract.
				Voters: []domain.QuorumVoter{},
			}
			for _, vt := range part.CurrentVoters {
				info.Voters = append(info.Voters, domain.QuorumVoter{
					ReplicaID:     vt.ReplicaID,
					Role:          "voter",
					LogEndOffset:  vt.LogEndOffset,
					LastFetchMs:   vt.LastFetchTimestamp,
					Synced:        vt.LogEndOffset < 0 || vt.LogEndOffset == part.HighWatermark,
					IsLeader:      vt.ReplicaID == part.LeaderID,
				})
			}
			for _, ob := range part.Observers {
				info.Voters = append(info.Voters, domain.QuorumVoter{
					ReplicaID:    ob.ReplicaID,
					Role:         "observer",
					LogEndOffset: ob.LogEndOffset,
					LastFetchMs:  ob.LastFetchTimestamp,
					Synced:       ob.LogEndOffset == part.HighWatermark,
					IsLeader:     false,
				})
			}
			for _, n := range qr.Nodes {
				if n.NodeID == info.LeaderID {
					for _, l := range n.Listeners {
						if l.Name == "CONTROLLER" {
							info.ControllerEndpoint = fmt.Sprintf("%s:%d", l.Host, l.Port)
						}
					}
				}
			}
			return info, nil
		}
	}
	return domain.QuorumInfo{}, fmt.Errorf("quorum 响应中没有 __cluster_metadata 分区")
}

func kerrText(code int16) string {
	if e := kerr.ErrorForCode(code); e != nil {
		return e.Error()
	}
	return fmt.Sprintf("错误码 %d", code)
}
