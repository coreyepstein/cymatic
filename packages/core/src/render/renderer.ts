/**
 * Backend-agnostic renderer surface for @cymatic/core.
 *
 * Presets and the rest of the engine target the {@link Renderer} interface and
 * the small {@link Scene} / {@link RenderFeatures} value types defined here.
 * They MUST NOT branch on WebGPU vs WebGL — the concrete backend is chosen once
 * by {@link createRenderer} and hidden behind this interface. A backend only has
 * to honour the surface; richer drawing primitives arrive in a later story.
 *
 * The current capability is deliberately minimal but real: clear/fill the
 * frame to a color. That is enough to prove both backends end-to-end (the
 * "smoke scene") while keeping the abstraction honest — nothing here leaks a
 * raw `GPUDevice` or `WebGLRenderingContext`.
 */

import {
  defaultHasWebgl,
  detectEnvironment,
  selectBackend,
  type BackendSelection,
  type GpuLike,
  type RendererBackend,
  type RendererEnvironment,
} from "./capabilities.js";
import {
  WebglRenderer,
  type WebglCanvasLike,
} from "./webgl/webgl-renderer.js";
import {
  WebgpuRenderer,
  type GpuNavigatorLike,
  type WebgpuCanvasLike,
} from "./webgpu/webgpu-renderer.js";

/** An RGBA color with channels in the `[0, 1]` range. */
export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  /** Alpha, defaults to fully opaque when omitted by a producer. */
  a: number;
}

/**
 * A backend-agnostic description of what to draw for a frame. For this story a
 * scene is just a background/clear color (the "solid fill" smoke scene); later
 * stories extend it with layers and primitives without changing the
 * {@link Renderer} contract's shape.
 */
export interface Scene {
  /** Color the frame is cleared/filled to. */
  background: RgbaColor;
}

/**
 * Audio-derived, per-frame inputs handed to the renderer. Kept opaque and
 * backend-neutral here; presets read these to modulate a scene. For the smoke
 * scene it is unused, but it is part of the per-frame contract so presets have
 * a stable signature across backends.
 */
export interface RenderFeatures {
  /** Overall loudness in `[0, 1]`, if available. */
  level?: number;
  /** Per-band energies in `[0, 1]`, if available. */
  bands?: readonly number[];
}

/** The pixel size of a renderer's backing store (post-DPR). */
export interface DrawingBufferSize {
  width: number;
  height: number;
}

/**
 * An axis-aligned rectangle expressed in normalized device coordinates: the
 * frame spans `x: [0, 1]` (left→right) and `y: [0, 1]` (top→bottom), so the
 * surface is resolution-independent and presets never deal in pixels. `w`/`h`
 * are normalized extents. This is the one backend-agnostic shape primitive the
 * Renderer understands; richer geometry composes from it.
 */
export interface NormalizedRect {
  /** Left edge, normalized `[0, 1]`. */
  x: number;
  /** Top edge, normalized `[0, 1]`. */
  y: number;
  /** Width, normalized `[0, 1]`. */
  w: number;
  /** Height, normalized `[0, 1]`. */
  h: number;
  /** Fill color. */
  color: RgbaColor;
}

/**
 * The backend-agnostic renderer. One instance owns a canvas's drawing context,
 * the backing-store sizing, and per-frame submission. Presets only ever see
 * this surface.
 */
export interface Renderer {
  /** Which concrete backend is in use. Informational only — do not branch on it. */
  readonly backend: RendererBackend;

  /**
   * Acquire the drawing context / device. Idempotent; resolves once the
   * renderer is ready to {@link render}.
   */
  init(): Promise<void>;

  /**
   * Resize the backing store. `cssWidth`/`cssHeight` are CSS pixels (layout
   * size); `dpr` is the device-pixel-ratio. Backing-store pixels are computed
   * via {@link computeDrawingBufferSize}.
   */
  resize(cssWidth: number, cssHeight: number, dpr: number): void;

  /** The current backing-store pixel size. */
  readonly drawingBufferSize: DrawingBufferSize;

  /**
   * Render one frame of `scene`, modulated by `features`, at time `timeSeconds`.
   * For the smoke scene this clears the frame to `scene.background`.
   *
   * This remains the simplest entry point (a solid fill). Presets that need to
   * draw primitives use the imperative frame API below
   * ({@link beginFrame}/{@link drawRect}/{@link endFrame}) instead.
   */
  render(scene: Scene, features: RenderFeatures, timeSeconds: number): void;

  /**
   * Open a frame, clearing the backing store to `background`. Pairs with
   * {@link endFrame}. Between the two, issue draw primitives like
   * {@link drawRect}. Backend-agnostic: presets never see the underlying pass /
   * GL state this sets up.
   */
  beginFrame(background: RgbaColor): void;

  /**
   * Draw a filled, axis-aligned rectangle in normalized device coordinates.
   * Must be called between {@link beginFrame} and {@link endFrame}. This is the
   * single shape primitive every backend implements; geometric / color-field /
   * particle preset packs compose their output from many of these.
   */
  drawRect(rect: NormalizedRect): void;

  /** Close the frame opened by {@link beginFrame}, submitting all draws. */
  endFrame(): void;

  /** Release GPU/GL resources. Idempotent. */
  dispose(): void;
}

/**
 * Compute backing-store pixel dimensions from a CSS (layout) size and a
 * device-pixel-ratio. Pure helper, shared by both backends so DPR/resize math
 * lives in exactly one tested place.
 *
 * Rules: clamp `dpr` to at least 1, clamp CSS size to non-negative, and round
 * to whole device pixels (a backing store is integer-sized). A zero CSS
 * dimension yields a zero backing dimension.
 */
export function computeDrawingBufferSize(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): DrawingBufferSize {
  const ratio = Number.isFinite(dpr) && dpr > 1 ? dpr : 1;
  const w = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : 0;
  const h = Number.isFinite(cssHeight) && cssHeight > 0 ? cssHeight : 0;
  return {
    width: Math.round(w * ratio),
    height: Math.round(h * ratio),
  };
}

/** Normalize a partial color into a fully-specified opaque-by-default RGBA. */
export function toRgba(color: Partial<RgbaColor>): RgbaColor {
  return {
    r: clampChannel(color.r),
    g: clampChannel(color.g),
    b: clampChannel(color.b),
    a: color.a == null ? 1 : clampChannel(color.a),
  };
}

function clampChannel(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** A canvas usable by either backend (the union of both backends' needs). */
export type RenderCanvasLike = WebglCanvasLike & WebgpuCanvasLike;

/** Options for {@link createRenderer}. */
export interface CreateRendererOptions {
  /**
   * The environment to select a backend from. Defaults to the ambient browser
   * environment; inject a {@link RendererEnvironment} to force a backend in
   * tests (e.g. `{ gpu }` for WebGPU, `{ hasWebgl: () => true }` for WebGL).
   */
  environment?: RendererEnvironment;
  /**
   * Force a specific backend, bypassing capability detection. When set, the
   * factory still requires the corresponding dependency (a `gpu` for WebGPU).
   */
  backend?: RendererBackend;
  /**
   * The WebGPU entrypoint to hand a WebGPU renderer. Defaults to
   * `environment.gpu`. Required (here or in the environment) for WebGPU.
   */
  gpu?: GpuNavigatorLike;
}

/**
 * Construct a {@link Renderer} for `canvas`, choosing the backend via
 * {@link selectBackend} (or `opts.backend` when forced).
 *
 * This is the single place the engine branches on backend. Everything
 * downstream — presets included — receives the resulting {@link Renderer} and
 * is blind to which backend was chosen. Throws when no backend is available
 * (e.g. a headless environment) so callers fail loudly rather than silently
 * rendering nothing.
 */
export function createRenderer(
  canvas: RenderCanvasLike,
  opts: CreateRendererOptions = {},
): Renderer {
  // Resolve the environment exactly once. The same resolved environment must
  // feed BOTH backend selection AND the WebGPU `gpu` lookup — otherwise the
  // ambient `navigator.gpu` that selection saw is silently dropped before the
  // WebGPU branch, and `createRenderer(canvas)` throws in real browsers.
  const environment: RendererEnvironment = opts.environment ?? detectEnvironment();
  const selection: BackendSelection = opts.backend ?? selectBackend(environment);

  switch (selection) {
    case "webgpu": {
      // `environment.gpu` is the same value selection inspected. The structural
      // capability shape (GpuLike) is widened to the WebGPU entrypoint shape
      // (GpuNavigatorLike) at this single boundary — both are minimal views of
      // `navigator.gpu`, so the cast (via the GpuLike alias, no `any`) is sound.
      const envGpu: GpuLike | null | undefined = environment.gpu;
      const gpu =
        opts.gpu ?? (envGpu as GpuNavigatorLike | null | undefined) ?? undefined;
      if (!gpu) {
        // No usable `gpu` entrypoint. If WebGPU was explicitly forced by the
        // caller, honour the strict contract and throw. Otherwise this is the
        // auto-selection path: degrade gracefully to WebGL when it is available
        // rather than failing the whole renderer.
        if (opts.backend === "webgpu") {
          throw new Error(
            "createRenderer: WebGPU selected but no `gpu` entrypoint was provided.",
          );
        }
        const hasWebgl = environment.hasWebgl ?? defaultHasWebgl;
        if (hasWebgl()) {
          return new WebglRenderer({ canvas });
        }
        throw new Error(
          "createRenderer: WebGPU selected but no `gpu` entrypoint was provided.",
        );
      }
      return new WebgpuRenderer({ canvas, gpu });
    }
    case "webgl":
      return new WebglRenderer({ canvas });
    case "none":
      throw new Error(
        "createRenderer: no rendering backend available (neither WebGPU nor WebGL).",
      );
    default: {
      const exhaustive: never = selection;
      throw new Error(`createRenderer: unhandled backend selection ${String(exhaustive)}`);
    }
  }
}
