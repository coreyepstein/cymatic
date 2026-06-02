import { describe, expect, it } from "vitest";

import { AudioAnalyser } from "./analyser.js";

/** Frequency spectrum (byte) with a single peak; flat time-domain (silence). */
function freqWithPeak(binCount: number, peakBin: number): Uint8Array {
  const spec = new Uint8Array(binCount).fill(2);
  spec[peakBin] = 255;
  return spec;
}

function silentTime(n: number): Uint8Array {
  return new Uint8Array(n).fill(128);
}

describe("AudioAnalyser.computeFrame", () => {
  it("produces a well-formed, normalized AudioFeatureFrame", () => {
    const analyser = new AudioAnalyser({ bandCount: 16, smoothing: 0 });
    const frame = analyser.computeFrame(freqWithPeak(512, 4), silentTime(1024), 1.25);

    expect(frame.bands).toHaveLength(16);
    for (const b of frame.bands) {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
    }
    expect(frame.bass).toBeGreaterThanOrEqual(0);
    expect(frame.bass).toBeLessThanOrEqual(1);
    expect(frame.rms).toBe(0); // silent time-domain
    expect(frame.time).toBe(1.25);
    expect(typeof frame.onset).toBe("boolean");
  });

  it("a low-frequency dominant peak raises bass above treble", () => {
    const analyser = new AudioAnalyser({ bandCount: 32, smoothing: 0 });
    const frame = analyser.computeFrame(freqWithPeak(1024, 4), silentTime(2048), 0);
    expect(frame.bass).toBeGreaterThan(frame.treble);
  });

  it("a high-frequency dominant peak raises treble above bass", () => {
    const analyser = new AudioAnalyser({ bandCount: 32, smoothing: 0 });
    const frame = analyser.computeFrame(
      freqWithPeak(1024, 1000),
      silentTime(2048),
      0,
    );
    expect(frame.treble).toBeGreaterThan(frame.bass);
  });

  it("smoothing causes bands to ramp toward the target over frames", () => {
    const analyser = new AudioAnalyser({ bandCount: 8, smoothing: 0.8 });
    const peak = freqWithPeak(256, 2);
    const f1 = analyser.computeFrame(peak, silentTime(512), 0);
    const f2 = analyser.computeFrame(peak, silentTime(512), 1);
    // With heavy smoothing the second frame should be closer to the steady
    // state (larger) than the first.
    expect(f2.bass).toBeGreaterThan(f1.bass);
  });

  it("read() throws before attach()", () => {
    const analyser = new AudioAnalyser();
    expect(() => analyser.read(0)).toThrow(/attach/);
  });
});
