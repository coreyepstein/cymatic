/**
 * `bandsPreset` — cinematic stacked luminous bands (V2-11 rebuild).
 *
 * A few broad horizontal color regions (the "Bands"/"Veil" mood) whose
 * boundaries breathe with the (heavily smoothed) audio spectrum and whose colors
 * are sampled from the director's crossfading palette + slow hue rotation. Each
 * band is a soft vertical gradient (a `drawGradientRect`) so the seams between
 * bands are luminous rather than hard, and each band carries a soft additive
 * glow core that swells on the beat. Bass + the director's intensity set the
 * overall luminance, the per-band spectrum nudges each boundary, the band count
 * is a param, and heavy bloom + a long feedback trail keep the whole veil dreamy
 * and slowly breathing.
 *
 * "Bands" references technique/mood, never a person or trademark. Public
 * `@cymatic/core` surface only (palette/director/easing + gradient/glow/blend/
 * post-FX primitives). Deterministic given `(features, director, time, seed)`.
 */

import {
  bandAt,
  clamp01,
  easeInOutSine,
  mapFeature,
  mixColor,
  smoothBand,
  Smoother,
  withAlpha,
  type BandSmoother,
} from "@cymatic/core";
import {
  composePreset,
  type Layer,
  type LayerFrame,
  type PresetDefinition,
} from "@cymatic/core";

import { BeatSwell, FIELD_SMOOTHING, colorfieldPostFx, directorColor, hot } from "./common.js";

/** Band-count steps the `bandCount` param maps onto. */
const BAND_STEPS: readonly number[] = [3, 4, 5, 6, 7];
/** The maximum band count (sizes the per-band weight smoother pool). */
const MAX_BANDS = BAND_STEPS[BAND_STEPS.length - 1] ?? 7;

/** Resolve a `[0,1]`-ish param into a concrete band count. Pure + exported. */
export function bandResolution(amount: number): number {
  const n = BAND_STEPS.length;
  const i = Math.min(n - 1, Math.max(0, Math.round(clamp01(amount) * (n - 1))));
  return BAND_STEPS[i] ?? 4;
}

/**
 * Resolve the `count+1` boundary positions (in `[0, 1]`, monotonic, spanning the
 * full height) from a set of (smoothed) per-band weights. Pure + exported so a
 * test can assert that shifting weight toward one band measurably grows its
 * region. Heavier weight on a band → that band claims more height.
 */
export function bandBoundaries(weights: readonly number[]): number[] {
  const n = Math.max(1, weights.length);
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

const P = {
  count: "bandCount",
  spread: "gradientSpread",
  softness: "seamSoftness",
  bloom: "bloomAmount",
  trail: "trailDecay",
  hueDrift: "hueDrift",
  lumGain: "luminanceGain",
  glow: "glowIntensity",
  swell: "beatSwell",
} as const;

function makeBandsLayer(): Layer {
  let bassS: BandSmoother | null = null;
  // One heavily-smoothed weight per band slot, sampled from across the spectrum.
  const weightS: Smoother[] = [];
  const swell = new BeatSwell(0.7);

  return {
    id: "colorfield.bands",
    init(): void {
      bassS = smoothBand("bass", FIELD_SMOOTHING);
      weightS.length = 0;
      for (let i = 0; i < MAX_BANDS; i++) weightS.push(new Smoother(FIELD_SMOOTHING, 0));
      swell.reset();
    },
    draw({ renderer, features, director, params, dt }: LayerFrame): void {
      const bass = (bassS ?? smoothBand("bass", FIELD_SMOOTHING)).push(features);
      const swellAmt = swell.update(features.onset, dt);

      const bands = bandResolution(Number(params[P.count] ?? 0.5));
      const spread = clamp01(Number(params[P.spread] ?? 0.85));
      const softness = clamp01(Number(params[P.softness] ?? 0.6));
      const bloomAmt = clamp01(Number(params[P.bloom] ?? director.bloom));
      const trail = clamp01(Number(params[P.trail] ?? 0.82));
      const hueDrift = clamp01(Number(params[P.hueDrift] ?? 0.5));
      const lumGain = clamp01(Number(params[P.lumGain] ?? 0.7));
      const glowK = clamp01(Number(params[P.glow] ?? 0.7));
      const swellGain = clamp01(Number(params[P.swell] ?? 0.6));

      const intensity = clamp01(director.intensity);
      const lum = clamp01(
        mapFeature(easeInOutSine(clamp01(bass * 0.7 + intensity * 0.5)), 0.4, 1.0) * (0.6 + lumGain) +
          swellAmt * swellGain * 0.18,
      );

      // Each band slot tracks a different slice of the raw spectrum, heavily
      // smoothed (only the active `bands` count is consumed).
      const weights: number[] = [];
      for (let i = 0; i < bands; i++) {
        const idx = Math.floor(((i + 0.5) / bands) * features.bands.length);
        const s = weightS[i] ?? new Smoother(FIELD_SMOOTHING, 0);
        weights.push(s.push(bandAt(features, idx)));
      }
      const edges = bandBoundaries(weights);

      renderer.setPostEffects(colorfieldPostFx(bloomAmt, trail));

      const deep = directorColor(director, 0.04);
      renderer.beginFrame({ r: deep.r * 0.12, g: deep.g * 0.12, b: deep.b * 0.14, a: 1 });

      renderer.setBlendMode("alpha");
      const hueShift = hueDrift * 0.25;
      for (let b = 0; b < bands; b++) {
        const top = edges[b] ?? 0;
        const bottom = edges[b + 1] ?? 1;
        const height = Math.max(0, bottom - top);
        if (height <= 0) continue;
        // Walk the palette top→bottom; `spread` controls how much of the palette
        // the stack of bands traverses (color variety).
        const tBand = (b + 0.5) / bands;
        const sampleT = clamp01(tBand * spread + (1 - spread) * 0.5 + hueShift);
        const colTop = directorColor(director, clamp01(sampleT - 0.04 * spread));
        const colBot = directorColor(director, clamp01(sampleT + 0.04 * spread));
        // Soft seam: brighten toward the band middle, dim toward its edges, with
        // `softness` widening the lit core.
        const edgeFade = 1 - (1 - softness) * 0.45;
        const glow = clamp01(lum * edgeFade);
        const litTop = mixColor({ r: 0, g: 0, b: 0, a: colTop.a }, colTop, glow);
        const litBot = mixColor({ r: 0, g: 0, b: 0, a: colBot.a }, colBot, glow);
        renderer.drawGradientRect(
          { x: 0, y: top, w: 1, h: height + 0.003, color: litTop },
          { from: withAlpha(litTop, litTop.a), to: litBot, angle: Math.PI / 2 },
        );

        // A soft glow core in the band center — the light each band blooms from.
        const cy = top + height / 2;
        const coreCol = directorColor(director, sampleT);
        renderer.drawGlow({
          x: 0.5,
          y: cy,
          radius: Math.max(0.06, height * (0.45 + softness * 0.35)),
          color: hot(coreCol, 1),
          intensity: 0.35 + glowK * 0.75 + intensity * 0.5 + swellAmt * swellGain * 0.9,
        });
      }

      renderer.endFrame();
    },
    dispose(): void {
      bassS = null;
      weightS.length = 0;
      swell.reset();
    },
  };
}

/** The Bands preset definition — rich param schema with audio/director bindings. */
export const bandsPreset: PresetDefinition = composePreset({
  id: "colorfield.bands",
  name: "Bands",
  description:
    "Stacked luminous color-field bands with soft gradient seams and glowing cores: the boundaries breathe with the smoothed spectrum, bass and the song's energy set the glow, beats add a slow swell, and heavy bloom + a long trail keep the veil dreamy as the color crossfades over the track.",
  tags: ["colorfield", "gradient", "bands", "veil", "atmosphere", "cinematic"],
  params: [
    { key: P.count, label: "Band count", group: "Field", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: P.softness, label: "Seam softness", group: "Field", type: "number", min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: P.lumGain, label: "Luminance gain", group: "Field", type: "number", min: 0, max: 1, step: 0.01, default: 0.7 },
    { key: P.spread, label: "Gradient spread", group: "Color", type: "number", min: 0, max: 1, step: 0.01, default: 0.85 },
    { key: P.hueDrift, label: "Hue drift", group: "Color", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: P.glow, label: "Glow intensity", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.7 },
    { key: P.bloom, label: "Bloom amount", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: P.trail, label: "Trail decay", group: "Light", type: "number", min: 0, max: 0.98, step: 0.01, default: 0.82 },
    { key: P.swell, label: "Beat swell", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.6 },
  ],
  bindings: {
    [P.lumGain]: { source: "director", path: "intensity", outMin: 0.4, outMax: 1, smoothing: 0.85 },
    [P.bloom]: { source: "director", path: "bloom", smoothing: 0.8 },
    [P.glow]: { source: "director", path: "intensity", outMin: 0.45, outMax: 1, smoothing: 0.8 },
    [P.swell]: { source: "audio", path: "bass", outMin: 0.4, outMax: 1, smoothing: 0.8 },
    [P.count]: { source: "director", path: "density", inMin: 0.5, inMax: 1.6, smoothing: 0.85 },
    [P.hueDrift]: { source: "audio", path: "mid", outMin: 0.3, outMax: 0.9, smoothing: 0.85 },
  },
  layers: () => [makeBandsLayer()],
});
