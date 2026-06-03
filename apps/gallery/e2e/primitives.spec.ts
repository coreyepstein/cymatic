import { expect, test, type Locator, type Page } from "@playwright/test";

import { decodePng, luminance, pixelAt, type DecodedImage } from "./png.js";

/**
 * V2-03 rich-primitives real-browser verification (pixel-level, no mocks).
 *
 * Loads the standalone primitives harness (which drives `@cymatic/core`
 * directly), paints each new primitive, and measures the real compositor pixels:
 *
 *   (a) GRADIENT — a horizontal red→blue ramp filling the frame. Left pixels are
 *       red-dominant, right pixels are blue-dominant, and red FALLS while blue
 *       RISES from left→right (a measurable ramp in the +x direction).
 *   (b) GLOW — a centered additive blob. The center is much brighter than the
 *       edge AND the falloff is monotone-ish through a mid ring (soft, not a hard
 *       disc): center > ring > edge.
 *   (c) LINE — a thick bright horizontal line at the vertical center. Pixels ON
 *       the line are lit while a parallel off-line band is near-background dark.
 *
 * Backend-aware: WebGPU runs the real per-pixel pipelines; WebGL falls back to
 * documented solid-color approximations (still a ramp/blob/line, just stepped /
 * blocky). The spec reports the resolved backend and asserts the SAME qualitative
 * properties on both, with thresholds loose enough for the approximation.
 */

async function capture(page: Page, canvas: Locator, kind: string): Promise<DecodedImage> {
  await page.evaluate((k) => window.__primHarness!.render(k as "gradient"), kind);
  const png = await canvas.screenshot();
  return decodePng(png);
}

test.describe("V2-03 rich primitives render real pixels in a browser", () => {
  test("gradient, glow, and line are visible with the expected structure", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("/primitives-harness.html");
    await page.waitForFunction(() => window.__primHarnessReady === true, undefined, {
      timeout: 30_000,
    });
    const harnessError = await page.evaluate(() => window.__primHarnessError ?? null);
    expect(harnessError, `harness boot error: ${harnessError ?? ""}`).toBeNull();

    const backend = await page.evaluate(() => window.__primHarness!.backend());
    const canvas = page.locator("#c");
    await expect(canvas).toBeVisible();

    // ── (a) GRADIENT: red→blue across x ──
    const grad = await capture(page, canvas, "gradient");
    const midY = grad.height / 2;
    const left = pixelAt(grad, grad.width * 0.1, midY);
    const mid = pixelAt(grad, grad.width * 0.5, midY);
    const right = pixelAt(grad, grad.width * 0.9, midY);
    const redFall = left.r - right.r; // red decreases L→R
    const blueRise = right.b - left.b; // blue increases L→R
    console.log(
      `[prim] backend=${backend} gradient ` +
        `left=(${left.r},${left.g},${left.b}) mid=(${mid.r},${mid.g},${mid.b}) ` +
        `right=(${right.r},${right.g},${right.b}) redFall=${redFall} blueRise=${blueRise}`,
    );
    // A real ramp: red falls and blue rises across x; left is red-ish, right blue-ish.
    expect(redFall).toBeGreaterThan(30);
    expect(blueRise).toBeGreaterThan(30);
    expect(left.r).toBeGreaterThan(left.b);
    expect(right.b).toBeGreaterThan(right.r);

    // ── (b) GLOW: soft additive falloff, center brightest ──
    const glow = await capture(page, canvas, "glow");
    const cx = glow.width / 2;
    const cy = glow.height / 2;
    const centerLum = luminance(
      pixelAt(glow, cx, cy).r,
      pixelAt(glow, cx, cy).g,
      pixelAt(glow, cx, cy).b,
    );
    // A ring at ~45% of the radius and an edge sample near the frame border.
    const ring = pixelAt(glow, cx + glow.width * 0.18, cy);
    const ringLum = luminance(ring.r, ring.g, ring.b);
    const edge = pixelAt(glow, cx + glow.width * 0.48, cy);
    const edgeLum = luminance(edge.r, edge.g, edge.b);
    console.log(
      `[prim] backend=${backend} glow center=${centerLum.toFixed(1)} ` +
        `ring=${ringLum.toFixed(1)} edge=${edgeLum.toFixed(1)}`,
    );
    // Center is clearly brighter than the edge (it is a glow, not a flat fill)
    // and the mid ring sits between them (a soft falloff, not a hard disc).
    expect(centerLum).toBeGreaterThan(edgeLum + 20);
    expect(centerLum).toBeGreaterThanOrEqual(ringLum);
    expect(ringLum).toBeGreaterThanOrEqual(edgeLum);

    // ── (c) LINE: lit along the segment, dark off it ──
    const line = await capture(page, canvas, "line");
    const lineY = line.height * 0.5;
    const offY = line.height * 0.25; // well above the line band
    const onLum = luminance(
      pixelAt(line, line.width * 0.5, lineY).r,
      pixelAt(line, line.width * 0.5, lineY).g,
      pixelAt(line, line.width * 0.5, lineY).b,
    );
    const offLum = luminance(
      pixelAt(line, line.width * 0.5, offY).r,
      pixelAt(line, line.width * 0.5, offY).g,
      pixelAt(line, line.width * 0.5, offY).b,
    );
    console.log(`[prim] backend=${backend} line on=${onLum.toFixed(1)} off=${offLum.toFixed(1)}`);
    // The line is bright where it runs and dark just off it.
    expect(onLum).toBeGreaterThan(150);
    expect(onLum).toBeGreaterThan(offLum + 80);

    // No renderer/GPU console errors on any backend.
    expect(consoleErrors.filter((e) => /renderer|webgpu|webgl|gpu/i.test(e))).toEqual([]);
  });
});
