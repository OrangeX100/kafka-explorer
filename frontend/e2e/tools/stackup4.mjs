// 行叠加复现 v4：复刻探针原时序——【发送对话框 30 连发 + 每发之间关弹】
// + 分区下拉切换（All ↔ 分区 0 ↔ 分区 1），这是 messages.spec 发送增强
// 用例的实际形态。关键差异假设：分区切换后旧行残留。
import { chromium } from "@playwright/test";
const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = b.contexts()[0].pages()[0];
const offs = () => page.evaluate(() =>
  [...document.querySelectorAll("table tbody tr")]
    .filter(r => r.checkVisibility?.())
    .map(r => ({ p: r.cells?.[0]?.textContent?.trim(), o: r.cells?.[1]?.textContent?.trim() }))
    .filter(x => /^\d+$/.test(x.o))
);
const dump = (label) => {
  const o = offs.then ? null : null;
  return offs();
};
const show = async (label) => {
  const o = await offs();
  console.log(`${label}: rows=${o.length} partitions=[${[...new Set(o.map(x => x.p))]}] window=[${o[0]?.o}..${o[o.length-1]?.o}]`);
};

// 逐分区发：分区 0 发 1 条（切分区下拉）
await page.locator("button.btn-accent").filter({ hasText: "发送消息" }).locator("visible=true").first().click();
let dlg = page.locator('[role="dialog"][data-state="open"]').last();
await dlg.waitFor({ state: "visible" });
// 分区下拉切到 分区 0
await dlg.locator('button[role="combobox"]').first().click();
await page.locator('[role="listbox"][data-state="open"] [role="option"]').filter({ hasText: /^分区 0$/ }).first().click();
await dlg.locator("textarea").first().fill("part-switch-a");
await dlg.locator("button").filter({ hasText: "发送消息" }).last().click();
await dlg.waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
await page.waitForTimeout(800);
await show("after p0 produce");

// 刷新 → 切分区 1 → 再刷新
await page.locator("button").filter({ hasText: "刷新" }).locator("visible=true").first().click();
await page.waitForTimeout(800);
await show("after refresh (p0)");
await page.locator('button[role="combobox"]').filter({ hasText: /^分区/ }).locator("visible=true").first().click();
await page.locator('[role="listbox"][data-state="open"] [role="option"]').filter({ hasText: /^分区 1$/ }).first().click();
await page.waitForTimeout(1000);
await show("after switch p1");
await page.locator("button").filter({ hasText: "刷新" }).locator("visible=true").first().click();
await page.waitForTimeout(800);
await show("after refresh (p1)");
await b.close();
process.exit(0);
