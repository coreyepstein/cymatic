import { describe, expect, it } from "vitest";

import {
  bandGroups,
  clamp01,
  computeBands,
  computeRms,
  ema,
  logBandEdges,
} from "./features.js";

/**
 * Build a magnitude spectrum (Uint8, 0..255) with a single peak at `peakBin`.
 */
function spectrumWithPeak(
  binCount: number,
  peakBin: number,
  peak = 255,
  floor = 2,
): Uint8Array {
  const spec = new Uint8Array(binCount).fill(floor);
  spec[peakBin] = peak;
  return spec;
}

describe("logBandEdges", () => {
  it("returns bandCount + 1 monotonic edges within [0, binCount]", () => {
    const edges = logBandEdges(1024, 32);
    expect(edges).toHaveLength(33);
    expect(edges[0]).toBe(0);
    expect(edges[32]).toBeLessThanOrEqual(1024);
    for (let i = 1; i < edges.length; i++) {
      expect(edges[i]!).toBeGreaterThan(edges[i - 1]!);
    }
  });

  it("gives low frequencies finer (narrower) resolution than highs", () => {
    const edges = logBandEdges(1024, 16);
    const firstWidth = edges[1]! - edges[0]!;
    const lastWidth = edges[16]! - edges[15]!;
    expect(lastWidth).toBeGreaterThan(firstWidth);
  });

  it("rejects invalid inputs", () => {
    expect(() => logBandEdges(0, 8)).toThrow();
    expect(() => logBandEdges(512, 0)).toThrow();
  });
});

describe("computeBands", () => {
  it("normalizes all bands into [0, 1]", () => {
    const spec = spectrumWithPeak(1024, 500);
    const bands = computeBands(spec, 32);
    expect(bands).toHaveLength(32);
    for (const b of bands) {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
    }
  });

  it("a low-frequency sine peak lands in a low (bass) band", () => {
    // Peak near the bottom of the spectrum.
    const binCount = 1024;
    const bands = computeBands(spectrumWithPeak(binCount, 4), 32);
    const maxIdx = argMax(bands);
    expect(maxIdx).toBeLessThan(8); // among the lowest quarter of bands
  });

  it("a high-frequency sine peak lands in a high (treble) band", () => {
    const binCount = 1024;
    const bands = computeBands(spectrumWithPeak(binCount, 1000), 32);
    const maxIdx = argMax(bands);
    expect(maxIdx).toBeGreaterThan(24); // among the highest quarter of bands
  });

  it("a mid-frequency peak lands in a middle band", () => {
    const binCount = 1024;
    const bands = computeBands(spectrumWithPeak(binCount, 180), 32);
    const maxIdx = argMax(bands);
    expect(maxIdx).toBeGreaterThanOrEqual(8);
    expect(maxIdx).toBeLessThanOrEqual(24);
  });
});

describe("bandGroups", () => {
  it("routes bass/mid/treble energy to the correct group", () => {
    const n = 32;
    const bassBands = new Array<number>(n).fill(0);
    bassBands[1] = 1;
    expect(bandGroups(bassBands).bass).toBeGreaterThan(
      bandGroups(bassBands).treble,
    );

    const trebleBands = new Array<number>(n).fill(0);
    trebleBands[n - 1] = 1;
    expect(bandGroups(trebleBands).treble).toBeGreaterThan(
      bandGroups(trebleBands).bass,
    );

    const midBands = new Array<number>(n).fill(0);
    midBands[Math.floor(n / 2) - 2] = 1;
    const mid = bandGroups(midBands);
    expect(mid.mid).toBeGreaterThan(mid.bass);
    expect(mid.mid).toBeGreaterThan(mid.treble);
  });

  it("returns zeros for an empty band array", () => {
    expect(bandGroups([])).toEqual({ bass: 0, mid: 0, treble: 0 });
  });
});

describe("computeRms", () => {
  it("is 0 for silence and ~0.707 for a full-scale float sine", () => {
    const n = 2048;
    expect(computeRms(new Float32Array(n))).toBe(0);

    const sine = new Float32Array(n);
    for (let i = 0; i < n; i++) sine[i] = Math.sin((2 * Math.PI * i) / 64);
    expect(computeRms(sine)).toBeCloseTo(Math.SQRT1_2, 2);
  });

  it("rescales byte time-domain data centered at 128", () => {
    const n = 1024;
    // Constant 128 == silence after centering.
    expect(computeRms(new Uint8Array(n).fill(128))).toBe(0);

    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      bytes[i] = 128 + Math.round(127 * Math.sin((2 * Math.PI * i) / 64));
    }
    expect(computeRms(bytes)).toBeCloseTo(Math.SQRT1_2, 1);
  });

  it("clamps to [0, 1] for over-unity float input", () => {
    expect(computeRms(new Float32Array([5, -5, 5, -5]))).toBe(1);
  });
});

describe("ema", () => {
  it("returns next when smoothing is 0 and prev when smoothing is 1", () => {
    expect(ema(0.2, 0.8, 0)).toBeCloseTo(0.8);
    expect(ema(0.2, 0.8, 1)).toBeCloseTo(0.2);
  });

  it("blends proportionally", () => {
    expect(ema(0, 1, 0.5)).toBeCloseTo(0.5);
  });
});

describe("clamp01", () => {
  it("clamps and guards NaN", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});

function argMax(arr: number[]): number {
  let best = 0;
  let bestVal = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i]! > bestVal) {
      bestVal = arr[i]!;
      best = i;
    }
  }
  return best;
}
