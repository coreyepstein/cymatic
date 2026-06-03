import { describe, expect, it } from "vitest";

import {
  blendPalettes,
  hex,
  mixColor,
  palette,
  PALETTE_CATALOG,
  PALETTE_NAMES,
  palettes,
  rgb,
  rgb255,
  rotateHue,
  sample,
  sampleBlended,
  sampleRamp,
  withAlpha,
} from "./palette.js";

describe("color construction", () => {
  it("rgb clamps channels and defaults alpha to opaque", () => {
    expect(rgb(2, -1, 0.5)).toEqual({ r: 1, g: 0, b: 0.5, a: 1 });
  });

  it("rgb255 scales 8-bit channels into [0,1]", () => {
    expect(rgb255(255, 0, 128)).toEqual({ r: 1, g: 0, b: 128 / 255, a: 1 });
  });

  it("hex parses #rrggbb", () => {
    expect(hex("#ff0000")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(hex("00ff00")).toEqual({ r: 0, g: 1, b: 0, a: 1 });
  });

  it("hex parses shorthand and alpha forms", () => {
    expect(hex("#f00")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(hex("#000000ff")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(hex("#00000000")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("hex throws on malformed input", () => {
    expect(() => hex("#12")).toThrow();
    expect(() => hex("#zzzzzz")).toThrow();
  });
});

describe("mixColor & withAlpha", () => {
  it("mixColor blends per-channel and clamps t", () => {
    const a = rgb(0, 0, 0, 0);
    const b = rgb(1, 1, 1, 1);
    expect(mixColor(a, b, 0.5)).toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 0.5 });
    expect(mixColor(a, b, -1)).toEqual(a);
    expect(mixColor(a, b, 2)).toEqual(b);
  });

  it("withAlpha replaces alpha, keeps rgb", () => {
    expect(withAlpha(rgb(0.2, 0.4, 0.6), 0.3)).toEqual({ r: 0.2, g: 0.4, b: 0.6, a: 0.3 });
  });
});

describe("palette sampling", () => {
  it("requires at least one stop", () => {
    expect(() => palette("empty", [])).toThrow();
  });

  it("returns the single stop regardless of t", () => {
    const p = palette("one", [rgb(0.3, 0.3, 0.3)]);
    expect(sample(p, 0)).toEqual(rgb(0.3, 0.3, 0.3));
    expect(sample(p, 1)).toEqual(rgb(0.3, 0.3, 0.3));
  });

  it("interpolates between evenly-spaced stops and clamps the ends", () => {
    const p = palette("ramp", [rgb(0, 0, 0), rgb(1, 1, 1)]);
    expect(sample(p, 0)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(sample(p, 1)).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(sample(p, 0.5)).toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
    expect(sample(p, -1)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(sample(p, 2)).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });

  it("samples the correct segment of a multi-stop palette", () => {
    const p = palette("rgb", [rgb(1, 0, 0), rgb(0, 1, 0), rgb(0, 0, 1)]);
    // Midpoint of the first segment.
    expect(sample(p, 0.25)).toEqual({ r: 0.5, g: 0.5, b: 0, a: 1 });
    // Exact middle stop.
    expect(sample(p, 0.5)).toEqual({ r: 0, g: 1, b: 0, a: 1 });
  });

  it("built-in palettes are non-empty and named", () => {
    for (const [key, p] of Object.entries(palettes)) {
      expect(p.name).toBe(key);
      expect(p.stops.length).toBeGreaterThan(0);
    }
  });
});

describe("sampleRamp", () => {
  const ramp = palette("ramp", [rgb(0, 0, 0), rgb(0.5, 0.5, 0.5), rgb(1, 1, 1)]);

  it("returns endpoint colors at t=0 and t=1", () => {
    expect(sampleRamp(ramp, 0)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(sampleRamp(ramp, 1)).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });

  it("returns an interpolated color mid-ramp", () => {
    const mid = sampleRamp(ramp, 0.5);
    expect(mid).toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
  });

  it("moves monotonically up a monotonic channel", () => {
    const lo = sampleRamp(ramp, 0.2).r;
    const midV = sampleRamp(ramp, 0.5).r;
    const hi = sampleRamp(ramp, 0.8).r;
    expect(lo).toBeLessThan(midV);
    expect(midV).toBeLessThan(hi);
  });
});

describe("blendPalettes & sampleBlended", () => {
  const a = palette("a", [rgb(0, 0, 0), rgb(0, 0, 1)]);
  const b = palette("b", [rgb(1, 1, 1), rgb(1, 0, 0)]);

  it("blend=0 reproduces palette a's ramp", () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(sampleBlended(a, b, 0, t)).toEqual(sampleRamp(a, t));
      expect(sampleRamp(blendPalettes(a, b, 0), t)).toEqual(sampleRamp(a, t));
    }
  });

  it("blend=1 reproduces palette b's ramp", () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(sampleBlended(a, b, 1, t)).toEqual(sampleRamp(b, t));
      expect(sampleRamp(blendPalettes(a, b, 1), t)).toEqual(sampleRamp(b, t));
    }
  });

  it("mid-blend lies between the two pure ramps", () => {
    const t = 0.5;
    const ca = sampleRamp(a, t);
    const cb = sampleRamp(b, t);
    const mid = sampleBlended(a, b, 0.5, t);
    const lo = Math.min(ca.r, cb.r);
    const hi = Math.max(ca.r, cb.r);
    expect(mid.r).toBeGreaterThanOrEqual(lo);
    expect(mid.r).toBeLessThanOrEqual(hi);
    expect(mid.r).toBeCloseTo((ca.r + cb.r) / 2, 6);
  });

  it("blendPalettes handles palettes of differing stop counts", () => {
    const short = palette("short", [rgb(0, 0, 0), rgb(1, 1, 1)]);
    const long = palette("long", [rgb(1, 0, 0), rgb(0, 1, 0), rgb(0, 0, 1)]);
    const blended = blendPalettes(short, long, 0.5);
    expect(blended.stops.length).toBe(3);
    for (const s of blended.stops) {
      for (const ch of [s.r, s.g, s.b, s.a]) {
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("rotateHue", () => {
  const orange = rgb(1, 0.5, 0); // saturated, unambiguous hue

  it("rotating by 0 is an identity", () => {
    const out = rotateHue(orange, 0);
    expect(out.r).toBeCloseTo(orange.r, 6);
    expect(out.g).toBeCloseTo(orange.g, 6);
    expect(out.b).toBeCloseTo(orange.b, 6);
    expect(out.a).toBe(orange.a);
  });

  it("rotating by 180 meaningfully shifts the hue", () => {
    const out = rotateHue(orange, 180);
    // Opposite of orange leans cyan/blue: blue should rise, red should fall.
    expect(out.b).toBeGreaterThan(orange.b + 0.3);
    expect(out.r).toBeLessThan(orange.r - 0.3);
  });

  it("rotating by 360 is approximately an identity", () => {
    const out = rotateHue(orange, 360);
    expect(out.r).toBeCloseTo(orange.r, 6);
    expect(out.g).toBeCloseTo(orange.g, 6);
    expect(out.b).toBeCloseTo(orange.b, 6);
  });

  it("preserves alpha and leaves grays unchanged", () => {
    expect(rotateHue(rgb(0.4, 0.4, 0.4, 0.5), 120)).toEqual({
      r: 0.4,
      g: 0.4,
      b: 0.4,
      a: 0.5,
    });
  });
});

describe("cinematic catalog", () => {
  it("has the expected number of palettes", () => {
    expect(PALETTE_NAMES.length).toBe(14);
    expect(PALETTE_CATALOG.length).toBe(14);
    expect(Object.keys(palettes).length).toBe(14);
  });

  it("includes the curated cinematic names", () => {
    for (const name of [
      "ember",
      "nocturne",
      "aurora",
      "sodium",
      "ultraviolet",
      "monoGold",
      "ice",
      "bloodmoon",
      "verdant",
      "pastelHaze",
    ]) {
      expect(PALETTE_NAMES).toContain(name);
    }
  });

  it("every palette is well-formed (>=2 stops, valid channels)", () => {
    for (const p of PALETTE_CATALOG) {
      expect(p.stops.length).toBeGreaterThanOrEqual(2);
      for (const s of p.stops) {
        for (const ch of [s.r, s.g, s.b, s.a]) {
          expect(Number.isFinite(ch)).toBe(true);
          expect(ch).toBeGreaterThanOrEqual(0);
          expect(ch).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
