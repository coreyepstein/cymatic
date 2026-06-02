import zlib from "node:zlib";

import { expect, test, type Locator } from "@playwright/test";

/**
 * Real-browser render smoke: prove the live canvas actually paints PIXELS, not
 * a single solid fill. This is the regression guard for the WebGPU "blank
 * canvas" bug, where every rect opened its own `loadOp:"clear"` pass and the
 * frame collapsed to one solid color.
 *
 * It is backend-agnostic by design: WebGPU is often unavailable in headless
 * Chromium, in which case the engine falls back to WebGL — either way a working
 * renderer paints the Op Grid's 8x8 checkerboard (which draws distinct light /
 * dark cells even at zero audio), so the canvas is NOT uniform. A blank/black
 * canvas (the bug) fails the variance / distinct-color assertions below.
 *
 * Pixels are captured with Playwright's `Locator.screenshot()` — the browser
 * compositor's on-screen pixels — rather than re-reading the GPU texture via
 * `drawImage`/`getImageData`, which returns transparent for a presented WebGPU
 * canvas. The screenshot is a PNG, decoded here with Node's built-in `zlib`.
 */

interface DecodedImage {
  width: number;
  height: number;
  /** Tightly-packed RGBA, 4 bytes/pixel. */
  rgba: Uint8Array;
}

/** Read a big-endian uint32 from `buf` at `off`. */
function readU32(buf: Buffer, off: number): number {
  return (
    ((buf[off]! << 24) | (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!) >>> 0
  );
}

/** Paeth predictor used by PNG filter type 4. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Minimal PNG decoder for the subset Playwright/Chromium emits: 8-bit,
 * non-interlaced, color type 2 (RGB) or 6 (RGBA). Handles all five scanline
 * filters. Sufficient for a screenshot-variance assertion.
 */
function decodePng(png: Buffer): DecodedImage {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < sig.length; i++) {
    if (png[i] !== sig[i]) throw new Error("not a PNG");
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  let off = 8;
  while (off < png.length) {
    const len = readU32(png, off);
    const type = png.toString("ascii", off + 4, off + 8);
    const dataStart = off + 8;
    if (type === "IHDR") {
      width = readU32(png, dataStart);
      height = readU32(png, dataStart + 4);
      bitDepth = png[dataStart + 8]!;
      colorType = png[dataStart + 9]!;
    } else if (type === "IDAT") {
      idat.push(png.subarray(dataStart, dataStart + len));
    } else if (type === "IEND") {
      break;
    }
    off = dataStart + len + 4; // skip data + CRC
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG: bitDepth=${bitDepth} colorType=${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * channels);

  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]!;
    const rowStart = y * stride;
    const prevRowStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[pos++]!;
      const a = x >= channels ? out[rowStart + x - channels]! : 0; // left
      const b = y > 0 ? out[prevRowStart + x]! : 0; // up
      const c = x >= channels && y > 0 ? out[prevRowStart + x - channels]! : 0; // up-left
      let value: number;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + ((a + b) >> 1);
          break;
        case 4:
          value = rawByte + paeth(a, b, c);
          break;
        default:
          throw new Error(`bad PNG filter ${filter}`);
      }
      out[rowStart + x] = value & 0xff;
    }
  }

  // Expand to RGBA.
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < out.length; i += channels, j += 4) {
    rgba[j] = out[i]!;
    rgba[j + 1] = out[i + 1]!;
    rgba[j + 2] = out[i + 2]!;
    rgba[j + 3] = channels === 4 ? out[i + 3]! : 255;
  }
  return { width, height, rgba };
}

/**
 * Quantize-and-count distinct colors plus luma variance over an RGBA image. A
 * blank canvas yields 1 distinct color and ~0 variance; a real render yields
 * many distinct colors and non-trivial variance.
 */
function colorStats(rgba: Uint8Array): { distinct: number; variance: number } {
  const seen = new Set<number>();
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    // Quantize to 4 bits/channel so anti-aliasing noise doesn't inflate the count.
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    seen.add(key);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += lum;
    sumSq += lum * lum;
    n++;
  }
  const mean = n > 0 ? sum / n : 0;
  const variance = n > 0 ? sumSq / n - mean * mean : 0;
  return { distinct: seen.size, variance };
}

async function screenshotStats(
  canvas: Locator,
): Promise<{ distinct: number; variance: number; width: number; height: number }> {
  const png = await canvas.screenshot();
  const img = decodePng(png);
  const { distinct, variance } = colorStats(img.rgba);
  return { distinct, variance, width: img.width, height: img.height };
}

test.describe("gallery live canvas actually renders", () => {
  test("selecting Op Grid paints a non-uniform canvas (not blank/black)", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("/");

    // Select the Op Grid preset (draws an 8x8 checkerboard even at rest).
    const opGrid = page.locator(".preset-item", { hasText: "Op Grid" });
    await opGrid.first().click();

    const canvas = page.locator("canvas");
    await expect(canvas).toBeVisible();

    // Best-effort backend probe for the log (does not gate the assertion).
    const gpuPresent = await page.evaluate(() => "gpu" in navigator);

    // Feed deterministic audio without a mic: a 200Hz oscillator into an
    // AudioContext. Even if it is not wired to the visualizer, Op Grid still
    // draws its static geometry — the assertion holds either way.
    await page.evaluate(() => {
      try {
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (!Ctx) return;
        const ac = new Ctx();
        const osc = ac.createOscillator();
        osc.frequency.value = 200;
        const gain = ac.createGain();
        gain.gain.value = 0.05;
        osc.connect(gain).connect(ac.destination);
        osc.start();
      } catch {
        /* audio is best-effort; geometry renders regardless */
      }
    });

    // Let several animation frames run, then capture composited pixels.
    await page.waitForTimeout(1200);

    const { distinct, variance, width, height } = await screenshotStats(canvas);

    // eslint-disable-next-line no-console
    console.log(
      `[render-not-blank] gpuPresent=${gpuPresent} shot=${width}x${height} ` +
        `distinctColors=${distinct} variance=${variance.toFixed(1)}`,
    );

    // A blank/black canvas has exactly 1 distinct color and ~0 variance — the
    // bug. A rendering canvas paints many cells: assert clearly above that.
    expect(distinct).toBeGreaterThan(3);
    expect(variance).toBeGreaterThan(50);

    // The renderer must not have logged an init failure.
    expect(
      consoleErrors.filter((e) => /renderer|webgpu|webgl|gpu/i.test(e)),
    ).toEqual([]);
  });
});
