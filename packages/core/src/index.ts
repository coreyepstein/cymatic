/**
 * @cymatic/core — core engine for the cymatic web audio visualizer.
 *
 * This is an early scaffold. Real engine surfaces (audio analysis, render
 * loop, visualizer registry) arrive in later stories.
 */

/** Semantic version of the @cymatic/core package surface. */
export const version = "0.0.0";

/** Identifier for the core package. */
export const name = "@cymatic/core";

// Audio analysis engine (US-002): FFT bands, RMS/loudness, onset detection,
// and input adapters for <audio>, microphone, and decoded AudioBuffer. Also
// exposes the offline AudioBuffer feature sampler (US-003).
export * from "./audio/index.js";

// Timing / clock abstraction (US-003): a single Clock interface backing both a
// realtime (rAF, wall-clock) and an offline (fixed 1/fps, deterministic) driver.
export * from "./clock/index.js";

// Renderer abstraction (US-004): a backend-agnostic Renderer surface with a
// createRenderer() factory that selects WebGPU (preferred) or WebGL (fallback)
// via capability detection. Presets target the Renderer and never branch on the
// backend.
export * from "./render/index.js";

// Visual primitives (US-005): easing & smoothing, color & palettes,
// lightweight typography, and audio-feature bindings — the pure, backend-
// agnostic building blocks presets compose from.
export * from "./primitives/index.js";

// Preset & layer/pass API (US-005): the Preset contract, definePreset, a
// PresetRegistry, the layer composition model, and a reference example preset
// built only from the public primitive surface.
export * from "./preset/index.js";
