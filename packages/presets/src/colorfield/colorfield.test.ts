/**
 * Tests for the cinematic color-field / Rothko-adjacent preset pack (V2-11).
 *
 * Every preset is driven through the public {@link Preset} lifecycle against a
 * recording mock {@link Renderer} that captures the FULL cinematic surface —
 * rects, gradient rects, glows, lines, blend modes, and post-FX — so these tests
 * prove the presets work on any backend without touching GL/GPU. We assert:
 *   - each preset registers AND declares a non-empty (6+) param schema;
 *   - a loud / high-energy frame produces MORE luminance / a wider lit field +
 *     brighter glow than a silent frame;
 *   - director evolution: two different {@link DirectorState}s (calm intro vs hot
 *     drop, different paletteBlend/hueRotation/intensity) yield materially
 *     DIFFERENT output (color and/or composition) — proving it evolves over a
 *     song;
 *   - determinism: same `(features, director, time, seed)` → identical recorded
 *     draw sequence across two runs;
 *   - smoothing: a step in bass moves the output gradually across frames (heavy
 *     smoothing damps a sudden input change — the whole point of this pack).
 */

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
  type RenderFeatures,
  type Renderer,
  type RgbaColor,
  type Scene,
} from "@cymatic/core";

import {
  bandBoundaries,
  bandResolution,
  bandsPreset,
  BeatSwell,
  colorfieldPresets,
  decaySwell,
  fieldLuminance,
  fieldPreset,
  horizonY,
  registerColorfieldPresets,
  washPreset,
} from "./index.js";
import { directorColor, paletteForIndex } from "./common.js";

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
  for (const x of f.rects)
    parts.push(`R ${x.x.toFixed(3)},${x.y.toFixed(3)},${x.w.toFixed(3)},${x.h.toFixed(3)}|${c(x.color)}`);
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

/** Mean luminance (r+g+b) across all fill draws — a proxy for "how lit". */
function meanLuminance(r: RecordingRenderer): number {
  const f = r.lastFrame;
  const acc: number[] = [];
  for (const x of f.rects) acc.push(x.color.r + x.color.g + x.color.b);
  for (const g of f.gradients) acc.push(g.fill.from.r + g.fill.from.g + g.fill.from.b);
  if (acc.length === 0) return 0;
  return acc.reduce((s, v) => s + v, 0) / acc.length;
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
  ["Field", fieldPreset],
  ["Soft Horizon", washPreset],
  ["Bands", bandsPreset],
];

// ---------------------------------------------------------------------------
// Registry + schema
// ---------------------------------------------------------------------------

describe("color-field pack — registry + param schema", () => {
  it("registers all presets into a registry under unique ids", () => {
    const registry = new PresetRegistry();
    const registered = registerColorfieldPresets(registry);
    expect(registered.length).toBeGreaterThanOrEqual(3);
    for (const def of colorfieldPresets) {
      expect(registry.has(def.id)).toBe(true);
      expect(typeof registry.create(def.id).update).toBe("function");
    }
    expect(registry.size).toBe(colorfieldPresets.length);
  });

  it("keeps the canonical ids and names", () => {
    expect(fieldPreset.id).toBe("colorfield.field");
    expect(washPreset.id).toBe("colorfield.wash");
    expect(bandsPreset.id).toBe("colorfield.bands");
    expect(colorfieldPresets.map((p) => p.name)).toEqual(
      expect.arrayContaining(["Field", "Soft Horizon", "Bands"]),
    );
  });

  it("each preset declares a non-empty (6+) param schema with unique keys", () => {
    for (const def of colorfieldPresets) {
      const params = def.params ?? [];
      expect(params.length).toBeGreaterThanOrEqual(6);
      const keys = new Set(params.map((p) => p.key));
      expect(keys.size).toBe(params.length);
    }
  });

  it("names reference technique/mood, not people or trademarks", () => {
    for (const name of colorfieldPresets.map((p) => p.name)) {
      expect(name).not.toMatch(/rothko|newman|klein|turner®/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Audio reactivity + cinematic surface
// ---------------------------------------------------------------------------

describe.each(PACK)("color-field pack — %s is cinematic + audio-reactive", (_name, def) => {
  it("draws a non-empty frame using glow (additive light)", () => {
    const { renderer } = drive(def, [LOUD()], hotDirector());
    const f = renderer.lastFrame;
    const total = f.rects.length + f.gradients.length + f.glows.length + f.lines.length;
    expect(total).toBeGreaterThan(0);
    // Cinematic: it must emit soft additive glow, not only flat fills.
    expect(f.glows.length).toBeGreaterThan(0);
  });

  it("sets cinematic post-FX (strong bloom + feedback) when active", () => {
    const { renderer } = drive(def, [LOUD()], hotDirector());
    expect(renderer.postEffects.length).toBeGreaterThan(0);
    const last = renderer.postEffects.at(-1)!;
    expect(last.bloom?.enabled).toBe(true);
    expect(last.feedback?.enabled).toBe(true);
  });

  it("a loud frame is brighter + emits MORE glow energy than a silent frame", () => {
    // Drive enough frames that the heavy smoothing has time to diverge.
    const seq = (f: AudioFeatureFrame): AudioFeatureFrame[] => new Array<AudioFeatureFrame>(60).fill(f);
    const loud = drive(def, seq(LOUD()), hotDirector());
    const silent = drive(def, seq(SILENT()), calmDirector());
    expect(meanLuminance(loud.renderer)).toBeGreaterThan(meanLuminance(silent.renderer));
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
    const colorDelta = Math.abs(sc.r - sh.r) + Math.abs(sc.g - sh.g) + Math.abs(sc.b - sh.b);
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
// Smoothing actually damps a sudden input change (the whole point of the pack)
// ---------------------------------------------------------------------------

describe.each(PACK)("color-field pack — %s smooths sudden input changes", (_name, def) => {
  it("moves gradually across frames after a step in bass, not instantly", () => {
    // Settle on silence, then step hard to loud and capture each frame's
    // luminance. Heavy smoothing → the first lit frame is far from the eventual
    // steady state, and luminance keeps climbing for several frames. We hold the
    // director fixed so ONLY the smoothed audio drives the change.
    const director = calmDirector();
    const renderer = new RecordingRenderer();
    const preset = def.create();
    void preset.init({ renderer, width: 100, height: 100, dpr: 1 });

    let t = 0;
    const step = 1 / 60;
    for (let i = 0; i < 30; i++) {
      preset.update({ ...SILENT(), time: t }, t, step, { director });
      t += step;
    }

    const lumByFrame: number[] = [];
    for (let i = 0; i < 40; i++) {
      preset.update({ ...LOUD({ onset: false }), time: t }, t, step, { director });
      t += step;
      lumByFrame.push(meanLuminance(renderer));
    }

    const first = lumByFrame[0] ?? 0;
    const settled = lumByFrame[lumByFrame.length - 1] ?? 0;
    // The field brightened over the run...
    expect(settled).toBeGreaterThan(first);
    // ...but the first post-step increment did NOT jump most of the way there.
    const climb = settled - first;
    const firstIncrement = (lumByFrame[1] ?? first) - first;
    expect(firstIncrement).toBeLessThan(climb);
    // Monotone-ish climb: a mid frame sits strictly between first and settled.
    const mid = lumByFrame[Math.floor(lumByFrame.length / 2)] ?? settled;
    expect(mid).toBeGreaterThan(first);
    expect(mid).toBeLessThan(settled);
  });
});

// ---------------------------------------------------------------------------
// Per-preset beat-response: a beat swells the field (gentle, not a hard flash)
// ---------------------------------------------------------------------------

describe.each(PACK)("color-field pack — %s swells on a beat", (_name, def) => {
  it("a beat frame emits at least as much glow as the same frame without a beat", () => {
    // Identical audio energy; only the onset flag differs. The decaying swell
    // lifts the glow, so the beat frame is brighter (never dimmer).
    const beat = drive(def, [LOUD({ onset: true })], hotDirector());
    const noBeat = drive(def, [LOUD({ onset: false })], hotDirector());
    expect(glowEnergy(beat.renderer)).toBeGreaterThan(glowEnergy(noBeat.renderer));
  });
});

// ---------------------------------------------------------------------------
// Director color helper
// ---------------------------------------------------------------------------

describe("color-field pack — directorColor evolves with the state", () => {
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
    let last: DirectorState = director.current;
    for (let i = 0; i < 600; i++) last = director.update(LOUD({ onset: i % 12 === 0 }), 1 / 60);
    const lastCol = directorColor(last, 0.6);
    const delta =
      Math.abs(first.r - lastCol.r) + Math.abs(first.g - lastCol.g) + Math.abs(first.b - lastCol.b);
    expect(delta).toBeGreaterThan(0.005);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("color-field pack — pure helpers", () => {
  it("fieldLuminance grows with bass, intensity, and an active beat swell", () => {
    expect(fieldLuminance(0.9, 0.5, 0)).toBeGreaterThan(fieldLuminance(0.1, 0.5, 0));
    expect(fieldLuminance(0.5, 0.9, 0)).toBeGreaterThan(fieldLuminance(0.5, 0.1, 0));
    expect(fieldLuminance(0.5, 0.5, 0.8)).toBeGreaterThan(fieldLuminance(0.5, 0.5, 0));
  });

  it("horizonY rises (smaller y) as energy grows", () => {
    expect(horizonY(0.9, 0.5)).toBeLessThan(horizonY(0.1, 0.5));
    expect(horizonY(0.5, 0.9)).toBeLessThan(horizonY(0.5, 0.1));
  });

  it("bandResolution snaps to more bands with density", () => {
    expect(bandResolution(1)).toBeGreaterThan(bandResolution(0));
  });

  it("bandBoundaries are monotonic, span [0,1], and grow a heavier band", () => {
    const even = bandBoundaries([0.2, 0.2, 0.2, 0.2]);
    expect(even[0]).toBe(0);
    expect(even[even.length - 1]).toBe(1);
    for (let i = 1; i < even.length; i++) {
      expect(even[i]!).toBeGreaterThanOrEqual(even[i - 1]!);
    }
    const heavy = bandBoundaries([1, 0.2, 0.2, 0.2]);
    expect(heavy[1]! - heavy[0]!).toBeGreaterThan(even[1]! - even[0]!);
  });

  it("decaySwell jumps up on an onset and decays gracefully otherwise", () => {
    const onBeat = decaySwell(0, true, 1 / 60);
    expect(onBeat).toBeGreaterThan(0.5);
    const after = decaySwell(onBeat, false, 1 / 60);
    expect(after).toBeLessThan(onBeat);
    expect(after).toBeGreaterThan(0);
  });

  it("BeatSwell envelope rises on a beat then decays over many frames", () => {
    const swell = new BeatSwell(0.6);
    const peak = swell.update(true, 1 / 60);
    expect(peak).toBeGreaterThan(0.5);
    let prev = peak;
    for (let i = 0; i < 10; i++) {
      const v = swell.update(false, 1 / 60);
      expect(v).toBeLessThan(prev);
      expect(v).toBeGreaterThan(0);
      prev = v;
    }
  });
});
