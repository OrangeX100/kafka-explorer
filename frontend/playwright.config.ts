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
  retries: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
});
