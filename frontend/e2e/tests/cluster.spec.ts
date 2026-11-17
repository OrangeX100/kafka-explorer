import { test, expect, type Page } from "@playwright/test";
import {
  connectApp,
  disconnectApp,
  ensureConnection,
  ensureConnListOpen,
  dismissOverlays,
  confirmDialogBox,
  openConnection,
  deleteConnection,
  openWorkspaceSection,
  createTopic,
  openTopic,
  deleteTopic,
  produceMessage,
  messageRows,
  positionBadge,
  keSelect,
  dialog,
  openConnectionDialog,
  isTargetLost,
  KAFKA,
  RUN_ID,
} from "./helpers.js";

// Cluster suite: drives a REAL Kafka cluster (KE_E2E_KAFKA=host:port) through
// the user paths static review cannot see. Hygiene rules (burned before):
//   - everything touches EPHEMERAL fixtures named e2e-* + RUN_ID, created
//     through the UI and deleted in afterAll — never a user's data;
//   - the reset-offset probe NEVER clicks 执行重置 (it would mutate commits);
//   - the update probe never clicks 安装并重启 (lives in update-flow.spec).
// The ephemeral Kafka connection is created via the real dialog and deleted
// through the real confirm — connect-crud covers the same loop explicitly.

let page: Page;
const CONN = `${RUN_ID}-conn`;
const PAGING_TOPIC = `${RUN_ID}-paging`;
const GOTO_TOPIC = `${RUN_ID}-goto`;

test.skip(!KAFKA, "需 KE_E2E_KAFKA=host:port 真集群");

async function workspaceOpen(p: Page): Promise<boolean> {
  return p.getByRole("button", { name: "主题", exact: true }).first().isVisible();
}

/** WebView2 occasionally recreates its renderer target (crash-recovery) —
 *  the APP keeps running but our Playwright page handle dies with
 *  "Target page, context or browser has been closed". Every test runs
 *  through run(): reconnect, rebuild the ephemeral workspace (tabs are
 *  session-level, so a fresh page starts with none), retry the body ONCE. */
async function run(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    if (!isTargetLost(err)) throw err;
    page = await connectApp();
    if (!(await workspaceOpen(page).catch(() => false))) {
      await ensureConnListOpen(page).catch(() => {});
      await openConnection(page, CONN);
    }
    await fn();
  }
}

test.beforeAll(async () => {
  page = await connectApp();
  await ensureConnection(page, CONN, KAFKA);
  await openConnection(page, CONN);
});

test.afterAll(async () => {
  test.setTimeout(180_000); // real-UI cleanup of up to 2 topics + 1 connection
  // cleanup order: switch back to the clusters view first (a previous test
  // may have left topView on Schema Registry — the keep-mounted workspace
  // would be HIDDEN and every topic-row interaction would silently fail),
  // then topics, then the connection. Each step heals a lost target.
  if (page) {
    const heal = async (f: () => Promise<void>) => {
      try {
        await f();
      } catch (err) {
        if (!isTargetLost(err)) return;
        page = await connectApp();
        await f();
      }
    };
    await heal(async () => {
      await dismissOverlays(page);
      await page.locator('[data-tip="集群连接"]').click();
      await openWorkspaceSection(page, "主题");
      for (const t of [PAGING_TOPIC, GOTO_TOPIC]) await deleteTopic(page, t);
      await deleteConnection(page, CONN);
    });
  }
  await disconnectApp();
});

test("connect-crud：新建→测试→保存→删除", () => run(async () => {
  test.setTimeout(120_000); // 测试连接往返 + confirm 弹簧动画 stability 重试
  const name = `${RUN_ID}-crud`;
  await ensureConnListOpen(page); // 打开工作区后列表已收起，行交互前必须先展开
  await openConnectionDialog(page);
  const dlg = dialog(page);
  await dlg.waitFor({ state: "visible" });
  await dlg.locator("input").nth(0).fill(name);
  await dlg.locator("input").nth(1).fill(KAFKA);

  // 测试连接 → structured success panel (title + latency chip), not a toast
  await dlg.getByRole("button", { name: "测试连接" }).click();
  await expect(dlg.getByText("连接成功")).toBeVisible({ timeout: 20_000 });

  await dlg.getByRole("button", { name: "保存" }).click();
  // 保存后可能自动重连 → 两联布局收起列表；且 Modal 退场动画 (~400ms) 内
  // backdrop 仍拦截指针。等对话框真消失再碰行。
  await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 5_000 });
  // delete through the SAME proven helper the cleanup uses (row menu +
  // styled confirm + drain) — one implementation, no drift between paths
  await deleteConnection(page, name);
}));

test("messages-paging：最早/最新/上一页/下一页→表内容与徽章一致", () => run(async () => {
  test.setTimeout(300_000); // 30 real produce-dialog cycles
  await openWorkspaceSection(page, "主题");
  await createTopic(page, PAGING_TOPIC, 1);
  await openTopic(page, PAGING_TOPIC);

  // per-page size is the app-wide setting — set 25/页 for two pages, then
  // RESTORE whatever the user had (residue discipline)
  const perPage = page.locator('button[role="combobox"]').filter({ hasText: "/ 页" }).first();
  const originalPerPage = ((await perPage.textContent()) ?? "50 / 页").trim();
  await keSelect(page, perPage, "25 / 页");

  // seed 30 records through the real produce dialog (25/页 → two pages);
  // every acked offset must be exactly i — a lost/duplicated produce fails
  // at ITS step instead of corrupting later page assertions
  for (let i = 0; i < 30; i++) {
    const ack = await produceMessage(page, `paging-${i}`);
    expect(ack.offset).toBe(i);
  }

  // The badge flips INSTANTLY on click while rows load async — poll on the
  // ROW CONTENT (the deterministic target) first, then assert the badge.
  const waitForWindow = async (first: number, last: number) => {
    await expect
      .poll(async () => {
        const rs = await messageRows(page);
        return rs.length ? `${rs[0].offset}-${rs[rs.length - 1].offset}` : "empty";
      }, { timeout: 15_000 })
      .toBe(`${first}-${last}`);
  };

  // 最新: tail window = [logEnd-25 .. logEnd-1] = [5..29]
  await page.getByRole("button", { name: "最新" }).click();
  await waitForWindow(5, 29);
  await expect.poll(async () => positionBadge(page), { timeout: 10_000 }).toBe("最新一页");
  const rows = await messageRows(page);
  expect(rows.map((r) => r.offset)).toEqual(Array.from({ length: 25 }, (_, k) => k + 5));

  // 上一页: window model = [start, start+pageSize) — start steps back a full
  // page and clamps at 0 → [0..24] (overlaps the tail window: the log only
  // has 30 records)
  await page.getByRole("button", { name: "上一页" }).click();
  await waitForWindow(0, 24);
  await expect.poll(async () => positionBadge(page), { timeout: 10_000 }).toBe("offset 0–24");
  expect((await messageRows(page)).map((r) => r.offset)).toEqual(
    Array.from({ length: 25 }, (_, k) => k),
  );

  // 下一页: start advances a page → [25..29] (the remaining 5 records)
  await page.getByRole("button", { name: "下一页" }).click();
  await waitForWindow(25, 29);
  await expect.poll(async () => positionBadge(page), { timeout: 10_000 }).toBe("offset 25–29");
  expect((await messageRows(page)).map((r) => r.offset)).toEqual([25, 26, 27, 28, 29]);

  // 最早: one-shot jump to the log start
  await page.getByRole("button", { name: "最早" }).click();
  await waitForWindow(0, 24);
  await expect.poll(async () => positionBadge(page), { timeout: 10_000 }).toBe("最早一页");
  expect((await messageRows(page)).length).toBe(25);

  // restore the user's per-page setting (ke-select same-value pick is a
  // no-op, so only restore when it actually differs)
  if (originalPerPage !== "25 / 页") await keSelect(page, perPage, originalPerPage);
}));

test("goto-cross-partition：跨分区跳转→统一升序→badge A–B（A<B）", () => run(async () => {
  test.setTimeout(180_000); // 6 produce cycles + dialog flows
  await openWorkspaceSection(page, "主题");
  await createTopic(page, GOTO_TOPIC, 2);
  await openTopic(page, GOTO_TOPIC);

  // deterministic offsets: 3 records to each partition, verified per ack
  for (let i = 0; i < 3; i++) {
    const ack = await produceMessage(page, `goto-p0-${i}`, "0");
    expect(ack.partition).toBe(0);
    expect(ack.offset).toBe(i);
  }
  for (let i = 0; i < 3; i++) {
    const ack = await produceMessage(page, `goto-p1-${i}`, "1");
    expect(ack.partition).toBe(1);
    expect(ack.offset).toBe(i);
  }

  // jump to partition 1 offset 0 from the aggregated (All) view
  await page.getByRole("button", { name: "跳转到" }).click();
  const dlg = dialog(page);
  await dlg.waitFor({ state: "visible" });
  await keSelect(page, dlg.locator('button[role="combobox"]').first(), "1");
  await dlg.locator("input[type=number]").fill("0");
  await dlg.getByRole("button", { name: "跳转", exact: true }).click();

  // the badge flips instantly while the jump's browse loads async — poll on
  // ROW CONTENT (all p1, ascending, starting at 0) before asserting
  await expect
    .poll(async () => {
      const rs = await messageRows(page);
      if (rs.length === 0) return "empty";
      if (!rs.every((r) => r.partition === 1)) return "mixed-partitions";
      return `${rs[0].offset}-${rs[rs.length - 1].offset}`;
    }, { timeout: 15_000 })
    .toBe("0-2");

  const badge = await positionBadge(page);
  const m = /^offset (\d+)–(\d+)$/.exec(badge);
  expect(m, `badge 应为 offset A–B 形态，实际「${badge}」`).toBeTruthy();
  expect(Number(m![1])).toBe(0); // jump landed at p1 offset 0
  expect(Number(m![1])).toBeLessThan(Number(m![2])); // A < B (ascending badge)

  const rows = await messageRows(page);
  expect(rows.length).toBe(3);
  const offsets = rows.map((r) => r.offset);
  expect([...offsets].sort((a, b) => a - b)).toEqual(offsets); // unified ascending
}));

test("groups-seq-guard：快速点击组 A→B→详情与选中一致", () => run(async () => {
  test.setTimeout(90_000);
  await openWorkspaceSection(page, "消费者组");
  const rows = page.locator('[data-testid="group-row"]');
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  test.skip((await rows.count()) < 2, "集群上少于 2 个消费组，无法做序列点击守卫");

  // textContent (not innerText): truncated names keep full text in the DOM
  const nameA = ((await rows.nth(0).locator("span.font-mono").first().textContent()) ?? "").trim();
  const nameB = ((await rows.nth(1).locator("span.font-mono").first().textContent()) ?? "").trim();

  // rapid sequence — the old bug: stale detail from A shown while B selected
  await rows.filter({ hasText: nameA }).first().click();
  await rows.filter({ hasText: nameB }).first().click();

  // selected row = B (accent-muted class)
  const bRow = rows.filter({ hasText: nameB }).first();
  await expect(bRow).toHaveClass(/bg-accent-muted/, { timeout: 10_000 });
  // detail header matches B — 组详情: <span>{group}</span>
  await expect(page.locator("span").filter({ hasText: "组详情:" })).toContainText(nameB, {
    timeout: 10_000,
  });
}));

test("reset-offset-drift：预览后改表单→plan 作废→执行重置不可点击", () => run(async () => {
  test.setTimeout(120_000);
  await openWorkspaceSection(page, "消费者组");
  const rows = page.locator('[data-testid="group-row"]');
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });

  // find a group whose detail has committed offsets (the reset dialog needs
  // a topic); try the first three, else skip — never fabricate commits
  let picked = false;
  for (let i = 0; i < Math.min(3, await rows.count()); i++) {
    await rows.nth(i).click();
    await page.waitForTimeout(800);
    const header = page.locator("span").filter({ hasText: "组详情:" });
    if ((await header.count()) === 0) continue;
    const offsetsTable = page.locator("table tbody tr").filter({ hasText: /\d/ }).first();
    if ((await offsetsTable.count()) > 0) {
      picked = true;
      break;
    }
  }
  test.skip(!picked, "前三个组都没有已提交偏移，跳过");

  // open the WHOLE-GROUP reset dialog from the detail header
  await page.getByRole("button", { name: "重置 Offset" }).click();
  const dlg = dialog(page);
  await dlg.waitFor({ state: "visible" });

  // pick the group's topic, run the mandatory dry-run preview
  const combos = dlg.locator('button[role="combobox"]');
  await combos.first().click(); // topic select
  const firstTopic = page.locator('[role="listbox"][data-state="open"] [role="option"]').first();
  await firstTopic.click();
  await dlg.getByRole("button", { name: "预览计划" }).click();
  const applyBtn = dlg.getByRole("button", { name: "执行重置" });
  await expect(applyBtn).toBeEnabled({ timeout: 15_000 });

  // drift: ANY form change must invalidate the plan (stale plan = wrong
  // commits touched). Switch the mode combo to a DIFFERENT value (same-value
  // picks are no-ops in ke-select) → apply must be disabled again.
  const modeTrigger = combos.nth(1);
  const currentMode = ((await modeTrigger.textContent()) ?? "").trim();
  const modes = ["最早 (earliest)", "最新 (latest)", "指定 offset", "时间戳"];
  const different = modes.find((m) => !currentMode.includes(m)) ?? "指定 offset";
  await keSelect(page, modeTrigger, different);
  await expect(applyBtn).toBeDisabled({ timeout: 5_000 });

  // NEVER apply — close the dialog; no cluster state was touched
  await dlg.getByRole("button", { name: "关闭" }).click();
  await expect(dlg).toBeHidden({ timeout: 5_000 });
}));

test("compat-rollback：兼容级别切换→select 显示跟随（真 SR）", () => run(async () => {
  test.setTimeout(120_000);
  // Schema Registry is a top-level rail item (not inside a workspace tab)
  await page.locator('[data-tip="Schema Registry"]').click();
  // the first registry entry may be an unreachable one (user-configured
  // list order is not ours) — try up to 3 until a registry loads subjects
  const regRows = page.locator('[data-testid="registry-row"]');
  const regCount = await regRows.count();
  test.skip(regCount === 0, "未配置 Schema Registry 连接");
  let subj = page.locator('[data-testid="subject-row"]').first();
  let found = false;
  for (let i = 0; i < Math.min(3, regCount); i++) {
    await regRows.nth(i).click();
    // subjects fetch crosses the public network — poll, don't sample
    try {
      await expect(subj).toBeVisible({ timeout: 12_000 });
      found = true;
      break;
    } catch {
      /* next registry */
    }
  }
  test.skip(!found, "前三个 Registry 都没有可加载的 subjects");
  await subj.click();

  // detail pane tabs: Schema / 版本历史 / 兼容性 / 对比
  await page.getByRole("tab", { name: "兼容性" }).click(); // GlidingTabs 显式 role=tab，getByRole("button") 匹配不到
  // scope the level combobox via its 兼容性级别 label — a page-wide
  // combobox locator would hit hidden keep-mounted panes first
  const levelTrigger = page
    .locator('span:text-is("兼容性级别")')
    .locator('xpath=following::button[@role="combobox"][1]');
  await expect(levelTrigger).toBeVisible({ timeout: 10_000 });
  const originalLabel = ((await levelTrigger.textContent()) ?? "").trim();
  const effectiveOriginal = originalLabel === "" ? "不检查兼容性" : originalLabel;

  // switch to a different level → select must follow (write confirmed)
  const next = effectiveOriginal === "向后兼容" ? "不检查兼容性" : "向后兼容";
  await keSelect(page, levelTrigger, next);
  await expect(levelTrigger).toContainText(next, { timeout: 15_000 });

  // restore the original level → select follows back
  await keSelect(page, levelTrigger, effectiveOriginal);
  await expect(levelTrigger).toContainText(effectiveOriginal, { timeout: 15_000 });
}));