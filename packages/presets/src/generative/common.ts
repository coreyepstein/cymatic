/**
 * Shared building blocks for the generative / algorithmic preset pack.
 *
 * Generative presets evolve internal state (particle positions, a reaction
 * grid, an accumulating plotter path) and visualize it as many small rects.
 * Two properties matter for this pack and are centralized here:
 *
 *   - DETERMINISM: every preset seeds a small, dependency-free PRNG
 *     ({@link mulberry32}) instead of `Math.random()`, so the same seed plus the
 *     same audio/time inputs reproduce an identical draw set — reproducible and
 *     unit-testable across runs.
 *   - A SMOOTH NOISE FIELD: a cheap, deterministic value-noise sampler
 *     ({@link valueNoise2D}) used to advect particles, so the flow field is
 *     organic without pulling in a noise dependency.
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

/** The default seed every generative preset uses unless told otherwise. */
export const DEFAULT_SEED = 0x9e3779b9;

/**
 * Deterministic 2D hash in `[0, 1)` for integer lattice coordinates, salted by
 * `seed`. The grid corner values {@link valueNoise2D} interpolates between.
 */
function hash2D(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ (seed | 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 1 | h);
  h = (h + Math.imul(h ^ (h >>> 7), 61 | h)) ^ h;
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
}

/** Smoothstep fade `6t^5 - 15t^4 + 10t^3` for value-noise interpolation. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Linear interpolation helper local to the noise sampler. */
function nlerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Deterministic smooth value noise in `[0, 1]` at continuous `(x, y)`, salted by
 * `seed`. Bilinear interpolation of hashed lattice corners with a smoothstep
 * fade — cheap, dependency-free, and stable for a given seed. Exported so the
 * flow field (and tests) can sample a reproducible vector field.
 */
export function valueNoise2D(x: number, y: number, seed = 0): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const c00 = hash2D(x0, y0, seed);
  const c10 = hash2D(x0 + 1, y0, seed);
  const c01 = hash2D(x0, y0 + 1, seed);
  const c11 = hash2D(x0 + 1, y0 + 1, seed);
  const top = nlerp(c00, c10, fx);
  const bot = nlerp(c01, c11, fx);
  return clamp01(nlerp(top, bot, fy));
}

/**
 * The flow angle (radians) of the vector field at `(x, y)`. The noise value is
 * scaled up to several turns so neighbouring cells point in smoothly-varying but
 * meaningfully different directions. Pure + exported so a test can confirm the
 * field is deterministic and that `scale` actually changes the field geometry.
 */
export function flowAngle(x: number, y: number, scale: number, seed = 0): number {
  const n = valueNoise2D(x * scale, y * scale, seed);
  return n * Math.PI * 4;
}

/** Wrap a normalized coordinate into `[0, 1)` (toroidal field) without bias. */
export function wrap01(v: number): number {
  const r = v - Math.floor(v);
  return r < 0 ? r + 1 : r;
}
