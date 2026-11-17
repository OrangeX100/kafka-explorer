import { defineConfig } from "vitest/config";

// Unit tests live under src/ only. The Playwright e2e specs (e2e/tests/
// *.spec.ts) connect over CDP to a running desktop app and must NOT be
// picked up by vitest — the default include pattern would match them from
// the frontend/ root and crash outside a browser.
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{js,ts,jsx,tsx}"],
    environment: "node",
  },
});
