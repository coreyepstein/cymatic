/**
 * `examplePreset` — a reference preset built ONLY from the public primitive API
 * and the layer model. It proves the {@link Preset} contract end-to-end: a host
 * can instantiate it, drive its lifecycle, and watch it react to audio, all
 * without the preset ever touching a backend.
 *
 * Visually: a horizontal row of vertical bars whose heights track the per-band
 * energy, colored by sampling the `sunset` palette across the spectrum, over a
 * background that brightens with (smoothed) bass and flashes on an onset. Every
 * value here comes from `../primitives` — no raw GL/GPU, no `renderer.backend`
 * branch.
 */

import { palettes, sample } from "../primitives/palette.js";
import { bandAt, mapFeature, smoothBand, type BandSmoother } from "../primitives/bindings.js";
import { easeOutCubic } from "../primitives/easing.js";
import type { Layer, LayerFrame } from "./layers.js";
import { composePreset } from "./layers.js";
import type { PresetDefinition } from "./preset.js";

/** How many bars the example draws across the frame. */
const BAR_COUNT = 16;
/** Fraction of each bar's slot left as a gap (visual breathing room). */
const BAR_GAP = 0.2;

/**
 * Compute the example's background brightness from a (smoothed) bass value and
 * the onset flag. Pure and exported so tests can assert the response curve
 * directly: higher bass → strictly higher brightness, and an onset adds a flash.
 */
export function exampleBackgroundBrightness(bass: number, onset: boolean): number {
  const base = mapFeature(bass, 0.02, 0.25);
  const flash = onset ? 0.2 : 0;
  return Math.min(1, base + flash);
}

/**
 * A layer that owns the per-instance smoothed-bass state, clears the frame to a
 * bass-reactive background, then draws one band-reactive bar per spectrum slice.
 * Keeping state in the layer means every `create()` gets independent state.
 */
function makeExampleLayer(): Layer {
  let bass: BandSmoother | null = null;

  return {
    id: "example.bars",
    init(): void {
      bass = smoothBand("bass", 0.6);
    },
    draw({ renderer, features }: LayerFrame): void {
      const smoother = bass ?? smoothBand("bass", 0.6);
      const brightness = exampleBackgroundBrightness(smoother.push(features), features.onset);
      // Tint the background toward the palette's low end so it stays in family.
      const tint = sample(palettes.sunset, 0);
      renderer.beginFrame({
        r: tint.r * brightness + brightness * 0.1,
        g: tint.g * brightness + brightness * 0.05,
        b: tint.b * brightness + brightness * 0.15,
        a: 1,
      });

      const slotWidth = 1 / BAR_COUNT;
      const barWidth = slotWidth * (1 - BAR_GAP);
      for (let i = 0; i < BAR_COUNT; i++) {
        const energy = bandAt(features, i);
        const height = easeOutCubic(energy);
        if (height <= 0) continue;
        const x = i * slotWidth + (slotWidth - barWidth) / 2;
        const color = sample(palettes.sunset, i / (BAR_COUNT - 1));
        renderer.drawRect({
          x,
          // Bars grow upward from the bottom of the frame.
          y: 1 - height,
          w: barWidth,
          h: height,
          color,
        });
      }

      renderer.endFrame();
    },
    dispose(): void {
      bass = null;
    },
  };
}

/**
 * The example preset definition. Because its single layer opens and closes the
 * frame itself (and owns its smoother), `composePreset` is used without a
 * `background` factory — the layer is fully self-contained per instance.
 */
export const examplePreset: PresetDefinition = composePreset({
  id: "core.example",
  name: "Example (bars)",
  description:
    "Reference preset built only from public primitives: bass-reactive bars over a beat-reactive background.",
  tags: ["reference", "geometric"],
  // A factory so every instance gets its own layer (and smoother) state.
  layers: () => [makeExampleLayer()],
});
