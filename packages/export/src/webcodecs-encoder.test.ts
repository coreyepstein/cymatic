import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isWebCodecsAvailable,
  WebCodecsEncoderSink,
} from "./webcodecs-encoder.js";
import { FrameSequenceSink } from "./frame-sequence.js";
import { selectFrameSink } from "./index.js";

describe("isWebCodecsAvailable", () => {
  afterEach(() => {
    // Always clean up any injected globals so cases stay isolated.
    delete (globalThis as Record<string, unknown>).VideoEncoder;
    delete (globalThis as Record<string, unknown>).VideoFrame;
    vi.restoreAllMocks();
  });

  it("reports false in Node (no VideoEncoder/VideoFrame)", () => {
    expect(isWebCodecsAvailable()).toBe(false);
  });

  it("reports true once both globals are present", () => {
    (globalThis as Record<string, unknown>).VideoEncoder = class {};
    (globalThis as Record<string, unknown>).VideoFrame = class {};
    expect(isWebCodecsAvailable()).toBe(true);
  });
});

describe("selectFrameSink", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).VideoEncoder;
    delete (globalThis as Record<string, unknown>).VideoFrame;
  });

  it("selects the PNG frame sequence when WebCodecs is absent", () => {
    expect(isWebCodecsAvailable()).toBe(false);
    const selected = selectFrameSink({
      webcodecs: { width: 16, height: 16, fps: 30 },
      frameSequence: { target: { write: () => {} } },
    });
    expect(selected.kind).toBe("png-sequence");
    expect(selected.sink).toBeInstanceOf(FrameSequenceSink);
  });

  it("selects the WebCodecs encoder when VideoEncoder is available", () => {
    // Minimal fake VideoEncoder/VideoFrame so construction + configure succeed.
    const configured: unknown[] = [];
    (globalThis as Record<string, unknown>).VideoEncoder = class {
      constructor(_init: unknown) {}
      configure(c: unknown): void {
        configured.push(c);
      }
      encode(): void {}
      async flush(): Promise<void> {}
      close(): void {}
    };
    (globalThis as Record<string, unknown>).VideoFrame = class {
      close(): void {}
    };

    const selected = selectFrameSink({
      webcodecs: { width: 16, height: 16, fps: 30 },
      frameSequence: { target: { write: () => {} } },
    });
    expect(selected.kind).toBe("webcodecs");
    expect(selected.sink).toBeInstanceOf(WebCodecsEncoderSink);
    expect(configured).toHaveLength(1);
  });
});

describe("WebCodecsEncoderSink", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).VideoEncoder;
    delete (globalThis as Record<string, unknown>).VideoFrame;
  });

  it("throws in Node so callers fall back to the PNG sequence", () => {
    expect(() => new WebCodecsEncoderSink({ width: 16, height: 16, fps: 30 })).toThrow(
      /isWebCodecsAvailable/,
    );
  });

  it("drives a fake VideoEncoder end-to-end, one encode per frame", async () => {
    const encodeCalls: Array<{ keyFrame: boolean }> = [];
    let flushed = false;
    let outputCb: ((chunk: unknown, meta: unknown) => void) | null = null;

    (globalThis as Record<string, unknown>).VideoEncoder = class {
      constructor(init: { output: (chunk: unknown, meta: unknown) => void }) {
        outputCb = init.output;
      }
      configure(): void {}
      encode(_frame: unknown, opts: { keyFrame: boolean }): void {
        encodeCalls.push({ keyFrame: opts.keyFrame });
        // Simulate the encoder emitting one chunk per encode.
        outputCb?.({ byteLength: 100 }, { decoderConfig: {} });
      }
      async flush(): Promise<void> {
        flushed = true;
      }
      close(): void {}
    };
    (globalThis as Record<string, unknown>).VideoFrame = class {
      constructor(_data: unknown, _init: unknown) {}
      close(): void {}
    };

    const seen: number[] = [];
    const sink = new WebCodecsEncoderSink({
      width: 4,
      height: 4,
      fps: 30,
      onChunk: (c) => seen.push(c.index),
    });

    for (let i = 0; i < 3; i++) {
      sink.writeFrame({
        index: i,
        time: i / 30,
        width: 4,
        height: 4,
        pixels: new Uint8Array(4 * 4 * 4),
      });
    }
    await sink.finish();

    expect(encodeCalls).toHaveLength(3);
    expect(encodeCalls[0]?.keyFrame).toBe(true); // first frame keyed
    expect(encodeCalls[1]?.keyFrame).toBe(false);
    expect(sink.chunks).toHaveLength(3);
    expect(seen).toEqual([0, 1, 2]);
    expect(flushed).toBe(true);
  });
});
