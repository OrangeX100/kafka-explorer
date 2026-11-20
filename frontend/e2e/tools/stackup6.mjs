// 行叠加复现 v6——【探针原时序逐字复刻】。唯一差异假设已收窄到：
// messages.spec 的 produce 循环【每次都走「对话框 → keSelect 分区下拉」
// → 发送 → 对话框关闭 → 刷新按钮 → keSelect 分区下拉再切回】。
// goto 主题现在 30 条（P0 若干+P1 3），配合 perPage 25 制造窗口边界。
import { chromium } from "@playwright/test";
const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = b.contexts()[0].pages()[0];
const show = async (label) => {
  const o = await page.evaluate(() =>
    [...document.querySelectorAll("table tbody tr")]
      .filter(r => r.checkVisibility?.())
      .map(r => ({ p: r.cells?.[0]?.textContent?.trim(), o: r.cells?.[1]?.textContent?.trim() }))
      .filter(x => /^\d+$/.test(x.o)));
  const parts = [...new Set(o.map(x => x.p))];
  console.log(`${label}: visRows=${o.length} parts=[${parts}] win=[${o[0]?.o ?? "-"}..${o[o.length - 1]?.o ?? "-"}]`);
  return o;
};
// 回到消息视图：点工作区 section「主题」？不对——当前 section 就是主题列表，
// 点主题行重开消息详情（keep-mounted messages 视图还在）
await page.locator("button").filter({ hasText: "下一页" }).locator("visible=true").first().click().catch(() => {});
await page.waitForTimeout(700);
await page.locator('[data-testid="topic-row"]').filter({ hasText: "e2e-mwpc3bb2-goto" }).first().click().catch(() => {});
await page.waitForTimeout(1200);
await show("reopen goto");

// 探针原时序：per-page=25 已是。produce 一条（All 视图 sticky）→ 刷新
await page.locator("button.btn-accent").filter({ hasText: "发送消息" }).locator("visible=true").first().click();
const dlg = page.locator('[role="dialog"][data-state="open"]').last();
await dlg.waitFor({ state: "visible" });
await dlg.locator("textarea").first().fill("stackup-final");
await dlg.locator("button").filter({ hasText: "发送消息" }).last().click();
await dlg.waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
await page.waitForTimeout(600);
await show("after produce");

// 逐分区切换（不刷新——看切换本身是否残留）
await page.locator('button[role="combobox"]').filter({ hasText: /^分区/ }).locator("visible=true").first().click();
await page.locator('[role="listbox"][data-state="open"] [role="option"]').filter({ hasText: /^分区 0/ }).first().click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(1200);
await show("switch p0");
await page.locator('button[role="combobox"]').filter({ hasText: /^分区/ }).locator("visible=true").first().click();
await page.locator('[role="listbox"][data-state="open"] [role="option"]').filter({ hasText: /^分区 1/ }).first().click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(1200);
await show("switch p1");
await page.locator('button[role="combobox"]').filter({ hasText: /^分区/ }).locator("visible=true").first().click();
await page.locator('[role="listbox"][data-state="open"] [role="option"]').filter({ hasText: /全部分区|^All/ }).first().click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(1200);
await show("switch all");
await b.close();
process.exit(0);
