/**
 * Public audio analysis surface for @cymatic/core.
 *
 * Pure DSP (`features`, `beat-detector`) is Node-testable; the analyser and
 * input adapters wire it to a live Web Audio `AnalyserNode` at runtime.
 */

export type { AudioFeatureFrame, BandSplit } from "./features.js";
export {
  DEFAULT_BAND_SPLIT,
  bandGroups,
  clamp01,
  computeBands,
  computeRms,
  crestFactor,
  ema,
  estimateTempo,
  logBandEdges,
  spectralCentroid,
  spectralRolloff,
} from "./features.js";

export type { BeatDetectorOptions } from "./beat-detector.js";
export { BeatDetector, spectralFlux } from "./beat-detector.js";

export type { MoodVector, MoodOptions } from "./mood.js";
export { ZERO_MOOD, computeMood } from "./mood.js";

export type { AnalyserOptions } from "./analyser.js";
export { AudioAnalyser } from "./analyser.js";

export type { ElementSource } from "./inputs/element.js";
export { connectElementSource } from "./inputs/element.js";

export type { MicrophoneSource } from "./inputs/microphone.js";
export { connectMicrophoneSource } from "./inputs/microphone.js";

export type { BufferSource } from "./inputs/buffer.js";
export { decodeAudioData, playBufferSource } from "./inputs/buffer.js";

export type {
  AudioBufferLike,
  OfflineSamplerOptions,
} from "./offline-sampler.js";
export { OfflineSampler } from "./offline-sampler.js";
