/**
 * `flowFieldPreset` — "Flow Field". A grid of particles advected through a
 * deterministic (pseudo-)noise vector field, each drawn as a tiny rect. The
 * field's spatial scale and the particle speed are driven by audio: bass widens
 * the field scale (broader, sweeping currents), treble adds speed, and a beat
 * injects a short burst of energy that decays away. Heavily smoothed parameters
 * keep the motion tasteful rather than jittery. Particles wrap toroidally so the
 * field stays populated. "Flow Field" names the technique, not a person.
 *
 * Public-surface only: `band`, easing/`Smoother`, palette `sample`/`mixColor`,
 * and `Renderer.drawRect`. A seeded PRNG ({@link mulberry32}) places particles
 * and a deterministic value-noise field advects them, so output is reproducible.
 */

import {
  band,
  clamp01,
  easeInOutSine,
  mapFeature,
  mixColor,
  palettes,
  sample,
  Smoother,
} from "@cymatic/core";
import { composePreset, type Layer, type LayerFrame, type PresetDefinition } from "@cymatic/core";

import {
  DEFAULT_SEED,
  flowAngle,
  mulberry32,
  wrap01,
} from "./common.js";

/** Particles along one axis of the seeding grid (so PARTICLES = N*N). */
const GRID = 28;
/** Total particle count — coarse enough to stay cheap, dense enough to read. */
export const PARTICLE_COUNT = GRID * GRID;
/** Side length of each particle's rect, in normalized units. */
const DOT = 0.006;
/** Smoothing weight for the audio-driven field parameters. */
const PARAM_SMOOTHING = 0.85;

interface Particle {
  x: number;
  y: number;
}

/**
 * Per-frame field parameters derived from audio. Pure + exported so a test can
 * assert that louder bass widens the field scale and treble/beat raise speed,
 * smoothly. `scale` is the noise frequency; `speed` is per-second advection.
 */
export function fieldParams(
  smoothedBass: number,
  smoothedTreble: number,
  burst: number,
): { scale: number; speed: number } {
  // Bass broadens the currents (lower frequency = larger sweeping structures).
  const scale = mapFeature(easeInOutSine(smoothedBass), 4.5, 1.6);
  // Treble + a decaying beat burst push particle speed.
  const speed = mapFeature(clamp01(smoothedTreble + burst * 0.6), 0.04, 0.42);
  return { scale, speed };
}

function makeFlowFieldLayer(seed: number): Layer {
  const rng = mulberry32(seed);
  const particles: Particle[] = [];
  const bassS = new Smoother(PARAM_SMOOTHING, 0);
  const trebleS = new Smoother(PARAM_SMOOTHING, 0);
  let burst = 0;

  function seedParticles(): void {
    particles.length = 0;
    const reseed = mulberry32(seed);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push({ x: reseed(), y: reseed() });
    }
  }

  return {
    id: "generative.flow-field",
    init(): void {
      bassS.reset(0);
      trebleS.reset(0);
      burst = 0;
      seedParticles();
      void rng; // particles are seeded deterministically via `reseed`.
    },
    draw({ renderer, features, dt }: LayerFrame): void {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
      const bass = bassS.push(band(features, "bass"));
      const treble = trebleS.push(band(features, "treble"));
      // Beat burst: jump on an onset, decay otherwise (frame-rate independent).
      const decay = Math.pow(0.5, step / 0.5);
      burst = features.onset ? clamp01(burst * decay + 0.8) : clamp01(burst * decay);

      const { scale, speed } = fieldParams(bass, treble, burst);

      const bg = mixColor(sample(palettes.aqua, 0), { r: 0, g: 0, b: 0, a: 1 }, 0.55);
      renderer.beginFrame(bg);

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i]!;
        const angle = flowAngle(p.x, p.y, scale, seed);
        p.x = wrap01(p.x + Math.cos(angle) * speed * step);
        p.y = wrap01(p.y + Math.sin(angle) * speed * step);

        // Color by direction so currents read as bands of hue; brightness rises
        // with the beat burst.
        const hueT = (angle / (Math.PI * 4)) % 1;
        const base = sample(palettes.aqua, clamp01(hueT));
        const color = mixColor(
          { r: 0, g: 0, b: 0, a: base.a },
          base,
          clamp01(0.45 + treble * 0.4 + burst * 0.3),
        );
        renderer.drawRect({ x: p.x - DOT / 2, y: p.y - DOT / 2, w: DOT, h: DOT, color });
      }

      renderer.endFrame();
    },
    dispose(): void {
      particles.length = 0;
      bassS.reset(0);
      trebleS.reset(0);
      burst = 0;
    },
  };
}

/** The Flow Field preset definition. */
export const flowFieldPreset: PresetDefinition = composePreset({
  id: "generative.flow-field",
  name: "Flow Field",
  description:
    "A grid of particles advected through a deterministic noise vector field, each a tiny rect: bass widens the field's currents, treble adds speed, and a beat injects a decaying burst of energy.",
  tags: ["generative", "flow-field", "particles", "algorithmic"],
  layers: () => [makeFlowFieldLayer(DEFAULT_SEED)],
});

/** Build a Flow Field definition with an explicit seed (used by tests). */
export function flowFieldPresetWithSeed(seed: number): PresetDefinition {
  return composePreset({
    id: `generative.flow-field.${seed}`,
    name: "Flow Field",
    description: flowFieldPreset.description,
    tags: flowFieldPreset.tags,
    layers: () => [makeFlowFieldLayer(seed)],
  });
}
