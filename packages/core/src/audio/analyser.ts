/**
 * Runtime audio analyser: wires the pure DSP functions in `features.ts` and
 * the {@link BeatDetector} to a live Web Audio `AnalyserNode`.
 *
 * This module touches DOM/Web Audio types but only constructs nodes lazily, so
 * importing it in Node is safe — only `attach()` / `read()` require a browser
 * `AudioContext`. The DSP itself is unit-tested directly against the pure
 * functions, so this class is a thin orchestration layer.
 */

import {
  BeatDetector,
  type BeatDetectorOptions,
} from "./beat-detector.js";
import {
  DEFAULT_BAND_SPLIT,
  bandGroups,
  clamp01,
  computeBands,
  computeRms,
  ema,
  type AudioFeatureFrame,
  type BandSplit,
} from "./features.js";

/** Configuration for {@link AudioAnalyser}. All fields optional. */
export interface AnalyserOptions {
  /** FFT size passed to the `AnalyserNode`. Must be a power of two. Default `2048`. */
  fftSize?: number;
  /** Number of log-spaced output bands. Default `32`. */
  bandCount?: number;
  /**
   * Exponential-moving-average smoothing for feature values in [0, 1).
   * Higher = smoother / laggier. Default `0.6`.
   */
  smoothing?: number;
  /** Crossover fractions splitting bass/mid/treble groups. */
  bandSplit?: BandSplit;
  /** Onset-detector tuning. */
  beat?: BeatDetectorOptions;
}

interface ResolvedOptions {
  fftSize: number;
  bandCount: number;
  smoothing: number;
  bandSplit: BandSplit;
}

const DEFAULTS: ResolvedOptions = {
  fftSize: 2048,
  bandCount: 32,
  smoothing: 0.6,
  bandSplit: DEFAULT_BAND_SPLIT,
};

/**
 * Wraps an `AnalyserNode` and produces normalized, smoothed
 * {@link AudioFeatureFrame}s on demand.
 */
export class AudioAnalyser {
  private readonly opts: ResolvedOptions;
  private readonly beatDetector: BeatDetector;

  private node: AnalyserNode | null = null;
  private freqData: Uint8Array | null = null;
  private timeData: Uint8Array | null = null;

  // Smoothed running state.
  private smoothedBands: number[];
  private smoothedRms = 0;

  constructor(options: AnalyserOptions = {}) {
    this.opts = {
      fftSize: options.fftSize ?? DEFAULTS.fftSize,
      bandCount: options.bandCount ?? DEFAULTS.bandCount,
      smoothing: clamp01(options.smoothing ?? DEFAULTS.smoothing),
      bandSplit: options.bandSplit ?? DEFAULTS.bandSplit,
    };
    this.beatDetector = new BeatDetector(options.beat);
    this.smoothedBands = new Array<number>(this.opts.bandCount).fill(0);
  }

  /** The resolved band count this analyser emits. */
  get bandCount(): number {
    return this.opts.bandCount;
  }

  /**
   * Reset all running state — smoothed bands, smoothed RMS, and the onset
   * detector — to the just-constructed condition. Useful for offline rendering
   * so a sequence can be reproduced deterministically from frame 0 without
   * re-attaching to a node.
   */
  reset(): void {
    this.smoothedBands = new Array<number>(this.opts.bandCount).fill(0);
    this.smoothedRms = 0;
    this.beatDetector.reset();
  }

  /** The underlying `AnalyserNode`, or `null` until {@link attach} is called. */
  get analyserNode(): AnalyserNode | null {
    return this.node;
  }

  /**
   * Create (or recreate) an `AnalyserNode` on the given context and connect a
   * source into it. Returns the node so callers can chain further routing.
   */
  attach(context: AudioContext, source: AudioNode): AnalyserNode {
    const node = context.createAnalyser();
    node.fftSize = this.opts.fftSize;
    source.connect(node);
    this.node = node;
    this.freqData = new Uint8Array(node.frequencyBinCount);
    this.timeData = new Uint8Array(node.fftSize);
    this.beatDetector.reset();
    return node;
  }

  /**
   * Sample the attached node and return a fresh feature frame.
   *
   * @param time Timestamp for the frame in seconds (e.g. `audioCtx.currentTime`).
   * @throws if called before {@link attach}.
   */
  read(time: number): AudioFeatureFrame {
    if (this.node === null || this.freqData === null || this.timeData === null) {
      throw new Error("AudioAnalyser.read() called before attach()");
    }
    // Web Audio's typings accept Uint8Array here.
    this.node.getByteFrequencyData(this.freqData);
    this.node.getByteTimeDomainData(this.timeData);
    return this.computeFrame(this.freqData, this.timeData, time);
  }

  /**
   * Pure frame computation shared by {@link read} and tests. Given raw
   * frequency + time-domain byte data, returns a smoothed feature frame and
   * advances the internal smoothing / onset state.
   */
  computeFrame(
    freqData: Uint8Array,
    timeData: Uint8Array,
    time: number,
  ): AudioFeatureFrame {
    const rawBands = computeBands(freqData, this.opts.bandCount);
    const s = this.opts.smoothing;

    for (let i = 0; i < this.opts.bandCount; i++) {
      this.smoothedBands[i] = ema(
        this.smoothedBands[i] ?? 0,
        rawBands[i] ?? 0,
        s,
      );
    }

    const rawRms = computeRms(timeData);
    this.smoothedRms = ema(this.smoothedRms, rawRms, s);

    const groups = bandGroups(this.smoothedBands, this.opts.bandSplit);
    // Onset detection runs on the raw frequency spectrum (un-smoothed) so
    // transients stay sharp.
    const onset = this.beatDetector.process(freqData);

    return {
      bands: this.smoothedBands.slice(),
      bass: groups.bass,
      mid: groups.mid,
      treble: groups.treble,
      rms: this.smoothedRms,
      onset,
      time,
    };
  }
}
