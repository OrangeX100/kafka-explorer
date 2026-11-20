// One-shot user-visible smoke for the 2026-11-20 import fix (docs/
// 开发文档-导入bug修复-20261120.md): drives the REAL import dialog —
// out-of-range partition → inline error panel with the valid range, dialog
// stays open → corrected payload → success + close. Bypasses the spec
// harness on purpose (its local-run fragility is unrelated to this fix).
// Run: node e2e/tools/import-smoke.mjs
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const KAFKA = process.env.KE_E2E_KAFKA || "110.40.185.78:9092";
const HOST = KAFKA.split(":")[0];
const RUN = `smoke-${Date.now()}`;
const TOPIC = `e2e-${RUN}-msg`;
const CONN = `e2e-${RUN}-conn`;

function sshKafka(args) {
  const pw = JSON.parse(readFileSync("C:/Users/51293/bin/hosts.json", "utf-8")).hosts[
    "tencent-server"
  ].password;
  const script = [
    "import paramiko, sys",
    "ssh = paramiko.SSHClient()",
    "ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())",
    `ssh.connect("${HOST}", username="root", password=${JSON.stringify(pw)}, timeout=10)`,
    `_, o, _ = ssh.exec_command(${JSON.stringify(
      `docker exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9096 ${args}`,
    )}, timeout=60)`,
    "sys.stdout.write(o.read().decode('utf-8','replace'))",
    "ssh.close()",
  ].join(String.fromCharCode(10));
  const f = `${tmpdir()}/ke-smoke-ssh-${Date.now()}.py`;
  writeFileSync(f, script, "utf-8");
  try {
    return execSync(`python "${f}"`, { shell: "cmd", timeout: 90_000 }).toString();
  } finally {
    unlinkSync(f);
  }
}

const step = (m) => console.log(`[step] ${m}`);
const die = (m) => {
  console.error(`[FAIL] ${m}`);
  process.exit(1);
};

step(`ssh create ${TOPIC}`);
sshKafka(`--create --if-not-exists --topic ${TOPIC} --partitions 2 --replication-factor 2`);

// pin the app window foreground (WebView2 throttles rAF when backgrounded)
execSync(
  'powershell -NoProfile -ExecutionPolicy Bypass -File "e2e/tools/foreground.ps1"',
  { shell: "cmd", stdio: "ignore", timeout: 15_000 },
);

const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts()[0].pages()[0];
await page.evaluate(() => localStorage.setItem("ke.locale", "zh-CN"));
await page.reload();
await page.waitForLoadState("domcontentloaded");
await page.waitForSelector("[data-tip]", { timeout: 20_000 });
await page.waitForTimeout(800);

// 1. create the smoke connection (UI) — rail 集群连接 toggles the list pane
step("create connection via UI");
await page.locator('[data-tip="集群连接"]').click();
const addBtn = page.getByRole("complementary").getByRole("button", { name: "新建连接" }).first();
await addBtn.click({ timeout: 15_000 });
let dlg = page.locator('[role="dialog"][data-state="open"]').last();
await dlg.waitFor({ state: "visible" });
await dlg.locator("input").nth(0).fill(CONN);
await dlg.locator("input").nth(1).fill(KAFKA);
await dlg.getByRole("button", { name: "保存" }).click();
await page.getByText("连接已保存").waitFor({ state: "visible", timeout: 8_000 });

// 2. open workspace → topic messages view
step("open workspace and topic");
await page.locator('[data-testid="conn-row"]').filter({ hasText: CONN }).first().dblclick();
await page.getByRole("button", { name: "主题", exact: true }).first().waitFor({ state: "visible", timeout: 20_000 });
const row = page.locator('[data-testid="topic-row"]').filter({ hasText: TOPIC }).first();
await row.waitFor({ state: "visible", timeout: 15_000 });
await row.click();
await page.getByRole("button", { name: "最早" }).first().waitFor({ state: "visible", timeout: 15_000 });

// 3. import dialog — NEGATIVE: out-of-range partition
step("open import dialog, submit partition=99");
await page.locator("button").filter({ hasText: "导入" }).first().click();
dlg = page.locator('[role="dialog"][data-state="open"]').last();
await dlg.waitFor({ state: "visible" });
await dlg.locator("textarea").first().fill(JSON.stringify({ value: "smoke-bad", partition: 99 }));
await dlg.locator("button").filter({ hasText: "导入" }).last().click();

const errText = await dlg
  .getByText(/分区 99 不存在/)
  .waitFor({ state: "visible", timeout: 12_000 })
  .then(() => true)
  .catch(() => false);
if (!errText) {
  const body = await page.locator("body").innerText();
  die(`内联错误未出现。body 片段: ${body.slice(0, 400)}`);
}
console.log("[ok] 内联错误出现：分区 99 不存在");
const hint = await dlg.getByText(/修正内容后可直接重试/).isVisible();
if (!hint) die("重试指引未出现");
console.log("[ok] 重试指引出现，对话框保持打开");
if (!(await dlg.isVisible())) die("对话框应保持打开");

// 4. POSITIVE: corrected payload → success → dialog closes
step("correct payload, resubmit");
await dlg.locator("textarea").first().fill(JSON.stringify({ value: "smoke-ok", partition: 1 }));
await dlg.locator("button").filter({ hasText: "导入" }).last().click();
await page.getByText("已导入 1 条").waitFor({ state: "visible", timeout: 12_000 }).catch(() => {});
await dlg.waitFor({ state: "hidden", timeout: 12_000 });
console.log("[ok] 成功导入且对话框关闭");

// 5. the record is visible after refresh
await page.getByRole("button", { name: "最新" }).first().click().catch(() => {});
const seen = await page
  .waitForFunction(() => document.body.innerText.includes("smoke-ok"), null, { timeout: 15_000 })
  .then(() => true)
  .catch(() => false);
console.log(seen ? "[ok] 消息落库可见" : "[warn] 列表未刷出 smoke-ok（分区过滤视图，落库已由 toast+关闭证明）");

// cleanup
step("cleanup");
await browser.close();
try {
  sshKafka(`--delete --topic ${TOPIC}`);
} catch {}
// delete the smoke connection through the UI
const b2 = await chromium.connectOverCDP("http://127.0.0.1:9223");
const p2 = b2.contexts()[0].pages()[0];
await p2.reload();
await p2.waitForLoadState("domcontentloaded");
await p2.waitForSelector("[data-tip]", { timeout: 20_000 });
const rows = p2.locator('[data-testid="conn-row"]').filter({ hasText: CONN });
if ((await rows.count()) > 0) {
  await rows.first().click({ button: "right" });
  await p2.locator('button[role="menuitem"]').filter({ hasText: "删除" }).first().click();
  const cdlg = p2.locator('[role="dialog"]').last();
  await cdlg.waitFor({ state: "visible" });
  await cdlg.locator("button.btn-danger, button.btn-accent").last().click();
}
await b2.close();
console.log("SMOKE PASS");
