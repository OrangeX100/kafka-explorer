import { test, expect } from "@playwright/test";
import {
  connectApp,
  disconnectApp,
  openSettingsSection,
  UPDATE_FLOW,
  type Page,
} from "./helpers.js";

// Update-chain probe (P0 — the update link broke FIVE times in 0.4.x and
// every break reached users). Drives the REAL production feed:
//   dev build stamped with PROBE_BASE (below the published latest) +
//   UpdateRepo=OrangeX100/kafka-explorer → 检查更新 discovers the release →
//   下载更新 starts the segmented download → progress UI renders →
//   取消 → idle restored (download button back).
//
// Never clicks 安装并重启 — that would quit the app and run the installer.
// Requires KE_E2E_UPDATE_FLOW=1 AND a binary built with
// `task dev:cdp VERSION=<PROBE_BASE>`; otherwise the suite skips.

// Probe base: the version the CI debug build stamps (must sit BELOW the
// published latest so 检查更新 discovers an update). Single source for the
// discover assertion below AND the skip hints — set_version.py rewrites
// this constant (and every "0.4.15" literal in comments) at every bump:
// the old released version becomes the new base. probe_contract_test.go
// pins this constant to the second-newest release tag. Hard-coding a
// version INSIDE an assertion was exactly the drift that broke CI: the
// stamp moved 0.4.10 → 0.4.15, the app rendered 0.4.15 correctly, and the
// assertion still expected 0.4.10.
const PROBE_BASE = "0.4.15";

let page: Page;

test.beforeAll(async () => {
  page = await connectApp();
});

test.afterAll(async () => {
  await disconnectApp();
});

test("检查更新→发现新版→按钮渲染→下载启动→取消→恢复 idle", async () => {
  test.skip(!UPDATE_FLOW, "需 KE_E2E_UPDATE_FLOW=1 + task dev:cdp VERSION=<探针基准> 构建");

  await openSettingsSection(page, "版本与更新");
  await page.getByRole("button", { name: "检查更新" }).click();

  const result = page.getByTestId("update-result");
  await expect(result).toBeVisible({ timeout: 30_000 });

  const readResult = async (): Promise<string> => (await result.innerText()).trim();
  let latest = await readResult();
  if (latest.includes("已是最新版本")) {
    // The manifest URL rides a CDN edge that can serve a STALE latest.json
    // (seen: feed lagging a release behind) — retry once before believing
    // the up-to-date verdict, then skip with the reason recorded.
    await page.waitForTimeout(1_000);
    await page.getByRole("button", { name: "检查更新" }).click();
    await expect(result).toContainText(/已是最新版本|发现新版本/, { timeout: 30_000 });
    latest = await readResult();
    if (latest.includes("已是最新版本")) {
      test.info().annotations.push({
        type: "skip",
        description: "二进制版本 ≥ 最新版（或更新源缓存滞后），下载链路需 VERSION=<探针基准> 构建",
      });
      return;
    }
  }

  // ---- discover: new version + version numbers rendered ----
  // Assertion derives from PROBE_BASE (never a baked-in literal — see the
  // constant's comment for the CI break that proved why).
  await expect(result).toContainText("发现新版本");
  await expect(result).toContainText(
    new RegExp(
      `当前版本 ${PROBE_BASE.replaceAll(".", "\\.")}，最新版本 \\d+\\.\\d+\\.\\d+`
    )
  );

  // ---- one-click download button renders (the 0.4.7 isWindows chain) ----
  const downloadBtn = result.getByRole("button", { name: "下载更新" });
  await expect(downloadBtn).toBeVisible();

  // ---- download starts: progress bar + bytes counter render ----
  await downloadBtn.click();
  const progress = page.getByText("正在下载更新…");
  await expect(progress).toBeVisible({ timeout: 20_000 });
  // wait for real bytes to flow (pct counter leaves "0%") — proves the
  // segmented download pipeline actually pulled data
  await expect
    .poll(async () => await progress.locator("xpath=ancestor::div[1]").innerText(), {
      timeout: 30_000,
      intervals: [500],
    })
    .toMatch(/\d+\.\d\/\d+\.\d MB · \d+%/);

  // ---- cancel: phase returns to idle (button re-renders, progress gone) ----
  // scope to the progress footer — a bare page-wide 取消 locator could hit a
  // hidden keep-mounted pane's cancel in other views
  const cancelBtn = progress.locator("xpath=ancestor::div[1]").getByRole("button", { name: "取消" });
  await cancelBtn.click();
  await expect(progress).toBeHidden({ timeout: 10_000 });
  await expect(result.getByRole("button", { name: "下载更新" })).toBeVisible({ timeout: 10_000 });
});
