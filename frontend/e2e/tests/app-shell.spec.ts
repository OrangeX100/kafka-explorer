import { test, expect, chromium, type Browser, type Page } from "@playwright/test";

// Enterprise UI test suite: connects over CDP to the RUNNING Wails/WebView2
// app (KE_DEBUG_CDP debug build — task dev:cdp) and verifies user-visible
// rendering paths vitest cannot reach — the 0.4.7 isWindows class of bugs
// (five static review rounds missed it; only a real render catches it).
//
//   1. task dev:cdp                       # build + launch app, CDP on 9223
//   2. cd frontend && npx playwright test # this suite
//   3. npx playwright show-report         # HTML report
//
// Locators use real Playwright auto-waiting (actionability checks), NOT
// document.querySelector .click() — a JS .click() bypasses visibility and
// hit-target checks and can pass while a real user sees nothing happen.

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  browser = await chromium.connectOverCDP(
    process.env.CDP_HTTP_URL || "http://127.0.0.1:9223",
  );
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("CDP 已连通但没有浏览器上下文（应用窗口可能尚未启动）");
  page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  // connectOverCDP: close() only disconnects the test process — the app
  // keeps running for manual inspection after a failure.
  await browser.close();
});

test.describe("应用外壳", () => {
  test("侧边栏导航已渲染（应用完成启动）", async () => {
    // Every sidebar nav item is a [data-tip] button. If they render, React
    // mounted, the wails bindings loaded, and the shell is up.
    await expect(page.locator("[data-tip]").first()).toBeVisible({
      timeout: 15_000,
    });
    expect(await page.locator("[data-tip]").count()).toBeGreaterThanOrEqual(3);
  });

  test("navigator.userAgent 含 windows（0.4.7 isWindows 回归防线）", async () => {
    // WebView2 UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ..." — the
    // old anchored /^windows/i never matched, hiding settings entries.
    const ua = await page.evaluate(() => navigator.userAgent);
    expect(ua).toMatch(/windows/i);
  });
});

test.describe("设置 → 版本与更新", () => {
  test.beforeEach(async () => {
    // 齿轮按钮（Sidebar 的 data-tip = settings.title「设置」）
    await page.locator('[data-tip="设置"]').click();
    // 设置页分区项「版本与更新」（settings.updates）。exact:true 不匹配
    // 自动检查更新 toast（那里只是子串）。
    await page.getByText("版本与更新", { exact: true }).first().click();
  });

  test("检查更新产出结果框（中文分类文案）", async () => {
    await page.getByRole("button", { name: "检查更新" }).click();
    const result = page.getByTestId("update-result");
    await expect(result).toBeVisible({ timeout: 30_000 });
    // 成功路径提示当前/新版本号，失败路径给出中文分类错误——两者都算
    // 「结果框渲染了用户可读内容」。一个纯空白框才是 bug。
    await expect(result).toContainText(/0\.4\.\d+|错误|失败|不可用|最新/, {
      timeout: 5_000,
    });
  });
});
