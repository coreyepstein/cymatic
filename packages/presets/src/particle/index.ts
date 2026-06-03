/**
 * Particle / fluid / 3D preset pack for @cymatic/presets — cinematic rebuild
 * (V2-13).
 *
 * This pack is MADE for glow + trails + bloom: a PARTICLE system drawn as
 * additive glow points that smear into luminous comet tails, a FLUID dye field
 * rendered as glowing gradient cells + glow cores, and a LIGHT 3D point cloud
 * projected (pure math, no 3D lib) to additive glows whose depth drives
 * brightness/size. All built from the public `@cymatic/core` primitive +
 * Renderer surface (gradient/glow/blend/post-FX) — no raw WebGL/WebGPU. Color is
 * sampled from the auto-director's crossfading palette + slow hue rotation (so it
 * evolves over a track); every preset uses a seeded PRNG (mulberry32) folded with
 * the director's per-section seed, so the same inputs+seed reproduce an identical
 * draw set AND each section reseeds fresh — never `Math.random()` / `Date.now`.
 * Each preset is hard-capped (particle/point count, grid size) so it stays
 * smooth. Names reference technique, never people or trademarks.
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
// Pack-specific helpers. Names already exported by another pack via the package
// barrel (`mulberry32`, `DEFAULT_SEED`, `sectionSeed` from generative;
// `directorColor`, `paletteForIndex`, `hot`, `dim` from geometric; `BeatSwell`,
// `decaySwell` from color-field) are intentionally NOT re-exported here: the
// package barrel `export *`s every pack, so re-exporting a shared name from a
// second pack would create an ambiguous duplicate. Tests import those from
// `./common.js` directly. `decayFactor`, `clampCount`, `particlePostFx` are
// unique to this pack.
export { decayFactor, clampCount, particlePostFx } from "./common.js";

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
