/**
 * Public timing / clock surface for @cymatic/core.
 *
 * A single {@link Clock} interface backs both the realtime (rAF, wall-clock)
 * and offline (fixed `1/fps` step, deterministic) drivers.
 */

export type { Clock, ClockListener, Unsubscribe } from "./clock.js";

export type {
  RealtimeClockOptions,
  NowFn,
  RafFn,
  CancelRafFn,
} from "./realtime-clock.js";
export { RealtimeClock } from "./realtime-clock.js";

export type { OfflineClockOptions } from "./offline-clock.js";
export { OfflineClock } from "./offline-clock.js";
