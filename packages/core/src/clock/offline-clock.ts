/**
 * Deterministic fixed-step {@link Clock} for offline rendering / export.
 *
 * Time advances in exact `1 / fps` increments, fully decoupled from wall-clock
 * time — no `requestAnimationFrame`, no `Date.now()` / `performance.now()`,
 * no randomness. Given the same `fps`, two clocks produce byte-identical time
 * sequences, which is what makes offline feature extraction reproducible.
 *
 * To keep time exact and free of floating-point drift, the current time is
 * derived as `frame / fps` rather than accumulated by repeated addition.
 */

import type { Clock, ClockListener, Unsubscribe } from "./clock.js";

/** Construction options for {@link OfflineClock}. */
export interface OfflineClockOptions {
  /** Frames per second; the inverse is the fixed step size. Default `60`. */
  fps?: number;
}

const DEFAULT_FPS = 60;

/**
 * A {@link Clock} that advances in fixed `1/fps` steps. Call {@link tick} (or
 * its alias {@link advance}) to step forward one frame deterministically.
 */
export class OfflineClock implements Clock {
  /** Frames per second; the fixed step is `1 / fps` seconds. */
  readonly fps: number;

  private readonly listeners = new Set<ClockListener>();
  private frameCount = 0;
  private isRunning = false;

  constructor(options: OfflineClockOptions = {}) {
    const fps = options.fps ?? DEFAULT_FPS;
    if (!(fps > 0) || !Number.isFinite(fps)) {
      throw new RangeError("OfflineClock: fps must be a positive, finite number");
    }
    this.fps = fps;
  }

  now(): number {
    // Derive from the frame counter so there is no accumulated FP drift.
    return this.frameCount / this.fps;
  }

  get frame(): number {
    return this.frameCount;
  }

  get running(): boolean {
    return this.isRunning;
  }

  start(): void {
    this.isRunning = true;
  }

  stop(): void {
    this.isRunning = false;
  }

  subscribe(listener: ClockListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Advance exactly one frame: increment the frame counter (so `now()` steps by
   * `1 / fps`) and notify subscribers.
   */
  tick(): void {
    this.frameCount++;
    for (const listener of this.listeners) listener(this);
  }

  /** Alias for {@link tick}: deterministic single-frame step. */
  advance(): void {
    this.tick();
  }

  /** Reset the clock to frame 0 / time 0 without touching subscribers. */
  reset(): void {
    this.frameCount = 0;
  }
}
