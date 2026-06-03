/**
 * React hooks for @cymatic/react.
 *
 * These are a THIN wrapper over the @cymatic/core engine. All rendering and DSP
 * lives in core; the hooks here only manage the React lifecycle: wiring a
 * {@link Renderer}, an {@link AudioAnalyser}, a {@link RealtimeClock}, and a
 * chosen input adapter together inside an effect, driving `preset.update` each
 * frame, resizing on DPR / element-size changes, and tearing everything down on
 * unmount.
 *
 * SSR-safety: nothing in this module touches `window` / `document` /
 * `navigator` at import time or during render. Every browser access happens
 * inside {@link useEffect} / {@link useLayoutEffect}, which never run under Node
 * SSR. Importing this module in a Node context therefore cannot throw.
 */

import {
  AudioAnalyser,
  Director,
  RealtimeClock,
  connectElementSource,
  connectMicrophoneSource,
  createRenderer,
  playBufferSource,
  toRgba,
  ZERO_MOOD,
  restingDirectorState,
  type AnalyserOptions,
  type AudioFeatureFrame,
  type CreateRendererOptions,
  type DirectorState,
  type ParamSet,
  type Preset,
  type RenderCanvasLike,
  type Renderer,
} from "@cymatic/core";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

/**
 * `useLayoutEffect` warns when run during SSR (it cannot run on the server).
 * We only ever read layout / DOM here, and the component is `"use client"`, but
 * to stay import-safe under Node we fall back to `useEffect` when there is no
 * DOM. The selection happens at module init but reads `window` *guardedly*
 * (`typeof`), so it never throws under SSR.
 */
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** A decoded-buffer input. Mirrors the shape `playBufferSource` expects. */
export type AudioBufferInput = AudioBuffer;

/** Options accepted by {@link useVisualizer}. */
export interface UseVisualizerOptions {
  /** The preset instance to drive. Required. */
  preset: Preset;

  /**
   * Audio input. Provide exactly one of these. If none is provided the
   * visualizer still mounts and runs the render loop with empty feature frames
   * (useful for a preview / placeholder).
   */
  /** An `HTMLAudioElement` (or a ref to one) to analyse via a media-element source. */
  audioElement?: HTMLMediaElement | RefObject<HTMLMediaElement | null> | null;
  /** A media URL — an `<audio>` element is created, loaded, and analysed. */
  src?: string;
  /** When true, request the microphone and analyse it. */
  microphone?: boolean;
  /** A decoded `AudioBuffer` to play back and analyse. */
  audioBuffer?: AudioBufferInput;

  /** Tuning forwarded to the core {@link AudioAnalyser}. */
  analyser?: AnalyserOptions;
  /** Options forwarded to the core `createRenderer` (e.g. to force a backend in tests). */
  renderer?: CreateRendererOptions;

  /**
   * Invoked once per rendered frame with the current feature frame, before the
   * preset draws. A stable callback is recommended; it is read through a ref so
   * a changing identity does not restart the engine.
   */
  onFeatures?: (frame: AudioFeatureFrame) => void;

  /**
   * Invoked once per rendered frame with the current {@link DirectorState}
   * driving the preset — the live macro state when the auto-director is enabled,
   * or the resting state when it is off. Read through a ref so a changing
   * identity does not restart the engine. Lets a host render a director HUD.
   */
  onDirectorState?: (state: DirectorState) => void;

  /**
   * Enable the auto-director (V2-14). When `true` (default) a live
   * {@link "@cymatic/core".Director} evolves the look over the track; when
   * `false` the preset receives a deterministic resting state instead, so it
   * falls back to audio / manual params. Toggling does NOT tear down the engine.
   */
  directorEnabled?: boolean;

  /**
   * Seed for the auto-director's deterministic drift / palette generators
   * (V2-14). Changing it reseeds the director live (no engine teardown) so the
   * generated look changes. Ignored when {@link directorEnabled} is `false`.
   */
  directorSeed?: number;

  /** When true, the render loop is paused (clock stopped). Default `false`. */
  paused?: boolean;
}

/** Imperative handle + canvas ref returned by {@link useVisualizer}. */
export interface VisualizerHandle {
  /** Attach to the managed `<canvas>`. */
  canvasRef: RefObject<HTMLCanvasElement>;
  /** Whether the engine has finished async init and is rendering. */
  ready: boolean;
  /** The last error thrown during setup (e.g. mic denied, no GPU), if any. */
  error: Error | null;
  /** The most recent feature frame, or `null` before the first frame. */
  features: AudioFeatureFrame | null;
  /**
   * The active preset's {@link ParamSet} once the preset is mounted, or `null`
   * when the preset declares no params (V2-14). A host drives live parameter
   * controls through it (`getSchema` / `setManual` / `bind` / `getResolved`).
   */
  paramSet: ParamSet | null;
}

/** An empty, all-zero feature frame used when no audio input is wired. */
function silentFrame(time: number): AudioFeatureFrame {
  return {
    bands: [],
    bass: 0,
    mid: 0,
    treble: 0,
    rms: 0,
    onset: false,
    spectralCentroid: 0,
    spectralRolloff: 0,
    spectralFlux: 0,
    loudnessShort: 0,
    loudnessLong: 0,
    dynamics: 0,
    tempo: 0,
    beatPhase: 0,
    onsetDensity: 0,
    mood: ZERO_MOOD,
    time,
  };
}

/** Resolve an element-or-ref into the underlying element (or null). */
function resolveElement(
  input: HTMLMediaElement | RefObject<HTMLMediaElement | null> | null | undefined,
): HTMLMediaElement | null {
  if (input == null) return null;
  if (typeof (input as RefObject<HTMLMediaElement | null>).current !== "undefined") {
    return (input as RefObject<HTMLMediaElement | null>).current;
  }
  return input as HTMLMediaElement;
}

/**
 * Internal disposable describing a wired audio input: an analyser plus a
 * teardown. The various core adapters all expose an `analyser` + async
 * `dispose`, which this normalizes.
 */
interface WiredInput {
  analyser: AudioAnalyser;
  dispose: () => Promise<void> | void;
}

/**
 * The engine hook. Owns the full core wiring lifecycle and returns a canvas ref
 * plus a small handle. The React layer adds no rendering or DSP — it only
 * sequences core calls inside effects and cleans them up.
 */
export function useVisualizer(options: UseVisualizerOptions): VisualizerHandle {
  const {
    preset,
    audioElement,
    src,
    microphone,
    audioBuffer,
    analyser: analyserOptions,
    renderer: rendererOptions,
    onFeatures,
    onDirectorState,
    directorEnabled = true,
    directorSeed,
    paused = false,
  } = options;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [features, setFeatures] = useState<AudioFeatureFrame | null>(null);
  const [paramSet, setParamSet] = useState<ParamSet | null>(null);

  // Read mutable callbacks/preset through refs so their identity changing does
  // not tear down and re-create the GPU/audio graph every render.
  const onFeaturesRef = useRef(onFeatures);
  onFeaturesRef.current = onFeatures;
  const onDirectorStateRef = useRef(onDirectorState);
  onDirectorStateRef.current = onDirectorState;
  const presetRef = useRef(preset);
  presetRef.current = preset;

  // Director controls read through refs so toggling / reseeding does not rebuild
  // the GPU + audio graph; the frame loop reads the latest value each tick.
  const directorEnabledRef = useRef(directorEnabled);
  directorEnabledRef.current = directorEnabled;
  // The live Director instance for the current mount, so a seed change can reset
  // it without a teardown. Set inside the effect (SSR-safe).
  const directorRef = useRef<Director | null>(null);

  // The clock lives across renders so `paused` can start/stop it without a full
  // teardown. It is created lazily inside the effect (never at module/render
  // time, keeping SSR safe).
  const clockRef = useRef<RealtimeClock | null>(null);

  useIsomorphicLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas == null) return;

    let disposed = false;
    let renderer: Renderer | null = null;
    let wired: WiredInput | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let createdAudioEl: HTMLAudioElement | null = null;
    const clock = new RealtimeClock();
    clockRef.current = clock;

    // The auto-director evolves the look over a whole track (intensity, motion,
    // density, crossfading palette, hue rotation). It lives across frames for
    // this mount, advances deterministically on the frame `dt`, and its state is
    // threaded into every `preset.update(...)`. Cinematic presets read it; older
    // presets that ignore the 4th arg are unaffected.
    const director = new Director(
      typeof directorSeed === "number" ? { seed: directorSeed } : {},
    );
    directorRef.current = director;

    let lastTime = 0;

    const applyResize = (): void => {
      if (renderer == null || disposed) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const cssWidth = rect.width || canvas.clientWidth || 0;
      const cssHeight = rect.height || canvas.clientHeight || 0;
      renderer.resize(cssWidth, cssHeight, dpr);
      const { width, height } = renderer.drawingBufferSize;
      presetRef.current.resize(width, height, dpr);
    };

    const wireInput = async (): Promise<WiredInput | null> => {
      const el = resolveElement(audioElement);
      if (el != null) {
        const s = connectElementSource(el, analyserOptions);
        return { analyser: s.analyser, dispose: s.dispose };
      }
      if (typeof src === "string" && src.length > 0) {
        const audio = document.createElement("audio");
        audio.src = src;
        audio.crossOrigin = "anonymous";
        audio.loop = true;
        createdAudioEl = audio;
        const s = connectElementSource(audio, analyserOptions);
        // Best-effort autoplay; browsers may block until a user gesture.
        void audio.play().catch(() => {
          /* autoplay blocked — host can start playback via a gesture */
        });
        return { analyser: s.analyser, dispose: s.dispose };
      }
      if (audioBuffer != null) {
        const s = playBufferSource(audioBuffer, analyserOptions);
        try {
          s.source.start();
        } catch {
          /* already started — ignore */
        }
        return { analyser: s.analyser, dispose: s.dispose };
      }
      if (microphone === true) {
        const s = await connectMicrophoneSource(analyserOptions);
        return { analyser: s.analyser, dispose: s.dispose };
      }
      return null;
    };

    const frame = (): void => {
      if (renderer == null || disposed) return;
      const time = clock.now();
      const dt = Math.max(0, time - lastTime);
      lastTime = time;

      const wiredInput = wired;
      let featureFrame: AudioFeatureFrame;
      if (wiredInput != null && wiredInput.analyser.analyserNode != null) {
        featureFrame = wiredInput.analyser.read(time);
      } else {
        featureFrame = silentFrame(time);
      }

      onFeaturesRef.current?.(featureFrame);
      setFeatures(featureFrame);
      // Advance the director on this frame's audio + dt when enabled, then
      // thread its macro state into the preset so cinematic presets evolve over
      // the track. When the auto-director is off, hand the preset a
      // deterministic resting state so it falls back to audio / manual params.
      // The director is still advanced (cheap, deterministic) so re-enabling
      // resumes from where the song is rather than snapping.
      const live = director.update(featureFrame, dt);
      const directorState: DirectorState = directorEnabledRef.current
        ? live
        : restingDirectorState(live.seed);
      onDirectorStateRef.current?.(directorState);
      presetRef.current.update(featureFrame, time, dt, { director: directorState });
    };

    // Create a renderer and initialize it, transparently falling back to the
    // WebGL backend if a WebGPU renderer fails to come up at runtime. WebGPU can
    // be selected (because `navigator.gpu` exists) yet still fail in `init()` —
    // e.g. the adapter is blocklisted or device creation rejects. In that case
    // we dispose the dead renderer and rebuild forcing WebGL. A failure here is
    // a genuine *renderer* error (surfaced as-is), never a microphone error.
    const createInitializedRenderer = async (): Promise<Renderer> => {
      const canvasLike = canvas as unknown as RenderCanvasLike;
      const r = createRenderer(canvasLike, rendererOptions);
      try {
        await r.init();
        return r;
      } catch (initErr) {
        // Only the WebGPU path is worth retrying — a WebGL failure is terminal.
        if (r.backend !== "webgpu") throw initErr;
        r.dispose();
        const fallback = createRenderer(canvasLike, {
          ...rendererOptions,
          backend: "webgl",
        });
        await fallback.init();
        return fallback;
      }
    };

    const setup = async (): Promise<void> => {
      try {
        renderer = await createInitializedRenderer();
        if (disposed) return;

        applyResize();
        // Prime the frame so the preset has a non-empty surface before audio.
        renderer.beginFrame(toRgba({ r: 0, g: 0, b: 0, a: 1 }));
        renderer.endFrame();

        await presetRef.current.init({
          renderer,
          width: renderer.drawingBufferSize.width,
          height: renderer.drawingBufferSize.height,
          dpr: window.devicePixelRatio || 1,
        });
        if (disposed) return;

        // Surface the preset's ParamSet (if any) so a host can drive live
        // parameter controls. Read after init so a preset that builds it lazily
        // is captured. Null for presets that declare no params.
        setParamSet(presetRef.current.paramSet ?? null);

        wired = await wireInput();
        if (disposed) {
          // The input may have been wired after we were torn down.
          await wired?.dispose();
          wired = null;
          return;
        }

        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(() => applyResize());
          resizeObserver.observe(canvas);
        }

        clock.subscribe(frame);
        if (!paused) clock.start();

        setReady(true);
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    };

    void setup();

    return () => {
      disposed = true;
      clock.stop();
      clockRef.current = null;
      directorRef.current = null;
      resizeObserver?.disconnect();
      void wired?.dispose();
      renderer?.dispose();
      if (createdAudioEl != null) {
        createdAudioEl.pause();
        createdAudioEl.removeAttribute("src");
        createdAudioEl.load();
      }
      setParamSet(null);
      setReady(false);
    };
    // The engine is rebuilt only when the *kind* of input or core options
    // change. Callback / preset identity changes are absorbed via refs above.
    // (react-hooks/exhaustive-deps is intentionally not part of this repo's
    // flat config; the dependency list below is curated by hand.)
  }, [
    audioElement,
    src,
    microphone,
    audioBuffer,
    analyserOptions,
    rendererOptions,
  ]);

  // Pause / resume without tearing down the GPU + audio graph.
  useEffect(() => {
    const clock = clockRef.current;
    if (clock == null) return;
    if (paused) {
      clock.stop();
    } else if (ready && !clock.running) {
      clock.start();
    }
  }, [paused, ready]);

  // Reseed the live director when `directorSeed` changes — no engine teardown,
  // so the generated look re-rolls while audio + GPU keep running. `ready` is a
  // dep so a seed set before the director exists is applied once it is up.
  useEffect(() => {
    if (typeof directorSeed !== "number") return;
    directorRef.current?.reset(directorSeed);
  }, [directorSeed, ready]);

  return { canvasRef, ready, error, features, paramSet };
}

/**
 * A convenience hook for custom UIs that only want to read the current feature
 * frame produced by a {@link useVisualizer} instance. Pass the handle returned
 * by {@link useVisualizer}; it simply surfaces `handle.features`.
 *
 * Most consumers prefer the `onFeatures` callback (no re-render per frame); this
 * hook is offered for declarative read-access where a render per frame is
 * acceptable.
 */
export function useAudioFeatures(handle: VisualizerHandle): AudioFeatureFrame | null {
  return handle.features;
}

/** Default styling for the managed canvas (fills its container). */
export const defaultCanvasStyle: CSSProperties = {
  display: "block",
  width: "100%",
  height: "100%",
};

/** Re-exported so consumers can build their own `onFeatures` handlers typed. */
export type { AudioFeatureFrame, Preset } from "@cymatic/core";
