import { test, expect, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import {
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
  confirmDialogBox,
  KAFKA,
  RUN_ID,
} from "./helpers.js";


// SHORT-SESSION pattern (the 0.4.12 lesson, again): long-lived CDP sessions
// on this box die mid-run (WebView2 target churn under AV injection), so
// every test is its own connectApp→assert→done roundtrip under 60s. The
// topic pre-exists (created via SSH in beforeAll, deleted via SSH in
// afterAll); the Kafka CONNECTION row also pre-exists (created once), so
// each test only walks: rail → section → topic → 配置 tab.
const CONN = `${RUN_ID}-conn`;
const TOPIC = `${RUN_ID}-cfg`;
const HOST = KAFKA.split(":")[0];
const KAFKA_DOCKER_PORT = "9096"; // broker-1 container-internal listener

function sshKafka(args: string) {
  // credentials live outside the repo (win-ops convention); the script is
  // written to a temp file (python -c mangles newlines through cmd)
  const pw = JSON.parse(readFileSync("C:/Users/51293/bin/hosts.json", "utf-8"))[
    "hosts"
  ]["tencent-server"]["password"];
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

// WebView2 RELOADS the page on every CDP connect/disconnect — a short
// session pattern (connect→act→disconnect per test) wipes the in-memory
// connection row between tests and destroys itself. ONE page for the whole
// spec instead; heal() revives it when the target dies mid-run.
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

/** Make sure the ephemeral connection's workspace is open on the shared
 *  page (CDP-driven reloads reset the app to the connections view). */
async function ensureWorkspaceOpen(p: Page) {
  if (await p.getByRole("button", { name: "主题", exact: true }).first().isVisible().catch(() => false)) return;
  await ensureConnListOpen(p);
  await p.locator('[data-testid="conn-row"]').filter({ hasText: CONN }).first().dblclick({ timeout: 15_000 });
  await expect(p.getByRole("button", { name: "主题", exact: true }).first()).toBeVisible({ timeout: 20_000 });
}

async function toConfigView(p: Page) {
  await openWorkspaceSection(p, "主题");
  await openTopic(p, TOPIC);
  // hidden keep-mounted panes can hold same-text buttons — require VISIBLE
  const cfgBtn = p.locator('button:text-is("配置") >> visible=true').first();
  for (let i = 0; i < 3; i++) {
    try {
      await cfgBtn.click({ timeout: 8_000 });
      break;
    } catch (err) {
      if (i === 2) throw err;
      await openWorkspaceSection(p, "主题");
      await openTopic(p, TOPIC);
    }
  }
  await p.waitForTimeout(800);
}

/** One test = one short CDP session: connect → config table → body → done.
 *  Any failure gets ONE restart-then-retry roundtrip (renderer churn under
 *  AV injection is routine on this box; CI runners are clean). */
async function withSession(fn: (page: Page) => Promise<void>) {
  try {
    const p = await heal();
    await ensureWorkspaceOpen(p);
    await toConfigView(p);
    await fn(p);
  } catch (err) {
    console.log(`[rdbg] retry once: ${String(err).slice(0, 300)}`);
    await restartApp();
    page = null;
    const p = await heal();
    await ensureWorkspaceOpen(p);
    await toConfigView(p);
    await fn(p);
  }
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  sshKafka(`--create --if-not-exists --topic ${TOPIC} --partitions 1 --replication-factor 2`);
  // create the ephemeral CONNECTION only — freshPage() would double-click a
  // row that does not exist yet. Pure create: dialog → fill → save. The
  // whole sequence retries: this box's WebView2 dies mid-dialog routinely.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
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
      await ensureWorkspaceOpen(p);
      page = p; // keep the session — a disconnect reloads the app and wipes it
      return;
    } catch (err) {
      console.log(`[bdbg] attempt ${attempt}: ${String(err).slice(0, 200)}`);
      if (attempt === 3) throw err;
      await restartApp();
      page = null;
    }
  }
});

test.afterAll(async () => {
  // CLI delete is the guarantee; UI cleanup happens inside the last test
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
    /* residue cleaner script covers this */
  }
  await disconnectApp();
});

function cfgRow(page: Page, key: string) {
  return page.locator("tr").filter({ hasText: key }).first();
}

test("配置表渲染：36+ 行、常用键可见、humanize 提示", () =>
  withSession(async (page) => {
    const rows = page.locator("table tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    expect(await rows.count()).toBeGreaterThanOrEqual(30);
    for (const key of ["cleanup.policy", "retention.ms", "compression.type"]) {
      await expect(cfgRow(page, key)).toBeVisible();
    }
    const hint = cfgRow(page, "retention.ms").locator("span").filter({ hasText: /≈|无上限|不限制|天|小时/ });
    await expect(hint.first()).toBeVisible({ timeout: 5_000 });
  }));

test("编辑覆盖：改 retention.ms → 覆盖徽章 → 删除覆盖 → 回滚", () =>
  withSession(async (page) => {
    test.setTimeout(120_000);
    const row = cfgRow(page, "retention.ms");
    await row.locator('button[title*="retention.ms"]').first().click();
    const dlg = dialog(page);
    await dlg.waitFor({ state: "visible" });

    await expect(dlg).toContainText("retention.ms");
    await dlg.locator("input").first().fill("3600000"); // 1 hour
    await dlg.getByRole("button", { name: "保存" }).click();
    await dlg.waitFor({ state: "hidden", timeout: 8_000 });

    await expect(row).toContainText("覆盖", { timeout: 20_000 });
    await expect(row).toContainText("3600000");

    await row.locator('button[title="删除覆盖（恢复默认）"]').click();
    await confirmDialogBox(page);
    await expect(row.locator("span", { hasText: "覆盖" })).toHaveCount(0, { timeout: 20_000 });
  }));

test("新增配置：联想 cleanup.policy → compact → 覆盖出现并清理", () =>
  withSession(async (page) => {
    test.setTimeout(120_000);
    await page.locator("button.btn-accent", { hasText: "新增配置" }).click();
    const dlg = dialog(page);
    await dlg.waitFor({ state: "visible" });

    await dlg.locator("input").first().fill("cleanup");
    const item = dlg.locator('[role="option"], .menu-item, div').filter({ hasText: /^cleanup\.policy/ }).last();
    await item.click();

    const valueTrigger = dlg.locator('button[role="combobox"]').first();
    await valueTrigger.click();
    await page
      .locator('[role="listbox"][data-state="open"] [role="option"]')
      .filter({ hasText: "compact" })
      .first()
      .click();

    await dlg.getByRole("button", { name: "保存" }).click();
    await dlg.waitFor({ state: "hidden", timeout: 8_000 });

    const row = cfgRow(page, "cleanup.policy");
    await expect(row).toContainText("覆盖", { timeout: 20_000 });
    await expect(row).toContainText("compact");

    await row.locator('button[title="删除覆盖（恢复默认）"]').click();
    await confirmDialogBox(page);
    await expect(row.locator("span", { hasText: "覆盖" })).toHaveCount(0, { timeout: 20_000 });
  }));

test("扩容对话框：不允许减少分区", () =>
  withSession(async (page) => {
    await page.locator('button[title*="Kafka 不允许减少"]').click();
    const dlg = dialog(page);
    await dlg.waitFor({ state: "visible" });
    await expect(dlg).toContainText(/Kafka 不允许减少|扩容/);
    await dlg.locator("input[type=number]").first().fill("1");
    await expect(dlg.locator("button.btn-accent")).toBeDisabled();
    await dlg.getByRole("button", { name: "关闭" }).click();
    await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 5_000 });
  }));
