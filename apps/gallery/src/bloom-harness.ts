/**
 * V2-02 bloom verification harness (real browser, real GPU pass — no mocks).
 *
 * Drives the backend-agnostic {@link createRenderer} directly: it paints a
 * single bright rect on a dark background through the post chain and exposes
 * `window.__bloomHarness.renderOnce(bloomEnabled)` so a Playwright spec can
 * capture the canvas with bloom OFF vs ON and measure the glow delta.
 *
 * The harness honours whatever backend the browser provides — WebGPU when
 * available (where the bloom chain runs) or WebGL (where post-FX is a no-op and
 * the two captures are identical). The spec reports the resolved backend and
 * only asserts a visible delta when WebGPU actually ran.
 */

import { createRenderer, type Renderer, type RgbaColor } from "@cymatic/core";

interface BloomHarness {
  /** Render one frame with bloom on/off; resolves after the GPU work submits. */
  renderOnce(bloomEnabled: boolean): Promise<void>;
  /** The resolved backend ("webgpu" | "webgl"). */
  backend(): string;
}

declare global {
  interface Window {
    __bloomHarness?: BloomHarness;
    __bloomHarnessReady?: boolean;
    __bloomHarnessError?: string;
  }
}

const BACKGROUND: RgbaColor = { r: 0.01, g: 0.01, b: 0.02, a: 1 };
/** A small, very bright rect in the center — well above the bloom threshold. */
const BRIGHT: RgbaColor = { r: 6, g: 6, b: 6, a: 1 };

async function boot(): Promise<void> {
  const canvas = document.getElementById("c") as HTMLCanvasElement | null;
  if (!canvas) throw new Error("bloom-harness: canvas #c missing");

  const renderer: Renderer = createRenderer(canvas);
  await renderer.init();
  // 256×256 backing store at DPR 1 keeps the capture math simple.
  renderer.resize(256, 256, 1);

  const drawScene = (): void => {
    renderer.beginFrame(BACKGROUND);
    // A centered bright square (~20% of the frame) whose highlights bleed.
    renderer.drawRect({ x: 0.4, y: 0.4, w: 0.2, h: 0.2, color: BRIGHT });
    renderer.endFrame();
  };

  const harness: BloomHarness = {
    backend: () => renderer.backend,
    renderOnce: async (bloomEnabled: boolean): Promise<void> => {
      // A strong, tasteful glow when on; vignette off so it can't confound the
      // luminance-ring measurement around the highlight.
      renderer.setPostEffects({
        exposure: 1,
        bloom: bloomEnabled
          ? { enabled: true, threshold: 0.7, intensity: 1.2, radius: 2 }
          : { enabled: false },
        vignette: { enabled: false },
      });
      drawScene();
      // Yield a frame so the compositor presents the swapchain before capture.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    },
  };

  window.__bloomHarness = harness;
  window.__bloomHarnessReady = true;
}

boot().catch((err: unknown) => {
  window.__bloomHarnessError =
    err instanceof Error ? err.message : String(err);
  window.__bloomHarnessReady = true;
});
