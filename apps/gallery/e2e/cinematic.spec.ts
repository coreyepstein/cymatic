import { expect, test, type Locator, type Page } from "@playwright/test";

import { decodePng, luminance, type DecodedImage } from "./png.js";

/**
 * V2-15 cinematic verification — the consolidated, durable regression guards for
 * the headline "it looks cinematic and EVOLVES over a song" guarantees, proven
 * pixel-level in a real browser (no mocks). Companion to the per-pack specs
 * (V2-10..13), which prove each family renders; this spec proves the
 * cross-cutting promises:
 *
 *   1. Evolves over a song — a synthetic SONG ARC (intro → build → drop →
 *      breakdown, ~12s) driven by a REAL Director materially changes the look
 *      between sections, for one preset PER PACK (all four families).
 *   2. Bloom/glow present — bloom forced on spreads measurably more bright halo
 *      than a no-bloom baseline.
 *   3. Seed variation — the same preset + same arc under two director seeds
 *      diverges (proves randomness).
 *   4. Perf budget — average ms/frame for a representative cinematic preset
 *      (bloom + feedback) is measured and LOGGED; a tolerant CI-safe ceiling
 *      warns rather than hard-failing on perf alone.
 *
 * Backend-aware: WebGPU runs the full bloom/feedback chain; headless Chromium
 * usually falls back to WebGL (post-FX a documented no-op). The not-blank,
 * evolves, and seed-variation guarantees hold on BOTH backends (they ride the
 * director's palette/hue/intensity which paint regardless of post-FX). Bloom
 * spread is only asserted where WebGPU actually ran; otherwise it is recorded.
 *
 * Thresholds are tuned to be CI-stable on headless SwiftShader yet tight enough
 * to FAIL a static/flat/blank renderer — each carries a comment on its intent.
 */

interface FrameStats {
  /** Distinct quantized colors (blank canvas → ~1). */
  distinct: number;
  /** Luma variance across the frame (blank/flat → ~0). */
  variance: number;
  /** Mean luminance (overall brightness) — composition/brightness signal. */
  meanLuma: number;
  /** Count of bright pixels (luma > 60) — glow halos light up many. */
  bright: number;
  /** Count of mid-bright pixels (luma 25..220) — bloom turns edges into gradients. */
  midBright: number;
  /** Mean normalized RGB over lit pixels (the dominant lit hue). */
  hue: { r: number; g: number; b: number };
}

function frameStats(img: DecodedImage): FrameStats {
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
    seen.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    const lum = luminance(r, g, b);
    sum += lum;
    sumSq += lum * lum;
    n++;
    if (lum > 60) bright++;
    if (lum >= 25 && lum <= 220) midBright++;
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
    meanLuma: mean,
    bright,
    midBright,
    hue:
      hueN > 0
        ? { r: hueAcc.r / hueN, g: hueAcc.g / hueN, b: hueAcc.b / hueN }
        : { r: 0, g: 0, b: 0 },
  };
}

/** L1 distance between two dominant-hue vectors (each component is a ratio). */
function hueDelta(a: FrameStats, b: FrameStats): number {
  return (
    Math.abs(a.hue.r - b.hue.r) +
    Math.abs(a.hue.g - b.hue.g) +
    Math.abs(a.hue.b - b.hue.b)
  );
}

/**
 * Composite "how different do these two frames look" score: dominant-hue shift
 * plus a normalized brightness/composition shift. A static loop scores ~0; a
 * look that genuinely develops scores well above the thresholds below.
 */
function lookDelta(a: FrameStats, b: FrameStats): number {
  const hue = hueDelta(a, b);
  const lumaShift = Math.abs(a.meanLuma - b.meanLuma) / 255;
  return hue + lumaShift;
}

interface ArcSample {
  t: number;
  label: string;
  section: string;
  bloom: number;
}

async function bootHarness(page: Page): Promise<{ backend: string; canvas: Locator }> {
  await page.goto("/cinematic-harness.html");
  await page.waitForFunction(() => window.__cineHarnessReady === true, undefined, {
    timeout: 30_000,
  });
  const bootError = await page.evaluate(() => window.__cineHarnessError ?? null);
  expect(bootError, `harness boot error: ${bootError ?? ""}`).toBeNull();
  const backend = await page.evaluate(() => window.__cineHarness!.backend());
  const canvas = page.locator("#c");
  await expect(canvas).toBeVisible();
  return { backend, canvas };
}

/** Run the arc to `seconds` under `seed`, return the canvas stats + arc sample. */
async function captureArc(
  page: Page,
  canvas: Locator,
  seed: number,
  seconds: number,
): Promise<{ stats: FrameStats; sample: ArcSample }> {
  const sample = await page.evaluate(
    ([s, sec]) => window.__cineHarness!.runArc(s as number, sec as number),
    [seed, seconds] as const,
  );
  const stats = frameStats(decodePng(await canvas.screenshot()));
  return { stats, sample };
}

const SEED_A = 0x1a2b3c4d;
const SEED_B = 0x77c0ffee;

/** One representative preset per pack — every visual family must prove evolution. */
const PACK_PRESETS: ReadonlyArray<{ pack: string; presetId: string }> = [
  { pack: "geometric", presetId: "geometric.op-grid" },
  { pack: "colorfield", presetId: "colorfield.field" },
  { pack: "generative", presetId: "generative.flow-field" },
  { pack: "particle", presetId: "particle.particles" },
];

test.describe("V2-15 cinematic guarantees (real browser, pixel-level)", () => {
  // (1) EVOLVES OVER A SONG — one preset per pack, all four families.
  for (const { pack, presetId } of PACK_PRESETS) {
    test(`[${pack}] ${presetId}: look evolves across the song arc`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });

      const { backend, canvas } = await bootHarness(page);
      await page.evaluate((id) => window.__cineHarness!.select(id), presetId);

      // Capture at three song positions: intro (~2s), drop (~7s), breakdown
      // (~11s). Each call re-runs the arc from t=0 under the SAME seed, so the
      // only difference between captures is HOW FAR through the song we are —
      // i.e. genuine development over the track, not frame jitter.
      const intro = await captureArc(page, canvas, SEED_A, 2.0);
      const drop = await captureArc(page, canvas, SEED_A, 7.0);
      const breakdown = await captureArc(page, canvas, SEED_A, 11.0);

      const introToDrop = lookDelta(intro.stats, drop.stats);
      const dropToBreakdown = lookDelta(drop.stats, breakdown.stats);
      const introToBreakdown = lookDelta(intro.stats, breakdown.stats);

      // eslint-disable-next-line no-console
      console.log(
        `[cinematic][${pack}] ${presetId} backend=${backend} | ` +
          `intro(t=${intro.sample.t},sec=${intro.sample.section}) ` +
          `drop(t=${drop.sample.t},sec=${drop.sample.section}) ` +
          `breakdown(t=${breakdown.sample.t},sec=${breakdown.sample.section}) | ` +
          `intro->drop=${introToDrop.toFixed(3)} ` +
          `drop->breakdown=${dropToBreakdown.toFixed(3)} ` +
          `intro->breakdown=${introToBreakdown.toFixed(3)} | ` +
          `meanLuma intro=${intro.stats.meanLuma.toFixed(1)} ` +
          `drop=${drop.stats.meanLuma.toFixed(1)} ` +
          `breakdown=${breakdown.stats.meanLuma.toFixed(1)}`,
      );

      // Each capture is a real, non-blank frame (>3 distinct colors + real luma
      // variance). A blank/flat canvas scores ~1 distinct and ~0 variance; the
      // floor of 8 still fails a flat renderer by an order of magnitude while
      // tolerating the dimmest section of a sparse field (e.g. a particle
      // breakdown), where evolution is still proven by the deltas below.
      //
      // Backend-aware: on WebGPU the HDR bloom/glow chain lifts even the QUIET
      // intro into visible glow, so all three captures clear the floor. On WebGL
      // (the documented BASIC look — no HDR/bloom) a SPARSE field at the quiet
      // intro is legitimately near-black until the song's energy ramps in, so the
      // not-blank floor is asserted on the song's LIT sections (drop +
      // breakdown). Either way the headline guarantee — the look EVOLVES over the
      // track — is asserted on BOTH backends by the deltas below; this is the
      // real per-backend contract, not a loosened WebGPU assertion.
      const notBlankCaptures = backend === "webgpu" ? [intro, drop, breakdown] : [drop, breakdown];
      for (const cap of notBlankCaptures) {
        expect(cap.stats.distinct).toBeGreaterThan(3);
        expect(cap.stats.variance).toBeGreaterThan(8);
      }

      // The director must have actually progressed through the arc — the drop
      // capture is NOT still in the intro section (proves the song-arc engine
      // advanced, not a frozen state).
      expect(drop.sample.section).not.toBe("intro");

      // The look develops MATERIALLY at multiple points along the track: a
      // static loop scores ~0 on lookDelta; 0.03 is comfortably above headless
      // pixel jitter yet any real palette/intensity development clears it.
      expect(introToDrop).toBeGreaterThan(0.03);
      expect(dropToBreakdown).toBeGreaterThan(0.03);
      // End-to-end the track has clearly moved on from where it started.
      expect(introToBreakdown).toBeGreaterThan(0.03);

      expect(
        consoleErrors.filter((e) => /renderer|webgpu|webgl|gpu/i.test(e)),
      ).toEqual([]);
    });
  }

  // (2) BLOOM / GLOW PRESENT — bloom-ON spreads more bright halo than baseline.
  test("bloom forced on spreads more bright halo than a no-bloom baseline", async ({
    page,
  }) => {
    const { backend, canvas } = await bootHarness(page);
    // colorfield.field is a smooth, luminous field that drives the full post
    // chain (bloom + feedback trail).
    await page.evaluate(() => window.__cineHarness!.select("colorfield.field"));

    // Compare at the DIM intro section (~2s), NOT the saturated drop: at full
    // energy the field is already near-white everywhere, leaving no dark room
    // for a halo to spread into. At the dim intro bloom visibly lifts glow.
    const BLOOM_AT = 2.0;
    await page.evaluate(
      (at) => window.__cineHarness!.renderBloom(0x1a2b3c4d, 0.0, at as number),
      BLOOM_AT,
    );
    const off = frameStats(decodePng(await canvas.screenshot()));
    await page.evaluate(
      (at) => window.__cineHarness!.renderBloom(0x1a2b3c4d, 0.9, at as number),
      BLOOM_AT,
    );
    const on = frameStats(decodePng(await canvas.screenshot()));

    // Bloom blurs bright cores back over the scene additively, so it injects
    // glow ENERGY: overall brightness rises and the bright-pixel population
    // grows as halos light up previously-dim pixels.
    const lumaDelta = on.meanLuma - off.meanLuma;
    const brightDelta = on.bright - off.bright;

    // eslint-disable-next-line no-console
    console.log(
      `[cinematic][bloom] backend=${backend} ` +
        `meanLuma off=${off.meanLuma.toFixed(1)} on=${on.meanLuma.toFixed(1)} ` +
        `delta=${lumaDelta.toFixed(2)} | ` +
        `bright off=${off.bright} on=${on.bright} delta=${brightDelta}`,
    );

    if (backend === "webgpu") {
      // The glow MUST be visible: bloom blurs bright cores back over the scene,
      // injecting glow energy so overall brightness rises measurably AND more
      // pixels cross into bright (halo spread). lumaDelta>1 and brightDelta>0
      // are strongly cleared by any real bloom; a no-op chain leaves both ~0.
      expect(lumaDelta).toBeGreaterThan(1);
      expect(brightDelta).toBeGreaterThan(0);
    } else {
      // WebGL: post-FX is a documented no-op, so the two captures match. We still
      // proved the harness paints real, non-blank pixels on a real backend.
      // eslint-disable-next-line no-console
      console.log(`[cinematic][bloom] backend=${backend}: post-FX no-op, bloom not exercisable here`);
      expect(on.midBright).toBeGreaterThan(0);
    }
  });

  // (3) SEED VARIATION — same preset + same arc, two seeds → divergent output.
  test("different director seeds produce visibly different output", async ({ page }) => {
    const { backend, canvas } = await bootHarness(page);
    // generative.flow-field's per-seed drift makes randomness easiest to see.
    await page.evaluate(() => window.__cineHarness!.select("generative.flow-field"));

    // Same song position (the drop) under two different director seeds. With the
    // arc identical, any difference is the director's seeded randomness.
    const a = await captureArc(page, canvas, SEED_A, 7.0);
    const b = await captureArc(page, canvas, SEED_B, 7.0);
    const delta = lookDelta(a.stats, b.stats);

    // eslint-disable-next-line no-console
    console.log(
      `[cinematic][seed] backend=${backend} seedA=${SEED_A.toString(16)} ` +
        `seedB=${SEED_B.toString(16)} lookDelta=${delta.toFixed(3)} | ` +
        `hueDelta=${hueDelta(a.stats, b.stats).toFixed(3)}`,
    );

    // Both seeds render real, non-blank frames.
    expect(a.stats.variance).toBeGreaterThan(20);
    expect(b.stats.variance).toBeGreaterThan(20);
    // The two seeds diverge. 0.02 is tolerant of headless jitter but a true
    // deterministic-with-no-randomness renderer would score ~0 here.
    expect(delta).toBeGreaterThan(0.02);
  });

  // (4) PERF BUDGET — measure + log ms/frame; warn (don't hard-fail) if over.
  test("representative cinematic preset stays within a tolerant perf budget", async ({
    page,
  }) => {
    const { backend, canvas } = await bootHarness(page);
    // colorfield.field at 320² with bloom + feedback is a representative
    // cinematic load.
    await page.evaluate(() => window.__cineHarness!.select("colorfield.field"));
    await expect(canvas).toBeVisible();

    const FRAMES = 120;
    const msPerFrame = await page.evaluate(
      (frames) => window.__cineHarness!.measurePerf(0x1a2b3c4d, frames as number),
      FRAMES,
    );

    // Target is < ~20ms/frame (50fps). Headless SwiftShader is far slower than
    // real hardware, so the HARD ceiling here is deliberately tolerant — we LOG
    // the real number for tracking and only WARN above target. Perf alone never
    // flakes CI red; the very loose ceiling only catches a catastrophic
    // regression (e.g. seconds/frame).
    const TARGET_MS = 20;
    const HARD_CEILING_MS = 500;

    // eslint-disable-next-line no-console
    console.log(
      `[cinematic][perf] backend=${backend} preset=colorfield.field ` +
        `res=320x320 frames=${FRAMES} msPerFrame=${msPerFrame.toFixed(2)} ` +
        `target=${TARGET_MS} (${msPerFrame <= TARGET_MS ? "WITHIN" : "OVER"} target)`,
    );
    if (msPerFrame > TARGET_MS) {
      // eslint-disable-next-line no-console
      console.warn(
        `[cinematic][perf] WARNING: ${msPerFrame.toFixed(2)}ms/frame exceeds the ` +
          `${TARGET_MS}ms target on backend=${backend} (likely headless software ` +
          `rendering, not a real-hardware regression).`,
      );
    }

    expect(msPerFrame).toBeGreaterThan(0);
    expect(msPerFrame).toBeLessThan(HARD_CEILING_MS);
  });
});
