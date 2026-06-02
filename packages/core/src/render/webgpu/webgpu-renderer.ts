/**
 * WebGPU implementation of the backend-agnostic {@link Renderer}.
 *
 * Browser-only: it requests an adapter + device from `navigator.gpu`, configures
 * the canvas's `webgpu` context, and clears it to the scene background each
 * frame via a render pass `clearValue` (the solid-fill smoke scene). Presets
 * never see this class — they target {@link Renderer}.
 *
 * We model only the slivers of the WebGPU API we touch via small structural
 * interfaces, so the package needs no `@webgpu/types` dependency.
 */

import type { GpuLike, RendererBackend } from "../capabilities.js";
import {
  computeDrawingBufferSize,
  type DrawingBufferSize,
  type NormalizedRect,
  type RenderFeatures,
  type Renderer,
  type RgbaColor,
  type Scene,
} from "../renderer.js";

/** Structural subset of `GPUDevice` used by this renderer. */
interface GpuDeviceLike {
  createCommandEncoder(): GpuCommandEncoderLike;
  readonly queue: { submit(buffers: unknown[]): void };
}

interface GpuAdapterLike {
  requestDevice(): Promise<GpuDeviceLike>;
}

interface GpuCommandEncoderLike {
  beginRenderPass(descriptor: GpuRenderPassDescriptorLike): GpuRenderPassLike;
  finish(): unknown;
}

interface GpuRenderPassLike {
  setScissorRect?(x: number, y: number, width: number, height: number): void;
  end(): void;
}

interface GpuRenderPassDescriptorLike {
  colorAttachments: Array<{
    view: unknown;
    clearValue: { r: number; g: number; b: number; a: number };
    loadOp: "clear" | "load";
    storeOp: "store";
  }>;
}

interface GpuCanvasContextLike {
  configure(config: { device: GpuDeviceLike; format: string; alphaMode?: string }): void;
  getCurrentTexture(): { createView(): unknown };
  unconfigure?(): void;
}

/** A minimal canvas shape: enough to obtain a `webgpu` context and be sized. */
export interface WebgpuCanvasLike {
  width: number;
  height: number;
  getContext(contextId: "webgpu"): unknown;
}

/** The WebGPU entrypoint (`navigator.gpu`), extended with the format helper. */
export interface GpuNavigatorLike extends GpuLike {
  requestAdapter(...args: unknown[]): Promise<GpuAdapterLike | null>;
  getPreferredCanvasFormat?(): string;
}

/** Construction options for {@link WebgpuRenderer}. */
export interface WebgpuRendererOptions {
  /** The canvas to render into. */
  canvas: WebgpuCanvasLike;
  /** The WebGPU entrypoint, normally `navigator.gpu`. */
  gpu: GpuNavigatorLike;
}

export class WebgpuRenderer implements Renderer {
  readonly backend: RendererBackend = "webgpu";

  private readonly canvas: WebgpuCanvasLike;
  private readonly gpu: GpuNavigatorLike;
  private device: GpuDeviceLike | null = null;
  private context: GpuCanvasContextLike | null = null;
  private format = "bgra8unorm";
  private size: DrawingBufferSize = { width: 0, height: 0 };
  /** The render-pass texture view for the frame currently open via beginFrame. */
  private frameView: unknown = null;
  private encoder: GpuCommandEncoderLike | null = null;

  constructor(options: WebgpuRendererOptions) {
    this.canvas = options.canvas;
    this.gpu = options.gpu;
  }

  get drawingBufferSize(): DrawingBufferSize {
    return this.size;
  }

  async init(): Promise<void> {
    if (this.device) return;
    const adapter = await this.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("WebgpuRenderer: no GPU adapter available.");
    }
    const device = await adapter.requestDevice();
    const ctx = this.canvas.getContext("webgpu") as GpuCanvasContextLike | null;
    if (!ctx) {
      throw new Error("WebgpuRenderer: unable to acquire a webgpu context.");
    }
    this.format = this.gpu.getPreferredCanvasFormat?.() ?? "bgra8unorm";
    ctx.configure({ device, format: this.format, alphaMode: "premultiplied" });
    this.device = device;
    this.context = ctx;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.size = computeDrawingBufferSize(cssWidth, cssHeight, dpr);
    this.canvas.width = this.size.width;
    this.canvas.height = this.size.height;
  }

  render(scene: Scene, _features: RenderFeatures, _timeSeconds: number): void {
    this.beginFrame(scene.background);
    this.endFrame();
  }

  beginFrame(background: RgbaColor): void {
    const { device, context } = this.require("beginFrame");
    const encoder = device.createCommandEncoder();
    // The clear pass establishes the background; subsequent rect passes load it.
    const view = context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { ...background },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.end();
    this.encoder = encoder;
    this.frameView = view;
  }

  drawRect(rect: NormalizedRect): void {
    const { device } = this.require("drawRect");
    const encoder = this.encoder;
    if (!encoder) {
      throw new Error("WebgpuRenderer: drawRect() called outside beginFrame().");
    }
    const { width, height } = this.size;
    const px = Math.round(rect.x * width);
    const py = Math.round(rect.y * height);
    const pw = Math.round(rect.w * width);
    const ph = Math.round(rect.h * height);
    if (pw <= 0 || ph <= 0) return;

    // A scissored load-pass clears just the rect region to the fill color,
    // preserving everything drawn before it.
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.frameView,
          clearValue: { ...rect.color },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setScissorRect?.(px, py, pw, ph);
    pass.end();
    void device;
  }

  endFrame(): void {
    const { device } = this.require("endFrame");
    const encoder = this.encoder;
    if (!encoder) {
      throw new Error("WebgpuRenderer: endFrame() called outside beginFrame().");
    }
    device.queue.submit([encoder.finish()]);
    this.encoder = null;
    this.frameView = null;
  }

  private require(op: string): { device: GpuDeviceLike; context: GpuCanvasContextLike } {
    const device = this.device;
    const context = this.context;
    if (!device || !context) {
      throw new Error(`WebgpuRenderer: ${op}() called before init().`);
    }
    return { device, context };
  }

  dispose(): void {
    this.context?.unconfigure?.();
    this.context = null;
    this.device = null;
    this.encoder = null;
    this.frameView = null;
  }
}
