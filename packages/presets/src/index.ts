/**
 * @cymatic/presets — curated visualizer presets for cymatic.
 *
 * Presets are authored purely against the public `@cymatic/core` surface
 * (primitives + the backend-agnostic Renderer) and registered into the shared
 * {@link defaultPresetRegistry} so hosts can discover them by id.
 */
import { version as coreVersion, defaultPresetRegistry } from "@cymatic/core";

import { geometricPresets, registerGeometricPresets } from "./geometric/index.js";
import { colorfieldPresets, registerColorfieldPresets } from "./colorfield/index.js";

/** Semantic version of the @cymatic/presets package surface. */
export const version = "0.0.0";

/** The version of @cymatic/core this preset bundle was built against. */
export const builtAgainstCore = coreVersion;

// The geometric / Swiss / Bauhaus pack.
export * from "./geometric/index.js";

// The color-field / Rothko-adjacent pack (luminous gradient atmospheres).
export * from "./colorfield/index.js";

/** Every preset definition shipped in this build, in display order. */
export const allPresets = [...geometricPresets, ...colorfieldPresets] as const;

/** Identifiers of presets shipped in this build. */
export const presetIds: readonly string[] = allPresets.map((p) => p.id);

// Register the bundled packs into the shared default registry as a side effect
// of importing the package, so a host that imports @cymatic/presets can resolve
// any shipped preset by id from `defaultPresetRegistry`.
registerGeometricPresets(defaultPresetRegistry, { replace: true });
registerColorfieldPresets(defaultPresetRegistry, { replace: true });
