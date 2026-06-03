/**
 * Shared cinematic building blocks for the color-field / Rothko-adjacent pack
 * (V2-11 rebuild).
 *
 * The rebuilt color-field pack is about luminous, breathing color *atmospheres*
 * rather than crisp geometry: dreamy gradient fields lit by soft additive glow,
 * heavy bloom, and slow feedback trails. Everything moves slowly and never
 * jitters — bass drives luminance / scale, brightness/centroid drive hue and
 * airiness, and a beat is a gentle, exponentially-decaying *swell* (never a hard
 * flash). Color evolves over the whole track by sampling the auto-director's
 * crossfading palette + slow hue rotation, so a section change visibly shifts
 * the mood (breakdown = darker/quieter, drop = brighter/wider).
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
 * The smoothing weight (kept-from-previous fraction) the color-field pack uses
 * for its audio envelopes. High on purpose: loudness / band changes take many
 * frames to move the visuals, which is the whole point of this direction.
 * Exported so tests can reason about it.
 */
export const FIELD_SMOOTHING = 0.92;

/**
 * How many strips a smooth gradient is rendered as when a preset stacks
 * `drawGradientRect` bands. Enough that banding is invisible at any reasonable
 * resolution; few enough to stay cheap. Pure getter so call sites read intent
 * rather than a magic number.
 */
export function gradientStripCount(): number {
  return 48;
}

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
 * hard flash — gentle and breathing, the color-field signature. Pure + exported
 * so a test can assert it rises on a beat and decays gracefully (never snaps).
 */
export function decaySwell(current: number, onset: boolean, dt: number, halfLife = 0.6): number {
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

  constructor(halfLife = 0.6, initial = 0) {
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
 * The post-FX defaults the color-field pack installs when a preset becomes
 * active. This is the pack where bloom + feedback SHINE: strong bloom so the
 * additive glow blooms into luminous halos, gentle exposure, a soft vignette to
 * pull the eye into the field, and HEAVY feedback so the slowly-breathing color
 * leaves long, dreamy trails. `bloomAmount` (from a param / the director) scales
 * the bloom intensity so the glow builds and drops with the song; `trailDecay`
 * controls how long the feedback tail lingers.
 */
export function colorfieldPostFx(bloomAmount: number, trailDecay: number): {
  exposure: number;
  bloom: { enabled: boolean; threshold: number; intensity: number; radius: number };
  vignette: { enabled: boolean; amount: number };
  feedback: { enabled: boolean; decay: number };
} {
  const amt = clamp01(bloomAmount);
  // Cap the trail decay so the HDR history can't accumulate toward a flat white —
  // a long-but-bounded tail keeps the dreamy look while preserving color (a decay
  // near 1 would wash every pixel to white and erase the palette hue).
  const decay = Math.min(0.7, clamp01(trailDecay));
  return {
    exposure: 1.0,
    // A wide, soft bloom (color fields are soft, so we want the lit haze to
    // spread) but a higher threshold + lower intensity than a flash-y pack, so
    // only the bright cores bloom and the field keeps its palette color instead
    // of clipping to white.
    bloom: { enabled: true, threshold: 0.8, intensity: 0.35 + amt * 0.6, radius: 1.7 },
    vignette: { enabled: true, amount: 0.3 },
    // Always on for this pack — the long (bounded) trail is the dreamy look.
    feedback: { enabled: true, decay },
  };
}
