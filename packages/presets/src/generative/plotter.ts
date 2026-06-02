/**
 * `plotterPreset` — "Plotter". A deterministic algorithmic pen path that
 * accumulates over time, drawn as a trail of short rect segments — the look of a
 * pen plotter slowly inking a figure. The pen walks a Lissajous-like curve whose
 * frequencies and rotation are fixed per instance (seeded), and audio modulates
 * how the ink lays down: bass sets the segment density (steps drawn per frame),
 * treble nudges the rotation, and a beat briefly thickens the line. A bounded
 * ring buffer of recent segments keeps the trail readable and the cost flat.
 * "Plotter" names the technique, not a person or trademark.
 *
 * Public-surface only: `band`, `mapFeature`, easing/`Smoother`, palette
 * `sample`/`mixColor`, and `Renderer.drawRect`. A seeded PRNG ({@link
 * mulberry32}) fixes the curve's parameters so the figure is reproducible.
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

import { DEFAULT_SEED, mulberry32 } from "./common.js";

/** How many recent pen segments stay on screen (the inked trail length). */
export const TRAIL = 600;
/** Base segment size; the beat thickens it. */
const SEG = 0.0045;
/** Smoothing for the audio-driven density/rotation. */
const PARAM_SMOOTHING = 0.8;

interface Seg {
  x: number;
  y: number;
  /** Color sampled when the segment was laid down. */
  r: number;
  g: number;
  b: number;
  /** Half-size of the segment rect. */
  s: number;
}

/**
 * Pen steps to advance this frame from (smoothed) bass. Pure + exported so a
 * test can assert louder bass lays ink down faster (denser figure).
 */
export function plotterDensity(smoothedBass: number): number {
  return Math.max(1, Math.round(mapFeature(easeInOutSine(smoothedBass), 1, 6)));
}

/** The two curve frequencies + phase a seed fixes, giving each instance a figure. */
export function plotterCurve(seed: number): { fx: number; fy: number; phase: number } {
  const rng = mulberry32(seed);
  // Small integer-ish ratios produce closed, plotter-like figures.
  const fx = 2 + Math.floor(rng() * 4);
  const fy = 3 + Math.floor(rng() * 4);
  const phase = rng() * Math.PI * 2;
  return { fx, fy, phase };
}

function makePlotterLayer(seed: number): Layer {
  const { fx, fy, phase } = plotterCurve(seed);
  const trail: Seg[] = [];
  let head = 0;
  let theta = 0;
  let rotation = 0;
  const bassS = new Smoother(PARAM_SMOOTHING, 0);
  const trebleS = new Smoother(PARAM_SMOOTHING, 0);
  let burst = 0;

  function penAt(t: number, rot: number): { x: number; y: number } {
    // Lissajous in centered coords, then rotate and map into [0,1].
    const cx = Math.sin(fx * t + phase);
    const cy = Math.sin(fy * t);
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const rx = cx * cos - cy * sin;
    const ry = cx * sin + cy * cos;
    return { x: 0.5 + rx * 0.42, y: 0.5 + ry * 0.42 };
  }

  return {
    id: "generative.plotter",
    init(): void {
      trail.length = 0;
      head = 0;
      theta = 0;
      rotation = 0;
      burst = 0;
      bassS.reset(0);
      trebleS.reset(0);
    },
    draw({ renderer, features, dt }: LayerFrame): void {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
      const bass = bassS.push(band(features, "bass"));
      const treble = trebleS.push(band(features, "treble"));
      const decay = Math.pow(0.5, step / 0.4);
      burst = features.onset ? clamp01(burst * decay + 0.8) : clamp01(burst * decay);

      // Treble slowly rotates the whole figure; bass sets ink density.
      rotation += mapFeature(treble, 0.0, 0.6) * step;
      const density = plotterDensity(bass);
      const segSize = SEG * (1 + burst * 1.2);

      for (let i = 0; i < density; i++) {
        theta += 0.03;
        const p = penAt(theta, rotation);
        // Color advances along the palette with the pen's progress.
        const base = sample(palettes.sunset, (theta * 0.05) % 1);
        const seg: Seg = { x: p.x, y: p.y, r: base.r, g: base.g, b: base.b, s: segSize / 2 };
        if (trail.length < TRAIL) {
          trail.push(seg);
        } else {
          trail[head] = seg;
          head = (head + 1) % TRAIL;
        }
      }

      renderer.beginFrame(mixColor(sample(palettes.sunset, 0), { r: 0, g: 0, b: 0, a: 1 }, 0.6));

      // Older segments fade out; the newest ink is brightest.
      const count = trail.length;
      for (let k = 0; k < count; k++) {
        // Walk oldest→newest so age is well-defined for the fade.
        const i = trail.length < TRAIL ? k : (head + k) % TRAIL;
        const seg = trail[i]!;
        const age = k / Math.max(1, count - 1); // 0 oldest … 1 newest
        const alpha = clamp01(0.15 + age * 0.85);
        const color = mixColor(
          { r: 0, g: 0, b: 0, a: 1 },
          { r: seg.r, g: seg.g, b: seg.b, a: 1 },
          alpha,
        );
        renderer.drawRect({ x: seg.x - seg.s, y: seg.y - seg.s, w: seg.s * 2, h: seg.s * 2, color });
      }

      renderer.endFrame();
    },
    dispose(): void {
      trail.length = 0;
      head = 0;
      theta = 0;
      rotation = 0;
      burst = 0;
      bassS.reset(0);
      trebleS.reset(0);
    },
  };
}

/** The Plotter preset definition. */
export const plotterPreset: PresetDefinition = composePreset({
  id: "generative.plotter",
  name: "Plotter",
  description:
    "A deterministic pen path accumulating as a trail of short rect segments — a plotter slowly inking a figure: bass sets ink density, treble rotates the figure, and a beat thickens the line.",
  tags: ["generative", "plotter", "pen-art", "algorithmic"],
  layers: () => [makePlotterLayer(DEFAULT_SEED)],
});

/** Build a Plotter definition with an explicit seed (used by tests). */
export function plotterPresetWithSeed(seed: number): PresetDefinition {
  return composePreset({
    id: `generative.plotter.${seed}`,
    name: "Plotter",
    description: plotterPreset.description,
    tags: plotterPreset.tags,
    layers: () => [makePlotterLayer(seed)],
  });
}
