/**
 * Geometric / Swiss / Bauhaus preset pack for @cymatic/presets.
 *
 * Flat, hard-edge, modular geometry — grids, op-art, and concentric frames —
 * all built purely from the public `@cymatic/core` primitive + Renderer surface
 * (no raw WebGL/WebGPU) and named for movements/techniques, never people or
 * trademarks.
 */

import type { PresetDefinition, PresetRegistry } from "@cymatic/core";

import { opGridPreset } from "./op-grid.js";
import { modularPreset } from "./modular.js";
import { concentricPreset } from "./concentric.js";

export { opGridPreset, cellFill, nextRotationStep } from "./op-grid.js";
export { modularPreset, moduleHeight, nextAccentModule } from "./modular.js";
export { concentricPreset, breathScale } from "./concentric.js";

/** Every preset in the geometric pack, in display order. */
export const geometricPresets: readonly PresetDefinition[] = [
  opGridPreset,
  modularPreset,
  concentricPreset,
];

/**
 * Register the whole geometric pack into a {@link PresetRegistry}. Returns the
 * registered definitions for convenience. Pass `{ replace: true }` to overwrite
 * existing ids (e.g. when re-registering in tests).
 */
export function registerGeometricPresets(
  registry: PresetRegistry,
  options: { replace?: boolean } = {},
): readonly PresetDefinition[] {
  for (const preset of geometricPresets) {
    registry.register(preset, options);
  }
  return geometricPresets;
}
