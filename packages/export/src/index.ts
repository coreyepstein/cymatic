/**
 * @cymatic/export — deterministic render-to-file export pipeline for cymatic.
 *
 * The entry point is {@link renderOffline}: a backend- and environment-agnostic
 * driver that steps a core {@link OfflineClock} frame-by-frame, samples audio
 * features with the core {@link OfflineSampler}, runs the preset, and captures
 * each frame. Output goes through one of two sinks:
 *
 *   - {@link WebCodecsEncoderSink} — encodes to mp4/webm via the browser
 *     `VideoEncoder` (gate on {@link isWebCodecsAvailable}).
 *   - {@link FrameSequenceSink} — emits one PNG per frame when WebCodecs is
 *     unavailable (Node / unsupported browsers).
 *
 * Use {@link selectFrameSink} to pick the right sink automatically. After a PNG
 * sequence (or silent video) is produced, the original audio is muxed back on
 * with ffmpeg — see `AUDIO-MUX.md` in this package.
 */
import { version as coreVersion } from "@cymatic/core";

import { isWebCodecsAvailable, WebCodecsEncoderSink } from "./webcodecs-encoder.js";
import { FrameSequenceSink } from "./frame-sequence.js";
import type { FrameSink } from "./render-offline.js";
import type { WebCodecsEncoderOptions } from "./webcodecs-encoder.js";
import type { FrameSequenceOptions } from "./frame-sequence.js";

export {
  renderOffline,
  frameCountFor,
} from "./render-offline.js";
export type {
  OfflineRenderConfig,
  CapturedFrame,
  FrameSource,
  FrameSink,
  RenderOfflineOptions,
  RenderOfflineResult,
  PresetRendererLike,
} from "./render-offline.js";

export {
  WebCodecsEncoderSink,
  isWebCodecsAvailable,
} from "./webcodecs-encoder.js";
export type {
  WebCodecsEncoderOptions,
  EncodedChunk,
} from "./webcodecs-encoder.js";

export { FrameSequenceSink, encodePng } from "./frame-sequence.js";
export type {
  FrameSequenceOptions,
  FrameSequenceTarget,
} from "./frame-sequence.js";

/** Semantic version of the @cymatic/export package surface. */
export const version = "0.1.0";

/** The version of @cymatic/core this exporter was built against. */
export const builtAgainstCore = coreVersion;

/**
 * Export target formats this build can produce. `"png-sequence"` is always
 * available (the dependency-free fallback); `"mp4"` / `"webm"` require WebCodecs
 * at runtime (browser-only).
 */
export const supportedFormats: readonly string[] = ["png-sequence", "mp4", "webm"];

/**
 * Pick the output {@link FrameSink} for the current environment: a
 * {@link WebCodecsEncoderSink} when `VideoEncoder` is available, else a
 * {@link FrameSequenceSink} PNG emitter. The chosen sink and its `kind` are
 * returned so callers can adapt (e.g. point the muxer at a video vs a PNG dir).
 */
export function selectFrameSink(options: {
  /** WebCodecs encoder options, used when WebCodecs is available. */
  readonly webcodecs: WebCodecsEncoderOptions;
  /** PNG frame-sequence options, used as the fallback. */
  readonly frameSequence: FrameSequenceOptions;
}): { kind: "webcodecs" | "png-sequence"; sink: FrameSink } {
  if (isWebCodecsAvailable()) {
    return { kind: "webcodecs", sink: new WebCodecsEncoderSink(options.webcodecs) };
  }
  return { kind: "png-sequence", sink: new FrameSequenceSink(options.frameSequence) };
}
