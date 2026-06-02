/**
 * Seeded randomness + organic drift generators for the auto-director.
 *
 * Everything here is fully deterministic — no `Math.random`, no `Date.now`.
 * Given the same seed and the same sequence of calls, the output is identical
 * across runs and across machines, so offline rendering reproduces exactly.
 */

import { clamp01 } from "../audio/features.js";

/**
 * A deterministic pseudo-random number generator (mulberry32). Fast, tiny, and
 * good enough for visual drift. Stateful: each {@link Rng.next} call advances
 * the internal state and returns a float in `[0, 1)`.
 */
export class Rng {
  private state: number;

  /** Seed the generator. The same seed always produces the same stream. */
  constructor(seed: number) {
    // Coerce to a uint32 so fractional / negative seeds still behave.
    this.state = seed >>> 0;
  }

  /** Next float in `[0, 1)`. */
  next(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Next float in `[min, max)`. */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** A fresh uint32 seed derived from this generator (for re-seeding). */
  nextSeed(): number {
    return (this.next() * 4294967296) >>> 0;
  }
}

/**
 * Deterministically derive a child seed from a parent seed and a salt. Used to
 * re-seed per section so each section gets a fresh-but-reproducible stream.
 */
export function deriveSeed(seed: number, salt: number): number {
  let h = (seed >>> 0) ^ Math.imul(salt >>> 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Smootherstep interpolation (Perlin's quintic curve) for `t` in `[0, 1]`. */
function smootherstep(t: number): number {
  const k = clamp01(t);
  return k * k * k * (k * (k * 6 - 15) + 10);
}

/**
 * A 1-D value-noise generator: a deterministic, smoothly-interpolated pseudo-
 * random curve over a continuous input. Sampling the same input always returns
 * the same value, and nearby inputs return nearby values, so it reads as
 * organic drift rather than jitter. Output is in `[0, 1]`.
 *
 * Internally it hashes integer lattice points from the seed and smootherstep-
 * interpolates between them — no precomputed gradient table, no global state.
 */
export class ValueNoise {
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  /** Hash an integer lattice point to a float in `[0, 1)`. */
  private hash(i: number): number {
    let h = (this.seed ^ Math.imul(i | 0, 0x27d4eb2d)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  /** Sample the noise at continuous position `x`. Returns `[0, 1]`. */
  sample(x: number): number {
    const i = Math.floor(x);
    const f = x - i;
    const a = this.hash(i);
    const b = this.hash(i + 1);
    return clamp01(a + (b - a) * smootherstep(f));
  }
}

/**
 * A bounded low-frequency oscillator that drifts organically. Combines a slow
 * sinusoid with seeded value noise so the result wanders rather than tracing a
 * perfect sine. Output is in `[0, 1]`. Phase is advanced explicitly via `dt`
 * (seconds), so it is wall-clock free and works identically offline.
 */
export class Lfo {
  private readonly noise: ValueNoise;
  private readonly freq: number;
  private readonly noiseAmount: number;
  private phase: number;

  /**
   * @param seed         Determines the noise stream.
   * @param frequency    Base cycles per second of the sinusoidal component.
   * @param noiseAmount  Blend of value-noise vs sine, in `[0, 1]`. 0 = pure
   *                     sine, 1 = pure drift.
   * @param phase        Initial phase in cycles (default 0).
   */
  constructor(
    seed: number,
    frequency = 0.05,
    noiseAmount = 0.5,
    phase = 0,
  ) {
    this.noise = new ValueNoise(seed);
    this.freq = frequency;
    this.noiseAmount = clamp01(noiseAmount);
    this.phase = phase;
  }

  /** Advance by `dt` seconds and return the next value in `[0, 1]`. */
  step(dt: number): number {
    this.phase += this.freq * Math.max(0, dt);
    return this.value();
  }

  /** Current value in `[0, 1]` without advancing. */
  value(): number {
    const sine = 0.5 + 0.5 * Math.sin(this.phase * Math.PI * 2);
    const drift = this.noise.sample(this.phase);
    return clamp01(sine * (1 - this.noiseAmount) + drift * this.noiseAmount);
  }
}
