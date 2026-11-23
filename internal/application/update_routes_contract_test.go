package application

import "testing"

// 锁 0.4.21 P1-1 的完整性锚契约：manifest 只走受信任双通道（github 直连 +
// CN 自有），第三方加速器永不入列——加速器曾可伪造 manifest 配对假 digest
// 过全门静默安装（stripUntrustedMirrors 的诞生缘由）。该契约此前只在
// manifestRoutesFor 的注释里声明，CI 无回归防线。
func TestManifestRoutesPinTrustedChannels(t *testing.T) {
	const repo = "OrangeX100/kafka-explorer"
	const cn = "http://127.0.0.1:1"

	got := manifestRoutesFor(repo, cn)
	if len(got) != 2 {
		t.Fatalf("manifest routes must be exactly [github direct, CN self-hosted], got %v", got)
	}
	if got[0] != releaseManifestURL(repo) {
		t.Fatalf("route 0 must be github direct, got %s", got[0])
	}
	if got[1] != cn+"/releases/latest.json" {
		t.Fatalf("route 1 must be CN self-hosted, got %s", got[1])
	}
	for _, r := range got {
		for _, m := range downloadMirrors {
			if len(r) >= len(m) && r[:len(m)] == m {
				t.Fatalf("manifest route must never travel an accelerator: %s (prefix %s)", r, m)
			}
		}
	}

	// CN 基名为空（部分单测隔离用）：仅 github 直连
	got = manifestRoutesFor(repo, "")
	if len(got) != 1 || got[0] != releaseManifestURL(repo) {
		t.Fatalf("empty cnBaseURL must yield github-direct only, got %v", got)
	}
}

// stripUntrustedMirrors：sidecar 候选剥 CN+加速器、放行未知前缀（单测夹具）
// ——sidecar 与 manifest 同为完整性锚，契约必须与 manifest 一致。
func TestStripUntrustedMirrorsSidecarParity(t *testing.T) {
	gh := "https://github.com/OrangeX100/kafka-explorer/releases/download/v1.0.0/KafkaExplorer_Setup_1.0.0.exe.sha256"
	got := stripUntrustedMirrors(downloadCandidates(gh, DownloadSourceAuto))
	if len(got) != 1 || got[0] != gh {
		t.Fatalf("sidecar chain must pin github direct, got %v", got)
	}
}
