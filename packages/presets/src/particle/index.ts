/**
 * Particle / fluid / 3D preset pack for @cymatic/presets.
 *
 * Presets that evolve physical-ish state — a bounded particle system, a coarse
 * advected dye field, and a perspective-projected rotating point cloud — and
 * visualize it as many small rects. All built purely from the public
 * `@cymatic/core` primitive + Renderer surface (no raw WebGL/WebGPU). Every
 * preset uses a seeded PRNG (mulberry32) instead of `Math.random()`/`Date`, so
 * the same seed plus the same audio/time inputs reproduce an identical draw set
 * — reproducible and unit-testable. Each exposes a configurable, hard-capped
 * budget (particle count / grid size / point count) so it stays smooth at
 * typical resolution. Names reference technique, never people or trademarks.
 */

import type { PresetDefinition, PresetRegistry } from "@cymatic/core";

import { particlesPreset } from "./particles.js";
import { fluidPreset } from "./fluid.js";
import { light3dPreset } from "./light-3d.js";

export {
  particlesPreset,
  particlesPresetWithSeed,
  emissionCount,
  emissionSpeed,
  DEFAULT_MAX_PARTICLES,
  MAX_PARTICLES_LIMIT,
  type ParticlesOptions,
} from "./particles.js";
export {
  fluidPreset,
  fluidPresetWithSeed,
  fluidParams,
  DEFAULT_GRID_SIZE,
  MAX_GRID_SIZE,
  type FluidOptions,
} from "./fluid.js";
export {
  light3dPreset,
  light3dPresetWithSeed,
  light3dParams,
  project,
  DEFAULT_MAX_POINTS,
  MAX_POINTS_LIMIT,
  type Light3dOptions,
} from "./light-3d.js";
// Note: the seeded PRNG (`mulberry32`) and `DEFAULT_SEED` are intentionally NOT
// re-exported here — the generative pack already surfaces them on the package's
// public API, and re-exporting would make those names ambiguous under the
// top-level `export *`. The particle-specific helpers below are unique.
export { decayFactor, advanceBurst, clampCount } from "./common.js";

/** Every preset in the particle pack, in display order. */
export const particlePresets: readonly PresetDefinition[] = [
  particlesPreset,
  fluidPreset,
  light3dPreset,
];

/**
 * Register the whole particle pack into a {@link PresetRegistry}. Returns the
 * registered definitions for convenience. Pass `{ replace: true }` to overwrite
 * existing ids (e.g. when re-registering in tests).
 */
export function registerParticlePresets(
  registry: PresetRegistry,
  options: { replace?: boolean } = {},
): readonly PresetDefinition[] {
  for (const preset of particlePresets) {
    registry.register(preset, options);
  }
  return particlePresets;
}
