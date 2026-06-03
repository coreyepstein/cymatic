/**
 * Parameter *binding* sources for @cymatic/core (V2-08).
 *
 * A {@link ParamBinding} says *where a parameter's value comes from* each frame.
 * The schema (see `schema.ts`) is the static shape; the binding is the live
 * wiring. A param can be driven by a constant, a live audio feature, a director
 * macro signal, an LFO, seeded randomness, or an explicit manual value that
 * overrides automation. Every auto binding can carry per-binding EMA smoothing
 * and (for numbers) a `[0, 1]` → output range mapping.
 *
 * Bindings are plain, serializable descriptors — the resolver (`resolve.ts`)
 * interprets them. Nothing here touches the renderer, `Date.now`, or
 * `Math.random`; LFOs advance on the frame's `dt` and randomness uses a seeded
 * RNG, so resolution is deterministic and reproducible offline.
 */

import type { AudioFeatureFrame } from "../audio/features.js";
import type { DirectorState } from "../director/director.js";

/** LFO waveform shapes for an {@link LfoBinding}. */
export type LfoShape = "sine" | "triangle" | "sawtooth" | "square" | "noise";

/**
 * Common smoothing + mapping applied to a numeric auto binding before it
 * becomes the resolved value. All optional.
 */
export interface BindingMap {
  /**
   * EMA smoothing kept from the previous resolved value, in `[0, 1)`. Higher =
   * smoother / laggier. `0` (or omitted) = no smoothing. Reuses the engine EMA.
   */
  readonly smoothing?: number;
  /**
   * Output range the normalized `[0, 1]` source maps onto. Defaults to the
   * param's own `[min, max]` (number params) when omitted.
   */
  readonly outMin?: number;
  readonly outMax?: number;
  /** Input range the source is expected to span before mapping. Default `[0, 1]`. */
  readonly inMin?: number;
  readonly inMax?: number;
}

/** A constant value — the param sits at this value forever. */
export interface ConstBinding {
  readonly source: "const";
  /** The fixed value. Omit to use the schema default. */
  readonly value?: number | string;
}

/**
 * Drive from a live audio feature, addressed by a dotted path into the
 * {@link AudioFeatureFrame} (e.g. `"bass"`, `"mood.energy"`, `"spectralCentroid"`).
 */
export interface AudioBinding extends BindingMap {
  readonly source: "audio";
  /** Dotted feature path, relative to the frame. */
  readonly path: string;
}

/**
 * Drive from a director macro signal, addressed by a dotted path into the
 * {@link DirectorState} (e.g. `"intensity"`, `"paletteBlend"`, `"motion"`).
 */
export interface DirectorBinding extends BindingMap {
  readonly source: "director";
  /** Dotted macro path, relative to the director state. */
  readonly path: string;
}

/** Drive from a deterministic low-frequency oscillator advanced on `dt`. */
export interface LfoBinding extends BindingMap {
  readonly source: "lfo";
  /** Oscillator shape. Default `"sine"`. */
  readonly shape?: LfoShape;
  /** Cycles per second. Default `0.2`. */
  readonly rate?: number;
  /** Amplitude as a fraction of the output range, in `[0, 1]`. Default `1`. */
  readonly depth?: number;
  /** Initial phase in cycles `[0, 1)`. Default `0`. */
  readonly phase?: number;
  /** Seed for the `"noise"` shape only. Default derived from the key. */
  readonly seed?: number;
}

/**
 * Drive from seeded randomness. By default it holds one random value (sampled
 * once, reproducible from the seed); set `everyFrame` to resample each frame, or
 * `intervalSeconds` to resample on a fixed cadence — both still deterministic
 * given the seed + dt stream.
 */
export interface RandomBinding extends BindingMap {
  readonly source: "random";
  /** Seed for the stream. Default derived from the key. */
  readonly seed?: number;
  /** Resample a fresh value every frame. Default `false` (sample-and-hold). */
  readonly everyFrame?: boolean;
  /** Resample every N seconds (ignored when `everyFrame`). Default: never. */
  readonly intervalSeconds?: number;
}

/**
 * An explicit manual value that overrides any automation. While a param carries
 * a manual binding the resolver returns `value` verbatim (range-clamped for
 * numbers); re-`bind`ing to an auto source clears it.
 */
export interface ManualBinding {
  readonly source: "manual";
  /** The user-set value. */
  readonly value: number | string;
}

/** The full set of binding descriptors a param may carry. */
export type ParamBinding =
  | ConstBinding
  | AudioBinding
  | DirectorBinding
  | LfoBinding
  | RandomBinding
  | ManualBinding;

/** A map from param key to its binding. */
export type ParamBindings = Readonly<Record<string, ParamBinding>>;

/**
 * Read a dotted numeric path out of an arbitrary object, guarded. Returns the
 * numeric leaf in `[0, 1]`-ish space (callers map/clamp), or `undefined` if the
 * path is missing or the leaf is not a finite number. Used for both audio and
 * director paths so there is a single, typed lookup.
 */
export function getNumberPath(root: unknown, path: string): number | undefined {
  const segments = path.split(".");
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (typeof cur === "boolean") return cur ? 1 : 0;
  if (typeof cur === "number" && Number.isFinite(cur)) return cur;
  return undefined;
}

/** Narrow helper: read an audio-feature path from a frame. */
export function readAudioPath(
  features: AudioFeatureFrame,
  path: string,
): number | undefined {
  return getNumberPath(features, path);
}

/** Narrow helper: read a director macro path from a state snapshot. */
export function readDirectorPath(
  director: DirectorState,
  path: string,
): number | undefined {
  return getNumberPath(director, path);
}
