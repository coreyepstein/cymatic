/**
 * WebGPU implementation of the backend-agnostic {@link Renderer}, with an
 * HDR offscreen render target + post-processing chain (cymatic v2 cinematic).
 *
 * Browser-only: it requests an adapter + device from `navigator.gpu`, configures
 * the canvas's `webgpu` context, and builds — once, in {@link init} — the
 * pipelines for the post chain:
 *
 *   1. The SCENE pipeline: the instanced colored-quad pipeline whose fragment
 *      target is an offscreen `rgba16float` HDR texture sized to the drawing
 *      buffer. Each frame the scene pass clears that HDR texture to the
 *      background and issues one instanced `draw(6, rects)`.
 *
 *   2. The BLOOM pipelines (V2-02): a bright-pass that reads the HDR scene and
 *      keeps only luminance above a threshold, written into a DOWNSAMPLED mip
 *      chain (2–4 half-res-per-level textures), then a separable Gaussian blur
 *      (horizontal + vertical, ping-pong per mip), and an upsample-accumulate
 *      that folds the smaller mips back up into the largest. The result is the
 *      blurred glow that the composite adds additively over the scene before
 *      tonemap.
 *
 *   3. The POST pipeline: a fullscreen pass that samples the HDR texture AND the
 *      bloom texture, adds `bloom * intensity`, applies exposure + an ACES
 *      tonemap, then a vignette darkening toward the edges, and writes to the
 *      swapchain. This is the composite/present stage.
 *
 * So every frame runs the scene pass, then (when bloom is enabled) the bloom
 * passes, then the final composite. Presets never see any of this — they target
 * {@link Renderer} and drive the chain only through {@link setPostEffects}.
 *
 * Why instanced quads and not a scissored clear: in WebGPU `loadOp: "clear"`
 * clears the ENTIRE attachment and `setScissorRect` constrains only draw/blit
 * ops, not the load-clear. A real draw pipeline is the correct way to fill rects.
 *
 * We model only the slivers of the WebGPU API we touch via small structural
 * interfaces, so the package needs no `@webgpu/types` dependency.
 */

import type { GpuLike, RendererBackend } from "../capabilities.js";
import {
  computeDrawingBufferSize,
  type BloomConfig,
  type DrawingBufferSize,
  type NormalizedRect,
  type PostEffectsConfig,
  type RenderFeatures,
  type Renderer,
  type RgbaColor,
  type Scene,
  type VignetteConfig,
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
 * `GPUTextureUsage` bit flags we rely on for the offscreen HDR / bloom targets:
 * each is both a render attachment (a pass draws into it) and a sampled texture
 * (a later pass reads it).
 */
const TEXTURE_USAGE = {
  /** Usable as a color attachment. */
  RENDER_ATTACHMENT: 0x10,
  /** Bindable as a sampled texture in a shader. */
  TEXTURE_BINDING: 0x04,
} as const;

/** The HDR format for the offscreen scene + bloom targets. */
const HDR_FORMAT = "rgba16float";

/** Default exposure for the tonemap stage. */
const DEFAULT_EXPOSURE = 1;

/** Cinematic bloom defaults. */
const DEFAULT_BLOOM_ENABLED = true;
const DEFAULT_BLOOM_THRESHOLD = 0.7;
const DEFAULT_BLOOM_INTENSITY = 0.6;
const DEFAULT_BLOOM_RADIUS = 1;

/** Cinematic vignette defaults. */
const DEFAULT_VIGNETTE_ENABLED = true;
const DEFAULT_VIGNETTE_AMOUNT = 0.35;

/** Number of downsampled bloom mip levels (clamped 2–4 of the design range). */
const BLOOM_MIP_LEVELS = 4;

/**
 * Bytes in the COMPOSITE uniform buffer: exposure, bloomIntensity, vignette
 * enabled flag, vignette amount → 4 × f32 = 16 bytes (one std140 vec4 slot).
 */
const POST_UNIFORM_BYTES = 16;

/**
 * Bytes in the BLOOM uniform buffer: threshold, dirX, dirY, radius → 4 × f32 =
 * 16 bytes. Re-uploaded each blur invocation (cheap) to set the blur direction.
 */
const BLOOM_UNIFORM_BYTES = 16;

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
    targets: Array<{ format: string; blend?: GpuBlendStateLike }>;
  };
  primitive: { topology: string };
}

/** A blend state (used to make the upsample pass additive). */
interface GpuBlendStateLike {
  color: { srcFactor: string; dstFactor: string; operation?: string };
  alpha: { srcFactor: string; dstFactor: string; operation?: string };
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
 * Shared fullscreen-triangle vertex stage used by every post pass. A single
 * oversized triangle covers the viewport (no vertex buffer) and emits UVs.
 */
const FULLSCREEN_VS = /* wgsl */ `
struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_fullscreen(@builtin(vertex_index) vi : u32) -> VsOut {
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
`;

/**
 * WGSL for the BRIGHT-PASS: read the HDR scene, keep only the portion of each
 * channel whose luminance is above `threshold`, scaled by how far over it is.
 * Writes into the (downsampled) first bloom mip. binding 0 = bloom params
 * uniform (threshold in `.x`), 1 = HDR scene texture, 2 = sampler.
 */
const BRIGHT_PASS_SHADER = /* wgsl */ `
${FULLSCREEN_VS}

struct BloomParams {
  threshold : f32,
  dirX : f32,
  dirY : f32,
  radius : f32,
};

@group(0) @binding(0) var<uniform> params : BloomParams;
@group(0) @binding(1) var srcTex : texture_2d<f32>;
@group(0) @binding(2) var srcSampler : sampler;

@fragment
fn fs_bright(in : VsOut) -> @location(0) vec4<f32> {
  let c = textureSample(srcTex, srcSampler, in.uv).rgb;
  let lum = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
  // Soft knee around the threshold so the bright-pass doesn't hard-clip.
  let over = max(lum - params.threshold, 0.0);
  let weight = over / max(lum, 1.0e-4);
  return vec4<f32>(c * weight, 1.0);
}
`;

/**
 * WGSL for the separable Gaussian BLUR. Direction comes from the bloom uniform
 * (`dirX`, `dirY`) scaled by `radius`; the texel step is derived from the source
 * texture dimensions so each mip blurs at its own resolution. 9-tap kernel.
 * binding 0 = bloom params uniform, 1 = source texture, 2 = sampler.
 */
const BLUR_SHADER = /* wgsl */ `
${FULLSCREEN_VS}

struct BloomParams {
  threshold : f32,
  dirX : f32,
  dirY : f32,
  radius : f32,
};

@group(0) @binding(0) var<uniform> params : BloomParams;
@group(0) @binding(1) var srcTex : texture_2d<f32>;
@group(0) @binding(2) var srcSampler : sampler;

@fragment
fn fs_blur(in : VsOut) -> @location(0) vec4<f32> {
  let dims = vec2<f32>(textureDimensions(srcTex, 0));
  let texel = vec2<f32>(1.0, 1.0) / dims;
  let dir = vec2<f32>(params.dirX, params.dirY) * texel * max(params.radius, 0.0);

  // Normalized 9-tap Gaussian weights.
  var w = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  var acc = textureSample(srcTex, srcSampler, in.uv).rgb * w[0];
  for (var i : i32 = 1; i < 5; i = i + 1) {
    let o = dir * f32(i);
    acc = acc + textureSample(srcTex, srcSampler, in.uv + o).rgb * w[i];
    acc = acc + textureSample(srcTex, srcSampler, in.uv - o).rgb * w[i];
  }
  return vec4<f32>(acc, 1.0);
}
`;

/**
 * WGSL for the UPSAMPLE pass: sample a smaller (already-blurred) mip and write
 * it into the next-larger mip with ADDITIVE blending (set on the pipeline) so
 * the chain accumulates a wide, soft glow. A plain bilinear sample widens the
 * footprint for free at the lower resolution. binding 0 = source, 1 = sampler.
 */
const UPSAMPLE_SHADER = /* wgsl */ `
${FULLSCREEN_VS}

@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var srcSampler : sampler;

@fragment
fn fs_upsample(in : VsOut) -> @location(0) vec4<f32> {
  return vec4<f32>(textureSample(srcTex, srcSampler, in.uv).rgb, 1.0);
}
`;

/**
 * WGSL for the POST / COMPOSITE pass. Samples the HDR scene AND the (largest)
 * bloom mip, adds `bloom * bloomIntensity`, applies exposure + ACES tonemap,
 * then a radial vignette darkening. Writes to the swapchain. binding 0 = post
 * params uniform, 1 = HDR scene, 2 = sampler, 3 = bloom texture.
 */
const POST_SHADER = /* wgsl */ `
${FULLSCREEN_VS}

struct Params {
  exposure : f32,
  bloomIntensity : f32,
  vignetteEnabled : f32,
  vignetteAmount : f32,
};

@group(0) @binding(0) var<uniform> params : Params;
@group(0) @binding(1) var sceneTex : texture_2d<f32>;
@group(0) @binding(2) var sceneSampler : sampler;
@group(0) @binding(3) var bloomTex : texture_2d<f32>;

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
  let hdr = textureSample(sceneTex, sceneSampler, in.uv).rgb;
  let bloom = textureSample(bloomTex, sceneSampler, in.uv).rgb;
  var color = hdr + bloom * params.bloomIntensity;
  color = color * params.exposure;
  var mapped = aces(color);

  // Radial vignette: darken toward the frame edges.
  if (params.vignetteEnabled > 0.5) {
    let d = in.uv - vec2<f32>(0.5, 0.5);
    let dist = length(d) * 1.41421356; // 1.0 at the corners
    let v = 1.0 - params.vignetteAmount * smoothstep(0.4, 1.0, dist);
    mapped = mapped * v;
  }

  return vec4<f32>(mapped, 1.0);
}
`;

/** One downsampled bloom mip: two ping-pong textures + their views. */
interface BloomMip {
  width: number;
  height: number;
  texA: GpuTextureLike;
  viewA: GpuTextureViewLike;
  texB: GpuTextureLike;
  viewB: GpuTextureViewLike;
}

/** Resolved (non-optional) post-FX state held by the renderer. */
interface ResolvedBloom {
  enabled: boolean;
  threshold: number;
  intensity: number;
  radius: number;
}

interface ResolvedVignette {
  enabled: boolean;
  amount: number;
}

export class WebgpuRenderer implements Renderer {
  readonly backend: RendererBackend = "webgpu";

  private readonly canvas: WebgpuCanvasLike;
  private readonly gpu: GpuNavigatorLike;
  private device: GpuDeviceLike | null = null;
  private context: GpuCanvasContextLike | null = null;
  private scenePipeline: GpuRenderPipelineLike | null = null;
  private postPipeline: GpuRenderPipelineLike | null = null;
  private postBindGroupLayout: GpuBindGroupLayoutLike | null = null;

  // Bloom pipelines + their shared bind-group layouts.
  private brightPipeline: GpuRenderPipelineLike | null = null;
  private blurPipeline: GpuRenderPipelineLike | null = null;
  private upsamplePipeline: GpuRenderPipelineLike | null = null;
  /** Layout for bright-pass + blur (uniform + texture + sampler). */
  private bloomBindGroupLayout: GpuBindGroupLayoutLike | null = null;
  /** Layout for upsample (texture + sampler, no uniform). */
  private upsampleBindGroupLayout: GpuBindGroupLayoutLike | null = null;

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
  private bloomUniformBuffer: GpuBufferLike | null = null;
  private postBindGroup: GpuBindGroupLike | null = null;

  /** Downsampled bloom mip chain (created on resize). */
  private bloomMips: BloomMip[] = [];

  /** Post-FX state. Exposure default is neutral (1.0). */
  private exposure = DEFAULT_EXPOSURE;
  private bloom: ResolvedBloom = {
    enabled: DEFAULT_BLOOM_ENABLED,
    threshold: DEFAULT_BLOOM_THRESHOLD,
    intensity: DEFAULT_BLOOM_INTENSITY,
    radius: DEFAULT_BLOOM_RADIUS,
  };
  private vignette: ResolvedVignette = {
    enabled: DEFAULT_VIGNETTE_ENABLED,
    amount: DEFAULT_VIGNETTE_AMOUNT,
  };
  /** Set when composite params changed and the uniform buffer needs reupload. */
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

    // BLOOM bind-group layout (uniform + texture + sampler), shared by the
    // bright-pass and both blur directions.
    const bloomLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 0x2 /* FRAGMENT */, buffer: { type: "uniform" } },
        { binding: 1, visibility: 0x2, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 2, visibility: 0x2, sampler: { type: "filtering" } },
      ],
    });
    this.bloomBindGroupLayout = bloomLayout;
    const bloomPipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bloomLayout],
    });

    const brightModule = device.createShaderModule({ code: BRIGHT_PASS_SHADER });
    this.brightPipeline = device.createRenderPipeline({
      layout: bloomPipelineLayout,
      vertex: { module: brightModule, entryPoint: "vs_fullscreen" },
      fragment: {
        module: brightModule,
        entryPoint: "fs_bright",
        targets: [{ format: HDR_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });

    const blurModule = device.createShaderModule({ code: BLUR_SHADER });
    this.blurPipeline = device.createRenderPipeline({
      layout: bloomPipelineLayout,
      vertex: { module: blurModule, entryPoint: "vs_fullscreen" },
      fragment: {
        module: blurModule,
        entryPoint: "fs_blur",
        targets: [{ format: HDR_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });

    // UPSAMPLE layout (texture + sampler) and pipeline (additive blend).
    const upsampleLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 0x2, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 1, visibility: 0x2, sampler: { type: "filtering" } },
      ],
    });
    this.upsampleBindGroupLayout = upsampleLayout;
    const upsamplePipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [upsampleLayout],
    });
    const upsampleModule = device.createShaderModule({ code: UPSAMPLE_SHADER });
    this.upsamplePipeline = device.createRenderPipeline({
      layout: upsamplePipelineLayout,
      vertex: { module: upsampleModule, entryPoint: "vs_fullscreen" },
      fragment: {
        module: upsampleModule,
        entryPoint: "fs_upsample",
        targets: [
          {
            format: HDR_FORMAT,
            // Additive: dst = src*1 + dst*1, so smaller mips accumulate.
            blend: {
              color: { srcFactor: "one", dstFactor: "one", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });

    // POST pipeline: fullscreen triangle sampling HDR + bloom → swapchain.
    const postModule = device.createShaderModule({ code: POST_SHADER });
    const postLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 0x2, buffer: { type: "uniform" } },
        { binding: 1, visibility: 0x2, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 2, visibility: 0x2, sampler: { type: "filtering" } },
        { binding: 3, visibility: 0x2, texture: { sampleType: "float", viewDimension: "2d" } },
      ],
    });
    this.postBindGroupLayout = postLayout;
    const postPipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [postLayout],
    });
    this.postPipeline = device.createRenderPipeline({
      layout: postPipelineLayout,
      vertex: { module: postModule, entryPoint: "vs_fullscreen" },
      fragment: {
        module: postModule,
        entryPoint: "fs_post",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
    });

    // The sampler + uniform buffers persist across frames/resizes.
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.postUniformBuffer = device.createBuffer({
      size: POST_UNIFORM_BYTES,
      usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
    });
    this.bloomUniformBuffer = device.createBuffer({
      size: BLOOM_UNIFORM_BYTES,
      usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
    });
    this.postParamsDirty = true;

    this.device = device;
    this.context = ctx;

    // Build the HDR target + bloom mip chain for the current size.
    this.ensureTargets();
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.size = computeDrawingBufferSize(cssWidth, cssHeight, dpr);
    this.canvas.width = this.size.width;
    this.canvas.height = this.size.height;
    // Recreate the offscreen HDR texture, bloom mips, and post bind group.
    this.ensureTargets();
  }

  render(scene: Scene, _features: RenderFeatures, _timeSeconds: number): void {
    this.beginFrame(scene.background);
    this.endFrame();
  }

  setPostEffects(config: PostEffectsConfig): void {
    if (config.exposure != null) {
      const next = clampNonNegative(config.exposure, DEFAULT_EXPOSURE);
      if (next !== this.exposure) {
        this.exposure = next;
        this.postParamsDirty = true;
      }
    }
    if (config.bloom) {
      this.applyBloom(config.bloom);
    }
    if (config.vignette) {
      this.applyVignette(config.vignette);
    }
  }

  private applyBloom(bloom: BloomConfig): void {
    if (bloom.enabled != null) {
      this.bloom.enabled = bloom.enabled;
      this.postParamsDirty = true;
    }
    if (bloom.threshold != null) {
      this.bloom.threshold = clampNonNegative(bloom.threshold, DEFAULT_BLOOM_THRESHOLD);
    }
    if (bloom.intensity != null) {
      const next = clampNonNegative(bloom.intensity, DEFAULT_BLOOM_INTENSITY);
      if (next !== this.bloom.intensity) {
        this.bloom.intensity = next;
        this.postParamsDirty = true;
      }
    }
    if (bloom.radius != null) {
      this.bloom.radius = clampNonNegative(bloom.radius, DEFAULT_BLOOM_RADIUS);
    }
  }

  private applyVignette(vignette: VignetteConfig): void {
    if (vignette.enabled != null) {
      this.vignette.enabled = vignette.enabled;
      this.postParamsDirty = true;
    }
    if (vignette.amount != null) {
      const a = vignette.amount;
      const next = Number.isFinite(a) ? Math.min(Math.max(a, 0), 1) : DEFAULT_VIGNETTE_AMOUNT;
      if (next !== this.vignette.amount) {
        this.vignette.amount = next;
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

    if (!this.hdrView || !this.postBindGroup) {
      this.ensureTargets();
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
      device.queue.writeBuffer(
        this.instanceBuffer!,
        0,
        data.buffer,
        data.byteOffset,
        count * BYTES_PER_INSTANCE,
      );
    }

    // Upload composite params (exposure, bloom intensity, vignette) when dirty.
    if (this.postParamsDirty && this.postUniformBuffer) {
      const params = new Float32Array([
        this.exposure,
        this.bloom.enabled ? this.bloom.intensity : 0,
        this.vignette.enabled ? 1 : 0,
        this.vignette.amount,
      ]);
      device.queue.writeBuffer(
        this.postUniformBuffer,
        0,
        params.buffer,
        params.byteOffset,
        POST_UNIFORM_BYTES,
      );
      this.postParamsDirty = false;
    }

    const encoder = device.createCommandEncoder();

    // ── PASS 1: SCENE → offscreen HDR texture ──
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
      scenePass.setVertexBuffer(0, this.instanceBuffer!);
      scenePass.draw(6, count);
    }
    scenePass.end();

    // ── BLOOM PASSES (optional) → downsampled mip chain ──
    // When bloom is enabled, run the bright-pass + separable blur per mip and
    // upsample-accumulate so the largest mip carries the full glow that the
    // composite reads. When disabled, the bloom passes are skipped entirely:
    // the composite's `bloomIntensity` uniform is 0 (see params upload above),
    // so whatever stale content sits in the bloom texture contributes nothing.
    const bloomActive = this.bloom.enabled && this.bloomMips.length > 0;
    if (bloomActive) {
      this.runBloom(device, encoder, hdrView);
    }

    // ── FINAL PASS: POST / COMPOSITE → swapchain ──
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
   * Run the full bloom chain into the mip pyramid:
   *   1. bright-pass: HDR scene → mip0.texA (threshold applied)
   *   2. for each mip i (largest→smallest): blur H then V (ping-pong texA/texB),
   *      ending in texA; then downsample texA into the next-smaller mip's texA.
   *   3. upsample-accumulate (smallest→largest) additively folding each mip back
   *      into the next-larger mip's texA.
   * The composite reads mip0.viewA (the largest, fully-accumulated glow).
   *
   * Each blur invocation re-uploads the bloom uniform to flip the blur direction
   * and carry threshold/radius; this is a tiny 16-byte write per call.
   */
  private runBloom(
    device: GpuDeviceLike,
    encoder: GpuCommandEncoderLike,
    hdrView: GpuTextureViewLike,
  ): void {
    const bright = this.brightPipeline;
    const blur = this.blurPipeline;
    const upsample = this.upsamplePipeline;
    const bloomLayout = this.bloomBindGroupLayout;
    const upLayout = this.upsampleBindGroupLayout;
    const sampler = this.sampler;
    const bloomUniform = this.bloomUniformBuffer;
    if (!bright || !blur || !upsample || !bloomLayout || !upLayout || !sampler || !bloomUniform) {
      return;
    }
    const mips = this.bloomMips;
    const mip0 = mips[0]!;

    // 1) BRIGHT-PASS: HDR scene → mip0.texA. threshold in uniform.x.
    this.writeBloomUniform(device, this.bloom.threshold, 0, 0, this.bloom.radius);
    this.fullscreenPass(encoder, mip0.viewA, bright, this.makeBloomBindGroup(device, bloomLayout, sampler, bloomUniform, hdrView));

    // 2) Per-mip blur (H then V) ending in texA, then downsample to next mip.
    for (let i = 0; i < mips.length; i++) {
      const mip = mips[i]!;
      // Horizontal blur: texA → texB.
      this.writeBloomUniform(device, this.bloom.threshold, 1, 0, this.bloom.radius);
      this.fullscreenPass(
        encoder,
        mip.viewB,
        blur,
        this.makeBloomBindGroup(device, bloomLayout, sampler, bloomUniform, mip.viewA),
      );
      // Vertical blur: texB → texA.
      this.writeBloomUniform(device, this.bloom.threshold, 0, 1, this.bloom.radius);
      this.fullscreenPass(
        encoder,
        mip.viewA,
        blur,
        this.makeBloomBindGroup(device, bloomLayout, sampler, bloomUniform, mip.viewB),
      );

      // Downsample this mip's blurred result into the next (smaller) mip's texA
      // via a plain (non-additive) copy through the upsample pipeline. We clear
      // the destination first by writing (loadOp clear) so it starts fresh.
      const next = mips[i + 1];
      if (next) {
        this.fullscreenPass(
          encoder,
          next.viewA,
          upsample,
          this.makeUpsampleBindGroup(device, upLayout, sampler, mip.viewA),
          { r: 0, g: 0, b: 0, a: 1 },
        );
      }
    }

    // 3) Upsample-accumulate smallest → largest (additive blend folds glow up).
    for (let i = mips.length - 1; i > 0; i--) {
      const src = mips[i]!;
      const dst = mips[i - 1]!;
      this.fullscreenPass(
        encoder,
        dst.viewA,
        upsample,
        this.makeUpsampleBindGroup(device, upLayout, sampler, src.viewA),
        // No clearValue: LOAD the existing (blurred) dst and ADD onto it.
        undefined,
      );
    }
  }

  /** Run a fullscreen-triangle pass into `view` with the given pipeline + bind group. */
  private fullscreenPass(
    encoder: GpuCommandEncoderLike,
    view: GpuTextureViewLike,
    pipeline: GpuRenderPipelineLike,
    bindGroup: GpuBindGroupLike,
    clearValue?: { r: number; g: number; b: number; a: number },
  ): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: clearValue ?? { r: 0, g: 0, b: 0, a: 1 },
          loadOp: clearValue ? "clear" : "load",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3, 1);
    pass.end();
  }

  private makeBloomBindGroup(
    device: GpuDeviceLike,
    layout: GpuBindGroupLayoutLike,
    sampler: GpuSamplerLike,
    uniform: GpuBufferLike,
    srcView: GpuTextureViewLike,
  ): GpuBindGroupLike {
    return device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: srcView },
        { binding: 2, resource: sampler },
      ],
    });
  }

  private makeUpsampleBindGroup(
    device: GpuDeviceLike,
    layout: GpuBindGroupLayoutLike,
    sampler: GpuSamplerLike,
    srcView: GpuTextureViewLike,
  ): GpuBindGroupLike {
    return device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: srcView },
        { binding: 1, resource: sampler },
      ],
    });
  }

  private writeBloomUniform(
    device: GpuDeviceLike,
    threshold: number,
    dirX: number,
    dirY: number,
    radius: number,
  ): void {
    if (!this.bloomUniformBuffer) return;
    const data = new Float32Array([threshold, dirX, dirY, radius]);
    device.queue.writeBuffer(
      this.bloomUniformBuffer,
      0,
      data.buffer,
      data.byteOffset,
      BLOOM_UNIFORM_BYTES,
    );
  }

  /**
   * (Re)create the offscreen HDR texture + bloom mip chain at the current size,
   * then rebuild the post-pass bind group against the fresh HDR + bloom views.
   * Called from init()/resize() and defensively before the first frame. Releases
   * prior textures so resizes don't leak GPU memory.
   */
  private ensureTargets(): void {
    const device = this.device;
    const sampler = this.sampler;
    const layout = this.postBindGroupLayout;
    const uniform = this.postUniformBuffer;
    if (!device || !sampler || !layout || !uniform) return;
    const { width, height } = this.size;
    if (width <= 0 || height <= 0) return;

    // Release the prior HDR target + bloom mips before allocating anew.
    this.hdrTexture?.destroy?.();
    this.releaseBloomMips();

    const texture = device.createTexture({
      size: { width, height },
      format: HDR_FORMAT,
      usage: TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.TEXTURE_BINDING,
    });
    const view = texture.createView();
    this.hdrTexture = texture;
    this.hdrView = view;

    // Build the downsampled bloom mip chain (each level half the prior, min 1px).
    this.bloomMips = [];
    let mw = width;
    let mh = height;
    for (let i = 0; i < BLOOM_MIP_LEVELS; i++) {
      mw = Math.max(1, Math.floor(mw / 2));
      mh = Math.max(1, Math.floor(mh / 2));
      const texA = device.createTexture({
        size: { width: mw, height: mh },
        format: HDR_FORMAT,
        usage: TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.TEXTURE_BINDING,
      });
      const texB = device.createTexture({
        size: { width: mw, height: mh },
        format: HDR_FORMAT,
        usage: TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.TEXTURE_BINDING,
      });
      this.bloomMips.push({
        width: mw,
        height: mh,
        texA,
        viewA: texA.createView(),
        texB,
        viewB: texB.createView(),
      });
      if (mw === 1 && mh === 1) break;
    }

    const bloomView = this.bloomMips[0]?.viewA ?? view;
    this.postBindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: view },
        { binding: 2, resource: sampler },
        { binding: 3, resource: bloomView },
      ],
    });
  }

  /** Destroy and clear the bloom mip chain. */
  private releaseBloomMips(): void {
    for (const mip of this.bloomMips) {
      mip.texA.destroy?.();
      mip.texB.destroy?.();
    }
    this.bloomMips = [];
  }

  /** Grow (or first-create) the instance buffer to hold at least `count` rects. */
  private ensureInstanceCapacity(device: GpuDeviceLike, count: number): void {
    if (this.instanceBuffer && this.instanceCapacity >= count) return;
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
    this.releaseBloomMips();
    this.postUniformBuffer?.destroy?.();
    this.postUniformBuffer = null;
    this.bloomUniformBuffer?.destroy?.();
    this.bloomUniformBuffer = null;
    this.postBindGroup = null;
    this.postBindGroupLayout = null;
    this.bloomBindGroupLayout = null;
    this.upsampleBindGroupLayout = null;
    this.sampler = null;
    this.scenePipeline = null;
    this.postPipeline = null;
    this.brightPipeline = null;
    this.blurPipeline = null;
    this.upsamplePipeline = null;
    this.context?.unconfigure?.();
    this.context = null;
    this.device = null;
    this.rects = [];
    this.frameOpen = false;
    this.exposure = DEFAULT_EXPOSURE;
    this.bloom = {
      enabled: DEFAULT_BLOOM_ENABLED,
      threshold: DEFAULT_BLOOM_THRESHOLD,
      intensity: DEFAULT_BLOOM_INTENSITY,
      radius: DEFAULT_BLOOM_RADIUS,
    };
    this.vignette = { enabled: DEFAULT_VIGNETTE_ENABLED, amount: DEFAULT_VIGNETTE_AMOUNT };
    this.postParamsDirty = true;
  }
}

/** Clamp a value to a finite, non-negative number, falling back to `fallback`. */
function clampNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
