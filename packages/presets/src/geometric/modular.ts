/**
 * `modularPreset` — modular, gridded blocks in the constructivist / Bauhaus
 * tradition: a column-based layout of stacked rectangles whose heights are
 * driven by the audio spectrum, with a beat-driven accent block that snaps to a
 * new column on each onset. The name references *modular* composition, not a
 * person or trademark.
 *
 * Public-surface only: `bandAt`/`band`, easing, palette `sample`, `smoothBand`,
 * and `Renderer.drawRect`. Deterministic given (features, time).
 */

import {
  band,
  bandAt,
  easeOutCubic,
  mapFeature,
  palettes,
  sample,
  smoothBand,
  type BandSmoother,
} from "@cymatic/core";
import { composePreset, type Layer, type LayerFrame, type PresetDefinition } from "@cymatic/core";

/** Number of vertical modules (columns). */
const MODULES = 6;
/** Gap between modules as a fraction of a module slot. */
const GAP = 0.12;

/**
 * Choose which module the beat accent jumps to. Pure + exported so a test can
 * assert the accent advances on an onset and holds otherwise.
 */
export function nextAccentModule(current: number, onset: boolean): number {
  return onset ? (current + 1) % MODULES : current % MODULES;
}

/**
 * Module block height fraction from a (smoothed) per-module band energy. Pure;
 * higher energy → taller block, eased for a non-twitchy response.
 */
export function moduleHeight(energy: number): number {
  return mapFeature(easeOutCubic(energy), 0.08, 0.92);
}

function makeModularLayer(): Layer {
  const smoothers: BandSmoother[] = [];
  let accent = 0;
  let prevOnset = false;

  return {
    id: "geometric.modular",
    init(): void {
      smoothers.length = 0;
      // One smoother per module, each tracking overall energy but settling at
      // its own rate so the columns don't move in lockstep.
      for (let i = 0; i < MODULES; i++) {
        const name = i % 3 === 0 ? "bass" : i % 3 === 1 ? "mid" : "treble";
        smoothers.push(smoothBand(name, 0.55 + (i / MODULES) * 0.3));
      }
      accent = 0;
      prevOnset = false;
    },
    draw({ renderer, features }: LayerFrame): void {
      if (features.onset && !prevOnset) {
        accent = nextAccentModule(accent, true);
      }
      prevOnset = features.onset;

      // Background warms slightly with mid energy but stays restrained.
      const bg = sample(palettes.ember, mapFeature(band(features, "mid"), 0.0, 0.18));
      renderer.beginFrame(bg);

      const slot = 1 / MODULES;
      const moduleW = slot * (1 - GAP);

      for (let i = 0; i < MODULES; i++) {
        const smoother = smoothers[i] ?? smoothBand("mid", 0.6);
        const energy = smoother.push(features);
        const h = moduleHeight(energy);
        const x = i * slot + (slot - moduleW) / 2;
        const isAccent = i === accent;
        // Accent column reads brighter on the ember ramp; others sit lower.
        const t = isAccent ? 0.95 : mapFeature(bandAt(features, i), 0.35, 0.7);
        const color = sample(palettes.ember, t);
        renderer.drawRect({ x, y: 1 - h, w: moduleW, h, color });

        // A small fixed "cap" block tops each module — the modular motif —
        // brightened on the accent column by an onset.
        const capH = slot * 0.25;
        const capColor = sample(palettes.ember, isAccent ? 1 : 0.5);
        renderer.drawRect({ x, y: 1 - h - capH, w: moduleW, h: capH, color: capColor });
      }

      renderer.endFrame();
    },
    dispose(): void {
      smoothers.length = 0;
    },
  };
}

/** The Modular preset definition. */
export const modularPreset: PresetDefinition = composePreset({
  id: "geometric.modular",
  name: "Modular",
  description:
    "Constructivist column modules: per-module spectrum drives block heights, a capped accent column snaps to the next module on each beat.",
  tags: ["geometric", "bauhaus", "modular", "constructivist"],
  layers: () => [makeModularLayer()],
});
