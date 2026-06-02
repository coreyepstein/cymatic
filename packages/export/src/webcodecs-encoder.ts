/**
 * WebCodecs encode path for @cymatic/export.
 *
 * Encodes captured RGBA frames to a compressed video stream (mp4 / webm)
 * using the browser `VideoEncoder` API. WebCodecs is browser-only, so this
 * module is written to be import-safe in Node: it NEVER references
 * `VideoEncoder` / `VideoFrame` / `EncodedVideoChunk` at module top level.
 * Everything touches them lazily, behind {@link isWebCodecsAvailable} guards,
 * inside method bodies — so `import`ing this file in Node (e.g. to use the
 * capability check that selects the PNG fallback) does not throw.
 *
 * The encoder yields raw `EncodedVideoChunk`s plus their metadata. Muxing those
 * chunks into a real `.mp4`/`.webm` container (and adding the audio track) is a
 * container-format concern delegated to a muxer (e.g. `mp4-muxer` /
 * `webm-muxer`) and to the ffmpeg step documented in `AUDIO-MUX.md`. Keeping the
 * muxer out of core export avoids a heavy, format-coupled dependency here while
 * still proving the encode path end-to-end in the browser.
 */

import type { CapturedFrame, FrameSink } from "./render-offline.js";

/**
 * True when the WebCodecs `VideoEncoder` is available in the current
 * environment. The single capability gate the rest of the pipeline branches on
 * (selecting {@link WebCodecsEncoderSink} when true, the PNG frame sequence
 * otherwise). Safe to call in Node — it only does a `typeof` check.
 */
export function isWebCodecsAvailable(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { VideoEncoder?: unknown }).VideoEncoder !== "undefined" &&
    typeof (globalThis as { VideoFrame?: unknown }).VideoFrame !== "undefined"
  );
}

/** An encoded chunk plus the encoder-supplied metadata (codec config, etc). */
export interface EncodedChunk {
  /** Zero-based frame index this chunk was produced from. */
  readonly index: number;
  /** The raw WebCodecs chunk. Typed loosely so this file stays Node-import-safe. */
  readonly chunk: unknown;
  /** Encoder metadata for the chunk (decoder config on the first key frame). */
  readonly meta: unknown;
}

/** Options for {@link WebCodecsEncoderSink}. */
export interface WebCodecsEncoderOptions {
  /** Frame width in device pixels. */
  readonly width: number;
  /** Frame height in device pixels. */
  readonly height: number;
  /** Frames per second (sets each frame's presentation timestamp). */
  readonly fps: number;
  /**
   * The WebCodecs codec string, e.g. `"avc1.42001f"` (H.264 → mp4) or
   * `"vp09.00.10.08"` (VP9 → webm). Defaults to H.264 baseline.
   */
  readonly codec?: string;
  /** Target bitrate in bits/sec. Default `5_000_000`. */
  readonly bitrate?: number;
  /**
   * Receives each {@link EncodedChunk} as it is produced. A muxer wires these
   * into a container; tests can count them. Optional — chunks are also retained
   * on {@link WebCodecsEncoderSink.chunks}.
   */
  readonly onChunk?: (chunk: EncodedChunk) => void;
}

const DEFAULT_CODEC = "avc1.42001f";
const DEFAULT_BITRATE = 5_000_000;

/**
 * The minimal `VideoEncoder` surface this sink drives. Typed structurally (and
 * loosely) so this module imports cleanly in Node, where `VideoEncoder` does
 * not exist; the real browser `VideoEncoder` satisfies it.
 */
interface VideoEncoderLike {
  configure(config: unknown): void;
  encode(frame: unknown, opts?: unknown): void;
  flush(): Promise<void>;
  close(): void;
}

/**
 * A {@link FrameSink} that encodes frames with the browser `VideoEncoder`.
 *
 * Browser-only: constructing one throws if WebCodecs is unavailable, so callers
 * MUST gate on {@link isWebCodecsAvailable} and fall back to the PNG sequence in
 * Node / unsupported browsers. The driver never references this type unless the
 * gate passes.
 */
export class WebCodecsEncoderSink implements FrameSink {
  /** All encoded chunks, in frame order (also delivered via `onChunk`). */
  readonly chunks: EncodedChunk[] = [];

  private readonly opts: Required<Omit<WebCodecsEncoderOptions, "onChunk">> &
    Pick<WebCodecsEncoderOptions, "onChunk">;
  // Typed loosely (the real type is `VideoEncoder`) to stay Node-import-safe.
  private readonly encoder: VideoEncoderLike;

  constructor(options: WebCodecsEncoderOptions) {
    if (!isWebCodecsAvailable()) {
      throw new Error(
        "WebCodecsEncoderSink: VideoEncoder is unavailable in this environment; " +
          "gate on isWebCodecsAvailable() and use the PNG frame sequence fallback.",
      );
    }
    this.opts = {
      width: options.width,
      height: options.height,
      fps: options.fps,
      codec: options.codec ?? DEFAULT_CODEC,
      bitrate: options.bitrate ?? DEFAULT_BITRATE,
      onChunk: options.onChunk,
    };

    const g = globalThis as unknown as {
      VideoEncoder: new (init: {
        output: (chunk: unknown, meta: unknown) => void;
        error: (err: unknown) => void;
      }) => VideoEncoderLike;
    };

    let nextIndex = 0;
    this.encoder = new g.VideoEncoder({
      output: (chunk: unknown, meta: unknown) => {
        const encoded: EncodedChunk = { index: nextIndex++, chunk, meta };
        this.chunks.push(encoded);
        this.opts.onChunk?.(encoded);
      },
      error: (err: unknown) => {
        throw err instanceof Error ? err : new Error(String(err));
      },
    });

    this.encoder.configure({
      codec: this.opts.codec,
      width: this.opts.width,
      height: this.opts.height,
      bitrate: this.opts.bitrate,
      framerate: this.opts.fps,
    });
  }

  writeFrame(frame: CapturedFrame): void {
    const g = globalThis as unknown as {
      VideoFrame: new (
        data: BufferSource,
        init: {
          format: string;
          codedWidth: number;
          codedHeight: number;
          timestamp: number;
          duration: number;
        },
      ) => { close: () => void };
    };

    // Timestamps in microseconds, derived from the frame index for determinism.
    const timestamp = Math.round((frame.index / this.opts.fps) * 1_000_000);
    const duration = Math.round((1 / this.opts.fps) * 1_000_000);

    const videoFrame = new g.VideoFrame(frame.pixels as unknown as BufferSource, {
      format: "RGBA",
      codedWidth: frame.width,
      codedHeight: frame.height,
      timestamp,
      duration,
    });

    try {
      // Key the first frame so the stream is decodable from the start.
      this.encoder.encode(videoFrame, { keyFrame: frame.index === 0 });
    } finally {
      videoFrame.close();
    }
  }

  async finish(): Promise<void> {
    await this.encoder.flush();
    this.encoder.close();
  }
}
