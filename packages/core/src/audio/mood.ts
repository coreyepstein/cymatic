/**
 * MoodVector — a smoothed, high-level read of the music's *feel*, derived from
 * the raw {@link AudioFeatureFrame} signals so presets and the director can
 * react to musical mood without hand-wiring every low-level feature.
 *
 * Every dimension is normalized to [0, 1] and exponentially smoothed (EMA) so
 * it drifts rather than jitters frame-to-frame. The computation is a pure,
 * deterministic function of the input features and the previous mood state
 * (no `Date.now` / `Math.random`), so offline rendering reproduces exactly.
 */

import { clamp01, ema, type AudioFeatureFrame } from "./features.js";

/**
 * A high-level, smoothed snapshot of the musical *feel*. All fields are in
 * [0, 1] and drift gradually across frames.
 */
export interface MoodVector {
  /**
   * Overall intensity in [0, 1] — driven by the loudness envelope and how
   * densely onsets are arriving. Quiet/sparse → low; loud/busy → high.
   */
  energy: number;
  /**
   * Tonal brightness in [0, 1] — dark/warm (energy in the lows) → low;
   * bright/airy (energy spread toward the highs) → high. Blends the spectral
   * centroid and rolloff.
   */
  brightness: number;
  /**
   * Activity / complexity in [0, 1] — how much is *happening*. Combines onset
   * density with spectral flux (rate of spectral change).
   */
  busyness: number;
  /**
   * APPROXIMATE musical positivity in [0, 1] — a HEURISTIC PROXY, not true
   * musical valence. There is no key/mode detection here; this blends
   * brightness with an energy term as a rough "bright + lively feels happier"
   * stand-in. Treat as a vibe knob, not a musicological claim.
   */
  valence: number;
  /**
   * Punchy vs sustained in [0, 1] — reuses the crest/dynamics measure. ~0 for a
   * steady sustained level, rising toward 1 on sharp transients.
   */
  dynamics: number;
}

/** A neutral, all-zero mood — the resting state before any audio arrives. */
export const ZERO_MOOD: MoodVector = {
  energy: 0,
  brightness: 0,
  busyness: 0,
  valence: 0,
  dynamics: 0,
};

/** Tuning for {@link computeMood}. All fields optional. */
export interface MoodOptions {
  /**
   * EMA smoothing for the mood dimensions in [0, 1). Higher = smoother /
   * laggier (the mood drifts more slowly toward its target). Default `0.85`.
   */
  smoothing?: number;
  /**
   * Onset density (onsets/sec) that maps to a full "busy" reading. Densities at
   * or above this saturate the onset contribution. Default `6`.
   */
  onsetDensityFull?: number;
}

interface ResolvedMoodOptions {
  smoothing: number;
  onsetDensityFull: number;
}

const DEFAULTS: ResolvedMoodOptions = {
  smoothing: 0.85,
  onsetDensityFull: 6,
};

/**
 * Compute the next {@link MoodVector} from a raw feature frame and the previous
 * mood, applying per-dimension EMA smoothing so the result drifts rather than
 * snaps. Pure and deterministic — same inputs always yield the same output.
 *
 * @param features The latest raw audio feature frame.
 * @param prev     The previous mood (use {@link ZERO_MOOD} for the first frame).
 * @param options  Optional smoothing / normalization tuning.
 */
export function computeMood(
  features: AudioFeatureFrame,
  prev: MoodVector = ZERO_MOOD,
  options: MoodOptions = {},
): MoodVector {
  const opts: ResolvedMoodOptions = {
    smoothing: clamp01(options.smoothing ?? DEFAULTS.smoothing),
    onsetDensityFull:
      options.onsetDensityFull && options.onsetDensityFull > 0
        ? options.onsetDensityFull
        : DEFAULTS.onsetDensityFull,
  };

  // Normalized onset-density contribution in [0, 1].
  const density = clamp01(features.onsetDensity / opts.onsetDensityFull);
  // Flux is already a small per-bin average; treat it as roughly [0, 1] but
  // clamp defensively so a hot frame can't push mood out of range.
  const flux = clamp01(features.spectralFlux);

  // --- Targets (the instantaneous reading before smoothing) -----------------

  // Energy: the sustained loudness envelope lifted by onset activity. Loudness
  // dominates; density adds the "driving" feel of a busy passage.
  const energyTarget = clamp01(
    0.7 * features.loudnessLong + 0.3 * density,
  );

  // Brightness: blend centroid (center of mass) and rolloff (spread toward
  // highs). Both already normalized to [0, 1].
  const brightnessTarget = clamp01(
    0.6 * features.spectralCentroid + 0.4 * features.spectralRolloff,
  );

  // Busyness: how much is happening — onset density plus spectral change.
  const busynessTarget = clamp01(0.6 * density + 0.4 * flux);

  // Valence: APPROXIMATE proxy only. "Bright + lively" stands in for "happier".
  // No key/mode detection — see the MoodVector.valence doc.
  const valenceTarget = clamp01(
    0.6 * brightnessTarget + 0.4 * energyTarget,
  );

  // Dynamics: reuse the crest/dynamics measure directly (already [0, 1]).
  const dynamicsTarget = clamp01(features.dynamics);

  // --- Smooth each dimension toward its target ------------------------------
  const s = opts.smoothing;
  return {
    energy: ema(prev.energy, energyTarget, s),
    brightness: ema(prev.brightness, brightnessTarget, s),
    busyness: ema(prev.busyness, busynessTarget, s),
    valence: ema(prev.valence, valenceTarget, s),
    dynamics: ema(prev.dynamics, dynamicsTarget, s),
  };
}
