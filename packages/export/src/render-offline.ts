/**
 * Deterministic offline render driver for @cymatic/export.
 *
 * Given a {@link Preset}, a decoded `AudioBuffer` (or any structurally-
 * compatible {@link AudioBufferLike}), and an {@link OfflineRenderConfig}
 * (`fps`, `width`, `height`, `duration`), this steps a core {@link OfflineClock}
 * frame-by-frame, samples audio features with the core {@link OfflineSampler} at
 * each frame's exact clock time, runs `preset.update`, and captures each frame
 * through an injectable {@link FrameSource}.
 *
 * The driver is intentionally backend- and environment-agnostic: it never
 * touches WebGPU/WebGL, `requestAnimationFrame`, `Date.now()`, or
 * `Math.random()`. The two side-effecting steps — capturing a rendered frame
 * and encoding it — sit behind the {@link FrameSource} and {@link FrameSink}
 * interfaces so the same driver runs verbatim in the browser (real renderer +
 * WebCodecs) and in Node (fake renderer/capture + counting sink). Given the
 * same inputs, two runs produce byte-identical output.
 *
 * Frame-count contract: exporting `duration` seconds at `fps` frames per second
 * yields exactly `frameCount = Math.round(duration * fps)` frames — frame `i`
 * (for `i` in `[0, frameCount)`) is rendered at clock time `i / fps`. The DSP /
 * stepping all comes from core; nothing here reimplements it.
 */

import {
  OfflineClock,
  OfflineSampler,
  type AudioBufferLike,
  type AudioFeatureFrame,
  type OfflineSamplerOptions,
  type Preset,
} from "@cymatic/core";

/** Dimensions + timing describing the offline render. */
export interface OfflineRenderConfig {
  /** Frames per second. Must be a positive, finite number. */
  readonly fps: number;
  /** Frame width in device pixels. Must be a positive integer. */
  readonly width: number;
  /** Frame height in device pixels. Must be a positive integer. */
  readonly height: number;
  /** Total duration to render, in seconds. Must be a non-negative, finite number. */
  readonly duration: number;
}

/** A single captured frame: RGBA8 pixels plus the metadata needed to encode it. */
export interface CapturedFrame {
  /** Zero-based frame index. */
  readonly index: number;
  /** Clock time of the frame, in seconds (`index / fps`). */
  readonly time: number;
  /** Backing-store width in device pixels. */
  readonly width: number;
  /** Backing-store height in device pixels. */
  readonly height: number;
  /**
   * Tightly-packed RGBA8 pixels, row-major, length `width * height * 4`. Owned
   * by the consumer once yielded — the {@link FrameSource} is free to reuse its
   * own scratch between captures, so a {@link FrameSink} that retains the buffer
   * must copy it.
   */
  readonly pixels: Uint8Array;
}

/**
 * Captures the current rendered frame as RGBA8 pixels. In the browser this
 * wraps a real renderer read-back (e.g. `gl.readPixels` /
 * `GPUBuffer` map, or a `<canvas>` `getImageData`). In Node tests a fake
 * implementation returns a deterministic buffer so the driver can be exercised
 * without a GPU.
 *
 * The driver calls {@link FrameSource.capture} once per frame, *after* the
 * preset has drawn that frame. Implementations may reuse a single backing
 * buffer across calls (see {@link CapturedFrame.pixels}).
 */
export interface FrameSource {
  /** Capture the just-rendered frame `index` at `time` seconds. */
  capture(index: number, time: number): Uint8Array;
}

/**
 * Consumes captured frames in order. Both the WebCodecs encoder and the PNG
 * frame-sequence emitter implement this so the driver is blind to the output
 * format. Implementations should be deterministic given deterministic input.
 */
export interface FrameSink {
  /** Receive one captured frame, in increasing `index` order. */
  writeFrame(frame: CapturedFrame): void | Promise<void>;
  /** Finalize output (flush the encoder, close the file sequence). */
  finish(): void | Promise<void>;
}

/** Options controlling an {@link renderOffline} run. */
export interface RenderOfflineOptions {
  /** The preset to drive. Its lifecycle (`init`/`resize`/`update`) is invoked here. */
  readonly preset: Preset;
  /** Decoded audio to sample features from (browser `AudioBuffer` or test stub). */
  readonly audio: AudioBufferLike;
  /** Frame dimensions + timing. */
  readonly config: OfflineRenderConfig;
  /** Captures each rendered frame's pixels. */
  readonly frameSource: FrameSource;
  /** Receives captured frames (a WebCodecs encoder or PNG sequence sink). */
  readonly sink: FrameSink;
  /**
   * Options forwarded to the core {@link OfflineSampler} (band count, fftSize,
   * smoothing, window alignment, …). Deterministic given the same values.
   */
  readonly samplerOptions?: OfflineSamplerOptions;
  /**
   * A {@link PresetContext}-shaped renderer surface, or `undefined`. The driver
   * does not need a real renderer to step deterministically; presets that draw
   * through one receive it via `preset.init`. When omitted, `preset.init` is
   * still called with a `null` renderer so purely state-driven presets work in
   * Node. Browser hosts pass the real renderer.
   */
  readonly renderer?: PresetRendererLike;
}

/**
 * The renderer surface a preset is initialized with. Kept structurally minimal
 * here so Node tests can pass a stub (or omit it) without importing the full
 * renderer; the browser passes a real core `Renderer`.
 */
export type PresetRendererLike = unknown;

/** Result of an {@link renderOffline} run. */
export interface RenderOfflineResult {
  /** Number of frames rendered (`Math.round(duration * fps)`). */
  readonly frameCount: number;
  /** The audio feature frame sampled for each rendered frame, in order. */
  readonly features: readonly AudioFeatureFrame[];
}

/**
 * Compute the exact number of frames for a `duration`/`fps` pair. Rounding (not
 * floor/ceil) keeps the count stable against floating-point error — e.g.
 * `2 * 30` and `1.9999999 * 30` both yield `60`.
 */
export function frameCountFor(duration: number, fps: number): number {
  if (!(fps > 0) || !Number.isFinite(fps)) {
    throw new RangeError("frameCountFor: fps must be a positive, finite number");
  }
  if (!(duration >= 0) || !Number.isFinite(duration)) {
    throw new RangeError("frameCountFor: duration must be a non-negative, finite number");
  }
  return Math.round(duration * fps);
}

function validateConfig(config: OfflineRenderConfig): void {
  const { fps, width, height, duration } = config;
  if (!(fps > 0) || !Number.isFinite(fps)) {
    throw new RangeError("renderOffline: config.fps must be a positive, finite number");
  }
  if (!Number.isInteger(width) || width <= 0) {
    throw new RangeError("renderOffline: config.width must be a positive integer");
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new RangeError("renderOffline: config.height must be a positive integer");
  }
  if (!(duration >= 0) || !Number.isFinite(duration)) {
    throw new RangeError("renderOffline: config.duration must be a non-negative, finite number");
  }
}

/**
 * Drive a deterministic offline render. Steps frame-by-frame:
 *
 *   1. Construct an {@link OfflineClock} at `config.fps` and an
 *      {@link OfflineSampler} over `config.audio` (DSP from core; not reimplemented).
 *   2. `await preset.init(ctx)` then `preset.resize(width, height, 1)`.
 *   3. For `index` in `[0, frameCount)`: position the clock at frame `index`
 *      (time `index / fps`), sample features at that exact time, call
 *      `preset.update(features, time, dt)`, then capture + write the frame.
 *   4. `await sink.finish()` and `preset.dispose()`.
 *
 * Frame 0 uses `dt = 0`; subsequent frames use `dt = 1 / fps`. The sampler is
 * called exactly once per frame, at the frame's clock time, in monotonic order
 * (which is what makes its stateful smoothing/onset detection reproducible).
 */
export async function renderOffline(
  options: RenderOfflineOptions,
): Promise<RenderOfflineResult> {
  const { preset, audio, config, frameSource, sink, samplerOptions, renderer } =
    options;
  validateConfig(config);

  const { fps, width, height, duration } = config;
  const total = frameCountFor(duration, fps);

  const clock = new OfflineClock({ fps });
  const sampler = new OfflineSampler(audio, samplerOptions);

  // Preset lifecycle. `init` may be async (returns void | Promise<void>).
  await preset.init({
    // The renderer is opaque to the driver; presets that draw cast it back.
    renderer: renderer as never,
    width,
    height,
    dpr: 1,
  });
  preset.resize(width, height, 1);

  const features: AudioFeatureFrame[] = [];
  const dtPerFrame = 1 / fps;

  for (let index = 0; index < total; index++) {
    // Position the clock exactly at frame `index`. We reset + tick rather than
    // accumulate so time is `index / fps` with no floating-point drift, and the
    // sampler always sees strictly increasing times.
    while (clock.frame < index) clock.tick();
    const time = clock.now();

    const frame = sampler.sampleAt(time);
    features.push(frame);

    const dt = index === 0 ? 0 : dtPerFrame;
    preset.update(frame, time, dt);

    const pixels = frameSource.capture(index, time);
    const captured: CapturedFrame = { index, time, width, height, pixels };
    await sink.writeFrame(captured);
  }

  await sink.finish();
  preset.dispose();

  return { frameCount: total, features };
}
