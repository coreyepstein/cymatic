import { describe, expect, it } from "vitest";

import { BeatDetector, spectralFlux } from "./beat-detector.js";

/**
 * Build a synthetic click track as a sequence of magnitude spectra: mostly
 * low-energy "noise floor" frames with periodic broadband spikes (the clicks).
 */
function clickTrack(
  frames: number,
  binCount: number,
  period: number,
  floor = 4,
  spike = 200,
): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let f = 0; f < frames; f++) {
    const isClick = f > 0 && f % period === 0;
    const spec = new Uint8Array(binCount).fill(floor);
    if (isClick) {
      for (let i = 0; i < binCount; i++) spec[i] = spike;
    }
    out.push(spec);
  }
  return out;
}

describe("spectralFlux", () => {
  it("is 0 between identical spectra", () => {
    const a = new Uint8Array([10, 20, 30, 40]);
    expect(spectralFlux(a, Uint8Array.from(a))).toBe(0);
  });

  it("only counts positive (rising) bin differences", () => {
    const prev = new Uint8Array([0, 100, 0, 100]);
    const next = new Uint8Array([100, 0, 100, 0]);
    // Two bins rose by 100 each, normalized by 4 bins => 50.
    expect(spectralFlux(prev, next)).toBeCloseTo(50);
  });

  it("returns 0 on length mismatch or empty input", () => {
    expect(spectralFlux(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(
      0,
    );
    expect(spectralFlux(new Uint8Array(), new Uint8Array())).toBe(0);
  });
});

describe("BeatDetector", () => {
  it("flags onsets on a synthetic click track at the click frames", () => {
    const binCount = 128;
    const period = 8;
    const frames = clickTrack(48, binCount, period);
    const detector = new BeatDetector({
      sensitivity: 1.5,
      decay: 0.9,
      minFramesBetween: 3,
    });

    const onsetFrames: number[] = [];
    frames.forEach((spec, i) => {
      if (detector.process(spec)) onsetFrames.push(i);
    });

    // Every click frame (8, 16, 24, 32, 40) should be detected.
    expect(onsetFrames).toEqual([8, 16, 24, 32, 40]);
  });

  it("does not flag onsets on a steady (DC) signal", () => {
    const detector = new BeatDetector();
    const steady = new Uint8Array(64).fill(120);
    let onsets = 0;
    for (let i = 0; i < 40; i++) {
      if (detector.process(Uint8Array.from(steady))) onsets++;
    }
    expect(onsets).toBe(0);
  });

  it("respects the refractory window (minFramesBetween)", () => {
    const binCount = 64;
    // Spike on consecutive frames; only the first should register.
    const detector = new BeatDetector({ minFramesBetween: 5, sensitivity: 1.2 });
    const floor = new Uint8Array(binCount).fill(4);
    const spike = new Uint8Array(binCount).fill(200);

    const seq = [floor, floor, spike, spike, spike, floor];
    const onsetIdx: number[] = [];
    seq.forEach((s, i) => {
      if (detector.process(Uint8Array.from(s))) onsetIdx.push(i);
    });
    expect(onsetIdx).toEqual([2]);
  });

  it("higher sensitivity yields fewer onsets", () => {
    const binCount = 64;
    const frames = clickTrack(40, binCount, 6, 4, 60);

    const count = (sensitivity: number) => {
      const d = new BeatDetector({ sensitivity, minFramesBetween: 2 });
      let n = 0;
      for (const f of frames) if (d.process(Uint8Array.from(f))) n++;
      return n;
    };

    expect(count(4.0)).toBeLessThanOrEqual(count(1.2));
  });

  it("reset() clears state", () => {
    const detector = new BeatDetector();
    detector.process(new Uint8Array(8).fill(10));
    detector.reset();
    expect(detector.lastFlux).toBe(0);
    // First frame after reset never reports an onset (no previous spectrum).
    expect(detector.process(new Uint8Array(8).fill(200))).toBe(false);
  });
});
