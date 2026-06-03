/**
 * `light3dPreset` — "Light 3D" (V2-13 cinematic rebuild).
 *
 * A pseudo-3D look with NO 3D library: a seeded point cloud on a sphere is
 * rotated and projected to 2D through a basic perspective transform, each point
 * drawn as an ADDITIVE GLOW whose depth drives brightness AND size — nearer
 * points are larger and brighter, so the cloud reads as luminous volume. With
 * the pack's long feedback trail the spinning points smear into glowing arcs.
 * Audio + the director drive it:
 *
 *   - ROTATION speed scales with treble + a beat swell + the director's motion
 *     (the cloud spins faster when the high end is busy and on the drop).
 *   - RADIUS PULSE scales with bass — heavy low end inflates the cloud outward
 *     (a breathing volume).
 *   - GLOW intensity per point combines its depth with the director's intensity
 *     + the beat swell, so the volume pulses brighter on every beat.
 *   - COLOR is sampled from the director's crossfading palette + hue rotation by
 *     depth, so the volume has a near/far hue gradient that recolors over a track.
 *
 * The point count is configurable + hard-capped (`maxPoints`, default 520) so it
 * stays smooth. Pure-math projection; a seeded PRNG ({@link mulberry32}) places
 * points and the director's per-section seed is folded in via {@link sectionSeed}
 * so each section RE-SEEDS the cloud — never `Math.random` / `Date.now`. "Light
 * 3D" names the technique. Public `@cymatic/core` surface only.
 */

import {
  band,
  clamp01,
  mapFeature,
} from "@cymatic/core";
import { composePreset, type Layer, type LayerFrame, type PresetDefinition } from "@cymatic/core";

import {
  BeatSwell,
  clampCount,
  DEFAULT_SEED,
  directorColor,
  hot,
  mulberry32,
  particlePostFx,
  sectionSeed,
} from "./common.js";

/** Default point count. Modest for smoothness, dense enough to read as volume. */
export const DEFAULT_MAX_POINTS = 520;
/** Absolute upper bound on points (perf guard). */
export const MAX_POINTS_LIMIT = 2600;
/** Camera distance for the perspective divide (in cloud-radius units). */
const CAMERA_Z = 3;
/** Base glow radius before depth scaling. */
const BASE_RADIUS = 0.008;

const P = {
  points: "pointCount",
  rotation: "rotationSpeed",
  pulse: "radiusPulse",
  glow: "glowIntensity",
  trail: "trailDecay",
  bloom: "bloomAmount",
  hueDrift: "hueDrift",
  swell: "beatSwell",
} as const;

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
 * Per-frame motion parameters from audio + the director + the params. Pure +
 * exported so a test can assert treble/beat/motion raise spin and bass raises
 * the radius pulse. `spin` is rad/sec, `pulse` a multiplicative radius factor
 * around 1.
 */
export function light3dParams(
  bass: number,
  treble: number,
  swell: number,
  motion: number,
  rotationParam: number,
  pulseParam: number,
): { spin: number; pulse: number } {
  const spin =
    mapFeature(clamp01(treble + swell * 0.5), 0.2, 2.8) *
    (0.5 + 0.5 * clamp01(motion / 2)) *
    (0.4 + clamp01(rotationParam));
  // Keep the pulse modest so the inflated cloud stays mostly on-screen (a very
  // large radius would push points past the frame and get them culled, which
  // would paradoxically DARKEN a loud frame). Centered near 1, swings to ~1.5.
  const pulse = mapFeature(clamp01(bass + swell * 0.3), 0.9, 1.4) * (0.85 + 0.15 * clamp01(pulseParam));
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
  const swell = new BeatSwell(0.42);
  let angleA = 0; // yaw
  let angleB = 0; // pitch
  let activeSeed = seed;

  function seedCloud(s: number): void {
    points.length = 0;
    const rng = mulberry32(s);
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
      swell.reset();
      activeSeed = sectionSeed(seed, 0);
      seedCloud(activeSeed);
    },
    draw({ renderer, features, director, params, dt }: LayerFrame): void {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
      const swellAmt = swell.update(features.onset, step);
      const bass = band(features, "bass");
      const treble = band(features, "treble");

      const rotationParam = clamp01(Number(params[P.rotation] ?? 0.6));
      const pulseParam = clamp01(Number(params[P.pulse] ?? 0.6));
      const glowK = clamp01(Number(params[P.glow] ?? 0.7));
      const trail = clamp01(Number(params[P.trail] ?? 0.85));
      const bloomAmt = clamp01(Number(params[P.bloom] ?? director.bloom));
      const hueDrift = clamp01(Number(params[P.hueDrift] ?? 0.5));
      const swellGain = clamp01(Number(params[P.swell] ?? 0.6));

      // Per-section reseed: a fresh director seed regrows the cloud layout.
      const wantSeed = sectionSeed(seed, director.seed);
      if (wantSeed !== activeSeed) {
        activeSeed = wantSeed;
        seedCloud(activeSeed);
      }

      const { spin, pulse } = light3dParams(
        bass,
        treble,
        swellAmt * swellGain,
        director.motion,
        rotationParam,
        pulseParam,
      );

      angleA += spin * step;
      angleB += spin * 0.4 * step;
      const cosA = Math.cos(angleA);
      const sinA = Math.sin(angleA);
      const cosB = Math.cos(angleB);
      const sinB = Math.sin(angleB);
      const radius = 1.1 * pulse;

      // Cinematic post-FX: strong bloom on, long feedback trail → glowing arcs.
      renderer.setPostEffects(particlePostFx(bloomAmt, trail));
      const voidColor = directorColor(director, 0.04);
      renderer.beginFrame({ r: voidColor.r * 0.08, g: voidColor.g * 0.08, b: voidColor.b * 0.12, a: 1 });

      const intensity = clamp01(director.intensity + bass * 0.4);
      const beat = swellAmt * swellGain;
      for (const p of points) {
        const proj = project(p, cosA, sinA, cosB, sinB, radius);
        if (!proj) continue;
        if (proj.sx < -0.05 || proj.sx > 1.05 || proj.sy < -0.05 || proj.sy > 1.05) continue;
        // Depth drives size + brightness; color is a near/far hue gradient across
        // the director's palette, widened by the hueDrift param.
        const t = clamp01(proj.depth * (0.4 + 0.6 * hueDrift) + beat * 0.1);
        const col = directorColor(director, t);
        const radiusN = BASE_RADIUS * (0.35 + proj.depth) * (0.7 + glowK * 0.9);
        const gain = 0.4 + glowK * 1.3 + intensity * 1.0 + beat * 1.5;
        renderer.drawGlow({
          x: proj.sx,
          y: proj.sy,
          radius: radiusN,
          color: hot(col, 1),
          intensity: gain * (0.25 + proj.depth * 0.9),
        });
      }

      renderer.endFrame();
    },
    dispose(): void {
      points.length = 0;
      angleA = 0;
      angleB = 0;
      swell.reset();
    },
  };
}

const LIGHT3D_PARAMS = [
  { key: P.points, label: "Point count", group: "Cloud", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.rotation, label: "Rotation speed", group: "Motion", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.pulse, label: "Radius pulse", group: "Motion", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.glow, label: "Glow intensity", group: "Light", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.7 },
  { key: P.bloom, label: "Bloom amount", group: "Light", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.trail, label: "Trail decay", group: "Light", type: "number" as const, min: 0, max: 0.93, step: 0.01, default: 0.85 },
  { key: P.swell, label: "Beat swell", group: "Light", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.hueDrift, label: "Hue drift", group: "Color", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.5 },
];

const LIGHT3D_BINDINGS = {
  // Rotation rides treble + the director's motion; the radius pulse rides bass;
  // glow + bloom build with the director's intensity; the swell rides bass.
  [P.rotation]: { source: "director" as const, path: "motion", inMin: 0.5, inMax: 2, outMin: 0.4, outMax: 1, smoothing: 0.7 },
  [P.pulse]: { source: "audio" as const, path: "bass", outMin: 0.4, outMax: 1, smoothing: 0.6 },
  [P.glow]: { source: "director" as const, path: "intensity", outMin: 0.4, outMax: 1, smoothing: 0.8 },
  [P.bloom]: { source: "director" as const, path: "bloom", smoothing: 0.8 },
  [P.swell]: { source: "audio" as const, path: "treble", outMin: 0.4, outMax: 1, smoothing: 0.6 },
  [P.hueDrift]: { source: "audio" as const, path: "treble", outMin: 0.3, outMax: 0.9, smoothing: 0.85 },
};

/** The Light 3D preset definition — rich param schema with audio/director bindings. */
export const light3dPreset: PresetDefinition = composePreset({
  id: "particle.light-3d",
  name: "Light 3D",
  description:
    "A seeded point cloud on a sphere, rotated and perspective-projected to 2D and drawn as additive glows with depth as the cue: nearer points are larger and brighter. Treble, beats and the director's motion speed the spin, bass inflates the cloud, and depth drives a near/far hue gradient across the director's crossfading palette — the long trail smears the spin into glowing arcs.",
  tags: ["3d", "light", "point-cloud", "glow", "cinematic"],
  params: LIGHT3D_PARAMS,
  bindings: LIGHT3D_BINDINGS,
  layers: () => [makeLight3dLayer(DEFAULT_SEED)],
});

/** Build a Light 3D definition with an explicit seed and/or options (tests, hosts). */
export function light3dPresetWithSeed(seed: number, options: Light3dOptions = {}): PresetDefinition {
  return composePreset({
    id: `particle.light-3d.${seed}`,
    name: "Light 3D",
    description: light3dPreset.description,
    tags: light3dPreset.tags,
    params: LIGHT3D_PARAMS,
    bindings: LIGHT3D_BINDINGS,
    layers: () => [makeLight3dLayer(seed, options)],
  });
}
