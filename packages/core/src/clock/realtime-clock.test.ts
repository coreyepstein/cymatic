import { describe, expect, it } from "vitest";

import { RealtimeClock } from "./realtime-clock.js";

/**
 * A controllable rAF substitute: queued callbacks fire only when `flush()` is
 * called, so tests drive the clock synchronously without a browser.
 */
function makeFakeRaf() {
  let pending: ((t: number) => void) | null = null;
  let handleSeq = 1;
  const raf = (cb: (t: number) => void): number => {
    pending = cb;
    return handleSeq++;
  };
  const flush = (timeMs = 0): void => {
    const cb = pending;
    pending = null;
    if (cb) cb(timeMs);
  };
  const hasPending = () => pending !== null;
  return { raf, flush, hasPending };
}

describe("RealtimeClock", () => {
  it("advances elapsed seconds against an injected wall-clock", () => {
    let t = 1000;
    const now = () => t;
    const { raf, flush } = makeFakeRaf();
    const clock = new RealtimeClock({ now, raf });

    clock.start();
    expect(clock.now()).toBe(0);
    expect(clock.frame).toBe(0);

    t = 1016; // ~one 60fps frame later
    flush();
    expect(clock.frame).toBe(1);
    expect(clock.now()).toBeCloseTo(0.016, 6);

    t = 1032;
    flush();
    expect(clock.frame).toBe(2);
    expect(clock.now()).toBeCloseTo(0.032, 6);
  });

  it("reschedules rAF each frame while running", () => {
    let t = 0;
    const now = () => t;
    const { raf, flush, hasPending } = makeFakeRaf();
    const clock = new RealtimeClock({ now, raf });

    clock.start();
    expect(hasPending()).toBe(true);
    t = 16;
    flush();
    expect(hasPending()).toBe(true); // rescheduled
  });

  it("stop() halts advancement and cancels the pending frame", () => {
    let t = 0;
    const now = () => t;
    let cancelled: number | null = null;
    const { raf, flush } = makeFakeRaf();
    const clock = new RealtimeClock({
      now,
      raf,
      cancelRaf: (h) => {
        cancelled = h;
      },
    });

    clock.start();
    t = 16;
    flush();
    expect(clock.frame).toBe(1);

    clock.stop();
    expect(cancelled).not.toBeNull();
    expect(clock.running).toBe(false);

    // A late flush after stop must not advance.
    t = 32;
    flush();
    expect(clock.frame).toBe(1);
  });

  it("start() is idempotent while running", () => {
    let t = 100;
    const now = () => t;
    const { raf, flush } = makeFakeRaf();
    const clock = new RealtimeClock({ now, raf });
    clock.start();
    t = 200;
    clock.start(); // no-op; must not reset baseline
    flush();
    expect(clock.now()).toBeCloseTo(0.1, 6);
  });

  it("notifies subscribers on each frame", () => {
    let t = 0;
    const now = () => t;
    const { raf, flush } = makeFakeRaf();
    const clock = new RealtimeClock({ now, raf });
    const frames: number[] = [];
    clock.subscribe((c) => frames.push(c.frame));
    clock.start();
    t = 10;
    flush();
    t = 20;
    flush();
    expect(frames).toEqual([1, 2]);
  });

  it("tick() can be driven manually for testing", () => {
    let t = 500;
    const now = () => t;
    // No raf needed when ticking manually.
    const clock = new RealtimeClock({ now, raf: () => 0 });
    clock.start();
    t = 600;
    clock.tick();
    expect(clock.frame).toBe(1);
    expect(clock.now()).toBeCloseTo(0.1, 6);
  });
});
