/**
 * `fieldPreset` — a single luminous vertical color field in the color-field /
 * Rothko-adjacent tradition: a smooth top→bottom gradient rendered as many thin
 * horizontal strips, sampled from a palette. The whole field breathes slowly —
 * its luminance rises with (heavily smoothed) bass and its hue/position drifts
 * with mid/treble — so the motion is a slow atmosphere, never a jitter. A beat
 * adds a gentle, decaying swell rather than a hard flash. "Field" references the
 * technique/mood, not a person or trademark.
 *
 * Public-surface only: `band`, easing, palette `sample`/`mixColor`, `Smoother`,
 * and `Renderer.drawRect` (the gradient is N stacked strips). Deterministic
 * given (features, time).
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

/** Number of horizontal strips the vertical gradient is rendered as. */
const STRIPS = gradientStripCount();

/**
 * Overall field luminance from (smoothed) bass plus a decaying beat swell. Pure
 * + exported so a test can assert louder bass and an active swell both brighten
 * the field, smoothly. Output is a multiplier in roughly `[0.45, 1.15]`.
 */
export function fieldLuminance(smoothedBass: number, swell: number): number {
  const base = mapFeature(easeInOutSine(smoothedBass), 0.45, 1.0);
  return base + swell * 0.15;
}

function makeFieldLayer(): Layer {
  // Heavy smoothing: the field changes over many frames, not one.
  const bassS = new Smoother(FIELD_SMOOTHING, 0);
  const trebleS = new Smoother(FIELD_SMOOTHING, 0);
  const swell = new BeatSwell();

  return {
    id: "colorfield.field",
    init(): void {
      bassS.reset(0);
      trebleS.reset(0);
      swell.reset();
    },
    draw({ renderer, features, dt }: LayerFrame): void {
      const bass = bassS.push(band(features, "bass"));
      const treble = trebleS.push(band(features, "treble"));
      const swellAmt = swell.update(features.onset, dt);
      const lum = fieldLuminance(bass, swellAmt);

      // The gradient window slides slightly with treble so the luminous center
      // drifts up/down very slowly. Heavily smoothed → slow, breathing motion.
      const drift = mapFeature(treble, -0.12, 0.12);

      // Background: the palette's deep end, dimmed — the field floats on near-dark.
      const bg = mixColor(sample(palettes.sunset, 0), { r: 0, g: 0, b: 0, a: 1 }, 0.35);
      renderer.beginFrame(bg);

      const stripH = 1 / STRIPS;
      for (let i = 0; i < STRIPS; i++) {
        const t = i / (STRIPS - 1);
        // Sample the palette across the strip's vertical position, shifted by drift.
        const sampleT = clamp01(t + drift);
        const base = sample(palettes.sunset, sampleT);
        // Apply the luminance multiplier toward/away from black for a glow that
        // swells with energy without changing hue.
        const color = mixColor({ r: 0, g: 0, b: 0, a: base.a }, base, clamp01(lum));
        renderer.drawRect({ x: 0, y: i * stripH, w: 1, h: stripH + 0.002, color });
      }

      renderer.endFrame();
    },
    dispose(): void {
      bassS.reset(0);
      trebleS.reset(0);
      swell.reset();
    },
  };
}

/** The Field preset definition. */
export const fieldPreset: PresetDefinition = composePreset({
  id: "colorfield.field",
  name: "Field",
  description:
    "A single luminous vertical color field rendered as stacked strips: it brightens slowly with bass, drifts with treble, and swells gently on each beat.",
  tags: ["colorfield", "gradient", "atmosphere", "luminous"],
  layers: () => [makeFieldLayer()],
});
