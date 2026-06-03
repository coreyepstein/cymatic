/**
 * `reactionPreset` — "Reaction" (V2-12 cinematic rebuild).
 *
 * A coarse Gray-Scott reaction-diffusion bath stepped each frame; each cell's
 * `v` concentration becomes LUMINOUS color — gradient-filled tiles ramped toward
 * the director's palette with additive glow cores on the dense ridges, so the
 * classic spotting / striping patterns read as glowing organic structures rather
 * than flat paint. Audio nudges the chemistry: bass raises the feed rate, treble
 * the kill rate (shifting the pattern regime), and a beat surges the per-frame
 * step count so the system visibly blooms. The grid RE-SEEDS its nuclei on a
 * strong onset OR a director section change (a fresh seed), so each section
 * grows a fresh pattern. Color crossfades over the track via the director's
 * palette + hue rotation; bloom + a feedback trail give it a living glow.
 *
 * Determinism: nuclei are placed by a seeded PRNG ({@link mulberry32}) folded
 * with the director's per-section seed via {@link sectionSeed} — never
 * `Math.random` / `Date.now`. "Reaction" names the technique. Public
 * `@cymatic/core` surface only (no raw GL/GPU).
 */

import {
  clamp01,
  mapFeature,
  smoothBand,
  withAlpha,
  type BandSmoother,
} from "@cymatic/core";
import { composePreset, type Layer, type LayerFrame, type PresetDefinition } from "@cymatic/core";

import {
  BeatSwell,
  DEFAULT_SEED,
  directorColor,
  generativePostFx,
  hot,
  mulberry32,
  sectionSeed,
} from "./common.js";

/** Grid resolution per side — coarse on purpose so the step stays cheap. */
export const GRID_SIZE = 46;
/** Diffusion coefficients for the two chemicals (standard Gray-Scott values). */
const DIFFUSE_U = 0.16;
const DIFFUSE_V = 0.08;
/** Smoothing for the audio-driven feed/kill so the regime drifts, not jumps. */
const PARAM_SMOOTHING = 0.9;

const P = {
  feedBias: "feedBias",
  killBias: "killBias",
  glow: "glowIntensity",
  surge: "beatSurge",
  trail: "trailDecay",
  bloom: "bloomAmount",
  hueSpread: "hueSpread",
  contrast: "contrast",
} as const;

/**
 * Audio-driven Gray-Scott parameters, nudged by param biases. Pure + exported so
 * a test can assert that bass raises feed and treble raises kill within the
 * pattern-forming band. The ranges sit inside the regime where spots/stripes form.
 */
export function reactionParams(
  smoothedBass: number,
  smoothedTreble: number,
  feedBias: number,
  killBias: number,
): { feed: number; kill: number } {
  const feed = mapFeature(clamp01(smoothedBass * 0.7 + feedBias * 0.3), 0.026, 0.058);
  const kill = mapFeature(clamp01(smoothedTreble * 0.7 + killBias * 0.3), 0.058, 0.066);
  return { feed, kill };
}

/**
 * Steps-per-frame from a decaying beat swell. Pure + exported: a fresh swell
 * runs more diffusion steps (a visible surge), settling back to the baseline.
 */
export function reactionSteps(swell: number): number {
  return 1 + Math.round(clamp01(swell) * 3);
}

function idx(x: number, y: number): number {
  return y * GRID_SIZE + x;
}

function makeReactionLayer(baseSeed: number): Layer {
  const n = GRID_SIZE * GRID_SIZE;
  let u = new Float64Array(n);
  let v = new Float64Array(n);
  let nu = new Float64Array(n);
  let nv = new Float64Array(n);
  let bassS: BandSmoother | null = null;
  let trebleS: BandSmoother | null = null;
  const swell = new BeatSwell(0.45);
  let activeSeed = baseSeed;

  function seedGrid(seed: number): void {
    u.fill(1);
    v.fill(0);
    nu.fill(0);
    nv.fill(0);
    // Drop a few deterministic nuclei of chemical V to kick off the reaction.
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
      bassS = smoothBand("bass", PARAM_SMOOTHING);
      trebleS = smoothBand("treble", PARAM_SMOOTHING);
      swell.reset();
      activeSeed = sectionSeed(baseSeed, 0);
      seedGrid(activeSeed);
    },
    draw({ renderer, features, director, params, dt }: LayerFrame): void {
      const dtsec = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
      const bass = (bassS ?? smoothBand("bass", PARAM_SMOOTHING)).push(features);
      const treble = (trebleS ?? smoothBand("treble", PARAM_SMOOTHING)).push(features);
      const swellAmt = swell.update(features.onset, dtsec);

      const feedBias = clamp01(Number(params[P.feedBias] ?? 0.5));
      const killBias = clamp01(Number(params[P.killBias] ?? 0.5));
      const glowK = clamp01(Number(params[P.glow] ?? 0.7));
      const surgeGain = clamp01(Number(params[P.surge] ?? 0.6));
      const trail = clamp01(Number(params[P.trail] ?? 0.8));
      const bloomAmt = clamp01(Number(params[P.bloom] ?? director.bloom));
      const hueSpread = clamp01(Number(params[P.hueSpread] ?? 0.7));
      const contrast = clamp01(Number(params[P.contrast] ?? director.contrast));

      // Reseed on a director section change (fresh seed) OR a strong onset, so
      // each section / big hit grows a fresh pattern. Deterministic given seed.
      const wantSeed = sectionSeed(baseSeed, director.seed);
      const strongOnset = features.onset && bass > 0.7;
      if (wantSeed !== activeSeed || strongOnset) {
        activeSeed = wantSeed;
        seedGrid(activeSeed);
      }

      const { feed, kill } = reactionParams(bass, treble, feedBias, killBias);
      const steps = reactionSteps(swellAmt * surgeGain + 0.0);
      for (let s = 0; s < steps; s++) step(feed, kill);

      // Cinematic post-FX: bloom + feedback trail → a living, glowing bath.
      renderer.setPostEffects(generativePostFx(bloomAmt, trail));

      const voidColor = directorColor(director, 0.04);
      renderer.beginFrame({ r: voidColor.r * 0.1, g: voidColor.g * 0.1, b: voidColor.b * 0.12, a: 1 });

      const cell = 1 / GRID_SIZE;
      const intensity = clamp01(director.intensity + bass * 0.3);

      // Pass 1: gradient-filled tiles, color ramped across the palette by
      // concentration. `hueSpread` widens the palette window; contrast deepens.
      renderer.setBlendMode("alpha");
      for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
          const c = clamp01(v[idx(x, y)]!);
          if (c < 0.04) continue; // skip near-empty cells (cheaper, cleaner).
          const t = clamp01(c * hueSpread + (1 - hueSpread) * 0.5);
          const col = directorColor(director, t);
          const lift = clamp01(0.2 + c * (0.6 + contrast * 0.4));
          const lit = { r: col.r * lift, g: col.g * lift, b: col.b * lift, a: col.a };
          const s = cell * (0.5 + 0.5 * c);
          const pad = (cell - s) / 2;
          renderer.drawGradientRect(
            { x: x * cell + pad, y: y * cell + pad, w: s, h: s, color: lit },
            { from: withAlpha(lit, 0.2), to: lit, radial: true },
          );
        }
      }

      // Pass 2: additive glow cores on the dense ridges — the light the bath
      // blooms from. Brightness rises with concentration + energy + the swell.
      const beat = swellAmt * surgeGain;
      for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
          const c = clamp01(v[idx(x, y)]!);
          if (c < 0.45) continue; // only the bright ridges glow.
          const t = clamp01(c * hueSpread + (1 - hueSpread) * 0.5);
          const col = directorColor(director, t);
          const gain = 0.5 + glowK * 1.2 + intensity * 0.9 + beat * 1.4;
          renderer.drawGlow({
            x: x * cell + cell / 2,
            y: y * cell + cell / 2,
            radius: cell * (1.0 + glowK * 0.8 + c * 0.6),
            color: hot(col, c),
            intensity: gain * c,
          });
        }
      }

      renderer.endFrame();
    },
    dispose(): void {
      u = new Float64Array(n);
      v = new Float64Array(n);
      nu = new Float64Array(n);
      nv = new Float64Array(n);
      bassS = null;
      trebleS = null;
      swell.reset();
    },
  };
}

const REACTION_PARAMS = [
  { key: P.feedBias, label: "Feed bias", group: "Chemistry", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.5 },
  { key: P.killBias, label: "Kill bias", group: "Chemistry", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.5 },
  { key: P.surge, label: "Beat surge", group: "Chemistry", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.glow, label: "Glow intensity", group: "Light", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.7 },
  { key: P.bloom, label: "Bloom amount", group: "Light", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.trail, label: "Trail decay", group: "Light", type: "number" as const, min: 0, max: 0.92, step: 0.01, default: 0.8 },
  { key: P.hueSpread, label: "Hue spread", group: "Color", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.7 },
  { key: P.contrast, label: "Contrast", group: "Color", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.5 },
];

const REACTION_BINDINGS = {
  // Feed/kill bias ride bass/treble; glow + bloom build with the director;
  // the beat surge rides bass; contrast follows the director.
  [P.feedBias]: { source: "audio" as const, path: "bass", smoothing: 0.85 },
  [P.killBias]: { source: "audio" as const, path: "treble", smoothing: 0.85 },
  [P.glow]: { source: "director" as const, path: "intensity", outMin: 0.45, outMax: 1, smoothing: 0.8 },
  [P.bloom]: { source: "director" as const, path: "bloom", smoothing: 0.8 },
  [P.surge]: { source: "audio" as const, path: "bass", outMin: 0.4, outMax: 1, smoothing: 0.7 },
  [P.contrast]: { source: "director" as const, path: "contrast", smoothing: 0.8 },
};

/** The Reaction preset definition — rich param schema with audio/director bindings. */
export const reactionPreset: PresetDefinition = composePreset({
  id: "generative.reaction",
  name: "Reaction",
  description:
    "A Gray-Scott reaction-diffusion bath whose concentration becomes luminous color — gradient tiles with additive glow on the dense ridges: bass raises the feed rate, treble the kill rate, a beat surges the chemistry, and a strong onset or section change reseeds a fresh pattern as the color crossfades over the track.",
  tags: ["generative", "reaction-diffusion", "gray-scott", "luminous", "cinematic"],
  params: REACTION_PARAMS,
  bindings: REACTION_BINDINGS,
  layers: () => [makeReactionLayer(DEFAULT_SEED)],
});

/** Build a Reaction definition with an explicit seed (used by tests). */
export function reactionPresetWithSeed(seed: number): PresetDefinition {
  return composePreset({
    id: `generative.reaction.${seed}`,
    name: "Reaction",
    description: reactionPreset.description,
    tags: reactionPreset.tags,
    params: REACTION_PARAMS,
    bindings: REACTION_BINDINGS,
    layers: () => [makeReactionLayer(seed)],
  });
}
