import { describe, expect, it } from "vitest";

import { ZERO_MOOD, computeMood, type MoodVector } from "./mood.js";
import type { AudioFeatureFrame } from "./features.js";

/**
 * Build a feature frame with sensible defaults, overriding only the fields a
 * test cares about. Mood ignores most fields (bands/tempo/etc.) so they stay at
 * neutral values.
 */
function frame(overrides: Partial<AudioFeatureFrame> = {}): AudioFeatureFrame {
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
    mood: ZERO_MOOD,
    time: 0,
    ...overrides,
  };
}

const HOT = frame({
  loudnessLong: 1,
  loudnessShort: 1,
  spectralCentroid: 1,
  spectralRolloff: 1,
  spectralFlux: 1,
  onsetDensity: 10,
  dynamics: 1,
});

const COLD = frame({
  loudnessLong: 0,
  loudnessShort: 0,
  spectralCentroid: 0,
  spectralRolloff: 0,
  spectralFlux: 0,
  onsetDensity: 0,
  dynamics: 0,
});

/** Run computeMood to convergence (no smoothing) for a stable reading. */
function settled(
  input: AudioFeatureFrame,
  smoothing = 0,
): MoodVector {
  return computeMood(input, ZERO_MOOD, { smoothing });
}

describe("computeMood", () => {
  it("a loud, bright, dense frame reads high across the board", () => {
    const m = settled(HOT);
    expect(m.energy).toBeGreaterThan(0.7);
    expect(m.brightness).toBeGreaterThan(0.7);
    expect(m.busyness).toBeGreaterThan(0.7);
    expect(m.valence).toBeGreaterThan(0.7);
    expect(m.dynamics).toBeGreaterThan(0.7);
    for (const v of Object.values(m)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("a quiet, dark, sparse frame reads low across the board", () => {
    const m = settled(COLD);
    expect(m.energy).toBeLessThan(0.1);
    expect(m.brightness).toBeLessThan(0.1);
    expect(m.busyness).toBeLessThan(0.1);
    expect(m.valence).toBeLessThan(0.1);
    expect(m.dynamics).toBeLessThan(0.1);
  });

  it("loud beats quiet on every dimension", () => {
    const hot = settled(HOT);
    const cold = settled(COLD);
    expect(hot.energy).toBeGreaterThan(cold.energy);
    expect(hot.brightness).toBeGreaterThan(cold.brightness);
    expect(hot.busyness).toBeGreaterThan(cold.busyness);
    expect(hot.valence).toBeGreaterThan(cold.valence);
    expect(hot.dynamics).toBeGreaterThan(cold.dynamics);
  });

  it("smoothing makes a step change move gradually, not instantly", () => {
    const smoothing = 0.8;
    // Start from rest, then hold a hot input. Each frame should advance toward
    // the target but never overshoot it, and stay below the unsmoothed target.
    const target = settled(HOT).energy;

    let mood = ZERO_MOOD;
    const energies: number[] = [];
    for (let i = 0; i < 5; i++) {
      mood = computeMood(HOT, mood, { smoothing });
      energies.push(mood.energy);
    }

    // First step is a small fraction of the way, not the full jump.
    expect(energies[0]!).toBeGreaterThan(0);
    expect(energies[0]!).toBeLessThan(target * 0.5);
    // Monotonic, strictly increasing toward the target.
    for (let i = 1; i < energies.length; i++) {
      expect(energies[i]!).toBeGreaterThan(energies[i - 1]!);
      expect(energies[i]!).toBeLessThan(target + 1e-9);
    }
  });

  it("converges to the unsmoothed target after many frames", () => {
    let mood = ZERO_MOOD;
    for (let i = 0; i < 200; i++) {
      mood = computeMood(HOT, mood, { smoothing: 0.8 });
    }
    const target = settled(HOT);
    expect(mood.energy).toBeCloseTo(target.energy, 3);
    expect(mood.brightness).toBeCloseTo(target.brightness, 3);
    expect(mood.busyness).toBeCloseTo(target.busyness, 3);
  });

  it("is deterministic — same inputs yield identical output", () => {
    const a = computeMood(HOT, ZERO_MOOD, { smoothing: 0.85 });
    const b = computeMood(HOT, ZERO_MOOD, { smoothing: 0.85 });
    expect(b).toEqual(a);
  });

  it("defaults prev to ZERO_MOOD when omitted", () => {
    expect(computeMood(COLD)).toEqual(computeMood(COLD, ZERO_MOOD));
  });

  it("clamps every dimension into [0, 1] even for out-of-range inputs", () => {
    const wild = frame({
      loudnessLong: 5,
      spectralCentroid: 5,
      spectralRolloff: 5,
      spectralFlux: 5,
      onsetDensity: 1000,
      dynamics: 5,
    });
    const m = settled(wild);
    for (const v of Object.values(m)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
