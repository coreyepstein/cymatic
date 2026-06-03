/**
 * Pure DSP functions for the cymatic audio analysis engine.
 *
 * Everything in this module operates on plain typed arrays so it can be unit
 * tested in Node without a real `AudioContext`. The runtime input adapters
 * (see `inputs/`) wire these functions to a live `AnalyserNode`.
 */

/** A single, normalized, smoothed snapshot of the audio signal. */
export interface AudioFeatureFrame {
  /** Per-band normalized energy in [0, 1], length === configured band count. */
  bands: number[];
  /** Aggregate normalized energy of the low band group, [0, 1]. */
  bass: number;
  /** Aggregate normalized energy of the mid band group, [0, 1]. */
  mid: number;
  /** Aggregate normalized energy of the high band group, [0, 1]. */
  treble: number;
  /** Root-mean-square loudness of the time-domain signal, normalized to [0, 1]. */
  rms: number;
  /** True when a beat/onset was detected on this frame. */
  onset: boolean;
  /**
   * Spectral centroid — the energy-weighted "center of mass" of the magnitude
   * spectrum, normalized to [0, 1] over the bin range. Higher = brighter
   * (more high-frequency energy). 0 for a silent spectrum.
   */
  spectralCentroid: number;
  /**
   * Spectral rolloff — the normalized bin position [0, 1] below which a fixed
   * fraction (default 85%) of the total spectral energy lies. Higher = more
   * energy spread toward the highs. 0 for a silent spectrum.
   */
  spectralRolloff: number;
  /**
   * Rectified spectral flux for this frame: the per-bin positive energy
   * increase versus the previous frame, normalized by bin count. Reuses the
   * same computation that drives onset detection. >= 0; 0 on the first frame.
   */
  spectralFlux: number;
  /**
   * Fast EMA of RMS loudness in [0, 1] — tracks the short-term (punchy)
   * loudness envelope.
   */
  loudnessShort: number;
  /**
   * Slow EMA of RMS loudness in [0, 1] — tracks the long-term (sustained)
   * loudness envelope.
   */
  loudnessLong: number;
  /**
   * Dynamics / crest measure in [0, 1]: how punchy vs sustained the moment is,
   * derived from the short-vs-long loudness ratio (peak-to-average). ~0 when
   * the signal is steady; rises toward 1 on sharp transients above the
   * sustained level.
   */
  dynamics: number;
  /**
   * Estimated tempo in beats per minute, clamped to [60, 200]. Smoothed/locked
   * across frames so it does not jitter every frame. 0 until enough onset
   * history exists to estimate.
   */
  tempo: number;
  /**
   * Position within the current beat in [0, 1): advances with time at the
   * estimated tempo and re-aligns to 0 on detected onsets. 0 when no tempo is
   * yet estimated.
   */
  beatPhase: number;
  /** Detected onsets per second, averaged over a rolling window. >= 0. */
  onsetDensity: number;
  /**
   * Smoothed, high-level read of the musical *feel* derived from the raw
   * features above (energy / brightness / busyness / valence / dynamics, each
   * in [0, 1]). See {@link MoodVector}. `valence` is an approximate heuristic
   * proxy, not true musical valence.
   */
  mood: import("./mood.js").MoodVector;
  /** Timestamp for the frame, in seconds. */
  time: number;
}

/** Boundaries (in fractions of the band array) splitting bass / mid / treble. */
export interface BandSplit {
  /** Upper edge of the bass group, as a fraction of total bands, (0, 1). */
  bass: number;
  /** Upper edge of the mid group, as a fraction of total bands, (0, 1). */
  mid: number;
}

/** Default crossover between bass / mid / treble groups. */
export const DEFAULT_BAND_SPLIT: BandSplit = { bass: 0.15, mid: 0.5 };

/**
 * Compute the log-spaced bin edges that map an FFT magnitude array of
 * `binCount` bins into `bandCount` perceptually-spaced bands.
 *
 * Returns `bandCount + 1` edges (inclusive of 0 and `binCount`). Bins are
 * spread logarithmically so low frequencies get finer resolution, matching
 * human pitch perception. Edges are monotonically non-decreasing and each
 * band is guaranteed to span at least one bin where possible.
 */
export function logBandEdges(binCount: number, bandCount: number): number[] {
  if (bandCount < 1) throw new RangeError("bandCount must be >= 1");
  if (binCount < 1) throw new RangeError("binCount must be >= 1");

  const edges: number[] = new Array<number>(bandCount + 1);
  // Use bin index 1 as the low anchor (bin 0 is DC) so log() is finite.
  const minBin = 1;
  const maxBin = binCount;
  const logMin = Math.log(minBin);
  const logMax = Math.log(maxBin);

  edges[0] = 0;
  for (let i = 1; i <= bandCount; i++) {
    const t = i / bandCount;
    const edge = Math.exp(logMin + (logMax - logMin) * t);
    // Force monotonic, integer, and at least one bin wide per band.
    const prev = edges[i - 1] ?? 0;
    edges[i] = Math.max(Math.round(edge), prev + 1);
  }
  // Clamp the final edge to the available bins.
  edges[bandCount] = Math.min(edges[bandCount] ?? maxBin, maxBin);
  // Re-clamp any earlier edges that were pushed past the ceiling.
  for (let i = bandCount; i > 0; i--) {
    const cur = edges[i] ?? 0;
    const prev = edges[i - 1] ?? 0;
    if (prev >= cur) edges[i - 1] = Math.max(0, cur - 1);
  }
  return edges;
}

/**
 * Aggregate an FFT magnitude spectrum into `bandCount` log-spaced bands,
 * each normalized to [0, 1].
 *
 * @param magnitudes Linear magnitude per bin (any non-negative scale).
 * @param bandCount  Number of output bands.
 * @param maxMagnitude Value that maps to 1.0 (defaults to 255 for byte data).
 */
export function computeBands(
  magnitudes: Float32Array | Uint8Array,
  bandCount: number,
  maxMagnitude = 255,
): number[] {
  const binCount = magnitudes.length;
  const edges = logBandEdges(binCount, bandCount);
  const bands: number[] = new Array<number>(bandCount).fill(0);

  for (let b = 0; b < bandCount; b++) {
    const start = edges[b] ?? 0;
    const end = edges[b + 1] ?? start;
    let sum = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      sum += magnitudes[i] ?? 0;
      count++;
    }
    const mean = count > 0 ? sum / count : 0;
    bands[b] = clamp01(mean / maxMagnitude);
  }
  return bands;
}

/**
 * Collapse a band array into bass / mid / treble aggregate energies in [0, 1].
 */
export function bandGroups(
  bands: number[],
  split: BandSplit = DEFAULT_BAND_SPLIT,
): { bass: number; mid: number; treble: number } {
  const n = bands.length;
  if (n === 0) return { bass: 0, mid: 0, treble: 0 };

  const bassEnd = Math.max(1, Math.round(n * split.bass));
  const midEnd = Math.max(bassEnd + 1, Math.round(n * split.mid));

  return {
    bass: meanSlice(bands, 0, Math.min(bassEnd, n)),
    mid: meanSlice(bands, Math.min(bassEnd, n), Math.min(midEnd, n)),
    treble: meanSlice(bands, Math.min(midEnd, n), n),
  };
}

/**
 * Root-mean-square of a time-domain signal.
 *
 * Accepts either a `Float32Array` of samples in [-1, 1] (returns RMS in
 * [0, 1]) or a `Uint8Array` of byte samples centered at 128 (as produced by
 * `AnalyserNode.getByteTimeDomainData`), which is rescaled to [-1, 1] first.
 */
export function computeRms(samples: Float32Array | Uint8Array): number {
  const n = samples.length;
  if (n === 0) return 0;

  let sumSq = 0;
  if (samples instanceof Uint8Array) {
    for (let i = 0; i < n; i++) {
      const v = ((samples[i] ?? 128) - 128) / 128;
      sumSq += v * v;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const v = samples[i] ?? 0;
      sumSq += v * v;
    }
  }
  return clamp01(Math.sqrt(sumSq / n));
}

/** Exponential moving average: blend `prev` toward `next` by `(1 - smoothing)`. */
export function ema(prev: number, next: number, smoothing: number): number {
  const s = clamp01(smoothing);
  return prev * s + next * (1 - s);
}

/** Clamp a number into the [0, 1] range. */
export function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function meanSlice(arr: number[], start: number, end: number): number {
  let sum = 0;
  let count = 0;
  for (let i = start; i < end; i++) {
    sum += arr[i] ?? 0;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Spectral centroid — the energy-weighted mean bin position of a magnitude
 * spectrum, normalized to [0, 1] across the available bins.
 *
 * 0 maps to the lowest bin, 1 to the highest. A spectrum with energy
 * concentrated in high bins yields a value near 1 (bright); energy in low bins
 * yields a value near 0 (dark). Returns 0 for an empty or silent spectrum.
 *
 * Normalized in bin-index space so it needs no sample rate and stays a pure,
 * deterministic function of the spectrum alone.
 */
export function spectralCentroid(
  magnitudes: Float32Array | Uint8Array,
): number {
  const n = magnitudes.length;
  if (n <= 1) return 0;
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const m = magnitudes[i] ?? 0;
    weighted += i * m;
    total += m;
  }
  if (total <= 0) return 0;
  // Mean bin index in [0, n-1] -> normalize to [0, 1].
  return clamp01(weighted / total / (n - 1));
}

/**
 * Spectral rolloff — the normalized bin position [0, 1] below which `fraction`
 * (default 0.85) of the total spectral energy is contained.
 *
 * A bright spectrum (energy toward the highs) yields a high rolloff; a dark one
 * yields a low rolloff. Returns 0 for an empty or silent spectrum. `fraction`
 * is clamped to (0, 1].
 */
export function spectralRolloff(
  magnitudes: Float32Array | Uint8Array,
  fraction = 0.85,
): number {
  const n = magnitudes.length;
  if (n <= 1) return 0;
  const f = fraction <= 0 ? 0 : fraction > 1 ? 1 : fraction;
  let total = 0;
  for (let i = 0; i < n; i++) total += magnitudes[i] ?? 0;
  if (total <= 0) return 0;
  const target = total * f;
  let cumulative = 0;
  for (let i = 0; i < n; i++) {
    cumulative += magnitudes[i] ?? 0;
    if (cumulative >= target) {
      return clamp01(i / (n - 1));
    }
  }
  return 1;
}

/**
 * Crest factor mapped to [0, 1]: the ratio of a short-term (peak-ish) loudness
 * to a long-term (sustained) loudness, expressing how punchy the moment is.
 *
 * Returns 0 when `long` is ~0 or when short <= long (steady / no transient),
 * and rises toward 1 as the short-term level exceeds the sustained level. The
 * mapping `1 - long/short` keeps the result bounded and monotonic in the ratio.
 */
export function crestFactor(short: number, long: number): number {
  if (short <= 0) return 0;
  if (long <= 0) return short > 0 ? 1 : 0;
  if (short <= long) return 0;
  return clamp01(1 - long / short);
}

/**
 * Estimate tempo (BPM) from a series of onset timestamps (in seconds) using the
 * median inter-onset interval, clamped to a musical [minBpm, maxBpm] range.
 *
 * Deterministic and dependency-free: no autocorrelation FFT, just the median of
 * consecutive gaps, which is robust to the occasional missed/extra onset. The
 * median IOI is octave-folded into the target range (doubling/halving) so a
 * half-time or double-time interval still recovers a sensible tempo.
 *
 * Returns 0 when fewer than two onsets are available.
 */
export function estimateTempo(
  onsetTimes: readonly number[],
  minBpm = 60,
  maxBpm = 200,
): number {
  if (onsetTimes.length < 2) return 0;
  const intervals: number[] = [];
  for (let i = 1; i < onsetTimes.length; i++) {
    const dt = (onsetTimes[i] ?? 0) - (onsetTimes[i - 1] ?? 0);
    if (dt > 0) intervals.push(dt);
  }
  if (intervals.length === 0) return 0;
  intervals.sort((a, b) => a - b);
  const mid = Math.floor(intervals.length / 2);
  const median =
    intervals.length % 2 === 1
      ? (intervals[mid] ?? 0)
      : ((intervals[mid - 1] ?? 0) + (intervals[mid] ?? 0)) / 2;
  if (median <= 0) return 0;

  let bpm = 60 / median;
  // Octave-fold into [minBpm, maxBpm].
  while (bpm < minBpm) bpm *= 2;
  while (bpm > maxBpm) bpm /= 2;
  // Final clamp in case the range is narrower than an octave.
  if (bpm < minBpm) bpm = minBpm;
  if (bpm > maxBpm) bpm = maxBpm;
  return bpm;
}
