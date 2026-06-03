/**
 * `concentricPreset` — cinematic concentric / hard-edge frames (V2-10 rebuild).
 *
 * Nested square rings drawn from the outside in: each ring is stroked with
 * additive light lines so the whole stack reads as a glowing target, the stack
 * breathes (scales about the center) with bass and the director's motion, the
 * innermost block is a gradient core that swells and flashes on the beat, and
 * the color crossfades over the track via the director's palette + hue rotation.
 * Light feedback leaves a faint pulsing trail as the stack breathes.
 *
 * "Concentric" / "Hard Edge" reference techniques, never a person. Public
 * `@cymatic/core` surface only (palette/director/easing + line/glow/gradient/
 * post-FX primitives). Deterministic given `(features, director, time, seed)`.
 */

import {
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

import { BeatFlash, directorColor, geometricPostFx, hot } from "./common.js";

const P = {
  rings: "ringCount",
  line: "lineWeight",
  glow: "glowIntensity",
  spread: "colorSpread",
  bloom: "bloomAmount",
  flash: "beatFlash",
  breath: "breathAmount",
  motion: "motionSpeed",
} as const;

/** Ring-count steps the `ringCount` param maps onto. */
const RING_STEPS: readonly number[] = [3, 4, 5, 6, 7];

/** Resolve a `[0,1]`-ish param into a concrete ring count. Pure. */
export function ringResolution(amount: number): number {
  const n = RING_STEPS.length;
  const i = Math.min(n - 1, Math.max(0, Math.round(clamp01(amount) * (n - 1))));
  return RING_STEPS[i] ?? 5;
}

/**
 * Overall breathing scale of the ring stack from (smoothed) bass, a `breath`
 * amount, the director's motion, and an onset pop. Pure + exported: louder bass
 * / more motion → the stack expands toward the frame edges, eased so it settles.
 */
export function breathScale(bass: number, breath: number, motion: number, onset: boolean): number {
  const span = 0.55 + clamp01(breath) * 0.4;
  const base = mapFeature(easeOutCubic(clamp01(bass)) * clamp01(0.6 + motion * 0.5), 0.5, span);
  return Math.min(1, base + (onset ? 0.06 : 0));
}

function makeConcentricLayer(): Layer {
  let bass: BandSmoother | null = null;
  let treble: BandSmoother | null = null;
  const flash = new BeatFlash(0.22);

  return {
    id: "geometric.concentric",
    init(): void {
      bass = smoothBand("bass", 0.75);
      treble = smoothBand("treble", 0.6);
      flash.reset();
    },
    draw({ renderer, features, director, params, dt }: LayerFrame): void {
      const bassS = (bass ?? smoothBand("bass", 0.75)).push(features);
      const trebleS = (treble ?? smoothBand("treble", 0.6)).push(features);
      const flashAmt = flash.update(features.onset, dt);

      const rings = ringResolution(Number(params[P.rings] ?? 0.5));
      const lineW = Number(params[P.line] ?? 0.008);
      const glowK = clamp01(Number(params[P.glow] ?? 0.6));
      const spread = clamp01(Number(params[P.spread] ?? 0.9));
      const bloomAmt = clamp01(Number(params[P.bloom] ?? director.bloom));
      const flashStrength = clamp01(Number(params[P.flash] ?? 0.85));
      const breath = clamp01(Number(params[P.breath] ?? 0.6));
      const motion = Number(params[P.motion] ?? director.motion);

      renderer.setPostEffects(geometricPostFx(bloomAmt, 0.5 + director.motion * 0.14));

      const voidColor = directorColor(director, 0.03);
      renderer.beginFrame({ r: voidColor.r * 0.1, g: voidColor.g * 0.1, b: voidColor.b * 0.13, a: 1 });

      const scale = breathScale(bassS, breath, motion, features.onset);
      const center = 0.5;
      const beat = flashAmt * flashStrength;
      const intensity = clamp01(director.intensity + bassS * 0.4);

      // Rings drawn outside-in as additive light frames.
      renderer.setBlendMode("additive");
      for (let i = 0; i < rings; i++) {
        const t = i / (rings - 1);
        const side = scale * (1 - t * 0.82);
        const half = side / 2;
        const left = center - half;
        const top = center - half;
        const col = directorColor(director, clamp01(t * spread));

        if (i === rings - 1) {
          // Innermost: a gradient core block (alpha) that swells + flashes.
          renderer.setBlendMode("alpha");
          const coreCol = hot(col, 1 + beat * 2.2);
          renderer.drawGradientRect(
            { x: left, y: top, w: side, h: side, color: coreCol },
            { from: withAlpha(col, 0.5), to: coreCol, radial: true },
          );
          // An additive glow sits on the core so it blooms hard on the beat.
          renderer.drawGlow({
            x: center,
            y: center,
            radius: half * (1.1 + beat * 0.6),
            color: hot(col, 1),
            intensity: 0.8 + glowK * 1.6 + intensity + beat * 2.6,
          });
          continue;
        }

        // Ring strokes brighten with treble + the beat; line weight is a param.
        const w = Math.max(0.001, lineW * (0.6 + trebleS * 1.0 + beat * 0.8));
        const strokeCol = hot(col, 0.5 + glowK * 1.2 + trebleS * 0.8 + beat);
        renderer.drawLine({ x0: left, y0: top, x1: left + side, y1: top, width: w, color: strokeCol }); // top
        renderer.drawLine({ x0: left, y0: top + side, x1: left + side, y1: top + side, width: w, color: strokeCol }); // bottom
        renderer.drawLine({ x0: left, y0: top, x1: left, y1: top + side, width: w, color: strokeCol }); // left
        renderer.drawLine({ x0: left + side, y0: top, x1: left + side, y1: top + side, width: w, color: strokeCol }); // right

        // A soft glow at each corner so the lattice reads as light, not ink.
        const cornerGain = 0.3 + glowK * 0.9 + beat * 1.2;
        const gr = side * 0.14 * (0.6 + glowK);
        for (const [gx, gy] of [
          [left, top],
          [left + side, top],
          [left, top + side],
          [left + side, top + side],
        ] as const) {
          renderer.drawGlow({ x: gx, y: gy, radius: gr, color: hot(col, 1), intensity: cornerGain });
        }
      }

      renderer.endFrame();
    },
    dispose(): void {
      bass = null;
      treble = null;
      flash.reset();
    },
  };
}

/** The Concentric preset definition — rich param schema with audio/director bindings. */
export const concentricPreset: PresetDefinition = composePreset({
  id: "geometric.concentric",
  name: "Concentric",
  description:
    "Glowing hard-edge nested rings: the stack breathes with bass and the song's motion, additive strokes and corner glows light the lattice, and a gradient core swells and flashes on each beat as the color crossfades over the track.",
  tags: ["geometric", "hard-edge", "concentric", "swiss", "cinematic"],
  params: [
    { key: P.rings, label: "Ring count", group: "Geometry", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: P.line, label: "Line weight", group: "Geometry", type: "number", min: 0, max: 0.03, step: 0.001, default: 0.008 },
    { key: P.breath, label: "Breath amount", group: "Motion", type: "number", min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: P.motion, label: "Motion speed", group: "Motion", type: "number", min: 0, max: 2, step: 0.01, default: 1 },
    { key: P.glow, label: "Glow intensity", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: P.bloom, label: "Bloom amount", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: P.flash, label: "Beat flash", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.85 },
    { key: P.spread, label: "Color spread", group: "Color", type: "number", min: 0, max: 1, step: 0.01, default: 0.9 },
  ],
  bindings: {
    [P.glow]: { source: "director", path: "intensity", outMin: 0.3, outMax: 1, smoothing: 0.5 },
    [P.bloom]: { source: "director", path: "bloom", smoothing: 0.6 },
    [P.breath]: { source: "audio", path: "bass", outMin: 0.4, outMax: 1, smoothing: 0.6 },
    [P.motion]: { source: "director", path: "motion", inMin: 0.5, inMax: 2, outMin: 0.5, outMax: 2, smoothing: 0.6 },
    [P.rings]: { source: "director", path: "density", inMin: 0.5, inMax: 1.6, smoothing: 0.8 },
    [P.flash]: { source: "audio", path: "treble", outMin: 0.5, outMax: 1, smoothing: 0.4 },
  },
  layers: () => [makeConcentricLayer()],
});
