/**
 * WebGPU implementation of the backend-agnostic {@link Renderer}, with an
 * HDR offscreen render target + post-processing framework (cymatic v2).
 *
 * Browser-only: it requests an adapter + device from `navigator.gpu`, configures
 * the canvas's `webgpu` context, and builds — once, in {@link init} — two
 * pipelines:
 *
 *   1. The SCENE pipeline: the existing instanced colored-quad pipeline, but its
 *      fragment target is now an offscreen `rgba16float` HDR texture sized to the
 *      drawing buffer, NOT the swapchain. Each frame the scene pass clears that
 *      HDR texture to the background and issues one instanced `draw(6, rects)`.
 *
 *   2. The POST pipeline: a fullscreen pass that samples the HDR texture with a
 *      single fullscreen triangle (no vertex buffer), applies exposure +
 *      tonemap (ACES approximation), and writes to `context.getCurrentTexture()`
 *      (the swapchain). This is the composite/present stage.
 *
 * So every frame runs TWO render passes — scene→offscreen, then post→swapchain.
 * This indirection is the substrate every later cinematic effect (bloom, trails)
 * plugs into: more stages slot between the scene pass and the final composite.
 * Presets never see any of this — they target {@link Renderer}.
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
  type PostEffectsConfig,
  type RenderFeatures,
  type Renderer,
  type RgbaColor,
  type Scene,
} from "../renderer.js";

/**
 * `GPUBufferUsage` bit flags we rely on. The real enum lives on the global
 * `GPUBufferUsage`; we mirror just the bits we set so the renderer stays
 * dependency-free and does not read ambient globals that may be absent in a
 * test/Node environment.
 */
const BUFFER_USAGE = {
  /** Usable as a vertex buffer. */
  VERTEX: 0x20,
  /** A valid destination for `queue.writeBuffer`. */
  COPY_DST: 0x08,
  /** Usable as a uniform buffer (post-FX params). */
  UNIFORM: 0x40,
} as const;

/**
 * `GPUTextureUsage` bit flags we rely on for the offscreen HDR target: it is
 * both a render attachment (the scene pass draws into it) and a sampled texture
 * (the post pass reads it).
 */
const TEXTURE_USAGE = {
  /** Usable as a color attachment. */
  RENDER_ATTACHMENT: 0x10,
  /** Bindable as a sampled texture in a shader. */
  TEXTURE_BINDING: 0x04,
} as const;

/** The HDR format for the offscreen scene target. */
const HDR_FORMAT = "rgba16float";

/** Default exposure for the tonemap stage. */
const DEFAULT_EXPOSURE = 1;

/** Bytes in the post-FX uniform buffer: a single f32 (exposure), padded to 16. */
const POST_UNIFORM_BYTES = 16;

/** Structural subset of `GPUBuffer`. */
interface GpuBufferLike {
  destroy?(): void;
}

/** Structural subset of `GPUTexture`. */
interface GpuTextureLike {
  createView(): GpuTextureViewLike;
  destroy?(): void;
}

/** Structural subset of `GPUTextureView`. */
interface GpuTextureViewLike {
  readonly __brand?: "view";
}

/** Structural subset of `GPUSampler`. */
interface GpuSamplerLike {
  readonly __brand?: "sampler";
}

/** Structural subset of `GPUShaderModule`. */
interface GpuShaderModuleLike {
  readonly __brand?: "shader";
}

/** Structural subset of `GPURenderPipeline`. */
interface GpuRenderPipelineLike {
  getBindGroupLayout?(index: number): GpuBindGroupLayoutLike;
  readonly __brand?: "pipeline";
}

/** Structural subset of `GPUBindGroupLayout`. */
interface GpuBindGroupLayoutLike {
  readonly __brand?: "bindGroupLayout";
}

/** Structural subset of `GPUPipelineLayout`. */
interface GpuPipelineLayoutLike {
  readonly __brand?: "pipelineLayout";
}

/** Structural subset of `GPUBindGroup`. */
interface GpuBindGroupLike {
  readonly __brand?: "bindGroup";
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

/** A bind-group entry: a uniform buffer binding, a sampler, or a texture view. */
interface GpuBindGroupEntryLike {
  binding: number;
  resource:
    | { buffer: GpuBufferLike }
    | GpuSamplerLike
    | GpuTextureViewLike;
}

interface GpuBindGroupDescriptorLike {
  layout: GpuBindGroupLayoutLike;
  entries: GpuBindGroupEntryLike[];
}

interface GpuSamplerDescriptorLike {
  magFilter?: "nearest" | "linear";
  minFilter?: "nearest" | "linear";
}

interface GpuTextureDescriptorLike {
  size: { width: number; height: number };
  format: string;
  usage: number;
}

/** Structural subset of `GPUDevice` used by this renderer. */
interface GpuDeviceLike {
  createCommandEncoder(): GpuCommandEncoderLike;
  createShaderModule(descriptor: { code: string }): GpuShaderModuleLike;
  createRenderPipeline(descriptor: GpuRenderPipelineDescriptorLike): GpuRenderPipelineLike;
  createBuffer(descriptor: { size: number; usage: number }): GpuBufferLike;
  createTexture(descriptor: GpuTextureDescriptorLike): GpuTextureLike;
  createSampler(descriptor?: GpuSamplerDescriptorLike): GpuSamplerLike;
  createBindGroupLayout(descriptor: unknown): GpuBindGroupLayoutLike;
  createPipelineLayout(descriptor: {
    bindGroupLayouts: GpuBindGroupLayoutLike[];
  }): GpuPipelineLayoutLike;
  createBindGroup(descriptor: GpuBindGroupDescriptorLike): GpuBindGroupLike;
  readonly queue: GpuQueueLike;
}

interface GpuRenderPipelineDescriptorLike {
  layout: "auto" | GpuPipelineLayoutLike;
  vertex: {
    module: GpuShaderModuleLike;
    entryPoint: string;
    buffers?: Array<{
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
  setBindGroup(index: number, bindGroup: GpuBindGroupLike): void;
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
  end(): void;
}

interface GpuRenderPassDescriptorLike {
  colorAttachments: Array<{
    view: GpuTextureViewLike | unknown;
    clearValue: { r: number; g: number; b: number; a: number };
    loadOp: "clear" | "load";
    storeOp: "store";
  }>;
}

interface GpuCanvasContextLike {
  configure(config: { device: GpuDeviceLike; format: string; alphaMode?: string }): void;
  getCurrentTexture(): GpuTextureLike;
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
 * WGSL for the instanced colored-quad SCENE pipeline. A unit quad is emitted
 * from `vertex_index` (two triangles, 6 vertices) with no vertex buffer; the
 * per-instance buffer carries `[x, y, w, h]` (a NormalizedRect: top-left origin,
 * y down, range [0,1]) and `[r, g, b, a]`. It targets the HDR offscreen texture.
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

/**
 * WGSL for the POST / composite pass. A single fullscreen triangle covers the
 * viewport (no vertex buffer); the fragment samples the HDR scene texture,
 * applies exposure, then an ACES-approximation tonemap, and writes to the
 * swapchain. The exposure scalar comes from a uniform buffer (binding 0); the
 * scene texture is binding 1 and its sampler binding 2.
 *
 * This is where later cinematic stages compose: bloom/vignette become extra
 * sampled textures + math before the final tonemap.
 */
const POST_SHADER = /* wgsl */ `
struct Params {
  exposure : f32,
  _pad0 : f32,
  _pad1 : f32,
  _pad2 : f32,
};

@group(0) @binding(0) var<uniform> params : Params;
@group(0) @binding(1) var sceneTex : texture_2d<f32>;
@group(0) @binding(2) var sceneSampler : sampler;

struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_post(@builtin(vertex_index) vi : u32) -> VsOut {
  // Oversized fullscreen triangle: clip-space corners and matching UVs.
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(2.0, 1.0),
    vec2<f32>(0.0, -1.0),
  );
  var out : VsOut;
  out.pos = vec4<f32>(positions[vi], 0.0, 1.0);
  out.uv = uvs[vi];
  return out;
}

// ACES filmic tonemap approximation (Narkowicz 2015).
fn aces(x : vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_post(in : VsOut) -> @location(0) vec4<f32> {
  let hdr = textureSample(sceneTex, sceneSampler, in.uv);
  let exposed = hdr.rgb * params.exposure;
  let mapped = aces(exposed);
  return vec4<f32>(mapped, hdr.a);
}
`;

export class WebgpuRenderer implements Renderer {
  readonly backend: RendererBackend = "webgpu";

  private readonly canvas: WebgpuCanvasLike;
  private readonly gpu: GpuNavigatorLike;
  private device: GpuDeviceLike | null = null;
  private context: GpuCanvasContextLike | null = null;
  private scenePipeline: GpuRenderPipelineLike | null = null;
  private postPipeline: GpuRenderPipelineLike | null = null;
  private postBindGroupLayout: GpuBindGroupLayoutLike | null = null;
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

  /** Offscreen HDR target (created on resize) + post-pass resources. */
  private hdrTexture: GpuTextureLike | null = null;
  private hdrView: GpuTextureViewLike | null = null;
  private sampler: GpuSamplerLike | null = null;
  private postUniformBuffer: GpuBufferLike | null = null;
  private postBindGroup: GpuBindGroupLike | null = null;

  /** Post-FX state. Exposure default is neutral (1.0). */
  private exposure = DEFAULT_EXPOSURE;
  /** Set when exposure changed and the uniform buffer needs reupload. */
  private postParamsDirty = true;

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

    // SCENE pipeline: instanced quads → HDR offscreen target. Built ONCE.
    // The per-instance buffer feeds location(0) = rect (x,y,w,h) and
    // location(1) = color (r,g,b,a), packed contiguously as 8 f32 per instance.
    // Its fragment target is the HDR format, NOT the swapchain format.
    const sceneModule = device.createShaderModule({ code: QUAD_SHADER });
    this.scenePipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: sceneModule,
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
        module: sceneModule,
        entryPoint: "fs_main",
        targets: [{ format: HDR_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });

    // POST pipeline: fullscreen triangle sampling the HDR texture → swapchain.
    // We declare an explicit bind-group layout (uniform + texture + sampler) so
    // the bind group can be rebuilt against fresh texture views on resize.
    const postModule = device.createShaderModule({ code: POST_SHADER });
    const postLayout = device.createBindGroupLayout({
      entries: [
        // 0: exposure/params uniform, visible to the fragment stage.
        { binding: 0, visibility: 0x2 /* FRAGMENT */, buffer: { type: "uniform" } },
        // 1: the HDR scene texture (float, 2d).
        { binding: 1, visibility: 0x2, texture: { sampleType: "float", viewDimension: "2d" } },
        // 2: the sampler.
        { binding: 2, visibility: 0x2, sampler: { type: "filtering" } },
      ],
    });
    this.postBindGroupLayout = postLayout;
    const postPipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [postLayout],
    });
    this.postPipeline = device.createRenderPipeline({
      layout: postPipelineLayout,
      vertex: { module: postModule, entryPoint: "vs_post" },
      fragment: {
        module: postModule,
        entryPoint: "fs_post",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
    });

    // The sampler + post params uniform persist across frames/resizes.
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.postUniformBuffer = device.createBuffer({
      size: POST_UNIFORM_BYTES,
      usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
    });
    this.postParamsDirty = true;

    this.device = device;
    this.context = ctx;

    // Build the HDR target for the current size (if resize() already ran).
    this.ensureHdrTarget();
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.size = computeDrawingBufferSize(cssWidth, cssHeight, dpr);
    this.canvas.width = this.size.width;
    this.canvas.height = this.size.height;
    // Recreate the offscreen HDR texture (and post bind group) at the new size.
    this.ensureHdrTarget();
  }

  render(scene: Scene, _features: RenderFeatures, _timeSeconds: number): void {
    this.beginFrame(scene.background);
    this.endFrame();
  }

  setPostEffects(config: PostEffectsConfig): void {
    if (config.exposure != null) {
      const e = config.exposure;
      const next = Number.isFinite(e) && e >= 0 ? e : DEFAULT_EXPOSURE;
      if (next !== this.exposure) {
        this.exposure = next;
        this.postParamsDirty = true;
      }
    }
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
    const { device, context, scenePipeline, postPipeline } = this.require("endFrame");
    if (!this.frameOpen) {
      throw new Error("WebgpuRenderer: endFrame() called outside beginFrame().");
    }
    this.frameOpen = false;

    // The offscreen HDR target + post bind group must exist (built in
    // init()/resize()). If a frame somehow runs before a non-zero resize, build
    // a minimal target now so the two-pass path is always honoured.
    if (!this.hdrView || !this.postBindGroup) {
      this.ensureHdrTarget();
    }
    const hdrView = this.hdrView;
    const postBindGroup = this.postBindGroup;
    if (!hdrView || !postBindGroup) {
      throw new Error("WebgpuRenderer: offscreen HDR target unavailable.");
    }

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

    // Upload post-FX params (exposure) when they changed.
    if (this.postParamsDirty && this.postUniformBuffer) {
      const params = new Float32Array([this.exposure, 0, 0, 0]);
      device.queue.writeBuffer(this.postUniformBuffer, 0, params.buffer, params.byteOffset, POST_UNIFORM_BYTES);
      this.postParamsDirty = false;
    }

    const encoder = device.createCommandEncoder();

    // ── PASS 1: SCENE → offscreen HDR texture ──
    // Clear the HDR target to the background, then one instanced draw paints all
    // rects on top — correct compositing, no per-rect clears.
    const scenePass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: hdrView,
          clearValue: { ...this.background },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    scenePass.setPipeline(scenePipeline);
    if (count > 0) {
      // The pipeline declares an instance vertex buffer at slot 0; it MUST be
      // bound before any draw. With no rects we issue NO draw at all: the HDR
      // target is just the background clear.
      scenePass.setVertexBuffer(0, this.instanceBuffer!);
      scenePass.draw(6, count);
    }
    scenePass.end();

    // ── PASS 2: POST / COMPOSITE → swapchain ──
    // Sample the HDR target with a fullscreen triangle, apply exposure+tonemap,
    // and present to the canvas swapchain.
    const swapView = context.getCurrentTexture().createView();
    const postPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: swapView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    postPass.setPipeline(postPipeline);
    postPass.setBindGroup(0, postBindGroup);
    postPass.draw(3, 1);
    postPass.end();

    device.queue.submit([encoder.finish()]);
  }

  /**
   * (Re)create the offscreen HDR texture + its view at the current size, then
   * rebuild the post-pass bind group against the new view. Called from
   * init()/resize() and defensively before the first frame. Releases the prior
   * texture so resizes don't leak GPU memory.
   */
  private ensureHdrTarget(): void {
    const device = this.device;
    const sampler = this.sampler;
    const layout = this.postBindGroupLayout;
    const uniform = this.postUniformBuffer;
    if (!device || !sampler || !layout || !uniform) return;
    const { width, height } = this.size;
    if (width <= 0 || height <= 0) return;

    // Release the prior target before allocating a new one.
    this.hdrTexture?.destroy?.();
    const texture = device.createTexture({
      size: { width, height },
      format: HDR_FORMAT,
      usage: TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.TEXTURE_BINDING,
    });
    const view = texture.createView();
    this.hdrTexture = texture;
    this.hdrView = view;

    this.postBindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: view },
        { binding: 2, resource: sampler },
      ],
    });
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

  private require(op: string): {
    device: GpuDeviceLike;
    context: GpuCanvasContextLike;
    scenePipeline: GpuRenderPipelineLike;
    postPipeline: GpuRenderPipelineLike;
  } {
    const device = this.device;
    const context = this.context;
    const scenePipeline = this.scenePipeline;
    const postPipeline = this.postPipeline;
    if (!device || !context || !scenePipeline || !postPipeline) {
      throw new Error(`WebgpuRenderer: ${op}() called before init().`);
    }
    return { device, context, scenePipeline, postPipeline };
  }

  dispose(): void {
    this.instanceBuffer?.destroy?.();
    this.instanceBuffer = null;
    this.instanceCapacity = 0;
    this.instanceData = new Float32Array(0);
    this.hdrTexture?.destroy?.();
    this.hdrTexture = null;
    this.hdrView = null;
    this.postUniformBuffer?.destroy?.();
    this.postUniformBuffer = null;
    this.postBindGroup = null;
    this.postBindGroupLayout = null;
    this.sampler = null;
    this.scenePipeline = null;
    this.postPipeline = null;
    this.context?.unconfigure?.();
    this.context = null;
    this.device = null;
    this.rects = [];
    this.frameOpen = false;
    this.exposure = DEFAULT_EXPOSURE;
    this.postParamsDirty = true;
  }
}
