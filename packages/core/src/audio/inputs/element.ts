/**
 * Input adapter: drive an {@link AudioAnalyser} from an `HTMLAudioElement`
 * (or `HTMLVideoElement`) via a `MediaElementAudioSourceNode`.
 *
 * Browser-only at runtime (constructs an `AudioContext`), but importing the
 * module in Node is harmless because nothing runs until `connectElementSource`
 * is invoked.
 */

import { AudioAnalyser, type AnalyserOptions } from "../analyser.js";

/** Handle returned by {@link connectElementSource}. */
export interface ElementSource {
  /** The analyser producing feature frames. */
  analyser: AudioAnalyser;
  /** The `AudioContext` created for this source. */
  context: AudioContext;
  /** The media-element source node feeding the analyser. */
  source: MediaElementAudioSourceNode;
  /** Disconnect nodes and close the context. */
  dispose: () => Promise<void>;
}

/**
 * Connect an `<audio>`/`<video>` element to a new analyser.
 *
 * The analyser is also routed to `context.destination` so the element keeps
 * playing audibly while being analysed.
 */
export function connectElementSource(
  element: HTMLMediaElement,
  options: AnalyserOptions = {},
  context: AudioContext = new AudioContext(),
): ElementSource {
  const analyser = new AudioAnalyser(options);
  const source = context.createMediaElementSource(element);
  const node = analyser.attach(context, source);
  node.connect(context.destination);

  return {
    analyser,
    context,
    source,
    dispose: async () => {
      source.disconnect();
      node.disconnect();
      await context.close();
    },
  };
}
