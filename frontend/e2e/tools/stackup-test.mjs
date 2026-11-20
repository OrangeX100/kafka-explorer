import { chromium } from "@playwright/test";
const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = b.contexts()[0].pages()[0];
const domRows = () => page.evaluate(() => document.querySelectorAll("table tbody tr").length);

// ① section 主题 → filter → 开第二个主题 tab
await page.locator("button.btn").filter({ hasText: "主题" }).locator("visible=true").first().click();
await page.waitForTimeout(1000);
await page.getByPlaceholder("filter…").first().fill("e2e-smoke-1795148501807-msg");
await page.waitForTimeout(800);
await page.locator('[data-testid="topic-row"]').filter({ hasText: "e2e-smoke-1795148501807-msg" }).first().click();
await page.waitForTimeout(1500);
console.log("tab2 opened, DOM rows:", await domRows());

// ② tab 栏列出所有 tab
const tabs = await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map(t => t.textContent.trim().slice(0, 20)));
console.log("tabs:", JSON.stringify(tabs));

// ③ 循环切换并计数
for (let i = 0; i < 3; i++) {
  for (const n of tabs) {
    await page.locator('[role="tab"]').filter({ hasText: n.slice(0, 10) }).first().click().catch(() => {});
    await page.waitForTimeout(900);
    console.log(`cycle${i} [${n.slice(0, 12)}] DOM rows:`, await domRows());
  }
}
await b.close();
process.exit(0);
