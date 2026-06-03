/**
 * `flowFieldPreset` — "Flow Field" (V2-12 cinematic rebuild).
 *
 * A swarm of particles advected through a deterministic curl/value-noise vector
 * field, rendered as ADDITIVE GLOW POINTS that smear into long feedback trails —
 * luminous ribbons of light tracing the field's currents. The field's spatial
 * scale and the particle speed are driven by audio + the director: bass/mid
 * broaden and energize the currents, the director's `motion` scales speed, and
 * its `density` scales how many particles are alive (sparse intro → dense drop).
 * A beat adds a gentle, decaying swell that brightens the glow rather than a hard
 * flash. Color is sampled from the director's crossfading palette + hue rotation
 * (by each particle's flow direction), so the ribbons recolor over a track.
 *
 * Determinism: a seeded PRNG ({@link mulberry32}) places particles and a
 * deterministic value-noise field advects them; the director's per-section seed
 * is folded in via {@link sectionSeed}, so each section RE-SEEDS the swarm and
 * looks fresh — never `Math.random` / `Date.now`. "Flow Field" names the
 * technique, not a person. Public `@cymatic/core` surface only (no raw GL/GPU).
 */

import {
  clamp01,
  easeInOutSine,
  mapFeature,
  smoothBand,
  type BandSmoother,
} from "@cymatic/core";
import { composePreset, type Layer, type LayerFrame, type PresetDefinition } from "@cymatic/core";

import {
  BeatSwell,
  DEFAULT_SEED,
  directorColor,
  flowAngle,
  generativePostFx,
  hot,
  mulberry32,
  sectionSeed,
  wrap01,
} from "./common.js";

/** Particles along one axis of the seeding grid (so MAX_PARTICLES = N*N). */
const GRID = 26;
/** Maximum particle count — the director's density scales the live fraction. */
export const PARTICLE_COUNT = GRID * GRID;
/** Smoothing weight for the audio-driven field parameters (kept-from-previous). */
const PARAM_SMOOTHING = 0.85;

const P = {
  count: "particleCount",
  fieldScale: "fieldScale",
  fieldStrength: "fieldStrength",
  glow: "glowIntensity",
  trail: "trailDecay",
  bloom: "bloomAmount",
  hueDrift: "hueDrift",
  swell: "beatSwell",
} as const;

interface Particle {
  x: number;
  y: number;
}

/**
 * Per-frame field parameters from (smoothed) bass/mid, the director's motion,
 * and a decaying beat swell. Pure + exported so a test can assert that louder
 * bass broadens the currents (lower noise frequency) and mid + motion + swell
 * raise particle speed, smoothly. `scale` is the noise frequency; `speed` is
 * per-second advection.
 */
export function fieldParams(
  smoothedBass: number,
  smoothedMid: number,
  motion: number,
  swell: number,
  strength: number,
): { scale: number; speed: number } {
  // Bass broadens the currents (lower frequency = larger sweeping structures).
  const scale = mapFeature(easeInOutSine(smoothedBass), 4.5, 1.6);
  // Mid + the director's motion + a decaying beat swell push particle speed,
  // scaled by the `fieldStrength` param.
  const drive = clamp01(smoothedMid * 0.6 + swell * 0.4);
  const speed = mapFeature(drive, 0.05, 0.5) * (0.5 + motion * 0.5) * (0.4 + strength);
  return { scale, speed };
}

/**
 * How many particles are alive this frame from the `particleCount` param and the
 * director's density. Pure + exported: higher density → more live ribbons (a
 * busier drop), always within `[some floor, PARTICLE_COUNT]`.
 */
export function liveParticles(countParam: number, density: number): number {
  const frac = clamp01(countParam) * clamp01(density / 1.6);
  return Math.max(48, Math.min(PARTICLE_COUNT, Math.round(PARTICLE_COUNT * (0.25 + frac))));
}

function makeFlowFieldLayer(baseSeed: number): Layer {
  const particles: Particle[] = [];
  let bassS: BandSmoother | null = null;
  let midS: BandSmoother | null = null;
  let trebleS: BandSmoother | null = null;
  const swell = new BeatSwell(0.45);
  // The combined seed currently driving the swarm; re-seeds on a director change.
  let activeSeed = baseSeed;

  function seedParticles(seed: number): void {
    particles.length = 0;
    const reseed = mulberry32(seed);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push({ x: reseed(), y: reseed() });
    }
  }

  return {
    id: "generative.flow-field",
    init(): void {
      bassS = smoothBand("bass", PARAM_SMOOTHING);
      midS = smoothBand("mid", PARAM_SMOOTHING);
      trebleS = smoothBand("treble", PARAM_SMOOTHING);
      swell.reset();
      activeSeed = sectionSeed(baseSeed, 0);
      seedParticles(activeSeed);
    },
    draw({ renderer, features, director, params, dt }: LayerFrame): void {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
      const bass = (bassS ?? smoothBand("bass", PARAM_SMOOTHING)).push(features);
      const mid = (midS ?? smoothBand("mid", PARAM_SMOOTHING)).push(features);
      const treble = (trebleS ?? smoothBand("treble", PARAM_SMOOTHING)).push(features);
      const swellAmt = swell.update(features.onset, step);

      const glowK = clamp01(Number(params[P.glow] ?? 0.7));
      const trail = clamp01(Number(params[P.trail] ?? 0.85));
      const bloomAmt = clamp01(Number(params[P.bloom] ?? director.bloom));
      const hueDrift = clamp01(Number(params[P.hueDrift] ?? 0.5));
      const swellGain = clamp01(Number(params[P.swell] ?? 0.6));
      const strength = clamp01(Number(params[P.fieldStrength] ?? 0.6));
      const countParam = clamp01(Number(params[P.count] ?? 0.6));

      // Per-section reseed: when the director hands a fresh seed, re-seed the
      // swarm so the section's currents look new. Deterministic given the seed.
      const wantSeed = sectionSeed(baseSeed, director.seed);
      if (wantSeed !== activeSeed) {
        activeSeed = wantSeed;
        seedParticles(activeSeed);
      }

      const { scale, speed } = fieldParams(bass, mid, director.motion, swellAmt * swellGain, strength);
      const live = liveParticles(countParam, director.density);

      // Cinematic post-FX: bloom on, long feedback trail → luminous ribbons.
      renderer.setPostEffects(generativePostFx(bloomAmt, trail));

      // A deep, palette-tinted void rather than flat black, so the ribbons float
      // on a color that itself evolves with the director.
      const voidColor = directorColor(director, 0.04);
      renderer.beginFrame({ r: voidColor.r * 0.1, g: voidColor.g * 0.1, b: voidColor.b * 0.12, a: 1 });

      // Glow points are inherently additive light; the trail (feedback) smears
      // their motion into ribbons. Radius/intensity rise with energy + the swell.
      const intensity = clamp01(director.intensity + bass * 0.4);
      const baseRadius = 0.006 + glowK * 0.012;
      for (let i = 0; i < live; i++) {
        const p = particles[i]!;
        const angle = flowAngle(p.x, p.y, scale, activeSeed);
        p.x = wrap01(p.x + Math.cos(angle) * speed * step);
        p.y = wrap01(p.y + Math.sin(angle) * speed * step);

        // Color by flow direction so currents read as bands of evolving hue; the
        // hueDrift param + treble widen how far across the palette the swarm reaches.
        const dirT = ((angle / (Math.PI * 4)) % 1 + 1) % 1;
        const t = clamp01(dirT * (0.4 + 0.6 * hueDrift) + treble * 0.15);
        const col = directorColor(director, t);
        const gain = 0.6 + glowK * 1.4 + intensity * 1.1 + swellAmt * swellGain * 1.6;
        renderer.drawGlow({
          x: p.x,
          y: p.y,
          radius: baseRadius * (1 + intensity * 0.6 + swellAmt * swellGain * 0.5),
          color: hot(col, 1),
          intensity: gain,
        });
      }

      renderer.endFrame();
    },
    dispose(): void {
      particles.length = 0;
      bassS = null;
      midS = null;
      trebleS = null;
      swell.reset();
    },
  };
}

const FLOW_PARAMS = [
  { key: P.count, label: "Particle count", group: "Swarm", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.fieldScale, label: "Field scale", group: "Field", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.5 },
  { key: P.fieldStrength, label: "Field strength", group: "Field", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.glow, label: "Glow intensity", group: "Light", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.7 },
  { key: P.bloom, label: "Bloom amount", group: "Light", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.trail, label: "Trail decay", group: "Light", type: "number" as const, min: 0, max: 0.92, step: 0.01, default: 0.85 },
  { key: P.swell, label: "Beat swell", group: "Light", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.hueDrift, label: "Hue drift", group: "Color", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.5 },
];

const FLOW_BINDINGS = {
  // Particle count follows the director's density (sparse intro → dense drop);
  // field strength + glow build with intensity; the swell rides bass.
  [P.count]: { source: "director" as const, path: "density", inMin: 0.5, inMax: 1.6, smoothing: 0.8 },
  [P.fieldStrength]: { source: "director" as const, path: "intensity", outMin: 0.4, outMax: 1, smoothing: 0.8 },
  [P.glow]: { source: "director" as const, path: "intensity", outMin: 0.45, outMax: 1, smoothing: 0.8 },
  [P.bloom]: { source: "director" as const, path: "bloom", smoothing: 0.8 },
  [P.swell]: { source: "audio" as const, path: "bass", outMin: 0.4, outMax: 1, smoothing: 0.7 },
  [P.hueDrift]: { source: "audio" as const, path: "treble", outMin: 0.3, outMax: 0.9, smoothing: 0.85 },
};

/** The Flow Field preset definition — rich param schema with audio/director bindings. */
export const flowFieldPreset: PresetDefinition = composePreset({
  id: "generative.flow-field",
  name: "Flow Field",
  description:
    "A swarm of particles advected through a deterministic noise field, drawn as additive glow points that smear into long luminous ribbons: bass broadens the currents, the director's motion/density energize and populate them, and a beat swells the glow as the color crossfades over the track.",
  tags: ["generative", "flow-field", "particles", "ribbons", "cinematic"],
  params: FLOW_PARAMS,
  bindings: FLOW_BINDINGS,
  layers: () => [makeFlowFieldLayer(DEFAULT_SEED)],
});

/** Build a Flow Field definition with an explicit seed (used by tests). */
export function flowFieldPresetWithSeed(seed: number): PresetDefinition {
  return composePreset({
    id: `generative.flow-field.${seed}`,
    name: "Flow Field",
    description: flowFieldPreset.description,
    tags: flowFieldPreset.tags,
    params: FLOW_PARAMS,
    bindings: FLOW_BINDINGS,
    layers: () => [makeFlowFieldLayer(seed)],
  });
}
