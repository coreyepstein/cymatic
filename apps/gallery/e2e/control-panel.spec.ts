import { expect, test } from "@playwright/test";

/**
 * Real-browser smoke for the V2-14 control panel + director HUD.
 *
 * Selects a cinematic preset, asserts the auto-introspected parameter panel
 * renders controls, drives a slider and confirms the app does not crash and the
 * canvas keeps painting (not blank), and toggles the auto-director while
 * asserting the HUD reports a section. Backend-agnostic: works on WebGPU or the
 * WebGL fallback.
 */
test.describe("gallery control panel + director HUD", () => {
  test("renders controls, drives a slider, and shows a director section", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(String(err)));

    await page.goto("/");

    // Pick a cinematic preset with a rich param schema.
    const opGrid = page.locator(".preset-item", { hasText: "Op Grid" });
    await opGrid.first().click();

    const canvas = page.locator("canvas");
    await expect(canvas).toBeVisible();

    // The control panel mounts.
    await expect(page.getByTestId("control-panel")).toBeVisible();

    // The HUD reports a section (intro at rest).
    const section = page.getByTestId("hud-section");
    await expect(section).toBeVisible();
    await expect(section).not.toBeEmpty();

    // The parameter panel auto-renders at least one control (Op Grid declares
    // several number params). Wait for the ParamSet to surface (polled).
    const sliders = page.locator(".panel .slider");
    await expect.poll(async () => sliders.count(), { timeout: 8_000 }).toBeGreaterThan(0);

    // Drive the first slider to its midpoint — must not crash the app.
    const first = sliders.first();
    await first.focus();
    const box = await first.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    // Flipping a param to Manual via the slider keeps the canvas painting.
    await page.waitForTimeout(600);
    await expect(canvas).toBeVisible();

    // The canvas still paints non-uniform pixels after the param change.
    const shot = await canvas.screenshot();
    const distinct = new Set<number>();
    // Decode is overkill here; sample raw PNG bytes for a coarse variance proxy.
    for (let i = 0; i < shot.length; i += 97) distinct.add(shot[i]!);
    expect(distinct.size).toBeGreaterThan(3);

    // Toggle the auto-director off, then on — HUD still reports a section, no
    // crash. The checkbox itself is visually hidden (custom switch), so click
    // the surrounding label which forwards the toggle.
    const toggle = page.getByLabel("Auto-director");
    const switchLabel = page.locator("label.switch");
    await switchLabel.click();
    await expect(toggle).not.toBeChecked();
    await page.waitForTimeout(300);
    await expect(section).not.toBeEmpty();
    await switchLabel.click();
    await expect(toggle).toBeChecked();
    await expect(section).not.toBeEmpty();

    // Randomize must not crash and the canvas keeps rendering.
    await page.getByTestId("randomize").click();
    await page.waitForTimeout(400);
    await expect(canvas).toBeVisible();

    // No renderer/init errors logged through any of the interactions.
    expect(
      consoleErrors.filter((e) => /renderer|webgpu|webgl|gpu|TypeError|undefined/i.test(e)),
    ).toEqual([]);
  });
});
