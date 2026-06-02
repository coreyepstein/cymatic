/**
 * `bandsPreset` — stacked luminous bands in the color-field tradition: a few
 * broad horizontal regions (the "Bands"/"Veil" mood) whose boundaries breathe
 * with the (heavily smoothed) audio spectrum and whose colors are sampled from
 * a palette gradient. Each band is itself a soft gradient (rendered as several
 * thin strips) so the seams between bands are luminous rather than hard. Bass
 * sets overall luminance, the per-band spectrum nudges each boundary, and a
 * beat adds a slow decaying swell. Slow, breathing, non-jittery. The name
 * references technique/mood, not a person or trademark.
 *
 * Public-surface only: `band`/`bandAt`, easing, palette `sample`/`mixColor`,
 * `Smoother`, and `Renderer.drawRect`. Deterministic given (features, time).
 */

import {
  band,
  bandAt,
  clamp01,
  easeInOutSine,
  mapFeature,
  mixColor,
  palettes,
  sample,
  Smoother,
} from "@cymatic/core";
import { composePreset, type Layer, type LayerFrame, type PresetDefinition } from "@cymatic/core";

import { BeatSwell, FIELD_SMOOTHING } from "./common.js";

/** Number of luminous bands stacked top→bottom. */
const BANDS = 4;
/** Strips per band — each band is itself a small gradient for soft seams. */
const STRIPS_PER_BAND = 12;

/**
 * Resolve the BANDS+1 boundary positions (in `[0, 1]`, monotonic, spanning the
 * full height) from a set of (smoothed) per-band weights. Pure + exported so a
 * test can assert that shifting weight toward one band measurably grows its
 * region. Heavier weight on a band → that band claims more height.
 */
export function bandBoundaries(weights: readonly number[]): number[] {
  const n = BANDS;
  // Give every band a floor so none collapses, then distribute the rest by weight.
  const floors = new Array<number>(n).fill(0.5);
  const sizes = floors.map((floor, i) => floor + clamp01(weights[i] ?? 0));
  const total = sizes.reduce((s, v) => s + v, 0) || 1;
  const edges: number[] = [0];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += (sizes[i] ?? 0) / total;
    edges.push(clamp01(acc));
  }
  edges[n] = 1; // pin the final edge exactly to the bottom
  return edges;
}

function makeBandsLayer(): Layer {
  const bassS = new Smoother(FIELD_SMOOTHING, 0);
  // One heavily-smoothed weight per band, sampled from across the spectrum.
  const weightS: Smoother[] = [];
  const swell = new BeatSwell();

  return {
    id: "colorfield.bands",
    init(): void {
      bassS.reset(0);
      weightS.length = 0;
      for (let i = 0; i < BANDS; i++) weightS.push(new Smoother(FIELD_SMOOTHING, 0));
      swell.reset();
    },
    draw({ renderer, features, dt }: LayerFrame): void {
      const bass = bassS.push(band(features, "bass"));
      const swellAmt = swell.update(features.onset, dt);
      const lum = clamp01(mapFeature(easeInOutSine(bass), 0.45, 0.95) + swellAmt * 0.18);

      // Each band tracks a different slice of the raw spectrum, heavily smoothed.
      const weights = weightS.map((s, i) => {
        const idx = Math.floor(((i + 0.5) / BANDS) * features.bands.length);
        return s.push(bandAt(features, idx));
      });
      const edges = bandBoundaries(weights);

      const bg = mixColor(sample(palettes.ember, 0), { r: 0, g: 0, b: 0, a: 1 }, 0.3);
      renderer.beginFrame(bg);

      for (let b = 0; b < BANDS; b++) {
        const top = edges[b] ?? 0;
        const bottom = edges[b + 1] ?? 1;
        const height = Math.max(0, bottom - top);
        if (height <= 0) continue;
        // Color center for this band, walking the palette top→bottom.
        const center = sample(palettes.ember, (b + 0.5) / BANDS);
        const stripH = height / STRIPS_PER_BAND;
        for (let s = 0; s < STRIPS_PER_BAND; s++) {
          const localT = s / (STRIPS_PER_BAND - 1);
          // Soft seam: dim toward the band edges, brightest in the middle.
          const edgeFade = 1 - Math.abs(localT - 0.5) * 2 * 0.4;
          const glow = clamp01(lum * edgeFade);
          const color = mixColor({ r: 0, g: 0, b: 0, a: center.a }, center, glow);
          renderer.drawRect({
            x: 0,
            y: top + s * stripH,
            w: 1,
            h: stripH + 0.002,
            color,
          });
        }
      }

      renderer.endFrame();
    },
    dispose(): void {
      bassS.reset(0);
      weightS.length = 0;
      swell.reset();
    },
  };
}

/** The Bands preset definition. */
export const bandsPreset: PresetDefinition = composePreset({
  id: "colorfield.bands",
  name: "Bands",
  description:
    "Stacked luminous color-field bands with soft, gradient seams: the boundaries breathe with the smoothed spectrum, bass sets the glow, and beats add a slow decaying swell.",
  tags: ["colorfield", "gradient", "bands", "veil", "atmosphere"],
  layers: () => [makeBandsLayer()],
});
