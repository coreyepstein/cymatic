/**
 * Input adapter: drive an {@link AudioAnalyser} from a decoded `AudioBuffer`.
 *
 * Two modes:
 *  - Realtime playback (`playBufferSource`) using a live `AudioContext` and an
 *    `AudioBufferSourceNode`, suitable for visualizing decoded files as they
 *    play.
 *  - Offline rendering hooks via an `OfflineAudioContext` for deterministic,
 *    faster-than-realtime feature extraction.
 *
 * Browser/Web-Audio only at runtime; safe to import in Node.
 */

import { AudioAnalyser, type AnalyserOptions } from "../analyser.js";

/** Handle returned by {@link playBufferSource}. */
export interface BufferSource {
  /** The analyser producing feature frames. */
  analyser: AudioAnalyser;
  /** The `AudioContext` driving playback. */
  context: AudioContext;
  /** The buffer source node (call `.start()` to begin playback). */
  source: AudioBufferSourceNode;
  /** Stop playback, disconnect nodes, and close the context. */
  dispose: () => Promise<void>;
}

/**
 * Wire a decoded `AudioBuffer` to a new analyser for realtime playback.
 *
 * Does not auto-start; call `source.start()` (or pass it to your scheduler) to
 * begin. The analyser is routed to `destination` so the buffer is audible.
 */
export function playBufferSource(
  buffer: AudioBuffer,
  options: AnalyserOptions = {},
  context: AudioContext = new AudioContext(),
): BufferSource {
  const analyser = new AudioAnalyser(options);
  const source = context.createBufferSource();
  source.buffer = buffer;
  const node = analyser.attach(context, source);
  node.connect(context.destination);

  return {
    analyser,
    context,
    source,
    dispose: async () => {
      try {
        source.stop();
      } catch {
        // already stopped — ignore
      }
      source.disconnect();
      node.disconnect();
      await context.close();
    },
  };
}

/**
 * Decode raw encoded audio (e.g. the contents of an `ArrayBuffer` from a fetch)
 * into an `AudioBuffer` using the given context.
 */
export async function decodeAudioData(
  data: ArrayBuffer,
  context: AudioContext = new AudioContext(),
): Promise<AudioBuffer> {
  return context.decodeAudioData(data);
}
