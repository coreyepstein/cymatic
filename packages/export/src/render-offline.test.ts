import { describe, expect, it } from "vitest";

import type { AudioBufferLike, AudioFeatureFrame, Preset, PresetContext } from "@cymatic/core";

import {
  frameCountFor,
  renderOffline,
  type CapturedFrame,
  type FrameSink,
  type FrameSource,
} from "./render-offline.js";

/**
 * Build a deterministic mono {@link AudioBufferLike}: a sine sweep, no Web Audio
 * context. `seconds` long at `sampleRate`.
 */
function makeBuffer(seconds: number, sampleRate = 44_100): AudioBufferLike {
  const length = Math.round(seconds * sampleRate);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    // Sweep frequency over time so successive windows differ.
    const freq = 80 + 400 * (i / Math.max(1, length));
    data[i] = 0.5 * Math.sin(2 * Math.PI * freq * t);
  }
  return {
    numberOfChannels: 1,
    length,
    sampleRate,
    getChannelData: () => data,
  };
}

/**
 * A deterministic fake {@link FrameSource}: returns a fresh RGBA buffer whose
 * bytes are a pure function of the frame index, so output is reproducible and
 * comparable across runs. Records the (index, time) pairs it was called with.
 */
function makeFrameSource(width: number, height: number): FrameSource & {
  readonly calls: Array<{ index: number; time: number }>;
} {
  const calls: Array<{ index: number; time: number }> = [];
  return {
    calls,
    capture(index: number, time: number): Uint8Array {
      calls.push({ index, time });
      const px = new Uint8Array(width * height * 4);
      // Deterministic fill keyed off the index.
      px.fill((index * 7) & 0xff);
      return px;
    },
  };
}

/** A counting {@link FrameSink} that copies and retains every frame. */
function makeCountingSink(): FrameSink & {
  readonly frames: CapturedFrame[];
  finished: boolean;
} {
  const frames: CapturedFrame[] = [];
  return {
    frames,
    finished: false,
    writeFrame(frame: CapturedFrame): void {
      // Copy pixels in case the source reuses scratch.
      frames.push({ ...frame, pixels: Uint8Array.from(frame.pixels) });
    },
    finish(): void {
      this.finished = true;
    },
  };
}

/**
 * A fake {@link Preset} that records its lifecycle calls. It also feeds the
 * features it receives into a running digest so two runs can be compared and
 * so we can assert it was driven once per frame with the right times.
 */
function makeRecordingPreset(): Preset & {
  readonly updates: Array<{ time: number; dt: number; rms: number }>;
  readonly lifecycle: string[];
} {
  const updates: Array<{ time: number; dt: number; rms: number }> = [];
  const lifecycle: string[] = [];
  return {
    updates,
    lifecycle,
    init(ctx: PresetContext): void {
      lifecycle.push(`init:${ctx.width}x${ctx.height}@${ctx.dpr}`);
    },
    resize(w: number, h: number, dpr: number): void {
      lifecycle.push(`resize:${w}x${h}@${dpr}`);
    },
    update(features: AudioFeatureFrame, time: number, dt: number): void {
      updates.push({ time, dt, rms: features.rms });
    },
    dispose(): void {
      lifecycle.push("dispose");
    },
  };
}

const WIDTH = 8;
const HEIGHT = 4;

describe("frameCountFor", () => {
  it("computes exactly N*F frames", () => {
    expect(frameCountFor(2, 30)).toBe(60);
    expect(frameCountFor(1, 60)).toBe(60);
    expect(frameCountFor(0.5, 24)).toBe(12);
    expect(frameCountFor(3, 25)).toBe(75);
  });

  it("rounds away floating-point error rather than truncating", () => {
    // 0.1 * 30 = 2.9999999999999996 in IEEE-754; must still be 3, not 2.
    expect(frameCountFor(0.1, 30)).toBe(3);
  });

  it("rejects non-positive fps and negative duration", () => {
    expect(() => frameCountFor(1, 0)).toThrow(RangeError);
    expect(() => frameCountFor(1, -30)).toThrow(RangeError);
    expect(() => frameCountFor(-1, 30)).toThrow(RangeError);
  });
});

describe("renderOffline frame-count correctness", () => {
  const cases: Array<{ duration: number; fps: number }> = [
    { duration: 2, fps: 30 },
    { duration: 1, fps: 60 },
    { duration: 0.5, fps: 24 },
    { duration: 3, fps: 25 },
  ];

  for (const { duration, fps } of cases) {
    it(`renders exactly ${duration}*${fps} = ${duration * fps} frames`, async () => {
      const expected = Math.round(duration * fps);
      const source = makeFrameSource(WIDTH, HEIGHT);
      const sink = makeCountingSink();
      const preset = makeRecordingPreset();

      const result = await renderOffline({
        preset,
        audio: makeBuffer(duration),
        config: { fps, width: WIDTH, height: HEIGHT, duration },
        frameSource: source,
        sink,
        samplerOptions: { bandCount: 8, fftSize: 512 },
      });

      expect(result.frameCount).toBe(expected);
      expect(result.features).toHaveLength(expected);
      expect(sink.frames).toHaveLength(expected);
      expect(source.calls).toHaveLength(expected);
      expect(preset.updates).toHaveLength(expected);
      expect(sink.finished).toBe(true);
    });
  }
});

describe("renderOffline sampler / clock cadence", () => {
  it("samples + updates once per frame at time index/fps in monotonic order", async () => {
    const fps = 30;
    const duration = 1;
    const source = makeFrameSource(WIDTH, HEIGHT);
    const sink = makeCountingSink();
    const preset = makeRecordingPreset();

    await renderOffline({
      preset,
      audio: makeBuffer(duration),
      config: { fps, width: WIDTH, height: HEIGHT, duration },
      frameSource: source,
      sink,
      samplerOptions: { bandCount: 8, fftSize: 512 },
    });

    const total = Math.round(duration * fps);
    for (let i = 0; i < total; i++) {
      const expectedTime = i / fps;
      // Frame source called with the exact frame time.
      expect(source.calls[i]?.index).toBe(i);
      expect(source.calls[i]?.time).toBeCloseTo(expectedTime, 10);
      // Preset.update driven with the same time + correct dt.
      expect(preset.updates[i]?.time).toBeCloseTo(expectedTime, 10);
      expect(preset.updates[i]?.dt).toBeCloseTo(i === 0 ? 0 : 1 / fps, 10);
      // Captured frame carries the matching index/time.
      expect(sink.frames[i]?.index).toBe(i);
      expect(sink.frames[i]?.time).toBeCloseTo(expectedTime, 10);
    }
  });

  it("drives the preset lifecycle in order", async () => {
    const preset = makeRecordingPreset();
    await renderOffline({
      preset,
      audio: makeBuffer(0.2),
      config: { fps: 30, width: WIDTH, height: HEIGHT, duration: 0.2 },
      frameSource: makeFrameSource(WIDTH, HEIGHT),
      sink: makeCountingSink(),
      samplerOptions: { bandCount: 8, fftSize: 512 },
    });

    expect(preset.lifecycle[0]).toBe(`init:${WIDTH}x${HEIGHT}@1`);
    expect(preset.lifecycle[1]).toBe(`resize:${WIDTH}x${HEIGHT}@1`);
    expect(preset.lifecycle.at(-1)).toBe("dispose");
  });
});

describe("renderOffline determinism", () => {
  it("produces byte-identical pixels + features across two runs", async () => {
    const fps = 30;
    const duration = 1;
    const run = async () => {
      const source = makeFrameSource(WIDTH, HEIGHT);
      const sink = makeCountingSink();
      const result = await renderOffline({
        preset: makeRecordingPreset(),
        audio: makeBuffer(duration),
        config: { fps, width: WIDTH, height: HEIGHT, duration },
        frameSource: source,
        sink,
        samplerOptions: { bandCount: 8, fftSize: 512 },
      });
      return { sink, result };
    };

    const a = await run();
    const b = await run();

    expect(a.result.frameCount).toBe(b.result.frameCount);
    expect(a.sink.frames.length).toBe(b.sink.frames.length);

    for (let i = 0; i < a.sink.frames.length; i++) {
      const fa = a.sink.frames[i]!;
      const fb = b.sink.frames[i]!;
      expect(fa.index).toBe(fb.index);
      expect(fa.time).toBe(fb.time);
      // Pixel buffers byte-identical.
      expect(Array.from(fa.pixels)).toEqual(Array.from(fb.pixels));
    }

    // Feature sequences byte-identical (rms, bands, onset all deterministic).
    expect(a.result.features).toEqual(b.result.features);
  });
});

describe("renderOffline validation", () => {
  const base = {
    preset: makeRecordingPreset(),
    audio: makeBuffer(1),
    frameSource: makeFrameSource(WIDTH, HEIGHT),
    sink: makeCountingSink(),
  };

  it("rejects a non-positive fps", async () => {
    await expect(
      renderOffline({ ...base, config: { fps: 0, width: WIDTH, height: HEIGHT, duration: 1 } }),
    ).rejects.toThrow(RangeError);
  });

  it("rejects non-integer / non-positive dimensions", async () => {
    await expect(
      renderOffline({ ...base, config: { fps: 30, width: 0, height: HEIGHT, duration: 1 } }),
    ).rejects.toThrow(RangeError);
    await expect(
      renderOffline({ ...base, config: { fps: 30, width: 8.5, height: HEIGHT, duration: 1 } }),
    ).rejects.toThrow(RangeError);
  });

  it("renders zero frames for a zero duration", async () => {
    const sink = makeCountingSink();
    const result = await renderOffline({
      preset: makeRecordingPreset(),
      audio: makeBuffer(1),
      config: { fps: 30, width: WIDTH, height: HEIGHT, duration: 0 },
      frameSource: makeFrameSource(WIDTH, HEIGHT),
      sink,
    });
    expect(result.frameCount).toBe(0);
    expect(sink.frames).toHaveLength(0);
    expect(sink.finished).toBe(true);
  });
});
