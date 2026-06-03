/**
 * Declarative parameter *schema* for @cymatic/core presets (V2-08).
 *
 * A preset exposes its tunable knobs as a list of {@link ParamSchema} entries.
 * Each entry is pure metadata — a key, a label, a group, a type, a default, and
 * (for numbers) a range / step or (for enums) a set of options. The schema is
 * inert and serializable so a host (the gallery, the export pipeline) can
 * introspect it to auto-render controls and validate values without running the
 * preset.
 *
 * The schema never holds a *value* — values are resolved each frame from the
 * {@link ParamBinding}s by the resolver (see `resolve.ts`). Keeping schema and
 * binding separate is what lets the same preset be driven manually, by audio,
 * by the director, by an LFO, or by seeded randomness without touching the
 * preset's own code.
 */

/** The kinds of value a parameter can hold. */
export type ParamType = "number" | "color" | "enum";

/** A single option for an `enum` parameter. */
export interface ParamOption {
  /** The stored value (what a binding resolves to). */
  readonly value: string;
  /** Human-readable label for the control. Defaults to `value`. */
  readonly label?: string;
}

/** Common metadata shared by every parameter, regardless of type. */
interface ParamBase {
  /** Stable, unique key within a preset (e.g. `"radius"`, `"baseColor"`). */
  readonly key: string;
  /** Human-readable label for the control. */
  readonly label: string;
  /** Optional grouping for the UI (e.g. `"Geometry"`, `"Color"`). */
  readonly group?: string;
  /** Optional one-line description / tooltip. */
  readonly description?: string;
}

/**
 * A numeric parameter. `min`/`max` bound the value (and define the range a
 * normalized `[0, 1]` source maps onto); `step` is a UI hint only.
 */
export interface NumberParamSchema extends ParamBase {
  readonly type: "number";
  readonly default: number;
  /** Lower bound. Defaults to `0` when omitted. */
  readonly min?: number;
  /** Upper bound. Defaults to `1` when omitted. */
  readonly max?: number;
  /** UI step hint. Optional; does not affect resolution. */
  readonly step?: number;
}

/**
 * A color parameter, stored as a CSS-style string (e.g. `"#ff8800"`). Colors
 * are passed through verbatim; only `const`/`manual` bindings are meaningful for
 * them (auto sources produce numbers).
 */
export interface ColorParamSchema extends ParamBase {
  readonly type: "color";
  readonly default: string;
}

/**
 * An enum parameter — one of a fixed set of string options. A numeric auto
 * source selects an option by mapping `[0, 1]` across the option list.
 */
export interface EnumParamSchema extends ParamBase {
  readonly type: "enum";
  readonly default: string;
  readonly options: readonly ParamOption[];
}

/** The schema for one parameter. Discriminated on {@link ParamType}. */
export type ParamSchema =
  | NumberParamSchema
  | ColorParamSchema
  | EnumParamSchema;

/** The resolved value of a parameter: a number for `number`, a string otherwise. */
export type ParamValue = number | string;

/**
 * Normalize an enum's options to always carry a `label`. Pure helper used by
 * the controller's introspection surface.
 */
export function optionLabel(option: ParamOption): string {
  return option.label ?? option.value;
}

/** Resolved `[min, max]` for a number param, applying the documented defaults. */
export function numberRange(schema: NumberParamSchema): readonly [number, number] {
  const min = schema.min ?? 0;
  const max = schema.max ?? 1;
  // Guard against an inverted range so mapping stays well-defined.
  return min <= max ? [min, max] : [max, min];
}

/**
 * Validate + freeze a list of param schemas. Rejects empty keys and duplicate
 * keys (a preset's keys must be unique), and requires enums to declare at least
 * one option. Returns a frozen array of frozen entries.
 */
export function defineParams(
  schemas: readonly ParamSchema[],
): readonly ParamSchema[] {
  const seen = new Set<string>();
  for (const schema of schemas) {
    const key = schema.key.trim();
    if (key.length === 0) {
      throw new Error("defineParams: every param needs a non-empty `key`");
    }
    if (seen.has(key)) {
      throw new Error(`defineParams: duplicate param key "${key}"`);
    }
    seen.add(key);
    if (schema.type === "enum" && schema.options.length === 0) {
      throw new Error(`defineParams: enum param "${key}" needs at least one option`);
    }
  }
  return Object.freeze(schemas.map((s) => Object.freeze({ ...s })));
}
