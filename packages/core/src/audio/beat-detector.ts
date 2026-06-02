/**
 * Spectral-flux onset / beat detection.
 *
 * The detector is a pure, stateful object: feed it one magnitude spectrum per
 * frame and it returns whether an onset occurred. It keeps a running estimate
 * of the recent flux via an exponential moving average and flags an onset when
 * the current positive flux exceeds that baseline by an adjustable
 * sensitivity, subject to a refractory decay window so a single transient is
 * not double-counted.
 *
 * No browser APIs are used, so it is fully testable in Node.
 */

/** Tunable parameters for {@link BeatDetector}. */
export interface BeatDetectorOptions {
  /**
   * How far above the rolling flux baseline the current flux must rise to
   * count as an onset. Higher = less sensitive (fewer beats). Default `1.4`.
   */
  sensitivity?: number;
  /**
   * EMA smoothing for the rolling flux baseline in [0, 1). Higher = slower to
   * adapt (longer memory). Default `0.9`.
   */
  decay?: number;
  /**
   * Minimum number of frames between two onsets (refractory period). Prevents
   * a single percussive hit from registering multiple times. Default `3`.
   */
  minFramesBetween?: number;
  /**
   * Absolute floor the flux must exceed regardless of baseline, to suppress
   * onsets in near-silence. Default `1e-4`.
   */
  fluxFloor?: number;
}

const DEFAULTS: Required<BeatDetectorOptions> = {
  sensitivity: 1.4,
  decay: 0.9,
  minFramesBetween: 3,
  fluxFloor: 1e-4,
};

/**
 * Rectified spectral flux between two consecutive magnitude spectra: the sum
 * of positive bin-to-bin increases, normalized by bin count.
 *
 * Returns 0 when lengths differ or either array is empty.
 */
export function spectralFlux(
  prev: Float32Array | Uint8Array,
  next: Float32Array | Uint8Array,
): number {
  const n = next.length;
  if (n === 0 || prev.length !== n) return 0;
  let flux = 0;
  for (let i = 0; i < n; i++) {
    const diff = (next[i] ?? 0) - (prev[i] ?? 0);
    if (diff > 0) flux += diff;
  }
  return flux / n;
}

/** Stateful spectral-flux onset detector. */
export class BeatDetector {
  private readonly opts: Required<BeatDetectorOptions>;
  private prevSpectrum: Float32Array | Uint8Array | null = null;
  private baseline = 0;
  private framesSinceOnset = Number.POSITIVE_INFINITY;
  /** Most recent rectified flux value (exposed for diagnostics/tests). */
  public lastFlux = 0;

  constructor(options: BeatDetectorOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /** Reset all internal state to the initial (just-constructed) condition. */
  reset(): void {
    this.prevSpectrum = null;
    this.baseline = 0;
    this.framesSinceOnset = Number.POSITIVE_INFINITY;
    this.lastFlux = 0;
  }

  /**
   * Process one magnitude spectrum and report whether it begins an onset.
   *
   * The detector adapts its baseline *after* the comparison so a sudden spike
   * is judged against the pre-spike average, then folded into the baseline.
   */
  process(spectrum: Float32Array | Uint8Array): boolean {
    if (this.framesSinceOnset !== Number.POSITIVE_INFINITY) {
      this.framesSinceOnset++;
    }

    if (this.prevSpectrum === null) {
      this.prevSpectrum = copy(spectrum);
      return false;
    }

    const flux = spectralFlux(this.prevSpectrum, spectrum);
    this.lastFlux = flux;
    this.prevSpectrum = copy(spectrum);

    const threshold = this.baseline * this.opts.sensitivity;
    const isOnset =
      flux > this.opts.fluxFloor &&
      flux > threshold &&
      this.framesSinceOnset >= this.opts.minFramesBetween;

    // Fold this frame's flux into the rolling baseline (slow EMA).
    this.baseline =
      this.baseline * this.opts.decay + flux * (1 - this.opts.decay);

    if (isOnset) this.framesSinceOnset = 0;
    return isOnset;
  }
}

function copy(a: Float32Array | Uint8Array): Float32Array | Uint8Array {
  return a instanceof Uint8Array ? Uint8Array.from(a) : Float32Array.from(a);
}
