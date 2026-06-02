/**
 * Public preset surface for @cymatic/core.
 *
 * The {@link Preset} contract, the {@link definePreset} authoring helper, the
 * {@link PresetRegistry}, the layer/pass composition model, and a reference
 * {@link examplePreset} built purely from public primitives. Everything here
 * targets the backend-agnostic {@link Renderer} — presets never see GL/GPU.
 */

export type {
  Preset,
  PresetContext,
  PresetMeta,
  PresetDefinition,
  DefinePresetInput,
} from "./preset.js";
export { definePreset, PresetRegistry, defaultPresetRegistry } from "./preset.js";

export type {
  Layer,
  LayerFrame,
  LayerResize,
  LayerSource,
  ComposeOptions,
} from "./layers.js";
export { LayerStack, composePreset } from "./layers.js";

export { examplePreset, exampleBackgroundBrightness } from "./example-preset.js";
