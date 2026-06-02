/**
 * `light3dPreset` — "Light 3D". A pseudo-3D look with no 3D library: a seeded
 * point cloud arranged on a sphere is rotated and projected to 2D through a
 * basic perspective transform, each point drawn as a small rect. Depth is the
 * core cue — nearer points are larger and brighter, farther points smaller and
 * dimmer — so the cloud reads as volume. Audio drives it:
 *
 *   - ROTATION SPEED scales with treble + a beat burst (the cloud spins faster
 *     when the high end is busy).
 *   - EXTRUSION / RADIUS PULSE scales with bass — heavy low end inflates the
 *     cloud outward (a breathing volume).
 *   - BRIGHTNESS per point combines its depth with overall level.
 *   - COLOR is sampled from a palette by depth so the volume has a near/far hue
 *     gradient.
 *
 * The point count is configurable and hard-capped (`maxPoints`, default 500) so
 * it stays smooth at typical resolution. Pure math projection on the public
 * `@cymatic/core` surface; a seeded PRNG ({@link mulberry32}) places points so
 * output is reproducible / unit-testable.
 */

import {
  band,
  clamp01,
  level,
  mapFeature,
  mixColor,
  palettes,
  sample,
} from "@cymatic/core";
import { composePreset, type Layer, type LayerFrame, type PresetDefinition } from "@cymatic/core";

import { DEFAULT_SEED, advanceBurst, clampCount, mulberry32 } from "./common.js";

/** Default point count. Modest for smoothness, dense enough to read as volume. */
export const DEFAULT_MAX_POINTS = 500;
/** Absolute upper bound on points (perf guard). */
export const MAX_POINTS_LIMIT = 2500;
/** Camera distance for the perspective divide (in cloud-radius units). */
const CAMERA_Z = 3;
/** Base rect side length before depth scaling. */
const BASE_SIZE = 0.006;

interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** Options for {@link makeLight3dLayer} / the Light 3D preset. */
export interface Light3dOptions {
  /** Hard cap on cloud points. Defaults to {@link DEFAULT_MAX_POINTS}. */
  maxPoints?: number;
}

/**
 * Per-frame motion parameters from audio. Pure + exported so a test can assert
 * treble/beat raise spin and bass raises the radius pulse. `spin` is rad/sec,
 * `pulse` a multiplicative radius factor around 1.
 */
export function light3dParams(bass: number, treble: number, burst: number): { spin: number; pulse: number } {
  const spin = mapFeature(clamp01(treble + burst * 0.5), 0.2, 2.6);
  const pulse = mapFeature(clamp01(bass + burst * 0.3), 0.85, 1.6);
  return { spin, pulse };
}

/**
 * Project a rotated 3D point to a normalized 2D position + a depth factor in
 * `[0,1]` (1 = nearest). Pure + exported so a test can assert nearer points
 * project larger/brighter. Returns null if the point is behind the camera.
 */
export function project(
  p: Point3,
  cosA: number,
  sinA: number,
  cosB: number,
  sinB: number,
  radius: number,
): { sx: number; sy: number; depth: number } | null {
  // Rotate around Y then X.
  const x1 = p.x * cosA + p.z * sinA;
  const z1 = -p.x * sinA + p.z * cosA;
  const y1 = p.y * cosB - z1 * sinB;
  const z2 = p.y * sinB + z1 * cosB;
  const rx = x1 * radius;
  const ry = y1 * radius;
  const rz = z2 * radius;
  const denom = CAMERA_Z + rz;
  if (denom <= 0.05) return null; // behind / too close to camera
  const persp = CAMERA_Z / denom;
  const sx = 0.5 + rx * persp * 0.4;
  const sy = 0.5 - ry * persp * 0.4;
  // Depth factor: nearer (smaller rz) → closer to 1.
  const depth = clamp01((CAMERA_Z - rz) / (2 * CAMERA_Z));
  return { sx, sy, depth };
}

function makeLight3dLayer(seed: number, options: Light3dOptions = {}): Layer {
  const cap = clampCount(options.maxPoints ?? DEFAULT_MAX_POINTS, DEFAULT_MAX_POINTS, MAX_POINTS_LIMIT);
  const points: Point3[] = [];
  let angleA = 0; // yaw
  let angleB = 0; // pitch
  let burst = 0;

  function seedCloud(): void {
    points.length = 0;
    const rng = mulberry32(seed);
    for (let i = 0; i < cap; i++) {
      // Even-ish sphere distribution via deterministic spherical coordinates.
      const u = rng();
      const v = rng();
      const theta = u * Math.PI * 2;
      const phi = Math.acos(2 * v - 1);
      const sinPhi = Math.sin(phi);
      points.push({
        x: Math.cos(theta) * sinPhi,
        y: Math.cos(phi),
        z: Math.sin(theta) * sinPhi,
      });
    }
  }

  return {
    id: "particle.light-3d",
    init(): void {
      angleA = 0;
      angleB = 0;
      burst = 0;
      seedCloud();
    },
    draw({ renderer, features, dt }: LayerFrame): void {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
      burst = advanceBurst(burst, features.onset, step, 0.45);
      const bass = band(features, "bass");
      const treble = band(features, "treble");
      const lvl = level(features);
      const { spin, pulse } = light3dParams(bass, treble, burst);

      angleA += spin * step;
      angleB += spin * 0.4 * step;
      const cosA = Math.cos(angleA);
      const sinA = Math.sin(angleA);
      const cosB = Math.cos(angleB);
      const sinB = Math.sin(angleB);
      const radius = 1.1 * pulse;

      renderer.beginFrame({ r: 0.01, g: 0, b: 0.03, a: 1 });

      const sizeBoost = mapFeature(lvl, 0.7, 1.8);
      for (const p of points) {
        const proj = project(p, cosA, sinA, cosB, sinB, radius);
        if (!proj) continue;
        if (proj.sx < -0.05 || proj.sx > 1.05 || proj.sy < -0.05 || proj.sy > 1.05) continue;
        const size = BASE_SIZE * sizeBoost * (0.35 + proj.depth);
        const base = sample(palettes.sunset, proj.depth);
        const bright = clamp01(0.15 + proj.depth * 0.7 + lvl * 0.3);
        const color = mixColor({ r: 0, g: 0, b: 0, a: base.a }, base, bright);
        renderer.drawRect({ x: proj.sx - size / 2, y: proj.sy - size / 2, w: size, h: size, color });
      }

      renderer.endFrame();
    },
    dispose(): void {
      points.length = 0;
      angleA = 0;
      angleB = 0;
      burst = 0;
    },
  };
}

/** The Light 3D preset definition (default point count). */
export const light3dPreset: PresetDefinition = composePreset({
  id: "particle.light-3d",
  name: "Light 3D",
  description:
    "A seeded point cloud on a sphere, rotated and perspective-projected to 2D with depth as the cue: nearer points are larger and brighter. Treble and beats speed the spin, bass inflates the cloud, and depth drives a near/far hue gradient.",
  tags: ["3d", "light", "point-cloud", "perspective", "beat-reactive"],
  layers: () => [makeLight3dLayer(DEFAULT_SEED)],
});

/** Build a Light 3D definition with an explicit seed and/or options (tests, hosts). */
export function light3dPresetWithSeed(seed: number, options: Light3dOptions = {}): PresetDefinition {
  return composePreset({
    id: `particle.light-3d.${seed}`,
    name: "Light 3D",
    description: light3dPreset.description,
    tags: light3dPreset.tags,
    layers: () => [makeLight3dLayer(seed, options)],
  });
}
