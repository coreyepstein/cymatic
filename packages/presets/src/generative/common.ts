/**
 * Shared cinematic building blocks for the generative / algorithmic preset pack
 * (V2-12 rebuild).
 *
 * The rebuilt generative pack is about *luminous algorithmic art*: particles
 * advected through a noise field rendered as additive glow points that smear
 * into long feedback trails (luminous ribbons), a reaction-diffusion bath whose
 * concentration becomes glowing color, and a pen-plotter that inks glowing
 * additive lines. Two properties from the original pack still matter and are
 * centralized here:
 *
 *   - DETERMINISM: every preset seeds a small, dependency-free PRNG
 *     ({@link mulberry32}) instead of `Math.random()`, so the same seed plus the
 *     same audio/director/time inputs reproduce an identical draw set —
 *     reproducible and unit-testable across runs. The director's per-section
 *     {@link "@cymatic/core".DirectorState.seed} is folded in via
 *     {@link sectionSeed} so each section RE-SEEDS the generator and looks fresh
 *     (no `Math.random` / `Date.now`).
 *   - A SMOOTH NOISE FIELD: a cheap, deterministic value-noise sampler
 *     ({@link valueNoise2D}) used to advect particles, so the flow field is
 *     organic without pulling in a noise dependency.
 *
 * On top of that it adds the V2 *cinematic* surface shared by every pack: color
 * sampled from the director's crossfading palette + slow hue rotation
 * ({@link directorColor}), HDR helpers ({@link hot} / {@link dim}) to push glow
 * cores past white so bloom blooms them, a breathing beat envelope
 * ({@link BeatSwell}), and the pack's post-FX defaults ({@link generativePostFx})
 * — bloom + a long feedback trail so glow points leave luminous ribbons.
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

/** The default seed every generative preset uses unless told otherwise. */
export const DEFAULT_SEED = 0x9e3779b9;

/**
 * Fold a preset's base `seed` together with the director's per-section `seed`
 * into a single 32-bit seed. The director re-seeds on every section change, so
 * combining it here makes each section RE-SEED a preset's generator — the same
 * preset looks materially fresh per section (different particle layout / reaction
 * nuclei / plotter figure) while staying fully deterministic given the inputs.
 * Pure + exported so a test can assert that two different director seeds yield a
 * different combined seed (and thus a different pattern).
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

// ---------------------------------------------------------------------------
// Cinematic surface (shared with the geometric / color-field packs)
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
export function decaySwell(current: number, onset: boolean, dt: number, halfLife = 0.45): number {
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

  constructor(halfLife = 0.45, initial = 0) {
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
 * The post-FX defaults the generative pack installs when a preset becomes
 * active. Generative art + glow/trails is the whole point of this pack, so this
 * leans into bloom + a long (bounded) feedback trail: the additive glow points /
 * lines smear into luminous RIBBONS over many frames. `bloomAmount` (from a
 * param / the director) scales the bloom intensity so the glow builds and drops
 * with the song; `trailDecay` controls how long the feedback ribbon lingers.
 */
export function generativePostFx(bloomAmount: number, trailDecay: number): {
  exposure: number;
  bloom: { enabled: boolean; threshold: number; intensity: number; radius: number };
  vignette: { enabled: boolean; amount: number };
  feedback: { enabled: boolean; decay: number };
} {
  const amt = clamp01(bloomAmount);
  // Cap the trail decay so the HDR history can't accumulate toward a flat white —
  // a long-but-bounded tail keeps the ribbon look while preserving palette hue.
  const decay = Math.min(0.92, clamp01(trailDecay));
  return {
    exposure: 1.05,
    // A punchy bloom: generative cores are small and bright, so a moderate
    // threshold + strong intensity makes the points/lines bloom into halos.
    bloom: { enabled: true, threshold: 0.6, intensity: 0.4 + amt * 1.1, radius: 1.5 },
    vignette: { enabled: true, amount: 0.3 },
    // Always on for this pack — the long (bounded) trail IS the luminous ribbon.
    feedback: { enabled: true, decay },
  };
}
