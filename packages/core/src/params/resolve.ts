/**
 * Pure parameter resolver for @cymatic/core (V2-08).
 *
 * {@link resolveParams} turns a param *schema* + the current *bindings* + a live
 * context (audio features, director state, time/dt, seeded RNG) into the
 * resolved values for this frame, plus the updated per-binding smoothing /
 * oscillator / random state to thread into the next call. It is a pure function:
 * the same `(schema, bindings, ctx, prevState)` always yields the same result.
 * There is no `Date.now` / `Math.random` — LFOs advance on `ctx.dt`, randomness
 * uses the seeded `Rng`, so offline rendering reproduces exactly.
 *
 * Resolution rules:
 *   - `manual` beats everything — its value is returned verbatim (clamped for
 *     numbers).
 *   - `const` returns its value, falling back to the schema default.
 *   - `audio` / `director` read a dotted path, map `[0, 1]` → the param range,
 *     and smooth.
 *   - `lfo` oscillates with `ctx.time`/`ctx.dt`; `random` draws from the seeded
 *     stream (sample-and-hold, per-frame, or interval).
 *   - For `enum` a numeric source selects an option across the option list; for
 *     `color` only `const`/`manual` strings are meaningful (auto falls back to
 *     the default color).
 */

import { clamp01, ema } from "../audio/features.js";
import { mapRange } from "../primitives/easing.js";
import { Rng, deriveSeed } from "../director/noise.js";
import type { DirectorState } from "../director/director.js";
import type { AudioFeatureFrame } from "../audio/features.js";
import {
  numberRange,
  type ParamSchema,
  type ParamValue,
} from "./schema.js";
import {
  getNumberPath,
  type BindingMap,
  type LfoShape,
  type ParamBinding,
  type ParamBindings,
} from "./bindings.js";

/** Live inputs the resolver reads each frame. */
export interface ResolveContext {
  /** The current audio snapshot. */
  readonly features: AudioFeatureFrame;
  /** The current director macro state. */
  readonly director: DirectorState;
  /** Elapsed seconds (monotonic) — drives LFO phase via `time`. */
  readonly time: number;
  /** Seconds since the previous frame — advances LFO phase / random cadence. */
  readonly dt: number;
}

/** Per-binding mutable state carried frame to frame for one param. */
export interface ParamBindingState {
  /** Last smoothed numeric value (for EMA continuity). */
  smoothed?: number;
  /** RNG state for a `random` binding (uint32), so it advances deterministically. */
  rngState?: number;
  /** Held random sample (sample-and-hold / interval). */
  randomHold?: number;
  /** Seconds accumulated toward the next interval resample. */
  randomElapsed?: number;
}

/** The full resolved frame: values + the state to thread into the next call. */
export interface ResolvedParams {
  /** Resolved value per param key. */
  readonly values: Readonly<Record<string, ParamValue>>;
  /** Updated per-key binding state for the next {@link resolveParams} call. */
  readonly state: Readonly<Record<string, ParamBindingState>>;
}

/** Empty previous state — used on the first frame. */
const EMPTY_STATE: Readonly<Record<string, ParamBindingState>> = Object.freeze({});

/** Resolve the LFO output in `[0, 1]` for a shape at a phase in cycles. */
function lfoWave(shape: LfoShape, phase: number, seed: number): number {
  const p = phase - Math.floor(phase); // fractional cycle [0, 1)
  switch (shape) {
    case "sine":
      return 0.5 + 0.5 * Math.sin(p * Math.PI * 2);
    case "triangle":
      return p < 0.5 ? p * 2 : 2 - p * 2;
    case "sawtooth":
      return p;
    case "square":
      return p < 0.5 ? 0 : 1;
    case "noise": {
      // Deterministic per-cycle value, smoothly held within a cycle.
      const cycle = Math.floor(phase);
      const rng = new Rng(deriveSeed(seed, cycle));
      return rng.next();
    }
    default:
      return 0.5;
  }
}

/**
 * Apply a binding's optional range map to a normalized `[0, 1]`-ish source
 * value, defaulting the output range to the param's own range for numbers.
 */
function applyMap(
  raw: number,
  map: BindingMap,
  schema: ParamSchema,
): number {
  const inMin = map.inMin ?? 0;
  const inMax = map.inMax ?? 1;
  let outMin = map.outMin;
  let outMax = map.outMax;
  if (outMin == null || outMax == null) {
    if (schema.type === "number") {
      const [lo, hi] = numberRange(schema);
      outMin ??= lo;
      outMax ??= hi;
    } else {
      outMin ??= 0;
      outMax ??= 1;
    }
  }
  return mapRange(raw, inMin, inMax, outMin, outMax);
}

/** Clamp a number to a number param's `[min, max]`; pass-through otherwise. */
function clampToSchema(value: number, schema: ParamSchema): number {
  if (schema.type !== "number") return value;
  const [lo, hi] = numberRange(schema);
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Coerce a resolved *numeric* source (already passed through {@link applyMap},
 * so it sits in its effective output range) into the param's value type:
 *   - number → as-is (mapping/clamping already happened in {@link applyMap},
 *     which honors an explicit `outMin`/`outMax` over the schema range).
 *   - enum   → option selected by mapping the number across the option list.
 *   - color  → not meaningful; caller falls back to default.
 */
function numberToValue(value: number, schema: ParamSchema): ParamValue {
  if (schema.type === "number") return value;
  if (schema.type === "enum") {
    const n = schema.options.length;
    const idx = Math.min(n - 1, Math.max(0, Math.floor(clamp01(value) * n)));
    return schema.options[idx]?.value ?? schema.default;
  }
  return schema.default;
}

/** Coerce an explicit (manual/const) value to the param type. */
function explicitToValue(
  value: number | string | undefined,
  schema: ParamSchema,
): ParamValue {
  if (value == null) return schema.default;
  if (schema.type === "number") {
    return clampToSchema(typeof value === "number" ? value : Number(value), schema);
  }
  // enum / color: accept the string as-is (enum unknown values are allowed
  // through so a host can preview, but fall back if blatantly absent).
  if (typeof value === "string") return value;
  // A number given for an enum selects by index; for color, fall back.
  if (schema.type === "enum") return numberToValue(value, schema);
  return schema.default;
}

/** Smooth `raw` against the prior smoothed value, if smoothing is configured. */
function smooth(
  raw: number,
  smoothing: number | undefined,
  prev: number | undefined,
): number {
  if (!smoothing || smoothing <= 0) return raw;
  const start = prev ?? raw;
  return ema(start, raw, smoothing);
}

/** Resolve one param. Returns its value + the next per-binding state. */
function resolveOne(
  schema: ParamSchema,
  binding: ParamBinding | undefined,
  ctx: ResolveContext,
  prev: ParamBindingState,
): { value: ParamValue; state: ParamBindingState } {
  // No binding → behave like a constant at the default.
  const b: ParamBinding = binding ?? { source: "const" };

  switch (b.source) {
    case "manual":
      return { value: explicitToValue(b.value, schema), state: {} };

    case "const":
      return { value: explicitToValue(b.value, schema), state: {} };

    case "audio":
    case "director": {
      const root: unknown = b.source === "audio" ? ctx.features : ctx.director;
      const raw = getNumberPath(root, b.path);
      if (raw == null) {
        // Missing path → fall back to default, keep no smoothing history.
        return { value: schema.default, state: {} };
      }
      const mapped = applyMap(raw, b, schema);
      const smoothed = smooth(mapped, b.smoothing, prev.smoothed);
      return {
        value: numberToValue(smoothed, schema),
        state: { smoothed },
      };
    }

    case "lfo": {
      const shape = b.shape ?? "sine";
      const rate = b.rate ?? 0.2;
      const depth = clamp01(b.depth ?? 1);
      const phase0 = b.phase ?? 0;
      const seed = b.seed ?? hashKey(schema.key);
      // Phase advances purely from absolute time so it is dt-stream-independent
      // yet still deterministic; `time` is the elapsed-seconds clock.
      const phase = phase0 + ctx.time * rate;
      const wave = lfoWave(shape, phase, seed);
      // Apply depth around the center (0.5) so depth<1 narrows the swing.
      const centered = 0.5 + (wave - 0.5) * depth;
      const mapped = applyMap(centered, b, schema);
      const smoothed = smooth(mapped, b.smoothing, prev.smoothed);
      return {
        value: numberToValue(smoothed, schema),
        state: { smoothed },
      };
    }

    case "random": {
      const seed = b.seed ?? hashKey(schema.key);
      let rngState = prev.rngState ?? seed >>> 0;
      let hold = prev.randomHold;
      let elapsed = prev.randomElapsed ?? 0;
      const rng = new Rng(rngState);

      const everyFrame = b.everyFrame ?? false;
      const interval = b.intervalSeconds;

      const needsSample =
        hold == null ||
        everyFrame ||
        (interval != null && interval > 0 && elapsed + ctx.dt >= interval);

      if (needsSample) {
        hold = rng.next();
        rngState = rng.nextSeed();
        elapsed = 0;
      } else {
        elapsed += Math.max(0, ctx.dt);
      }

      const raw = hold ?? 0;
      const mapped = applyMap(raw, b, schema);
      const smoothed = smooth(mapped, b.smoothing, prev.smoothed);
      return {
        value: numberToValue(smoothed, schema),
        state: {
          smoothed: b.smoothing && b.smoothing > 0 ? smoothed : undefined,
          rngState,
          randomHold: hold,
          randomElapsed: elapsed,
        },
      };
    }

    default:
      return { value: schema.default, state: {} };
  }
}

/** Stable 32-bit hash of a string key, used as a default seed for lfo/random. */
function hashKey(key: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Resolve every param in `schema` against `bindings` for the current frame.
 * Pure and deterministic. Pass the returned `state` back in as `prevState` on
 * the next frame to keep smoothing / LFO / random continuity.
 *
 * @param schema    The preset's declared param schema.
 * @param bindings  Per-key binding descriptors (missing key → `const` default).
 * @param ctx       Live frame inputs (features, director, time, dt).
 * @param prevState Per-key state from the previous call (omit on first frame).
 */
export function resolveParams(
  schema: readonly ParamSchema[],
  bindings: ParamBindings,
  ctx: ResolveContext,
  prevState: Readonly<Record<string, ParamBindingState>> = EMPTY_STATE,
): ResolvedParams {
  const values: Record<string, ParamValue> = {};
  const state: Record<string, ParamBindingState> = {};
  for (const s of schema) {
    const prev = prevState[s.key] ?? {};
    const { value, state: next } = resolveOne(s, bindings[s.key], ctx, prev);
    values[s.key] = value;
    state[s.key] = next;
  }
  return { values: Object.freeze(values), state: Object.freeze(state) };
}
