/**
 * WebGPU implementation of the backend-agnostic {@link Renderer}.
 *
 * Browser-only: it requests an adapter + device from `navigator.gpu`, configures
 * the canvas's `webgpu` context, and builds — once, in {@link init} — a small
 * instanced render pipeline that draws axis-aligned colored quads. Each frame is
 * a SINGLE render pass: the attachment is cleared to the background, then one
 * instanced `draw(6, rects.length)` paints every rectangle. Presets never see
 * this class — they target {@link Renderer}.
 *
 * Why instanced quads and not a scissored clear: in WebGPU `loadOp: "clear"`
 * clears the ENTIRE attachment and `setScissorRect` constrains only draw/blit
 * ops, not the load-clear. A per-rect "scissored clear" therefore repaints the
 * whole canvas to each rect's color, leaving only the last fill — a blank frame.
 * A real draw pipeline is the correct (and standard) way to fill rects.
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

/**
 * `GPUBufferUsage` bit flags we rely on. The real enum lives on the global
 * `GPUBufferUsage`; we mirror just the two bits we set so the renderer stays
 * dependency-free and does not read ambient globals that may be absent in a
 * test/Node environment.
 */
const BUFFER_USAGE = {
  /** Usable as a vertex buffer. */
  VERTEX: 0x20,
  /** A valid destination for `queue.writeBuffer`. */
  COPY_DST: 0x08,
} as const;

/** Structural subset of `GPUBuffer`. */
interface GpuBufferLike {
  destroy?(): void;
}

/** Structural subset of `GPUShaderModule`. */
interface GpuShaderModuleLike {
  readonly __brand?: "shader";
}

/** Structural subset of `GPURenderPipeline`. */
interface GpuRenderPipelineLike {
  readonly __brand?: "pipeline";
}

/** Structural subset of `GPUQueue`. */
interface GpuQueueLike {
  submit(buffers: unknown[]): void;
  writeBuffer(
    buffer: GpuBufferLike,
    bufferOffset: number,
    data: BufferSource,
    dataOffset?: number,
    size?: number,
  ): void;
}

/** Structural subset of `GPUDevice` used by this renderer. */
interface GpuDeviceLike {
  createCommandEncoder(): GpuCommandEncoderLike;
  createShaderModule(descriptor: { code: string }): GpuShaderModuleLike;
  createRenderPipeline(descriptor: GpuRenderPipelineDescriptorLike): GpuRenderPipelineLike;
  createBuffer(descriptor: { size: number; usage: number }): GpuBufferLike;
  readonly queue: GpuQueueLike;
}

interface GpuRenderPipelineDescriptorLike {
  layout: "auto" | unknown;
  vertex: {
    module: GpuShaderModuleLike;
    entryPoint: string;
    buffers: Array<{
      arrayStride: number;
      stepMode: "instance" | "vertex";
      attributes: Array<{ shaderLocation: number; offset: number; format: string }>;
    }>;
  };
  fragment: {
    module: GpuShaderModuleLike;
    entryPoint: string;
    targets: Array<{ format: string }>;
  };
  primitive: { topology: string };
}

interface GpuAdapterLike {
  requestDevice(): Promise<GpuDeviceLike>;
}

interface GpuCommandEncoderLike {
  beginRenderPass(descriptor: GpuRenderPassDescriptorLike): GpuRenderPassLike;
  finish(): unknown;
}

interface GpuRenderPassLike {
  setPipeline(pipeline: GpuRenderPipelineLike): void;
  setVertexBuffer(slot: number, buffer: GpuBufferLike): void;
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
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

/** Floats per instance: x, y, w, h, r, g, b, a. */
const FLOATS_PER_INSTANCE = 8;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;

/**
 * WGSL for the instanced colored-quad pipeline. A unit quad is emitted from
 * `vertex_index` (two triangles, 6 vertices) with no vertex buffer; the
 * per-instance buffer carries `[x, y, w, h]` (a NormalizedRect: top-left origin,
 * y down, range [0,1]) and `[r, g, b, a]`.
 *
 * Map a unit-quad coord (u, v) in [0,1] into clip space:
 *   clipX = (x + u*w) * 2 - 1
 *   clipY = 1 - (y + v*h) * 2   // flip y: normalized y runs top→bottom
 */
const QUAD_SHADER = /* wgsl */ `
struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) color : vec4<f32>,
};

@vertex
fn vs_main(
  @builtin(vertex_index) vi : u32,
  @location(0) rect : vec4<f32>,   // x, y, w, h
  @location(1) color : vec4<f32>,  // r, g, b, a
) -> VsOut {
  // Unit-quad corners (u, v) in [0,1] for two triangles.
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(1.0, 1.0),
  );
  let uv = corners[vi];
  let nx = rect.x + uv.x * rect.z;
  let ny = rect.y + uv.y * rect.w;
  let clipX = nx * 2.0 - 1.0;
  let clipY = 1.0 - ny * 2.0;
  var out : VsOut;
  out.pos = vec4<f32>(clipX, clipY, 0.0, 1.0);
  out.color = color;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  return in.color;
}
`;

export class WebgpuRenderer implements Renderer {
  readonly backend: RendererBackend = "webgpu";

  private readonly canvas: WebgpuCanvasLike;
  private readonly gpu: GpuNavigatorLike;
  private device: GpuDeviceLike | null = null;
  private context: GpuCanvasContextLike | null = null;
  private pipeline: GpuRenderPipelineLike | null = null;
  private format = "bgra8unorm";
  private size: DrawingBufferSize = { width: 0, height: 0 };

  /** Per-frame accumulation: the background and the rects to draw. */
  private background: RgbaColor = { r: 0, g: 0, b: 0, a: 1 };
  private rects: NormalizedRect[] = [];
  private frameOpen = false;

  /** The instance buffer + its capacity (in instances) and CPU staging array. */
  private instanceBuffer: GpuBufferLike | null = null;
  private instanceCapacity = 0;
  private instanceData: Float32Array = new Float32Array(0);

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

    // Build the instanced quad pipeline ONCE. The per-instance buffer feeds
    // location(0) = rect (x,y,w,h) and location(1) = color (r,g,b,a), packed
    // contiguously as 8 f32 per instance.
    const module = device.createShaderModule({ code: QUAD_SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: BYTES_PER_INSTANCE,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x4" },
              { shaderLocation: 1, offset: 16, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
    });

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
    this.require("beginFrame");
    this.background = { ...background };
    this.rects = [];
    this.frameOpen = true;
  }

  drawRect(rect: NormalizedRect): void {
    this.require("drawRect");
    if (!this.frameOpen) {
      throw new Error("WebgpuRenderer: drawRect() called outside beginFrame().");
    }
    if (rect.w <= 0 || rect.h <= 0) return;
    this.rects.push(rect);
  }

  endFrame(): void {
    const { device, context, pipeline } = this.require("endFrame");
    if (!this.frameOpen) {
      throw new Error("WebgpuRenderer: endFrame() called outside beginFrame().");
    }
    this.frameOpen = false;

    const count = this.rects.length;
    if (count > 0) {
      this.ensureInstanceCapacity(device, count);
      const data = this.instanceData;
      for (let i = 0; i < count; i++) {
        const rect = this.rects[i]!;
        const base = i * FLOATS_PER_INSTANCE;
        data[base] = rect.x;
        data[base + 1] = rect.y;
        data[base + 2] = rect.w;
        data[base + 3] = rect.h;
        data[base + 4] = rect.color.r;
        data[base + 5] = rect.color.g;
        data[base + 6] = rect.color.b;
        data[base + 7] = rect.color.a;
      }
      // Upload exactly the bytes for `count` instances.
      device.queue.writeBuffer(
        this.instanceBuffer!,
        0,
        data.buffer,
        data.byteOffset,
        count * BYTES_PER_INSTANCE,
      );
    }

    const encoder = device.createCommandEncoder();
    const view = context.getCurrentTexture().createView();
    // ONE pass: clear to the background, then a single instanced draw paints all
    // rects on top — correct compositing, no per-rect clears.
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { ...this.background },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(pipeline);
    if (count > 0) {
      // The pipeline declares an instance vertex buffer at slot 0; it MUST be
      // bound before any draw or the command buffer is invalid (and the whole
      // submit — including the clear — is dropped). With no rects we issue NO
      // draw at all: the frame is just the background clear.
      pass.setVertexBuffer(0, this.instanceBuffer!);
      pass.draw(6, count);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  /** Grow (or first-create) the instance buffer to hold at least `count` rects. */
  private ensureInstanceCapacity(device: GpuDeviceLike, count: number): void {
    if (this.instanceBuffer && this.instanceCapacity >= count) return;
    // Grow geometrically to amortize reallocations across frames.
    const capacity = Math.max(count, this.instanceCapacity * 2, 64);
    this.instanceBuffer?.destroy?.();
    this.instanceBuffer = device.createBuffer({
      size: capacity * BYTES_PER_INSTANCE,
      usage: BUFFER_USAGE.VERTEX | BUFFER_USAGE.COPY_DST,
    });
    this.instanceCapacity = capacity;
    this.instanceData = new Float32Array(capacity * FLOATS_PER_INSTANCE);
  }

  private require(
    op: string,
  ): { device: GpuDeviceLike; context: GpuCanvasContextLike; pipeline: GpuRenderPipelineLike } {
    const device = this.device;
    const context = this.context;
    const pipeline = this.pipeline;
    if (!device || !context || !pipeline) {
      throw new Error(`WebgpuRenderer: ${op}() called before init().`);
    }
    return { device, context, pipeline };
  }

  dispose(): void {
    this.instanceBuffer?.destroy?.();
    this.instanceBuffer = null;
    this.instanceCapacity = 0;
    this.instanceData = new Float32Array(0);
    this.pipeline = null;
    this.context?.unconfigure?.();
    this.context = null;
    this.device = null;
    this.rects = [];
    this.frameOpen = false;
  }
}
