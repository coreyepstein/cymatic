/**
 * `concentricPreset` — hard-edge concentric frames in the Swiss / geometric-
 * abstraction tradition: nested square rings drawn from the outside in, each
 * ring's thickness and color stepping from the spectrum, the whole stack
 * breathing (scaling about the center) with bass and flashing the innermost
 * block on each onset. "Concentric" / "Hard Edge" reference techniques, not a
 * person.
 *
 * Public-surface only; nested rings are drawn as four rect borders per ring via
 * `Renderer.drawRect`. Deterministic given (features, time).
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

/** Number of concentric rings. */
const RINGS = 5;

/**
 * Overall breathing scale of the ring stack from (smoothed) bass. Pure +
 * exported: louder bass → the stack expands toward the frame edges, eased so it
 * settles rather than jitters. An onset adds a brief outward pop.
 */
export function breathScale(bass: number, onset: boolean): number {
  const base = mapFeature(easeOutCubic(bass), 0.55, 0.95);
  return Math.min(1, base + (onset ? 0.05 : 0));
}

function makeConcentricLayer(): Layer {
  let bass: BandSmoother | null = null;
  let treble: BandSmoother | null = null;

  return {
    id: "geometric.concentric",
    init(): void {
      bass = smoothBand("bass", 0.75);
      treble = smoothBand("treble", 0.6);
    },
    draw({ renderer, features }: LayerFrame): void {
      const bassS = (bass ?? smoothBand("bass", 0.75)).push(features);
      const trebleS = (treble ?? smoothBand("treble", 0.6)).push(features);

      // Background sits at the aqua palette's deep end, warming faintly with mid.
      const bg = sample(palettes.aqua, mapFeature(band(features, "mid"), 0.0, 0.15));
      renderer.beginFrame(bg);

      const scale = breathScale(bassS, features.onset);
      // The outermost ring spans `scale` of the frame, centered.
      const outer = scale;
      const center = 0.5;

      for (let i = 0; i < RINGS; i++) {
        const t = i / (RINGS - 1);
        // Ring side length shrinks linearly inward.
        const side = outer * (1 - t * 0.85);
        const half = side / 2;
        // Ring stroke thickness grows with treble (sharper, harder edges).
        const stroke = Math.max(
          0.01,
          (side / RINGS) * 0.5 * mapFeature(trebleS, 0.4, 1.1),
        );
        const color = sample(palettes.aqua, mapFeature(t, 0.3, 1));

        const left = center - half;
        const top = center - half;

        if (i === RINGS - 1) {
          // Innermost: a solid block that flashes to white-ish on onset.
          const flash = features.onset
            ? sample(palettes.mono, 1)
            : color;
          renderer.drawRect({ x: left, y: top, w: side, h: side, color: flash });
          continue;
        }

        // Draw the ring as four hard-edge borders (top/bottom/left/right).
        renderer.drawRect({ x: left, y: top, w: side, h: stroke, color }); // top
        renderer.drawRect({ x: left, y: top + side - stroke, w: side, h: stroke, color }); // bottom
        renderer.drawRect({ x: left, y: top, w: stroke, h: side, color }); // left
        renderer.drawRect({ x: left + side - stroke, y: top, w: stroke, h: side, color }); // right
      }

      renderer.endFrame();
    },
    dispose(): void {
      bass = null;
      treble = null;
    },
  };
}

/** The Concentric preset definition. */
export const concentricPreset: PresetDefinition = composePreset({
  id: "geometric.concentric",
  name: "Concentric",
  description:
    "Hard-edge nested square rings: the stack breathes with bass, ring strokes sharpen with treble, the innermost block flashes on each beat.",
  tags: ["geometric", "hard-edge", "concentric", "swiss"],
  layers: () => [makeConcentricLayer()],
});
