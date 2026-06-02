/**
 * @cymatic/react — React bindings for the cymatic web audio visualizer.
 *
 * A THIN wrapper over @cymatic/core: a managed-canvas {@link Visualizer}
 * component and the {@link useVisualizer} / {@link useAudioFeatures} hooks for
 * custom UIs. All rendering and DSP lives in core; this layer only sequences
 * the core lifecycle inside React effects and tears it down on unmount.
 *
 * SSR-safe: importing this module under Node touches no browser globals.
 */
import { version as coreVersion } from "@cymatic/core";

/** Semantic version of the @cymatic/react package surface. */
export const version = "0.0.0";

/** The version of @cymatic/core this binding was built against. */
export const builtAgainstCore = coreVersion;

export { Visualizer } from "./Visualizer.js";
export type { VisualizerProps, VisualizerRef } from "./Visualizer.js";

export {
  useVisualizer,
  useAudioFeatures,
  defaultCanvasStyle,
} from "./hooks.js";
export type {
  UseVisualizerOptions,
  VisualizerHandle,
  AudioBufferInput,
} from "./hooks.js";

// Convenience re-exports so consumers can type feature callbacks and presets
// without a separate @cymatic/core import.
export type { AudioFeatureFrame, Preset } from "@cymatic/core";
