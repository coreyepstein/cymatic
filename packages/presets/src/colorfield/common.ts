/**
 * Shared building blocks for the color-field preset pack.
 *
 * Color-field presets are about slow, breathing atmospheres, so they all lean
 * on the same two ideas: very heavy smoothing of audio features, and a beat
 * response that is a gentle, exponentially-decaying *swell* rather than a hard
 * per-frame flash. These helpers centralize both so every field moves the same
 * graceful way. All pure / Node-testable; built only on the public
 * `@cymatic/core` surface.
 */

import { clamp01 } from "@cymatic/core";

/**
 * The smoothing weight (kept-from-previous fraction) every field uses. High on
 * purpose: loudness/band changes take many frames to move the visuals, which is
 * the whole point of this direction. Exported so tests can reason about it.
 */
export const FIELD_SMOOTHING = 0.92;

/**
 * How many strips a smooth gradient is rendered as. Enough that the banding is
 * invisible at any reasonable resolution; few enough to stay cheap. Pure getter
 * so call sites read intent rather than a magic number.
 */
export function gradientStripCount(): number {
  return 48;
}

/**
 * One step of the beat swell envelope: when an onset fires the swell jumps
 * toward 1, otherwise it decays exponentially toward 0 over `dt` seconds.
 * `halfLife` is the seconds for the swell to halve. Pure + exported so a test
 * can assert it rises on a beat and decays gracefully (never snaps to 0).
 */
export function decaySwell(current: number, onset: boolean, dt: number, halfLife = 0.6): number {
  const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
  // Exponential decay: factor halves every `halfLife` seconds.
  const decay = halfLife > 0 ? Math.pow(0.5, safeDt / halfLife) : 0;
  const decayed = current * decay;
  // A beat injects energy, but it adds to (and is capped with) the residual so
  // rapid beats build a sustained glow rather than re-triggering a hard flash.
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
