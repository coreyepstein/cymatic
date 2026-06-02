/**
 * `particlesPreset` — "Particles". A bounded particle system: particles are
 * emitted from the center on beats (and a trickle on sustained loudness), fly
 * outward, age, and are recycled. Audio drives the system directly:
 *
 *   - EMISSION RATE rises with onset (a beat sprays a burst) and overall level.
 *   - INITIAL VELOCITY scales with bass — heavier low end throws particles
 *     farther/faster.
 *   - SIZE scales with bass + the particle's own age (a brief flash, then fade).
 *   - COLOR is sampled from a palette by which band is loudest (bass→ember warm,
 *     treble→cool), so the field's hue tracks the spectrum.
 *
 * The system is hard-capped (`maxParticles`, default 600) so it stays smooth at
 * typical resolution; emission never exceeds the free slots. Built purely on the
 * public `@cymatic/core` surface (primitives + `Renderer.drawRect`) and a seeded
 * PRNG ({@link mulberry32}) so output is reproducible / unit-testable.
 */

import {
  band,
  clamp01,
  level,
  mapFeature,
  mixColor,
  palettes,
  sample,
  type AudioFeatureFrame,
} from "@cymatic/core";
import { composePreset, type Layer, type LayerFrame, type PresetDefinition } from "@cymatic/core";

import { DEFAULT_SEED, advanceBurst, clampCount, decayFactor, mulberry32 } from "./common.js";

/** Default hard cap on live particles — modest for smoothness, dense enough to read. */
export const DEFAULT_MAX_PARTICLES = 600;
/** Absolute upper bound regardless of requested config (perf guard). */
export const MAX_PARTICLES_LIMIT = 2000;
/** Base rect side length (normalized) before audio/age scaling. */
const BASE_SIZE = 0.004;

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
 * How many particles to emit this frame given a beat burst and overall level.
 * Pure + exported so a test can assert a beat raises emission above silence. The
 * result is clamped to the available free slots by the caller.
 */
export function emissionCount(burst: number, lvl: number, onset: boolean): number {
  // A beat sprays a burst proportional to the envelope; sustained loudness adds
  // a steady trickle. Silence emits nothing.
  const beatSpray = onset ? 14 : 0;
  const burstSpray = Math.round(mapFeature(burst, 0, 18));
  const trickle = Math.round(mapFeature(lvl, 0, 4));
  return beatSpray + burstSpray + trickle;
}

/**
 * Initial outward speed for a freshly emitted particle, scaled by bass. Pure +
 * exported so a test can assert louder bass throws particles faster.
 */
export function emissionSpeed(bass: number): number {
  return mapFeature(clamp01(bass), 0.12, 0.95);
}

function makeParticlesLayer(seed: number, options: ParticlesOptions = {}): Layer {
  const cap = clampCount(
    options.maxParticles ?? DEFAULT_MAX_PARTICLES,
    DEFAULT_MAX_PARTICLES,
    MAX_PARTICLES_LIMIT,
  );
  const rng = mulberry32(seed);
  const pool: Particle[] = [];
  let burst = 0;

  function resetPool(): void {
    pool.length = 0;
    for (let i = 0; i < cap; i++) {
      pool.push({ x: 0.5, y: 0.5, vx: 0, vy: 0, life: 0, span: 1, hue: 0, alive: false });
    }
  }

  /** Choose a palette hue from the loudest band: bass=warm low, treble=cool high. */
  function hueForFrame(features: AudioFeatureFrame): number {
    const b = band(features, "bass");
    const m = band(features, "mid");
    const t = band(features, "treble");
    const total = b + m + t;
    if (total <= 0) return 0;
    // Weighted center of mass across the spectrum → palette position.
    return clamp01((m * 0.5 + t * 1) / total);
  }

  function emit(features: AudioFeatureFrame, count: number): void {
    const bass = band(features, "bass");
    const speed = emissionSpeed(bass);
    const hue = hueForFrame(features);
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
      p.span = 0.8 + rng() * 1.4;
      p.life = p.span;
      p.hue = clamp01(hue + (rng() - 0.5) * 0.15);
      p.alive = true;
      spawned++;
    }
  }

  return {
    id: "particle.particles",
    init(): void {
      burst = 0;
      resetPool();
    },
    draw({ renderer, features, dt }: LayerFrame): void {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
      burst = advanceBurst(burst, features.onset, step, 0.35);
      const lvl = level(features);
      const bass = band(features, "bass");

      // Emit, bounded by free slots so we never exceed the cap.
      let free = 0;
      for (const p of pool) if (!p.alive) free++;
      const want = emissionCount(burst, lvl, features.onset);
      if (want > 0 && free > 0) emit(features, Math.min(want, free));

      const bg = mixColor(sample(palettes.ember, 0), { r: 0, g: 0, b: 0, a: 1 }, 0.7);
      renderer.beginFrame(bg);

      const gravity = 0.04; // gentle downward drift
      const drag = decayFactor(step, 1.2);
      const sizeBoost = mapFeature(clamp01(bass), 1, 2.4);

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
        const size = BASE_SIZE * sizeBoost * (0.4 + ageT);
        const base = sample(palettes.ember, p.hue);
        const color = mixColor({ r: 0, g: 0, b: 0, a: base.a }, base, clamp01(0.2 + ageT * 0.9));
        renderer.drawRect({ x: p.x - size / 2, y: p.y - size / 2, w: size, h: size, color });
      }

      renderer.endFrame();
    },
    dispose(): void {
      pool.length = 0;
      burst = 0;
    },
  };
}

/** The Particles preset definition (default cap). */
export const particlesPreset: PresetDefinition = composePreset({
  id: "particle.particles",
  name: "Particles",
  description:
    "A bounded particle system that sprays particles from the center on beats; bass throws them faster and larger, the loudest band tints the field, and particles age out so the system stays capped and smooth.",
  tags: ["particle", "particles", "physics", "beat-reactive"],
  layers: () => [makeParticlesLayer(DEFAULT_SEED)],
});

/** Build a Particles definition with an explicit seed and/or options (tests, hosts). */
export function particlesPresetWithSeed(seed: number, options: ParticlesOptions = {}): PresetDefinition {
  return composePreset({
    id: `particle.particles.${seed}`,
    name: "Particles",
    description: particlesPreset.description,
    tags: particlesPreset.tags,
    layers: () => [makeParticlesLayer(seed, options)],
  });
}
