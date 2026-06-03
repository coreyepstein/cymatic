/**
 * `modularPreset` — cinematic modular / constructivist columns (V2-10 rebuild).
 *
 * A column-based layout of stacked, gradient-filled modules whose heights are
 * driven by the audio spectrum and the director's intensity. Each module glows
 * from within (additive core), a capped accent module snaps to a new column on
 * each beat and flares, and the color crossfades over the track via the
 * director's palette + hue rotation. Light feedback leaves a faint vertical
 * trail as modules grow/shrink, so the blocks feel like rising bars of light.
 *
 * The name references *modular* composition, never a person or trademark. Public
 * `@cymatic/core` surface only (palette/director/easing + gradient/glow/post-FX
 * primitives). Deterministic given `(features, director, time, seed)`.
 */

import {
  bandAt,
  clamp01,
  easeOutCubic,
  mapFeature,
  smoothBand,
  withAlpha,
  type BandSmoother,
} from "@cymatic/core";
import {
  composePreset,
  type Layer,
  type LayerFrame,
  type PresetDefinition,
} from "@cymatic/core";

import { BeatFlash, directorColor, dim, geometricPostFx, hot } from "./common.js";

const P = {
  modules: "moduleCount",
  glow: "glowIntensity",
  gap: "moduleGap",
  spread: "colorSpread",
  bloom: "bloomAmount",
  flash: "beatFlash",
  height: "heightDrive",
  cap: "capWeight",
} as const;

/** Module-count steps the `moduleCount` param maps onto. */
const MODULE_STEPS: readonly number[] = [4, 5, 6, 8, 10];

/** Resolve a `[0,1]`-ish param into a concrete module (column) count. Pure. */
export function moduleResolution(amount: number): number {
  const n = MODULE_STEPS.length;
  const i = Math.min(n - 1, Math.max(0, Math.round(clamp01(amount) * (n - 1))));
  return MODULE_STEPS[i] ?? 6;
}

/** Which module the beat accent jumps to. Pure: advances on an onset, holds otherwise. */
export function nextAccentModule(current: number, count: number, onset: boolean): number {
  const n = Math.max(1, count);
  return onset ? (current + 1) % n : current % n;
}

/**
 * Module block height fraction from a (smoothed) band energy and a `drive`
 * multiplier (director intensity). Pure; higher energy/drive → taller block,
 * eased for a non-twitchy response.
 */
export function moduleHeight(energy: number, drive: number): number {
  return mapFeature(easeOutCubic(clamp01(energy)) * clamp01(0.4 + drive), 0.08, 0.94);
}

function makeModularLayer(): Layer {
  const smoothers: BandSmoother[] = [];
  const flash = new BeatFlash(0.2);
  let accent = 0;
  let prevOnset = false;

  return {
    id: "geometric.modular",
    init(): void {
      smoothers.length = 0;
      for (let i = 0; i < 10; i++) {
        const name = i % 3 === 0 ? "bass" : i % 3 === 1 ? "mid" : "treble";
        smoothers.push(smoothBand(name, 0.55 + (i / 10) * 0.3));
      }
      flash.reset();
      accent = 0;
      prevOnset = false;
    },
    draw({ renderer, features, director, params, dt }: LayerFrame): void {
      const flashAmt = flash.update(features.onset, dt);

      const modules = moduleResolution(Number(params[P.modules] ?? 0.5));
      const glowK = clamp01(Number(params[P.glow] ?? 0.6));
      const gap = clamp01(Number(params[P.gap] ?? 0.12)) * 0.5;
      const spread = clamp01(Number(params[P.spread] ?? 0.8));
      const bloomAmt = clamp01(Number(params[P.bloom] ?? director.bloom));
      const flashStrength = clamp01(Number(params[P.flash] ?? 0.8));
      const drive = clamp01(Number(params[P.height] ?? director.intensity));
      const capW = clamp01(Number(params[P.cap] ?? 0.4));

      renderer.setPostEffects(geometricPostFx(bloomAmt, 0.4 + director.motion * 0.14));

      if (features.onset && !prevOnset) accent = nextAccentModule(accent, modules, true);
      prevOnset = features.onset;

      // Palette-tinted void background, evolving with the director.
      const voidColor = directorColor(director, 0.04);
      renderer.beginFrame({ r: voidColor.r * 0.1, g: voidColor.g * 0.1, b: voidColor.b * 0.13, a: 1 });

      const slot = 1 / modules;
      const moduleW = slot * (1 - gap * 2);
      const beat = flashAmt * flashStrength;

      renderer.setBlendMode("alpha");
      for (let i = 0; i < modules; i++) {
        const smoother = smoothers[i] ?? smoothBand("mid", 0.6);
        const energy = smoother.push(features);
        const h = moduleHeight(energy, drive);
        const x = i * slot + (slot - moduleW) / 2;
        const isAccent = i === accent;
        const t = clamp01((i / Math.max(1, modules - 1)) * spread);
        const col = directorColor(director, t);

        // Gradient block: dim base at the bottom rising to the lit color at the
        // top, so each module reads as a column of light rather than flat fill.
        const top = dim(col, isAccent ? 0 : 0.25);
        renderer.drawGradientRect(
          { x, y: 1 - h, w: moduleW, h, color: top },
          { from: withAlpha(dim(col, 0.7), 0.6), to: top, angle: Math.PI / 2 },
        );

        // The modular "cap" block atop each module — brighter, and it flares on
        // the accent column when a beat hits.
        const capH = slot * (0.12 + capW * 0.22);
        const capCol = isAccent ? hot(col, 1 + beat * 1.5) : col;
        renderer.drawRect({ x, y: 1 - h - capH, w: moduleW, h: capH, color: capCol });
      }

      // Additive glow cores rising up each module — the inner light.
      for (let i = 0; i < modules; i++) {
        const smoother = smoothers[i] ?? smoothBand("mid", 0.6);
        const energy = clamp01(bandAt(features, i) * 0.5 + smoother.current * 0.5);
        const h = moduleHeight(energy, drive);
        const cx = i * slot + slot / 2;
        const isAccent = i === accent;
        const t = clamp01((i / Math.max(1, modules - 1)) * spread);
        const col = directorColor(director, t);
        const accentBoost = isAccent ? 1 + beat * 2.2 : 1;
        // A couple of stacked glow blobs up the module's height read as a soft
        // vertical bar of light; intensity scales with energy + glow param.
        const cores = 3;
        for (let k = 0; k < cores; k++) {
          const fy = (k + 0.5) / cores;
          const cy = 1 - h * fy;
          const gain = (0.4 + glowK * 1.4 + director.intensity) * accentBoost * (1 - 0.2 * k);
          renderer.drawGlow({
            x: cx,
            y: cy,
            radius: moduleW * (0.6 + glowK * 0.5),
            color: hot(col, 1),
            intensity: gain,
          });
        }
      }

      renderer.endFrame();
    },
    dispose(): void {
      smoothers.length = 0;
      flash.reset();
    },
  };
}

/** The Modular preset definition — rich param schema with audio/director bindings. */
export const modularPreset: PresetDefinition = composePreset({
  id: "geometric.modular",
  name: "Modular",
  description:
    "Constructivist columns of glowing gradient modules: per-module spectrum drives the heights, additive cores light each block, and a capped accent column flares on the beat as the color crossfades over the track.",
  tags: ["geometric", "bauhaus", "modular", "constructivist", "cinematic"],
  params: [
    { key: P.modules, label: "Module count", group: "Geometry", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: P.gap, label: "Module gap", group: "Geometry", type: "number", min: 0, max: 1, step: 0.01, default: 0.12 },
    { key: P.cap, label: "Cap weight", group: "Geometry", type: "number", min: 0, max: 1, step: 0.01, default: 0.4 },
    { key: P.height, label: "Height drive", group: "Motion", type: "number", min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: P.glow, label: "Glow intensity", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: P.bloom, label: "Bloom amount", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: P.flash, label: "Beat flash", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.8 },
    { key: P.spread, label: "Color spread", group: "Color", type: "number", min: 0, max: 1, step: 0.01, default: 0.8 },
  ],
  bindings: {
    [P.height]: { source: "director", path: "intensity", smoothing: 0.6 },
    [P.glow]: { source: "director", path: "intensity", outMin: 0.3, outMax: 1, smoothing: 0.5 },
    [P.bloom]: { source: "director", path: "bloom", smoothing: 0.6 },
    [P.modules]: { source: "director", path: "density", inMin: 0.5, inMax: 1.6, smoothing: 0.8 },
    [P.flash]: { source: "audio", path: "treble", outMin: 0.5, outMax: 1, smoothing: 0.4 },
  },
  layers: () => [makeModularLayer()],
});
