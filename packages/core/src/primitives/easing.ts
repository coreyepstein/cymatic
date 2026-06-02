/**
 * Easing & smoothing primitives for @cymatic/core presets.
 *
 * All easing functions are pure: they map a normalized progress `t` in `[0, 1]`
 * to an eased value, are defined so `f(0) === 0` and `f(1) === 1`, and clamp
 * out-of-range input. They have no dependency on audio, time, or the renderer,
 * so they are trivially unit-testable in Node.
 *
 * `smoothing` helpers wrap the exponential moving average from the audio engine
 * (see `../audio/features.ts`) so presets get framerate-aware smoothing without
 * duplicating the DSP.
 */

import { clamp01, ema } from "../audio/features.js";

/** A pure easing function: normalized progress in → eased progress out. */
export type EasingFn = (t: number) => number;

function unit(t: number): number {
  return clamp01(t);
}

/** Linear (identity) easing. */
export const linear: EasingFn = (t) => unit(t);

/** Quadratic ease-in. */
export const easeInQuad: EasingFn = (t) => {
  const x = unit(t);
  return x * x;
};

/** Quadratic ease-out. */
export const easeOutQuad: EasingFn = (t) => {
  const x = unit(t);
  return x * (2 - x);
};

/** Quadratic ease-in-out. */
export const easeInOutQuad: EasingFn = (t) => {
  const x = unit(t);
  return x < 0.5 ? 2 * x * x : -1 + (4 - 2 * x) * x;
};

/** Cubic ease-in. */
export const easeInCubic: EasingFn = (t) => {
  const x = unit(t);
  return x * x * x;
};

/** Cubic ease-out. */
export const easeOutCubic: EasingFn = (t) => {
  const x = unit(t) - 1;
  return x * x * x + 1;
};

/** Cubic ease-in-out. */
export const easeInOutCubic: EasingFn = (t) => {
  const x = unit(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

/** Sinusoidal ease-in-out — a gentle, natural curve. */
export const easeInOutSine: EasingFn = (t) => {
  const x = unit(t);
  return -(Math.cos(Math.PI * x) - 1) / 2;
};

/** Exponential ease-out — fast attack, slow settle. */
export const easeOutExpo: EasingFn = (t) => {
  const x = unit(t);
  return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
};

/** A named registry of the built-in easing functions. */
export const easings = {
  linear,
  easeInQuad,
  easeOutQuad,
  easeInOutQuad,
  easeInCubic,
  easeOutCubic,
  easeInOutCubic,
  easeInOutSine,
  easeOutExpo,
} as const satisfies Record<string, EasingFn>;

/** Name of any built-in easing. */
export type EasingName = keyof typeof easings;

/**
 * Linear interpolation between `a` and `b` by `t`. `t` is NOT clamped, so this
 * doubles as extrapolation; clamp `t` yourself with {@link clamp01} if needed.
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Re-map `value` from the input range `[inMin, inMax]` to `[outMin, outMax]`.
 * The result is clamped to the output range, and a zero-width input range maps
 * to `outMin` (no divide-by-zero). This is the workhorse for turning an audio
 * feature in `[0, 1]` into a visual parameter in any range.
 */
export function mapRange(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  const span = inMax - inMin;
  if (span === 0) return outMin;
  const t = (value - inMin) / span;
  const clampedT = t < 0 ? 0 : t > 1 ? 1 : t;
  return outMin + (outMax - outMin) * clampedT;
}

/**
 * A stateful exponential smoother. Feed it a noisy per-frame signal and read a
 * smoothed value back; `smoothing` in `[0, 1]` is the weight kept from the
 * previous value (higher = smoother / slower). Reuses the audio engine's
 * {@link ema} so the smoothing math lives in one place.
 *
 * Use {@link makeSmoother} to construct one without `new`.
 */
export class Smoother {
  private value: number;
  private readonly smoothing: number;

  constructor(smoothing = 0.8, initial = 0) {
    this.smoothing = clamp01(smoothing);
    this.value = initial;
  }

  /** Push a new sample and return the updated smoothed value. */
  push(next: number): number {
    this.value = ema(this.value, next, this.smoothing);
    return this.value;
  }

  /** The current smoothed value without advancing. */
  get current(): number {
    return this.value;
  }

  /** Reset the smoother to `value`. */
  reset(value = 0): void {
    this.value = value;
  }
}

/** Construct a {@link Smoother}. */
export function makeSmoother(smoothing = 0.8, initial = 0): Smoother {
  return new Smoother(smoothing, initial);
}
