/**
 * Wall-clock-driven {@link Clock}, built on `requestAnimationFrame`.
 *
 * Elapsed time is measured against an injectable `now()` function (defaulting
 * to `performance.now()` / `Date.now()`), and frames are scheduled via an
 * injectable `raf()` (defaulting to the global `requestAnimationFrame`). Both
 * are injectable so the clock is fully testable in Node without a browser.
 */

import type { Clock, ClockListener, Unsubscribe } from "./clock.js";

/** Monotonic millisecond time source. */
export type NowFn = () => number;

/** `requestAnimationFrame`-shaped scheduler. */
export type RafFn = (callback: (timeMs: number) => void) => number;

/** `cancelAnimationFrame`-shaped canceller. */
export type CancelRafFn = (handle: number) => void;

/** Construction options for {@link RealtimeClock}. */
export interface RealtimeClockOptions {
  /**
   * Monotonic millisecond time source. Defaults to `performance.now()` when
   * available, otherwise `Date.now()`. Injectable for testing.
   */
  now?: NowFn;
  /**
   * Frame scheduler. Defaults to the global `requestAnimationFrame`. Injectable
   * for testing (the test driver can fire callbacks synchronously).
   */
  raf?: RafFn;
  /** Frame canceller. Defaults to the global `cancelAnimationFrame`. */
  cancelRaf?: CancelRafFn;
}

function defaultNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function defaultRaf(callback: (timeMs: number) => void): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }
  throw new Error(
    "RealtimeClock: no requestAnimationFrame available — inject a `raf` option.",
  );
}

function defaultCancelRaf(handle: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle);
  }
}

/**
 * A {@link Clock} that advances from `requestAnimationFrame` against
 * wall-clock time. `now()` returns seconds elapsed since the most recent
 * {@link start}.
 */
export class RealtimeClock implements Clock {
  private readonly nowFn: NowFn;
  private readonly rafFn: RafFn;
  private readonly cancelRafFn: CancelRafFn;
  private readonly listeners = new Set<ClockListener>();

  private startTimeMs = 0;
  private elapsedSeconds = 0;
  private frameCount = 0;
  private isRunning = false;
  private rafHandle: number | null = null;

  constructor(options: RealtimeClockOptions = {}) {
    this.nowFn = options.now ?? defaultNow;
    this.rafFn = options.raf ?? defaultRaf;
    this.cancelRafFn = options.cancelRaf ?? defaultCancelRaf;
  }

  now(): number {
    return this.elapsedSeconds;
  }

  get frame(): number {
    return this.frameCount;
  }

  get running(): boolean {
    return this.isRunning;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startTimeMs = this.nowFn();
    this.elapsedSeconds = 0;
    this.frameCount = 0;
    this.schedule();
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.rafHandle !== null) {
      this.cancelRafFn(this.rafHandle);
      this.rafHandle = null;
    }
  }

  subscribe(listener: ClockListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  tick(): void {
    // Measure elapsed wall-clock time since start, in seconds.
    this.elapsedSeconds = (this.nowFn() - this.startTimeMs) / 1000;
    this.frameCount++;
    for (const listener of this.listeners) listener(this);
  }

  private schedule(): void {
    this.rafHandle = this.rafFn(() => {
      if (!this.isRunning) return;
      this.tick();
      if (this.isRunning) this.schedule();
    });
  }
}
