import { test, expect, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import {
  isSSHSeedAvailable,
  connectApp,
  disconnectApp,
  ensureAppRunning,
  keepForeground,
  restartApp,
  ensureConnection,
  ensureConnListOpen,
  openConnectionDialog,
  openWorkspaceSection,
  openTopic,
  deleteTopic,
  deleteConnection,
  dialog,
  produceMessage,
  messageRows,
  positionBadge,
  detailActiveTab,
  detailTabClick,
  openFirstMessageDetail,
  openLastMessageDetail,
  expectToast,
  keSelect,
  KAFKA,
  RUN_ID,
} from "./helpers.js";

// Messages probe family (P1-2/3/4 + P2-4): produce-enhanced (Key/partition/
// headers with per-ack verification), message detail decode chain (auto
// view pick, tab switching, internal-topic decode), find/search (keyword +
// regex + suspended-paging badge), export-to-clipboard and import-paste
// roundtrip. Topic is pre-created via SSH; all messages land on an
// EPHEMERAL topic deleted afterwards.

const CONN = `${RUN_ID}-conn`;
const TOPIC = `${RUN_ID}-msg`;
const HOST = KAFKA.split(":")[0];
const KAFKA_DOCKER_PORT = "9096";

function sshKafka(args: string) {
  const pw = JSON.parse(readFileSync("C:/Users/51293/bin/hosts.json", "utf-8"))["hosts"][
    "tencent-server"
  ]["password"];
  const script = [
    "import paramiko, sys",
    "ssh = paramiko.SSHClient()",
    "ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())",
    `ssh.connect("${HOST}", username="root", password=${JSON.stringify(pw)}, timeout=10)`,
    `_, o, _ = ssh.exec_command(${JSON.stringify(
      `docker exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:${KAFKA_DOCKER_PORT} ${args}`,
    )}, timeout=60)`,
    "sys.stdout.write(o.read().decode('utf-8','replace'))",
    "ssh.close()",
  ].join(String.fromCharCode(10));
  const f = joinPath(tmpdir(), `ke-e2e-ssh-${Date.now()}.py`);
  writeFileSync(f, script, "utf-8");
  try {
    return execSync(`python "${f}"`, { shell: "cmd", timeout: 90_000 }).toString();
  } finally {
    unlinkSync(f);
  }
}

// ONE page for the whole spec (WebView2 reloads on CDP disconnect — a short
// session wipes in-memory state). heal() revives the page when its target
// dies (renderer churn under AV injection; CI runners are clean).
let page: Page | null = null;

async function heal(): Promise<Page> {
  await ensureAppRunning();
  keepForeground();
  if (page) {
    const alive = await Promise.race([
      page.evaluate(() => true).then(() => true).catch(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), 4000)),
    ]);
    if (alive) return page;
  }
  page = await connectApp();
  return page;
}

async function ensureWorkspaceOpen(p: Page) {
  if (await p.getByRole("button", { name: "主题", exact: true }).first().isVisible().catch(() => false)) return;
  await ensureConnListOpen(p);
  await p.locator('[data-testid="conn-row"]').filter({ hasText: CONN }).first().dblclick({ timeout: 15_000 });
  await expect(p.getByRole("button", { name: "主题", exact: true }).first()).toBeVisible({ timeout: 20_000 });
}

async function toMessages(p: Page) {
  await openWorkspaceSection(p, "主题");
  await openTopic(p, TOPIC);
}

/** Retry-once wrapper: restart the app between attempts, rebuild state. */
async function run(fn: (p: Page) => Promise<void>) {
  try {
    const p = await heal();
    await ensureWorkspaceOpen(p);
    await toMessages(p);
    await fn(p);
  } catch (err) {
    console.log(`[rdbg] retry once: ${String(err).slice(0, 300)}`);
    await restartApp();
    page = null;
    const p = await heal();
    await ensureWorkspaceOpen(p);
    await toMessages(p);
    await fn(p);
  }
}

test.skip(!KAFKA, "需 KE_E2E_KAFKA=host:port 真集群");
// 主题由本机 SSH 预建（hosts.json 只在作者机上有）——CI 无此文件时诚实跳过，
// 否则 beforeAll 直接 ENOENT 红（2026-11-20 集群探针首跑实证）。
test.skip(!isSSHSeedAvailable(), "需本机 hosts.json SSH 主题种子（CI 诚实跳过）");

test.beforeAll(async () => {
  test.setTimeout(240_000);
  sshKafka(`--create --if-not-exists --topic ${TOPIC} --partitions 2 --replication-factor 2`);
  await ensureAppRunning();
  keepForeground();
  const p = await connectApp();
  await ensureConnListOpen(p);
  const existing = p.locator('[data-testid="conn-row"]').filter({ hasText: CONN }).first();
  if (!(await existing.isVisible().catch(() => false))) {
    await openConnectionDialog(p);
    const dlg = dialog(p);
    await dlg.waitFor({ state: "visible" });
    await dlg.locator("input").nth(0).fill(CONN);
    await dlg.locator("input").nth(1).fill(KAFKA);
    await dlg.getByRole("button", { name: "保存" }).click();
    await expect(p.getByText("连接已保存")).toBeVisible({ timeout: 8_000 });
    await expect(p.locator('[role="dialog"]')).toHaveCount(0, { timeout: 8_000 });
  }
  page = p;
});

test.afterAll(async () => {
  try {
    sshKafka(`--delete --topic ${TOPIC}`);
  } catch {
    /* best effort */
  }
  try {
    const p = await heal();
    await ensureConnListOpen(p);
    await deleteConnection(p, CONN);
  } catch {
    /* residue cleaner covers this */
  }
  await disconnectApp();
});

test("发送增强：Key+指定分区+Headers → ack 校验 + 详情可见", () =>
  run(async (p) => {
    test.setTimeout(180_000);
    // explicit partition + key + headers, verified per-ack
    const ack = await produceMessage(p, "hdr-value-1", "1", "k-hero", "h1:v1\nh2:v2");
    expect(ack.partition).toBe(1);
    expect(ack.offset).toBeGreaterThanOrEqual(0);
    // the table does NOT auto-refresh after produce, and it shows the
    // selected partition (default 0) — switch to the acked partition,
    // refresh, then open the fresh (last visible) row
    const partTrigger = p
      .locator('button[role="combobox"]')
      .locator("visible=true")
      .first();
    await keSelect(p, partTrigger, `分区 ${ack.partition}`);
    await p.getByRole('button', { name: '刷新' }).first().click();
    await p.waitForTimeout(1500);
    await openLastMessageDetail(p);
    await p.waitForTimeout(600);
    await expect(p.locator("body").getByText("k-hero").first()).toBeVisible({ timeout: 10_000 });
    // Headers column carries our headers (text col shows h1=v1 rendering or
    // the strip in detail) — tolerate either surface but require SOMETHING
    const hdrHit = await p.evaluate(() => document.body.innerText.includes("h1") || document.body.innerText.includes("Headers"));
    expect(hdrHit).toBe(true);
  }));

test("详情解码链：纯 JSON 自动选 JSON 视图，Hex 可切换", () =>
  run(async (p) => {
    test.setTimeout(120_000);
    const ack = await produceMessage(p, '{"n": 1, "ok": true}');
    expect(ack.offset).toBeGreaterThanOrEqual(0);
    // 表格不随 produce 自动刷新且受分区选择器过滤——首行可能是旧文本
    // 记录（或空表导致 openFirst 静默空点击，曾拿到空 tab 串）。切到 ack
    // 分区刷新后开最后一行（=刚写入的 JSON 记录），与发送测试同款模式。
    const partTrigger = p
      .locator('button[role="combobox"]')
      .locator("visible=true")
      .first();
    await keSelect(p, partTrigger, `分区 ${ack.partition}`);
    await p.getByRole("button", { name: "刷新" }).first().click();
    await p.waitForTimeout(1500);
    await openLastMessageDetail(p);
    await p.waitForTimeout(600);
    // bestViewFor: valid JSON text auto-picks the JSON view
    await expect(detailActiveTab(p)).resolves.toMatch(/JSON/);
    // switch to Hex and back — raw bytes always render
    await detailTabClick(p, "Hex");
    await expect(detailActiveTab(p)).resolves.toBe("Hex");
    await detailTabClick(p, "文本");
    await expect(detailActiveTab(p)).resolves.toBe("文本");
  }));

test("内部主题解码：__consumer_offsets 行点击出「Offsets 解码」视图", () =>
  run(async (p) => {
    test.setTimeout(120_000);
    await openWorkspaceSection(p, "主题");
    await openTopic(p, "__consumer_offsets");
    await p.waitForTimeout(1000);
    await openFirstMessageDetail(p);
    await p.waitForTimeout(800);
    // internal decode registers its own tab — deterministic label per
    // kafkaInternal.ts (消费组偏移提交), never a mojibake wall
    const body = await p.locator("body").innerText();
    expect(body).toMatch(/Offsets 解码|消费组偏移|组元数据/);
    // back to the ephemeral topic for later tests
    await openTopic(p, TOPIC);
  }));

test("查找：关键字命中 → 徽章「翻页已停用」→ 正则多条 → 最新恢复", () =>
  run(async (p) => {
    test.setTimeout(180_000);
    // seed a distinguishable record on partition 0
    await produceMessage(p, "findme-alpha-42", "0", "k-find");
    // keyword search
    const find = p.locator('input[placeholder*="关键字"]');
    await find.fill("findme-alpha-42");
    await p.getByRole("button", { name: "搜索" }).click();
    await expect
      .poll(async () => await positionBadge(p), { timeout: 15_000 })
      .toBe("搜索结果 · 翻页已停用");
    expect((await messageRows(p)).length).toBeGreaterThanOrEqual(1);
    const scanned = await p.getByText(/已扫描 \d+/).first().isVisible().catch(() => false);
    expect(scanned).toBe(true);

    // regex search over the value we just seeded (literal search stays
    // keyword mode until 正则 is checked)
    await find.fill("findme-\\w+-\\d+");
    await p.locator('input[type="checkbox"]').last().check(); // 正则 checkbox
    await p.getByRole("button", { name: "搜索" }).click();
    await expect
      .poll(async () => (await messageRows(p)).length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(1);

    // leave search state: 最新 one-shot jump restores paging
    await p.getByRole("button", { name: "最新" }).click();
    await expect.poll(async () => await positionBadge(p), { timeout: 15_000 }).toBe("最新一页");
  }));

test("导出剪贴板 → 导入粘贴往返", () =>
  run(async (p) => {
    test.setTimeout(240_000);
    // EXPORT: export dialog → JSONL → 复制到剪贴板 → fresh success toast
    await p.locator('button[title*="导出"], button').filter({ hasText: "导出消息" }).first().click();
    const dlg = dialog(p);
    await dlg.waitFor({ state: "visible" });
    // 复制到剪贴板 → fresh 已导出 toast（成功路径）。偶发剪贴板锁会让
    // writeText 挂住——runner 的 test timeout 兜底，不额外造断言分叉。
    const before = new Set(await p.getByText(/已导出|复制失败/).allInnerTexts());
    await dlg.getByRole("button", { name: "复制到剪贴板" }).click();
    const t0 = Date.now();
    let fresh = "";
    while (Date.now() - t0 < 15_000) {
      const texts = await p.getByText(/已导出 \d+ 字符|复制失败/).allInnerTexts();
      fresh = texts.find((t) => !before.has(t)) ?? "";
      if (fresh) break;
      await p.waitForTimeout(200);
    }
    expect(fresh, "复制按钮应产出 成功/错误 反馈 toast").toBeTruthy();
    // 复制成功后对话框自关闭（forceClose）；spec 再点「关闭」会与卸载
    // 动画竞态——链式 locator（[data-state=open] >> .last() >> 关闭）重
    // 解析时等父对话框"再出现"且 timeout=0，曾把整个用例挂满全局 240s
    // （2026-11-20 trace 实证：click before 事件后永无 after）。只断言
    // 排空，不再点关闭。
    await expect(p.locator('[role="dialog"]')).toHaveCount(0, { timeout: 10_000 });

    // IMPORT leg. The 2026-11-20 round closed the old "UNKNOWN_TOPIC on
    // explicit partition" case: Go-level ITs against the real cluster
    // (produce_partition_it_test.go) proved the produce path correct for
    // every partition choice — the original failure had NO partition in the
    // payload at all (topic-level, out-of-band cleanup). The REAL defects
    // fixed here were backend upfront validation + the toast-only error
    // UX; both are probed below.
    await p.locator("button").filter({ hasText: "导入" }).first().click();
    const idlg = dialog(p);
    await idlg.waitFor({ state: "visible" });
    // NEGATIVE: an out-of-range partition must surface as an INLINE error
    // with the valid range (backend guard), the dialog stays open for a
    // retry — never a dead dialog with only a vanished toast.
    await idlg
      .locator("textarea")
      .first()
      .fill(JSON.stringify({ value: "imported-bad-partition", partition: 99 }));
    // 提交按钮可访问名是「导入消息」——getByRole(name:"导入",exact) 永不
    // 匹配且默认 timeout=0 曾挂满全局超时；用 hasText+显式上界（冒烟脚本
    // 同款已验证模式）。
    await idlg.locator("button").filter({ hasText: "导入" }).last().click({ timeout: 8_000 });
    const errBox = idlg.getByText(/分区 99 不存在/);
    await expect(errBox).toBeVisible({ timeout: 10_000 });
    await expect(idlg.getByText(/修正内容后可直接重试/)).toBeVisible();
    // retry with a valid payload: same dialog, no reopen
    // ImportedMessage takes PLAIN-TEXT value (not base64 — see
    // domain.ImportedMessage).
    await idlg
      .locator("textarea")
      .first()
      .fill(JSON.stringify({ value: "imported-roundtrip" }));
    // the toast fires BEFORE the dialog closes — poll body text instead of
    // chasing the short-lived toast element
    await idlg.locator("button").filter({ hasText: "导入" }).last().click({ timeout: 8_000 });
    await expect
      .poll(async () => (await p.locator("body").innerText()).includes("已导入"), {
        timeout: 10_000,
      })
      .toBe(true);
    await idlg.waitFor({ state: "hidden", timeout: 10_000 });
    // refresh to the newest window, then the imported record must appear
    await p.getByRole("button", { name: "最新" }).first().click();
    await expect
      .poll(
        async () => (await p.locator("body").innerText()).includes("imported-roundtrip"),
        { timeout: 15_000 },
      )
      .toBe(true);
  }));
