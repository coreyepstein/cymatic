/**
 * Color-field / Rothko-adjacent preset pack for @cymatic/presets.
 *
 * Luminous gradient regions with slow, breathing, non-jittery motion — fields,
 * washes, and bands — all built purely from the public `@cymatic/core` primitive
 * + Renderer surface (no raw WebGL/WebGPU). The gradient look is achieved by
 * stacking many thin strips whose colors are sampled from a palette gradient.
 * Names reference technique/mood, never people or trademarks.
 */

import type { PresetDefinition, PresetRegistry } from "@cymatic/core";

import { fieldPreset } from "./field.js";
import { washPreset } from "./wash.js";
import { bandsPreset } from "./bands.js";

export { fieldPreset, fieldLuminance } from "./field.js";
export { washPreset, horizonY } from "./wash.js";
export { bandsPreset, bandBoundaries } from "./bands.js";
export { BeatSwell, decaySwell, FIELD_SMOOTHING, gradientStripCount } from "./common.js";

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
