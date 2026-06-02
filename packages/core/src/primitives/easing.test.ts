import { describe, expect, it } from "vitest";

import {
  easings,
  easeInOutCubic,
  easeOutCubic,
  lerp,
  linear,
  makeSmoother,
  mapRange,
  Smoother,
} from "./easing.js";

describe("easing functions", () => {
  it("all pin the endpoints f(0)=0 and f(1)=1", () => {
    for (const [name, fn] of Object.entries(easings)) {
      expect(fn(0), `${name}(0)`).toBeCloseTo(0, 10);
      expect(fn(1), `${name}(1)`).toBeCloseTo(1, 10);
    }
  });

  it("clamp out-of-range input to the [0,1] domain", () => {
    expect(linear(-1)).toBe(0);
    expect(linear(2)).toBe(1);
    expect(easeOutCubic(-5)).toBeCloseTo(0, 10);
    expect(easeOutCubic(5)).toBeCloseTo(1, 10);
  });

  it("are monotonically non-decreasing across the domain", () => {
    for (const [name, fn] of Object.entries(easings)) {
      let prev = fn(0);
      for (let i = 1; i <= 20; i++) {
        const cur = fn(i / 20);
        expect(cur, `${name} monotonic at ${i}`).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = cur;
      }
    }
  });

  it("easeInOutCubic is symmetric about the midpoint", () => {
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
    expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1, 10);
  });
});

describe("lerp & mapRange", () => {
  it("lerp interpolates and extrapolates linearly", () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 1.5)).toBe(15); // not clamped
  });

  it("mapRange re-maps and clamps to the output range", () => {
    expect(mapRange(0.5, 0, 1, 0, 100)).toBe(50);
    expect(mapRange(-1, 0, 1, 0, 100)).toBe(0);
    expect(mapRange(2, 0, 1, 0, 100)).toBe(100);
    expect(mapRange(5, 0, 10, 10, 20)).toBe(15);
  });

  it("mapRange maps a zero-width input range to outMin", () => {
    expect(mapRange(5, 3, 3, 7, 9)).toBe(7);
  });
});

describe("Smoother", () => {
  it("converges toward a constant input", () => {
    const s = new Smoother(0.5, 0);
    let v = 0;
    for (let i = 0; i < 50; i++) v = s.push(1);
    expect(v).toBeCloseTo(1, 3);
  });

  it("higher smoothing moves more slowly per step", () => {
    const slow = new Smoother(0.9, 0);
    const fast = new Smoother(0.1, 0);
    const slowV = slow.push(1);
    const fastV = fast.push(1);
    expect(fastV).toBeGreaterThan(slowV);
  });

  it("makeSmoother matches the class and resets", () => {
    const s = makeSmoother(0.5, 0.25);
    expect(s.current).toBe(0.25);
    s.push(1);
    expect(s.current).toBeGreaterThan(0.25);
    s.reset();
    expect(s.current).toBe(0);
  });
});
