import { defineConfig } from "@playwright/test";

// Enterprise UI suite for the Wails/WebView2 desktop app. Connects over CDP
// to an already-running debug build (task dev:cdp exposes 127.0.0.1:9223).
// The runner itself launches NO browser: tests grab the app page via
// chromium.connectOverCDP in beforeAll, so there are no launchOptions here.
// (A bare wsEndpoint does NOT work against WebView2 — its real WS path
// carries a UUID that only the /json/version handshake reveals.)

export default defineConfig({
  testDir: "./e2e/tests",
  fullyParallel: false, // one CDP connection; tests share the single app page
  workers: 1,
  // CI: 2 (three attempts). Goto/watermark probes are feature-verified
  // locally and on CI rounds — the residual failures are environment
  // randomness (zombie attempt from a frozen protocol call fights the
  // retry; each attempt pays the 300s timeout). A third attempt converts
  // two-bad-luck into green; breadcrumbs keep the diagnosis intact.
  // GITHUB_ACTIONS, not CI: anyone setting CI=true locally for junit-style
  // output would otherwise trip the 3-attempt budget AND disable the
  // foreground keeper — the full pathological combo (0.4.20 review P3-2).
  retries: process.env.GITHUB_ACTIONS ? 2 : 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    // CI-readable results for the probe jobs
    ...(process.env.GITHUB_ACTIONS ? [["junit", { outputFile: "test-results/junit.xml" }]] : []),
  ],
});
