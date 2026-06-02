import { describe, expect, it } from "vitest";

import {
  hex,
  mixColor,
  palette,
  palettes,
  rgb,
  rgb255,
  sample,
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
