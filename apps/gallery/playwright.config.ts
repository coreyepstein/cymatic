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
      use: {
        ...devices["Desktop Chrome"],
        // Maximize the chance of a working GPU/WebGPU in headless Chromium so
        // the render-smoke test can exercise the real WebGPU path when the
        // sandbox allows it. The tests do NOT depend on WebGPU — they fall back
        // to WebGL transparently — these flags only widen coverage.
        launchOptions: {
          args: [
            "--enable-unsafe-webgpu",
            "--enable-features=Vulkan",
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--ignore-gpu-blocklist",
          ],
        },
      },
    },
  ],
  webServer: {
    command: "pnpm build && pnpm preview --port 4317 --strictPort",
    url: "http://localhost:4317",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
