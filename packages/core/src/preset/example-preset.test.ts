import { describe, expect, it } from "vitest";

import type { AudioFeatureFrame } from "../audio/features.js";
import type {
  DrawingBufferSize,
  NormalizedRect,
  Renderer,
  RenderFeatures,
  RgbaColor,
  Scene,
} from "../render/renderer.js";
import { examplePreset, exampleBackgroundBrightness } from "./example-preset.js";
import type { PresetContext } from "./preset.js";

/**
 * A backend-free mock {@link Renderer} that records every frame's background
 * and rects. Proves a preset drives the surface without any GL/GPU — the only
 * thing the preset can do is call these methods.
 */
class MockRenderer implements Renderer {
  readonly backend = "webgl" as const;
  drawingBufferSize: DrawingBufferSize = { width: 0, height: 0 };

  /** One entry per beginFrame/endFrame pair. */
  readonly frames: Array<{ background: RgbaColor; rects: NormalizedRect[] }> = [];
  private open: { background: RgbaColor; rects: NormalizedRect[] } | null = null;

  init(): Promise<void> {
    return Promise.resolve();
  }
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.drawingBufferSize = { width: cssWidth * dpr, height: cssHeight * dpr };
  }
  render(scene: Scene, _features: RenderFeatures, _time: number): void {
    this.beginFrame(scene.background);
    this.endFrame();
  }
  beginFrame(background: RgbaColor): void {
    this.open = { background, rects: [] };
  }
  drawRect(rect: NormalizedRect): void {
    if (!this.open) throw new Error("drawRect outside frame");
    this.open.rects.push(rect);
  }
  endFrame(): void {
    if (!this.open) throw new Error("endFrame outside frame");
    this.frames.push(this.open);
    this.open = null;
  }
  dispose(): void {}

  /** The most recently completed frame. */
  get lastFrame() {
    return this.frames[this.frames.length - 1];
  }
}

function frame(overrides: Partial<AudioFeatureFrame> = {}): AudioFeatureFrame {
  return {
    bands: new Array<number>(16).fill(0),
    bass: 0,
    mid: 0,
    treble: 0,
    rms: 0,
    onset: false,
    time: 0,
    ...overrides,
  };
}

async function mount(): Promise<{ preset: ReturnType<typeof examplePreset.create>; r: MockRenderer }> {
  const r = new MockRenderer();
  const preset = examplePreset.create();
  const ctx: PresetContext = { renderer: r, width: 640, height: 480, dpr: 1 };
  await preset.init(ctx);
  return { preset, r };
}

describe("exampleBackgroundBrightness (pure response curve)", () => {
  it("rises monotonically with bass", () => {
    expect(exampleBackgroundBrightness(0.5, false)).toBeGreaterThan(
      exampleBackgroundBrightness(0.1, false),
    );
  });

  it("adds a flash on an onset", () => {
    expect(exampleBackgroundBrightness(0.2, true)).toBeGreaterThan(
      exampleBackgroundBrightness(0.2, false),
    );
  });
});

describe("examplePreset metadata", () => {
  it("is a registry-ready definition", () => {
    expect(examplePreset.id).toBe("core.example");
    expect(typeof examplePreset.create).toBe("function");
  });
});

describe("examplePreset reacts to audio through the Renderer surface", () => {
  it("opens and closes exactly one frame per update", async () => {
    const { preset, r } = await mount();
    preset.update(frame(), 0, 0.016);
    expect(r.frames).toHaveLength(1);
  });

  it("draws more (taller) bars as band energy rises", async () => {
    const { preset, r } = await mount();
    preset.update(frame({ bands: new Array<number>(16).fill(0) }), 0, 0.016);
    const quiet = r.lastFrame;
    preset.update(frame({ bands: new Array<number>(16).fill(0.8) }), 0.016, 0.016);
    const loud = r.lastFrame;

    expect(quiet?.rects.length).toBe(0); // zero-energy bars are skipped
    expect(loud?.rects.length).toBe(16);
    // Loud bars are tall.
    for (const rect of loud?.rects ?? []) {
      expect(rect.h).toBeGreaterThan(0.5);
    }
  });

  it("brightens the background when bass increases", async () => {
    const { preset, r } = await mount();
    // Drive several quiet frames, then several loud-bass frames; compare the
    // (smoothed) background brightness at the end of each run.
    for (let i = 0; i < 10; i++) preset.update(frame({ bass: 0.05 }), i * 0.016, 0.016);
    const quietBg = r.lastFrame?.background;
    for (let i = 0; i < 10; i++) preset.update(frame({ bass: 0.9 }), (10 + i) * 0.016, 0.016);
    const loudBg = r.lastFrame?.background;

    const lum = (c?: RgbaColor) => (c ? c.r + c.g + c.b : 0);
    expect(lum(loudBg)).toBeGreaterThan(lum(quietBg));
  });

  it("flashes the background brighter on an onset frame", async () => {
    const { preset, r } = await mount();
    preset.update(frame({ bass: 0.3, onset: false }), 0, 0.016);
    const noBeat = r.lastFrame?.background;
    preset.update(frame({ bass: 0.3, onset: true }), 0.016, 0.016);
    const beat = r.lastFrame?.background;
    const lum = (c?: RgbaColor) => (c ? c.r + c.g + c.b : 0);
    expect(lum(beat)).toBeGreaterThan(lum(noBeat));
  });

  it("two instances keep independent state", async () => {
    const a = examplePreset.create();
    const b = examplePreset.create();
    const ra = new MockRenderer();
    const rb = new MockRenderer();
    await a.init({ renderer: ra, width: 100, height: 100, dpr: 1 });
    await b.init({ renderer: rb, width: 100, height: 100, dpr: 1 });
    // Only drive a; b must not have rendered anything.
    a.update(frame({ bass: 0.9, bands: new Array<number>(16).fill(0.9) }), 0, 0.016);
    expect(ra.frames).toHaveLength(1);
    expect(rb.frames).toHaveLength(0);
  });
});
