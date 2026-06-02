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
  crestFactor,
  ema,
  estimateTempo,
  spectralCentroid,
  spectralRolloff,
  type AudioFeatureFrame,
  type BandSplit,
} from "./features.js";
import {
  ZERO_MOOD,
  computeMood,
  type MoodOptions,
  type MoodVector,
} from "./mood.js";

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
  /**
   * EMA smoothing for the *short* (fast) loudness envelope in [0, 1). Lower =
   * snappier. Default `0.5`.
   */
  loudnessShortSmoothing?: number;
  /**
   * EMA smoothing for the *long* (slow) loudness envelope in [0, 1). Higher =
   * more sustained / laggier. Default `0.95`.
   */
  loudnessLongSmoothing?: number;
  /**
   * Rolling window (in seconds) over which onsets are retained for tempo and
   * onset-density estimation. Default `4`.
   */
  tempoWindowSeconds?: number;
  /**
   * EMA smoothing applied to the estimated tempo in [0, 1) so the BPM locks and
   * does not jitter every frame. Higher = stickier. Default `0.9`.
   */
  tempoSmoothing?: number;
  /**
   * Tuning for the derived {@link MoodVector} (smoothing + normalization). See
   * {@link MoodOptions}.
   */
  mood?: MoodOptions;
}

interface ResolvedOptions {
  fftSize: number;
  bandCount: number;
  smoothing: number;
  bandSplit: BandSplit;
  loudnessShortSmoothing: number;
  loudnessLongSmoothing: number;
  tempoWindowSeconds: number;
  tempoSmoothing: number;
  mood: MoodOptions;
}

const DEFAULTS: ResolvedOptions = {
  fftSize: 2048,
  bandCount: 32,
  smoothing: 0.6,
  bandSplit: DEFAULT_BAND_SPLIT,
  loudnessShortSmoothing: 0.5,
  loudnessLongSmoothing: 0.95,
  tempoWindowSeconds: 4,
  tempoSmoothing: 0.9,
  mood: {},
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
  private loudnessShort = 0;
  private loudnessLong = 0;
  /** Locked/smoothed tempo estimate in BPM (0 until enough history). */
  private lockedTempo = 0;
  /** Beat phase in [0, 1) advanced by time, re-aligned on onsets. */
  private beatPhase = 0;
  /** Time of the previous processed frame, for phase advance. null = first. */
  private prevTime: number | null = null;
  /** Rolling onset timestamps (seconds) within the tempo window. */
  private onsetTimes: number[] = [];
  /** Smoothed high-level mood vector, carried across frames. */
  private mood: MoodVector = { ...ZERO_MOOD };

  constructor(options: AnalyserOptions = {}) {
    this.opts = {
      fftSize: options.fftSize ?? DEFAULTS.fftSize,
      bandCount: options.bandCount ?? DEFAULTS.bandCount,
      smoothing: clamp01(options.smoothing ?? DEFAULTS.smoothing),
      bandSplit: options.bandSplit ?? DEFAULTS.bandSplit,
      loudnessShortSmoothing: clamp01(
        options.loudnessShortSmoothing ?? DEFAULTS.loudnessShortSmoothing,
      ),
      loudnessLongSmoothing: clamp01(
        options.loudnessLongSmoothing ?? DEFAULTS.loudnessLongSmoothing,
      ),
      tempoWindowSeconds:
        options.tempoWindowSeconds ?? DEFAULTS.tempoWindowSeconds,
      tempoSmoothing: clamp01(
        options.tempoSmoothing ?? DEFAULTS.tempoSmoothing,
      ),
      mood: options.mood ?? DEFAULTS.mood,
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
    this.loudnessShort = 0;
    this.loudnessLong = 0;
    this.lockedTempo = 0;
    this.beatPhase = 0;
    this.prevTime = null;
    this.onsetTimes = [];
    this.mood = { ...ZERO_MOOD };
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

    // Loudness envelope: a fast and a slow EMA of the raw RMS. Their ratio
    // gives a crest/dynamics measure (punchy vs sustained).
    this.loudnessShort = ema(
      this.loudnessShort,
      rawRms,
      this.opts.loudnessShortSmoothing,
    );
    this.loudnessLong = ema(
      this.loudnessLong,
      rawRms,
      this.opts.loudnessLongSmoothing,
    );
    const dynamics = crestFactor(this.loudnessShort, this.loudnessLong);

    const groups = bandGroups(this.smoothedBands, this.opts.bandSplit);

    // Spectral shape on the raw (un-smoothed) spectrum so brightness tracks
    // transients sharply.
    const centroid = spectralCentroid(freqData);
    const rolloff = spectralRolloff(freqData);

    // Onset detection runs on the raw frequency spectrum (un-smoothed) so
    // transients stay sharp. Its rectified flux is exposed in the frame.
    const onset = this.beatDetector.process(freqData);
    const flux = this.beatDetector.lastFlux;

    // Maintain a rolling window of onset timestamps for tempo + density.
    if (onset) this.onsetTimes.push(time);
    const windowStart = time - this.opts.tempoWindowSeconds;
    while (this.onsetTimes.length > 0 && (this.onsetTimes[0] ?? 0) < windowStart) {
      this.onsetTimes.shift();
    }

    // Onset density: onsets per second over the elapsed window span.
    const span = Math.min(this.opts.tempoWindowSeconds, Math.max(0, time));
    const onsetDensity = span > 0 ? this.onsetTimes.length / span : 0;

    // Tempo: estimate from the onset history and lock it with an EMA so it does
    // not jitter frame-to-frame. Only update the lock once an estimate exists.
    const rawTempo = estimateTempo(this.onsetTimes);
    if (rawTempo > 0) {
      this.lockedTempo =
        this.lockedTempo > 0
          ? ema(this.lockedTempo, rawTempo, this.opts.tempoSmoothing)
          : rawTempo;
    }

    // Beat phase: advance by elapsed time at the locked tempo, wrapping in
    // [0, 1). Re-align to 0 on a detected onset so it stays beat-locked.
    if (onset) {
      this.beatPhase = 0;
    } else if (this.lockedTempo > 0 && this.prevTime !== null) {
      const dt = time - this.prevTime;
      if (dt > 0) {
        const beatsPerSecond = this.lockedTempo / 60;
        this.beatPhase = (this.beatPhase + dt * beatsPerSecond) % 1;
        if (this.beatPhase < 0) this.beatPhase += 1;
      }
    }
    this.prevTime = time;

    const frame: AudioFeatureFrame = {
      bands: this.smoothedBands.slice(),
      bass: groups.bass,
      mid: groups.mid,
      treble: groups.treble,
      rms: this.smoothedRms,
      onset,
      spectralCentroid: centroid,
      spectralRolloff: rolloff,
      spectralFlux: flux,
      loudnessShort: this.loudnessShort,
      loudnessLong: this.loudnessLong,
      dynamics,
      tempo: this.lockedTempo,
      beatPhase: this.beatPhase,
      onsetDensity,
      mood: ZERO_MOOD,
      time,
    };

    // Derive the high-level mood from the raw frame, smoothing across frames.
    this.mood = computeMood(frame, this.mood, this.opts.mood);
    frame.mood = this.mood;

    return frame;
  }
}
