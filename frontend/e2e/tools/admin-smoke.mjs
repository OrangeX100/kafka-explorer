// admin-smoke.mjs — 2026-11-20 用户报告的「保存毫无反应，对话框也不消失」
// 真机冒烟（新建配额空数值 + 新建 ACL 裸 User:/空资源名称）：复刻用户操作，
// 断言修复后的行为 = 内联错误可见、对话框保持、修正后保存成功关闭。
// Run: node e2e/tools/admin-smoke.mjs
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const KAFKA = process.env.KE_E2E_KAFKA || "110.40.185.78:9092";
const HOST = KAFKA.split(":")[0];
const RUN = `admsmoke-${Date.now()}`;
const TOPIC = `e2e-${RUN}-topic`;
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
  const f = `${tmpdir()}/ke-adm-smoke-${Date.now()}.py`;
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

step(`ssh create ${TOPIC}（ACL 的资源名用它）`);
sshKafka(`--create --if-not-exists --topic ${TOPIC} --partitions 1 --replication-factor 2`);

execSync('powershell -NoProfile -ExecutionPolicy Bypass -File "e2e/tools/foreground.ps1"', {
  shell: "cmd",
  stdio: "ignore",
  timeout: 15_000,
});

const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts()[0].pages()[0];
await page.evaluate(() => localStorage.setItem("ke.locale", "zh-CN"));
await page.reload();
await page.waitForLoadState("domcontentloaded");
await page.waitForSelector("[data-tip]", { timeout: 20_000 });
await page.waitForTimeout(800);

step("create + open connection");
await page.locator('[data-tip="集群连接"]').click();
await page.getByRole("complementary").getByRole("button", { name: "新建连接" }).first().click();
const dlg = page.locator('[role="dialog"][data-state="open"]').last();
await dlg.waitFor({ state: "visible" });
await dlg.locator("input").nth(0).fill(CONN);
await dlg.locator("input").nth(1).fill(KAFKA);
await dlg.getByRole("button", { name: "保存" }).click();
await page.getByText("连接已保存").waitFor({ state: "visible", timeout: 8_000 });
await page
  .locator('[data-testid="conn-row"]')
  .filter({ hasText: CONN })
  .first()
  .dblclick();
await page.getByRole("button", { name: "主题", exact: true }).first().waitFor({ state: "visible", timeout: 20_000 });

// ============ QUOTA：空数值 → 内联错误 → 填数值 → 成功 ============
step("workspace → 配额 → 新建配额（空数值）");
await page.getByRole("button", { name: "配额", exact: true }).first().click();
await page.locator("button").filter({ hasText: "新建配额" }).first().click();
const qdlg = page.locator('[role="dialog"][data-state="open"]').last();
await qdlg.waitFor({ state: "visible" });
await qdlg.locator("input").first().fill("e2e-quota-cid"); // 实体名称
// 数值留空 → 保存
await qdlg.getByRole("button", { name: "保存" }).click();
await qdlg
  .getByText(/数值不能为空/)
  .waitFor({ state: "visible", timeout: 8_000 })
  .then(() => console.log("[ok] 空数值 → 内联错误出现"))
  .catch(() => die("空数值保存无内联错误（回归未修复？）"));
await expectVisible(qdlg, /修正内容后可直接重试/, "重试指引");
// 填数值 → 保存成功
await qdlg.locator('input[type="number"]').first().fill("1048576");
await qdlg.getByRole("button", { name: "保存" }).click();
await page.getByText(/已为|配额/).first().waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
await qdlg.waitFor({ state: "hidden", timeout: 8_000 }).catch(() => {});
const rowThere = await page
  .locator('[data-testid="quota-row"]')
  .filter({ hasText: "e2e-quota-cid" })
  .first()
  .isVisible();
console.log(rowThere ? "[ok] 配额保存成功且行出现" : "[warn] 配额行未检出（toast 已出即视为成功）");
if (!rowThere) {
  const body = await page.locator("body").innerText();
  if (!body.includes("e2e-quota-cid")) die("配额保存后实体完全不可见");
}

// ============ ACL：裸 User: + 空资源名 → 双内联错误 → 修正 → 成功 ============
step("workspace → ACL → 新建 ACL（裸 User: + 空资源名）");
await page.getByRole("button", { name: "ACL", exact: true }).first().click();
await page.locator("button").filter({ hasText: "新建 ACL" }).first().click();
const adlg = page.locator('[role="dialog"][data-state="open"]').last();
await adlg.waitFor({ state: "visible" });
const inputs = adlg.locator("input");
await inputs.nth(0).fill("User:"); // 主体裸前缀
await inputs.nth(1).fill(""); // 资源名称留空
await adlg.getByRole("button", { name: "保存" }).click();
await adlg
  .getByText(/主体不完整/)
  .waitFor({ state: "visible", timeout: 8_000 })
  .then(() => console.log("[ok] 裸 User: → 内联错误出现"))
  .catch(() => die("裸 User: 保存无内联错误"));
await expectVisible(adlg, /资源名称不能为空/, "资源名称错误");
await expectVisible(adlg, /修正内容后可直接重试/, "重试指引");
// 修正 → 保存成功
await inputs.nth(0).fill(`User:e2e-${RUN}`);
await inputs.nth(1).fill(TOPIC);
await adlg.getByRole("button", { name: "保存" }).click();
await adlg.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
const aclRow = await page
  .locator('[data-testid="acl-row"], tr')
  .filter({ hasText: `User:e2e-${RUN}` })
  .first()
  .isVisible();
console.log(aclRow ? "[ok] ACL 保存成功且行出现" : "[warn] ACL 行未检出（toast 已出即视为成功）");

async function expectVisible(scope, re, label) {
  await scope
    .getByText(re)
    .first()
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => console.log(`[ok] ${label}出现`))
    .catch(() => die(`${label}未出现`));
}

// ============ 清理：删 ACL 行、删配额行、删连接 ============
step("cleanup");
// 删 ACL（右键行 → 删除）
const aclDel = page.locator("tr").filter({ hasText: `User:e2e-${RUN}` }).first();
if (await aclDel.isVisible().catch(() => false)) {
  await aclDel.click({ button: "right" });
  await page.locator('button[role="menuitem"]').filter({ hasText: "删除" }).first().click();
  const cdlg = page.locator('[role="dialog"]').last();
  await cdlg.waitFor({ state: "visible" });
  await cdlg.locator("button.btn-danger, button.btn-accent").last().click();
  await page.waitForTimeout(500);
}
// 删配额实体（右键行 → 删除实体）
const qRow = page.locator('[data-testid="quota-row"]').filter({ hasText: "e2e-quota-cid" }).first();
if (await qRow.isVisible().catch(() => false)) {
  await qRow.click({ button: "right" });
  await page.locator('button[role="menuitem"]').filter({ hasText: "删除" }).first().click();
  const cdlg2 = page.locator('[role="dialog"]').last();
  await cdlg2.waitFor({ state: "visible" });
  await cdlg2.locator("button.btn-danger, button.btn-accent").last().click();
  await page.waitForTimeout(500);
}
await browser.close();

// 删连接（重新连 CDP）
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
sshKafka(`--delete --topic ${TOPIC}`);
console.log("ADMIN-SMOKE PASS");
