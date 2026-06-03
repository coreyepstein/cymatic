/**
 * Shared cinematic building blocks for the particle / fluid / 3D preset pack
 * (V2-13 rebuild).
 *
 * This pack is MADE for glow + trails + bloom: glowing additive particles that
 * smear into comet tails, a coarse advected dye field rendered as luminous
 * gradient/glow, and a seeded 3D point cloud projected to additive glows whose
 * depth drives brightness/size. Two properties from the original pack still
 * matter and are centralized here:
 *
 *   - DETERMINISM: every preset seeds a small, dependency-free PRNG
 *     ({@link mulberry32}) instead of `Math.random()` / `Date`, so the same seed
 *     plus the same audio/director/time inputs reproduce an identical draw set —
 *     reproducible and unit-testable across runs. The director's per-section
 *     {@link "@cymatic/core".DirectorState.seed} is folded in via
 *     {@link sectionSeed} so each section RE-SEEDS the system and looks fresh
 *     (no `Math.random` / `Date.now`).
 *   - PERFORMANCE: every preset exposes a configurable cap (particle / point
 *     count, grid size) with a sane default + a hard upper guard
 *     ({@link clampCount}) so it stays smooth at typical resolution.
 *
 * On top of that it adds the V2 *cinematic* surface shared by every pack: color
 * sampled from the director's crossfading palette + slow hue rotation
 * ({@link directorColor}), HDR helpers ({@link hot} / {@link dim}) to push glow
 * cores past white so bloom blooms them, a breathing beat envelope
 * ({@link BeatSwell}), and the pack's post-FX defaults ({@link particlePostFx})
 * — strong bloom + a long feedback trail so particles leave luminous comet tails.
 *
 * Everything here is pure / Node-testable and built only on the public
 * `@cymatic/core` surface (no raw WebGL/WebGPU).
 */

import {
  clamp01,
  mixColor,
  palettes,
  PALETTE_CATALOG,
  rotateHue,
  sampleBlended,
  type DirectorState,
  type Palette,
  type RgbaColor,
} from "@cymatic/core";

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
 * Fold a preset's base `seed` together with the director's per-section `seed`
 * into a single 32-bit seed. The director re-seeds on every section change, so
 * combining it here makes each section RE-SEED a preset's generator — the same
 * preset looks materially fresh per section (different particle layout / point
 * cloud / dye plume) while staying fully deterministic given the inputs. Pure +
 * exported so a test can assert two different director seeds yield a different
 * combined seed (and thus a different pattern).
 */
export function sectionSeed(base: number, directorSeed: number): number {
  // xorshift-mix the two seeds so neither dominates and small director-seed
  // deltas fully decorrelate the stream.
  let h = (base ^ Math.imul(directorSeed | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

/**
 * A frame-rate-independent exponential decay factor: the fraction of a value
 * that survives `dt` seconds given a `halfLife` (seconds to halve). Used to make
 * particle drag / dye dissipation decay at the same wall-clock rate regardless
 * of fps.
 */
export function decayFactor(dt: number, halfLife: number): number {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
  const hl = halfLife > 0 ? halfLife : 0.0001;
  return Math.pow(0.5, step / hl);
}

/** Clamp a particle/grid budget to a sane positive integer with an upper guard. */
export function clampCount(requested: number, fallback: number, max: number): number {
  const n = Number.isFinite(requested) ? Math.floor(requested) : fallback;
  if (n < 1) return 1;
  if (n > max) return max;
  return n;
}

// ---------------------------------------------------------------------------
// Cinematic surface (shared with the geometric / color-field / generative packs)
// ---------------------------------------------------------------------------

/**
 * Resolve the director's `paletteIndex` into the catalog {@link Palette}, with a
 * safe modulo so an out-of-range index never throws. The director's index space
 * is the catalog order ({@link PALETTE_CATALOG}), so an index maps 1:1.
 */
export function paletteForIndex(index: number): Palette {
  const n = PALETTE_CATALOG.length;
  if (n === 0) return palettes.sunset;
  const i = ((Math.trunc(index) % n) + n) % n;
  return PALETTE_CATALOG[i] ?? palettes.sunset;
}

/**
 * Sample a single evolving color from the director's state at ramp position `t`
 * (`[0, 1]`). This is the heart of "color evolves over a song":
 *   - it crossfades between the director's previous and target palettes by
 *     `paletteBlend` (so a section change visibly shifts the family), and
 *   - it rotates the resulting hue by `hueRotation` turns (a slow, continuous
 *     drift), so the color is never fixed.
 *
 * Pure + exported so a test can assert that two different director states (a
 * different `paletteBlend` / `hueRotation`) yield a materially different color.
 */
export function directorColor(director: DirectorState, t: number): RgbaColor {
  const from = paletteForIndex(director.prevPaletteIndex);
  const to = paletteForIndex(director.paletteIndex);
  const base = sampleBlended(from, to, clamp01(director.paletteBlend), clamp01(t));
  // `hueRotation` is in turns [0, 1); rotateHue takes degrees.
  return rotateHue(base, director.hueRotation * 360);
}

/**
 * Scale a color into HDR by `gain` (>1 pushes the core past white so the
 * renderer's bloom picks it up). Keeps alpha. Pure helper used to feed
 * `drawGlow` / additive draws their punch.
 */
export function hot(color: RgbaColor, gain: number): RgbaColor {
  const g = gain > 0 ? gain : 0;
  return { r: color.r * g, g: color.g * g, b: color.b * g, a: color.a };
}

/** Dim a color toward black by `amount` in `[0, 1]` (0 = unchanged). Keeps alpha. */
export function dim(color: RgbaColor, amount: number): RgbaColor {
  return mixColor(color, { r: 0, g: 0, b: 0, a: color.a }, clamp01(amount));
}

/**
 * One step of the beat-swell envelope: when an onset fires the swell jumps
 * toward 1, otherwise it decays exponentially toward 0 over `dt` seconds.
 * `halfLife` is the seconds for the swell to halve. The decay is ADDED to the
 * residual so rapid beats build a sustained glow rather than re-triggering a
 * hard flash. Pure + exported so a test can assert it rises on a beat and decays
 * gracefully (never snaps).
 */
export function decaySwell(current: number, onset: boolean, dt: number, halfLife = 0.4): number {
  const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const decay = halfLife > 0 ? Math.pow(0.5, safeDt / halfLife) : 0;
  const decayed = current * decay;
  return onset ? clamp01(decayed + 0.85) : clamp01(decayed);
}

/**
 * A stateful beat-swell envelope. Feed it `(onset, dt)` each frame and read a
 * smooth `[0, 1]` swell that rises on beats and decays gracefully between them.
 * Wraps {@link decaySwell} so the envelope math lives in one place.
 */
export class BeatSwell {
  private value: number;
  private readonly halfLife: number;

  constructor(halfLife = 0.4, initial = 0) {
    this.halfLife = halfLife;
    this.value = clamp01(initial);
  }

  /** Advance one frame and return the current swell. */
  update(onset: boolean, dt: number): number {
    this.value = decaySwell(this.value, onset, dt, this.halfLife);
    return this.value;
  }

  /** Current swell without advancing. */
  get current(): number {
    return this.value;
  }

  /** Reset to `value`. */
  reset(value = 0): void {
    this.value = clamp01(value);
  }
}

/**
 * The post-FX defaults the particle pack installs when a preset becomes active.
 * Particles + glow/trails is the whole point of this pack, so this leans HARD
 * into bloom + a long (bounded) feedback trail: the additive glow particles
 * smear into luminous COMET TAILS over many frames. `bloomAmount` (from a param
 * / the director) scales the bloom intensity so the glow builds and drops with
 * the song; `trailDecay` controls how long the comet tail lingers.
 */
export function particlePostFx(bloomAmount: number, trailDecay: number): {
  exposure: number;
  bloom: { enabled: boolean; threshold: number; intensity: number; radius: number };
  vignette: { enabled: boolean; amount: number };
  feedback: { enabled: boolean; decay: number };
} {
  const amt = clamp01(bloomAmount);
  // Cap the trail decay so the HDR history can't accumulate toward a flat white —
  // a long-but-bounded tail keeps the comet look while preserving palette hue.
  const decay = Math.min(0.93, clamp01(trailDecay));
  return {
    exposure: 1.05,
    // A punchy bloom: particle cores are tiny and bright, so a moderate
    // threshold + strong intensity makes the points bloom into glowing halos.
    bloom: { enabled: true, threshold: 0.6, intensity: 0.45 + amt * 1.2, radius: 1.6 },
    vignette: { enabled: true, amount: 0.32 },
    // Always on for this pack — the long (bounded) trail IS the comet tail.
    feedback: { enabled: true, decay },
  };
}
