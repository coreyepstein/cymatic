/**
 * The preset contract for @cymatic/core.
 *
 * A {@link Preset} is the unit of authored visual content. It targets the
 * backend-agnostic {@link Renderer} and the {@link AudioFeatureFrame} — it never
 * touches raw GL/GPU. The lifecycle mirrors the renderer surface:
 *
 *   - `init(ctx)`    — one-time setup; receives a {@link PresetContext}.
 *   - `resize(w,h,dpr)` — backing-store size changed (CSS pixels + DPR).
 *   - `update(features, time, dt)` — produce one frame from audio + time.
 *   - `dispose()`    — release any preset-held resources.
 *
 * Authors declare presets with {@link definePreset} and can register them into a
 * {@link PresetRegistry} so hosts (the gallery app, the export pipeline) can
 * discover and instantiate them by id.
 */

import type { AudioFeatureFrame } from "../audio/features.js";
import type { ParamSchema, ParamValue } from "../params/schema.js";
import type { ParamSet } from "../params/param-set.js";
import type { DirectorState } from "../director/director.js";
import type { Renderer } from "../render/renderer.js";

/**
 * Everything a preset is handed at {@link Preset.init}. Kept small and
 * backend-neutral: the {@link Renderer} surface plus the initial size. Hosts may
 * extend this in their own layer, but the core contract depends only on these.
 */
export interface PresetContext {
  /** The backend-agnostic renderer the preset draws through. */
  readonly renderer: Renderer;
  /** Initial backing-store width in device pixels. */
  readonly width: number;
  /** Initial backing-store height in device pixels. */
  readonly height: number;
  /** Initial device-pixel-ratio. */
  readonly dpr: number;
}

/**
 * Per-frame, host-supplied context threaded into {@link Preset.update} on top of
 * the audio frame (V2-10). Backward-compatible and fully optional: a host that
 * does not run an auto-director (or a preset that ignores it) keeps working
 * exactly as before. Cinematic presets read {@link PresetFrameContext.director}
 * to evolve their look over a whole track.
 */
export interface PresetFrameContext {
  /**
   * The current auto-director macro state, if the host runs a
   * {@link "../director/director.js".Director}. When present, presets sample the
   * crossfading palette / hue rotation / intensity / motion / density to build
   * and drop with the song. When absent, presets fall back to a resting state.
   */
  readonly director?: DirectorState;
  /**
   * Optionally pre-resolved parameter values, keyed by param key. Most presets
   * own their own {@link "../params/param-set.js".ParamSet} and resolve
   * internally; this field lets a host that wants centralized control inject
   * already-resolved values instead. Purely additive.
   */
  readonly params?: Readonly<Record<string, ParamValue>>;
}

/**
 * The runtime contract every preset implements. Method names intentionally
 * align with the {@link Renderer} lifecycle so a host can drive both in lockstep.
 */
export interface Preset {
  /** One-time setup. Resolve once the preset is ready to {@link Preset.update}. */
  init(ctx: PresetContext): void | Promise<void>;

  /**
   * Backing store resized. `width`/`height` are device pixels; `dpr` the
   * device-pixel-ratio. Mirrors {@link Renderer.resize}.
   */
  resize(width: number, height: number, dpr: number): void;

  /**
   * Produce one frame. `features` is the current audio snapshot, `time` the
   * elapsed seconds, `dt` the seconds since the previous frame. The preset
   * issues its draws through the {@link Renderer} captured at {@link Preset.init}.
   *
   * The optional `frameContext` (V2-10) threads the auto-director macro state
   * (and optionally pre-resolved params) so cinematic presets can evolve over a
   * whole track. It is fully optional and backward-compatible: presets that
   * ignore it — and hosts that omit it — behave exactly as before.
   */
  update(
    features: AudioFeatureFrame,
    time: number,
    dt: number,
    frameContext?: PresetFrameContext,
  ): void;

  /** Release preset-held resources. Idempotent. */
  dispose(): void;

  /**
   * The preset's per-instance {@link ParamSet}, when it declared a `params`
   * schema and resolves its own parameters (V2-14). Optional and additive: a
   * preset without parameters (or one that takes pre-resolved values from the
   * host) leaves this absent/`null`. A host (the gallery) reads it to
   * auto-render controls, set manual overrides, randomize, or re-bind a param
   * to its default — driving the live look without reaching into preset code.
   * Compositions built with `composePreset` populate it automatically.
   */
  readonly paramSet?: ParamSet | null;
}

/** Static metadata describing a preset, independent of any instance. */
export interface PresetMeta {
  /** Stable, unique identifier (e.g. `"geometric.bars"`). */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;
  /** Optional one-line description. */
  readonly description?: string;
  /** Optional tags for discovery / filtering. */
  readonly tags?: readonly string[];
  /**
   * Optional declarative parameter schema (V2-08). When present, hosts can
   * introspect a preset's tunable knobs without instantiating it (to
   * auto-render controls); the preset reads resolved values each frame via a
   * {@link "../params/index.js".ParamSet}. Presets that omit `params` keep
   * working exactly as before — the field is purely additive.
   */
  readonly params?: readonly ParamSchema[];
}

/**
 * A preset definition: metadata plus a factory that builds a fresh
 * {@link Preset} instance. Definitions are inert and reusable; each `create()`
 * yields an independent, stateful instance.
 */
export interface PresetDefinition extends PresetMeta {
  /** Build a new, independent preset instance. */
  create(): Preset;
}

/** Input to {@link definePreset}: metadata plus the instance factory. */
export interface DefinePresetInput extends PresetMeta {
  create(): Preset;
}

/**
 * Declare a preset definition. A thin, validating constructor: it trims the id,
 * rejects an empty id, and returns a frozen {@link PresetDefinition}. This is
 * the one blessed way to author a preset so every definition has consistent
 * shape and metadata.
 */
export function definePreset(input: DefinePresetInput): PresetDefinition {
  const id = input.id.trim();
  if (id.length === 0) {
    throw new Error("definePreset: `id` must be a non-empty string");
  }
  if (typeof input.create !== "function") {
    throw new Error(`definePreset("${id}"): \`create\` must be a function`);
  }
  return Object.freeze({
    id,
    name: input.name,
    description: input.description,
    tags: input.tags,
    params: input.params,
    create: input.create,
  });
}

/**
 * A registry presets register into so hosts can discover them by id. A registry
 * owns a set of {@link PresetDefinition}s keyed by their id; re-registering the
 * same id throws (definitions are meant to be unique) unless `replace` is set.
 */
export class PresetRegistry {
  private readonly defs = new Map<string, PresetDefinition>();

  /** Register a definition. Throws on a duplicate id unless `replace` is true. */
  register(def: PresetDefinition, options: { replace?: boolean } = {}): PresetDefinition {
    if (this.defs.has(def.id) && !options.replace) {
      throw new Error(`PresetRegistry: a preset with id "${def.id}" is already registered`);
    }
    this.defs.set(def.id, def);
    return def;
  }

  /** Look up a definition by id, or `undefined` if absent. */
  get(id: string): PresetDefinition | undefined {
    return this.defs.get(id);
  }

  /** Whether a definition with `id` is registered. */
  has(id: string): boolean {
    return this.defs.has(id);
  }

  /** Instantiate a preset by id. Throws if the id is unknown. */
  create(id: string): Preset {
    const def = this.defs.get(id);
    if (!def) {
      throw new Error(`PresetRegistry: no preset registered with id "${id}"`);
    }
    return def.create();
  }

  /** All registered definitions, in insertion order. */
  list(): PresetDefinition[] {
    return [...this.defs.values()];
  }

  /** Number of registered definitions. */
  get size(): number {
    return this.defs.size;
  }
}

/**
 * A process-wide default registry, convenient for the common case. Hosts that
 * need isolation (tests, multiple independent galleries) can construct their own
 * {@link PresetRegistry} instead.
 */
export const defaultPresetRegistry = new PresetRegistry();
