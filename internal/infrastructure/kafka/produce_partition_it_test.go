package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"kafkaexplorer/internal/domain"
)

// IT gate: KE_IT_KAFKA=<bootstrap> 走真集群（本机诊断/回归用，CI 无变量时诚实跳过）。
func itBootstrap(t *testing.T) string {
	b := os.Getenv("KE_IT_KAFKA")
	if b == "" {
		t.Skip("需要 KE_IT_KAFKA=<bootstrap> 指向真集群")
	}
	return b
}

// TestITProduceExplicitPartition 复现导入 UNKNOWN_TOPIC_OR_PARTITION：
// 探针时序 = SSH 建主题（2 分区 RF2）→ 手工 produce（显式分区，绿）→
// 导出（JSONL 行携带真实分区号）→ 粘贴导入（按行透传分区）→ 报错。
// 本 IT 用与 app 完全相同的 Open 栈逐项隔离变量。
func TestITProduceExplicitPartition(t *testing.T) {
	bootstrap := itBootstrap(t)
	ctx := context.Background()
	topic := fmt.Sprintf("e2e-it-part-%d", time.Now().Unix())

	c, err := Open(ctx, domain.Connection{Bootstrap: bootstrap}, "", nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer c.Close()
	if err := c.CreateTopic(ctx, topic, 2, 2, nil); err != nil {
		t.Fatalf("create topic: %v", err)
	}
	t.Cleanup(func() { _ = c.DeleteTopic(ctx, topic) })

	// 导出行的真实形状（Export JSONL 渲染器生成，Import 按行解析）。
	exportLine := func(p int) string {
		b, _ := json.Marshal(map[string]any{
			"topic": topic, "partition": p, "offset": 0,
			"timestamp": time.Now().UTC().Format(time.RFC3339),
			"key":       "", "value": "imported-roundtrip",
		})
		return string(b)
	}
	produceImportLine := func(line string) error {
		var rec domain.ImportedMessage
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			return err
		}
		_, err := c.Produce(ctx, topic, rec.Partition, []byte("k"), []byte(*rec.Value), nil)
		return err
	}

	cases := []struct {
		name string
		run  func() error
	}{
		{"explicit-p0-immediate", func() error { _, err := c.Produce(ctx, topic, int32Ptr(0), []byte("k"), []byte("v"), nil); return err }},
		{"explicit-p1-immediate", func() error { _, err := c.Produce(ctx, topic, int32Ptr(1), []byte("k"), []byte("v"), nil); return err }},
		{"nil-partition-immediate", func() error { _, err := c.Produce(ctx, topic, nil, []byte("k"), []byte("v"), nil); return err }},
		{"import-line-p1", func() error { return produceImportLine(exportLine(1)) }},
		{"import-line-p0", func() error { return produceImportLine(exportLine(0)) }},
		{"out-of-range-p99-control", func() error { _, err := c.Produce(ctx, topic, int32Ptr(99), []byte("k"), []byte("v"), nil); return err }},
	}
	for _, tc := range cases {
		err := tc.run()
		got := "OK"
		if err != nil {
			got = "FAIL: " + err.Error()
		}
		t.Logf("%-28s → %s", tc.name, got)
		if strings.Contains(tc.name, "control") {
			if err == nil {
				t.Errorf("%s：越界分区应当报错（对照组失真）", tc.name)
			}
		} else if err != nil {
			t.Errorf("%s：应成功，实得 %v", tc.name, err)
		}
	}

	// 时序假设检验：过 MetadataMaxAge(10s) 窗口后显式分区是否自愈。
	time.Sleep(12 * time.Second)
	if _, err := c.Produce(ctx, topic, int32Ptr(1), []byte("k"), []byte("v-late"), nil); err != nil {
		t.Errorf("explicit-p1-after-12s：应成功（时序假设被推翻），实得 %v", err)
	} else {
		t.Logf("%-28s → OK", "explicit-p1-after-12s")
	}
}

// TestITProbeSequenceReplica 复刻探针真实时序：app 客户端先连（此刻主题
// 尚不存在）→ SSH 侧另建主题 → 浏览分区列表 → 显式分区 produce → 导出形
// JSONL → 按行导入。与 TestITProduceExplicitPartition 的差别仅在客户端
// 连接早于主题创建（初始元数据快照里没有该主题）。
func TestITProbeSequenceReplica(t *testing.T) {
	bootstrap := itBootstrap(t)
	ctx := context.Background()
	topic := fmt.Sprintf("e2e-it-seq-%d", time.Now().Unix())

	// ① app 客户端先连（主题尚不存在——探针的 connectApp 先于 sshKafka create）
	app, err := Open(ctx, domain.Connection{Bootstrap: bootstrap}, "", nil)
	if err != nil {
		t.Fatalf("open app client: %v", err)
	}
	defer app.Close()

	// ② 外部进程（探针=SSH；这里用独立 admin 客户端）后建主题
	admin, err := Open(ctx, domain.Connection{Bootstrap: bootstrap}, "", nil)
	if err != nil {
		t.Fatalf("open admin client: %v", err)
	}
	defer admin.Close()
	if err := admin.CreateTopic(ctx, topic, 2, 2, nil); err != nil {
		t.Fatalf("create topic: %v", err)
	}
	t.Cleanup(func() { _ = admin.DeleteTopic(ctx, topic) })

	// ③ 探针接下来浏览分区列表（export 的 exportPartitions 同款调用）
	ids, err := app.TopicPartitionIDs(ctx, topic)
	if err != nil {
		t.Fatalf("partition ids: %v", err)
	}
	t.Logf("partition ids seen by app client: %v", ids)

	// ④ 显式分区 produce（探针 produce 腿，绿的那条）
	if _, err := app.Produce(ctx, topic, int32Ptr(1), []byte("k"), []byte("seed"), nil); err != nil {
		t.Fatalf("explicit-p1: %v", err)
	}
	// ⑤ 导出→导入形：行携带分区号，按行透传（探针导入腿，曾红的那个）
	line := fmt.Sprintf(`{"topic":%q,"partition":1,"offset":0,"timestamp":%q,"key":"","value":"imported-roundtrip"}`,
		topic, time.Now().UTC().Format(time.RFC3339))
	var rec domain.ImportedMessage
	if err := json.Unmarshal([]byte(line), &rec); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, err := app.Produce(ctx, topic, rec.Partition, []byte("k"), []byte(*rec.Value), nil); err != nil {
		t.Errorf("import-shape-with-partition: %v", err)
	} else {
		t.Logf("import-shape-with-partition → OK")
	}
}

func int32Ptr(v int32) *int32 { return &v }
