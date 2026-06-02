/**
 * `washPreset` — a soft-horizon color wash: two luminous regions (a warmer top
 * and a cooler bottom) meeting at a slowly-drifting horizon, the whole thing
 * rendered as many thin horizontal strips sampled from a palette gradient. The
 * horizon rides (heavily smoothed) bass up and down; mid shifts the palette
 * hue; a beat sends a slow, decaying swell of brightness through the wash. This
 * is the "Soft Horizon" / "Wash" mood — slow and atmospheric, never jittery.
 * The name references technique/mood, not a person or trademark.
 *
 * Public-surface only: `band`, easing, palette `sample`/`mixColor`, `Smoother`,
 * and `Renderer.drawRect`. Deterministic given (features, time).
 */

import {
  band,
  clamp01,
  easeInOutSine,
  mapFeature,
  mixColor,
  palettes,
  sample,
  Smoother,
} from "@cymatic/core";
import { composePreset, type Layer, type LayerFrame, type PresetDefinition } from "@cymatic/core";

import { BeatSwell, FIELD_SMOOTHING, gradientStripCount } from "./common.js";

/** Number of horizontal strips the wash is rendered as. */
const STRIPS = gradientStripCount();

/**
 * Vertical position of the horizon (where the two regions meet), in `[0.2,
 * 0.8]`, from (smoothed) bass. Pure + exported so a test can assert louder bass
 * raises the horizon smoothly. Higher bass → horizon climbs (smaller y).
 */
export function horizonY(smoothedBass: number): number {
  // Invert: more bass → smaller y (higher on screen), eased so it glides.
  return mapFeature(easeInOutSine(smoothedBass), 0.7, 0.32);
}

function makeWashLayer(): Layer {
  const bassS = new Smoother(FIELD_SMOOTHING, 0);
  const midS = new Smoother(FIELD_SMOOTHING, 0);
  const swell = new BeatSwell();

  return {
    id: "colorfield.wash",
    init(): void {
      bassS.reset(0);
      midS.reset(0);
      swell.reset();
    },
    draw({ renderer, features, dt }: LayerFrame): void {
      const bass = bassS.push(band(features, "bass"));
      const mid = midS.push(band(features, "mid"));
      const swellAmt = swell.update(features.onset, dt);

      const horizon = horizonY(bass);
      // Mid slowly slides which slice of the palette the wash draws from, so the
      // hue breathes; the beat swell lifts overall luminance gently.
      const hueShift = mapFeature(mid, 0.0, 0.4);
      const lum = clamp01(0.55 + swellAmt * 0.25 + bass * 0.15);

      const bg = mixColor(sample(palettes.aqua, 0), { r: 0, g: 0, b: 0, a: 1 }, 0.4);
      renderer.beginFrame(bg);

      const stripH = 1 / STRIPS;
      for (let i = 0; i < STRIPS; i++) {
        const y = i * stripH;
        const center = y + stripH / 2;
        // Distance from the horizon, normalized per-half, gives a smooth ramp
        // that brightens toward the horizon line and fades to the edges.
        const span = center < horizon ? horizon : 1 - horizon;
        const dist = span > 0 ? clamp01(Math.abs(center - horizon) / span) : 1;
        // Top half samples the cool low end; bottom half the warm high end.
        const half = center < horizon ? 0.0 : 0.5;
        const sampleT = clamp01(half + hueShift + (1 - dist) * 0.25);
        const base = sample(palettes.aqua, sampleT);
        // Brightest at the horizon, dimming outward — a soft luminous seam.
        const glow = clamp01(lum * (1 - dist * 0.6));
        const color = mixColor({ r: 0, g: 0, b: 0, a: base.a }, base, glow);
        renderer.drawRect({ x: 0, y, w: 1, h: stripH + 0.002, color });
      }

      renderer.endFrame();
    },
    dispose(): void {
      bassS.reset(0);
      midS.reset(0);
      swell.reset();
    },
  };
}

/** The Wash preset definition. */
export const washPreset: PresetDefinition = composePreset({
  id: "colorfield.wash",
  name: "Soft Horizon",
  description:
    "A soft-horizon color wash: two luminous regions meet at a slowly-drifting seam that rides bass, the hue breathes with mid, and beats send a gentle decaying swell through the wash.",
  tags: ["colorfield", "gradient", "horizon", "atmosphere"],
  layers: () => [makeWashLayer()],
});
