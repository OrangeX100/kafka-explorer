// 行叠加复现 v5——回到产品源码路径。当前 app 在主题列表视图（工作区 tab
// 还开着 goto 的消息视图，被主题列表盖住）。直接切 tab 回 goto 消息视图。
import { chromium } from "@playwright/test";
const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = b.contexts()[0].pages()[0];
const show = async (label) => {
  const o = await page.evaluate(() =>
    [...document.querySelectorAll("table tbody tr")]
      .filter(r => r.checkVisibility?.())
      .map(r => ({ p: r.cells?.[0]?.textContent?.trim(), o: r.cells?.[1]?.textContent?.trim() }))
      .filter(x => /^\d+$/.test(x.o)));
  console.log(`${label}: visRows=${o.length} partitions=[${[...new Set(o.map(x => x.p))]}]`);
};
// 顶部 tab 栏（TabBar）切换回 goto
const tabs = await page.evaluate(() => [...document.querySelectorAll("[role=\"tab\"]")].map(t => t.textContent.trim().slice(0, 24)));
console.log("tabs:", JSON.stringify(tabs));
for (const n of tabs) {
  await page.locator('[role="tab"]').filter({ hasText: n.slice(0, 12) }).first().click({ timeout: 5000 }).catch(e => console.log("tab fail", n.slice(0, 10)));
  await page.waitForTimeout(1000);
  await show(`tab [${n.slice(0, 14)}]`);
}
// goto tab 上做分区切换序列（All ↔ p0 ↔ p1）不带刷新
const gotoTab = tabs.find(t => t.includes("goto"));
if (gotoTab) {
  await page.locator('[role="tab"]').filter({ hasText: gotoTab.slice(0, 12) }).first().click();
  await page.waitForTimeout(900);
  await show("goto before switch");
  const combo = page.locator('button[role="combobox"]').filter({ hasText: /^分区/ }).locator("visible=true").first();
  await combo.click({ timeout: 5000 }).catch(e => console.log("combo fail"));
  await page.locator('[role="listbox"][data-state="open"] [role="option"]').filter({ hasText: /^分区 0/ }).first().click({ timeout: 5000 }).catch(e => console.log("p0 fail"));
  await page.waitForTimeout(1200);
  await show("goto switch p0");
  await page.locator("button").filter({ hasText: "刷新" }).locator("visible=true").first().click().catch(() => {});
  await page.waitForTimeout(1000);
  await show("goto refresh p0");
}
await b.close();
process.exit(0);
