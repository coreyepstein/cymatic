/**
 * `reactionPreset` — "Reaction". A coarse Gray-Scott reaction-diffusion grid
 * stepped each frame; each cell's `v` concentration is mapped to a rect's color
 * and size, so the classic spotting / striping patterns emerge over time. Audio
 * modulates the chemistry: bass raises the feed rate and treble the kill rate
 * (shifting the pattern regime), while a beat bumps the per-frame step count so
 * the system visibly surges. The grid is seeded with a few deterministic
 * perturbations via a seeded PRNG ({@link mulberry32}), never `Math.random()`,
 * so the evolution is fully reproducible. "Reaction" names the technique.
 *
 * Public-surface only: `band`, `mapFeature`, palette `sample`/`mixColor`,
 * `Smoother`, and `Renderer.drawRect`.
 */

import {
  band,
  clamp01,
  mapFeature,
  mixColor,
  palettes,
  sample,
  Smoother,
} from "@cymatic/core";
import { composePreset, type Layer, type LayerFrame, type PresetDefinition } from "@cymatic/core";

import { DEFAULT_SEED, mulberry32 } from "./common.js";

/** Grid resolution per side — coarse on purpose so the step stays cheap. */
export const GRID_SIZE = 48;
/** Diffusion coefficients for the two chemicals (standard Gray-Scott values). */
const DIFFUSE_U = 0.16;
const DIFFUSE_V = 0.08;
/** Smoothing for the audio-driven feed/kill so the regime drifts, not jumps. */
const PARAM_SMOOTHING = 0.9;

/**
 * Audio-driven Gray-Scott parameters. Pure + exported so a test can assert that
 * bass raises feed and treble raises kill within the pattern-forming band. The
 * ranges sit inside the regime where spots/stripes actually form.
 */
export function reactionParams(
  smoothedBass: number,
  smoothedTreble: number,
): { feed: number; kill: number } {
  const feed = mapFeature(smoothedBass, 0.026, 0.058);
  const kill = mapFeature(smoothedTreble, 0.058, 0.066);
  return { feed, kill };
}

/**
 * Steps-per-frame from a decaying beat burst. Pure + exported: a fresh burst
 * runs more diffusion steps (a visible surge), settling back to the baseline.
 */
export function reactionSteps(burst: number): number {
  return 1 + Math.round(burst * 3);
}

function idx(x: number, y: number): number {
  return y * GRID_SIZE + x;
}

function makeReactionLayer(seed: number): Layer {
  const n = GRID_SIZE * GRID_SIZE;
  let u = new Float64Array(n);
  let v = new Float64Array(n);
  let nu = new Float64Array(n);
  let nv = new Float64Array(n);
  const bassS = new Smoother(PARAM_SMOOTHING, 0);
  const trebleS = new Smoother(PARAM_SMOOTHING, 0);
  let burst = 0;

  function seedGrid(): void {
    u.fill(1);
    v.fill(0);
    nu.fill(0);
    nv.fill(0);
    burst = 0;
    // Drop a few deterministic seeds of chemical V to kick off the reaction.
    const rng = mulberry32(seed);
    const seeds = 8;
    for (let s = 0; s < seeds; s++) {
      const cx = 2 + Math.floor(rng() * (GRID_SIZE - 4));
      const cy = 2 + Math.floor(rng() * (GRID_SIZE - 4));
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE) {
            v[idx(x, y)] = 1;
            u[idx(x, y)] = 0;
          }
        }
      }
    }
  }

  /** Laplacian of `arr` at (x,y) with wrap-around (toroidal) neighbours. */
  function laplace(arr: Float64Array, x: number, y: number): number {
    const xm = (x - 1 + GRID_SIZE) % GRID_SIZE;
    const xp = (x + 1) % GRID_SIZE;
    const ym = (y - 1 + GRID_SIZE) % GRID_SIZE;
    const yp = (y + 1) % GRID_SIZE;
    const center = arr[idx(x, y)]!;
    // 9-point stencil: orthogonal weight 0.2, diagonal 0.05, center -1.
    return (
      center * -1 +
      (arr[idx(xm, y)]! + arr[idx(xp, y)]! + arr[idx(x, ym)]! + arr[idx(x, yp)]!) * 0.2 +
      (arr[idx(xm, ym)]! + arr[idx(xp, ym)]! + arr[idx(xm, yp)]! + arr[idx(xp, yp)]!) * 0.05
    );
  }

  function step(feed: number, kill: number): void {
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const i = idx(x, y);
        const uu = u[i]!;
        const vv = v[i]!;
        const reaction = uu * vv * vv;
        nu[i] = clamp01(uu + (DIFFUSE_U * laplace(u, x, y) - reaction + feed * (1 - uu)));
        nv[i] = clamp01(vv + (DIFFUSE_V * laplace(v, x, y) + reaction - (kill + feed) * vv));
      }
    }
    // Swap buffers (no allocation per frame after warm-up).
    const tu = u;
    u = nu;
    nu = tu;
    const tv = v;
    v = nv;
    nv = tv;
  }

  return {
    id: "generative.reaction",
    init(): void {
      bassS.reset(0);
      trebleS.reset(0);
      seedGrid();
    },
    draw({ renderer, features, dt }: LayerFrame): void {
      const dtsec = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
      const bass = bassS.push(band(features, "bass"));
      const treble = trebleS.push(band(features, "treble"));
      const decay = Math.pow(0.5, dtsec / 0.5);
      burst = features.onset ? clamp01(burst * decay + 0.8) : clamp01(burst * decay);

      const { feed, kill } = reactionParams(bass, treble);
      const steps = reactionSteps(burst);
      for (let s = 0; s < steps; s++) step(feed, kill);

      renderer.beginFrame(mixColor(sample(palettes.ember, 0), { r: 0, g: 0, b: 0, a: 1 }, 0.5));

      const cell = 1 / GRID_SIZE;
      for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
          const c = clamp01(v[idx(x, y)]!);
          if (c < 0.02) continue; // skip near-empty cells (cheaper, cleaner).
          const base = sample(palettes.ember, c);
          const color = mixColor({ r: 0, g: 0, b: 0, a: base.a }, base, clamp01(0.2 + c));
          // Size the rect by concentration so dense cells read as solid blobs.
          const s = cell * (0.45 + 0.55 * c);
          const pad = (cell - s) / 2;
          renderer.drawRect({ x: x * cell + pad, y: y * cell + pad, w: s, h: s, color });
        }
      }

      renderer.endFrame();
    },
    dispose(): void {
      u = new Float64Array(n);
      v = new Float64Array(n);
      nu = new Float64Array(n);
      nv = new Float64Array(n);
      bassS.reset(0);
      trebleS.reset(0);
      burst = 0;
    },
  };
}

/** The Reaction preset definition. */
export const reactionPreset: PresetDefinition = composePreset({
  id: "generative.reaction",
  name: "Reaction",
  description:
    "A coarse Gray-Scott reaction-diffusion grid stepped each frame and drawn as concentration-scaled rects: bass raises the feed rate, treble the kill rate, and a beat surges the step count.",
  tags: ["generative", "reaction-diffusion", "gray-scott", "algorithmic"],
  layers: () => [makeReactionLayer(DEFAULT_SEED)],
});

/** Build a Reaction definition with an explicit seed (used by tests). */
export function reactionPresetWithSeed(seed: number): PresetDefinition {
  return composePreset({
    id: `generative.reaction.${seed}`,
    name: "Reaction",
    description: reactionPreset.description,
    tags: reactionPreset.tags,
    layers: () => [makeReactionLayer(seed)],
  });
}
