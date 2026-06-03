/**
 * Generative / algorithmic preset pack for @cymatic/presets — cinematic rebuild
 * (V2-12).
 *
 * Luminous algorithmic art: a particle FLOW FIELD rendered as additive glow
 * points smeared into long feedback trails (luminous ribbons), a REACTION
 * (Gray-Scott) bath whose concentration becomes glowing color, and a PLOTTER
 * that inks glowing additive lines. All built from the public `@cymatic/core`
 * primitive + Renderer surface (gradient/glow/line/blend/post-FX) — no raw
 * WebGL/WebGPU. Color is sampled from the auto-director's crossfading palette +
 * slow hue rotation (so it evolves over a track); every preset uses a seeded
 * PRNG (mulberry32) folded with the director's per-section seed, so the same
 * inputs+seed reproduce an identical draw set AND each section reseeds fresh —
 * never `Math.random()` / `Date.now`. Names reference technique, never people or
 * trademarks.
 */

import type { PresetDefinition, PresetRegistry } from "@cymatic/core";

import { flowFieldPreset } from "./flow-field.js";
import { reactionPreset } from "./reaction-diffusion.js";
import { plotterPreset } from "./plotter.js";

export {
  flowFieldPreset,
  flowFieldPresetWithSeed,
  fieldParams,
  liveParticles,
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
// Pack-specific helpers (seeded RNG, noise field, per-section reseed, post-FX).
// Names already exported by another pack via the package barrel (`directorColor`,
// `paletteForIndex`, `hot`, `dim` from geometric; `BeatSwell`, `decaySwell` from
// color-field) are intentionally NOT re-exported here: the package barrel
// `export *`s every pack, so re-exporting a shared name from a second pack would
// create an ambiguous duplicate. Tests import those from `./common.js` directly.
export {
  mulberry32,
  valueNoise2D,
  flowAngle,
  wrap01,
  sectionSeed,
  generativePostFx,
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
