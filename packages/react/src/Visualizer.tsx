"use client";

/**
 * `<Visualizer />` — a managed-canvas React component for the cymatic engine.
 *
 * It is a THIN wrapper: it renders a single `<canvas>` and delegates the entire
 * engine lifecycle to {@link useVisualizer}. No rendering or DSP lives here.
 *
 * SSR-safety: this module touches no browser globals at import time or during
 * render. All `window` / `document` / `navigator` access is confined to the
 * effects inside {@link useVisualizer}, so importing or server-rendering this
 * component under Node never throws.
 */

import { forwardRef, useImperativeHandle, type CSSProperties } from "react";

import {
  defaultCanvasStyle,
  useVisualizer,
  type AudioBufferInput,
  type UseVisualizerOptions,
  type VisualizerHandle,
} from "./hooks.js";
import type {
  AnalyserOptions,
  AudioFeatureFrame,
  CreateRendererOptions,
  DirectorState,
  ParamSet,
  Preset,
} from "@cymatic/core";

/** Props for {@link Visualizer}. */
export interface VisualizerProps {
  /** The preset to render. Required. */
  preset: Preset;

  /** Provide exactly one audio input (or none for an idle preview). */
  audioElement?: UseVisualizerOptions["audioElement"];
  /** A media URL to load and analyse. */
  src?: string;
  /** Toggle microphone capture. */
  microphone?: boolean;
  /** A decoded `AudioBuffer` to play back and analyse. */
  audioBuffer?: AudioBufferInput;

  /** Analyser tuning forwarded to the core engine. */
  analyser?: AnalyserOptions;
  /** Renderer options forwarded to core `createRenderer` (e.g. forced backend). */
  renderer?: CreateRendererOptions;

  /** Per-frame feature callback. */
  onFeatures?: (frame: AudioFeatureFrame) => void;
  /** Per-frame director-state callback (for a director HUD). */
  onDirectorState?: (state: DirectorState) => void;
  /** Enable the auto-director (default `true`); when off, params fall back to audio/manual. */
  directorEnabled?: boolean;
  /** Seed for the director's deterministic drift; changing it reseeds live. */
  directorSeed?: number;
  /** Pause / resume the render loop. */
  paused?: boolean;

  /** Class applied to the managed canvas. */
  className?: string;
  /** Inline style merged over the default (block, 100% w/h). */
  style?: CSSProperties;
  /** Accessible label for the canvas. */
  ariaLabel?: string;
}

/**
 * The imperative handle exposed via `ref`. Mirrors the {@link VisualizerHandle}
 * fields a parent may want, minus the internal canvas ref (the component owns
 * the canvas).
 */
export interface VisualizerRef {
  /** Whether the engine is rendering. */
  ready: boolean;
  /** The last setup error, if any. */
  error: Error | null;
  /** The most recent feature frame. */
  features: AudioFeatureFrame | null;
  /**
   * The active preset's {@link ParamSet} (or `null` if it declares no params).
   * A host drives live parameter controls through it (V2-14).
   */
  paramSet: ParamSet | null;
}

export const Visualizer = forwardRef<VisualizerRef, VisualizerProps>(function Visualizer(
  props,
  ref,
) {
  const {
    preset,
    audioElement,
    src,
    microphone,
    audioBuffer,
    analyser,
    renderer,
    onFeatures,
    onDirectorState,
    directorEnabled,
    directorSeed,
    paused,
    className,
    style,
    ariaLabel,
  } = props;

  const handle: VisualizerHandle = useVisualizer({
    preset,
    audioElement,
    src,
    microphone,
    audioBuffer,
    analyser,
    renderer,
    onFeatures,
    onDirectorState,
    directorEnabled,
    directorSeed,
    paused,
  });

  useImperativeHandle(
    ref,
    () => ({
      ready: handle.ready,
      error: handle.error,
      features: handle.features,
      paramSet: handle.paramSet,
    }),
    [handle.ready, handle.error, handle.features, handle.paramSet],
  );

  return (
    <canvas
      ref={handle.canvasRef}
      className={className}
      style={{ ...defaultCanvasStyle, ...style }}
      aria-label={ariaLabel}
      role="img"
    />
  );
});
