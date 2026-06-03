/**
 * `fieldPreset` — a cinematic luminous color field (V2-11 rebuild).
 *
 * A single dreamy vertical color atmosphere: a smooth top→bottom gradient
 * rendered as stacked `drawGradientRect` strips whose colors are sampled from
 * the auto-director's crossfading palette + slow hue rotation, lit from within
 * by a big soft additive glow core. The whole field BREATHES — its luminance
 * and the glow scale rise with (heavily smoothed) bass + the director's
 * intensity, the luminous center drifts with brightness/centroid, and a beat
 * adds a gentle, exponentially-decaying swell rather than a hard flash. Heavy
 * bloom + a long feedback trail turn it into a slow, luminous haze.
 *
 * "Field" references the technique/mood, never a person or trademark. Built only
 * on the public `@cymatic/core` surface (palette/director/easing + gradient/
 * glow/blend/post-FX primitives). Deterministic given `(features, director,
 * time, seed)`.
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

/** Number of horizontal strips the vertical gradient is rendered as. */
const STRIPS = gradientStripCount();

const P = {
  spread: "gradientSpread",
  softness: "fieldSoftness",
  bloom: "bloomAmount",
  trail: "trailDecay",
  hueDrift: "hueDrift",
  lumGain: "luminanceGain",
  glow: "glowIntensity",
  swell: "beatSwell",
} as const;

/**
 * Overall field luminance from (smoothed) bass, the director's intensity, a
 * `luminanceGain` param, and a decaying beat swell. Pure + exported so a test
 * can assert louder bass and an active swell both brighten the field, smoothly.
 * Output is a multiplier in roughly `[0.3, 1.4]`.
 */
export function fieldLuminance(smoothedBass: number, intensity: number, swell: number, gain = 1): number {
  const base = mapFeature(easeInOutSine(clamp01(smoothedBass * 0.7 + intensity * 0.5)), 0.32, 1.05);
  return clamp01(base * (0.6 + clamp01(gain))) + swell * 0.18;
}

function makeFieldLayer(): Layer {
  // Heavy smoothing: the field changes over many frames, not one.
  let bassS: BandSmoother | null = null;
  let trebleS: BandSmoother | null = null;
  const swell = new BeatSwell(0.7);

  return {
    id: "colorfield.field",
    init(): void {
      bassS = smoothBand("bass", FIELD_SMOOTHING);
      trebleS = smoothBand("treble", FIELD_SMOOTHING);
      swell.reset();
    },
    draw({ renderer, features, director, params, dt }: LayerFrame): void {
      const bass = (bassS ?? smoothBand("bass", FIELD_SMOOTHING)).push(features);
      const treble = (trebleS ?? smoothBand("treble", FIELD_SMOOTHING)).push(features);
      const swellAmt = swell.update(features.onset, dt);

      const spread = clamp01(Number(params[P.spread] ?? 0.85));
      const softness = clamp01(Number(params[P.softness] ?? 0.6));
      const bloomAmt = clamp01(Number(params[P.bloom] ?? director.bloom));
      const trail = clamp01(Number(params[P.trail] ?? 0.82));
      const hueDrift = clamp01(Number(params[P.hueDrift] ?? 0.5));
      const lumGain = clamp01(Number(params[P.lumGain] ?? 0.7));
      const glowK = clamp01(Number(params[P.glow] ?? 0.7));
      const swellGain = clamp01(Number(params[P.swell] ?? 0.6));

      const intensity = clamp01(director.intensity);
      const lum = fieldLuminance(bass, intensity, swellAmt * swellGain, lumGain);

      // Heavy bloom + long feedback: the dreamy luminous haze.
      renderer.setPostEffects(colorfieldPostFx(bloomAmt, trail));

      // The luminous center drifts up/down very slowly with treble; the palette
      // window the field samples from drifts with the hueDrift param so the hue
      // breathes. Heavily smoothed → slow, breathing motion (never a jitter).
      const drift = mapFeature(treble, -0.1, 0.1) * (0.5 + hueDrift);
      const center = clamp01(0.5 + drift);

      // Background: the director's deep palette end, dimmed — the field floats on
      // a near-dark color that itself evolves with the song.
      const deep = directorColor(director, 0.04);
      renderer.beginFrame({ r: deep.r * 0.12, g: deep.g * 0.12, b: deep.b * 0.14, a: 1 });

      // Stacked gradient strips. Each strip is a small vertical ramp toward its
      // neighbour so the seams are luminous, not stepped. `spread` controls how
      // far across the palette the field reaches (color variety).
      renderer.setBlendMode("alpha");
      const stripH = 1 / STRIPS;
      for (let i = 0; i < STRIPS; i++) {
        const t = i / (STRIPS - 1);
        const sampleT = clamp01((t + drift) * spread + (1 - spread) * 0.5);
        const colTop = directorColor(director, sampleT);
        const colBot = directorColor(director, clamp01(sampleT + stripH * spread));
        // Brighten toward the luminous center, fading to the edges — a soft glow
        // that swells with energy. `softness` widens the lit region.
        const dist = clamp01(Math.abs(t - center) / (0.5 + softness * 0.5));
        const glow = clamp01(lum * (1 - dist * (0.7 - softness * 0.3)));
        const litTop = mixColor({ r: 0, g: 0, b: 0, a: colTop.a }, colTop, glow);
        const litBot = mixColor({ r: 0, g: 0, b: 0, a: colBot.a }, colBot, glow);
        renderer.drawGradientRect(
          { x: 0, y: i * stripH, w: 1, h: stripH + 0.003, color: litTop },
          { from: litTop, to: litBot, angle: Math.PI / 2 },
        );
      }

      // A big, soft additive glow core anchored at the luminous center — this is
      // the light the field blooms from. Intensity rises with energy + the swell.
      const coreCol = directorColor(director, clamp01(center * spread));
      renderer.drawGlow({
        x: 0.5,
        y: center,
        radius: 0.35 + softness * 0.35 + lum * 0.15,
        color: hot(coreCol, 1),
        intensity: 0.4 + glowK * 0.8 + intensity * 0.6 + swellAmt * swellGain * 1.0,
      });

      renderer.endFrame();
    },
    dispose(): void {
      bassS = null;
      trebleS = null;
      swell.reset();
    },
  };
}

/** The Field preset definition — rich param schema with audio/director bindings. */
export const fieldPreset: PresetDefinition = composePreset({
  id: "colorfield.field",
  name: "Field",
  description:
    "A single luminous color field that breathes: a gradient atmosphere lit by a soft glow core, brightening with bass and the song's energy, drifting with brightness, blooming on each gentle beat swell as the color crossfades over the track.",
  tags: ["colorfield", "gradient", "atmosphere", "luminous", "cinematic"],
  params: [
    { key: P.spread, label: "Gradient spread", group: "Color", type: "number", min: 0, max: 1, step: 0.01, default: 0.85 },
    { key: P.hueDrift, label: "Hue drift", group: "Color", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: P.softness, label: "Field softness", group: "Field", type: "number", min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: P.lumGain, label: "Luminance gain", group: "Field", type: "number", min: 0, max: 1, step: 0.01, default: 0.7 },
    { key: P.glow, label: "Glow intensity", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.7 },
    { key: P.bloom, label: "Bloom amount", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: P.trail, label: "Trail decay", group: "Light", type: "number", min: 0, max: 0.98, step: 0.01, default: 0.82 },
    { key: P.swell, label: "Beat swell", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.6 },
  ],
  bindings: {
    // Luminance gain follows the song's intensity; bloom follows the director's
    // bloom; the beat swell rides bass so louder mixes swell harder. All heavily
    // smoothed so the field breathes rather than snaps.
    [P.lumGain]: { source: "director", path: "intensity", outMin: 0.4, outMax: 1, smoothing: 0.85 },
    [P.bloom]: { source: "director", path: "bloom", smoothing: 0.8 },
    [P.glow]: { source: "director", path: "intensity", outMin: 0.45, outMax: 1, smoothing: 0.8 },
    [P.swell]: { source: "audio", path: "bass", outMin: 0.4, outMax: 1, smoothing: 0.8 },
    [P.hueDrift]: { source: "audio", path: "treble", outMin: 0.3, outMax: 0.9, smoothing: 0.85 },
  },
  layers: () => [makeFieldLayer()],
});
