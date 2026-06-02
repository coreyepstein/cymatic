import { describe, expect, it, vi } from "vitest";

import type { AudioFeatureFrame } from "../audio/features.js";
import { band, bandAt, level, mapFeature, onBeat, smoothBand } from "./bindings.js";

function frame(overrides: Partial<AudioFeatureFrame> = {}): AudioFeatureFrame {
  return {
    bands: [0.1, 0.2, 0.3, 0.4],
    bass: 0.5,
    mid: 0.3,
    treble: 0.1,
    rms: 0.4,
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
    ...overrides,
  };
}

describe("band & bandAt & level", () => {
  it("reads named band groups, clamped to [0,1]", () => {
    expect(band(frame(), "bass")).toBe(0.5);
    expect(band(frame({ mid: 2 }), "mid")).toBe(1);
    expect(band(frame({ treble: -1 }), "treble")).toBe(0);
  });

  it("reads raw bands by index and returns 0 out of range", () => {
    expect(bandAt(frame(), 0)).toBe(0.1);
    expect(bandAt(frame(), 3)).toBe(0.4);
    expect(bandAt(frame(), 99)).toBe(0);
    expect(bandAt(frame(), -1)).toBe(0);
  });

  it("level reads clamped rms", () => {
    expect(level(frame({ rms: 0.4 }))).toBe(0.4);
    expect(level(frame({ rms: 5 }))).toBe(1);
  });
});

describe("mapFeature", () => {
  it("maps a [0,1] feature onto an output range", () => {
    expect(mapFeature(0, 10, 20)).toBe(10);
    expect(mapFeature(1, 10, 20)).toBe(20);
    expect(mapFeature(0.5, 0, 100)).toBe(50);
  });

  it("honours a custom input range", () => {
    expect(mapFeature(5, 0, 100, 0, 10)).toBe(50);
  });
});

describe("onBeat", () => {
  it("invokes the callback only on an onset frame", () => {
    const cb = vi.fn();
    expect(onBeat(frame({ onset: false }), cb)).toBe(false);
    expect(cb).not.toHaveBeenCalled();
    expect(onBeat(frame({ onset: true }), cb)).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("smoothBand", () => {
  it("smooths a band toward a sustained value", () => {
    const s = smoothBand("bass", 0.5);
    let v = 0;
    for (let i = 0; i < 50; i++) v = s.push(frame({ bass: 0.8 }));
    expect(v).toBeCloseTo(0.8, 2);
  });

  it("is monotonic for a rising-then-constant signal", () => {
    const s = smoothBand("bass", 0.7);
    const a = s.push(frame({ bass: 1 }));
    const b = s.push(frame({ bass: 1 }));
    expect(b).toBeGreaterThan(a);
    expect(s.current).toBe(b);
  });
});
