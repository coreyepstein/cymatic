/**
 * `particlesPreset` — "Particles" (V2-13 cinematic rebuild).
 *
 * A bounded particle system rendered as ADDITIVE GLOW POINTS that smear into
 * long feedback COMET TAILS — luminous sparks thrown from the center on beats.
 * Audio + the director drive it:
 *
 *   - EMISSION fires a burst on every beat/onset (a decaying swell) plus a
 *     trickle on sustained level; the director's `density` scales how many
 *     sparks each burst throws (sparse intro → dense drop).
 *   - INITIAL VELOCITY + SIZE scale with bass — heavier low end throws sparks
 *     farther/faster and bigger.
 *   - GLOW intensity rises with the director's intensity + the beat swell, so
 *     the field breathes brighter on the drop and on every beat.
 *   - COLOR is sampled from the director's crossfading palette + hue rotation
 *     (by each spark's age + a hue-drift param), so the field recolors over a
 *     track.
 *
 * The system is hard-capped (`maxParticles`, default 700) so it stays smooth at
 * typical resolution; emission never exceeds the free slots. Determinism: a
 * seeded PRNG ({@link mulberry32}) drives emission angles/jitter and the
 * director's per-section seed is folded in via {@link sectionSeed}, so each
 * section RE-SEEDS the spray and looks fresh — never `Math.random` / `Date.now`.
 * "Particles" names the technique. Public `@cymatic/core` surface only.
 */

import {
  band,
  clamp01,
  level,
  mapFeature,
  type AudioFeatureFrame,
} from "@cymatic/core";
import { composePreset, type Layer, type LayerFrame, type PresetDefinition } from "@cymatic/core";

import {
  BeatSwell,
  clampCount,
  decayFactor,
  DEFAULT_SEED,
  directorColor,
  hot,
  mulberry32,
  particlePostFx,
  sectionSeed,
} from "./common.js";

/** Default hard cap on live particles — dense enough to read, modest for smoothness. */
export const DEFAULT_MAX_PARTICLES = 700;
/** Absolute upper bound regardless of requested config (perf guard). */
export const MAX_PARTICLES_LIMIT = 2400;
/** Base glow radius (normalized) before audio/age scaling. */
const BASE_RADIUS = 0.006;

const P = {
  count: "particleCount",
  emission: "emissionRate",
  velocity: "velocity",
  glow: "glowIntensity",
  trail: "trailDecay",
  bloom: "bloomAmount",
  hueDrift: "hueDrift",
  swell: "beatSwell",
} as const;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Remaining life in seconds. */
  life: number;
  /** Original life span, for normalized age. */
  span: number;
  /** Palette position [0,1] captured at emission. */
  hue: number;
  alive: boolean;
}

/** Options for {@link makeParticlesLayer} / the Particles preset. */
export interface ParticlesOptions {
  /** Hard cap on live particles. Defaults to {@link DEFAULT_MAX_PARTICLES}. */
  maxParticles?: number;
}

/**
 * How many particles to emit this frame from a beat swell, overall level, the
 * `emissionRate` param, and the director's density. Pure + exported so a test
 * can assert a beat (and a denser director) raises emission above silence. The
 * result is clamped to available free slots by the caller.
 */
export function emissionCount(
  swell: number,
  lvl: number,
  onset: boolean,
  rate: number,
  density: number,
): number {
  const gain = (0.4 + clamp01(rate)) * (0.5 + clamp01(density / 1.6));
  // A beat sprays a burst proportional to the swell; sustained loudness adds a
  // steady trickle. Silence emits nothing.
  const beatSpray = onset ? Math.round(16 * gain) : 0;
  const burstSpray = Math.round(mapFeature(clamp01(swell), 0, 22) * gain);
  const trickle = Math.round(mapFeature(clamp01(lvl), 0, 5) * gain);
  return beatSpray + burstSpray + trickle;
}

/**
 * Initial outward speed for a freshly emitted particle, scaled by bass and the
 * `velocity` param. Pure + exported so a test can assert louder bass throws
 * particles faster.
 */
export function emissionSpeed(bass: number, velocityParam: number): number {
  return mapFeature(clamp01(bass), 0.14, 1.0) * (0.4 + clamp01(velocityParam));
}

function makeParticlesLayer(seed: number, options: ParticlesOptions = {}): Layer {
  const cap = clampCount(
    options.maxParticles ?? DEFAULT_MAX_PARTICLES,
    DEFAULT_MAX_PARTICLES,
    MAX_PARTICLES_LIMIT,
  );
  const pool: Particle[] = [];
  const swell = new BeatSwell(0.38);
  // The combined seed currently driving the spray; re-seeds on a director change.
  let activeSeed = seed;
  let rng = mulberry32(seed);

  function resetPool(): void {
    pool.length = 0;
    for (let i = 0; i < cap; i++) {
      pool.push({ x: 0.5, y: 0.5, vx: 0, vy: 0, life: 0, span: 1, hue: 0, alive: false });
    }
  }

  /** Choose a palette ramp position from the loudest band: bass→warm low, treble→cool high. */
  function hueForFrame(features: AudioFeatureFrame, drift: number): number {
    const b = band(features, "bass");
    const m = band(features, "mid");
    const t = band(features, "treble");
    const total = b + m + t;
    if (total <= 0) return clamp01(0.2 + drift * 0.6);
    return clamp01(((m * 0.5 + t * 1) / total) * (0.4 + 0.6 * drift) + drift * 0.2);
  }

  function emit(features: AudioFeatureFrame, count: number, velocityParam: number, drift: number): void {
    const bass = band(features, "bass");
    const speed = emissionSpeed(bass, velocityParam);
    const hue = hueForFrame(features, drift);
    let spawned = 0;
    for (let i = 0; i < pool.length && spawned < count; i++) {
      const p = pool[i]!;
      if (p.alive) continue;
      const angle = rng() * Math.PI * 2;
      const jitter = 0.6 + rng() * 0.8;
      p.x = 0.5;
      p.y = 0.5;
      p.vx = Math.cos(angle) * speed * jitter;
      p.vy = Math.sin(angle) * speed * jitter;
      p.span = 0.7 + rng() * 1.4;
      p.life = p.span;
      p.hue = clamp01(hue + (rng() - 0.5) * 0.2);
      p.alive = true;
      spawned++;
    }
  }

  return {
    id: "particle.particles",
    init(): void {
      swell.reset();
      activeSeed = sectionSeed(seed, 0);
      rng = mulberry32(activeSeed);
      resetPool();
    },
    draw({ renderer, features, director, params, dt }: LayerFrame): void {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
      const swellAmt = swell.update(features.onset, step);
      const lvl = level(features);
      const bass = band(features, "bass");

      const countParam = clamp01(Number(params[P.count] ?? 0.6));
      const rate = clamp01(Number(params[P.emission] ?? 0.6));
      const velocityParam = clamp01(Number(params[P.velocity] ?? 0.6));
      const glowK = clamp01(Number(params[P.glow] ?? 0.7));
      const trail = clamp01(Number(params[P.trail] ?? 0.88));
      const bloomAmt = clamp01(Number(params[P.bloom] ?? director.bloom));
      const hueDrift = clamp01(Number(params[P.hueDrift] ?? 0.5));
      const swellGain = clamp01(Number(params[P.swell] ?? 0.6));

      // Per-section reseed: when the director hands a fresh seed, re-seed the
      // spray so the section's sparks look new. Deterministic given the seed.
      const wantSeed = sectionSeed(seed, director.seed);
      if (wantSeed !== activeSeed) {
        activeSeed = wantSeed;
        rng = mulberry32(activeSeed);
      }

      // Cinematic post-FX: strong bloom on, long feedback trail → comet tails.
      renderer.setPostEffects(particlePostFx(bloomAmt, trail));

      // A deep, palette-tinted void rather than flat black, so the sparks float
      // on a color that itself evolves with the director.
      const voidColor = directorColor(director, 0.04);
      renderer.beginFrame({ r: voidColor.r * 0.1, g: voidColor.g * 0.1, b: voidColor.b * 0.12, a: 1 });

      // Emit, bounded by free slots so we never exceed the cap. The director's
      // density (via the bound `particleCount` param) and the beat swell drive
      // how busy the spray is.
      let free = 0;
      for (const p of pool) if (!p.alive) free++;
      // `particleCount` (bound to the director's density) and `emissionRate`
      // together set how busy the spray is.
      const want = emissionCount(
        swellAmt * swellGain,
        lvl,
        features.onset,
        rate,
        director.density * (0.4 + countParam),
      );
      if (want > 0 && free > 0) emit(features, Math.min(want, free), velocityParam, hueDrift);

      const gravity = 0.05; // gentle downward drift
      const drag = decayFactor(step, 1.1);
      const sizeBoost = mapFeature(clamp01(bass), 1, 2.6);
      const intensity = clamp01(director.intensity + bass * 0.4);

      for (const p of pool) {
        if (!p.alive) continue;
        p.vx *= drag;
        p.vy = p.vy * drag + gravity * step;
        p.x += p.vx * step;
        p.y += p.vy * step;
        p.life -= step;
        if (p.life <= 0 || p.x < -0.1 || p.x > 1.1 || p.y < -0.1 || p.y > 1.1) {
          p.alive = false;
          continue;
        }
        const ageT = clamp01(p.life / p.span); // 1 fresh → 0 dying
        // Color recolors by age across the palette; the trail/feedback smears
        // each spark's motion into a luminous comet tail.
        const t = clamp01(p.hue * (0.5 + 0.5 * hueDrift) + (1 - ageT) * 0.2);
        const col = directorColor(director, t);
        const radius = BASE_RADIUS * sizeBoost * (0.4 + ageT) * (0.7 + glowK * 0.8);
        const gain = 0.5 + glowK * 1.4 + intensity * 1.1 + swellAmt * swellGain * 1.6;
        renderer.drawGlow({
          x: p.x,
          y: p.y,
          radius,
          color: hot(col, 1),
          intensity: gain * (0.3 + ageT * 0.9),
        });
      }

      renderer.endFrame();
    },
    dispose(): void {
      pool.length = 0;
      swell.reset();
    },
  };
}

const PARTICLE_PARAMS = [
  { key: P.count, label: "Particle count", group: "Swarm", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.emission, label: "Emission rate", group: "Swarm", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.velocity, label: "Velocity", group: "Swarm", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.glow, label: "Glow intensity", group: "Light", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.7 },
  { key: P.bloom, label: "Bloom amount", group: "Light", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.trail, label: "Trail decay", group: "Light", type: "number" as const, min: 0, max: 0.93, step: 0.01, default: 0.88 },
  { key: P.swell, label: "Beat swell", group: "Light", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.hueDrift, label: "Hue drift", group: "Color", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.5 },
];

const PARTICLE_BINDINGS = {
  // Particle count follows the director's density (sparse intro → dense drop);
  // glow + bloom build with intensity; the swell + velocity ride bass.
  [P.count]: { source: "director" as const, path: "density", inMin: 0.5, inMax: 1.6, smoothing: 0.8 },
  [P.glow]: { source: "director" as const, path: "intensity", outMin: 0.4, outMax: 1, smoothing: 0.8 },
  [P.bloom]: { source: "director" as const, path: "bloom", smoothing: 0.8 },
  [P.velocity]: { source: "audio" as const, path: "bass", outMin: 0.4, outMax: 1, smoothing: 0.6 },
  [P.swell]: { source: "audio" as const, path: "bass", outMin: 0.4, outMax: 1, smoothing: 0.6 },
  [P.hueDrift]: { source: "audio" as const, path: "treble", outMin: 0.3, outMax: 0.9, smoothing: 0.85 },
};

/** The Particles preset definition — rich param schema with audio/director bindings. */
export const particlesPreset: PresetDefinition = composePreset({
  id: "particle.particles",
  name: "Particles",
  description:
    "A bounded particle system drawn as additive glow points that smear into long luminous comet tails: beats spray bursts of sparks from the center, bass throws them faster and bigger, the director's density populates the field and its intensity brightens the glow as the color crossfades over the track.",
  tags: ["particle", "particles", "comet-trails", "glow", "cinematic"],
  params: PARTICLE_PARAMS,
  bindings: PARTICLE_BINDINGS,
  layers: () => [makeParticlesLayer(DEFAULT_SEED)],
});

/** Build a Particles definition with an explicit seed and/or options (tests, hosts). */
export function particlesPresetWithSeed(seed: number, options: ParticlesOptions = {}): PresetDefinition {
  return composePreset({
    id: `particle.particles.${seed}`,
    name: "Particles",
    description: particlesPreset.description,
    tags: particlesPreset.tags,
    params: PARTICLE_PARAMS,
    bindings: PARTICLE_BINDINGS,
    layers: () => [makeParticlesLayer(seed, options)],
  });
}
