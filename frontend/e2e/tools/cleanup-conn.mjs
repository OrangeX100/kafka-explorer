// One-off residue cleanup: delete every e2e-* connection left by failed
// probe runs, through the real UI (row context menu → styled confirm).
// Run: node scripts/e2e/cleanup-conn.mjs
import { chromium } from "@playwright/test";

const CDP_URL = process.env.CDP_HTTP_URL || "http://127.0.0.1:9223";
const browser = await chromium.connectOverCDP(CDP_URL);
const page = browser.contexts()[0].pages()[0];
await page.evaluate(() => localStorage.setItem("ke.locale", "zh-CN"));
await page.reload();
await page.waitForLoadState("domcontentloaded");
await page.waitForSelector('[data-tip]', { timeout: 20000 });
await page.waitForTimeout(800);

const rows = page.locator('[data-testid="conn-row"]').filter({ hasText: /e2e-/ });
const n = await rows.count();
console.log(`e2e 连接残留: ${n}`);

for (let i = 0; i < n; i++) {
  const row = rows.first(); // list re-renders after each delete
  const name = (await row.textContent())?.trim() ?? "?";
  await row.click({ button: "right" });
  await page.locator('button[role="menuitem"]').filter({ hasText: "删除" }).first().click();
  const dlg = page.locator('[role="dialog"]').last();
  await dlg.waitFor({ state: "visible" });
  await dlg.locator("button.btn-danger, button.btn-accent").last().click();
  await page.waitForTimeout(400);
  console.log(`已删除: ${name}`);
}

// also drop any e2e-* topics via the workspace of whichever connection is open
console.log("done");
await browser.close();
