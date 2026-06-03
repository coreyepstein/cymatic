/**
 * Geometric / Swiss / Bauhaus preset pack for @cymatic/presets — cinematic
 * rebuild (V2-10).
 *
 * Crisp, hard-edge, modular geometry that GLOWS and EVOLVES: grids, modular
 * columns, and concentric frames built from gradient fills + additive glow +
 * bloom + light trails, with color crossfading over a track via the auto-
 * director and a rich, auto-bound param schema per preset. All on the public
 * `@cymatic/core` surface (no raw WebGL/WebGPU); named for movements/techniques,
 * never people or trademarks.
 */

import type { PresetDefinition, PresetRegistry } from "@cymatic/core";

import { opGridPreset } from "./op-grid.js";
import { modularPreset } from "./modular.js";
import { concentricPreset } from "./concentric.js";

export { opGridPreset, cellFill, gridResolution, nextRotationStep } from "./op-grid.js";
export { modularPreset, moduleHeight, moduleResolution, nextAccentModule } from "./modular.js";
export { concentricPreset, breathScale, ringResolution } from "./concentric.js";
export {
  directorColor,
  paletteForIndex,
  hot,
  dim,
  stepFlash,
  BeatFlash,
  geometricPostFx,
} from "./common.js";

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
