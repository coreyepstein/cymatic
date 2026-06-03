/**
 * Tests for the cinematic geometric / Swiss / Bauhaus preset pack (V2-10).
 *
 * Every preset is driven through the public {@link Preset} lifecycle against a
 * recording mock {@link Renderer} that captures the FULL cinematic surface —
 * rects, gradient rects, glows, lines, blend modes, and post-FX — so these tests
 * prove the presets work on any backend without touching GL/GPU. We assert:
 *   - each preset registers AND declares a non-empty param schema;
 *   - a loud / high-energy frame produces MORE / brighter draw activity (more
 *     glow draws and higher color magnitude) than a silent frame;
 *   - director evolution: two different {@link DirectorState}s (calm intro vs hot
 *     drop, different paletteBlend/hueRotation) yield materially DIFFERENT output
 *     (color and/or composition) — proving it evolves over a song;
 *   - determinism: same `(features, director, time, seed)` → identical recorded
 *     draw sequence across two runs.
 */

import { describe, expect, it } from "vitest";

import {
  Director,
  PresetRegistry,
  restingDirectorState,
  type AudioFeatureFrame,
  type DirectorState,
  type GlowSpec,
  type GradientFill,
  type LineSpec,
  type NormalizedRect,
  type PostEffectsConfig,
  type Preset,
  type PresetDefinition,
  type Renderer,
  type RgbaColor,
  type Scene,
  type RenderFeatures,
  type DrawingBufferSize,
  type BlendMode,
} from "@cymatic/core";

import {
  breathScale,
  cellFill,
  concentricPreset,
  directorColor,
  geometricPresets,
  gridResolution,
  moduleHeight,
  modularPreset,
  moduleResolution,
  nextAccentModule,
  nextRotationStep,
  opGridPreset,
  paletteForIndex,
  registerGeometricPresets,
  ringResolution,
  stepFlash,
} from "./index.js";

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

/** Total additive light energy emitted by glow draws in the last frame. */
function glowEnergy(r: RecordingRenderer): number {
  return r.lastFrame.glows.reduce((sum, g) => {
    const col = g.color;
    const mag = col.r + col.g + col.b;
    return sum + mag * (g.intensity ?? 1) * Math.max(g.radius, 0);
  }, 0);
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
  ["Op Grid", opGridPreset],
  ["Modular", modularPreset],
  ["Concentric", concentricPreset],
];

// ---------------------------------------------------------------------------
// Registry + schema
// ---------------------------------------------------------------------------

describe("geometric pack — registry + param schema", () => {
  it("registers all presets into a registry under unique ids", () => {
    const registry = new PresetRegistry();
    const registered = registerGeometricPresets(registry);
    expect(registered.length).toBeGreaterThanOrEqual(3);
    for (const def of geometricPresets) {
      expect(registry.has(def.id)).toBe(true);
      expect(typeof registry.create(def.id).update).toBe("function");
    }
    expect(registry.size).toBe(geometricPresets.length);
  });

  it("keeps the canonical ids and names", () => {
    expect(opGridPreset.id).toBe("geometric.op-grid");
    expect(modularPreset.id).toBe("geometric.modular");
    expect(concentricPreset.id).toBe("geometric.concentric");
    expect(geometricPresets.map((p) => p.name)).toEqual(
      expect.arrayContaining(["Op Grid", "Modular", "Concentric"]),
    );
  });

  it("each preset declares a non-empty (6+) param schema with unique keys", () => {
    for (const def of geometricPresets) {
      const params = def.params ?? [];
      expect(params.length).toBeGreaterThanOrEqual(6);
      const keys = new Set(params.map((p) => p.key));
      expect(keys.size).toBe(params.length);
    }
  });

  it("names reference movements/techniques, not people or trademarks", () => {
    for (const name of geometricPresets.map((p) => p.name)) {
      expect(name).not.toMatch(/riley|albers|vasarely|mondrian|bauhaus®/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Audio reactivity + cinematic surface
// ---------------------------------------------------------------------------

describe.each(PACK)("geometric pack — %s is cinematic + audio-reactive", (_name, def) => {
  it("draws a non-empty frame using glow (additive light)", () => {
    const { renderer } = drive(def, [LOUD()], hotDirector());
    const f = renderer.lastFrame;
    const total = f.rects.length + f.gradients.length + f.glows.length + f.lines.length;
    expect(total).toBeGreaterThan(0);
    // Cinematic: it must emit soft additive glow, not only flat rects.
    expect(f.glows.length).toBeGreaterThan(0);
  });

  it("sets cinematic post-FX (bloom on) when active", () => {
    const { renderer } = drive(def, [LOUD()], hotDirector());
    expect(renderer.postEffects.length).toBeGreaterThan(0);
    const last = renderer.postEffects.at(-1)!;
    expect(last.bloom?.enabled).toBe(true);
  });

  it("a loud frame emits MORE/brighter glow energy than a silent frame", () => {
    const loud = drive(def, [LOUD()], hotDirector());
    const silent = drive(def, [SILENT()], calmDirector());
    expect(glowEnergy(loud.renderer)).toBeGreaterThan(glowEnergy(silent.renderer));
  });

  it("is deterministic given the same (features, director, time, seed)", () => {
    const a = drive(def, [LOUD(), LOUD({ onset: true }), LOUD()], hotDirector());
    const b = drive(def, [LOUD(), LOUD({ onset: true }), LOUD()], hotDirector());
    expect(fingerprint(a.renderer)).toBe(fingerprint(b.renderer));
  });

  it("evolves with the director: calm-intro vs hot-drop differ materially", () => {
    // Identical audio; only the director state differs (intensity/motion/density,
    // palette crossfade, hue rotation). The output must change materially.
    const calm = drive(def, [LOUD()], calmDirector());
    const hot = drive(def, [LOUD()], hotDirector());
    // Composition and/or light differ.
    expect(fingerprint(hot.renderer)).not.toBe(fingerprint(calm.renderer));
    // Specifically: the hot drop is brighter (more glow energy).
    expect(glowEnergy(hot.renderer)).toBeGreaterThan(glowEnergy(calm.renderer));
    // And the color signature shifts (palette crossfade + hue rotation).
    const sc = colorSignature(calm.renderer);
    const sh = colorSignature(hot.renderer);
    const colorDelta =
      Math.abs(sc.r - sh.r) + Math.abs(sc.g - sh.g) + Math.abs(sc.b - sh.b);
    expect(colorDelta).toBeGreaterThan(0.02);
  });

  it("a different palette/hue director state changes the color, not just brightness", () => {
    // Two director states with the SAME intensity/motion/density but different
    // palette crossfade + hue — isolating color evolution.
    const base = hotDirector();
    const shifted: DirectorState = {
      ...base,
      paletteIndex: 7,
      prevPaletteIndex: 1,
      paletteBlend: 0.8,
      hueRotation: 0.7,
    };
    const a = drive(def, [LOUD()], base);
    const b = drive(def, [LOUD()], shifted);
    const sa = colorSignature(a.renderer);
    const sb = colorSignature(b.renderer);
    const delta = Math.abs(sa.r - sb.r) + Math.abs(sa.g - sb.g) + Math.abs(sa.b - sb.b);
    expect(delta).toBeGreaterThan(0.02);
  });
});

// ---------------------------------------------------------------------------
// Director color helper
// ---------------------------------------------------------------------------

describe("geometric pack — directorColor evolves with the state", () => {
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
    // Smoke: a real director advanced over loud frames changes its emitted color.
    const director = new Director();
    const first = directorColor(director.update(LOUD(), 1 / 60), 0.6);
    let last = first;
    for (let i = 0; i < 600; i++) last = director.update(LOUD({ onset: i % 12 === 0 }), 1 / 60);
    const lastCol = directorColor(last as DirectorState, 0.6);
    // Over ~10s of loud audio the hue/palette has advanced.
    const delta =
      Math.abs(first.r - lastCol.r) + Math.abs(first.g - lastCol.g) + Math.abs(first.b - lastCol.b);
    expect(delta).toBeGreaterThan(0.005);
  });
});

// ---------------------------------------------------------------------------
// Pure helper response curves
// ---------------------------------------------------------------------------

describe("geometric pack — pure helpers", () => {
  it("cellFill grows with energy/intensity and dark cells recede with contrast", () => {
    expect(cellFill(0.9, 0.9, 0, 1)).toBeGreaterThan(cellFill(0.1, 0.1, 0, 1));
    expect(cellFill(0.5, 0.5, 0.0, 0)).toBeGreaterThan(cellFill(0.5, 0.5, 0.5, 0));
  });

  it("gridResolution / moduleResolution / ringResolution snap to a finer grid with density", () => {
    expect(gridResolution(1)).toBeGreaterThan(gridResolution(0));
    expect(moduleResolution(1)).toBeGreaterThan(moduleResolution(0));
    expect(ringResolution(1)).toBeGreaterThan(ringResolution(0));
  });

  it("nextRotationStep advances only on an onset and wraps mod 4", () => {
    expect(nextRotationStep(0, true)).toBe(1);
    expect(nextRotationStep(1, false)).toBe(1);
    expect(nextRotationStep(3, true)).toBe(0);
  });

  it("moduleHeight grows monotonically with energy and drive", () => {
    expect(moduleHeight(0.9, 1)).toBeGreaterThan(moduleHeight(0.2, 1));
    expect(moduleHeight(0.6, 1)).toBeGreaterThan(moduleHeight(0.6, 0));
  });

  it("nextAccentModule advances on onset and holds otherwise", () => {
    expect(nextAccentModule(0, 6, true)).toBe(1);
    expect(nextAccentModule(2, 6, false)).toBe(2);
    expect(nextAccentModule(5, 6, true)).toBe(0);
  });

  it("breathScale grows with bass/motion and pops outward on an onset", () => {
    expect(breathScale(0.9, 0.6, 1, false)).toBeGreaterThan(breathScale(0.1, 0.6, 1, false));
    expect(breathScale(0.5, 0.6, 1, true)).toBeGreaterThanOrEqual(breathScale(0.5, 0.6, 1, false));
  });

  it("stepFlash rises on a beat and decays gracefully (never snaps to 0)", () => {
    const lit = stepFlash(0, true, 1 / 60);
    expect(lit).toBeGreaterThan(0.5);
    const decayed = stepFlash(lit, false, 1 / 60);
    expect(decayed).toBeLessThan(lit);
    expect(decayed).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Per-preset beat-response specifics
// ---------------------------------------------------------------------------

describe("geometric pack — beat response", () => {
  it("Op Grid: an onset frame differs from a non-onset frame", () => {
    const noBeat = drive(opGridPreset, [LOUD({ onset: false })], hotDirector());
    const beat = drive(opGridPreset, [LOUD({ onset: true })], hotDirector());
    expect(fingerprint(beat.renderer)).not.toBe(fingerprint(noBeat.renderer));
  });

  it("Concentric: the core glow is brighter on a beat", () => {
    const noBeat = drive(concentricPreset, [LOUD({ onset: false })], hotDirector());
    const beat = drive(concentricPreset, [LOUD({ onset: true })], hotDirector());
    expect(glowEnergy(beat.renderer)).toBeGreaterThan(glowEnergy(noBeat.renderer));
  });

  it("Modular: an onset moves the accent column, changing the draw set", () => {
    const noBeat = drive(modularPreset, [LOUD({ onset: false })], hotDirector());
    const beat = drive(modularPreset, [LOUD({ onset: true })], hotDirector());
    expect(fingerprint(beat.renderer)).not.toBe(fingerprint(noBeat.renderer));
  });
});
