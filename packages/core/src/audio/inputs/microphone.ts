/**
 * Input adapter: drive an {@link AudioAnalyser} from the user's microphone via
 * `getUserMedia` + a `MediaStreamAudioSourceNode`.
 *
 * Browser-only at runtime; importing in Node is harmless because the async
 * `connectMicrophoneSource` function is what touches the platform APIs.
 */

import { AudioAnalyser, type AnalyserOptions } from "../analyser.js";

/** Handle returned by {@link connectMicrophoneSource}. */
export interface MicrophoneSource {
  /** The analyser producing feature frames. */
  analyser: AudioAnalyser;
  /** The `AudioContext` created for this source. */
  context: AudioContext;
  /** The captured media stream (stop its tracks to release the mic). */
  stream: MediaStream;
  /** The stream source node feeding the analyser. */
  source: MediaStreamAudioSourceNode;
  /** Stop the mic, disconnect nodes, and close the context. */
  dispose: () => Promise<void>;
}

/**
 * Request microphone access and connect it to a new analyser.
 *
 * The mic is intentionally *not* routed to `destination` (that would echo the
 * user back to themselves).
 *
 * @param constraints Audio constraints forwarded to `getUserMedia`. Defaults
 *   disable echo-cancellation/AGC/noise-suppression so the analysed signal is
 *   faithful to the source.
 */
export async function connectMicrophoneSource(
  options: AnalyserOptions = {},
  constraints: MediaStreamConstraints = {
    audio: {
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: false,
    },
  },
  context: AudioContext = new AudioContext(),
): Promise<MicrophoneSource> {
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const analyser = new AudioAnalyser(options);
  const source = context.createMediaStreamSource(stream);
  const node = analyser.attach(context, source);

  return {
    analyser,
    context,
    stream,
    source,
    dispose: async () => {
      for (const track of stream.getTracks()) track.stop();
      source.disconnect();
      node.disconnect();
      await context.close();
    },
  };
}
