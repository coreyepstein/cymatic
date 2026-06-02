/**
 * WebGL implementation of the backend-agnostic {@link Renderer}.
 *
 * Browser-only: it obtains a `webgl2`/`webgl` context from a canvas and clears
 * it to the scene background each frame (the solid-fill smoke scene). It holds
 * no knowledge of presets — presets target {@link Renderer} and never see this
 * class.
 */

import type { RendererBackend } from "../capabilities.js";
import {
  computeDrawingBufferSize,
  type DrawingBufferSize,
  type NormalizedRect,
  type PostEffectsConfig,
  type RenderFeatures,
  type Renderer,
  type RgbaColor,
  type Scene,
} from "../renderer.js";

/** A minimal canvas shape: enough to obtain a WebGL context and be sized. */
export interface WebglCanvasLike {
  width: number;
  height: number;
  getContext(contextId: "webgl2" | "webgl" | "experimental-webgl"): unknown;
}

/** Construction options for {@link WebglRenderer}. */
export interface WebglRendererOptions {
  /** The canvas to render into. */
  canvas: WebglCanvasLike;
}

/** Structural subset of `WebGLRenderingContext` this renderer uses. */
interface GlLike {
  readonly COLOR_BUFFER_BIT: number;
  readonly SCISSOR_TEST: number;
  viewport(x: number, y: number, width: number, height: number): void;
  clearColor(r: number, g: number, b: number, a: number): void;
  clear(mask: number): void;
  enable(cap: number): void;
  disable(cap: number): void;
  scissor(x: number, y: number, width: number, height: number): void;
}

export class WebglRenderer implements Renderer {
  readonly backend: RendererBackend = "webgl";

  private readonly canvas: WebglCanvasLike;
  private gl: GlLike | null = null;
  private size: DrawingBufferSize = { width: 0, height: 0 };

  constructor(options: WebglRendererOptions) {
    this.canvas = options.canvas;
  }

  get drawingBufferSize(): DrawingBufferSize {
    return this.size;
  }

  init(): Promise<void> {
    if (this.gl) return Promise.resolve();
    const ctx =
      (this.canvas.getContext("webgl2") as GlLike | null) ??
      (this.canvas.getContext("webgl") as GlLike | null) ??
      (this.canvas.getContext("experimental-webgl") as GlLike | null);
    if (!ctx) {
      throw new Error("WebglRenderer: unable to acquire a WebGL context.");
    }
    this.gl = ctx;
    return Promise.resolve();
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.size = computeDrawingBufferSize(cssWidth, cssHeight, dpr);
    this.canvas.width = this.size.width;
    this.canvas.height = this.size.height;
    this.gl?.viewport(0, 0, this.size.width, this.size.height);
  }

  render(scene: Scene, _features: RenderFeatures, _timeSeconds: number): void {
    this.beginFrame(scene.background);
    this.endFrame();
  }

  beginFrame(background: RgbaColor): void {
    const gl = this.requireGl("beginFrame");
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(background.r, background.g, background.b, background.a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  drawRect(rect: NormalizedRect): void {
    const gl = this.requireGl("drawRect");
    // Filled rect via a scissored clear — a real, shader-free GL technique.
    // Normalized coords have y running top→bottom; GL's framebuffer origin is
    // bottom-left, so flip y when mapping to device pixels.
    const { width, height } = this.size;
    const px = Math.round(rect.x * width);
    const pw = Math.round(rect.w * width);
    const ph = Math.round(rect.h * height);
    const py = Math.round((1 - rect.y - rect.h) * height);
    if (pw <= 0 || ph <= 0) return;

    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(px, py, pw, ph);
    const { r, g, b, a } = rect.color;
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  endFrame(): void {
    const gl = this.gl;
    // Leave scissor disabled so it can't leak into the next frame's clear.
    gl?.disable(gl.SCISSOR_TEST);
  }

  /**
   * No-op for the WebGL backend. Cinematic post-processing (HDR offscreen
   * target, tonemap/exposure, bloom, …) is WebGPU-only; WebGL keeps its basic
   * direct-render look. Accepting and ignoring the config keeps the
   * preset/React call site backend-agnostic — callers never branch.
   */
  setPostEffects(_config: PostEffectsConfig): void {
    // intentionally no-op
  }

  private requireGl(op: string): GlLike {
    const gl = this.gl;
    if (!gl) {
      throw new Error(`WebglRenderer: ${op}() called before init().`);
    }
    return gl;
  }

  dispose(): void {
    this.gl = null;
  }
}
