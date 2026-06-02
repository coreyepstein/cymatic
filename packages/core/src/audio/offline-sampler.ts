/**
 * Offline audio-feature sampling.
 *
 * Bridges a decoded `AudioBuffer` (or any structurally-compatible object) and a
 * deterministic clock to the existing US-002 DSP. For a given clock time it
 * extracts the time-domain window that a live `AnalyserNode` would have seen
 * for that frame, runs an FFT to recover a magnitude spectrum, quantizes both
 * to the same byte layouts the runtime analyser consumes
 * (`getByteFrequencyData` / `getByteTimeDomainData`), and feeds them through
 * {@link AudioAnalyser.computeFrame}. No DSP is duplicated — bands, RMS,
 * band groups, smoothing and onset detection all come from the existing pure
 * functions via the analyser.
 *
 * Everything here is deterministic: no `Date.now()`, `performance.now()`, or
 * `Math.random()`. Given the same buffer, fps and options, two runs produce
 * byte-identical feature-frame sequences.
 *
 * It is also Node-safe: it never touches a real Web Audio context. Tests can
 * pass a plain {@link AudioBufferLike} object instead of a browser `AudioBuffer`.
 */

import { AudioAnalyser, type AnalyserOptions } from "./analyser.js";
import type { AudioFeatureFrame } from "./features.js";
import type { Clock } from "../clock/clock.js";

/**
 * The minimal `AudioBuffer` surface this sampler needs. A browser `AudioBuffer`
 * satisfies it structurally; in Node, tests synthesize a plain object with the
 * same shape so no Web Audio context is required.
 */
export interface AudioBufferLike {
  /** Number of channels of audio data. */
  readonly numberOfChannels: number;
  /** Length of the buffer in sample-frames. */
  readonly length: number;
  /** Sample rate in Hz. */
  readonly sampleRate: number;
  /** Returns the Float32 PCM samples (in [-1, 1]) for `channel`. */
  getChannelData(channel: number): Float32Array;
}

/** Options for {@link OfflineSampler}. */
export interface OfflineSamplerOptions extends AnalyserOptions {
  /**
   * How the per-frame window is positioned relative to the clock time. With
   * `"trailing"` (default) the window *ends* at the frame's sample (matching a
   * live `AnalyserNode`, which reports the most recent `fftSize` samples).
   * `"centered"` centers the window on the frame's sample.
   */
  windowAlignment?: "trailing" | "centered";
}

/**
 * Deterministically samples {@link AudioFeatureFrame}s from a decoded buffer at
 * arbitrary clock times, reusing the runtime {@link AudioAnalyser} DSP.
 */
export class OfflineSampler {
  private readonly buffer: AudioBufferLike;
  private readonly analyser: AudioAnalyser;
  private readonly fftSize: number;
  private readonly alignment: "trailing" | "centered";

  /** Mono mixdown of the buffer (computed once, reused per frame). */
  private readonly mono: Float32Array;

  // Scratch buffers reused across frames to avoid per-frame allocation.
  private readonly windowReal: Float32Array;
  private readonly windowImag: Float32Array;
  private readonly freqBytes: Uint8Array;
  private readonly timeBytes: Uint8Array;

  constructor(buffer: AudioBufferLike, options: OfflineSamplerOptions = {}) {
    this.buffer = buffer;
    this.analyser = new AudioAnalyser(options);
    this.fftSize = options.fftSize ?? 2048;
    if (!isPowerOfTwo(this.fftSize) || this.fftSize < 2) {
      throw new RangeError(
        "OfflineSampler: fftSize must be a power of two >= 2",
      );
    }
    this.alignment = options.windowAlignment ?? "trailing";

    this.mono = toMono(buffer);
    this.windowReal = new Float32Array(this.fftSize);
    this.windowImag = new Float32Array(this.fftSize);
    // frequencyBinCount === fftSize / 2.
    this.freqBytes = new Uint8Array(this.fftSize / 2);
    this.timeBytes = new Uint8Array(this.fftSize);
  }

  /** Total duration of the underlying buffer in seconds. */
  get duration(): number {
    return this.buffer.length / this.buffer.sampleRate;
  }

  /**
   * Extract and analyse the frame at `time` seconds. Stateful: smoothing and
   * onset detection advance with each call, so callers should sample in
   * monotonic time order (which the offline clock guarantees).
   */
  sampleAt(time: number): AudioFeatureFrame {
    this.fillWindow(time);
    this.fillFrequencyBytes();
    this.fillTimeBytes();
    return this.analyser.computeFrame(this.freqBytes, this.timeBytes, time);
  }

  /**
   * Convenience driver: render the full sequence of feature frames by stepping
   * `clock` until `time >= duration`. Resets analyser smoothing/onset state
   * first so the sequence is reproducible from frame 0.
   *
   * The clock is advanced via {@link Clock.tick}; an {@link OfflineClock}
   * steps deterministically by `1/fps` per tick.
   */
  render(clock: Clock): AudioFeatureFrame[] {
    this.analyser.reset();
    const frames: AudioFeatureFrame[] = [];
    // Frame 0 is at time 0; subsequent frames step the clock first.
    let first = true;
    while (true) {
      if (!first) clock.tick();
      first = false;
      const t = clock.now();
      if (t >= this.duration) break;
      frames.push(this.sampleAt(t));
    }
    return frames;
  }

  /** Fill {@link windowReal} with the time-domain window for `time`. */
  private fillWindow(time: number): void {
    const center = Math.round(time * this.buffer.sampleRate);
    const start =
      this.alignment === "centered"
        ? center - Math.floor(this.fftSize / 2)
        : center - this.fftSize + 1;

    const mono = this.mono;
    const n = mono.length;
    for (let i = 0; i < this.fftSize; i++) {
      const idx = start + i;
      // Zero-pad out-of-range samples (before start / past end of buffer).
      this.windowReal[i] = idx >= 0 && idx < n ? (mono[idx] ?? 0) : 0;
      this.windowImag[i] = 0;
    }
  }

  /**
   * Quantize the windowed time-domain signal into the byte layout produced by
   * `AnalyserNode.getByteTimeDomainData`: samples in [-1, 1] mapped to [0, 255]
   * centered at 128.
   */
  private fillTimeBytes(): void {
    for (let i = 0; i < this.fftSize; i++) {
      const v = this.windowReal[i] ?? 0;
      const byte = Math.round(v * 128 + 128);
      this.timeBytes[i] = byte < 0 ? 0 : byte > 255 ? 255 : byte;
    }
  }

  /**
   * Run the FFT on the current window (applying a Hann window first, as the
   * Web Audio analyser does) and quantize the magnitude spectrum into the byte
   * layout produced by `AnalyserNode.getByteFrequencyData`.
   */
  private fillFrequencyBytes(): void {
    const size = this.fftSize;
    // Apply a Hann window into the imag-free FFT input. We copy into the
    // FFT scratch arrays; windowReal already holds the raw samples, but the
    // time-domain bytes were taken from the *un-windowed* signal (matching the
    // analyser, which windows only for the frequency transform).
    const re = new Float32Array(size);
    const im = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
      re[i] = (this.windowReal[i] ?? 0) * hann;
      im[i] = 0;
    }

    fftInPlace(re, im);

    // dB scaling matching the Web Audio analyser defaults.
    const minDb = -100;
    const maxDb = -30;
    const rangeDb = maxDb - minDb;
    const half = size / 2;
    for (let i = 0; i < half; i++) {
      const reI = re[i] ?? 0;
      const imI = im[i] ?? 0;
      // Normalize magnitude by FFT size so it is independent of fftSize.
      const mag = Math.sqrt(reI * reI + imI * imI) / size;
      const db = mag > 0 ? 20 * Math.log10(mag) : minDb;
      // Map [minDb, maxDb] -> [0, 255].
      const scaled = ((db - minDb) / rangeDb) * 255;
      const byte = Math.round(scaled);
      this.freqBytes[i] = byte < 0 ? 0 : byte > 255 ? 255 : byte;
    }
  }
}

/** Down-mix all channels of a buffer to a single mono Float32Array. */
function toMono(buffer: AudioBufferLike): Float32Array {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const out = new Float32Array(length);
  if (channels <= 0) return out;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) {
      out[i] = (out[i] ?? 0) + (data[i] ?? 0);
    }
  }
  const inv = 1 / channels;
  for (let i = 0; i < length; i++) out[i] = (out[i] ?? 0) * inv;
  return out;
}

function isPowerOfTwo(n: number): boolean {
  return n >= 1 && (n & (n - 1)) === 0;
}

/**
 * In-place radix-2 iterative Cooley–Tukey FFT. `re` / `im` must have a
 * power-of-two length. Deterministic and dependency-free so it runs identically
 * in Node and the browser.
 */
function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if (n <= 1) return;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i] ?? 0;
      re[i] = re[j] ?? 0;
      re[j] = tr;
      const ti = im[i] ?? 0;
      im[i] = im[j] ?? 0;
      im[j] = ti;
    }
  }

  // Iterative butterflies.
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k] ?? 0;
        const aIm = im[i + k] ?? 0;
        const bRe = re[i + k + len / 2] ?? 0;
        const bIm = im[i + k + len / 2] ?? 0;
        const tRe = curRe * bRe - curIm * bIm;
        const tIm = curRe * bIm + curIm * bRe;
        re[i + k] = aRe + tRe;
        im[i + k] = aIm + tIm;
        re[i + k + len / 2] = aRe - tRe;
        im[i + k + len / 2] = aIm - tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}
