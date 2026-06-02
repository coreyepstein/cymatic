import { describe, expect, it, vi } from "vitest";

import {
  OfflineSampler,
  type AudioBufferLike,
} from "./offline-sampler.js";
import { OfflineClock } from "../clock/offline-clock.js";

/**
 * Synthesize a deterministic, Node-safe `AudioBuffer`-like object: a sum of two
 * sine tones with a periodic amplitude pulse (to give the onset detector
 * something to react to). No randomness, no Web Audio context.
 */
function makeBuffer(options?: {
  sampleRate?: number;
  seconds?: number;
  channels?: number;
}): AudioBufferLike {
  const sampleRate = options?.sampleRate ?? 44100;
  const seconds = options?.seconds ?? 0.5;
  const channels = options?.channels ?? 1;
  const length = Math.floor(sampleRate * seconds);

  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const arr = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const bass = 0.5 * Math.sin(2 * Math.PI * 110 * t);
      const high = 0.3 * Math.sin(2 * Math.PI * 4000 * t);
      // A pulse every 0.1s creates transients for onset detection.
      const pulse = Math.sin(2 * Math.PI * 10 * t) > 0.95 ? 0.4 : 0;
      // Slight per-channel offset so mixdown is exercised.
      arr[i] = (bass + high + pulse) * (1 - c * 0.1);
    }
    data.push(arr);
  }

  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    getChannelData: (channel: number) => {
      const d = data[channel];
      if (!d) throw new RangeError(`no channel ${channel}`);
      return d;
    },
  };
}

const FFT_SIZE = 1024;
const BAND_COUNT = 32;

describe("OfflineSampler", () => {
  it("produces feature frames with the configured band count", () => {
    const buffer = makeBuffer();
    const sampler = new OfflineSampler(buffer, {
      fftSize: FFT_SIZE,
      bandCount: BAND_COUNT,
    });
    const frame = sampler.sampleAt(0.1);
    expect(frame.bands).toHaveLength(BAND_COUNT);
    expect(frame.time).toBe(0.1);
    for (const b of frame.bands) {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
    }
    expect(frame.rms).toBeGreaterThanOrEqual(0);
    expect(frame.rms).toBeLessThanOrEqual(1);
  });

  it("detects more energy in bass than treble for a bass-heavy tone", () => {
    const buffer = makeBuffer();
    const sampler = new OfflineSampler(buffer, {
      fftSize: FFT_SIZE,
      bandCount: BAND_COUNT,
      smoothing: 0, // no smoothing so a single frame reflects the spectrum
    });
    // Step to a stable mid-buffer frame.
    let frame = sampler.sampleAt(0.05);
    frame = sampler.sampleAt(0.2);
    expect(frame.bass).toBeGreaterThan(frame.treble);
  });

  it("renders a full sequence whose frame times follow the clock", () => {
    const buffer = makeBuffer({ seconds: 0.25, sampleRate: 8000 });
    const sampler = new OfflineSampler(buffer, {
      fftSize: 256,
      bandCount: 16,
    });
    const fps = 30;
    const frames = sampler.render(new OfflineClock({ fps }));
    expect(frames.length).toBeGreaterThan(0);
    // Last frame time must be < duration; spacing is exactly 1/fps.
    expect(frames[0]!.time).toBe(0);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]!.time).toBeCloseTo(i / fps, 10);
    }
    const lastTime = frames[frames.length - 1]!.time;
    expect(lastTime).toBeLessThan(sampler.duration);
  });

  it("DETERMINISM: same input + OfflineClock yields identical sequences across two runs", () => {
    const fps = 60;

    const runOnce = () => {
      const buffer = makeBuffer({ seconds: 0.5, sampleRate: 22050 });
      const sampler = new OfflineSampler(buffer, {
        fftSize: FFT_SIZE,
        bandCount: BAND_COUNT,
        smoothing: 0.6,
      });
      return sampler.render(new OfflineClock({ fps }));
    };

    const runA = runOnce();
    const runB = runOnce();

    expect(runA.length).toBeGreaterThan(10);
    // Deep equality across the entire feature-frame sequence.
    expect(runB).toEqual(runA);
  });

  it("DETERMINISM: a shared sampler reset between runs reproduces the sequence", () => {
    const buffer = makeBuffer({ seconds: 0.3, sampleRate: 16000 });
    const sampler = new OfflineSampler(buffer, {
      fftSize: 512,
      bandCount: 24,
      smoothing: 0.5,
    });

    const runA = sampler.render(new OfflineClock({ fps: 50 }));
    // render() resets analyser state, so a second render reproduces run A.
    const runB = sampler.render(new OfflineClock({ fps: 50 }));
    expect(runB).toEqual(runA);
  });

  it("never touches Date.now / Math.random in the offline path", () => {
    const dateSpy = vi.spyOn(Date, "now");
    const randSpy = vi.spyOn(Math, "random");
    const buffer = makeBuffer({ seconds: 0.2, sampleRate: 8000 });
    const sampler = new OfflineSampler(buffer, { fftSize: 256, bandCount: 16 });
    sampler.render(new OfflineClock({ fps: 30 }));
    expect(dateSpy).not.toHaveBeenCalled();
    expect(randSpy).not.toHaveBeenCalled();
    dateSpy.mockRestore();
    randSpy.mockRestore();
  });

  it("mixes multiple channels to mono", () => {
    const mono = makeBuffer({ channels: 1, seconds: 0.2 });
    const stereo = makeBuffer({ channels: 2, seconds: 0.2 });
    const sMono = new OfflineSampler(mono, { fftSize: 256, bandCount: 16 });
    const sStereo = new OfflineSampler(stereo, { fftSize: 256, bandCount: 16 });
    // Both should produce valid, in-range frames (channel 2 is attenuated 10%).
    const fMono = sMono.sampleAt(0.1);
    const fStereo = sStereo.sampleAt(0.1);
    expect(fMono.bands).toHaveLength(16);
    expect(fStereo.bands).toHaveLength(16);
    expect(fStereo.rms).toBeGreaterThan(0);
  });

  it("rejects a non-power-of-two fftSize", () => {
    const buffer = makeBuffer();
    expect(() => new OfflineSampler(buffer, { fftSize: 1000 })).toThrow(
      RangeError,
    );
  });
});
