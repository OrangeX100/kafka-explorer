package application

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"kafkaexplorer/internal/domain"
	"kafkaexplorer/internal/infrastructure/kafka"
)

// IT 门禁：KE_IT_KAFKA=<bootstrap> 走真集群；CI 无变量时诚实跳过。
// 覆盖 2026-11-20 导入修复的服务层守卫（docs/开发文档-导入bug修复-20261120.md）：
// 前置主题校验 + 逐行分区范围守卫 + 正常导入回归（粘贴与文件两路）。
type itRepo struct{ bootstrap string }

func (r *itRepo) List(context.Context) ([]domain.Connection, error) { return nil, nil }
func (r *itRepo) Get(_ context.Context, id string) (domain.Connection, error) {
	return domain.Connection{ID: id, Bootstrap: r.bootstrap}, nil
}
func (r *itRepo) Save(context.Context, domain.Connection) error { return nil }
func (r *itRepo) Delete(context.Context, string) error          { return nil }
func (r *itRepo) SetPinned(context.Context, string, bool) error { return nil }

type itSecrets struct{}

func (itSecrets) Set(string, string, string) error { return nil }
func (itSecrets) Get(string, string) (string, error) {
	return "", fmt.Errorf("no secret")
}
func (itSecrets) Delete(string, string) error { return nil }

func TestITImportGuards(t *testing.T) {
	bootstrap := os.Getenv("KE_IT_KAFKA")
	if bootstrap == "" {
		t.Skip("需要 KE_IT_KAFKA=<bootstrap> 指向真集群")
	}
	ctx := context.Background()
	topic := fmt.Sprintf("e2e-it-guard-%d", time.Now().Unix())

	admin, err := kafka.Open(ctx, domain.Connection{Bootstrap: bootstrap}, "", nil)
	if err != nil {
		t.Fatalf("open admin: %v", err)
	}
	defer admin.Close()
	if err := admin.CreateTopic(ctx, topic, 2, 2, nil); err != nil {
		t.Fatalf("create topic: %v", err)
	}
	t.Cleanup(func() { _ = admin.DeleteTopic(ctx, topic) })

	svc := NewMessageIOService(kafka.NewPool(&itRepo{bootstrap: bootstrap}, itSecrets{}))
	connID := "it-conn"
	input := func(template string) domain.GenerateInput {
		return domain.GenerateInput{ConnectionID: connID, Topic: topic, Template: template}
	}

	t.Run("missing topic gets upfront friendly error", func(t *testing.T) {
		_, err := svc.Import(ctx, domain.GenerateInput{
			ConnectionID: connID, Topic: "e2e-it-no-such-topic", Template: `{"value":"x"}`,
		})
		if err == nil {
			t.Fatal("不存在的主题应当被前置校验拦下")
		}
		for _, want := range []string{"导入前置检查失败", "不存在", "刷新主题列表"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("错误应含 %q，实得：%s", want, err.Error())
			}
		}
	})

	t.Run("out-of-range partition names the valid range", func(t *testing.T) {
		_, err := svc.Import(ctx, input(`{"value":"x","partition":99}`))
		if err == nil {
			t.Fatal("越界分区应当被逐行守卫拦下")
		}
		for _, want := range []string{"line 1", "分区 99 不存在", "0-1"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("错误应含 %q，实得：%s", want, err.Error())
			}
		}
	})

	t.Run("valid lines land (partition + auto)", func(t *testing.T) {
		res, err := svc.Import(ctx, input("{\"value\":\"a\",\"partition\":1}\n\n{\"value\":\"b\"}\n"))
		if err != nil {
			t.Fatalf("合法导入不应报错：%v", err)
		}
		if res.Produced != 2 {
			t.Errorf("Produced = %d, want 2（空行不计）", res.Produced)
		}
		if res.FirstOffset < 0 {
			t.Errorf("FirstOffset 应为首个写入 offset，实得 %d", res.FirstOffset)
		}
	})

	t.Run("file import: good lines land, bad partition listed", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "payload.jsonl")
		content := "{\"value\":\"ok-1\"}\n{\"value\":\"bad\",\"partition\":7}\n{\"value\":\"ok-2\",\"partition\":0}\n"
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatalf("write payload: %v", err)
		}
		res, err := svc.ImportFromFile(ctx, domain.ImportFileInput{ConnectionID: connID, Topic: topic, Path: path})
		if err != nil {
			t.Fatalf("best-effort 文件导入不应整体失败：%v", err)
		}
		if res.Produced != 2 || res.Failed != 1 {
			t.Errorf("Produced/Failed = %d/%d, want 2/1", res.Produced, res.Failed)
		}
		if len(res.FailedLines) != 1 || res.FailedLines[0].Line != 2 {
			t.Fatalf("失败行应记第 2 行，实得 %+v", res.FailedLines)
		}
		if !strings.Contains(res.FailedLines[0].Error, "分区 7 不存在") {
			t.Errorf("失败行错误应含范围文案，实得：%s", res.FailedLines[0].Error)
		}
	})

	t.Run("file import: missing topic fails upfront", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "payload.jsonl")
		if err := os.WriteFile(path, []byte("{\"value\":\"x\"}\n"), 0o600); err != nil {
			t.Fatalf("write payload: %v", err)
		}
		_, err := svc.ImportFromFile(ctx, domain.ImportFileInput{
			ConnectionID: connID, Topic: "e2e-it-no-such-topic", Path: path,
		})
		if err == nil || !strings.Contains(err.Error(), "导入前置检查失败") {
			t.Fatalf("文件路径也应走前置校验，实得：%v", err)
		}
	})
}
