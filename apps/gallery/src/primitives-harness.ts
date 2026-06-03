/**
 * V2-03 rich-primitives verification harness (real browser, real GPU — no mocks).
 *
 * Drives the backend-agnostic {@link createRenderer} directly and exposes
 * `window.__primHarness.render(kind)` so a Playwright spec can paint ONE of the
 * new primitives and measure real compositor pixels:
 *
 *   - "gradient": a horizontal red→blue linear gradient filling the frame. The
 *     spec asserts a measurable color ramp across x (left red-ish, right blue-ish).
 *   - "glow": a single bright additive glow centered in the frame. The spec
 *     asserts a soft falloff — center brighter than the edge, smooth ring.
 *   - "line": a thick bright diagonal line. The spec asserts pixels ALONG the
 *     line are lit while a parallel off-line band is dark.
 *
 * Backend-aware: WebGPU runs the real per-pixel pipelines; WebGL falls back to
 * the documented solid-color approximations (still lit, still a ramp/blob/line).
 * The spec reports the resolved backend and tunes its thresholds accordingly.
 */

import { createRendererWithFallback, type Renderer, type RgbaColor } from "@cymatic/core";

type Primitive = "gradient" | "glow" | "line";

interface PrimHarness {
  /** Render one frame of `kind`; resolves after the GPU work submits. */
  render(kind: Primitive): Promise<void>;
  /** The resolved backend ("webgpu" | "webgl"). */
  backend(): string;
}

declare global {
  interface Window {
    __primHarness?: PrimHarness;
    __primHarnessReady?: boolean;
    __primHarnessError?: string;
  }
}

const BACKGROUND: RgbaColor = { r: 0.01, g: 0.01, b: 0.02, a: 1 };

async function boot(): Promise<void> {
  const canvas = document.getElementById("c") as HTMLCanvasElement | null;
  if (!canvas) throw new Error("primitives-harness: canvas #c missing");

  // Create + init the renderer, transparently falling back to WebGL if the
  // WebGPU adapter/device can't be acquired (e.g. GPU-less CI runners), so the
  // harness BOOTS rather than boot-erroring. `backend()` reflects the real
  // post-fallback backend the spec then branches on.
  const renderer: Renderer = await createRendererWithFallback(canvas);
  renderer.resize(256, 256, 1);
  // Keep post-FX neutral so the primitive's own pixels are what we measure
  // (no bloom spreading the line/gradient, no vignette darkening the edges).
  renderer.setPostEffects({
    exposure: 1,
    bloom: { enabled: false },
    vignette: { enabled: false },
  });

  const drawGradient = (): void => {
    renderer.beginFrame(BACKGROUND);
    renderer.drawGradientRect(
      { x: 0, y: 0, w: 1, h: 1, color: { r: 0, g: 0, b: 0, a: 1 } },
      { from: { r: 1, g: 0, b: 0, a: 1 }, to: { r: 0, g: 0, b: 1, a: 1 }, angle: 0 },
    );
    renderer.endFrame();
  };

  const drawGlow = (): void => {
    renderer.beginFrame(BACKGROUND);
    // A single soft glow in the center; intensity>1 for a bright HDR core.
    renderer.drawGlow({
      x: 0.5,
      y: 0.5,
      radius: 0.35,
      color: { r: 1, g: 0.9, b: 0.8, a: 1 },
      intensity: 2.5,
    });
    renderer.endFrame();
  };

  const drawLine = (): void => {
    renderer.beginFrame(BACKGROUND);
    // A thick bright horizontal line across the vertical center.
    renderer.drawLine({
      x0: 0.1,
      y0: 0.5,
      x1: 0.9,
      y1: 0.5,
      width: 0.08,
      color: { r: 1, g: 1, b: 1, a: 1 },
    });
    renderer.endFrame();
  };

  const harness: PrimHarness = {
    backend: () => renderer.backend,
    render: async (kind: Primitive): Promise<void> => {
      if (kind === "gradient") drawGradient();
      else if (kind === "glow") drawGlow();
      else drawLine();
      // Yield two frames so the compositor presents the swapchain before capture.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    },
  };

  window.__primHarness = harness;
  window.__primHarnessReady = true;
}

boot().catch((err: unknown) => {
  window.__primHarnessError = err instanceof Error ? err.message : String(err);
  window.__primHarnessReady = true;
});
