/**
 * V2-04 feedback / trail verification harness (real browser, real GPU — no mocks).
 *
 * Drives the backend-agnostic {@link createRenderer} directly and exposes
 * `window.__feedbackHarness.runSequence(feedbackEnabled)` so a Playwright spec
 * can move a single bright glow ACROSS several frames and capture the FINAL
 * frame's compositor pixels:
 *
 *   - feedback ON (decay ~0.9): the moving glow leaves a luminous TRAIL — pixels
 *     along the past path stay lit and fade with distance behind the current
 *     position.
 *   - feedback OFF: only the current glow position is lit; the past path is
 *     background-dark.
 *
 * The glow travels left→right along the vertical center over N frames. After the
 * sequence the last frame is presented and the spec captures it, measuring the
 * luminance profile along the path BEHIND the final position.
 *
 * Backend-aware: WebGPU runs the real feedback chain (history ping-pong). WebGL
 * treats feedback as a documented no-op, so the trail is absent there; the spec
 * reports the resolved backend and only asserts a trail when WebGPU ran.
 */

import { createRendererWithFallback, type Renderer, type RgbaColor } from "@cymatic/core";

interface FeedbackHarness {
  /**
   * Render the full moving-glow sequence with feedback on/off and present the
   * final frame; resolves after the GPU work submits + the compositor presents.
   */
  runSequence(feedbackEnabled: boolean): Promise<void>;
  /** The number of frames in the sequence (so the spec knows the path geometry). */
  frameCount(): number;
  /** Start/end normalized x of the glow path + its y (for the spec's measurements). */
  path(): { x0: number; x1: number; y: number; radius: number };
  /** The resolved backend ("webgpu" | "webgl"). */
  backend(): string;
}

declare global {
  interface Window {
    __feedbackHarness?: FeedbackHarness;
    __feedbackHarnessReady?: boolean;
    __feedbackHarnessError?: string;
  }
}

const BACKGROUND: RgbaColor = { r: 0.01, g: 0.01, b: 0.02, a: 1 };
/** A bright HDR glow so the trail is clearly above background after decaying. */
const GLOW_COLOR: RgbaColor = { r: 1, g: 0.95, b: 0.9, a: 1 };

/** Sequence geometry: the glow steps left→right along the vertical center. */
const FRAMES = 8;
const PATH = { x0: 0.2, x1: 0.8, y: 0.5, radius: 0.06 } as const;
const DECAY = 0.9;

async function boot(): Promise<void> {
  const canvas = document.getElementById("c") as HTMLCanvasElement | null;
  if (!canvas) throw new Error("feedback-harness: canvas #c missing");

  // Create + init the renderer, transparently falling back to WebGL if the
  // WebGPU adapter/device can't be acquired (e.g. GPU-less CI runners), so the
  // harness BOOTS rather than boot-erroring. `backend()` reflects the real
  // post-fallback backend the spec then branches on.
  const renderer: Renderer = await createRendererWithFallback(canvas);
  // 256×256 backing store at DPR 1 keeps the capture math simple.
  renderer.resize(256, 256, 1);

  /** Draw frame `i` of the sequence: one glow at the i-th position along the path. */
  const drawFrame = (i: number): void => {
    const t = FRAMES <= 1 ? 0 : i / (FRAMES - 1);
    const x = PATH.x0 + (PATH.x1 - PATH.x0) * t;
    renderer.beginFrame(BACKGROUND);
    renderer.drawGlow({
      x,
      y: PATH.y,
      radius: PATH.radius,
      color: GLOW_COLOR,
      intensity: 3,
    });
    renderer.endFrame();
  };

  const harness: FeedbackHarness = {
    backend: () => renderer.backend,
    frameCount: () => FRAMES,
    path: () => ({ ...PATH }),
    runSequence: async (feedbackEnabled: boolean): Promise<void> => {
      // Keep bloom + vignette off so the only spreading is the feedback trail —
      // bloom would bleed the CURRENT glow symmetrically and confound the
      // "trail is BEHIND the glow" measurement; vignette would darken edges.
      renderer.setPostEffects({
        exposure: 1,
        bloom: { enabled: false },
        vignette: { enabled: false },
        feedback: feedbackEnabled
          ? { enabled: true, decay: DECAY }
          : { enabled: false },
      });
      // Render the whole sequence. With feedback ON, each frame's history is the
      // decayed accumulation of all prior frames, so the FINAL frame carries the
      // full trail. We submit each frame back-to-back (no intermediate present
      // is required for the history to advance — endFrame submits + flips).
      for (let i = 0; i < FRAMES; i++) {
        drawFrame(i);
      }
      // Yield two frames so the compositor presents the final swapchain image
      // before the spec captures it.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    },
  };

  window.__feedbackHarness = harness;
  window.__feedbackHarnessReady = true;
}

boot().catch((err: unknown) => {
  window.__feedbackHarnessError = err instanceof Error ? err.message : String(err);
  window.__feedbackHarnessReady = true;
});
