/**
 * {@link ParamSet} — the stateful controller a preset (and the gallery) drives
 * the declarative parameter system through (V2-08).
 *
 * It owns a frozen schema, the current per-key {@link ParamBinding}s, and the
 * resolver's per-binding state between frames. Each frame the preset calls
 * {@link ParamSet.resolve} with the live context to advance smoothing / LFO /
 * random and read the resolved values; hosts call {@link ParamSet.setManual} /
 * {@link ParamSet.bind} to re-wire a param and {@link ParamSet.getSchema} /
 * {@link ParamSet.getResolved} to introspect for auto-rendered controls and
 * live read-outs.
 *
 * Manual overrides beat automation: `setManual(key, value)` installs a `manual`
 * binding that the resolver returns verbatim until `bind(key, …)` re-points the
 * param at an auto source.
 *
 * The controller adds no nondeterminism of its own — it is a thin shell over the
 * pure {@link resolveParams}.
 */

import { defineParams, type ParamSchema, type ParamValue } from "./schema.js";
import type { ParamBinding, ParamBindings } from "./bindings.js";
import {
  resolveParams,
  type ParamBindingState,
  type ResolveContext,
} from "./resolve.js";

/** Options for {@link createParamSet}. */
export interface ParamSetOptions {
  /** Initial bindings per key. Missing keys default to a `const` at the default. */
  readonly bindings?: ParamBindings;
}

/**
 * A stateful, introspectable parameter controller. Construct via
 * {@link createParamSet} (or `new ParamSet(...)`).
 */
export class ParamSet {
  private readonly schema: readonly ParamSchema[];
  private readonly byKey: ReadonlyMap<string, ParamSchema>;
  private readonly bindings: Map<string, ParamBinding>;
  private bindingState: Readonly<Record<string, ParamBindingState>> = {};
  private values: Readonly<Record<string, ParamValue>>;

  constructor(schema: readonly ParamSchema[], options: ParamSetOptions = {}) {
    // Validate + freeze (rejects dup/empty keys, empty enums).
    this.schema = defineParams(schema);
    this.byKey = new Map(this.schema.map((s) => [s.key, s]));
    this.bindings = new Map(Object.entries(options.bindings ?? {}));
    // Seed resolved values with each param's default so getResolved() is valid
    // before the first resolve().
    const initial: Record<string, ParamValue> = {};
    for (const s of this.schema) initial[s.key] = s.default;
    this.values = Object.freeze(initial);
  }

  /** Throw if `key` is not a declared param. */
  private require(key: string): ParamSchema {
    const s = this.byKey.get(key);
    if (!s) throw new Error(`ParamSet: unknown param "${key}"`);
    return s;
  }

  /**
   * Advance one frame: resolve every param against `ctx`, update internal
   * smoothing / LFO / random state, and return the resolved values. Pure with
   * respect to `ctx` — same controller state + same `ctx` yields the same map.
   */
  resolve(ctx: ResolveContext): Readonly<Record<string, ParamValue>> {
    const bindings: ParamBindings = Object.fromEntries(this.bindings);
    const result = resolveParams(this.schema, bindings, ctx, this.bindingState);
    this.bindingState = result.state;
    this.values = result.values;
    return this.values;
  }

  /** The last resolved value for `key` (default before the first resolve). */
  get(key: string): ParamValue {
    this.require(key);
    return this.values[key] ?? this.require(key).default;
  }

  /**
   * Install a `manual` override for `key` — the resolver returns `value`
   * verbatim (range-clamped for numbers) until {@link bind} re-points it.
   */
  setManual(key: string, value: ParamValue): void {
    this.require(key);
    this.bindings.set(key, { source: "manual", value });
    // Drop any smoothing history so re-binding to auto starts clean.
    this.clearState(key);
  }

  /** Point `key` at a (typically auto) binding source, clearing manual override. */
  bind(key: string, source: ParamBinding): void {
    this.require(key);
    this.bindings.set(key, source);
    this.clearState(key);
  }

  /** Remove any binding for `key`, reverting it to a `const` at the default. */
  unbind(key: string): void {
    this.require(key);
    this.bindings.delete(key);
    this.clearState(key);
  }

  /** The current binding for `key`, or `undefined` if it defaults to const. */
  getBinding(key: string): ParamBinding | undefined {
    this.require(key);
    return this.bindings.get(key);
  }

  /** The frozen declared schema (for auto-rendering controls). */
  getSchema(): readonly ParamSchema[] {
    return this.schema;
  }

  /** All current bindings as a plain map (for serialization / introspection). */
  getBindings(): ParamBindings {
    return Object.freeze(Object.fromEntries(this.bindings));
  }

  /** The current resolved values (for live read-outs). */
  getResolved(): Readonly<Record<string, ParamValue>> {
    return this.values;
  }

  /** Drop the per-binding resolver state for `key` (smoothing/LFO/random). */
  private clearState(key: string): void {
    if (key in this.bindingState) {
      const next: Record<string, ParamBindingState> = { ...this.bindingState };
      delete next[key];
      this.bindingState = Object.freeze(next);
    }
  }
}

/** Construct a {@link ParamSet} without `new`. */
export function createParamSet(
  schema: readonly ParamSchema[],
  options: ParamSetOptions = {},
): ParamSet {
  return new ParamSet(schema, options);
}
