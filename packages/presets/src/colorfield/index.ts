/**
 * Color-field / Rothko-adjacent preset pack for @cymatic/presets — cinematic
 * rebuild (V2-11).
 *
 * Luminous, breathing color *atmospheres* with slow, non-jittery motion —
 * fields, washes, and bands — built from gradient fills + soft additive glow +
 * heavy bloom + long feedback trails, with color crossfading over a track via
 * the auto-director's palette + slow hue rotation and a rich, auto-bound param
 * schema per preset. All on the public `@cymatic/core` surface (no raw WebGL/
 * WebGPU); named for technique/mood, never people or trademarks.
 */

import type { PresetDefinition, PresetRegistry } from "@cymatic/core";

import { fieldPreset } from "./field.js";
import { washPreset } from "./wash.js";
import { bandsPreset } from "./bands.js";

export { fieldPreset, fieldLuminance } from "./field.js";
export { washPreset, horizonY } from "./wash.js";
export { bandsPreset, bandBoundaries, bandResolution } from "./bands.js";
// Color-field-specific helpers. The generic director-color helpers
// (`directorColor`, `paletteForIndex`, `hot`, `dim`) are intentionally NOT
// re-exported here: the package barrel `export *`s every pack, and the geometric
// pack already exports those same names — re-exporting them from a second pack
// would create an ambiguous duplicate. Tests import them from `./common.js`.
export { BeatSwell, decaySwell, FIELD_SMOOTHING, gradientStripCount, colorfieldPostFx } from "./common.js";

/** Every preset in the color-field pack, in display order. */
export const colorfieldPresets: readonly PresetDefinition[] = [
  fieldPreset,
  washPreset,
  bandsPreset,
];

/**
 * Register the whole color-field pack into a {@link PresetRegistry}. Returns the
 * registered definitions for convenience. Pass `{ replace: true }` to overwrite
 * existing ids (e.g. when re-registering in tests).
 */
export function registerColorfieldPresets(
  registry: PresetRegistry,
  options: { replace?: boolean } = {},
): readonly PresetDefinition[] {
  for (const preset of colorfieldPresets) {
    registry.register(preset, options);
  }
  return colorfieldPresets;
}
