/**
 * `washPreset` — a cinematic soft-horizon color wash (V2-11 rebuild).
 *
 * Two luminous regions (a cooler top and a warmer bottom, both sampled from the
 * director's crossfading palette) meet at a slowly-drifting horizon seam. The
 * horizon rides (heavily smoothed) bass + the director's intensity up and down;
 * the seam itself is a bright additive glow bar that swells gently on each beat;
 * brightness/centroid shift the airiness. Heavy bloom turns the seam into a
 * luminous band of light and a long feedback trail leaves a dreamy wake as the
 * horizon glides. Slow and atmospheric, never jittery.
 *
 * "Soft Horizon" references technique/mood, never a person or trademark. Public
 * `@cymatic/core` surface only (palette/director/easing + gradient/glow/blend/
 * post-FX primitives). Deterministic given `(features, director, time, seed)`.
 */

import {
  clamp01,
  easeInOutSine,
  mapFeature,
  mixColor,
  smoothBand,
  type BandSmoother,
} from "@cymatic/core";
import {
  composePreset,
  type Layer,
  type LayerFrame,
  type PresetDefinition,
} from "@cymatic/core";

import { BeatSwell, FIELD_SMOOTHING, colorfieldPostFx, directorColor, gradientStripCount, hot } from "./common.js";

/** Number of horizontal strips the wash is rendered as. */
const STRIPS = gradientStripCount();

const P = {
  spread: "gradientSpread",
  airiness: "airiness",
  bloom: "bloomAmount",
  trail: "trailDecay",
  hueDrift: "hueDrift",
  lumGain: "luminanceGain",
  glow: "seamGlow",
  swell: "beatSwell",
} as const;

/**
 * Vertical position of the horizon (where the two regions meet), in `[0.25,
 * 0.75]`, from (smoothed) bass and the director's intensity. Pure + exported so
 * a test can assert louder bass raises the horizon smoothly. Higher energy →
 * horizon climbs (smaller y).
 */
export function horizonY(smoothedBass: number, intensity = 0): number {
  // Invert: more energy → smaller y (higher on screen), eased so it glides.
  return mapFeature(easeInOutSine(clamp01(smoothedBass * 0.7 + intensity * 0.4)), 0.72, 0.3);
}

function makeWashLayer(): Layer {
  let bassS: BandSmoother | null = null;
  let midS: BandSmoother | null = null;
  const swell = new BeatSwell(0.7);

  return {
    id: "colorfield.wash",
    init(): void {
      bassS = smoothBand("bass", FIELD_SMOOTHING);
      midS = smoothBand("mid", FIELD_SMOOTHING);
      swell.reset();
    },
    draw({ renderer, features, director, params, dt }: LayerFrame): void {
      const bass = (bassS ?? smoothBand("bass", FIELD_SMOOTHING)).push(features);
      const mid = (midS ?? smoothBand("mid", FIELD_SMOOTHING)).push(features);
      const swellAmt = swell.update(features.onset, dt);

      const spread = clamp01(Number(params[P.spread] ?? 0.8));
      const airiness = clamp01(Number(params[P.airiness] ?? 0.55));
      const bloomAmt = clamp01(Number(params[P.bloom] ?? director.bloom));
      const trail = clamp01(Number(params[P.trail] ?? 0.84));
      const hueDrift = clamp01(Number(params[P.hueDrift] ?? 0.5));
      const lumGain = clamp01(Number(params[P.lumGain] ?? 0.7));
      const glowK = clamp01(Number(params[P.glow] ?? 0.75));
      const swellGain = clamp01(Number(params[P.swell] ?? 0.6));

      const intensity = clamp01(director.intensity);
      const horizon = horizonY(bass, intensity);
      // Mid + the hueDrift param slide which slice of the palette the wash draws
      // from, so the hue breathes; the beat swell + bass lift overall luminance.
      const hueShift = mapFeature(mid, 0.0, 0.4) * (0.5 + hueDrift);
      const lum = clamp01(0.45 + lumGain * 0.4 + swellAmt * swellGain * 0.25 + bass * 0.15);

      renderer.setPostEffects(colorfieldPostFx(bloomAmt, trail));

      const deep = directorColor(director, 0.04);
      renderer.beginFrame({ r: deep.r * 0.12, g: deep.g * 0.12, b: deep.b * 0.14, a: 1 });

      renderer.setBlendMode("alpha");
      const stripH = 1 / STRIPS;
      for (let i = 0; i < STRIPS; i++) {
        const y = i * stripH;
        const centerY = y + stripH / 2;
        // Distance from the horizon, normalized per-half, gives a smooth ramp
        // that brightens toward the seam and fades to the edges. `airiness`
        // widens the lit falloff so the wash reads more open.
        const span = centerY < horizon ? horizon : 1 - horizon;
        const dist = span > 0 ? clamp01(Math.abs(centerY - horizon) / span) : 1;
        // Top half samples the cool low palette end; bottom half the warm high.
        const half = centerY < horizon ? 0.0 : 0.5;
        const sampleT = clamp01((half + hueShift + (1 - dist) * 0.25) * spread + (1 - spread) * half);
        const base = directorColor(director, sampleT);
        // Brightest at the horizon, dimming outward — a soft luminous seam.
        const fade = 1 - dist * (0.65 - airiness * 0.3);
        const glow = clamp01(lum * fade);
        const color = mixColor({ r: 0, g: 0, b: 0, a: base.a }, base, glow);
        renderer.drawRect({ x: 0, y, w: 1, h: stripH + 0.003, color });
      }

      // A bright additive glow bar riding the horizon seam — the band of light
      // the wash blooms from. It swells gently on the beat.
      const seamCol = directorColor(director, clamp01(0.5 * spread + hueShift));
      renderer.drawGlow({
        x: 0.5,
        y: horizon,
        radius: 0.4 + airiness * 0.3 + swellAmt * swellGain * 0.12,
        color: hot(seamCol, 1),
        intensity: 0.4 + glowK * 0.85 + intensity * 0.6 + swellAmt * swellGain * 1.0,
      });

      renderer.endFrame();
    },
    dispose(): void {
      bassS = null;
      midS = null;
      swell.reset();
    },
  };
}

/** The Soft Horizon preset definition — rich param schema with audio/director bindings. */
export const washPreset: PresetDefinition = composePreset({
  id: "colorfield.wash",
  name: "Soft Horizon",
  description:
    "A soft-horizon color wash: two luminous regions meet at a slowly-drifting seam that rides bass and the song's energy, a bright glow bar swells gently on each beat, the hue breathes with mid, and heavy bloom + a long trail keep it dreamy as the color crossfades over the track.",
  tags: ["colorfield", "gradient", "horizon", "atmosphere", "cinematic"],
  params: [
    { key: P.spread, label: "Gradient spread", group: "Color", type: "number", min: 0, max: 1, step: 0.01, default: 0.8 },
    { key: P.hueDrift, label: "Hue drift", group: "Color", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: P.airiness, label: "Airiness", group: "Field", type: "number", min: 0, max: 1, step: 0.01, default: 0.55 },
    { key: P.lumGain, label: "Luminance gain", group: "Field", type: "number", min: 0, max: 1, step: 0.01, default: 0.7 },
    { key: P.glow, label: "Seam glow", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.75 },
    { key: P.bloom, label: "Bloom amount", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: P.trail, label: "Trail decay", group: "Light", type: "number", min: 0, max: 0.98, step: 0.01, default: 0.84 },
    { key: P.swell, label: "Beat swell", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.6 },
  ],
  bindings: {
    [P.lumGain]: { source: "director", path: "intensity", outMin: 0.4, outMax: 1, smoothing: 0.85 },
    [P.bloom]: { source: "director", path: "bloom", smoothing: 0.8 },
    [P.glow]: { source: "director", path: "intensity", outMin: 0.5, outMax: 1, smoothing: 0.8 },
    [P.swell]: { source: "audio", path: "bass", outMin: 0.4, outMax: 1, smoothing: 0.8 },
    [P.hueDrift]: { source: "audio", path: "mid", outMin: 0.3, outMax: 0.9, smoothing: 0.85 },
    [P.airiness]: { source: "director", path: "motion", inMin: 0.5, inMax: 1.8, outMin: 0.35, outMax: 0.8, smoothing: 0.85 },
  },
  layers: () => [makeWashLayer()],
});
