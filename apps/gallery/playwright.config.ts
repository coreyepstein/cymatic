import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright smoke test config for the cymatic gallery.
 *
 * Builds the SPA and serves the production bundle, then drives a real browser
 * against it. Browsers may be unavailable in restricted CI/sandbox setups; in
 * that case `playwright install` is required first (the lib `test` job does not
 * depend on this — see .github/workflows/ci.yml `gallery-e2e`).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:4317",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm build && pnpm preview --port 4317 --strictPort",
    url: "http://localhost:4317",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
