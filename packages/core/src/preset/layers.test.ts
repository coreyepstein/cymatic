import { describe, expect, it, vi } from "vitest";

import type { AudioFeatureFrame } from "../audio/features.js";
import type {
  DrawingBufferSize,
  NormalizedRect,
  Renderer,
  RenderFeatures,
  RgbaColor,
  Scene,
} from "../render/renderer.js";
import { composePreset, LayerStack, type Layer, type LayerFrame } from "./layers.js";
import type { PresetContext } from "./preset.js";

class MockRenderer implements Renderer {
  readonly backend = "webgl" as const;
  drawingBufferSize: DrawingBufferSize = { width: 0, height: 0 };
  readonly frames: Array<{ background: RgbaColor; rects: NormalizedRect[] }> = [];
  private open: { background: RgbaColor; rects: NormalizedRect[] } | null = null;
  init(): Promise<void> {
    return Promise.resolve();
  }
  resize(): void {}
  render(s: Scene, _f: RenderFeatures, _t: number): void {
    this.beginFrame(s.background);
    this.endFrame();
  }
  beginFrame(background: RgbaColor): void {
    this.open = { background, rects: [] };
  }
  drawRect(rect: NormalizedRect): void {
    this.open?.rects.push(rect);
  }
  endFrame(): void {
    if (this.open) this.frames.push(this.open);
    this.open = null;
  }
  dispose(): void {}
}

function frame(): AudioFeatureFrame {
  return {
    bands: [],
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
  };
}

describe("LayerStack", () => {
  it("drives init/resize/draw/dispose across layers in order", async () => {
    const calls: string[] = [];
    const make = (id: string): Layer => ({
      id,
      init: () => {
        calls.push(`init:${id}`);
      },
      resize: () => {
        calls.push(`resize:${id}`);
      },
      draw: () => {
        calls.push(`draw:${id}`);
      },
      dispose: () => {
        calls.push(`dispose:${id}`);
      },
    });
    const stack = new LayerStack([make("a")]);
    stack.add(make("b"));
    expect(stack.size).toBe(2);

    const r = new MockRenderer();
    const ctx: PresetContext = { renderer: r, width: 1, height: 1, dpr: 1 };
    await stack.init(ctx);
    stack.resize({ width: 2, height: 2, dpr: 1 });
    stack.draw({ renderer: r, features: frame(), time: 0, dt: 0, width: 2, height: 2 });
    stack.dispose();

    expect(calls).toEqual([
      "init:a",
      "init:b",
      "resize:a",
      "resize:b",
      "draw:a",
      "draw:b",
      // dispose runs in reverse order.
      "dispose:b",
      "dispose:a",
    ]);
  });

  it("treats init/resize/dispose as optional", async () => {
    const draw = vi.fn();
    const stack = new LayerStack([{ id: "min", draw }]);
    const r = new MockRenderer();
    await stack.init({ renderer: r, width: 1, height: 1, dpr: 1 });
    stack.resize({ width: 1, height: 1, dpr: 1 });
    stack.draw({ renderer: r, features: frame(), time: 0, dt: 0, width: 1, height: 1 });
    stack.dispose();
    expect(draw).toHaveBeenCalledTimes(1);
  });
});

describe("composePreset", () => {
  it("opens/closes the frame around layers when a background is given", async () => {
    const r = new MockRenderer();
    const def = composePreset({
      id: "compose.bg",
      name: "bg",
      background: () => ({ r: 0.1, g: 0.2, b: 0.3, a: 1 }),
      layers: [
        {
          id: "rect",
          draw: ({ renderer }: LayerFrame) =>
            renderer.drawRect({ x: 0, y: 0, w: 0.5, h: 0.5, color: { r: 1, g: 0, b: 0, a: 1 } }),
        },
      ],
    });
    const preset = def.create();
    await preset.init({ renderer: r, width: 10, height: 10, dpr: 1 });
    preset.update(frame(), 0, 0.016);

    expect(r.frames).toHaveLength(1);
    expect(r.frames[0]?.background).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
    expect(r.frames[0]?.rects).toHaveLength(1);
  });

  it("lets layers manage the frame themselves when no background is given", async () => {
    const r = new MockRenderer();
    const def = composePreset({
      id: "compose.self",
      name: "self",
      layers: [
        {
          id: "self",
          draw: ({ renderer }: LayerFrame) => {
            renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
            renderer.endFrame();
          },
        },
      ],
    });
    const preset = def.create();
    await preset.init({ renderer: r, width: 10, height: 10, dpr: 1 });
    preset.update(frame(), 0, 0.016);
    expect(r.frames).toHaveLength(1);
  });

  it("builds fresh layers per create() when given a factory", async () => {
    const made: string[] = [];
    let n = 0;
    const def = composePreset({
      id: "compose.factory",
      name: "factory",
      layers: () => {
        const id = `layer-${n++}`;
        made.push(id);
        return [{ id, draw: () => {} }];
      },
    });
    def.create();
    def.create();
    expect(made).toEqual(["layer-0", "layer-1"]);
  });

  it("throws if update() runs before init()", () => {
    const def = composePreset({ id: "compose.early", name: "early", layers: [] });
    const preset = def.create();
    expect(() => preset.update(frame(), 0, 0)).toThrow(/before init/);
  });
});
