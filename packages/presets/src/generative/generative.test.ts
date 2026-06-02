/**
 * Tests for the generative / algorithmic preset pack.
 *
 * Each preset is driven through the public {@link Preset} lifecycle against a
 * recording mock {@link Renderer} (only `beginFrame`/`drawRect`/`endFrame`), so
 * these tests prove the presets work on any backend without touching GL/GPU. We
 * assert:
 *   - all three presets register into a {@link PresetRegistry} under unique ids;
 *   - names reference technique, not people / trademarks;
 *   - SEEDED DETERMINISM: the same seed + identical inputs reproduce an identical
 *     recorded draw set across two independent runs, and different seeds diverge;
 *   - AUDIO MATTERS: a sustained loud signal produces a measurably different draw
 *     set than silence;
 *   - NO Math.random: the pack's source contains no `Math.random` calls;
 *   - the pure parameter helpers respond to audio as documented.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PresetRegistry,
  type AudioFeatureFrame,
  type NormalizedRect,
  type PresetDefinition,
  type Renderer,
  type RgbaColor,
  type Scene,
  type RenderFeatures,
  type DrawingBufferSize,
} from "@cymatic/core";

import {
  fieldParams,
  flowFieldPreset,
  flowFieldPresetWithSeed,
  generativePresets,
  mulberry32,
  plotterCurve,
  plotterDensity,
  plotterPreset,
  plotterPresetWithSeed,
  reactionParams,
  reactionPreset,
  reactionPresetWithSeed,
  reactionSteps,
  registerGenerativePresets,
  valueNoise2D,
} from "./index.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type CapturedRect = NormalizedRect;

/** A minimal in-memory renderer that records the rects drawn per frame. */
class RecordingRenderer implements Renderer {
  readonly backend = "webgl" as const;
  readonly drawingBufferSize: DrawingBufferSize = { width: 100, height: 100 };

  lastFrameRects: CapturedRect[] = [];
  private current: CapturedRect[] | null = null;

  init(): Promise<void> {
    return Promise.resolve();
  }
  resize(): void {}
  render(_scene: Scene, _features: RenderFeatures, _time: number): void {}

  beginFrame(_background: RgbaColor): void {
    this.current = [];
  }
  drawRect(rect: NormalizedRect): void {
    if (!this.current) throw new Error("drawRect outside of a frame");
    this.current.push({ ...rect, color: { ...rect.color } });
  }
  endFrame(): void {
    if (!this.current) throw new Error("endFrame without beginFrame");
    this.lastFrameRects = this.current;
    this.current = null;
  }
  dispose(): void {}
}

function frame(over: Partial<AudioFeatureFrame> = {}): AudioFeatureFrame {
  return {
    bands: new Array<number>(16).fill(0),
    bass: 0,
    mid: 0,
    treble: 0,
    rms: 0,
    onset: false,
    time: 0,
    ...over,
  };
}

const SILENT = (): AudioFeatureFrame => frame();
const LOUD = (over: Partial<AudioFeatureFrame> = {}): AudioFeatureFrame =>
  frame({
    bands: new Array<number>(16).fill(0.85),
    bass: 0.9,
    mid: 0.7,
    treble: 0.8,
    rms: 0.8,
    ...over,
  });

/**
 * Drive a preset for `frames`, advancing time by a fixed step so determinism is
 * a function of (def/seed, inputs) only. Returns the renderer for inspection.
 */
function drive(def: PresetDefinition, frames: AudioFeatureFrame[]): RecordingRenderer {
  const renderer = new RecordingRenderer();
  const preset = def.create();
  void preset.init({ renderer, width: 100, height: 100, dpr: 1 });
  let t = 0;
  const step = 1 / 60;
  for (const f of frames) {
    preset.update({ ...f, time: t }, t, step);
    t += step;
  }
  return renderer;
}

/** A stable fingerprint of a frame's draw set, rounded to avoid float noise. */
function fingerprint(rects: CapturedRect[]): string {
  return rects
    .map(
      (r) =>
        `${r.x.toFixed(4)},${r.y.toFixed(4)},${r.w.toFixed(4)},${r.h.toFixed(4)}|` +
        `${r.color.r.toFixed(3)},${r.color.g.toFixed(3)},${r.color.b.toFixed(3)},${r.color.a.toFixed(3)}`,
    )
    .join(";");
}

const PACK: ReadonlyArray<[string, PresetDefinition]> = [
  ["Flow Field", flowFieldPreset],
  ["Reaction", reactionPreset],
  ["Plotter", plotterPreset],
];

const WITH_SEED: ReadonlyArray<[string, (seed: number) => PresetDefinition]> = [
  ["Flow Field", flowFieldPresetWithSeed],
  ["Reaction", reactionPresetWithSeed],
  ["Plotter", plotterPresetWithSeed],
];

/** Several frames of loud audio with a periodic beat — enough state to diverge. */
function loudRun(n = 40): AudioFeatureFrame[] {
  return Array.from({ length: n }, (_v, i) => LOUD({ onset: i % 8 === 0 }));
}

// ---------------------------------------------------------------------------
// Registry + naming
// ---------------------------------------------------------------------------

describe("generative pack — registry", () => {
  it("registers at least three presets into a registry under unique ids", () => {
    const registry = new PresetRegistry();
    const registered = registerGenerativePresets(registry);

    expect(registered.length).toBeGreaterThanOrEqual(3);
    for (const def of generativePresets) {
      expect(registry.has(def.id)).toBe(true);
      expect(typeof registry.create(def.id).update).toBe("function");
    }
    expect(registry.size).toBe(generativePresets.length);
    expect(new Set(generativePresets.map((p) => p.id)).size).toBe(generativePresets.length);
  });

  it("names reference technique, not people or trademarks", () => {
    const names = generativePresets.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["Flow Field", "Reaction", "Plotter"]));
    for (const name of names) {
      expect(name).not.toMatch(/conway|perlin|gray|scott|®|™/i);
    }
  });

  it("each preset renders a non-empty frame through the Renderer", () => {
    for (const [, def] of PACK) {
      const r = drive(def, loudRun(20));
      expect(r.lastFrameRects.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Seeded determinism — the headline property of this pack
// ---------------------------------------------------------------------------

describe.each(WITH_SEED)("generative pack — %s is seed-deterministic", (_name, withSeed) => {
  it("same seed + identical inputs → identical draw set across two runs", () => {
    const seq = loudRun();
    const a = drive(withSeed(1234), seq);
    const b = drive(withSeed(1234), seq);
    expect(fingerprint(a.lastFrameRects)).toBe(fingerprint(b.lastFrameRects));
    // And there is actually content to compare.
    expect(a.lastFrameRects.length).toBeGreaterThan(0);
  });

  it("different seeds produce a different draw set", () => {
    const seq = loudRun();
    const a = drive(withSeed(1), seq);
    const b = drive(withSeed(2), seq);
    expect(fingerprint(a.lastFrameRects)).not.toBe(fingerprint(b.lastFrameRects));
  });
});

// ---------------------------------------------------------------------------
// Audio actually drives the output
// ---------------------------------------------------------------------------

describe.each(PACK)("generative pack — %s responds to audio", (_name, def) => {
  it("produces a measurably different draw set for loud vs silent input", () => {
    const loud = drive(def, loudRun());
    const silent = drive(def, new Array<AudioFeatureFrame>(40).fill(SILENT()));
    expect(fingerprint(loud.lastFrameRects)).not.toBe(fingerprint(silent.lastFrameRects));
  });

  it("is deterministic given the same (features, time)", () => {
    const seq = loudRun();
    const a = drive(def, seq);
    const b = drive(def, seq);
    expect(fingerprint(a.lastFrameRects)).toBe(fingerprint(b.lastFrameRects));
  });
});

// ---------------------------------------------------------------------------
// No Math.random in the pack's source (determinism guard)
// ---------------------------------------------------------------------------

describe("generative pack — uses a seeded PRNG, never Math.random", () => {
  it("no source file in src/generative references Math.random", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const raw = readFileSync(join(here, f), "utf8");
      // Strip line + block comments so a doc mention ("instead of Math.random")
      // isn't a false positive — we only forbid an actual call in code.
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(code, `${f} must not call Math.random()`).not.toMatch(/Math\s*\.\s*random/);
    }
  });

  it("mulberry32 yields a deterministic stream for a given seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    const seqC = [c(), c(), c(), c()];
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Pure parameter helpers
// ---------------------------------------------------------------------------

describe("generative pack — pure helpers", () => {
  it("valueNoise2D is deterministic and stays in [0,1]", () => {
    expect(valueNoise2D(1.5, 2.5, 7)).toBe(valueNoise2D(1.5, 2.5, 7));
    expect(valueNoise2D(1.5, 2.5, 7)).not.toBe(valueNoise2D(1.5, 2.5, 8));
    for (let i = 0; i < 20; i++) {
      const v = valueNoise2D(i * 0.37, i * 0.91, 3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("flow field: more bass widens the currents, beat burst raises speed", () => {
    const quiet = fieldParams(0.1, 0.1, 0);
    const bassy = fieldParams(0.9, 0.1, 0);
    // Bigger sweeping structures = lower noise frequency (smaller scale).
    expect(bassy.scale).toBeLessThan(quiet.scale);
    const calm = fieldParams(0.1, 0.2, 0);
    const burst = fieldParams(0.1, 0.2, 0.9);
    expect(burst.speed).toBeGreaterThan(calm.speed);
  });

  it("reaction: bass raises feed, treble raises kill; beat adds steps", () => {
    expect(reactionParams(0.9, 0.5).feed).toBeGreaterThan(reactionParams(0.1, 0.5).feed);
    expect(reactionParams(0.5, 0.9).kill).toBeGreaterThan(reactionParams(0.5, 0.1).kill);
    expect(reactionSteps(0.9)).toBeGreaterThan(reactionSteps(0));
  });

  it("plotter: louder bass lays down more segments; seed fixes a stable figure", () => {
    expect(plotterDensity(0.9)).toBeGreaterThan(plotterDensity(0.1));
    expect(plotterCurve(99)).toEqual(plotterCurve(99));
    expect(plotterCurve(99)).not.toEqual(plotterCurve(100));
  });
});
