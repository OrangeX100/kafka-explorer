// 诊断脚本：连 CDP，检查页面冻结/前台状态，并手动走导入对话框的负例步骤。
import { chromium } from "@playwright/test";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] ?? (await ctx.newPage());
console.log("url:", page.url());

const health = await page.evaluate(async () => {
  const raf = await new Promise((res) => {
    const t0 = performance.now();
    requestAnimationFrame(() => res(performance.now() - t0));
    setTimeout(() => res(-1), 3000);
  });
  return {
    title: document.title,
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
    bodyLen: document.body.innerText.length,
    raf,
  };
});
console.log("health:", JSON.stringify(health));

const ui = await page.evaluate(() => ({
  dialogs: document.querySelectorAll('[role="dialog"][data-state="open"]').length,
  tabs: document.querySelectorAll('[role="tab"]').length,
  buttons: document.querySelectorAll("button").length,
  importBtns: [...document.querySelectorAll("button")].filter((b) => b.textContent?.includes("导入")).length,
  errPanel: document.body.innerText.includes("分区 99 不存在"),
  imported: document.body.innerText.includes("imported-roundtrip"),
}));
console.log("ui:", JSON.stringify(ui));

await browser.close();
console.log("DONE");
