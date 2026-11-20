// 行叠加复现 v2：双 tab（ratescan 大表 + goto 2P 小表），高频切换+翻页/刷新混合
import { chromium } from "@playwright/test";
const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = b.contexts()[0].pages()[0];
const dom = () => page.evaluate(() => document.querySelectorAll("table tbody tr").length);

// tab A：ratescan（已开）。tab B：打开 goto 主题（page2 有 e2e-mwpc3bb2-goto）
await page.locator("button").filter({ hasText: "下一页" }).locator("visible=true").first().click();
await page.waitForTimeout(800);
await page.locator('[data-testid="topic-row"]').filter({ hasText: "e2e-mwpc3bb2-goto" }).first().click();
await page.waitForTimeout(1800);
console.log("goto opened, DOM:", await dom());

// goto 主题 2 分区各产 3 条 → All 视图 6 行
for (let i = 0; i < 3; i++) {
  await page.locator("button.btn-accent").filter({ hasText: "发送消息" }).locator("visible=true").first().click();
  const dlg = page.locator('[role="dialog"][data-state="open"]').last();
  await dlg.waitFor({ state: "visible" });
  await dlg.locator("textarea").first().fill(`stackup-p0-${i}`);
  await dlg.locator("button").filter({ hasText: "发送消息" }).last().click();
  await dlg.waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
}
console.log("after 3 produces, DOM:", await dom());

// 混合操作循环：切 tab → 翻页 → 刷新 → 切回
for (let i = 0; i < 2; i++) {
  await page.locator('[role="tab"]').filter({ hasText: "ratescan" }).first().click().catch(() => {});
  await page.waitForTimeout(800);
  await page.locator("button").filter({ hasText: "下一页" }).locator("visible=true").first().click().catch(() => {});
  await page.waitForTimeout(800);
  console.log(`c${i} ratescan next, DOM:`, await dom());
  await page.locator('[role="tab"]').filter({ hasText: "goto" }).first().click().catch(() => {});
  await page.waitForTimeout(800);
  await page.locator("button").filter({ hasText: "刷新" }).locator("visible=true").first().click().catch(() => {});
  await page.waitForTimeout(800);
  console.log(`c${i} goto refresh, DOM:`, await dom());
}
await b.close();
process.exit(0);
