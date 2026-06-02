/**
 * `fluidPreset` — "Fluid". A coarse advection/dye simulation on a modest grid,
 * rendered one rect per cell. Dye is injected at the bottom and on beats, swept
 * upward and sideways by a slowly-rotating, audio-modulated velocity field, and
 * dissipates over time so the field keeps breathing. Audio drives it:
 *
 *   - A BEAT injects a bright pulse of dye across a band of cells (emission).
 *   - BASS increases the upward advection speed (the plume rises faster).
 *   - TREBLE adds horizontal swirl so the field shears and curls.
 *   - The dye amount per cell maps to a palette color + brightness.
 *
 * The grid is deliberately small (`gridSize`, default 48 → 48×48 = 2304 cells)
 * and configurable, so it stays smooth at typical resolution. Advection is a
 * cheap semi-Lagrangian backtrace with bilinear sampling — no GL, pure math.
 * Built on the public `@cymatic/core` surface and a seeded PRNG
 * ({@link mulberry32}) so output is reproducible / unit-testable.
 */

import {
  band,
  clamp01,
  mapFeature,
  mixColor,
  palettes,
  sample,
} from "@cymatic/core";
import { composePreset, type Layer, type LayerFrame, type PresetDefinition } from "@cymatic/core";

import { DEFAULT_SEED, advanceBurst, clampCount, decayFactor, mulberry32 } from "./common.js";

/** Default grid side; total cells = gridSize². Modest for smoothness. */
export const DEFAULT_GRID_SIZE = 48;
/** Absolute upper bound on grid side (perf guard). */
export const MAX_GRID_SIZE = 160;

/** Options for {@link makeFluidLayer} / the Fluid preset. */
export interface FluidOptions {
  /** Grid side length (cells = size²). Defaults to {@link DEFAULT_GRID_SIZE}. */
  gridSize?: number;
}

/**
 * Per-frame fluid field parameters derived from audio. Pure + exported so a test
 * can assert bass raises the rise speed and treble raises the swirl. `rise` is
 * upward advection (cells/sec, normalized), `swirl` the horizontal shear.
 */
export function fluidParams(bass: number, treble: number, burst: number): { rise: number; swirl: number } {
  const rise = mapFeature(clamp01(bass + burst * 0.4), 0.25, 1.6);
  const swirl = mapFeature(clamp01(treble + burst * 0.3), 0.05, 0.9);
  return { rise, swirl };
}

function makeFluidLayer(seed: number, options: FluidOptions = {}): Layer {
  const size = clampCount(options.gridSize ?? DEFAULT_GRID_SIZE, DEFAULT_GRID_SIZE, MAX_GRID_SIZE);
  const n = size * size;
  const rng = mulberry32(seed);
  let dye = new Float64Array(n);
  let next = new Float64Array(n);
  let burst = 0;
  // Fixed, seed-derived per-column profiles so the field is spatially varied but
  // deterministic: `phase` shifts the swirl, `source` weights how much dye each
  // bottom-row column emits. Both are reproducible for a given seed and make the
  // evolved field genuinely seed-dependent (not just the velocity direction).
  const phase = new Float64Array(size);
  const source = new Float64Array(size);

  const idx = (c: number, r: number): number => r * size + c;

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
      burst = 0;
      for (let c = 0; c < size; c++) {
        phase[c] = rng() * Math.PI * 2;
        // Per-column source weight in [0.25, 1] — a fixed, seed-derived emission
        // profile so different seeds grow visibly different plumes.
        source[c] = 0.25 + rng() * 0.75;
      }
    },
    draw({ renderer, features, time, dt }: LayerFrame): void {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
      burst = advanceBurst(burst, features.onset, step, 0.5);
      const bass = band(features, "bass");
      const treble = band(features, "treble");
      const { rise, swirl } = fluidParams(bass, treble, burst);

      // --- Inject dye at the bottom row (steady source) + a beat pulse band ---
      // Inject a moderate amount weighted by the seed-derived per-column source
      // profile. Kept well below saturation so the profile (and thus the seed)
      // shapes a visibly different plume rather than clamping every cell to 1.
      const bottom = size - 1;
      for (let c = 0; c < size; c++) {
        dye[idx(c, bottom)] = clamp01(dye[idx(c, bottom)]! + (0.12 + bass * 0.25) * source[c]!);
      }
      if (features.onset || burst > 0.05) {
        const pulseRow = Math.min(size - 1, Math.floor(size * 0.7));
        for (let c = 0; c < size; c++) {
          dye[idx(c, pulseRow)] = clamp01(dye[idx(c, pulseRow)]! + burst * 0.9);
        }
      }

      // --- Advect: semi-Lagrangian backtrace through the velocity field ---
      const dissipate = decayFactor(step, 1.4);
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

      // --- Render: one rect per cell, dye → palette color + brightness ---
      renderer.beginFrame({ r: 0, g: 0, b: 0.02, a: 1 });
      const cw = 1 / size;
      const ch = 1 / size;
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const v = dye[idx(c, r)]!;
          if (v <= 0.01) continue; // skip near-empty cells (cheaper, darker bg shows)
          const base = sample(palettes.aqua, clamp01(v));
          const color = mixColor({ r: 0, g: 0, b: 0, a: 1 }, base, clamp01(0.15 + v));
          renderer.drawRect({ x: c * cw, y: r * ch, w: cw, h: ch, color });
        }
      }
      renderer.endFrame();
    },
    dispose(): void {
      dye = new Float64Array(0);
      next = new Float64Array(0);
      burst = 0;
    },
  };
}

/** The Fluid preset definition (default grid). */
export const fluidPreset: PresetDefinition = composePreset({
  id: "particle.fluid",
  name: "Fluid",
  description:
    "A coarse advected dye field on a modest grid: dye rises from the bottom, beats inject bright pulses, bass speeds the plume's rise and treble adds horizontal swirl, with the dye amount mapped to a luminous palette.",
  tags: ["fluid", "advection", "dye", "beat-reactive"],
  layers: () => [makeFluidLayer(DEFAULT_SEED)],
});

/** Build a Fluid definition with an explicit seed and/or options (tests, hosts). */
export function fluidPresetWithSeed(seed: number, options: FluidOptions = {}): PresetDefinition {
  return composePreset({
    id: `particle.fluid.${seed}`,
    name: "Fluid",
    description: fluidPreset.description,
    tags: fluidPreset.tags,
    layers: () => [makeFluidLayer(seed, options)],
  });
}
