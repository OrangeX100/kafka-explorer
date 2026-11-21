package kafka

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"

	"kafkaexplorer/internal/domain"
)

// TestITBrowseTrailingControlRecord 钉住 2026-11-21 的 backward exhausted
// 修复：事务提交在分区尾部留一条 endTxnMarker 控制记录（对所有消费者不
// 可见，2026-11-21 用户报告 ksql 命令主题"水位 2 只显示 1 条"的根因）。
// 修复前 backward 短页按"最新可见 offset+1 ≥ log end"判 exhausted——尾段
// 控制记录让该条件永不成立，exhausted 卡 false，前端缺口横幅不出、下一页
// 落到空页。修复后按"窗口上沿触及 log end"判定，本用例锁死该语义：
//
//	3 条事务数据 + 1 条控制记录 → 水位 4、可见 3、tail 浏览 exhausted=true
func TestITBrowseTrailingControlRecord(t *testing.T) {
	bootstrap := itBootstrap(t)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	topic := fmt.Sprintf("e2e-it-browse-%d", time.Now().Unix())

	admin, err := Open(ctx, domain.Connection{Bootstrap: bootstrap}, "", nil)
	if err != nil {
		t.Fatalf("open admin: %v", err)
	}
	defer admin.Close()
	if err := admin.CreateTopic(ctx, topic, 1, 2, nil); err != nil {
		t.Fatalf("create topic: %v", err)
	}
	// Defer, NOT t.Cleanup: cleanups run AFTER the test fn's defers, by
	// which time admin.Close has already shut the kgo client — every real-
	// cluster run leaked its topic (ErrClientClosed swallowed by _ =).
	// LIFO ordering deletes the topic first, while the client is alive.
	defer func() { _ = admin.DeleteTopic(context.Background(), topic) }()

	// 独立事务生产者：3 条数据记录一个事务提交 → 尾部恰好 1 条控制记录。
	// 用 kgo 原生栈而非 app 生产路径，隔离变量只测浏览语义。
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(bootstrap),
		kgo.TransactionalID(fmt.Sprintf("it-browse-gap-%d", time.Now().Unix())),
		kgo.RecordDeliveryTimeout(30*time.Second),
	)
	if err != nil {
		t.Fatalf("new txn producer: %v", err)
	}
	defer cl.Close()

	// franz-go 事务 API：BeginTransaction 置状态，期间 produce 都进事务，
	// EndTransaction(TryCommit) 提交并写 endTxnMarker 控制记录。
	if err := cl.BeginTransaction(); err != nil {
		t.Fatalf("begin txn: %v", err)
	}
	recs := make([]*kgo.Record, 3)
	for i := range recs {
		recs[i] = &kgo.Record{
			Topic:     topic,
			Partition: 0,
			Key:       []byte(fmt.Sprintf("k%d", i)),
			Value:     []byte(fmt.Sprintf("v%d", i)),
		}
	}
	if err := cl.ProduceSync(ctx, recs...).FirstErr(); err != nil {
		t.Fatalf("txn produce: %v", err)
	}
	if err := cl.EndTransaction(ctx, kgo.TryCommit); err != nil {
		t.Fatalf("commit txn: %v", err)
	}

	// 水位 = 4（3 数据 + 1 控制记录）先证控制记录确实在——否则 exhausted
	// 断言不具区分力（无控制记录时 3 条也会 exhausted=true）。控制记录由
	// coordinator 在提交完成后异步写入数据分区，轮询等待落盘。
	// kadm.Close closes the WRAPPED kgo client too; the explicit cl.Close
	// below would then run twice (harmless but pointless) — review P3.
	adm := kadm.NewClient(cl)
	var endOff int64 = -1
	var lastListErr error
	for i := 0; i < 30; i++ {
		ends, err := adm.ListEndOffsets(ctx, topic)
		if err != nil {
			lastListErr = err // transient WAN blips retry with the loop
			time.Sleep(500 * time.Millisecond)
			continue
		}
		lo, ok := ends.Lookup(topic, 0)
		if ok && lo.Err == nil {
			endOff = lo.Offset
			if endOff == 4 {
				break
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	if endOff != 4 {
		if lastListErr != nil {
			t.Fatalf("事务提交后水位未达 4（实得 %d），末次 ListEndOffsets 错误: %v", endOff, lastListErr)
		}
		t.Fatalf("事务提交后水位应为 4（3 数据+1 控制记录），实得 %d", endOff)
	}

	// tail 浏览（无锚 backward，与 UI 最新按钮同构）：3 条可见 + exhausted。
	p0 := int32(0)
	page, err := admin.BrowsePage(ctx, domain.BrowseRequest{
		ConnectionID: "it",
		Topic:        topic,
		Partition:    &p0,
		Direction:    "backward",
		Limit:        100,
	})
	if err != nil {
		t.Fatalf("backward browse: %v", err)
	}
	if len(page.Messages) != 3 {
		t.Fatalf("可见消息应 3 条（控制记录不可见），实得 %d", len(page.Messages))
	}
	if !page.Exhausted {
		t.Fatal("尾段窗口上沿触及 log end：exhausted 必须为 true（控制记录不得卡住）")
	}
	seen := map[int64]bool{}
	for _, m := range page.Messages {
		seen[m.Offset] = true
	}
	if len(seen) != 3 || !seen[0] || !seen[1] || !seen[2] {
		t.Fatalf("可见 offsets 应恰为 {0,1,2}，实得 %v", seen)
	}
}

// TestITBrowseCompactTopic 压缩主题浏览 sanity：cleanup.policy=compact
// 下按 key 重复写入不破坏浏览与游标（压缩异步执行，此处不等待 compaction
// 真正运行——水位口径与横幅的端到端语义由 UI 探针在 _schemas 上锁）。
func TestITBrowseCompactTopic(t *testing.T) {
	bootstrap := itBootstrap(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	topic := fmt.Sprintf("e2e-it-compact-%d", time.Now().Unix())

	compact := "compact"
	admin, err := Open(ctx, domain.Connection{Bootstrap: bootstrap}, "", nil)
	if err != nil {
		t.Fatalf("open admin: %v", err)
	}
	defer admin.Close()
	if err := admin.CreateTopic(ctx, topic, 1, 2, map[string]*string{
		"cleanup.policy": &compact,
	}); err != nil {
		t.Fatalf("create compact topic: %v", err)
	}
	// LIFO defer — see the txn test's cleanup comment (client must outlive
	// the delete).
	defer func() { _ = admin.DeleteTopic(context.Background(), topic) }()

	cl, err := kgo.NewClient(kgo.SeedBrokers(bootstrap), kgo.RecordDeliveryTimeout(30*time.Second))
	if err != nil {
		t.Fatalf("new producer: %v", err)
	}
	defer cl.Close()
	recs := []*kgo.Record{
		{Topic: topic, Partition: 0, Key: []byte("same"), Value: []byte("v1")},
		{Topic: topic, Partition: 0, Key: []byte("other"), Value: []byte("o1")},
		{Topic: topic, Partition: 0, Key: []byte("same"), Value: []byte("v2")},
	}
	if err := cl.ProduceSync(ctx, recs...).FirstErr(); err != nil {
		t.Fatalf("produce: %v", err)
	}

	p0 := int32(0)
	page, err := admin.BrowsePage(ctx, domain.BrowseRequest{
		ConnectionID: "it",
		Topic:        topic,
		Partition:    &p0,
		Direction:    "backward",
		Limit:        100,
	})
	if err != nil {
		t.Fatalf("compact browse: %v", err)
	}
	if len(page.Messages) != 3 || !page.Exhausted {
		t.Fatalf("无压缩动作前水位=行数=3 且 exhausted，实得 %d 条 exhausted=%v", len(page.Messages), page.Exhausted)
	}
}
