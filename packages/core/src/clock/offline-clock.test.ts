import { describe, expect, it, vi } from "vitest";

import { OfflineClock } from "./offline-clock.js";

describe("OfflineClock", () => {
  it("starts at frame 0 / time 0", () => {
    const clock = new OfflineClock({ fps: 60 });
    expect(clock.frame).toBe(0);
    expect(clock.now()).toBe(0);
  });

  it("advances in exact 1/fps steps decoupled from wall-clock", () => {
    const clock = new OfflineClock({ fps: 60 });
    clock.tick();
    expect(clock.frame).toBe(1);
    expect(clock.now()).toBeCloseTo(1 / 60, 12);
    clock.tick();
    expect(clock.frame).toBe(2);
    expect(clock.now()).toBeCloseTo(2 / 60, 12);
  });

  it("advance() is an alias for tick()", () => {
    const clock = new OfflineClock({ fps: 30 });
    clock.advance();
    clock.advance();
    expect(clock.frame).toBe(2);
    expect(clock.now()).toBeCloseTo(2 / 30, 12);
  });

  it("derives time from frame counter (no accumulated FP drift)", () => {
    // 0.1s is not exactly representable; deriving frame/fps avoids drift that
    // repeated += (1/fps) would accumulate.
    const clock = new OfflineClock({ fps: 10 });
    for (let i = 0; i < 100; i++) clock.tick();
    expect(clock.frame).toBe(100);
    expect(clock.now()).toBe(10); // 100 / 10 exactly
  });

  it("never reads wall-clock sources", () => {
    const dateSpy = vi.spyOn(Date, "now");
    const clock = new OfflineClock({ fps: 60 });
    clock.start();
    for (let i = 0; i < 10; i++) clock.tick();
    clock.stop();
    expect(dateSpy).not.toHaveBeenCalled();
    dateSpy.mockRestore();
  });

  it("notifies subscribers each tick and unsubscribes cleanly", () => {
    const clock = new OfflineClock({ fps: 24 });
    const seen: number[] = [];
    const unsub = clock.subscribe((c) => seen.push(c.frame));
    clock.tick();
    clock.tick();
    unsub();
    clock.tick();
    expect(seen).toEqual([1, 2]);
  });

  it("reset() returns to frame 0 / time 0", () => {
    const clock = new OfflineClock({ fps: 60 });
    clock.tick();
    clock.tick();
    clock.reset();
    expect(clock.frame).toBe(0);
    expect(clock.now()).toBe(0);
  });

  it("tracks running state via start/stop", () => {
    const clock = new OfflineClock();
    expect(clock.running).toBe(false);
    clock.start();
    expect(clock.running).toBe(true);
    clock.stop();
    expect(clock.running).toBe(false);
  });

  it("rejects non-positive or non-finite fps", () => {
    expect(() => new OfflineClock({ fps: 0 })).toThrow(RangeError);
    expect(() => new OfflineClock({ fps: -1 })).toThrow(RangeError);
    expect(() => new OfflineClock({ fps: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
  });
});
