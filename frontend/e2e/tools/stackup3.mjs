// 行叠加复现 v3：分页窗口移动（探针原始形态：最新→上一页→下一页 在
// 恰好 25+5 条的主题上，窗口钳制边界反复横跳）
import { chromium } from "@playwright/test";
const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = b.contexts()[0].pages()[0];
const dom = () => page.evaluate(() => document.querySelectorAll("table tbody tr").length);
const offs = () => page.evaluate(() =>
  [...document.querySelectorAll("table tbody tr")]
    .filter(r => r.checkVisibility?.())
    .map(r => r.cells?.[1]?.textContent?.trim())
    .filter(x => /^\d+$/.test(x))
);

// goto 主题现在 6 条（P0 3 + P1 3）——All 视图，25/页
// produce 到 30 条制造多窗口（复用发送对话框，不选分区=sticky）
for (let i = 0; i < 24; i++) {
  await page.locator("button.btn-accent").filter({ hasText: "发送消息" }).locator("visible=true").first().click();
  const dlg = page.locator('[role="dialog"][data-state="open"]').last();
  await dlg.waitFor({ state: "visible" });
  await dlg.locator("textarea").first().fill(`bulk-${i}`);
  await dlg.locator("button").filter({ hasText: "发送消息" }).last().click();
  await dlg.waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(200);
}
console.log("after bulk, DOM:", await dom());

// 翻页窗口横跳（探针形态）
const click = async (name) => {
  await page.locator("button").filter({ hasText: name }).locator("visible=true").first().click({ timeout: 5000 }).catch(e => console.log(name, "click fail"));
  await page.waitForTimeout(1000);
  const o = await offs();
  console.log(`after ${name}: rows=${o.length} window=[${o[0]}..${o[o.length-1]}]`);
};
await click("最新");
await click("上一页");
await click("下一页");
await click("上一页");
await click("刷新");
await click("下一页");
await click("刷新");
await click("最早");
await click("刷新");
await click("最新");
await b.close();
process.exit(0);
