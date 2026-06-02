/**
 * Generative / algorithmic preset pack for @cymatic/presets.
 *
 * Presets that evolve internal state — a particle flow field, a Gray-Scott
 * reaction-diffusion grid, an accumulating pen-plotter path — and visualize it
 * as many small rects. All built purely from the public `@cymatic/core`
 * primitive + Renderer surface (no raw WebGL/WebGPU). Every preset uses a seeded
 * PRNG (mulberry32) instead of `Math.random()`, so the same seed plus the same
 * audio/time inputs reproduce an identical draw set — reproducible and
 * unit-testable. Names reference technique, never people or trademarks.
 */

import type { PresetDefinition, PresetRegistry } from "@cymatic/core";

import { flowFieldPreset } from "./flow-field.js";
import { reactionPreset } from "./reaction-diffusion.js";
import { plotterPreset } from "./plotter.js";

export {
  flowFieldPreset,
  flowFieldPresetWithSeed,
  fieldParams,
  PARTICLE_COUNT,
} from "./flow-field.js";
export {
  reactionPreset,
  reactionPresetWithSeed,
  reactionParams,
  reactionSteps,
  GRID_SIZE,
} from "./reaction-diffusion.js";
export {
  plotterPreset,
  plotterPresetWithSeed,
  plotterDensity,
  plotterCurve,
  TRAIL,
} from "./plotter.js";
export {
  mulberry32,
  valueNoise2D,
  flowAngle,
  wrap01,
  DEFAULT_SEED,
} from "./common.js";

/** Every preset in the generative pack, in display order. */
export const generativePresets: readonly PresetDefinition[] = [
  flowFieldPreset,
  reactionPreset,
  plotterPreset,
];

/**
 * Register the whole generative pack into a {@link PresetRegistry}. Returns the
 * registered definitions for convenience. Pass `{ replace: true }` to overwrite
 * existing ids (e.g. when re-registering in tests).
 */
export function registerGenerativePresets(
  registry: PresetRegistry,
  options: { replace?: boolean } = {},
): readonly PresetDefinition[] {
  for (const preset of generativePresets) {
    registry.register(preset, options);
  }
  return generativePresets;
}
