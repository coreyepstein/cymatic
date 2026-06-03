/**
 * Tests for the cinematic particle / fluid / 3D preset pack (V2-13).
 *
 * Every preset is driven through the public {@link Preset} lifecycle against a
 * recording mock {@link Renderer} that captures the FULL cinematic surface —
 * rects, gradient rects, glows, lines, blend modes, and post-FX — so these tests
 * prove the presets work on any backend without touching GL/GPU. We assert:
 *   - each preset registers AND declares a non-empty (6+) param schema;
 *   - the canonical ids/names are kept ("Particles" / "Fluid" / "Light 3D");
 *   - names reference technique, not people / trademarks;
 *   - the pack emits soft additive GLOW (cinematic light) and sets bloom +
 *     feedback on;
 *   - a loud / high-energy frame produces MORE / brighter glow than a silent one;
 *   - director evolution: calm intro vs hot drop yield materially DIFFERENT
 *     output (color and/or composition) — proving it evolves over a song;
 *   - SEEDED DETERMINISM: same `(features, director, time, seed)` → identical
 *     recorded draw sequence across two independent runs;
 *   - PER-SECTION RESEED: changing the director's `seed` (a section change)
 *     changes the generated pattern;
 *   - PERFORMANCE GUARD: the live particle count never exceeds the hard cap;
 *   - NO `Math.random` / `Date.now`: the pack's source contains neither;
 *   - the pure parameter helpers respond to audio / director as documented.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  Director,
  PresetRegistry,
  restingDirectorState,
  type AudioFeatureFrame,
  type BlendMode,
  type DirectorState,
  type DrawingBufferSize,
  type GlowSpec,
  type GradientFill,
  type LineSpec,
  type NormalizedRect,
  type PostEffectsConfig,
  type Preset,
  type PresetDefinition,
  type Renderer,
  type RenderFeatures,
  type RgbaColor,
  type Scene,
} from "@cymatic/core";

import {
  DEFAULT_MAX_PARTICLES,
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
import { directorColor, paletteForIndex, sectionSeed } from "./common.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type CapturedRect = NormalizedRect;
interface CapturedGradient {
  rect: NormalizedRect;
  fill: GradientFill;
}

/**
 * A minimal in-memory renderer that records the full cinematic draw surface per
 * frame. It honors the begin/draw/end discipline so misuse (drawing outside a
 * frame) is caught.
 */
class RecordingRenderer implements Renderer {
  readonly backend = "webgl" as const;
  readonly drawingBufferSize: DrawingBufferSize = { width: 100, height: 100 };

  backgrounds: RgbaColor[] = [];
  postEffects: PostEffectsConfig[] = [];

  lastFrame = {
    rects: [] as CapturedRect[],
    gradients: [] as CapturedGradient[],
    glows: [] as GlowSpec[],
    lines: [] as LineSpec[],
    blendModes: [] as BlendMode[],
    background: { r: 0, g: 0, b: 0, a: 1 } as RgbaColor,
  };
  private cur: typeof this.lastFrame | null = null;

  init(): Promise<void> {
    return Promise.resolve();
  }
  resize(): void {}
  render(_scene: Scene, _features: RenderFeatures, _time: number): void {}

  beginFrame(background: RgbaColor): void {
    this.backgrounds.push({ ...background });
    this.cur = {
      rects: [],
      gradients: [],
      glows: [],
      lines: [],
      blendModes: [],
      background: { ...background },
    };
  }
  private frame(): NonNullable<typeof this.cur> {
    if (!this.cur) throw new Error("draw outside of a frame");
    return this.cur;
  }
  setBlendMode(mode: BlendMode): void {
    this.frame().blendModes.push(mode);
  }
  drawRect(rect: NormalizedRect): void {
    this.frame().rects.push({ ...rect, color: { ...rect.color } });
  }
  drawGradientRect(rect: NormalizedRect, fill: GradientFill): void {
    this.frame().gradients.push({
      rect: { ...rect, color: { ...rect.color } },
      fill: { ...fill, from: { ...fill.from }, to: { ...fill.to } },
    });
  }
  drawGlow(glow: GlowSpec): void {
    this.frame().glows.push({ ...glow, color: { ...glow.color } });
  }
  drawLine(line: LineSpec): void {
    this.frame().lines.push({ ...line, color: { ...line.color } });
  }
  setPostEffects(config: PostEffectsConfig): void {
    this.postEffects.push(config);
  }
  endFrame(): void {
    if (!this.cur) throw new Error("endFrame without beginFrame");
    this.lastFrame = this.cur;
    this.cur = null;
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
    mood: { energy: 0, brightness: 0, busyness: 0, valence: 0, dynamics: 0 },
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
    loudnessLong: 0.8,
    mood: { energy: 0.9, brightness: 0.7, busyness: 0.8, valence: 0.6, dynamics: 0.5 },
    ...over,
  });

/** A calm intro-like director state (low intensity, first palette, no rotation). */
function calmDirector(): DirectorState {
  return {
    ...restingDirectorState(),
    section: 0 as DirectorState["section"],
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
}

/** A hot drop-like director state: high intensity, mid-crossfade, hue rotated. */
function hotDirector(): DirectorState {
  return {
    ...restingDirectorState(),
    section: 3 as DirectorState["section"],
    intensity: 0.95,
    motion: 1.6,
    bloom: 0.85,
    density: 1.5,
    contrast: 0.85,
    paletteIndex: 4,
    prevPaletteIndex: 2,
    paletteBlend: 0.5,
    hueRotation: 0.4,
  };
}

/**
 * Drive a preset against a fresh renderer for N frames at a fixed dt, threading
 * a director state into every update. Returns the renderer for inspection.
 */
function drive(
  def: PresetDefinition,
  frames: AudioFeatureFrame[],
  director: DirectorState = restingDirectorState(),
): { renderer: RecordingRenderer; preset: Preset } {
  const renderer = new RecordingRenderer();
  const preset = def.create();
  void preset.init({ renderer, width: 100, height: 100, dpr: 1 });
  let t = 0;
  for (const f of frames) {
    preset.update({ ...f, time: t }, t, 1 / 60, { director });
    t += 1 / 60;
  }
  return { renderer, preset };
}

/**
 * A stable fingerprint of a frame's FULL draw set (rects + gradients + glows +
 * lines), rounded to avoid float noise. Two runs with identical inputs must
 * produce an identical fingerprint.
 */
function fingerprint(r: RecordingRenderer): string {
  const f = r.lastFrame;
  const c = (col: RgbaColor): string =>
    `${col.r.toFixed(3)},${col.g.toFixed(3)},${col.b.toFixed(3)},${col.a.toFixed(3)}`;
  const parts: string[] = [`bg:${c(f.background)}`, `blend:${f.blendModes.join(">")}`];
  for (const x of f.rects) parts.push(`R ${x.x.toFixed(3)},${x.y.toFixed(3)},${x.w.toFixed(3)},${x.h.toFixed(3)}|${c(x.color)}`);
  for (const g of f.gradients)
    parts.push(`G ${g.rect.x.toFixed(3)},${g.rect.y.toFixed(3)}|${c(g.fill.from)}->${c(g.fill.to)}`);
  for (const g of f.glows)
    parts.push(`L ${g.x.toFixed(3)},${g.y.toFixed(3)},${g.radius.toFixed(4)}|${c(g.color)}@${(g.intensity ?? 1).toFixed(3)}`);
  for (const l of f.lines)
    parts.push(`S ${l.x0.toFixed(3)},${l.y0.toFixed(3)}->${l.x1.toFixed(3)},${l.y1.toFixed(3)}|w${l.width.toFixed(4)}|${c(l.color)}`);
  return parts.join(";");
}

/** Total additive light energy emitted by glow + line draws in the last frame. */
function glowEnergy(r: RecordingRenderer): number {
  const f = r.lastFrame;
  const glow = f.glows.reduce((sum, g) => {
    const mag = g.color.r + g.color.g + g.color.b;
    return sum + mag * (g.intensity ?? 1) * Math.max(g.radius, 0);
  }, 0);
  const lines = f.lines.reduce((sum, l) => {
    const mag = l.color.r + l.color.g + l.color.b;
    return sum + mag * Math.max(l.width, 0);
  }, 0);
  return glow + lines;
}

/** Total draw activity in the last frame (gradients + glows + lines + rects). */
function drawActivity(r: RecordingRenderer): number {
  const f = r.lastFrame;
  return f.rects.length + f.gradients.length + f.glows.length + f.lines.length;
}

/** Mean dominant-hue-ish color signature of all draws (rough RGB ratios). */
function colorSignature(r: RecordingRenderer): { r: number; g: number; b: number } {
  const acc = { r: 0, g: 0, b: 0 };
  let n = 0;
  const add = (col: RgbaColor): void => {
    acc.r += col.r;
    acc.g += col.g;
    acc.b += col.b;
    n++;
  };
  for (const x of r.lastFrame.rects) add(x.color);
  for (const g of r.lastFrame.gradients) add(g.fill.to);
  for (const g of r.lastFrame.glows) add(g.color);
  for (const l of r.lastFrame.lines) add(l.color);
  if (n === 0) return { r: 0, g: 0, b: 0 };
  return { r: acc.r / n, g: acc.g / n, b: acc.b / n };
}

const PACK: ReadonlyArray<[string, PresetDefinition]> = [
  ["Particles", particlesPreset],
  ["Fluid", fluidPreset],
  ["Light 3D", light3dPreset],
];

/** With-seed factories so the determinism/reseed checks can vary the seed. */
const SEEDED: ReadonlyArray<[string, (seed: number) => PresetDefinition]> = [
  ["Particles", particlesPresetWithSeed],
  ["Fluid", fluidPresetWithSeed],
  ["Light 3D", light3dPresetWithSeed],
];

// ---------------------------------------------------------------------------
// Registry + schema
// ---------------------------------------------------------------------------

describe("particle pack — registry + param schema", () => {
  it("registers all presets into a registry under unique ids", () => {
    const registry = new PresetRegistry();
    const registered = registerParticlePresets(registry);
    expect(registered.length).toBe(3);
    for (const def of particlePresets) {
      expect(registry.has(def.id)).toBe(true);
      expect(typeof registry.create(def.id).update).toBe("function");
    }
    expect(registry.size).toBe(particlePresets.length);
  });

  it("keeps the canonical ids and names", () => {
    expect(particlesPreset.id).toBe("particle.particles");
    expect(fluidPreset.id).toBe("particle.fluid");
    expect(light3dPreset.id).toBe("particle.light-3d");
    expect(particlePresets.map((p) => p.name)).toEqual(
      expect.arrayContaining(["Particles", "Fluid", "Light 3D"]),
    );
  });

  it("each preset declares a non-empty (6+) param schema with unique keys", () => {
    for (const def of particlePresets) {
      const params = def.params ?? [];
      expect(params.length).toBeGreaterThanOrEqual(6);
      const keys = new Set(params.map((p) => p.key));
      expect(keys.size).toBe(params.length);
    }
  });

  it("names reference techniques, not people or trademarks", () => {
    for (const name of particlePresets.map((p) => p.name)) {
      expect(name).not.toMatch(/houdini|navier|stokes|unity®|unreal/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Audio reactivity + cinematic surface
// ---------------------------------------------------------------------------

describe.each(PACK)("particle pack — %s is cinematic + audio-reactive", (_name, def) => {
  it("draws a non-empty frame using additive light (glow)", () => {
    const { renderer } = drive(
      def,
      [LOUD(), LOUD({ onset: true }), LOUD(), LOUD({ onset: true }), LOUD()],
      hotDirector(),
    );
    const f = renderer.lastFrame;
    const total = f.rects.length + f.gradients.length + f.glows.length + f.lines.length;
    expect(total).toBeGreaterThan(0);
    // Cinematic: it must emit soft additive light — glow blobs.
    expect(f.glows.length).toBeGreaterThan(0);
  });

  it("sets cinematic post-FX (bloom + feedback on) when active", () => {
    const { renderer } = drive(def, [LOUD()], hotDirector());
    expect(renderer.postEffects.length).toBeGreaterThan(0);
    const last = renderer.postEffects.at(-1)!;
    expect(last.bloom?.enabled).toBe(true);
    expect(last.feedback?.enabled).toBe(true);
  });

  it("a loud frame emits MORE/brighter light than a silent frame", () => {
    const loud = drive(
      def,
      [LOUD(), LOUD({ onset: true }), LOUD(), LOUD({ onset: true }), LOUD()],
      hotDirector(),
    );
    const silent = drive(def, [SILENT(), SILENT(), SILENT(), SILENT(), SILENT()], calmDirector());
    expect(glowEnergy(loud.renderer)).toBeGreaterThan(glowEnergy(silent.renderer));
  });

  it("is deterministic given the same (features, director, time, seed)", () => {
    const seq = [LOUD(), LOUD({ onset: true }), LOUD(), LOUD({ onset: true })];
    const a = drive(def, seq, hotDirector());
    const b = drive(def, seq, hotDirector());
    expect(fingerprint(a.renderer)).toBe(fingerprint(b.renderer));
  });

  it("evolves with the director: calm-intro vs hot-drop differ materially", () => {
    const seq = [LOUD(), LOUD({ onset: true }), LOUD(), LOUD({ onset: true }), LOUD()];
    const calm = drive(def, seq, calmDirector());
    const hot = drive(def, seq, hotDirector());
    // Composition and/or light differ materially.
    expect(fingerprint(hot.renderer)).not.toBe(fingerprint(calm.renderer));
    // Both states still produce real draw activity (neither collapses to empty).
    expect(drawActivity(hot.renderer)).toBeGreaterThan(0);
    expect(drawActivity(calm.renderer)).toBeGreaterThan(0);
    // The color signature shifts (palette crossfade + hue rotation) — the core of
    // director evolution over a song.
    const sc = colorSignature(calm.renderer);
    const sh = colorSignature(hot.renderer);
    const colorDelta =
      Math.abs(sc.r - sh.r) + Math.abs(sc.g - sh.g) + Math.abs(sc.b - sh.b);
    expect(colorDelta).toBeGreaterThan(0.02);
  });

  it("a different palette/hue director state changes the color, not just brightness", () => {
    const base = hotDirector();
    const shifted: DirectorState = {
      ...base,
      paletteIndex: 7,
      prevPaletteIndex: 1,
      paletteBlend: 0.8,
      hueRotation: 0.7,
    };
    const seq = [LOUD(), LOUD({ onset: true }), LOUD(), LOUD({ onset: true }), LOUD()];
    const a = drive(def, seq, base);
    const b = drive(def, seq, shifted);
    const sa = colorSignature(a.renderer);
    const sb = colorSignature(b.renderer);
    const delta = Math.abs(sa.r - sb.r) + Math.abs(sa.g - sb.g) + Math.abs(sa.b - sb.b);
    expect(delta).toBeGreaterThan(0.02);
  });
});

// ---------------------------------------------------------------------------
// Seeded determinism + per-section reseed
// ---------------------------------------------------------------------------

describe.each(SEEDED)("particle pack — %s seeded determinism + reseed", (_name, withSeed) => {
  const seq = [LOUD(), LOUD({ onset: true }), LOUD(), LOUD()];

  it("identical seed + inputs reproduce an identical draw set across runs", () => {
    const a = drive(withSeed(1234), seq, hotDirector());
    const b = drive(withSeed(1234), seq, hotDirector());
    expect(fingerprint(a.renderer)).toBe(fingerprint(b.renderer));
  });

  it("a different base seed diverges (a different generated pattern)", () => {
    const a = drive(withSeed(1234), seq, hotDirector());
    const b = drive(withSeed(9876), seq, hotDirector());
    expect(fingerprint(a.renderer)).not.toBe(fingerprint(b.renderer));
  });

  it("changing the director's seed (a section change) changes the pattern", () => {
    // Same base seed + identical audio; only the director's per-section seed
    // differs. The per-section reseed must produce a materially different frame.
    const d1: DirectorState = { ...hotDirector(), seed: 0x11111111 };
    const d2: DirectorState = { ...hotDirector(), seed: 0x22222222 };
    const a = drive(withSeed(42), seq, d1);
    const b = drive(withSeed(42), seq, d2);
    expect(fingerprint(a.renderer)).not.toBe(fingerprint(b.renderer));
  });
});

// ---------------------------------------------------------------------------
// Performance guard — the particle count respects the hard cap
// ---------------------------------------------------------------------------

describe("particle pack — performance guard", () => {
  it("Particles never draws more glows than the hard cap, even under a beat storm", () => {
    // Drive many beats with a maxed director density so emission is maximal; the
    // live particle count (and thus glow draws) must stay within the cap.
    const seq: AudioFeatureFrame[] = [];
    for (let i = 0; i < 120; i++) seq.push(LOUD({ onset: true }));
    const dense: DirectorState = { ...hotDirector(), density: 100 };
    const { renderer } = drive(particlesPreset, seq, dense);
    expect(renderer.lastFrame.glows.length).toBeLessThanOrEqual(DEFAULT_MAX_PARTICLES);
    // …and the storm actually produced a busy field (the cap isn't trivially met).
    expect(renderer.lastFrame.glows.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Director color helper
// ---------------------------------------------------------------------------

describe("particle pack — directorColor evolves with the state", () => {
  it("a different paletteBlend yields a different color", () => {
    const d = hotDirector();
    const a = directorColor({ ...d, paletteBlend: 0 }, 0.6);
    const b = directorColor({ ...d, paletteBlend: 1 }, 0.6);
    const delta = Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
    expect(delta).toBeGreaterThan(0.01);
  });

  it("a different hueRotation yields a different color", () => {
    const d = hotDirector();
    const a = directorColor({ ...d, hueRotation: 0 }, 0.6);
    const b = directorColor({ ...d, hueRotation: 0.5 }, 0.6);
    const delta = Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
    expect(delta).toBeGreaterThan(0.01);
  });

  it("paletteForIndex wraps safely for any index", () => {
    expect(paletteForIndex(0)).toBeDefined();
    expect(paletteForIndex(-3)).toBeDefined();
    expect(paletteForIndex(999)).toBeDefined();
  });

  it("a live Director produces an evolving state that drives changing color", () => {
    const director = new Director();
    const first = directorColor(director.update(LOUD(), 1 / 60), 0.6);
    let last = first;
    for (let i = 0; i < 600; i++) last = director.update(LOUD({ onset: i % 12 === 0 }), 1 / 60);
    const lastCol = directorColor(last as DirectorState, 0.6);
    const delta =
      Math.abs(first.r - lastCol.r) + Math.abs(first.g - lastCol.g) + Math.abs(first.b - lastCol.b);
    expect(delta).toBeGreaterThan(0.005);
  });
});

// ---------------------------------------------------------------------------
// Pure helper response curves
// ---------------------------------------------------------------------------

describe("particle pack — pure helpers", () => {
  it("sectionSeed decorrelates: different director seeds → different combined seed", () => {
    expect(sectionSeed(42, 0x11111111)).not.toBe(sectionSeed(42, 0x22222222));
    // Deterministic: same inputs → same seed.
    expect(sectionSeed(42, 7)).toBe(sectionSeed(42, 7));
  });

  it("emissionCount: a beat + denser director raises emission above silence", () => {
    const silent = emissionCount(0, 0, false, 0.6, 0.6);
    const beat = emissionCount(0.8, 0.8, true, 0.6, 0.6);
    expect(beat).toBeGreaterThan(silent);
    expect(silent).toBe(0);
    // Denser director throws more on a beat.
    const sparse = emissionCount(0.8, 0.8, true, 0.6, 0.6);
    const dense = emissionCount(0.8, 0.8, true, 0.6, 1.6);
    expect(dense).toBeGreaterThan(sparse);
  });

  it("emissionSpeed: louder bass throws particles faster", () => {
    expect(emissionSpeed(0.9, 0.6)).toBeGreaterThan(emissionSpeed(0.1, 0.6));
  });

  it("fluidParams: bass raises rise; treble raises swirl", () => {
    expect(fluidParams(0.9, 0.5, 0, 0.6, 0.6).rise).toBeGreaterThan(
      fluidParams(0.1, 0.5, 0, 0.6, 0.6).rise,
    );
    expect(fluidParams(0.5, 0.9, 0, 0.6, 0.6).swirl).toBeGreaterThan(
      fluidParams(0.5, 0.1, 0, 0.6, 0.6).swirl,
    );
  });

  it("light3dParams: treble/beat/motion raise spin; bass raises the radius pulse", () => {
    const slow = light3dParams(0.5, 0.1, 0, 0.7, 0.6, 0.6).spin;
    const fast = light3dParams(0.5, 0.9, 0.8, 1.6, 0.6, 0.6).spin;
    expect(fast).toBeGreaterThan(slow);
    expect(light3dParams(0.9, 0.5, 0, 1, 0.6, 0.6).pulse).toBeGreaterThan(
      light3dParams(0.1, 0.5, 0, 1, 0.6, 0.6).pulse,
    );
  });

  it("project: a nearer point projects with a larger depth factor than a far point", () => {
    const near = project({ x: 0, y: 0, z: -1 }, 1, 0, 1, 0, 1);
    const far = project({ x: 0, y: 0, z: 1 }, 1, 0, 1, 0, 1);
    expect(near).not.toBeNull();
    expect(far).not.toBeNull();
    expect(near!.depth).toBeGreaterThan(far!.depth);
  });
});

// ---------------------------------------------------------------------------
// Per-preset beat-response specifics
// ---------------------------------------------------------------------------

describe("particle pack — beat response", () => {
  it("Particles: a beat sprays more / brighter glow than no beat", () => {
    const noBeat = drive(
      particlesPreset,
      [LOUD({ onset: false }), LOUD({ onset: false }), LOUD({ onset: false })],
      hotDirector(),
    );
    const beat = drive(
      particlesPreset,
      [LOUD({ onset: true }), LOUD({ onset: true }), LOUD({ onset: true })],
      hotDirector(),
    );
    expect(glowEnergy(beat.renderer)).toBeGreaterThan(glowEnergy(noBeat.renderer));
  });

  it("Light 3D: a beat swells the glow brighter than no beat", () => {
    const noBeat = drive(
      light3dPreset,
      [LOUD({ onset: false }), LOUD({ onset: false })],
      hotDirector(),
    );
    const beat = drive(
      light3dPreset,
      [LOUD({ onset: true }), LOUD({ onset: true })],
      hotDirector(),
    );
    expect(glowEnergy(beat.renderer)).toBeGreaterThan(glowEnergy(noBeat.renderer));
  });
});

// ---------------------------------------------------------------------------
// No Math.random / Date.now in the pack source
// ---------------------------------------------------------------------------

describe("particle pack — determinism hygiene", () => {
  it("the pack source contains no Math.random / Date.now", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      // Strip line + block comments so a doc mention ("instead of Math.random")
      // doesn't false-positive — we only care about actual calls.
      const code = readFileSync(join(dir, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(code, `${file} must not call Math.random()`).not.toMatch(/Math\s*\.\s*random/);
      expect(code, `${file} must not call Date.now()`).not.toMatch(/Date\s*\.\s*now/);
    }
  });
});
