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
  type RenderFeatures,
  type Renderer,
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
  viewport(x: number, y: number, width: number, height: number): void;
  clearColor(r: number, g: number, b: number, a: number): void;
  clear(mask: number): void;
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
    const gl = this.gl;
    if (!gl) {
      throw new Error("WebglRenderer: render() called before init().");
    }
    const { r, g, b, a } = scene.background;
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  dispose(): void {
    this.gl = null;
  }
}
