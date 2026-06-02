/**
 * Audio-feature binding primitives for @cymatic/core presets.
 *
 * These helpers turn an {@link AudioFeatureFrame} (from the audio engine) into
 * visual parameters: reading a named band group, indexing the raw band array,
 * mapping a feature through a range, reacting to onsets, and smoothing a feature
 * over frames. They are the documented bridge between audio and visuals so
 * presets never poke at frame internals ad hoc.
 *
 * Smoothing reuses the audio engine's EMA (via {@link Smoother}); range mapping
 * reuses {@link mapRange}. No DSP is duplicated here.
 */

import type { AudioFeatureFrame } from "../audio/features.js";
import { clamp01 } from "../audio/features.js";
import { mapRange, Smoother } from "./easing.js";

/** A named, aggregate band group exposed on every frame. */
export type BandName = "bass" | "mid" | "treble";

/**
 * Read a named band-group energy (`bass` / `mid` / `treble`) from a frame,
 * normalized to `[0, 1]`. The canonical way for a preset to ask "how much bass
 * is there right now?".
 */
export function band(features: AudioFeatureFrame, name: BandName): number {
  return clamp01(features[name]);
}

/**
 * Read a single raw band by index from `features.bands`, normalized to
 * `[0, 1]`. Out-of-range indices return `0` (safe for presets that assume a
 * band count larger than the live one).
 */
export function bandAt(features: AudioFeatureFrame, index: number): number {
  const value = features.bands[index];
  return value == null ? 0 : clamp01(value);
}

/** Overall RMS loudness of the frame, normalized to `[0, 1]`. */
export function level(features: AudioFeatureFrame): number {
  return clamp01(features.rms);
}

/**
 * Map a feature `value` (assumed in `[0, 1]`) onto an output range. Thin,
 * intention-revealing wrapper over {@link mapRange} for the common
 * audio→visual case (e.g. `mapFeature(band(f, "bass"), 0.2, 2.0)` to scale a
 * radius). The input range defaults to the feature's natural `[0, 1]`.
 */
export function mapFeature(
  value: number,
  outMin: number,
  outMax: number,
  inMin = 0,
  inMax = 1,
): number {
  return mapRange(value, inMin, inMax, outMin, outMax);
}

/**
 * Invoke `cb` when `features.onset` is true for this frame. Returns whether the
 * callback fired, so it also reads as a boolean guard. Keeps onset reactions
 * declarative inside a preset's `update`.
 */
export function onBeat(features: AudioFeatureFrame, cb: () => void): boolean {
  if (features.onset) {
    cb();
    return true;
  }
  return false;
}

/**
 * A stateful smoothing binding for one named band group. Push frames in; read a
 * smoothed `[0, 1]` value out. Wraps {@link Smoother} so the EMA math is shared
 * with the audio engine rather than reimplemented.
 */
export class BandSmoother {
  private readonly smoother: Smoother;
  private readonly name: BandName;

  constructor(name: BandName, smoothing = 0.8) {
    this.name = name;
    this.smoother = new Smoother(smoothing, 0);
  }

  /** Feed a frame and return the smoothed band value. */
  push(features: AudioFeatureFrame): number {
    return this.smoother.push(band(features, this.name));
  }

  /** Current smoothed value without advancing. */
  get current(): number {
    return this.smoother.current;
  }
}

/** Construct a {@link BandSmoother} for `name`. */
export function smoothBand(name: BandName, smoothing = 0.8): BandSmoother {
  return new BandSmoother(name, smoothing);
}
