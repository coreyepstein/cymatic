/**
 * Public parameter-system surface for @cymatic/core (V2-08).
 *
 * A declarative, introspectable named-parameter framework presets use to expose
 * tunable knobs that can be driven automatically (audio / mood / director / LFO
 * / seeded random) or manually. A preset declares a {@link ParamSchema} list,
 * wires each key to a {@link ParamBinding}, and reads resolved values each frame
 * via a {@link ParamSet} (or the pure {@link resolveParams}). Manual overrides
 * always beat automation. Everything here is pure + deterministic (no
 * `Date.now` / `Math.random`) so offline rendering reproduces exactly.
 */

export type {
  ParamType,
  ParamOption,
  ParamSchema,
  NumberParamSchema,
  ColorParamSchema,
  EnumParamSchema,
  ParamValue,
} from "./schema.js";
export { defineParams, numberRange, optionLabel } from "./schema.js";

export type {
  ParamBinding,
  ParamBindings,
  BindingMap,
  LfoShape,
  ConstBinding,
  AudioBinding,
  DirectorBinding,
  LfoBinding,
  RandomBinding,
  ManualBinding,
} from "./bindings.js";
export { getNumberPath, readAudioPath, readDirectorPath } from "./bindings.js";

export type {
  ResolveContext,
  ResolvedParams,
  ParamBindingState,
} from "./resolve.js";
export { resolveParams } from "./resolve.js";

export type { ParamSetOptions } from "./param-set.js";
export { ParamSet, createParamSet } from "./param-set.js";
