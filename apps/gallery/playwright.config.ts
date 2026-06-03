import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright smoke test config for the cymatic gallery.
 *
 * Builds the SPA and serves the production bundle, then drives a real browser
 * against it. Browsers may be unavailable in restricted CI/sandbox setups; in
 * that case `playwright install` is required first (the lib `test` job does not
 * depend on this — see .github/workflows/ci.yml `gallery-e2e`).
 *
 * When `CYMATIC_E2E_NO_WEBGPU=1`, Chromium launches with WebGPU disabled so the
 * suite exercises the WebGL FALLBACK path locally — equivalent to a GPU-less CI
 * runner (where `navigator.gpu` exists but yields no adapter, and the renderer
 * falls back to WebGL automatically). The DEFAULT (unset) config still enables
 * WebGPU where the machine supports it. Either way the committed specs pass:
 * each branches on the resolved backend and asserts the real per-backend
 * contract (full cinematic post-FX on WebGPU; the basic non-blank look on WebGL).
 */
const NO_WEBGPU = process.env.CYMATIC_E2E_NO_WEBGPU === "1";

const chromiumArgs = NO_WEBGPU
  ? [
      // Force the no-WebGPU path: remove the API outright (no enabling flags).
      "--disable-features=WebGPU",
      "--use-gl=angle",
      "--use-angle=swiftshader",
    ]
  : [
      // Maximize the chance of a working GPU/WebGPU in headless Chromium so the
      // render tests can exercise the real WebGPU path when the sandbox allows
      // it. The tests do NOT depend on WebGPU — they fall back to WebGL
      // transparently — these flags only widen coverage.
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--ignore-gpu-blocklist",
    ];

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
        launchOptions: {
          args: chromiumArgs,
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
