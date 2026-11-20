import { chromium, expect, type Browser, type Page, type Locator } from "@playwright/test";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { join as joinPath, dirname } from "node:path";

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
  // A wedged WebView2 can leave 9223 LISTENING while /json/version never
  // answers — connectOverCDP would hang forever. Race a hard timeout.
  const connectTimeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error("connectOverCDP 15 秒未完成（CDP 端口垂死）")), 15_000),
  );
  browser = await Promise.race([chromium.connectOverCDP(CDP_URL), connectTimeout]);
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
  // Set the locale, then reload so the app re-reads it at boot. A wedged
  // target hangs evaluate()/reload() FOREVER — race a watchdog so callers
  // can fall through to restartApp().
  const withWatchdog = async <T>(p: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error("connectApp phase timed out (wedged target?)")), ms);
    });
    try {
      return await Promise.race([p, tick]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  await ensureForeground();
  // locale persists (set by every earlier run) — NO reload here: reload
  // destroys and recreates the CDP target, and any command racing that
  // window reports the target as closed. The rail visibility assert below
  // is the boot-complete signal instead.
  await withWatchdog(
    page.evaluate(() => {
      localStorage.setItem("ke.locale", "zh-CN");
      // pin the connection list open: the probe harness cannot win the
      // auto-collapse race over a WAN ping (Sidebar.openFlow honors this
      // key — user machines never have it set)
      localStorage.setItem("ke.e2eKeepList", "1");
    }),
    10_000,
  );
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

/** App binary directory resolution: CI passes KE_APP_DIR (the runner's
 *  workspace bin/); local runs fall back to the well-known local path.
 *  spawn() needs an absolute path (it does NOT search cwd — the ENOENT
 *  lesson). */
function appDir(): string {
  if (process.env.KE_APP_DIR) return process.env.KE_APP_DIR;
  if (existsSync(resolve("bin/kafka-explorer-cdp.exe"))) return resolve("bin");
  return "D:\\视途智能\\kafka-explorer\\bin";
}

const APP_DIR = appDir();

/** Ping the CDP port; when the app is dead, launch it (detached spawn) and
 *  wait for readiness. beforeAll step one in every spec — WHOEVER killed
 *  the previous instance (job-object trees, AV, wedged renderer), the next
 *  probe run self-heals to a known-good state instead of ECONNREFUSED. */
export async function ensureAppRunning(waitMs = 45_000) {
  const alive = async () => {
    try {
      const res = await fetch("http://127.0.0.1:9223/json/version", { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  };
  if (await alive()) return;
  const { spawn } = await import("node:child_process");
  // spawn resolves the exe against PATH, NOT cwd — a relative name here
  // throws ENOENT (and the restart silently never happened)
  spawn(joinPath(APP_DIR, "kafka-explorer-cdp.exe"), [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, KE_DEBUG_CDP: "1" },
  }).unref();
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    if (await alive()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("ensureAppRunning: CDP 端口 45 秒内未就绪");
}

/** Full app process restart: the recovery of last resort when the renderer
 *  target is wedged (evaluate() hangs forever on a dying target — a bare
 *  CDP reconnect is NOT enough). taskkill + relaunch + port readiness.
 *  cmd `start /D` + relative exe name: NO path escaping through PowerShell
 *  (double-backslash mangling silently failed Start-Process before). The
 *  KE_DEBUG_CDP env travels through execSync's env, not the shell line. */
export async function restartApp() {
  try {
    execSync("taskkill /IM kafka-explorer-cdp.exe /F", { shell: "cmd", stdio: "ignore", timeout: 15_000 });
  } catch {
    /* already gone */
  }
  await new Promise((r) => setTimeout(r, 2000));
  // Node detached spawn: the child joins NO job object tied to this test
  // runner, so it survives the runner's exit (execSync→powershell chains
  // died with the job tree right after the runner finished — the app was
  // alive through afterAll, then vanished).
  const { spawn } = await import("node:child_process");
  const child = spawn("kafka-explorer-cdp.exe", [], {
    cwd: APP_DIR,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, KE_DEBUG_CDP: "1" },
  });
  child.unref();
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    try {
      const res = await fetch("http://127.0.0.1:9223/json/version");
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("restartApp: CDP 端口 60 秒内未就绪");
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
  await expect(page.locator("body").getByText(text).last()).toBeVisible({ timeout: 8_000 });
}

/* ---------------- connections ---------------- */

/** TRUE hit-test for "list is interactable": the collapse is a
 *  width→0 + overflow-hidden clip, and clipped children keep a full
 *  bounding box — Playwright's isVisible() reports them visible while
 *  every click lands on the covering main pane. elementFromPoint tells
 *  the truth. */
export async function connListOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // The sidebar is an <aside> — its complementary role is IMPLICIT (the
    // aria-complementary name only exists in Playwright snapshots); an
    // explicit [role=complementary] attribute does not exist in the DOM.
    const pane = document.querySelector('aside');
    if (!pane) return false;
    // Probe = a connection row when one exists, else the pane's 新建连接
    // button: a FRESH app (CI runner) has ZERO rows and the row-only probe
    // read that as "collapsed" forever — ensureConnListOpen then cycled the
    // rail toggle 10× (a no-op with no active connection) and threw, even
    // though the list was plainly open (2026-11-20 CI first-run evidence).
    // Probe must sit BELOW the frameless-window drag strip: wails paints an
    // invisible --wails-draggable overlay across the top of the pane, so
    // the 新建连接 header button hit-tests to the overlay and reads as
    // "collapsed" even while the list is plainly open (CI evidence). The
    // search textbox lives below that strip; rows do too.
    const probe =
      document.querySelector('[data-testid="conn-row"]') ||
      pane.querySelector("input[type='text'], input:not([type])");
    // scroll it into view FIRST: with many rows the checked row can sit
    // below the fold — its rect.y exceeds the viewport and elementFromPoint
    // returns null, which a naive hit-test misreads as "collapsed"
    probe.scrollIntoView({ block: "center" });
    const r = probe.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    if (r.bottom <= 0 || r.top >= window.innerHeight) return false; // truly off-screen
    const hit = document.elementFromPoint(
      r.left + r.width / 2,
      r.top + Math.min(r.height / 2, 12)
    );
    return !!hit && (hit === probe || probe.contains(hit) || pane.contains(hit));
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

/** Wait out the post-open churn: the health ping lands (public handshake
 *  3-8s), the list collapses, the exit animation plays. The row-text
 *  signal (已连接) proved unreliable via textContent on this machine —
 *  the STRONG signal is structural: workspace section rail visible, no
 *  dialog open, and a short settle window for the collapse animation.
 *  Any collapse Playwright misses is healed later by clickListEl. */
export async function stabilizeConnList(page: Page, _name?: string, waitMs = 10_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    const dlg = await page.locator('[role="dialog"]').count();
    const rail = await page
      .getByRole("button", { name: "主题", exact: true })
      .first()
      .isVisible()
      .catch(() => false);
    if (rail && dlg === 0) {
      await page.waitForTimeout(600); // collapse animation settle
      return;
    }
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
  await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 8_000 }); // exit anim done
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

/** Create a topic through the real dialog (创建 button). Idempotent:
 *  returns immediately when a row with the name is already visible. */
export async function createTopic(page: Page, name: string, partitions: number) {
  const existing = page.locator('[data-testid="topic-row"]').filter({ hasText: name }).first();
  if ((await existing.count()) > 0 && (await existing.isVisible())) return;
  // .first(): a fresh cluster view renders TWO 新建主题 buttons (toolbar +
  // empty-state main pane) — strict mode would reject the bare locator
  // (2026-11-20 CI run 4: admin/cluster paging failed on exactly this)
  await page.locator('button[title="新建主题"]').first().click();
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
        /^(最新一页|最早一页|搜索结果 · 翻页已停用|offset [\d,]+–[\d,]+|offset \d+)$/.test(s.textContent?.trim() ?? ""),
    );
    return spans[0]?.textContent?.trim() ?? "";
  });
}

/** Open a message row's detail panel (single click on the visible row). */
export async function openFirstMessageDetail(page: Page) {
  await page.evaluate(() => {
    const trs = [...document.querySelectorAll("table tbody tr")];
    const tr = trs.find((t) => typeof t.checkVisibility === "function" && t.checkVisibility());
    (tr as HTMLElement)?.click();
  });
}

/** Click the LAST visible message row (the freshest produce). */
export async function openLastMessageDetail(page: Page) {
  await page.evaluate(() => {
    const trs = [...document.querySelectorAll("table tbody tr")].filter(
      (t) => typeof t.checkVisibility === "function" && t.checkVisibility(),
    );
    (trs[trs.length - 1] as HTMLElement)?.click();
  });
}

/** Click a view-mode tab (文本/JSON/Hex/已解码) in the open detail panel. */
export async function detailTabClick(page: Page, label: string) {
  await page.getByRole("button", { name: label }).last().click();
}

/** Which detail view-mode tab is ACTIVE (btn-accent highlight). */
export async function detailActiveTab(page: Page): Promise<string> {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll("button.btn-accent")].filter(
      (b) =>
        typeof b.checkVisibility === "function" &&
        b.checkVisibility() &&
        /^(文本|JSON|Hex|已解码)/.test(b.textContent?.trim() ?? ""),
    );
    return btns[0]?.textContent?.trim() ?? "";
  });
}

export interface ProduceOpts {
  key?: string;
  headers?: string; // raw headers textarea lines: "k1:v1" + LF + "k2:v2"
  partition?: string;
}

/** Produce one message through the real dialog; returns the acked
 *  {partition, offset} parsed from a FRESH 已发送到 toast. A plain
 *  toast-exists check is a false positive machine: the previous
 *  produce's toast is still on screen (~3s lifetime), so a silently
 *  cancelled send would pass. Capture with an IN-PAGE MutationObserver:
 *  a short-lived toast can mount and unmount between two CDP polls
 *  (latency spikes), which both false-positives the stale-toast check
 *  and loses real acks. */
export async function produceMessage(
  page: Page,
  value: string,
  partition = "",
  key = "",
  headers = "",
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
  if (headers !== "") await dlg.locator("textarea").nth(1).fill(headers);

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
/** THE root cause of every "random" probe hang on this machine: when the
 *  app window is NOT in the foreground, WebView2 throttles its render
 *  pipeline — requestAnimationFrame stops ticking — and Playwright's
 *  actionability check (stable = same bbox across two rAF frames) waits
 *  forever. evaluate() keeps working, so the failure looks like a
 *  mysterious click timeout while fills still succeed. Bring the window
 *  to the foreground (Win32 SetForegroundWindow, restore if minimized)
 *  before touching any click. */
export async function ensureForeground() {
  const { execSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  // resolve the .ps1 relative to this module (e2e/tests/ → e2e/tools/)
  const here = fileURLToPath(import.meta.url);
  const ps1 = joinPath(dirname(here), "..", "tools", "foreground.ps1");
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`, {
    shell: "cmd",
    stdio: "ignore",
    timeout: 15_000,
  });
  await new Promise((r) => setTimeout(r, 800)); // let the render pipeline wake
}
/** Keep the app window foreground for the WHOLE probe run: every time this
 *  test runner's own terminal (or any other window) covers the app,
 *  WebView2 throttles its render pipeline — rAF stops — and Playwright's
 *  actionability check hangs on the next click. A 15s heartbeat pins the
 *  window in front. Call ONCE in beforeAll; the timer never blocks exit. */
export function keepForeground() {
  void ensureForeground();
  const t = setInterval(() => void ensureForeground(), 15_000);
  if (typeof t.unref === "function") t.unref();
}

/** SSH topic-seed availability: the seed helpers read the local hosts.json
 *  (user-machine only). CI runners have no such file — specs that need a
 *  pre-created topic must skip honestly on it instead of failing ENOENT. */
export function isSSHSeedAvailable(): boolean {
  return existsSync("C:/Users/51293/bin/hosts.json");
}
