import { expect, test, type Locator, type Page } from "@playwright/test";

import { decodePng, luminance, type DecodedImage } from "./png.js";

/**
 * V2-10 real-browser verification of the cinematic geometric pack (pixel-level,
 * no mocks).
 *
 * Loads the geometric harness (which drives `@cymatic/core` + the geometric
 * presets directly), selects a geometric preset, feeds high-energy audio under
 * an explicit evolving director, and asserts:
 *   (a) the canvas is NOT blank,
 *   (b) glow/bloom is present — a meaningful spread of BRIGHT pixels (halos),
 *       not just hard-edged cells, and
 *   (c) color CHANGES over time: capturing the SAME preset under two different
 *       evolving director states (different palette crossfade + hue rotation)
 *       yields a different dominant hue.
 *
 * Backend-aware: WebGPU is where the bloom/glow chain actually blooms. In
 * headless Chromium WebGL is the usual fallback (post-FX is a documented no-op),
 * where the additive glow still paints bright pixels but bloom does not spread
 * them further. The spec reports the backend and tunes the glow-spread assertion
 * accordingly, but the not-blank + color-change assertions hold on both.
 */

interface ColorStats {
  /** Distinct quantized colors (blank canvas → ~1). */
  distinct: number;
  /** Luma variance across the frame (blank → ~0). */
  variance: number;
  /** Count of bright pixels (luma > 60) — glow halos light up many. */
  bright: number;
  /** Count of mid-bright pixels (luma 25..220) — bloom turns edges into gradients. */
  midBright: number;
  /** Mean normalized RGB over bright-ish pixels (the dominant lit hue). */
  hue: { r: number; g: number; b: number };
}

function colorStats(img: DecodedImage): ColorStats {
  const { rgba } = img;
  const seen = new Set<number>();
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  let bright = 0;
  let midBright = 0;
  const hueAcc = { r: 0, g: 0, b: 0 };
  let hueN = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    seen.add(key);
    const lum = luminance(r, g, b);
    sum += lum;
    sumSq += lum * lum;
    n++;
    if (lum > 60) bright++;
    if (lum >= 25 && lum <= 220) midBright++;
    // Accumulate hue over pixels with some light, normalized so brightness
    // differences don't dominate the comparison — we want the COLOR, not the
    // luminance, to drive the change assertion.
    const mag = r + g + b;
    if (mag > 60) {
      hueAcc.r += r / mag;
      hueAcc.g += g / mag;
      hueAcc.b += b / mag;
      hueN++;
    }
  }
  const mean = n > 0 ? sum / n : 0;
  return {
    distinct: seen.size,
    variance: n > 0 ? sumSq / n - mean * mean : 0,
    bright,
    midBright,
    hue:
      hueN > 0
        ? { r: hueAcc.r / hueN, g: hueAcc.g / hueN, b: hueAcc.b / hueN }
        : { r: 0, g: 0, b: 0 },
  };
}

async function capture(
  page: Page,
  canvas: Locator,
  director: Record<string, number>,
  loud: boolean,
  frames: number,
): Promise<ColorStats> {
  await page.evaluate(
    ([d, l, f]) =>
      window.__geoHarness!.renderWith(
        d as Record<string, number>,
        l as boolean,
        f as number,
      ),
    [director, loud, frames] as const,
  );
  const png = await canvas.screenshot();
  return colorStats(decodePng(png));
}

/** Calm intro-like director: low intensity, first palette, no hue rotation. */
const CALM = {
  intensity: 0.1,
  motion: 0.7,
  bloom: 0.15,
  density: 0.6,
  contrast: 0.4,
  paletteIndex: 0,
  prevPaletteIndex: 0,
  paletteBlend: 1,
  hueRotation: 0,
};

/** Hot drop-like director: high intensity, mid-crossfade between palettes, hue rotated. */
const HOT = {
  intensity: 0.95,
  motion: 1.6,
  bloom: 0.85,
  density: 1.5,
  contrast: 0.85,
  paletteIndex: 4,
  prevPaletteIndex: 2,
  paletteBlend: 0.5,
  hueRotation: 0.45,
};

test.describe("V2-10 geometric pack renders cinematically in a real browser", () => {
  for (const presetId of ["geometric.op-grid", "geometric.modular", "geometric.concentric"]) {
    test(`${presetId}: not blank, glow/bloom present, color evolves`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });

      await page.goto("/geometric-harness.html");
      await page.waitForFunction(() => window.__geoHarnessReady === true, undefined, {
        timeout: 30_000,
      });
      const bootError = await page.evaluate(() => window.__geoHarnessError ?? null);
      expect(bootError, `harness boot error: ${bootError ?? ""}`).toBeNull();

      const backend = await page.evaluate(() => window.__geoHarness!.backend());
      const canvas = page.locator("#c");
      await expect(canvas).toBeVisible();

      await page.evaluate((id) => window.__geoHarness!.select(id), presetId);

      // (a)+(b): a high-energy frame under the HOT director. Not blank + glow.
      const hot = await capture(page, canvas, HOT, true, 24);
      // (c): the SAME preset under the CALM intro director — different palette
      // crossfade + hue rotation → a different dominant lit color.
      const calm = await capture(page, canvas, CALM, true, 24);

      const hueDelta =
        Math.abs(hot.hue.r - calm.hue.r) +
        Math.abs(hot.hue.g - calm.hue.g) +
        Math.abs(hot.hue.b - calm.hue.b);

      // eslint-disable-next-line no-console
      console.log(
        `[geometric] ${presetId} backend=${backend} ` +
          `distinct=${hot.distinct} variance=${hot.variance.toFixed(1)} ` +
          `bright=${hot.bright} midBright=${hot.midBright} hueDelta=${hueDelta.toFixed(3)}`,
      );

      // (a) Not blank: many colors + real luma variance.
      expect(hot.distinct).toBeGreaterThan(3);
      expect(hot.variance).toBeGreaterThan(40);

      // (b) Glow present: a meaningful population of bright + mid-bright pixels.
      // Additive glow lights bright cores on BOTH backends; bloom (WebGPU) widens
      // the mid-bright halo further. Assert bright pixels exist either way, and a
      // stronger mid-bright spread when the bloom chain actually runs.
      expect(hot.bright).toBeGreaterThan(100);
      if (backend === "webgpu") {
        expect(hot.midBright).toBeGreaterThan(500);
      } else {
        expect(hot.midBright).toBeGreaterThan(50);
      }

      // (c) Color evolves: the dominant lit hue differs between director states.
      expect(hueDelta).toBeGreaterThan(0.02);

      expect(
        consoleErrors.filter((e) => /renderer|webgpu|webgl|gpu/i.test(e)),
      ).toEqual([]);
    });
  }
});
