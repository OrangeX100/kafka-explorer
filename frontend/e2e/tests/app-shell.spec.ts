import { test, expect } from "@playwright/test";
import { connectApp, disconnectApp, openSettingsSection, type Page } from "./helpers.js";

// Non-cluster UI suite: runs on EVERY push (CI needs only the debug build,
// no Kafka). Covers shell boot, the 0.4.7 isWindows regression, and the
// settings echo-guard bug class (045 round: stale echo rolled back user
// edits).

let page: Page;

test.beforeAll(async () => {
  page = await connectApp();
});

test.afterAll(async () => {
  await disconnectApp();
});

test.describe("应用外壳", () => {
  test("侧边栏导航已渲染（应用完成启动）", async () => {
    // Every sidebar nav item is a [data-tip] button. If they render, React
    // mounted, the wails bindings loaded, and the shell is up.
    await expect(page.locator("[data-tip]").first()).toBeVisible({ timeout: 15_000 });
    expect(await page.locator("[data-tip]").count()).toBeGreaterThanOrEqual(3);
  });

  test("navigator.userAgent 含 windows（0.4.7 isWindows 回归防线）", async () => {
    // WebView2 UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ..." — the
    // old anchored /^windows/i never matched, hiding settings entries.
    const ua = await page.evaluate(() => navigator.userAgent);
    expect(ua).toMatch(/windows/i);
  });
});

test.describe("设置 → 回显守卫", () => {
  test("pageSize 快速连续修改不回滚（echo guard）", async () => {
    // 045 bug class: the 600ms-debounced save echoed the OLD settings object
    // back over a NEWER local edit. Drive two edits inside the debounce
    // window and assert the second edit survives the echo.
    await openSettingsSection(page, "数据");
    const input = page.locator('input[type="number"]').first(); // pageSize row
    await expect(input).toBeVisible({ timeout: 10_000 });

    const original = await input.inputValue();
    // two rapid edits inside the 600ms debounce window
    await input.fill("100");
    await input.fill("200");
    // wait past the debounce + save roundtrip + one potential stale echo
    await page.waitForTimeout(1_400);
    await expect(input).toHaveValue("200", { timeout: 5_000 });

    // restore: same rapid pattern must also survive
    await input.fill(original);
    await page.waitForTimeout(1_400);
    await expect(input).toHaveValue(original, { timeout: 5_000 });
  });
});
