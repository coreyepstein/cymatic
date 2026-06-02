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
// and input adapters for <audio>, microphone, and decoded AudioBuffer.
export * from "./audio/index.js";
