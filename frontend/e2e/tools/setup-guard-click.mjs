// setup-guard-click.mjs — WM_CLOSE 守卫探针的 CDP 段：连探针版 setup 前端
// （DebugFeatures=cdp 戳 + KE_DEBUG_CDP=1），真点「安装」按钮让安装进入
// busy。之后 WM_CLOSE 部分由 installer_guard_probe.ps1（Win32 侧）负责。
// Run: node e2e/tools/setup-guard-click.mjs
import { chromium } from "@playwright/test";

const deadline = Date.now() + 40_000;
let page;
while (Date.now() < deadline) {
  try {
    const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
    page = browser.contexts()[0].pages()[0];
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!page) {
  console.error("CLICK-FAIL: 40s 内连不上 CDP 9223");
  process.exit(1);
}
await page.evaluate(() => localStorage.setItem("ke.locale", "zh-CN"));
const btn = page.getByRole("button").filter({ hasText: /^(安装|升级)$/ }).first();
await btn.waitFor({ state: "visible", timeout: 15_000 });
await btn.click({ timeout: 8_000 });
console.log("CLICK-OK");
process.exit(0);
