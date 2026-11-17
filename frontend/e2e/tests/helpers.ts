import { chromium, expect, type Browser, type Page, type Locator } from "@playwright/test";

// Shared UI-automation infrastructure. Everything here encodes a real
// CDP-probe lesson from the 0.4.x review rounds — keep the comments when
// editing, they are the reason the code looks the way it does.

export const CDP_URL = process.env.CDP_HTTP_URL || "http://127.0.0.1:9223";
/** host:port of a reachable Kafka broker (e.g. 110.40.185.78:9092).
 *  Cluster specs skip entirely when unset. */
export const KAFKA = process.env.KE_E2E_KAFKA || "";
/** Set (plus a binary built with VERSION below the published latest) to
 *  exercise the full update chain: discover → download → cancel → idle. */
export const UPDATE_FLOW = process.env.KE_E2E_UPDATE_FLOW === "1";

export const RUN_ID = `e2e-${Date.now().toString(36)}`;

let browser: Browser;
let currentPage: Page | null = null;

/** Connect over CDP to the RUNNING app. connectOverCDP(http://…), never a
 *  bare wsEndpoint: WebView2's real WS path carries a UUID only revealed by
 *  the /json/version handshake. close() later only disconnects — the app
 *  keeps running for manual inspection after a failure. */
export async function connectApp(): Promise<Page> {
  browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("CDP 已连通但没有浏览器上下文（应用窗口可能尚未启动）");
  // /json/list can list MORE than one page target (DevTools windows included
  // — a real past trap). Prefer the app's own page: the one at the app origin.
  const page =
    ctx.pages().find((p) => !p.url().startsWith("devtools://") && p.url() !== "about:blank") ??
    (await ctx.newPage());
  currentPage = page;
  // ke.locale persists across CDP sessions — a previous crashed run can
  // leave the UI in English and every zh-CN text assertion would lie.
  // Set the locale, then reload so the app re-reads it at boot.
  await page.evaluate(() => localStorage.setItem("ke.locale", "zh-CN"));
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  // Sidebar rail [data-tip] buttons render = React mounted + bindings up.
  await expect(page.locator("[data-tip]").first()).toBeVisible({ timeout: 20_000 });
  return page;
}

export function currentPageOrThrow(): Page {
  if (!currentPage) throw new Error("connectApp() 尚未调用");
  return currentPage;
}

export async function disconnectApp() {
  currentPage = null;
  await browser?.close();
}

/** True when the Playwright page object died out from under us (WebView2
 *  recreates its renderer target on crash-recovery; the APP keeps running,
 *  our handle doesn't). */
export function isTargetLost(err: unknown): boolean {
  const s = String(err);
  return s.includes("has been closed") || s.includes("Target crashed");
}

/* ---------------- navigation ---------------- */

/** Open the settings view and switch to a rail section by exact label
 *  (数据 / 版本与更新 / 关于…). exact:true keeps the auto-check toast
 *  (which only contains 「版本与更新」 as a substring) from matching. */
export async function openSettingsSection(page: Page, rail: string) {
  await page.locator('[data-tip="设置"]').click();
  await page.getByText(rail, { exact: true }).first().click();
  await page.waitForTimeout(300); // section swap animation
}

/** Click a workspace section button (主题 / 消费者组 / Broker …). */
export async function openWorkspaceSection(page: Page, title: string) {
  await page.getByRole("button", { name: title, exact: true }).first().click();
  await page.waitForTimeout(300);
}

/* ---------------- ke-select ---------------- */

/** The custom select is NOT a native <select> — it's a button[role=combobox]
 *  whose options render into a PORTAL (div.ke-select-content[role=listbox]).
 *  querySelector("select") never sees it; drive the real trigger + options. */
export async function keSelect(page: Page, trigger: Locator, optionLabel: string) {
  await trigger.click();
  const listbox = page.locator('[role="listbox"][data-state="open"]');
  await listbox.waitFor({ state: "visible" });
  await listbox.locator('[role="option"]').filter({ hasText: optionLabel }).first().click();
}

/** Pick an option from a Portal'd listbox that is ALREADY open. */
export async function pickOpenOption(page: Page, optionLabel: string) {
  const listbox = page.locator('[role="listbox"][data-state="open"]');
  await listbox.waitFor({ state: "visible" });
  await listbox.locator('[role="option"]').filter({ hasText: optionLabel }).first().click();
}

/* ---------------- context menu ---------------- */

/** Context menu items are <button role="menuitem"> — querySelector by text
 *  would hit the outer same-text div wrapper that has no onClick. */
export async function contextMenuItem(page: Page, label: string) {
  await page.locator('button[role="menuitem"]').filter({ hasText: label }).first().click();
}

/* ---------------- dialogs / confirm ---------------- */

export function dialog(page: Page): Locator {
  // Modal mounts with role="dialog" — far more reliable than className
  // reverse-matching on the fixed overlay. data-state="open" EXCLUDES the
  // closing modal of the previous interaction: its DOM lingers ~400ms
  // through the exit animation, and rapid-fire flows (produce dialogs)
  // would otherwise fill/click the dying node and silently lose sends.
  return page.locator('[role="dialog"][data-state="open"]').last();
}

/** Escape out of any leftover context menu / confirm dialog. A crashed or
 *  timed-out previous step can leave overlays open; every subsequent
 *  pointer interaction would then be blocked by their backdrop. */
export async function dismissOverlays(page: Page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(250);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(350);
}

/** Confirm whatever styled confirm dialog is open — and DRAIN stacked ones.
 *  The confirm button label varies (确认 default, callers may pass
 *  confirmLabel=删除) but it is always the RIGHTMOST btn-danger/btn-accent
 *  in the dialog footer. The dialog mounts a few ms AFTER the menu item
 *  click (React render) — wait for it first, or a count check races it and
 *  returns having confirmed nothing. Waits through the modal exit animation
 *  before returning, or the next interaction hits the closing backdrop. */
export async function confirmDialogBox(page: Page) {
  await dialog(page).waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  for (let i = 0; i < 3; i++) {
    const dlg = dialog(page);
    if ((await dlg.count()) === 0) return;
    const btn = dlg.locator("button.btn-danger, button.btn-accent").last();
    if (!(await btn.isVisible())) return;
    await btn.click();
    await page.waitForTimeout(500); // modal exit animation (~400ms)
  }
}

/* ---------------- toasts ---------------- */

/** Assert a toast containing text appeared (success toasts auto-dismiss). */
export async function expectToast(page: Page, text: string | RegExp) {
  await expect(
    page.locator("body").getByText(text).last(),
  ).toBeVisible({ timeout: 8_000 });
}

/* ---------------- connections ---------------- */

/** TRUE hit-test for "list is interactable": the collapse is a
 *  width→0 + overflow-hidden clip, and clipped children keep a full
 *  bounding box — Playwright's isVisible() reports them visible while
 *  every click lands on the covering main pane. elementFromPoint tells
 *  the truth. */
export async function connListOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="conn-row"]');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 12));
    return !!hit && (hit === el || el.contains(hit) || el.contains(hit.parentElement));
  });
}

/** The two-pane layout COLLAPSES the connection list once a connection
 *  opens (首次探活成功才收起) — every sidebar-row interaction must make
 *  sure the list is expanded again first, or the row is covered by the
 *  main pane and clicks never land. The rail 集群连接 button toggles it. */
export async function ensureConnListOpen(page: Page) {
  if (await connListOpen(page)) return;
  await page.locator('[data-tip="集群连接"]').click();
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(300);
    if (await connListOpen(page)) return;
    // toggle may have raced another collapse (health-poll ping landing)
    await page.locator('[data-tip="集群连接"]').click();
  }
  throw new Error("连接列表无法展开（rail 开关被探活收起循环干扰）");
}

/** Wait out the list collapse. The collapse fires when the connection's
 *  FIRST health ping lands — a public-network Kafka handshake takes 3-8s,
 *  so a time-window poll returns too early and later clicks fight the
 *  animation until the whole test times out. DETERMINISTIC settle signals:
 *  the connection's own row flips to 已连接 (ping done), or the row is
 *  already hidden (collapse done). 25s covers a slow handshake. */
export async function stabilizeConnList(page: Page, name?: string, waitMs = 25_000) {
  const row = (name ? page.locator('[data-testid="conn-row"]').filter({ hasText: name }) : page.locator('[data-testid="conn-row"]')).first();
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    if (!(await row.isVisible().catch(() => false))) return; // collapsed
    const txt = (await row.textContent().catch(() => "")) ?? "";
    if (txt.includes("已连接")) return; // ping landed; collapse (if any) next frame
    await page.waitForTimeout(300);
  }
}

/** The sidebar 30s health poll can collapse the list at ANY moment, so a
 *  sidebar click is never provably safe — only SELF-HEALING. Click with a
 *  short timeout; when it times out covered (main pane / rail over the
 *  collapsed list), re-open the list and retry. */
export async function clickListEl(page: Page, loc: Locator, action: "click" | "dblclick" | "rclick" = "click") {
  for (let i = 0; i < 5; i++) {
    try {
      if (action === "rclick") await loc.click({ button: "right", timeout: 4_000 });
      else if (action === "dblclick") await loc.dblclick({ timeout: 4_000 });
      else await loc.click({ timeout: 4_000 });
      return;
    } catch (err) {
      if (i === 4) throw err;
      await ensureConnListOpen(page);
    }
  }
}

/** The sidebar's 新建连接 button. There are TWO such buttons (sidebar +
 *  workspace TabBar "+") — scope to the sidebar (role=complementary) or the
 *  locator resolves to 2 and Playwright strict mode fails the click. */
export function sidebarAddConnection(page: Page): Locator {
  return page.getByRole("complementary").getByRole("button", { name: "新建连接" });
}

/** Open the connection dialog via the sidebar + button (collapse-resilient). */
export async function openConnectionDialog(page: Page) {
  await clickListEl(page, sidebarAddConnection(page));
}

/** Create a Kafka connection through the REAL dialog if absent. Fields are
 *  the modal's two text inputs (name first, bootstrap second — bootstrap's
 *  placeholder is the host:port hint). Returns after the row exists. */
export async function ensureConnection(page: Page, name: string, bootstrap: string) {
  await ensureConnListOpen(page);
  const existing = page.locator('[data-testid="conn-row"]').filter({ hasText: name });
  if ((await existing.count()) > 0 && (await existing.first().isVisible())) return;

  await openConnectionDialog(page);
  const dlg = dialog(page);
  await dlg.waitFor({ state: "visible" });
  await dlg.locator("input").nth(0).fill(name);
  await dlg.locator("input").nth(1).fill(bootstrap);
  await dlg.getByRole("button", { name: "保存" }).click();
  await expectToast(page, "连接已保存");
  await expect(page.locator('[data-testid="conn-row"]').filter({ hasText: name }).first()).toBeVisible({
    timeout: 10_000,
  });
}

/** Open a connection's workspace: double-click (single click only selects —
 *  VS Code semantics). Waits for the workspace section rail to appear. */
export async function openConnection(page: Page, name: string) {
  await clickListEl(page, page.locator('[data-testid="conn-row"]').filter({ hasText: name }).first(), "dblclick");
  await expect(page.getByRole("button", { name: "主题", exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });
  // 首次探活成功 → 列表自动收起；等它稳定，后续测试不再跟动画赛跑
  await stabilizeConnList(page, name);
}

/** Delete a connection via row context menu + styled confirm. */
export async function deleteConnection(page: Page, name: string) {
  await dismissOverlays(page); // leftover menus/dialogs block the right-click
  await stabilizeConnList(page, name); // wait out any pending collapse animation
  await ensureConnListOpen(page);
  const row = page.locator('[data-testid="conn-row"]').filter({ hasText: name }).first();
  if ((await row.count()) === 0) return;
  await clickListEl(page, row, "rclick");
  await contextMenuItem(page, "删除");
  await confirmDialogBox(page);
  await expect(row).toHaveCount(0, { timeout: 10_000 });
}

/* ---------------- topics ---------------- */

/** Create a topic through the real dialog (创建 button). */
export async function createTopic(page: Page, name: string, partitions: number) {
  await page.locator('button[title="新建主题"]').click();
  const dlg = dialog(page);
  await dlg.waitFor({ state: "visible" });
  await dlg.locator("input").nth(0).fill(name);
  await dlg.locator("input[type=number]").nth(0).fill(String(partitions));
  await dlg.getByRole("button", { name: "创建" }).click();
  await expect(page.locator('[data-testid="topic-row"]').filter({ hasText: name }).first()).toBeVisible({
    timeout: 20_000,
  });
}

/** Select a topic row (single click opens the topic detail). */
export async function openTopic(page: Page, name: string) {
  await page.locator('[data-testid="topic-row"]').filter({ hasText: name }).first().click();
  // toolbar renders once the detail loads — 最早 button is a stable marker
  await expect(page.getByRole("button", { name: "最早" })).toBeVisible({ timeout: 15_000 });
}

/** Delete a topic via row context menu + confirm (cleanup helper). */
export async function deleteTopic(page: Page, name: string) {
  await dismissOverlays(page);
  const row = page.locator('[data-testid="topic-row"]').filter({ hasText: name }).first();
  if ((await row.count()) === 0 || !(await row.isVisible())) return;
  await row.click({ button: "right" });
  await contextMenuItem(page, "删除主题");
  await confirmDialogBox(page);
  await expect(row).toHaveCount(0, { timeout: 20_000 });
}

/* ---------------- messages ---------------- */

/** Visible message rows as {partition, offset} pairs. The table keeps
 *  hidden panes mounted for other tabs — filter by visibility. */
export async function messageRows(page: Page): Promise<{ partition: number; offset: number }[]> {
  return page.evaluate(() => {
    const out: { partition: number; offset: number }[] = [];
    for (const tr of document.querySelectorAll("table tbody tr")) {
      if (typeof tr.checkVisibility === "function" && !tr.checkVisibility()) continue;
      const tds = tr.querySelectorAll("td");
      if (tds.length < 2) continue;
      const p = Number(tds[0].textContent?.trim());
      const o = Number(tds[1].textContent?.trim());
      if (Number.isFinite(p) && Number.isFinite(o)) out.push({ partition: p, offset: o });
    }
    return out;
  });
}

/** The window-position badge text (最新一页 / 最早一页 / offset A–B). */
export async function positionBadge(page: Page): Promise<string> {
  return page.evaluate(() => {
    const spans = [...document.querySelectorAll("span")].filter(
      (s) =>
        typeof s.checkVisibility === "function" &&
        s.checkVisibility() &&
        /^(最新一页|最早一页|offset [\d,]+–[\d,]+|offset \d+)$/.test(s.textContent?.trim() ?? ""),
    );
    return spans[0]?.textContent?.trim() ?? "";
  });
}

/** Produce one message through the real dialog; returns the acked
 *  {partition, offset} parsed from a FRESH 已发送到 toast. A plain
 *  toast-exists check is a false positive machine: the previous
 *  produce's toast is still on screen (~3s lifetime), so a silently
 *  cancelled send would pass. Instead: snapshot the toasts already on
 *  screen, click, then wait for a toast TEXT that was not in the
 *  snapshot (topic-partition-offset makes every toast unique). */
export async function produceMessage(
  page: Page,
  value: string,
  partition = "",
  key = "",
): Promise<{ partition: number; offset: number }> {
  // the previous produce's dialog DOM lingers through its exit animation —
  // wait for FULL unmount before opening the next one
  await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 5_000 }).catch(() => {});
  // toolbar produce button is the accent button in the messages toolbar
  await page.locator("button.btn-accent").filter({ hasText: "发送消息" }).first().click();
  const dlg = dialog(page);
  await dlg.waitFor({ state: "visible" });
  if (partition !== "") {
    const combo = dlg.locator('button[role="combobox"]').first();
    await keSelect(page, combo, partition);
  }
  // fields wrap in <label> — scope by the label text, never input indexes
  if (key !== "") await dlg.locator("label", { hasText: "Key" }).locator("input").fill(key);
  await dlg.locator("textarea").first().fill(value);
  // Capture toasts with an IN-PAGE MutationObserver: a short-lived toast
  // can mount and unmount between two CDP polls (latency spikes), which
  // both false-positives the stale-toast check and loses real acks. The
  // observer records every toast text the instant it renders.
  const before = new Set(await page.getByText(/已发送到/).allInnerTexts());
  await page.evaluate(() => {
    const w = window as unknown as { __toastLog: string[]; __toastObs?: MutationObserver };
    w.__toastLog = [];
    w.__toastObs?.disconnect();
    w.__toastObs = new MutationObserver(() => {
      for (const el of document.querySelectorAll("body *")) {
        const t = el.textContent ?? "";
        if (t.includes("已发送到") && t.length < 200 && !w.__toastLog.includes(t)) {
          w.__toastLog.push(t);
        }
      }
    });
    w.__toastObs.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await dlg.getByRole("button", { name: "发送消息" }).click();
  await dlg.waitFor({ state: "hidden", timeout: 8_000 }); // closes on success
  const log = await page.evaluate(() => (window as unknown as { __toastLog: string[] }).__toastLog);
  await page.evaluate(() => (window as unknown as { __toastObs?: MutationObserver }).__toastObs?.disconnect());
  const fresh = log.find((t) => !before.has(t)) ?? "";
  if (!fresh) throw new Error(`produce 后未见新的 已发送到 toast (value=${value}, log=${JSON.stringify(log)})`);
  const m = /已发送到 .+-(\d+) offset (\d+)/.exec(fresh.replace(/\s+/g, " "));
  if (!m) throw new Error(`toast 文本无法解析: ${fresh}`);
  return { partition: Number(m[1]), offset: Number(m[2]) };
}
