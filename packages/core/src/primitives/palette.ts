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

/**
 * Sample a palette as a continuous gradient ramp at `t` in `[0, 1]`.
 *
 * This is the cinematic-facing name for {@link sample}: identical behavior
 * (linear per-channel interpolation between evenly-spaced stops, clamped at the
 * ends), exposed under a clearer "ramp" vocabulary for color-evolution code.
 */
export function sampleRamp(p: Palette, t: number): RgbaColor {
  return sample(p, t);
}

/**
 * Crossfade two palettes into a new {@link Palette}.
 *
 * The result has as many stops as the longer input; each output stop position
 * is sampled from *both* inputs (so palettes of different stop counts still
 * blend smoothly) and mixed by `blend`. `blend <= 0` reproduces `a`'s ramp,
 * `blend >= 1` reproduces `b`'s ramp. The result is HDR-safe (channels are
 * mixed, not re-clamped beyond the inputs).
 */
export function blendPalettes(a: Palette, b: Palette, blend: number): Palette {
  const k = clamp01(blend);
  const n = Math.max(a.stops.length, b.stops.length, 2);
  const stops: RgbaColor[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    stops.push(mixColor(sample(a, t), sample(b, t), k));
  }
  return { name: `${a.name}→${b.name}`, stops };
}

/**
 * Sample the crossfade of two palettes directly at ramp position `t`, with
 * crossfade amount `blend`. Equivalent to `sample(blendPalettes(a, b, blend),
 * t)` but allocation-free — the director calls this per frame.
 *
 * At `blend = 0` this equals `sampleRamp(a, t)`; at `blend = 1`,
 * `sampleRamp(b, t)`.
 */
export function sampleBlended(
  a: Palette,
  b: Palette,
  blend: number,
  t: number,
): RgbaColor {
  return mixColor(sample(a, t), sample(b, t), clamp01(blend));
}

/**
 * Rotate a color's hue by `degrees` (any real number; wraps mod 360), keeping
 * its perceived saturation, lightness, and alpha. `0` (or any multiple of 360)
 * is an identity; `180` produces the opposing hue. Works in HSL space; HDR
 * channels above `1` are normalized into the rotation and restored in scale, so
 * hot stops keep their punch.
 */
export function rotateHue(color: RgbaColor, degrees: number): RgbaColor {
  // Preserve HDR magnitude: rotate the unit-scaled color, then rescale.
  const peak = Math.max(color.r, color.g, color.b, 1);
  const { h, s, l } = rgbToHsl(color.r / peak, color.g / peak, color.b / peak);
  let hue = (h + degrees / 360) % 1;
  if (hue < 0) hue += 1;
  const { r, g, b } = hslToRgb(hue, s, l);
  return { r: r * peak, g: g * peak, b: b * peak, a: color.a };
}

/** Convert linear-ish `[0,1]` RGB → HSL (all channels `[0,1]`, hue in turns). */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h / 6, s, l };
}

/** Convert HSL (hue in turns `[0,1)`, s/l `[0,1]`) → `[0,1]` RGB. */
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  if (s === 0) return { r: l, g: l, b: l };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hue2rgb(p, q, h + 1 / 3),
    g: hue2rgb(p, q, h),
    b: hue2rgb(p, q, h - 1 / 3),
  };
}

function hue2rgb(p: number, q: number, t: number): number {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}

/**
 * The cinematic palette catalog — a curated set of named, multi-stop gradients
 * tuned to feel moody and luminous rather than garish. Each is an ordered list
 * of stops sampled as a continuous ramp via {@link sampleRamp}. The auto-director
 * rotates and crossfades through these over a track.
 */
export const palettes = {
  // --- Originals (kept for back-compat with existing presets) --------------
  /** Deep indigo → magenta → warm amber. */
  sunset: palette("sunset", [hex("#1a1147"), hex("#7b2ff7"), hex("#f72585"), hex("#ffba08")]),
  /** Cool teal → cyan → near-white. */
  aqua: palette("aqua", [hex("#03045e"), hex("#0077b6"), hex("#00b4d8"), hex("#caf0f8")]),
  /** Neutral grayscale ramp. */
  mono: palette("mono", [hex("#000000"), hex("#ffffff")]),

  // --- Cinematic catalog ---------------------------------------------------
  /** Ember black → deep red → orange → white-hot. */
  ember: palette("ember", [hex("#0b0707"), hex("#5c0a0a"), hex("#c1330b"), hex("#f97c14"), hex("#ffd27a")]),
  /** Midnight blues, the deep quiet of late night. */
  nocturne: palette("nocturne", [hex("#05060f"), hex("#101a3a"), hex("#27407a"), hex("#5d7bc4"), hex("#aebfe6")]),
  /** Northern-lights green → teal → violet over a near-black sky. */
  aurora: palette("aurora", [hex("#020a12"), hex("#0c3b32"), hex("#1d9a6c"), hex("#3fd3a3"), hex("#9a6cff")]),
  /** Sodium streetlight amber — warm orange monochrome glow. */
  sodium: palette("sodium", [hex("#0d0700"), hex("#3d1c01"), hex("#8a4a06"), hex("#df8a1f"), hex("#ffce7a")]),
  /** Ultraviolet — black-light violet, magenta, electric blue. */
  ultraviolet: palette("ultraviolet", [hex("#06010f"), hex("#2a0a52"), hex("#6a1fd0"), hex("#c13ff0"), hex("#7ad0ff")]),
  /** Mono gold — burnished, single-hue luxury gradient. */
  monoGold: palette("monoGold", [hex("#0c0a04"), hex("#3a2c0c"), hex("#7a5c1e"), hex("#c79a3c"), hex("#f6e2a0")]),
  /** Ice — glacial blues into frost white. */
  ice: palette("ice", [hex("#03121c"), hex("#0d4a63"), hex("#2a9bb8"), hex("#8fd9e8"), hex("#eafbff")]),
  /** Bloodmoon — bruised crimson, dried blood, lunar bone. */
  bloodmoon: palette("bloodmoon", [hex("#0a0405"), hex("#3a0810"), hex("#7d1322"), hex("#c0394a"), hex("#e9a39c")]),
  /** Verdant — mossy forest greens with a luminous canopy edge. */
  verdant: palette("verdant", [hex("#04100a"), hex("#0f3a22"), hex("#2f7a3f"), hex("#7ec46b"), hex("#dcf0b0")]),
  /** Pastel haze — soft dawn pinks, lilac, and pale gold. */
  pastelHaze: palette("pastelHaze", [hex("#241a2e"), hex("#6b5a8a"), hex("#c79fc4"), hex("#f3c6c0"), hex("#fdeccf")]),
  /** Cyberpunk neon — inky base into hot magenta and cyan. */
  neon: palette("neon", [hex("#070310"), hex("#2b0a4a"), hex("#e01f8b"), hex("#f25f9c"), hex("#22e0e0")]),
} as const satisfies Record<string, Palette>;

/** Name of any built-in palette. */
export type PaletteName = keyof typeof palettes;

/** The cinematic palette catalog as an ordered array (catalog iteration / UIs). */
export const PALETTE_CATALOG: readonly Palette[] = Object.values(palettes);

/** All palette names, in catalog order. */
export const PALETTE_NAMES = Object.keys(palettes) as readonly PaletteName[];
