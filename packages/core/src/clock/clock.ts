/**
 * Timing / clock abstraction for the cymatic engine.
 *
 * The render + analysis pipeline reads time from a {@link Clock} rather than
 * touching `performance.now()` / `requestAnimationFrame` directly. Two
 * implementations share this interface:
 *
 *  - {@link RealtimeClock} advances against wall-clock time, driven by
 *    `requestAnimationFrame`, for live playback.
 *  - {@link OfflineClock} advances in fixed `1/fps` steps fully decoupled from
 *    wall-clock time, for deterministic offline rendering / export.
 *
 * Parameterizing feature reads by `clock.now()` lets offline mode sample an
 * `AudioBuffer` at the exact window for each frame, producing identical
 * feature-frame sequences across runs.
 */

/** A subscriber invoked once per {@link Clock} tick. */
export type ClockListener = (clock: Clock) => void;

/** Unsubscribe handle returned by {@link Clock.subscribe}. */
export type Unsubscribe = () => void;

/**
 * A monotonic frame clock. Implementations advance either against wall-clock
 * time (realtime) or in fixed steps (offline), but expose the same surface so
 * consumers are agnostic to the driver.
 */
export interface Clock {
  /** Elapsed time since {@link start}, in seconds. */
  now(): number;
  /** Zero-based count of frames emitted since {@link start}. */
  readonly frame: number;
  /** Begin advancing. Idempotent: a second call while running is a no-op. */
  start(): void;
  /** Stop advancing and release any underlying driver (e.g. rAF handle). */
  stop(): void;
  /** Whether the clock is currently advancing. */
  readonly running: boolean;
  /**
   * Subscribe to per-frame ticks. The listener fires after each frame's time +
   * frame counter have advanced. Returns an unsubscribe handle.
   */
  subscribe(listener: ClockListener): Unsubscribe;
  /**
   * Advance exactly one frame and notify subscribers. Realtime clocks call this
   * internally from their rAF callback; offline clocks call it explicitly to
   * step deterministically. Safe to call manually for testing either clock.
   */
  tick(): void;
}
