import { expect, test } from "@playwright/test";

test.describe("cymatic gallery", () => {
  test("loads and lists a non-empty preset catalog", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "cymatic", level: 1 })).toBeVisible();

    const presetButtons = page.locator(".preset-item");
    const count = await presetButtons.count();
    expect(count).toBeGreaterThan(0);
  });

  test("selecting a preset mounts a <canvas> (live switch, no reload)", async ({
    page,
  }) => {
    await page.goto("/");
    const presetButtons = page.locator(".preset-item");
    await presetButtons.first().click();

    // The <Visualizer/> renders a managed canvas once a backend is available.
    // In a headed/GPU CI runner WebGL is present, so the canvas mounts.
    const canvas = page.locator("canvas");
    await expect(canvas).toBeVisible();

    // Switching to a second preset must not navigate (no reload): the URL is
    // unchanged and a canvas remains mounted.
    const before = page.url();
    if ((await presetButtons.count()) > 1) {
      await presetButtons.nth(1).click();
      await expect(page.locator("canvas")).toBeVisible();
      expect(page.url()).toBe(before);
    }
  });

  test("exposes file-picker and microphone input controls", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: /choose audio file/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /use microphone/i })).toBeVisible();
    await expect(page.locator('input[type="file"]')).toHaveCount(1);
  });

  test("each preset shows a copy-paste install/usage snippet", async ({ page }) => {
    await page.goto("/");
    const snippet = page.locator(".snippet pre code");
    await expect(snippet).toContainText("npm i @cymatic/react @cymatic/presets");
    await expect(snippet).toContainText("defaultPresetRegistry.create(");
    await expect(page.getByRole("button", { name: /^copy$/i })).toBeVisible();
  });

  test("links to docs and the GitHub repo", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /docs/i })).toHaveAttribute(
      "href",
      /github\.com/,
    );
    await expect(page.getByRole("link", { name: /github/i })).toHaveAttribute(
      "href",
      /github\.com/,
    );
  });

  test("handles microphone-permission denial gracefully (no crash)", async ({
    page,
    context,
  }) => {
    // Explicitly deny mic permission, then request the microphone input.
    await context.clearPermissions();
    await page.addInitScript(() => {
      // Force getUserMedia to reject as if the user denied the prompt.
      const md = navigator.mediaDevices;
      if (md) {
        md.getUserMedia = () =>
          Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
      }
    });

    await page.goto("/");
    await page.getByRole("button", { name: /use microphone/i }).click();

    // The app must surface a friendly error indicator and stay alive. Either
    // the overlay card or the status-bar error dot is acceptable; both signal
    // the denial was handled rather than crashing the app.
    await expect(
      page.locator(".status-card.error, .input-status .dot.error").first(),
    ).toBeVisible({ timeout: 5_000 });
    expect(await page.locator(".preset-item").count()).toBeGreaterThan(0);
  });
});
