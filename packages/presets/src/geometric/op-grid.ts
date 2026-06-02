/**
 * `opGridPreset` — an Op-art reactive grid.
 *
 * A regular grid of squares whose individual fill scale pulses with bass and
 * whose checkerboard contrast deepens with treble; the whole field rotates one
 * discrete step on each onset. The look references the high-contrast optical
 * grids of the Op-art movement (Bridget-Riley-era), but the name references the
 * *technique* ("Op Grid"), never a person.
 *
 * Built ONLY from the public primitive surface (`band`, `mapFeature`,
 * `smoothBand`, easing, palette `sample`) and `Renderer.drawRect`. It never
 * touches WebGL/WebGPU, so it runs identically on both backends. Given the same
 * (features, time) it draws the same rects, so it is deterministic and testable
 * with a recording mock renderer.
 */

import {
  band,
  easeOutCubic,
  mapFeature,
  palettes,
  sample,
  smoothBand,
  type BandSmoother,
} from "@cymatic/core";
import { composePreset, type Layer, type LayerFrame, type PresetDefinition } from "@cymatic/core";

/** Grid resolution (cells per axis). */
const COLS = 8;
const ROWS = 8;

/**
 * Per-onset rotation is expressed as a discrete index into four 90° steps.
 * Pure helper so a test can assert that an onset advances the step and a silent
 * frame does not.
 */
export function nextRotationStep(step: number, onset: boolean): number {
  return onset ? (step + 1) % 4 : step % 4;
}

/**
 * Compute a single cell's fill fraction (`[0, 1]`) from the smoothed bass, the
 * checkerboard parity, and the treble contrast. Pure and exported for direct
 * unit testing: more bass → larger cells; on a "dark" parity cell more treble
 * shrinks it (raising contrast between light/dark cells).
 */
export function cellFill(bass: number, treble: number, parity: 0 | 1): number {
  const base = mapFeature(easeOutCubic(bass), 0.35, 0.95);
  if (parity === 1) return base;
  // Dark cells recede further as treble (contrast) climbs.
  const contrast = mapFeature(treble, 0, 0.45);
  return Math.max(0.05, base - contrast);
}

function makeOpGridLayer(): Layer {
  let bass: BandSmoother | null = null;
  let treble: BandSmoother | null = null;
  let rotationStep = 0;
  let prevOnset = false;

  return {
    id: "geometric.opGrid",
    init(): void {
      bass = smoothBand("bass", 0.7);
      treble = smoothBand("treble", 0.5);
      rotationStep = 0;
      prevOnset = false;
    },
    draw({ renderer, features }: LayerFrame): void {
      const bassS = (bass ?? smoothBand("bass", 0.7)).push(features);
      const trebleS = (treble ?? smoothBand("treble", 0.5)).push(features);

      // Advance the discrete rotation on the rising edge of an onset only.
      if (features.onset && !prevOnset) {
        rotationStep = nextRotationStep(rotationStep, true);
      }
      prevOnset = features.onset;

      renderer.beginFrame(sample(palettes.mono, 0));

      const cellW = 1 / COLS;
      const cellH = 1 / ROWS;
      // Phase from the rotation step swaps the checkerboard parity each onset,
      // reading as a quarter-turn flip without any matrix math on the rects.
      const phase = rotationStep % 2;

      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const parity = (((r + c + phase) % 2) === 0 ? 1 : 0) as 0 | 1;
          const fill = cellFill(bassS, trebleS, parity);
          const w = cellW * fill;
          const h = cellH * fill;
          const x = c * cellW + (cellW - w) / 2;
          const y = r * cellH + (cellH - h) / 2;
          // Mid drives where we sit on the mono ramp for a subtle gray shift.
          const tone = parity === 1 ? 1 : mapFeature(band(features, "mid"), 0.05, 0.4);
          renderer.drawRect({ x, y, w, h, color: sample(palettes.mono, tone) });
        }
      }

      renderer.endFrame();
    },
    dispose(): void {
      bass = null;
      treble = null;
    },
  };
}

/** The Op Grid preset definition. */
export const opGridPreset: PresetDefinition = composePreset({
  id: "geometric.op-grid",
  name: "Op Grid",
  description:
    "High-contrast optical grid: cell scale pulses with bass, checkerboard contrast deepens with treble, the field flips a quarter-turn on each beat.",
  tags: ["geometric", "op-art", "grid", "swiss"],
  layers: () => [makeOpGridLayer()],
});
