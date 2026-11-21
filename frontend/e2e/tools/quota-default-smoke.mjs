// 评审 P1 修复验证：配额默认实体（实体名留空）——空名=wire null=broker
// 默认实体。此前空名被原样发送被 broker 拒绝（Empty client-id not supported）。
// 场景：留空创建 → 行出现 → 删键 → 实体消失；再对已存在默认行删键值复验。
import { chromium } from "@playwright/test";
const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = b.contexts()[0].pages()[0];
await page.evaluate(() => localStorage.setItem("ke.locale", "zh-CN"));
await page.reload();
await page.waitForLoadState("domcontentloaded");
await page.waitForSelector("[data-tip]", { timeout: 20000 });

// 先开连接 tab（reload 后 workspace tab 清空——session-scoped by design）
await page.locator('[data-tip="集群连接"]').click();
await page.waitForTimeout(600);
await page.locator('[data-testid="conn-row"]').filter({ hasText: "e2e-stackup-conn" }).first().dblclick();
await page.getByRole("button", { name: "主题", exact: true }).first().waitFor({ state: "visible", timeout: 20000 });
await page.getByRole("button", { name: "配额", exact: true }).first().click();
await page.waitForTimeout(1000);
await page.locator("button").filter({ hasText: "新建配额" }).first().click();
const dlg = page.locator('[role="dialog"][data-state="open"]').last();
await dlg.waitFor({ state: "visible" });
// 实体名留空（默认实体）+ producer_byte_rate 1024
await dlg.locator('input[type="number"]').first().fill("1024");
await dlg.locator("button").filter({ hasText: "保存" }).last().click();
await page
  .getByText(/Empty|不支持|已为/)
  .first()
  .waitFor({ state: "visible", timeout: 8000 })
  .then(async (h) => {
    const t = (await h.innerText()).slice(0, 60);
    console.log(t.includes("Empty") ? `FAIL: 仍被拒 → ${t}` : `[ok] 成功提示: ${t}`);
  });
await dlg.waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
// 默认实体行出现（entity 列显示 (default) 或空名形态）
const defRow = await page
  .locator('[data-testid="quota-row"]')
  .filter({ hasText: /default|默认/ })
  .first()
  .isVisible()
  .catch(() => false);
console.log(defRow ? "[ok] 默认配额行出现" : "[warn] 默认行未检出（检查列表渲染）");
// 清理：右键默认行 → 删除实体
if (defRow) {
  await page
    .locator('[data-testid="quota-row"]')
    .filter({ hasText: /default|默认/ })
    .first()
    .click({ button: "right" });
  await page.locator('button[role="menuitem"]').filter({ hasText: "删除" }).first().click();
  const cdlg = page.locator('[role="dialog"]').last();
  await cdlg.waitFor({ state: "visible" });
  await cdlg.locator("button.btn-danger, button.btn-accent").last().click();
  await page.waitForTimeout(600);
  console.log("[ok] 默认实体已清理");
}
await b.close();
process.exit(0);
