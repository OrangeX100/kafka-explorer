// 修复验证：原叠加场景（tbody key 变化+双 tbody 瞬态）——连发翻页/切分区
// 并高频采样行数与窗口，任何一次 sample 出现双 tbody（DOM 行数 > 可见行数
// 或行数≠窗口预期）即报。
import { chromium } from "@playwright/test";
const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = b.contexts()[0].pages()[0];
await page.evaluate(() => localStorage.setItem("ke.locale", "zh-CN"));
await page.reload();
await page.waitForLoadState("domcontentloaded");
await page.waitForSelector("[data-tip]", { timeout: 20000 });

// 建 tab：ratescan（大数据量）——直接点主题列表
await page.locator('[data-tip="集群连接"]').click();
await page.waitForTimeout(600);
await page.locator('[data-testid="conn-row"]').filter({ hasText: "e2e-stackup-conn" }).first().dblclick();
await page.getByRole("button", { name: "主题", exact: true }).first().waitFor({ state: "visible", timeout: 20000 });
await page.waitForTimeout(1200);
await page.locator('[data-testid="topic-row"]').filter({ hasText: "kafka-explorer-ratescan" }).first().click();
await page.getByRole("button", { name: "最早" }).first().waitFor({ state: "visible", timeout: 15000 });
await page.waitForTimeout(1500);

// 高频采样：翻页/切换/刷新交替，每次操作后 200ms 间隔连续采样 3 次
let violations = 0;
const sample = async (label) => {
  for (let k = 0; k < 3; k++) {
    const r = await page.evaluate(() => {
      const all = document.querySelectorAll("table tbody").length;
      const rows = [...document.querySelectorAll("table tbody tr")].filter(tr => tr.checkVisibility?.());
      const os = rows.map(tr => tr.cells?.[1]?.textContent?.trim()).filter(x => /^\d+$/.test(x));
      return { tbodyCount: all, visRows: rows.length, win: os.length ? `${os[0]}..${os[os.length - 1]}` : "empty" };
    });
    // 违规：多于 1 个 tbody（瞬态双份）或窗口行数异常
    if (r.tbodyCount > 1) { violations++; console.log(`VIOLATION ${label}: tbodies=${r.tbodyCount}`); }
    await page.waitForTimeout(200);
  }
  const last = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("table tbody tr")].filter(tr => tr.checkVisibility?.());
    const os = rows.map(tr => tr.cells?.[1]?.textContent?.trim()).filter(x => /^\d+$/.test(x));
    return `${rows.length} rows [${os[0] ?? "-"}..${os[os.length - 1] ?? "-"}]`;
  });
  console.log(`${label}: ${last}`);
};

for (let i = 0; i < 3; i++) {
  await page.locator("button").filter({ hasText: "最新" }).locator("visible=true").first().click();
  await sample(`c${i} 最新`);
  await page.locator("button").filter({ hasText: "上一页" }).locator("visible=true").first().click();
  await sample(`c${i} 上一页`);
  await page.locator("button").filter({ hasText: "下一页" }).locator("visible=true").first().click();
  await sample(`c${i} 下一页`);
  await page.locator("button").filter({ hasText: "刷新" }).locator("visible=true").first().click();
  await sample(`c${i} 刷新`);
}
// 分区切换
for (const p of ["分区 0", "分区 1"]) {
  await page.locator('button[role="combobox"]').filter({ hasText: /^分区/ }).locator("visible=true").first().click();
  await page.locator('[role="listbox"][data-state="open"] [role="option"]').filter({ hasText: new RegExp(`^${p}`) }).first().click({ timeout: 5000 }).catch(() => {});
  await sample(p);
}
console.log(violations === 0 ? "STACKUP-VERIFY PASS（0 违规）" : `STACKUP-VERIFY FAIL（${violations} 违规）`);
await b.close();
process.exit(0);
