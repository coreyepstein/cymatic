/**
 * V2-12 generative cinematic verification harness (real browser, real GPU pass —
 * no mocks).
 *
 * Drives a generative preset (flow field / reaction / plotter) through the public
 * preset lifecycle against the backend-agnostic {@link createRenderer}, threading
 * an explicit {@link DirectorState} into each `update` so a Playwright spec can:
 *   1. render a high-energy frame and assert the canvas is NOT blank and shows
 *      glow/bloom (bright halos → bright-pixel spread), and
 *   2. render the SAME preset under two different evolving director states
 *      (different palette crossfade + hue rotation) and assert the dominant
 *      color CHANGES — proving color evolves over a song.
 *
 * Honours whatever backend the browser provides (WebGPU where the bloom/glow/
 * feedback chain runs; WebGL otherwise). The spec reports the resolved backend.
 *
 * Identical shape to the V2-10/11 geometric + color-field harnesses so the e2e
 * specs stay parallel.
 */

import {
  createRendererWithFallback,
  defaultPresetRegistry,
  restingDirectorState,
  type AudioFeatureFrame,
  type DirectorState,
  type Preset,
  type Renderer,
} from "@cymatic/core";
// Import for the registration side-effect so presets resolve by id.
import "@cymatic/presets";

interface GenerativeHarness {
  /** Select a preset by id, building a fresh instance. */
  select(id: string): Promise<void>;
  /**
   * Render `frames` update steps with a loud audio frame and the given director
   * macro overrides, presenting the final frame. Resolves after the swapchain
   * presents.
   */
  renderWith(director: Partial<DirectorState>, loud: boolean, frames: number): Promise<void>;
  /** The resolved backend ("webgpu" | "webgl"). */
  backend(): string;
}

declare global {
  interface Window {
    __genHarness?: GenerativeHarness;
    __genHarnessReady?: boolean;
    __genHarnessError?: string;
  }
}

function loudFrame(time: number): AudioFeatureFrame {
  return {
    bands: new Array<number>(16).fill(0.85),
    bass: 0.9,
    mid: 0.7,
    treble: 0.85,
    rms: 0.8,
    onset: Math.floor(time * 4) % 2 === 0,
    spectralCentroid: 0.6,
    spectralRolloff: 0.6,
    spectralFlux: 0.4,
    loudnessShort: 0.8,
    loudnessLong: 0.8,
    dynamics: 0.5,
    tempo: 120,
    beatPhase: (time % 0.5) * 2,
    onsetDensity: 4,
    mood: { energy: 0.9, brightness: 0.7, busyness: 0.8, valence: 0.6, dynamics: 0.5 },
    time,
  };
}

function silentFrame(time: number): AudioFeatureFrame {
  return {
    bands: new Array<number>(16).fill(0),
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
    mood: { energy: 0, brightness: 0, busyness: 0, valence: 0, dynamics: 0 },
    time,
  };
}

async function boot(): Promise<void> {
  const canvas = document.getElementById("c") as HTMLCanvasElement | null;
  if (!canvas) throw new Error("generative-harness: canvas #c missing");

  // Create + init the renderer, transparently falling back to WebGL if the
  // WebGPU adapter/device can't be acquired (e.g. GPU-less CI runners), so the
  // harness BOOTS rather than boot-erroring. `backend()` reflects the real
  // post-fallback backend the spec then branches on.
  const renderer: Renderer = await createRendererWithFallback(canvas);
  renderer.resize(256, 256, 1);

  let preset: Preset | null = null;

  const harness: GenerativeHarness = {
    backend: () => renderer.backend,
    select: async (id: string): Promise<void> => {
      preset?.dispose();
      preset = defaultPresetRegistry.create(id);
      await preset.init({ renderer, width: 256, height: 256, dpr: 1 });
    },
    renderWith: async (
      directorOverride: Partial<DirectorState>,
      loud: boolean,
      frames: number,
    ): Promise<void> => {
      if (!preset) throw new Error("generative-harness: no preset selected");
      const director: DirectorState = { ...restingDirectorState(), ...directorOverride };
      let t = 0;
      for (let i = 0; i < frames; i++) {
        const f = loud ? loudFrame(t) : silentFrame(t);
        preset.update(f, t, 1 / 60, { director });
        t += 1 / 60;
      }
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    },
  };

  window.__genHarness = harness;
  window.__genHarnessReady = true;
}

boot().catch((err: unknown) => {
  window.__genHarnessError = err instanceof Error ? err.message : String(err);
  window.__genHarnessReady = true;
});
