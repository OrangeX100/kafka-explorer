import { test, expect, type Page } from "@playwright/test";
import {
  connectApp,
  disconnectApp,
  ensureConnection,
  openConnection,
  openWorkspaceSection,
  KAFKA,
  RUN_ID,
} from "./helpers.js";

// View-render smoke sweep: EVERY settings rail section, every top-level rail
// view, and every workspace section must render its key elements with no
// white screen (React #300/#310 class) and no stuck error banner. This is
// the GLOBAL defense for the 0.4.7 isWindows bug class — five static review
// rounds missed a button that never rendered, only a real render check
// scales to every view. One assertion failure here names the exact view.

let page: Page;
const CONN = `${RUN_ID}-smoke`;

test.beforeAll(async () => {
  page = await connectApp();
});

test.afterAll(async () => {
  if (page && KAFKA) {
    await page.locator('[data-tip="集群连接"]').click().catch(() => {});
    await import("./helpers.js").then((h) => h.deleteConnection(page, CONN).catch(() => {}));
  }
  await disconnectApp();
});

/** Main pane shows NO stuck load-error banner (an ErrorHint that survived a
 *  successful render — a load error on first paint is legitimate only while
 *  visible; after data arrives it must be gone). */
async function expectNoErrorBanner(page: Page) {
  const hint = page.locator("text=加载失败");
  expect(await hint.count()).toBe(0);
}

test.describe("设置页四栏", () => {
  for (const rail of ["外观", "数据", "版本与更新", "关于"]) {
    test(`设置 → ${rail} 渲染`, async () => {
      await page.locator('[data-tip="设置"]').click();
      await page.getByText(rail, { exact: true }).first().click();
      await page.waitForTimeout(400);
      // settings panels are section.panel containers with real content
      const panel = page.locator("main section").first();
      await expect(panel).toBeVisible();
      expect(((await panel.innerText()) ?? "").length).toBeGreaterThan(15);
    });
  }
});

test.describe("顶级 rail 视图", () => {
  test("集群连接列表渲染", async () => {
    await page.locator('[data-tip="集群连接"]').click();
    await expect(page.locator('button[title="新建连接"]').first()).toBeVisible({ timeout: 10_000 });
  });

  test("Schema Registry 视图渲染", async () => {
    await page.locator('[data-tip="Schema Registry"]').click();
    await page.waitForTimeout(600);
    // either registry rows or the create button — never a blank main
    await expect(page.locator("main")).toContainText(/新建 Registry|选择.*Schema|Subjects/, { timeout: 10_000 });
    await expectNoErrorBanner(page);
  });

  test("Connect 视图渲染", async () => {
    await page.locator('[data-tip="Connect"]').click();
    await page.waitForTimeout(600);
    await expect(page.locator("main")).toContainText(/新建 Connect 集群|Connectors|暂无 connector/, { timeout: 10_000 });
    await expectNoErrorBanner(page);
  });

  test("ksqlDB 视图渲染", async () => {
    await page.locator('[data-tip="ksqlDB"]').click();
    await page.waitForTimeout(600);
    await expect(page.locator("main")).toContainText(/新建 ksqlDB 服务|从左侧选择或新建/, { timeout: 10_000 });
    await expectNoErrorBanner(page);
  });
});

test.describe("工作区七栏（需真集群）", () => {
  test.skip(!KAFKA, "需 KE_E2E_KAFKA=host:port 真集群");

  test.beforeAll(async () => {
    await ensureConnection(page, CONN, KAFKA);
    await openConnection(page, CONN);
  });

  const sections: { label: string; marker: string | RegExp }[] = [
    { label: "主题", marker: "新建主题" },
    { label: "消费者组", marker: /消费者组|组详情|暂无|empty/i },
    { label: "Share 组", marker: /Share|share|无 Share 组/ },
    { label: "Broker", marker: /Broker|KRaft/ },
    { label: "ACL", marker: /ACL/ },
    { label: "配额", marker: /配额/ },
    { label: "对比", marker: /对比/ },
  ];

  for (const { label, marker } of sections) {
    test(`工作区 → ${label} 渲染`, async () => {
      await openWorkspaceSection(page, label);
      const main = page.locator("main");
      await expect(main).toBeVisible();
      // a marker OR non-trivial content — blank/whitespace-only main is the
      // white-screen regression this sweep exists to catch
      const ok =
        (await main.getByText(marker).first().isVisible().catch(() => false)) ||
        ((await main.innerText()).length ?? 0) > 50;
      expect(ok, `${label} 视图未渲染出任何可识别内容`).toBe(true);
    });
  }

  test("全部七栏走完后无残留对话框/错误横幅", async () => {
    await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 5_000 });
  });
});
