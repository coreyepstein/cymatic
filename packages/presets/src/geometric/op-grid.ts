/**
 * `opGridPreset` — a cinematic Op-art reactive grid (V2-10 rebuild).
 *
 * A grid of crisp cells that GLOW: each cell is a gradient-filled tile whose
 * scale pulses with bass and the director's intensity, topped by an additive
 * glow core that brightens on the beat so the whole field reads as luminous
 * light rather than flat paint. Color is sampled from the director's crossfading
 * palette + hue rotation, so it visibly evolves over a track; cell density,
 * glow, line weight, color spread, bloom, motion speed and beat-flash strength
 * are all exposed as params with sensible default bindings to audio/director.
 *
 * The name references the optical-grid *technique* ("Op Grid"), never a person.
 * Built only on the public `@cymatic/core` surface (palette sampling, director
 * state, easing) + the Renderer's gradient/glow/line/blend/post-FX primitives —
 * no raw GL/GPU. Deterministic given `(features, director, time, seed)`.
 */

import {
  clamp01,
  easeOutCubic,
  mapFeature,
  smoothBand,
  withAlpha,
  type BandSmoother,
} from "@cymatic/core";
import {
  composePreset,
  type Layer,
  type LayerFrame,
  type PresetDefinition,
} from "@cymatic/core";

import {
  BeatFlash,
  directorColor,
  geometricPostFx,
  hot,
} from "./common.js";

/** Param keys, centralized so the layer and schema can't drift. */
const P = {
  cells: "cellDensity",
  glow: "glowIntensity",
  line: "lineWeight",
  spread: "colorSpread",
  bloom: "bloomAmount",
  motion: "motionSpeed",
  flash: "beatFlash",
  contrast: "contrast",
} as const;

/** Discrete grid resolutions the `cellDensity` param maps onto. */
const GRID_STEPS: readonly number[] = [4, 6, 8, 10, 12];

/**
 * Resolve a `[0,1]`-ish density param into a concrete grid size (cells per
 * axis). Pure + exported: higher density → a finer grid, snapped to a tasteful
 * set so the grid always stays crisp.
 */
export function gridResolution(density: number): number {
  const n = GRID_STEPS.length;
  const i = Math.min(n - 1, Math.max(0, Math.round(clamp01(density) * (n - 1))));
  return GRID_STEPS[i] ?? 8;
}

/**
 * Per-onset rotation step (four 90° phases). Pure helper so a test can assert an
 * onset advances the field's checkerboard phase and a silent frame does not.
 */
export function nextRotationStep(step: number, onset: boolean): number {
  return onset ? (step + 1) % 4 : step % 4;
}

/**
 * A single cell's fill fraction `[0,1]` from the (smoothed) bass, the director's
 * intensity, and the checkerboard parity. Pure + exported: more energy → larger
 * tiles; on a "dark" parity cell more contrast shrinks it (deepening the optical
 * contrast the movement is known for).
 */
export function cellFill(energy: number, intensity: number, contrast: number, parity: 0 | 1): number {
  const base = mapFeature(easeOutCubic(clamp01(energy * 0.6 + intensity * 0.5)), 0.34, 0.94);
  if (parity === 1) return base;
  const recede = mapFeature(clamp01(contrast), 0, 0.5);
  return Math.max(0.06, base - recede);
}

function makeOpGridLayer(): Layer {
  let bass: BandSmoother | null = null;
  let treble: BandSmoother | null = null;
  const flash = new BeatFlash(0.16);
  let rotationStep = 0;
  let prevOnset = false;

  return {
    id: "geometric.opGrid",
    init(): void {
      bass = smoothBand("bass", 0.7);
      treble = smoothBand("treble", 0.5);
      flash.reset();
      rotationStep = 0;
      prevOnset = false;
    },
    draw({ renderer, features, director, params, dt }: LayerFrame): void {
      const bassS = (bass ?? smoothBand("bass", 0.7)).push(features);
      const trebleS = (treble ?? smoothBand("treble", 0.5)).push(features);
      const flashAmt = flash.update(features.onset, dt);

      const glowK = clamp01(Number(params[P.glow] ?? 0.6));
      const lineW = Number(params[P.line] ?? 0.004);
      const spread = clamp01(Number(params[P.spread] ?? 0.7));
      const bloomAmt = clamp01(Number(params[P.bloom] ?? director.bloom));
      const flashStrength = clamp01(Number(params[P.flash] ?? 0.7));
      const contrast = clamp01(Number(params[P.contrast] ?? director.contrast));
      const cols = gridResolution(Number(params[P.cells] ?? 0.5) * (0.7 + 0.3 * director.density));
      const rows = cols;

      // Cinematic post-FX: bloom on (scaled by the director), light trail.
      renderer.setPostEffects(geometricPostFx(bloomAmt, 0.45 + director.motion * 0.12));

      // Advance the discrete rotation on the rising edge of an onset.
      if (features.onset && !prevOnset) rotationStep = nextRotationStep(rotationStep, true);
      prevOnset = features.onset;

      // A deep, palette-tinted void rather than flat black, so the grid floats
      // on color that itself evolves with the director.
      const voidColor = directorColor(director, 0.05);
      renderer.beginFrame({ r: voidColor.r * 0.12, g: voidColor.g * 0.12, b: voidColor.b * 0.14, a: 1 });

      const cellW = 1 / cols;
      const cellH = 1 / rows;
      const phase = rotationStep % 2;
      const intensity = clamp01(director.intensity + bassS * 0.4);

      // Pass 1: gradient-filled tiles (alpha). Crisp geometry, but each tile is a
      // ramp toward its glow color so it reads with depth, not as flat paint.
      renderer.setBlendMode("alpha");
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const parity = (((r + c + phase) % 2) === 0 ? 1 : 0) as 0 | 1;
          const fill = cellFill(bassS, intensity, contrast, parity);
          const w = cellW * fill;
          const h = cellH * fill;
          const x = c * cellW + (cellW - w) / 2;
          const y = r * cellH + (cellH - h) / 2;
          // Color ramps across the grid; `spread` widens how far across the
          // palette the field reaches so color variety scales with the param.
          const t = ((c / Math.max(1, cols - 1)) * 0.5 + (r / Math.max(1, rows - 1)) * 0.5) * spread;
          const col = directorColor(director, clamp01(t));
          const lit = parity === 1 ? col : { r: col.r * 0.4, g: col.g * 0.4, b: col.b * 0.4, a: col.a };
          renderer.drawGradientRect(
            { x, y, w, h, color: lit },
            { from: withAlpha(lit, 0.25), to: lit, radial: true },
          );
        }
      }

      // Pass 2: additive glow cores on the bright (parity-1) cells. This is the
      // light: intensity rises with energy + the beat flash so the field pulses.
      const beat = flashAmt * flashStrength;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const parity = ((r + c + phase) % 2) === 0 ? 1 : 0;
          if (parity !== 1) continue;
          const cx = c * cellW + cellW / 2;
          const cy = r * cellH + cellH / 2;
          const t = ((c / Math.max(1, cols - 1)) + (r / Math.max(1, rows - 1))) * 0.5 * spread;
          const col = directorColor(director, clamp01(t));
          const gain = 0.6 + glowK * 1.6 + intensity * 1.2 + beat * 2.0;
          renderer.drawGlow({
            x: cx,
            y: cy,
            radius: cellW * (0.5 + glowK * 0.4 + beat * 0.3),
            color: hot(col, 1),
            intensity: gain,
          });
        }
      }

      // Pass 3: thin additive grid lines, brightening with treble — the crisp
      // optical lattice over the glow.
      if (lineW > 0) {
        renderer.setBlendMode("additive");
        const lineCol = hot(directorColor(director, clamp01(0.8 * spread)), 0.5 + trebleS * 1.2 + beat);
        for (let c = 0; c <= cols; c++) {
          const x = c * cellW;
          renderer.drawLine({ x0: x, y0: 0, x1: x, y1: 1, width: lineW, color: lineCol });
        }
        for (let r = 0; r <= rows; r++) {
          const y = r * cellH;
          renderer.drawLine({ x0: 0, y0: y, x1: 1, y1: y, width: lineW, color: lineCol });
        }
      }

      renderer.endFrame();
    },
    dispose(): void {
      bass = null;
      treble = null;
      flash.reset();
    },
  };
}

/** The Op Grid preset definition — rich param schema with audio/director bindings. */
export const opGridPreset: PresetDefinition = composePreset({
  id: "geometric.op-grid",
  name: "Op Grid",
  description:
    "A luminous optical grid: gradient tiles glow with bass and the song's energy, additive cores pulse on the beat, and the color crossfades over the track via the auto-director.",
  tags: ["geometric", "op-art", "grid", "swiss", "cinematic"],
  params: [
    { key: P.cells, label: "Cell density", group: "Geometry", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: P.line, label: "Line weight", group: "Geometry", type: "number", min: 0, max: 0.02, step: 0.001, default: 0.004 },
    { key: P.glow, label: "Glow intensity", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: P.bloom, label: "Bloom amount", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: P.flash, label: "Beat flash", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.7 },
    { key: P.spread, label: "Color spread", group: "Color", type: "number", min: 0, max: 1, step: 0.01, default: 0.7 },
    { key: P.contrast, label: "Contrast", group: "Color", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: P.motion, label: "Motion speed", group: "Motion", type: "number", min: 0, max: 2, step: 0.01, default: 1 },
  ],
  bindings: {
    // Glow and bloom build with the song; contrast follows the director; the
    // beat-flash strength rides treble so brighter mixes punch harder.
    [P.glow]: { source: "director", path: "intensity", outMin: 0.3, outMax: 1, smoothing: 0.6 },
    [P.bloom]: { source: "director", path: "bloom", smoothing: 0.6 },
    [P.contrast]: { source: "director", path: "contrast", smoothing: 0.7 },
    [P.flash]: { source: "audio", path: "treble", outMin: 0.4, outMax: 1, smoothing: 0.4 },
    [P.cells]: { source: "director", path: "density", inMin: 0.5, inMax: 1.6, smoothing: 0.7 },
    [P.motion]: { source: "director", path: "motion", inMin: 0.5, inMax: 2, outMin: 0.5, outMax: 2 },
  },
  layers: () => [makeOpGridLayer()],
});
