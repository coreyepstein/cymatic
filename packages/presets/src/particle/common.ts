/**
 * Shared building blocks for the particle / fluid / 3D preset pack.
 *
 * These presets evolve internal physical-ish state — a bounded particle system,
 * a coarse advected dye field, a projected rotating point cloud — and visualize
 * it as many small rects through the backend-agnostic {@link Renderer}. Two
 * properties matter for this pack and are centralized here:
 *
 *   - DETERMINISM: every preset seeds a small, dependency-free PRNG
 *     ({@link mulberry32}) instead of `Math.random()` / `Date`, so the same seed
 *     plus the same audio/time inputs reproduce an identical draw set —
 *     reproducible and unit-testable across runs.
 *   - PERFORMANCE: every preset exposes a configurable cap (particle count or
 *     grid size) with a sane default so it stays smooth at typical resolution.
 *
 * Everything here is pure / Node-testable and built only on the public
 * `@cymatic/core` surface (no raw WebGL/WebGPU).
 */

import { clamp01 } from "@cymatic/core";

/**
 * A small, fast, deterministic PRNG (mulberry32). Given a 32-bit integer seed it
 * returns a function that yields the next float in `[0, 1)`. Used everywhere in
 * this pack in place of `Math.random()` so output is reproducible. Exported so
 * tests can assert identical streams for identical seeds.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The default seed every particle preset uses unless told otherwise. */
export const DEFAULT_SEED = 0x1f123bb5;

/**
 * A frame-rate-independent exponential decay factor: the fraction of a value
 * that survives `dt` seconds given a `halfLife` (seconds to halve). Used to make
 * beat bursts and trails decay at the same wall-clock rate regardless of fps.
 */
export function decayFactor(dt: number, halfLife: number): number {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
  const hl = halfLife > 0 ? halfLife : 0.0001;
  return Math.pow(0.5, step / hl);
}

/**
 * Advance a decaying "beat burst" envelope: jump toward `peak` on an onset,
 * otherwise decay toward zero. Clamped to `[0, 1]`. Pure + exported so presets
 * and tests share one envelope shape.
 */
export function advanceBurst(
  current: number,
  onset: boolean,
  dt: number,
  halfLife = 0.4,
  peak = 0.85,
): number {
  const decayed = current * decayFactor(dt, halfLife);
  return clamp01(onset ? decayed + peak : decayed);
}

/** Clamp a particle/grid budget to a sane positive integer with an upper guard. */
export function clampCount(requested: number, fallback: number, max: number): number {
  const n = Number.isFinite(requested) ? Math.floor(requested) : fallback;
  if (n < 1) return 1;
  if (n > max) return max;
  return n;
}
