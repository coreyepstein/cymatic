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

    // New V2-05 fields are present and in their documented ranges.
    expect(frame.spectralCentroid).toBeGreaterThanOrEqual(0);
    expect(frame.spectralCentroid).toBeLessThanOrEqual(1);
    expect(frame.spectralRolloff).toBeGreaterThanOrEqual(0);
    expect(frame.spectralRolloff).toBeLessThanOrEqual(1);
    expect(frame.spectralFlux).toBe(0); // first frame has no previous spectrum
    expect(frame.loudnessShort).toBe(0); // silent
    expect(frame.loudnessLong).toBe(0);
    expect(frame.dynamics).toBe(0);
    expect(frame.tempo).toBe(0); // no onset history yet
    expect(frame.beatPhase).toBe(0);
    expect(frame.onsetDensity).toBeGreaterThanOrEqual(0);

    // V2-06 mood vector: present and in range. Silent input -> low mood.
    expect(frame.mood).toBeDefined();
    for (const v of Object.values(frame.mood)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(frame.mood.energy).toBeLessThan(0.5);
  });

  it("mood rises for a loud, bright, busy signal vs near-silence", () => {
    const analyser = new AudioAnalyser({ bandCount: 16, smoothing: 0 });

    // Bright, high-energy spectrum + loud time-domain, with periodic spikes to
    // drive onsets/density. Run several frames so the mood EMA can rise.
    const bright = new Uint8Array(512).fill(180);
    for (let i = 256; i < 512; i++) bright[i] = 255; // energy toward the highs
    const spike = new Uint8Array(512).fill(255);
    const loud = new Uint8Array(1024);
    for (let i = 0; i < 1024; i++) {
      loud[i] = 128 + Math.round(120 * Math.sin((2 * Math.PI * i) / 64));
    }

    let hot = analyser.computeFrame(bright, loud, 0);
    for (let i = 1; i < 40; i++) {
      const spectrum = i % 5 === 0 ? spike : bright;
      hot = analyser.computeFrame(spectrum, loud, i * 0.1);
    }

    const quiet = new AudioAnalyser({ bandCount: 16, smoothing: 0 });
    const dark = new Uint8Array(512).fill(2);
    let cold = quiet.computeFrame(dark, silentTime(1024), 0);
    for (let i = 1; i < 40; i++) {
      cold = quiet.computeFrame(dark, silentTime(1024), i * 0.1);
    }

    expect(hot.mood.energy).toBeGreaterThan(cold.mood.energy);
    expect(hot.mood.brightness).toBeGreaterThan(cold.mood.brightness);
    expect(hot.mood.busyness).toBeGreaterThan(cold.mood.busyness);
  });

  it("exposes spectral flux after the first frame", () => {
    const analyser = new AudioAnalyser({ bandCount: 16, smoothing: 0 });
    // Frame 1: establishes baseline spectrum (flux 0).
    const f1 = analyser.computeFrame(freqWithPeak(512, 4), silentTime(1024), 0);
    expect(f1.spectralFlux).toBe(0);
    // Frame 2: a different (louder) spectrum -> positive flux.
    const louder = new Uint8Array(512).fill(50);
    louder[4] = 255;
    const f2 = analyser.computeFrame(louder, silentTime(1024), 1);
    expect(f2.spectralFlux).toBeGreaterThan(0);
  });

  it("beatPhase stays in [0, 1) and onsetDensity rises with onsets", () => {
    const analyser = new AudioAnalyser({ bandCount: 16, smoothing: 0 });
    // Feed a steady spectrum then periodic spikes to provoke onsets.
    const flat = new Uint8Array(512).fill(10);
    const spike = new Uint8Array(512).fill(10);
    for (let i = 0; i < 512; i++) spike[i] = 200;

    let sawOnset = false;
    let lastDensity = 0;
    for (let i = 0; i < 40; i++) {
      const t = i * 0.1; // 10 fps
      const spectrum = i % 5 === 0 ? spike : flat;
      const frame = analyser.computeFrame(spectrum, silentTime(1024), t);
      expect(frame.beatPhase).toBeGreaterThanOrEqual(0);
      expect(frame.beatPhase).toBeLessThan(1);
      expect(frame.onsetDensity).toBeGreaterThanOrEqual(0);
      if (frame.onset) sawOnset = true;
      lastDensity = frame.onsetDensity;
    }
    expect(sawOnset).toBe(true);
    expect(lastDensity).toBeGreaterThan(0);
  });

  it("dynamics rises on a punchy transient vs a sustained level", () => {
    const analyser = new AudioAnalyser({ bandCount: 8, smoothing: 0 });
    const freq = freqWithPeak(256, 2);

    // Establish a sustained mid loudness so short ~ long.
    const sustained = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      sustained[i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * i) / 64));
    }
    let frame = analyser.computeFrame(freq, sustained, 0);
    for (let i = 1; i < 20; i++) {
      frame = analyser.computeFrame(freq, sustained, i);
    }
    const steadyDynamics = frame.dynamics;

    // Now a sudden loud transient -> short envelope jumps above long.
    const loud = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      loud[i] = 128 + Math.round(120 * Math.sin((2 * Math.PI * i) / 64));
    }
    const punch = analyser.computeFrame(freq, loud, 20);
    expect(punch.dynamics).toBeGreaterThan(steadyDynamics);
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
