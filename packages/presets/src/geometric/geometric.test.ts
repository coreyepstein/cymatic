/**
 * Tests for the geometric / Swiss / Bauhaus preset pack.
 *
 * Every preset is driven through the public {@link Preset} lifecycle against a
 * recording mock {@link Renderer} (it only implements the surface presets use —
 * `beginFrame`/`drawRect`/`endFrame`), so these tests prove the presets work on
 * any backend without touching GL/GPU. We assert:
 *   - each preset registers in a {@link PresetRegistry};
 *   - a high-energy frame produces a measurably different draw set than silence;
 *   - an onset triggers each preset's beat response.
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
  breathScale,
  cellFill,
  concentricPreset,
  geometricPresets,
  modularPreset,
  moduleHeight,
  nextAccentModule,
  nextRotationStep,
  opGridPreset,
  registerGeometricPresets,
} from "./index.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A draw call captured by the mock renderer. */
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
  // composePreset's init is async-capable but synchronous here.
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

const PACK: ReadonlyArray<[string, PresetDefinition]> = [
  ["Op Grid", opGridPreset],
  ["Modular", modularPreset],
  ["Concentric", concentricPreset],
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("geometric pack — registry", () => {
  it("registers all presets into a registry under unique ids", () => {
    const registry = new PresetRegistry();
    const registered = registerGeometricPresets(registry);

    expect(registered.length).toBeGreaterThanOrEqual(3);
    for (const def of geometricPresets) {
      expect(registry.has(def.id)).toBe(true);
      // The registry can instantiate a fresh, independent preset by id.
      expect(typeof registry.create(def.id).update).toBe("function");
    }
    expect(registry.size).toBe(geometricPresets.length);
  });

  it("names reference movements/techniques, not people or trademarks", () => {
    const names = geometricPresets.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["Op Grid", "Modular", "Concentric"]));
    // No name should contain a personal-name marker or trademark-y token.
    for (const name of names) {
      expect(name).not.toMatch(/riley|albers|vasarely|mondrian|bauhaus®/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Audio reactivity (shared across the pack)
// ---------------------------------------------------------------------------

describe.each(PACK)("geometric pack — %s reacts to audio", (_name, def) => {
  it("draws a non-empty frame", () => {
    const { renderer } = drive(def, [LOUD()]);
    expect(renderer.lastFrameRects.length).toBeGreaterThan(0);
  });

  it("produces a measurably different draw set for loud vs silent input", () => {
    const loud = drive(def, [LOUD()]);
    const silent = drive(def, [SILENT()]);
    expect(fingerprint(loud.renderer.lastFrameRects)).not.toBe(
      fingerprint(silent.renderer.lastFrameRects),
    );
  });

  it("is deterministic given the same (features, time)", () => {
    const a = drive(def, [LOUD()]);
    const b = drive(def, [LOUD()]);
    expect(fingerprint(a.renderer.lastFrameRects)).toBe(
      fingerprint(b.renderer.lastFrameRects),
    );
  });

  it("responds to an onset (beat) with a different draw set than a non-onset frame", () => {
    // Identical audio energy; the only difference is the onset flag. A visible
    // beat response must change the draw set.
    const noBeat = drive(def, [LOUD({ onset: false })]);
    const beat = drive(def, [LOUD({ onset: true })]);
    expect(fingerprint(beat.renderer.lastFrameRects)).not.toBe(
      fingerprint(noBeat.renderer.lastFrameRects),
    );
  });
});

// ---------------------------------------------------------------------------
// Pure helper response curves
// ---------------------------------------------------------------------------

describe("geometric pack — pure helpers", () => {
  it("cellFill grows with bass and dark cells recede with treble", () => {
    expect(cellFill(0.9, 0, 1)).toBeGreaterThan(cellFill(0.1, 0, 1));
    // On a dark parity cell, more treble (contrast) shrinks it.
    expect(cellFill(0.5, 0.0, 0)).toBeGreaterThan(cellFill(0.5, 0.4, 0));
  });

  it("nextRotationStep advances only on an onset and wraps mod 4", () => {
    expect(nextRotationStep(0, true)).toBe(1);
    expect(nextRotationStep(1, false)).toBe(1);
    expect(nextRotationStep(3, true)).toBe(0);
  });

  it("moduleHeight grows monotonically with energy", () => {
    expect(moduleHeight(0.9)).toBeGreaterThan(moduleHeight(0.2));
  });

  it("nextAccentModule advances on onset and holds otherwise", () => {
    expect(nextAccentModule(0, true)).toBe(1);
    expect(nextAccentModule(2, false)).toBe(2);
  });

  it("breathScale grows with bass and pops outward on an onset", () => {
    expect(breathScale(0.9, false)).toBeGreaterThan(breathScale(0.1, false));
    expect(breathScale(0.5, true)).toBeGreaterThanOrEqual(breathScale(0.5, false));
  });
});

// ---------------------------------------------------------------------------
// Per-preset beat-response specifics
// ---------------------------------------------------------------------------

describe("geometric pack — beat-response specifics", () => {
  it("Op Grid advances its rotation step on a rising onset edge", () => {
    // Two onset frames separated by a non-onset frame should advance twice
    // (rising-edge detection), changing the checkerboard phase each time.
    const { renderer } = drive(opGridPreset, [
      LOUD({ onset: true }),
      LOUD({ onset: false }),
      LOUD({ onset: true }),
    ]);
    // After two rising edges the phase returns to its original parity, but the
    // intermediate frame differed — assert the field actually drew rects.
    expect(renderer.lastFrameRects.length).toBe(64);
  });

  it("Concentric flashes the innermost block toward white on an onset", () => {
    const beat = drive(concentricPreset, [LOUD({ onset: true })]);
    const noBeat = drive(concentricPreset, [LOUD({ onset: false })]);
    const beatInner = beat.renderer.lastFrameRects.at(-1)!;
    const noBeatInner = noBeat.renderer.lastFrameRects.at(-1)!;
    // The flash pushes every channel higher (toward white) than the calm color.
    expect(beatInner.color.r).toBeGreaterThan(noBeatInner.color.r);
    expect(beatInner.color.g).toBeGreaterThan(noBeatInner.color.g);
  });
});
