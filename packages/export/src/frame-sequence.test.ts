import { describe, expect, it } from "vitest";

import {
  encodePng,
  FrameSequenceSink,
  type FrameSequenceTarget,
} from "./frame-sequence.js";
import type { CapturedFrame } from "./render-offline.js";

/** An in-memory {@link FrameSequenceTarget} that records every PNG written. */
function makeTarget(): FrameSequenceTarget & {
  readonly written: Array<{ index: number; filename: string; png: Uint8Array }>;
} {
  const written: Array<{ index: number; filename: string; png: Uint8Array }> = [];
  return {
    written,
    write(index: number, filename: string, png: Uint8Array): void {
      written.push({ index, filename, png: Uint8Array.from(png) });
    },
  };
}

function makeFrame(index: number, width: number, height: number): CapturedFrame {
  const pixels = new Uint8Array(width * height * 4);
  pixels.fill((index * 11) & 0xff);
  return { index, time: index / 30, width, height, pixels };
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

describe("encodePng", () => {
  it("emits a spec-valid PNG signature + IHDR + IDAT + IEND", () => {
    const png = encodePng(2, 2, new Uint8Array(2 * 2 * 4).fill(200));
    // Signature.
    expect(Array.from(png.subarray(0, 8))).toEqual(PNG_SIGNATURE);
    // First chunk type must be IHDR (bytes 12..16).
    const ihdrType = String.fromCharCode(...png.subarray(12, 16));
    expect(ihdrType).toBe("IHDR");
    // IHDR width/height.
    const dv = new DataView(png.buffer, png.byteOffset);
    expect(dv.getUint32(16)).toBe(2); // width
    expect(dv.getUint32(20)).toBe(2); // height
    // The stream must contain IDAT and end with IEND.
    const text = String.fromCharCode(...png);
    expect(text.includes("IDAT")).toBe(true);
    expect(text.endsWith("IEND" + String.fromCharCode(0xae, 0x42, 0x60, 0x82))).toBe(true);
  });

  it("is deterministic: identical RGBA in → byte-identical PNG out", () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 13) & 0xff;
    const a = encodePng(4, 4, rgba);
    const b = encodePng(4, 4, Uint8Array.from(rgba));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("rejects a pixel buffer of the wrong length", () => {
    expect(() => encodePng(2, 2, new Uint8Array(10))).toThrow(RangeError);
  });
});

describe("FrameSequenceSink", () => {
  it("writes exactly one PNG per frame with zero-padded sortable names", async () => {
    const target = makeTarget();
    const sink = new FrameSequenceSink({ target });

    for (let i = 0; i < 12; i++) {
      await sink.writeFrame(makeFrame(i, 4, 4));
    }
    sink.finish();

    expect(target.written).toHaveLength(12);
    expect(sink.written).toBe(12);
    expect(target.written[0]?.filename).toBe("frame-00000.png");
    expect(target.written[11]?.filename).toBe("frame-00011.png");
    // Every payload is a real PNG.
    for (const w of target.written) {
      expect(Array.from(w.png.subarray(0, 8))).toEqual(PNG_SIGNATURE);
    }
  });

  it("honours custom prefix + pad", async () => {
    const target = makeTarget();
    const sink = new FrameSequenceSink({ target, prefix: "f_", pad: 3 });
    await sink.writeFrame(makeFrame(7, 2, 2));
    expect(target.written[0]?.filename).toBe("f_007.png");
  });
});
