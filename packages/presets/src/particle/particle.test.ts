/**
 * Tests for the particle / fluid / 3D preset pack.
 *
 * Each preset is driven through the public {@link Preset} lifecycle against a
 * recording mock {@link Renderer} (only `beginFrame`/`drawRect`/`endFrame`), so
 * these tests prove the presets work on any backend without touching GL/GPU. We
 * assert:
 *   - all three presets register into a {@link PresetRegistry} under unique ids;
 *   - names match the brief ("Particles" / "Fluid" / "Light 3D") and reference
 *     technique, not people / trademarks;
 *   - SEEDED DETERMINISM: the same seed + identical inputs reproduce an identical
 *     recorded draw set across two independent runs, and different seeds diverge;
 *   - AUDIO MATTERS: beats raise particle/emission activity (more draws or higher
 *     velocity) vs silence;
 *   - PERFORMANCE GUARD: live particle count / point count never exceeds the cap;
 *   - NO Math.random / Date: the pack's source contains no such calls;
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
  DEFAULT_MAX_PARTICLES,
  DEFAULT_MAX_POINTS,
  emissionCount,
  emissionSpeed,
  fluidParams,
  fluidPreset,
  fluidPresetWithSeed,
  light3dParams,
  light3dPreset,
  light3dPresetWithSeed,
  particlePresets,
  particlesPreset,
  particlesPresetWithSeed,
  project,
  registerParticlePresets,
} from "./index.js";
import { mulberry32 } from "./common.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type CapturedRect = NormalizedRect;

/** A minimal in-memory renderer that records the rects drawn per frame. */
class RecordingRenderer implements Renderer {
  readonly backend = "webgl" as const;
  readonly drawingBufferSize: DrawingBufferSize = { width: 100, height: 100 };

  lastFrameRects: CapturedRect[] = [];
  /** Max rects seen in any single frame across the whole run (perf guard). */
  maxRectsInAnyFrame = 0;
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
    if (this.current.length > this.maxRectsInAnyFrame) {
      this.maxRectsInAnyFrame = this.current.length;
    }
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
    spectralCentroid: 0,
    spectralRolloff: 0,
    spectralFlux: 0,
    loudnessShort: 0,
    loudnessLong: 0,
    dynamics: 0,
    tempo: 0,
    beatPhase: 0,
    onsetDensity: 0,
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
  ["Particles", particlesPreset],
  ["Fluid", fluidPreset],
  ["Light 3D", light3dPreset],
];

const WITH_SEED: ReadonlyArray<[string, (seed: number) => PresetDefinition]> = [
  ["Particles", particlesPresetWithSeed],
  ["Fluid", fluidPresetWithSeed],
  ["Light 3D", light3dPresetWithSeed],
];

/** Several frames of loud audio with a periodic beat — enough state to diverge. */
function loudRun(n = 40): AudioFeatureFrame[] {
  return Array.from({ length: n }, (_v, i) => LOUD({ onset: i % 8 === 0 }));
}

/** Silent frames for the same duration. */
function silentRun(n = 40): AudioFeatureFrame[] {
  return new Array<AudioFeatureFrame>(n).fill(SILENT());
}

// ---------------------------------------------------------------------------
// Registry + naming
// ---------------------------------------------------------------------------

describe("particle pack — registry", () => {
  it("registers at least three presets into a registry under unique ids", () => {
    const registry = new PresetRegistry();
    const registered = registerParticlePresets(registry);

    expect(registered.length).toBeGreaterThanOrEqual(3);
    for (const def of particlePresets) {
      expect(registry.has(def.id)).toBe(true);
      expect(typeof registry.create(def.id).update).toBe("function");
    }
    expect(registry.size).toBe(particlePresets.length);
    expect(new Set(particlePresets.map((p) => p.id)).size).toBe(particlePresets.length);
  });

  it("names match the brief and reference technique, not people or trademarks", () => {
    const names = particlePresets.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["Particles", "Fluid", "Light 3D"]));
    for (const name of names) {
      expect(name).not.toMatch(/navier|stokes|®|™/i);
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

describe.each(WITH_SEED)("particle pack — %s is seed-deterministic", (_name, withSeed) => {
  it("same seed + identical inputs → identical draw set across two runs", () => {
    const seq = loudRun();
    const a = drive(withSeed(1234), seq);
    const b = drive(withSeed(1234), seq);
    expect(fingerprint(a.lastFrameRects)).toBe(fingerprint(b.lastFrameRects));
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

describe.each(PACK)("particle pack — %s responds to audio", (_name, def) => {
  it("produces a measurably different draw set for loud/beaty vs silent input", () => {
    const loud = drive(def, loudRun());
    const silent = drive(def, silentRun());
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
// Beats raise activity (emission / live count) above silence
// ---------------------------------------------------------------------------

describe("particle pack — beats increase activity", () => {
  it("Particles: a beaty run ends with more live particles than a silent run", () => {
    // Drive enough frames that emission has accumulated under beats while the
    // silent run has emitted nothing.
    const loud = drive(particlesPreset, loudRun(30));
    const silent = drive(particlesPreset, silentRun(30));
    expect(loud.lastFrameRects.length).toBeGreaterThan(silent.lastFrameRects.length);
    // Silence emits nothing → no live particles to draw.
    expect(silent.lastFrameRects.length).toBe(0);
  });

  it("Fluid: a beaty run injects more dye (more lit cells) than silence", () => {
    const loud = drive(fluidPreset, loudRun(30));
    const silent = drive(fluidPreset, silentRun(30));
    expect(loud.lastFrameRects.length).toBeGreaterThan(silent.lastFrameRects.length);
  });

  it("emissionCount: a beat emits more than a sustained tone, which emits more than silence", () => {
    const onBeat = emissionCount(0.85, 0.8, true);
    const sustained = emissionCount(0, 0.8, false);
    const silentEmit = emissionCount(0, 0, false);
    expect(onBeat).toBeGreaterThan(sustained);
    expect(sustained).toBeGreaterThan(silentEmit);
    expect(silentEmit).toBe(0);
  });

  it("emissionSpeed: louder bass throws particles faster", () => {
    expect(emissionSpeed(0.9)).toBeGreaterThan(emissionSpeed(0.1));
  });
});

// ---------------------------------------------------------------------------
// Performance guard — caps are respected
// ---------------------------------------------------------------------------

describe("particle pack — performance caps", () => {
  it("Particles never draws more rects in a frame than its particle cap", () => {
    const r = drive(particlesPreset, loudRun(120));
    expect(r.maxRectsInAnyFrame).toBeLessThanOrEqual(DEFAULT_MAX_PARTICLES);
  });

  it("Particles honours a custom (smaller) maxParticles cap", () => {
    const small = particlesPresetWithSeed(7, { maxParticles: 50 });
    const r = drive(small, loudRun(120));
    expect(r.maxRectsInAnyFrame).toBeLessThanOrEqual(50);
    expect(r.maxRectsInAnyFrame).toBeGreaterThan(0);
  });

  it("Light 3D never draws more rects in a frame than its point cap", () => {
    const r = drive(light3dPreset, loudRun(60));
    expect(r.maxRectsInAnyFrame).toBeLessThanOrEqual(DEFAULT_MAX_POINTS);
  });

  it("Light 3D honours a custom (smaller) maxPoints cap", () => {
    const small = light3dPresetWithSeed(7, { maxPoints: 80 });
    const r = drive(small, loudRun(60));
    expect(r.maxRectsInAnyFrame).toBeLessThanOrEqual(80);
  });

  it("Fluid never draws more rects in a frame than its grid cell count", () => {
    const small = fluidPresetWithSeed(7, { gridSize: 24 });
    const r = drive(small, loudRun(80));
    expect(r.maxRectsInAnyFrame).toBeLessThanOrEqual(24 * 24);
  });
});

// ---------------------------------------------------------------------------
// No Math.random / Date in the pack's source (determinism guard)
// ---------------------------------------------------------------------------

describe("particle pack — uses a seeded PRNG, never Math.random / Date", () => {
  it("no source file in src/particle references Math.random or Date.now", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const raw = readFileSync(join(here, f), "utf8");
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, `${f} must not call Math.random()`).not.toMatch(/Math\s*\.\s*random/);
      expect(code, `${f} must not call Date.now() / new Date`).not.toMatch(/Date\s*\.\s*now|new\s+Date/);
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

describe("particle pack — pure helpers", () => {
  it("fluid: bass raises rise speed; treble raises swirl", () => {
    expect(fluidParams(0.9, 0.2, 0).rise).toBeGreaterThan(fluidParams(0.1, 0.2, 0).rise);
    expect(fluidParams(0.2, 0.9, 0).swirl).toBeGreaterThan(fluidParams(0.2, 0.1, 0).swirl);
    // A beat burst adds energy to both.
    expect(fluidParams(0.3, 0.3, 0.9).rise).toBeGreaterThan(fluidParams(0.3, 0.3, 0).rise);
  });

  it("light3d: treble/beat raise spin; bass raises the radius pulse", () => {
    expect(light3dParams(0.2, 0.9, 0).spin).toBeGreaterThan(light3dParams(0.2, 0.1, 0).spin);
    expect(light3dParams(0.2, 0.2, 0.9).spin).toBeGreaterThan(light3dParams(0.2, 0.2, 0).spin);
    expect(light3dParams(0.9, 0.2, 0).pulse).toBeGreaterThan(light3dParams(0.1, 0.2, 0).pulse);
  });

  it("project: a nearer point projects larger (bigger depth factor) than a farther one", () => {
    // No rotation → z directly controls depth. Negative z is toward the camera.
    const near = project({ x: 0, y: 0, z: -0.8 }, 1, 0, 1, 0, 1);
    const far = project({ x: 0, y: 0, z: 0.8 }, 1, 0, 1, 0, 1);
    expect(near).not.toBeNull();
    expect(far).not.toBeNull();
    expect(near!.depth).toBeGreaterThan(far!.depth);
  });

  it("project: a point too close to / behind the camera is culled (returns null)", () => {
    // No rotation → rz = z * radius. CAMERA_Z is 3, so rz <= -2.95 collapses the
    // perspective denominator; z = -0.99 * radius 3 = -2.97 trips the cull.
    const behind = project({ x: 0, y: 0, z: -0.99 }, 1, 0, 1, 0, 3);
    expect(behind).toBeNull();
  });
});
