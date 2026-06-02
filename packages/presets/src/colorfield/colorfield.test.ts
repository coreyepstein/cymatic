/**
 * Tests for the color-field / Rothko-adjacent preset pack.
 *
 * Every preset is driven through the public {@link Preset} lifecycle against a
 * recording mock {@link Renderer} (it only implements the surface presets use —
 * `beginFrame`/`drawRect`/`endFrame`), so these tests prove the presets work on
 * any backend without touching GL/GPU. We assert:
 *   - each preset registers in a {@link PresetRegistry};
 *   - a high-energy frame produces a measurably different draw set than silence;
 *   - the presets are deterministic given (features, time);
 *   - heavy smoothing actually *damps* a sudden input step — a jump in bass
 *     moves the output gradually across frames rather than instantly;
 *   - the beat swell rises on an onset and decays gracefully (never snaps).
 */

import { describe, expect, it } from "vitest";

import {
  PresetRegistry,
  type AudioFeatureFrame,
  type NormalizedRect,
  type Preset,
  type PresetDefinition,
  type Renderer,
  type RgbaColor,
  type Scene,
  type RenderFeatures,
  type DrawingBufferSize,
} from "@cymatic/core";

import {
  bandBoundaries,
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

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type CapturedRect = NormalizedRect;

/**
 * A minimal in-memory renderer that records the rects drawn per frame. It honors
 * the begin/draw/end discipline so misuse (drawing outside a frame) is caught.
 */
class RecordingRenderer implements Renderer {
  readonly backend = "webgl" as const;
  readonly drawingBufferSize: DrawingBufferSize = { width: 100, height: 100 };

  backgrounds: RgbaColor[] = [];
  /** Rects of the most recently completed frame. */
  lastFrameRects: CapturedRect[] = [];
  private current: CapturedRect[] | null = null;

  init(): Promise<void> {
    return Promise.resolve();
  }
  resize(): void {}
  render(_scene: Scene, _features: RenderFeatures, _time: number): void {}

  beginFrame(background: RgbaColor): void {
    this.backgrounds.push({ ...background });
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
    bands: new Array<number>(16).fill(over.rms ?? 0),
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

/** Run a preset against a fresh renderer and return both for inspection. */
function drive(
  def: PresetDefinition,
  frames: AudioFeatureFrame[],
): { renderer: RecordingRenderer; preset: Preset } {
  const renderer = new RecordingRenderer();
  const preset = def.create();
  void preset.init({ renderer, width: 100, height: 100, dpr: 1 });
  let t = 0;
  for (const f of frames) {
    preset.update({ ...f, time: t }, t, 1 / 60);
    t += 1 / 60;
  }
  return { renderer, preset };
}

/** A stable fingerprint of a frame's draw set, rounded to avoid float noise. */
function fingerprint(rects: CapturedRect[]): string {
  return rects
    .map(
      (r) =>
        `${r.x.toFixed(3)},${r.y.toFixed(3)},${r.w.toFixed(3)},${r.h.toFixed(3)}|` +
        `${r.color.r.toFixed(3)},${r.color.g.toFixed(3)},${r.color.b.toFixed(3)}`,
    )
    .join(";");
}

/** Mean luminance (r+g+b) across a frame's rects — a proxy for "how lit". */
function meanLuminance(rects: CapturedRect[]): number {
  if (rects.length === 0) return 0;
  let sum = 0;
  for (const r of rects) sum += r.color.r + r.color.g + r.color.b;
  return sum / rects.length;
}

const PACK: ReadonlyArray<[string, PresetDefinition]> = [
  ["Field", fieldPreset],
  ["Soft Horizon", washPreset],
  ["Bands", bandsPreset],
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("color-field pack — registry", () => {
  it("registers at least three presets into a registry under unique ids", () => {
    const registry = new PresetRegistry();
    const registered = registerColorfieldPresets(registry);

    expect(registered.length).toBeGreaterThanOrEqual(3);
    for (const def of colorfieldPresets) {
      expect(registry.has(def.id)).toBe(true);
      expect(typeof registry.create(def.id).update).toBe("function");
    }
    expect(registry.size).toBe(colorfieldPresets.length);
  });

  it("names reference technique/mood, not people or trademarks", () => {
    const names = colorfieldPresets.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["Field", "Soft Horizon", "Bands"]));
    for (const name of names) {
      // No living-artist / trademark markers.
      expect(name).not.toMatch(/rothko|newman|klein|turner®/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Audio reactivity (shared across the pack)
// ---------------------------------------------------------------------------

describe.each(PACK)("color-field pack — %s reacts to audio", (_name, def) => {
  it("draws a non-empty frame", () => {
    const { renderer } = drive(def, [LOUD()]);
    expect(renderer.lastFrameRects.length).toBeGreaterThan(0);
  });

  it("produces a measurably different draw set for loud vs silent input", () => {
    // Drive enough frames that the heavy smoothing has time to diverge.
    const frames = (f: AudioFeatureFrame): AudioFeatureFrame[] =>
      new Array<AudioFeatureFrame>(60).fill(f);
    const loud = drive(def, frames(LOUD()));
    const silent = drive(def, frames(SILENT()));
    expect(fingerprint(loud.renderer.lastFrameRects)).not.toBe(
      fingerprint(silent.renderer.lastFrameRects),
    );
    // And the loud field is meaningfully brighter than silence.
    expect(meanLuminance(loud.renderer.lastFrameRects)).toBeGreaterThan(
      meanLuminance(silent.renderer.lastFrameRects),
    );
  });

  it("is deterministic given the same (features, time)", () => {
    const seq = new Array<AudioFeatureFrame>(30).fill(LOUD());
    const a = drive(def, seq);
    const b = drive(def, seq);
    expect(fingerprint(a.renderer.lastFrameRects)).toBe(
      fingerprint(b.renderer.lastFrameRects),
    );
  });
});

// ---------------------------------------------------------------------------
// Smoothing actually damps a sudden input change (the whole point of the pack)
// ---------------------------------------------------------------------------

describe.each(PACK)("color-field pack — %s smooths sudden input changes", (_name, def) => {
  it("moves gradually across frames after a step in bass, not instantly", () => {
    // Settle on silence, then step hard to loud and capture each frame's
    // luminance. Heavy smoothing → the first lit frame is far from the
    // eventual steady state, and luminance keeps climbing for several frames.
    const renderer = new RecordingRenderer();
    const preset = def.create();
    void preset.init({ renderer, width: 100, height: 100, dpr: 1 });

    let t = 0;
    const step = 1 / 60;
    // Warm up on silence so smoothers sit near 0.
    for (let i = 0; i < 30; i++) {
      preset.update({ ...SILENT(), time: t }, t, step);
      t += step;
    }

    // Now apply a hard step to loud and record the per-frame luminance.
    const lumByFrame: number[] = [];
    for (let i = 0; i < 30; i++) {
      preset.update({ ...LOUD(), time: t }, t, step);
      t += step;
      lumByFrame.push(meanLuminance(renderer.lastFrameRects));
    }

    const first = lumByFrame[0] ?? 0;
    const settled = lumByFrame[lumByFrame.length - 1] ?? 0;
    // The field brightened over the run...
    expect(settled).toBeGreaterThan(first);
    // ...but the first post-step frame did NOT jump most of the way there:
    // gradual response means a single frame never snaps to the steady state.
    const climb = settled - first;
    // The increment between consecutive early frames is small relative to the
    // total climb — i.e. no single frame snaps to the steady state.
    const firstIncrement = (lumByFrame[1] ?? first) - first;
    expect(firstIncrement).toBeLessThan(climb);
    // Monotone-ish climb: a mid frame sits strictly between first and settled.
    const mid = lumByFrame[Math.floor(lumByFrame.length / 2)] ?? settled;
    expect(mid).toBeGreaterThan(first);
    expect(mid).toBeLessThan(settled);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("color-field pack — pure helpers", () => {
  it("fieldLuminance grows with bass and with an active beat swell", () => {
    expect(fieldLuminance(0.9, 0)).toBeGreaterThan(fieldLuminance(0.1, 0));
    expect(fieldLuminance(0.5, 0.8)).toBeGreaterThan(fieldLuminance(0.5, 0));
  });

  it("horizonY rises (smaller y) as bass grows", () => {
    expect(horizonY(0.9)).toBeLessThan(horizonY(0.1));
  });

  it("bandBoundaries are monotonic, span [0,1], and grow a heavier band", () => {
    const even = bandBoundaries([0.2, 0.2, 0.2, 0.2]);
    expect(even[0]).toBe(0);
    expect(even[even.length - 1]).toBe(1);
    for (let i = 1; i < even.length; i++) {
      expect(even[i]!).toBeGreaterThanOrEqual(even[i - 1]!);
    }
    // Pushing weight onto band 0 grows its region vs the even split.
    const heavy = bandBoundaries([1, 0.2, 0.2, 0.2]);
    expect(heavy[1]! - heavy[0]!).toBeGreaterThan(even[1]! - even[0]!);
  });

  it("decaySwell jumps up on an onset and decays gracefully otherwise", () => {
    const onBeat = decaySwell(0, true, 1 / 60);
    expect(onBeat).toBeGreaterThan(0.5);
    // Without a beat it decays toward zero but never snaps to it in one frame.
    const after = decaySwell(onBeat, false, 1 / 60);
    expect(after).toBeLessThan(onBeat);
    expect(after).toBeGreaterThan(0);
  });

  it("BeatSwell envelope rises on a beat then decays over many frames", () => {
    const swell = new BeatSwell(0.6);
    const peak = swell.update(true, 1 / 60);
    expect(peak).toBeGreaterThan(0.5);
    let prev = peak;
    // Several quiet frames: strictly decreasing, still positive.
    for (let i = 0; i < 10; i++) {
      const v = swell.update(false, 1 / 60);
      expect(v).toBeLessThan(prev);
      expect(v).toBeGreaterThan(0);
      prev = v;
    }
  });
});

// ---------------------------------------------------------------------------
// Per-preset beat-response: a beat brightens the field (gentle swell)
// ---------------------------------------------------------------------------

describe.each(PACK)("color-field pack — %s swells on a beat", (_name, def) => {
  it("a beat frame is at least as bright as the same frame without a beat", () => {
    // Identical audio energy; only the onset flag differs. The decaying swell
    // lifts luminance, so the beat frame is brighter (never dimmer).
    const beat = drive(def, [LOUD({ onset: true })]);
    const noBeat = drive(def, [LOUD({ onset: false })]);
    expect(meanLuminance(beat.renderer.lastFrameRects)).toBeGreaterThan(
      meanLuminance(noBeat.renderer.lastFrameRects),
    );
  });
});
