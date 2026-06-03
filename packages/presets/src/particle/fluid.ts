/**
 * `fluidPreset` — "Fluid" (V2-13 cinematic rebuild).
 *
 * A coarse advected dye field on a modest grid, rendered as LUMINOUS GRADIENT
 * CELLS topped by additive GLOW cores so the plume reads as glowing light rather
 * than flat paint. Dye is injected at the bottom and on beats, swept upward and
 * sideways by a slowly-rotating, audio-modulated velocity field, and dissipates
 * over time so the field keeps breathing. Audio + the director drive it:
 *
 *   - A BEAT injects a bright pulse of dye across a band of cells (a swell).
 *   - BASS increases the upward advection (the plume RISES faster).
 *   - TREBLE adds horizontal SWIRL so the field shears and curls.
 *   - GLOW intensity rises with the director's intensity + bloom, so the plume
 *     blooms brighter on the drop.
 *   - COLOR is sampled from the director's crossfading palette + hue rotation by
 *     dye concentration, so the plume recolors over a track.
 *
 * The grid is deliberately small (`gridSize`, default 44 → 44×44 cells) and
 * configurable + hard-capped so it stays smooth. Advection is a cheap
 * semi-Lagrangian backtrace with bilinear sampling — pure math, no GL. A seeded
 * PRNG ({@link mulberry32}) shapes per-column emission/phase profiles and the
 * director's per-section seed is folded in via {@link sectionSeed}, so each
 * section grows a fresh plume — never `Math.random` / `Date.now`. "Fluid" names
 * the technique. Public `@cymatic/core` surface only.
 */

import {
  band,
  clamp01,
  mapFeature,
  withAlpha,
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

/** Default grid side; total cells = gridSize². Modest for smoothness. */
export const DEFAULT_GRID_SIZE = 44;
/** Absolute upper bound on grid side (perf guard). */
export const MAX_GRID_SIZE = 140;

const P = {
  grid: "gridDensity",
  rise: "rise",
  swirl: "swirl",
  glow: "glowIntensity",
  trail: "trailDecay",
  bloom: "bloomAmount",
  hueDrift: "hueDrift",
  swell: "beatSwell",
} as const;

/** Options for {@link makeFluidLayer} / the Fluid preset. */
export interface FluidOptions {
  /** Grid side length (cells = size²). Defaults to {@link DEFAULT_GRID_SIZE}. */
  gridSize?: number;
}

/**
 * Per-frame fluid field parameters derived from audio + the params. Pure +
 * exported so a test can assert bass raises the rise speed and treble raises the
 * swirl. `rise` is upward advection (normalized cells/sec), `swirl` the
 * horizontal shear.
 */
export function fluidParams(
  bass: number,
  treble: number,
  swell: number,
  riseParam: number,
  swirlParam: number,
): { rise: number; swirl: number } {
  const rise = mapFeature(clamp01(bass + swell * 0.4), 0.25, 1.7) * (0.4 + clamp01(riseParam));
  const swirl = mapFeature(clamp01(treble + swell * 0.3), 0.05, 1.0) * (0.4 + clamp01(swirlParam));
  return { rise, swirl };
}

function makeFluidLayer(seed: number, options: FluidOptions = {}): Layer {
  const size = clampCount(options.gridSize ?? DEFAULT_GRID_SIZE, DEFAULT_GRID_SIZE, MAX_GRID_SIZE);
  const n = size * size;
  let dye = new Float64Array(n);
  let next = new Float64Array(n);
  const swell = new BeatSwell(0.5);
  // Fixed, seed-derived per-column profiles so the field is spatially varied but
  // deterministic: `phase` shifts the swirl, `source` weights how much dye each
  // bottom-row column emits. Both are reproducible for a given seed and make the
  // evolved field genuinely seed-dependent (not just the velocity direction).
  const phase = new Float64Array(size);
  const source = new Float64Array(size);
  let activeSeed = seed;

  const idx = (c: number, r: number): number => r * size + c;

  function seedProfiles(s: number): void {
    const rng = mulberry32(s);
    for (let c = 0; c < size; c++) {
      phase[c] = rng() * Math.PI * 2;
      // Per-column source weight in [0.25, 1] — a fixed, seed-derived emission
      // profile so different seeds grow visibly different plumes.
      source[c] = 0.25 + rng() * 0.75;
    }
  }

  /** Bilinear sample of the dye field at continuous grid coords (clamped edges). */
  function sampleDye(field: Float64Array, x: number, y: number): number {
    const cx = x < 0 ? 0 : x > size - 1 ? size - 1 : x;
    const cy = y < 0 ? 0 : y > size - 1 ? size - 1 : y;
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = x0 + 1 < size ? x0 + 1 : x0;
    const y1 = y0 + 1 < size ? y0 + 1 : y0;
    const fx = cx - x0;
    const fy = cy - y0;
    const a = field[idx(x0, y0)]!;
    const b = field[idx(x1, y0)]!;
    const c = field[idx(x0, y1)]!;
    const d = field[idx(x1, y1)]!;
    const top = a + (b - a) * fx;
    const bot = c + (d - c) * fx;
    return top + (bot - top) * fy;
  }

  return {
    id: "particle.fluid",
    init(): void {
      dye = new Float64Array(n);
      next = new Float64Array(n);
      swell.reset();
      activeSeed = sectionSeed(seed, 0);
      seedProfiles(activeSeed);
    },
    draw({ renderer, features, director, params, time, dt }: LayerFrame): void {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
      const swellAmt = swell.update(features.onset, step);
      const bass = band(features, "bass");
      const treble = band(features, "treble");

      const gridParam = clamp01(Number(params[P.grid] ?? 0.6));
      const riseParam = clamp01(Number(params[P.rise] ?? 0.6));
      const swirlParam = clamp01(Number(params[P.swirl] ?? 0.6));
      const glowK = clamp01(Number(params[P.glow] ?? 0.7));
      const trail = clamp01(Number(params[P.trail] ?? 0.86));
      const bloomAmt = clamp01(Number(params[P.bloom] ?? director.bloom));
      const hueDrift = clamp01(Number(params[P.hueDrift] ?? 0.5));
      const swellGain = clamp01(Number(params[P.swell] ?? 0.6));

      // Per-section reseed: a fresh director seed regrows the plume profiles.
      const wantSeed = sectionSeed(seed, director.seed);
      if (wantSeed !== activeSeed) {
        activeSeed = wantSeed;
        seedProfiles(activeSeed);
      }

      const { rise, swirl } = fluidParams(bass, treble, swellAmt * swellGain, riseParam, swirlParam);

      // --- Inject dye at the bottom row (steady source) + a beat pulse band ---
      // `gridDensity` scales the steady source so a denser setting grows a busier,
      // fuller plume (lighter settings keep it sparse and wispy).
      const bottom = size - 1;
      const sourceGain = 0.5 + gridParam;
      for (let c = 0; c < size; c++) {
        dye[idx(c, bottom)] = clamp01(dye[idx(c, bottom)]! + (0.07 + bass * 0.16) * source[c]! * sourceGain);
      }
      if (features.onset || swellAmt > 0.05) {
        const pulseRow = Math.min(size - 1, Math.floor(size * 0.7));
        for (let c = 0; c < size; c++) {
          dye[idx(c, pulseRow)] = clamp01(dye[idx(c, pulseRow)]! + swellAmt * swellGain * 0.55);
        }
      }

      // --- Advect: semi-Lagrangian backtrace through the velocity field ---
      // A shorter dissipation half-life keeps the field from accumulating toward
      // a saturated white (which would wash out the palette hue under bloom).
      const dissipate = decayFactor(step, 0.9);
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          // Velocity: upward rise + per-column horizontal swirl (curls over time).
          const vy = -rise; // grid rows increase downward, so rise is negative dy
          const vx = Math.sin(time * 0.8 + phase[c]! + r * 0.15) * swirl;
          const srcX = c - vx * step * size * 0.5;
          const srcY = r - vy * step * size * 0.5;
          next[idx(c, r)] = sampleDye(dye, srcX, srcY) * dissipate;
        }
      }
      const swap = dye;
      dye = next;
      next = swap;

      // --- Render: gradient cells + additive glow cores → a luminous plume ---
      // The fluid is a near-full-frame field (unlike the sparse comet presets),
      // so it uses a SHORTER feedback trail + a softer bloom than the pack default
      // — a long trail + strong bloom over a full field accumulates the HDR target
      // toward a saturated white that washes out the palette hue. Cap both here.
      const fx = particlePostFx(bloomAmt * 0.5, Math.min(trail, 0.55));
      renderer.setPostEffects(fx);
      const voidColor = directorColor(director, 0.04);
      renderer.beginFrame({ r: voidColor.r * 0.08, g: voidColor.g * 0.08, b: voidColor.b * 0.12, a: 1 });

      const cw = 1 / size;
      const ch = 1 / size;
      const intensity = clamp01(director.intensity + bass * 0.4);

      // Pass 1: gradient-filled cells (alpha) — the dye body, a soft ramp toward
      // its lit color so it reads with depth, not flat paint.
      renderer.setBlendMode("alpha");
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const v = dye[idx(c, r)]!;
          if (v <= 0.02) continue; // skip near-empty cells (cheaper, darker bg shows)
          const t = clamp01(v * (0.5 + 0.5 * hueDrift) + (1 - r / size) * 0.2);
          const col = directorColor(director, t);
          // Keep the body well below clipping so the palette hue survives (a
          // fully-bright body would wash to white under bloom and lose its color).
          const lum = 0.15 + v * 0.7;
          const lit = { r: col.r * lum, g: col.g * lum, b: col.b * lum, a: 1 };
          renderer.drawGradientRect(
            { x: c * cw, y: r * ch, w: cw, h: ch, color: lit },
            { from: withAlpha(lit, 0.2), to: lit, radial: true },
          );
        }
      }

      // Pass 2: additive glow cores on the brightest cells — the light. Intensity
      // rises with energy + the beat swell so the plume pulses + blooms.
      const beat = swellAmt * swellGain;
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const v = dye[idx(c, r)]!;
          if (v <= 0.35) continue; // only the dense dye glows (keeps it tasteful)
          const t = clamp01(v * (0.5 + 0.5 * hueDrift) + (1 - r / size) * 0.2);
          const col = directorColor(director, t);
          const gain = 0.3 + glowK * 0.8 + intensity * 0.6 + beat * 1.0;
          renderer.drawGlow({
            x: c * cw + cw / 2,
            y: r * ch + ch / 2,
            radius: cw * (0.7 + glowK * 0.6 + v * 0.4),
            color: hot(col, 1),
            intensity: gain * v,
          });
        }
      }

      renderer.endFrame();
    },
    dispose(): void {
      dye = new Float64Array(0);
      next = new Float64Array(0);
      swell.reset();
    },
  };
}

const FLUID_PARAMS = [
  { key: P.grid, label: "Grid density", group: "Field", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.rise, label: "Rise", group: "Field", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.swirl, label: "Swirl", group: "Field", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.glow, label: "Glow intensity", group: "Light", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.7 },
  { key: P.bloom, label: "Bloom amount", group: "Light", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.trail, label: "Trail decay", group: "Light", type: "number" as const, min: 0, max: 0.93, step: 0.01, default: 0.86 },
  { key: P.swell, label: "Beat swell", group: "Light", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.hueDrift, label: "Hue drift", group: "Color", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.5 },
];

const FLUID_BINDINGS = {
  // Rise rides bass, swirl rides treble; glow + bloom build with the director's
  // intensity; the swell rides bass so heavy low end pulses the plume.
  [P.rise]: { source: "audio" as const, path: "bass", outMin: 0.4, outMax: 1, smoothing: 0.7 },
  [P.swirl]: { source: "audio" as const, path: "treble", outMin: 0.4, outMax: 1, smoothing: 0.7 },
  [P.glow]: { source: "director" as const, path: "intensity", outMin: 0.4, outMax: 1, smoothing: 0.8 },
  [P.bloom]: { source: "director" as const, path: "bloom", smoothing: 0.8 },
  [P.swell]: { source: "audio" as const, path: "bass", outMin: 0.4, outMax: 1, smoothing: 0.6 },
  [P.hueDrift]: { source: "audio" as const, path: "treble", outMin: 0.3, outMax: 0.9, smoothing: 0.85 },
};

/** The Fluid preset definition — rich param schema with audio/director bindings. */
export const fluidPreset: PresetDefinition = composePreset({
  id: "particle.fluid",
  name: "Fluid",
  description:
    "A coarse advected dye field rendered as luminous gradient cells topped by additive glow: dye rises from the bottom, beats inject bright pulses, bass speeds the plume's rise and treble adds horizontal swirl, with the dye mapped to the director's crossfading palette so the bloom-heavy plume recolors over the track.",
  tags: ["fluid", "advection", "dye", "glow", "cinematic"],
  params: FLUID_PARAMS,
  bindings: FLUID_BINDINGS,
  layers: () => [makeFluidLayer(DEFAULT_SEED)],
});

/** Build a Fluid definition with an explicit seed and/or options (tests, hosts). */
export function fluidPresetWithSeed(seed: number, options: FluidOptions = {}): PresetDefinition {
  return composePreset({
    id: `particle.fluid.${seed}`,
    name: "Fluid",
    description: fluidPreset.description,
    tags: fluidPreset.tags,
    params: FLUID_PARAMS,
    bindings: FLUID_BINDINGS,
    layers: () => [makeFluidLayer(seed, options)],
  });
}
