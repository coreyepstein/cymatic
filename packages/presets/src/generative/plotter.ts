/**
 * `plotterPreset` — "Plotter" (V2-12 cinematic rebuild).
 *
 * A penplot-style figure inked as GLOWING ADDITIVE LINES: a pen walks a
 * Lissajous-like curve (frequencies + phase fixed per seed) and each step lays
 * down a `drawLine` segment in additive blend, so the figure accumulates as a
 * luminous wire whose recent strokes are brightest and older ones fade. A long
 * feedback trail + bloom turn the inked path into glowing ribbons. Audio +
 * director drive how the ink lays down: treble + the director's density set the
 * segment density (strokes per frame), treble nudges the figure's rotation, the
 * director's motion sets jitter (organic wobble), and a beat thickens + brightens
 * the line via a decaying swell. Color crossfades over a track via the director's
 * palette + hue rotation.
 *
 * Determinism: a seeded PRNG ({@link mulberry32}) fixes the curve, folded with
 * the director's per-section seed via {@link sectionSeed} so each section inks a
 * fresh figure — never `Math.random` / `Date.now`. "Plotter" names the
 * technique. Public `@cymatic/core` surface only (no raw GL/GPU).
 */

import {
  clamp01,
  easeInOutSine,
  mapFeature,
  smoothBand,
  type BandSmoother,
} from "@cymatic/core";
import { composePreset, type Layer, type LayerFrame, type PresetDefinition } from "@cymatic/core";

import {
  BeatSwell,
  DEFAULT_SEED,
  directorColor,
  generativePostFx,
  hot,
  mulberry32,
  sectionSeed,
} from "./common.js";

/** How many recent pen segments stay on screen (the inked, fading trail length). */
export const TRAIL = 520;
/** Base stroke width; the beat swell thickens it. */
const STROKE = 0.0035;
/** Smoothing for the audio-driven density/rotation. */
const PARAM_SMOOTHING = 0.8;

const P = {
  lineDensity: "lineDensity",
  glow: "glowIntensity",
  jitter: "jitter",
  trail: "trailDecay",
  bloom: "bloomAmount",
  hueDrift: "hueDrift",
  swell: "beatSwell",
} as const;

interface Seg {
  /** Segment endpoints in normalized space. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Palette position the segment was inked at. */
  t: number;
  /** Stroke width when laid down. */
  w: number;
}

/**
 * Pen steps to advance this frame from (smoothed) treble and the director's
 * density. Pure + exported so a test can assert higher treble / density inks
 * faster (a denser figure).
 */
export function plotterDensity(smoothedTreble: number, density: number): number {
  const drive = clamp01(smoothedTreble * 0.7 + clamp01(density / 1.6) * 0.5);
  return Math.max(1, Math.round(mapFeature(easeInOutSine(drive), 1, 7)));
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

function makePlotterLayer(baseSeed: number): Layer {
  const trail: Seg[] = [];
  let head = 0;
  let theta = 0;
  let rotation = 0;
  let prevX = 0.5;
  let prevY = 0.5;
  let bassS: BandSmoother | null = null;
  let trebleS: BandSmoother | null = null;
  const swell = new BeatSwell(0.4);
  let activeSeed = baseSeed;
  let curve = plotterCurve(baseSeed);
  // Per-step deterministic jitter stream, seeded with the figure.
  let jitterRng = mulberry32(baseSeed);

  function penAt(t: number, rot: number): { x: number; y: number } {
    const cx = Math.sin(curve.fx * t + curve.phase);
    const cy = Math.sin(curve.fy * t);
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const rx = cx * cos - cy * sin;
    const ry = cx * sin + cy * cos;
    return { x: 0.5 + rx * 0.42, y: 0.5 + ry * 0.42 };
  }

  function reseed(seed: number): void {
    activeSeed = seed;
    curve = plotterCurve(seed);
    jitterRng = mulberry32(seed);
    trail.length = 0;
    head = 0;
    theta = 0;
    rotation = 0;
    const start = penAt(0, 0);
    prevX = start.x;
    prevY = start.y;
  }

  return {
    id: "generative.plotter",
    init(): void {
      bassS = smoothBand("bass", PARAM_SMOOTHING);
      trebleS = smoothBand("treble", PARAM_SMOOTHING);
      swell.reset();
      reseed(sectionSeed(baseSeed, 0));
    },
    draw({ renderer, features, director, params, dt }: LayerFrame): void {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
      void (bassS ?? smoothBand("bass", PARAM_SMOOTHING)).push(features);
      const treble = (trebleS ?? smoothBand("treble", PARAM_SMOOTHING)).push(features);
      const swellAmt = swell.update(features.onset, step);

      const glowK = clamp01(Number(params[P.glow] ?? 0.7));
      const trailDecay = clamp01(Number(params[P.trail] ?? 0.88));
      const bloomAmt = clamp01(Number(params[P.bloom] ?? director.bloom));
      const hueDrift = clamp01(Number(params[P.hueDrift] ?? 0.5));
      const jitterK = clamp01(Number(params[P.jitter] ?? 0.4));
      const swellGain = clamp01(Number(params[P.swell] ?? 0.6));
      const lineDensityParam = clamp01(Number(params[P.lineDensity] ?? 0.6));

      // Per-section reseed: a fresh director seed inks a fresh figure.
      const wantSeed = sectionSeed(baseSeed, director.seed);
      if (wantSeed !== activeSeed) reseed(wantSeed);

      // Treble + the director's motion slowly rotate the figure; treble + density
      // + the param set ink density; the swell thickens the stroke.
      rotation += mapFeature(treble, 0.0, 0.6) * (0.5 + director.motion * 0.5) * step;
      const density = plotterDensity(treble * (0.5 + lineDensityParam), director.density);
      const jitterAmt = jitterK * (0.3 + director.motion * 0.4) * 0.02;
      const strokeW = STROKE * (1 + swellAmt * swellGain * 1.6 + glowK * 0.5);

      for (let i = 0; i < density; i++) {
        theta += 0.03;
        const p = penAt(theta, rotation);
        // Organic jitter (deterministic) so the line wobbles like a real pen.
        const jx = (jitterRng() - 0.5) * jitterAmt;
        const jy = (jitterRng() - 0.5) * jitterAmt;
        const x = clamp01(p.x + jx);
        const y = clamp01(p.y + jy);
        const t = clamp01((theta * 0.05 * (0.5 + hueDrift)) % 1);
        const seg: Seg = { x0: prevX, y0: prevY, x1: x, y1: y, t, w: strokeW };
        if (trail.length < TRAIL) {
          trail.push(seg);
        } else {
          trail[head] = seg;
          head = (head + 1) % TRAIL;
        }
        prevX = x;
        prevY = y;
      }

      // Cinematic post-FX: bloom + long feedback → glowing inked ribbons.
      renderer.setPostEffects(generativePostFx(bloomAmt, trailDecay));

      const voidColor = directorColor(director, 0.04);
      renderer.beginFrame({ r: voidColor.r * 0.1, g: voidColor.g * 0.1, b: voidColor.b * 0.12, a: 1 });

      // Additive glowing lines: the newest ink is brightest, older strokes fade.
      renderer.setBlendMode("additive");
      const intensity = clamp01(director.intensity + treble * 0.3);
      const count = trail.length;
      for (let k = 0; k < count; k++) {
        const i = trail.length < TRAIL ? k : (head + k) % TRAIL;
        const seg = trail[i]!;
        const age = k / Math.max(1, count - 1); // 0 oldest … 1 newest
        const col = directorColor(director, seg.t);
        const gain = (0.3 + age * 0.7) * (0.6 + glowK * 1.2 + intensity * 0.8 + swellAmt * swellGain * 1.2);
        renderer.drawLine({
          x0: seg.x0,
          y0: seg.y0,
          x1: seg.x1,
          y1: seg.y1,
          width: seg.w,
          color: hot(col, gain),
        });
      }

      renderer.endFrame();
    },
    dispose(): void {
      trail.length = 0;
      head = 0;
      theta = 0;
      rotation = 0;
      bassS = null;
      trebleS = null;
      swell.reset();
    },
  };
}

const PLOTTER_PARAMS = [
  { key: P.lineDensity, label: "Line density", group: "Plot", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.jitter, label: "Jitter", group: "Plot", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.4 },
  { key: P.glow, label: "Glow intensity", group: "Light", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.7 },
  { key: P.bloom, label: "Bloom amount", group: "Light", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.trail, label: "Trail decay", group: "Light", type: "number" as const, min: 0, max: 0.92, step: 0.01, default: 0.88 },
  { key: P.swell, label: "Beat swell", group: "Light", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: P.hueDrift, label: "Hue drift", group: "Color", type: "number" as const, min: 0, max: 1, step: 0.01, default: 0.5 },
];

const PLOTTER_BINDINGS = {
  // Line density + jitter ride treble + the director; glow/bloom build with the
  // director; the swell rides treble so brighter highs punch the ink harder.
  [P.lineDensity]: { source: "audio" as const, path: "treble", outMin: 0.3, outMax: 1, smoothing: 0.8 },
  [P.jitter]: { source: "director" as const, path: "motion", inMin: 0.5, inMax: 2, outMin: 0.2, outMax: 0.8, smoothing: 0.8 },
  [P.glow]: { source: "director" as const, path: "intensity", outMin: 0.45, outMax: 1, smoothing: 0.8 },
  [P.bloom]: { source: "director" as const, path: "bloom", smoothing: 0.8 },
  [P.swell]: { source: "audio" as const, path: "treble", outMin: 0.4, outMax: 1, smoothing: 0.7 },
  [P.hueDrift]: { source: "audio" as const, path: "treble", outMin: 0.3, outMax: 0.9, smoothing: 0.85 },
};

/** The Plotter preset definition — rich param schema with audio/director bindings. */
export const plotterPreset: PresetDefinition = composePreset({
  id: "generative.plotter",
  name: "Plotter",
  description:
    "A penplot figure inked as glowing additive lines: a pen walks a seeded Lissajous curve laying down luminous strokes — treble and the director's density set ink density, treble rotates the figure, the director's motion sets jitter, and a beat thickens and brightens the line as the color crossfades over the track.",
  tags: ["generative", "plotter", "pen-art", "lines", "cinematic"],
  params: PLOTTER_PARAMS,
  bindings: PLOTTER_BINDINGS,
  layers: () => [makePlotterLayer(DEFAULT_SEED)],
});

/** Build a Plotter definition with an explicit seed (used by tests). */
export function plotterPresetWithSeed(seed: number): PresetDefinition {
  return composePreset({
    id: `generative.plotter.${seed}`,
    name: "Plotter",
    description: plotterPreset.description,
    tags: plotterPreset.tags,
    params: PLOTTER_PARAMS,
    bindings: PLOTTER_BINDINGS,
    layers: () => [makePlotterLayer(seed)],
  });
}
