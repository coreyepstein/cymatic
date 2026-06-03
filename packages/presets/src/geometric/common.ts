/**
 * Shared cinematic building blocks for the geometric / Swiss / Bauhaus pack
 * (V2-10).
 *
 * The rebuilt geometric pack is crisp geometry that *glows and breathes*: it
 * samples color from the auto-director's crossfading palette + hue rotation (so
 * color evolves over a track), drives scale / contrast / glow from audio AND the
 * director's macro signals (intensity / motion / density), and leans on additive
 * glow + bloom + light feedback trails for a cinematic feel.
 *
 * Everything here is pure and built only on the public `@cymatic/core` surface
 * (palette sampling, the director state shape, easing). No raw GL/GPU, no
 * `Date.now` / `Math.random` — so presets stay deterministic given
 * `(features, director, time, seed)` and testable with a recording renderer.
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
 * Resolve the director's `paletteIndex` into the catalog {@link Palette}, with a
 * safe modulo so an out-of-range index never throws. The director's index space
 * is {@link DIRECTOR_PALETTE_ORDER}; the catalog is {@link PALETTE_CATALOG} in
 * the same order, so an index maps 1:1.
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
 * A stateful beat-flash envelope: an onset injects energy toward 1, which then
 * decays exponentially toward 0 over `dt`. Identical math to the colorfield
 * swell, kept local so the geometric pack reads self-contained. Pure stepping
 * (`step`) is exported for direct testing.
 */
export function stepFlash(current: number, onset: boolean, dt: number, halfLife = 0.18): number {
  const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const decay = halfLife > 0 ? Math.pow(0.5, safeDt / halfLife) : 0;
  const decayed = current * decay;
  return onset ? clamp01(decayed + 0.9) : clamp01(decayed);
}

/** Stateful wrapper around {@link stepFlash} — the beat-flash strength `[0,1]`. */
export class BeatFlash {
  private value: number;
  private readonly halfLife: number;

  constructor(halfLife = 0.18, initial = 0) {
    this.halfLife = halfLife;
    this.value = clamp01(initial);
  }

  /** Advance one frame and return the current flash strength. */
  update(onset: boolean, dt: number): number {
    this.value = stepFlash(this.value, onset, dt, this.halfLife);
    return this.value;
  }

  /** Current strength without advancing. */
  get current(): number {
    return this.value;
  }

  /** Reset to `value`. */
  reset(value = 0): void {
    this.value = clamp01(value);
  }
}

/**
 * The post-FX defaults the geometric pack installs when a preset becomes active:
 * bloom on (so the additive glow blooms), gentle exposure, a subtle vignette to
 * pull the eye in, and light feedback so motion leaves a faint luminous trail.
 * `bloomAmount` (from a param / the director) scales the bloom intensity so the
 * glow builds and drops with the song.
 */
export function geometricPostFx(bloomAmount: number, feedbackDecay: number): {
  exposure: number;
  bloom: { enabled: boolean; threshold: number; intensity: number; radius: number };
  vignette: { enabled: boolean; amount: number };
  feedback: { enabled: boolean; decay: number };
} {
  const amt = clamp01(bloomAmount);
  return {
    exposure: 1.05,
    bloom: { enabled: true, threshold: 0.65, intensity: 0.4 + amt * 1.0, radius: 1.4 },
    vignette: { enabled: true, amount: 0.32 },
    feedback: { enabled: feedbackDecay > 0, decay: clamp01(feedbackDecay) },
  };
}
