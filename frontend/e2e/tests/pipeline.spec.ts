import { test, expect, type Page } from "@playwright/test";
import {
  connectApp,
  disconnectApp,
  ensureAppRunning,
  keepForeground,
  restartApp,
  ensureConnListOpen,
  openConnectionDialog,
  dialog,
  contextMenuItem,
  confirmDialogBox,
  keSelect,
  RUN_ID,
} from "./helpers.js";

// Pipeline probe family (P2-3): Connect cluster CRUD through the REAL
// dialogs against the live Connect worker, and ksqlDB server CRUD + a real
// SHOW TOPICS query. Both remote services live on the same public host
// (8088). Cluster/server deletion removes ONLY the saved record.

// 0.4.21 评审 P2-2：IP 兜底曾把测试服务器地址公开在仓库里，与
// KE_E2E_KAFKA-as-secret 的设计矛盾——缺失即诚实 skip
const HOST = process.env.KE_E2E_HOST || "";
const SKIP_PIPELINE = !HOST;
const SKIP_REASON = "需 KE_E2E_HOST=测试服务器地址（secret，不再硬编码）";
// 0.4.21 实证：{ skip } 不是合法的 per-test options（被静默忽略，as never
// 连 TS 也骗过）——文件级 test.skip 是唯一可靠的形态
test.skip(SKIP_PIPELINE, SKIP_REASON);
const CONNECT_URL = `http://${HOST}:8088`;
const KSQL_URL = `http://${HOST}:8088`;
const CREG = `${RUN_ID}-connect`;
const KREG = `${RUN_ID}-ksql`;

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

async function run(fn: (p: Page) => Promise<void>) {
  try {
    const p = await heal();
    await fn(p);
  } catch (err) {
    console.log(`[rdbg] retry once: ${String(err).slice(0, 300)}`);
    await restartApp();
    page = null;
    const p = await heal();
    await fn(p);
  }
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  await ensureAppRunning();
  keepForeground();
  page = await connectApp();
});

test.afterAll(async () => {
  await disconnectApp();
});

test("Connect：新建集群→行出现→测试/连接器面板→删除", () =>
  run(async (p) => {
    test.setTimeout(180_000);
    await p.locator('[data-tip="Connect"]').click();
    await p.getByRole("button", { name: "新建 Connect 集群" }).click();
    const dlg = dialog(p);
    await dlg.waitFor({ state: "visible" });
    await dlg.locator("input").nth(0).fill(CREG);
    await dlg.locator("input").nth(1).fill(CONNECT_URL);
    await dlg.getByRole("button", { name: "保存" }).click();
    const row = p.locator('[data-testid="connect-cluster"]').filter({ hasText: CREG }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });

    // select it: the connectors panel loads from the live worker (empty
    // state or real connector rows — both are correct renderings)
    await row.click();
    await expect(
      p.locator("main").getByText(/暂无 connector|连接器/).first(),
    ).toBeVisible({ timeout: 25_000 });

    // delete via row context menu + confirm (removes ONLY the saved record)
    await row.click({ button: "right" });
    await contextMenuItem(p, "删除");
    await confirmDialogBox(p);
    await expect(row).toHaveCount(0, { timeout: 10_000 });
  }));

test("ksqlDB：新建服务→查询页渲染→SHOW TOPICS 真执行→删除", () =>
  run(async (p) => {
    test.setTimeout(180_000);
    await p.locator('[data-tip="ksqlDB"]').click();
    await p.getByRole("button", { name: "新建 ksqlDB 服务" }).click();
    const dlg = dialog(p);
    await dlg.waitFor({ state: "visible" });
    await dlg.locator("input").nth(0).fill(KREG);
    await dlg.locator("input").nth(1).fill(KSQL_URL);
    await dlg.getByRole("button", { name: "保存" }).click();
    await p.waitForTimeout(800);

    // select the server → query editor appears
    const row = p.locator("main").getByText(KREG).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();
    const editor = p.locator("textarea");
    await expect(editor.first()).toBeVisible({ timeout: 15_000 });

    // run a real pull query — the live ksqlDB server answers
    await editor.first().fill("SHOW TOPICS;");
    await p.getByRole("button", { name: "运行" }).click();
    // the query history shows 行 · ms latency once the server answered —
    // the ksqlDB roundtrip's deterministic fingerprint
    await expect(p.locator("main").getByText(/\d+ 行 · \d+ ms/).first()).toBeVisible({
      timeout: 25_000,
    });

    // delete the saved server record via its context menu
    await row.click({ button: "right" });
    await contextMenuItem(p, "删除");
    await confirmDialogBox(p);
    await expect(row).toHaveCount(0, { timeout: 10_000 });
  }));
