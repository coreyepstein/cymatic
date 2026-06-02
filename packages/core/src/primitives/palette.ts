/**
 * Color & palette primitives for @cymatic/core presets.
 *
 * Colors are the renderer's {@link RgbaColor} (channels in `[0, 1]`). This
 * module adds construction helpers, interpolation, and palette sampling, plus a
 * few tasteful built-in palettes. Everything is pure and Node-testable.
 */

import { clamp01 } from "../audio/features.js";
import { toRgba, type RgbaColor } from "../render/renderer.js";

export type { RgbaColor };

/** Construct an opaque {@link RgbaColor} from `[0, 1]` channels. */
export function rgb(r: number, g: number, b: number, a = 1): RgbaColor {
  return toRgba({ r, g, b, a });
}

/**
 * Construct a color from 8-bit channels (`0..255`). Convenience for porting
 * hex/CSS values; alpha is a `[0, 1]` float as usual.
 */
export function rgb255(r: number, g: number, b: number, a = 1): RgbaColor {
  return toRgba({ r: r / 255, g: g / 255, b: b / 255, a });
}

/**
 * Parse a `#rgb` / `#rrggbb` / `#rrggbbaa` hex string into an {@link RgbaColor}.
 * Throws on a malformed string so palettes fail loudly at author time.
 */
export function hex(value: string): RgbaColor {
  const s = value.trim().replace(/^#/, "");
  const expand = (h: string): number => parseInt(h.length === 1 ? h + h : h, 16);

  if (s.length === 3 || s.length === 4) {
    const r = expand(s[0] as string);
    const g = expand(s[1] as string);
    const b = expand(s[2] as string);
    const a = s.length === 4 ? expand(s[3] as string) / 255 : 1;
    return rgb255(r, g, b, a);
  }
  if (s.length === 6 || s.length === 8) {
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    const a = s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1;
    if ([r, g, b].some(Number.isNaN)) {
      throw new Error(`hex: malformed color "${value}"`);
    }
    return rgb255(r, g, b, a);
  }
  throw new Error(`hex: expected 3/4/6/8 hex digits, got "${value}"`);
}

/** Linearly interpolate between two colors (per-channel) by `t` in `[0, 1]`. */
export function mixColor(a: RgbaColor, b: RgbaColor, t: number): RgbaColor {
  const k = clamp01(t);
  return {
    r: a.r + (b.r - a.r) * k,
    g: a.g + (b.g - a.g) * k,
    b: a.b + (b.b - a.b) * k,
    a: a.a + (b.a - a.a) * k,
  };
}

/** Scale a color's alpha by `factor` (clamped), keeping RGB. */
export function withAlpha(color: RgbaColor, alpha: number): RgbaColor {
  return { r: color.r, g: color.g, b: color.b, a: clamp01(alpha) };
}

/**
 * An ordered list of color stops sampled as a continuous gradient. At least one
 * stop is required; sampling clamps to the ends.
 */
export interface Palette {
  /** Human-readable name (for registries / UIs). */
  readonly name: string;
  /** The gradient stops, evenly spaced across `[0, 1]`. */
  readonly stops: readonly RgbaColor[];
}

/** Build a {@link Palette} from a name and one or more stops. */
export function palette(name: string, stops: readonly RgbaColor[]): Palette {
  if (stops.length === 0) {
    throw new Error(`palette "${name}": needs at least one stop`);
  }
  return { name, stops };
}

/**
 * Sample a palette at `t` in `[0, 1]`, interpolating between evenly-spaced
 * stops. `t <= 0` returns the first stop; `t >= 1` returns the last.
 */
export function sample(p: Palette, t: number): RgbaColor {
  const stops = p.stops;
  const n = stops.length;
  if (n === 1) return stops[0] as RgbaColor;

  const k = clamp01(t);
  const scaled = k * (n - 1);
  const i = Math.min(Math.floor(scaled), n - 2);
  const frac = scaled - i;
  return mixColor(stops[i] as RgbaColor, stops[i + 1] as RgbaColor, frac);
}

/** A few tasteful built-in palettes presets can use out of the box. */
export const palettes = {
  /** Deep indigo → magenta → warm amber. */
  sunset: palette("sunset", [hex("#1a1147"), hex("#7b2ff7"), hex("#f72585"), hex("#ffba08")]),
  /** Cool teal → cyan → near-white. */
  aqua: palette("aqua", [hex("#03045e"), hex("#0077b6"), hex("#00b4d8"), hex("#caf0f8")]),
  /** Ember black → red → orange → white-hot. */
  ember: palette("ember", [hex("#0b0b0b"), hex("#9d0208"), hex("#e85d04"), hex("#ffea00")]),
  /** Neutral grayscale ramp. */
  mono: palette("mono", [hex("#000000"), hex("#ffffff")]),
} as const satisfies Record<string, Palette>;

/** Name of any built-in palette. */
export type PaletteName = keyof typeof palettes;
