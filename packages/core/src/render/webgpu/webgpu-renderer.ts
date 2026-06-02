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
  expandLineToQuad,
  type BlendMode,
  type BloomConfig,
  type DrawingBufferSize,
  type FeedbackConfig,
  type GlowSpec,
  type GradientFill,
  type LineSpec,
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

/**
 * Feedback / trail defaults. Disabled by default — presets opt in. The decay
 * default (0.9) is a conservative, clearly-visible-but-bounded trail. Decay is
 * clamped below 1 so trails always eventually fade (1.0 would never decay and
 * could accumulate unboundedly in the HDR history).
 */
const DEFAULT_FEEDBACK_ENABLED = false;
const DEFAULT_FEEDBACK_DECAY = 0.9;
const MAX_FEEDBACK_DECAY = 0.999;

/**
 * Bytes in the FEEDBACK uniform buffer: decay (+ 3 pad) → 4 × f32 = 16 bytes
 * (one std140 vec4 slot). Re-uploaded only when the decay changes.
 */
const FEEDBACK_UNIFORM_BYTES = 16;

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
  resource: { buffer: GpuBufferLike } | GpuSamplerLike | GpuTextureViewLike;
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
  draw(
    vertexCount: number,
    instanceCount?: number,
    firstVertex?: number,
    firstInstance?: number,
  ): void;
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

/** Floats per RECT instance: x, y, w, h, r, g, b, a. */
const FLOATS_PER_INSTANCE = 8;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;

/** Floats per GRADIENT instance: rect(4) + from(4) + to(4) + params(4). */
const FLOATS_PER_GRADIENT = 16;
const BYTES_PER_GRADIENT = FLOATS_PER_GRADIENT * 4;

/** Floats per GLOW instance: center(4: cx,cy,radius,_) + color(4) + extra(4). */
const FLOATS_PER_GLOW = 12;
const BYTES_PER_GLOW = FLOATS_PER_GLOW * 4;

/** Floats per LINE instance: c01(4) + c23(4) + color(4). */
const FLOATS_PER_LINE = 12;
const BYTES_PER_LINE = FLOATS_PER_LINE * 4;

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
 * WGSL for the GRADIENT pipeline. Same unit-quad expansion as the rect shader,
 * but each instance carries `from`/`to` colors and a `mode` packed into the
 * rect's spare lane: the per-instance buffer is `[x,y,w,h, fromRGBA, toRGBA,
 * angle, radial, _, _]`. The fragment interpolates `from`→`to` across the rect:
 * linear along `angle` (radians, clockwise from +x in rect-UV space) or radial
 * from center to the farthest corner. HDR colors pass through unclamped.
 */
const GRADIENT_SHADER = /* wgsl */ `
struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) fromColor : vec4<f32>,
  @location(2) toColor : vec4<f32>,
  @location(3) params : vec2<f32>,  // angle, radial(>0.5)
};

@vertex
fn vs_grad(
  @builtin(vertex_index) vi : u32,
  @location(0) rect : vec4<f32>,       // x, y, w, h
  @location(1) fromColor : vec4<f32>,
  @location(2) toColor : vec4<f32>,
  @location(3) params : vec4<f32>,     // angle, radial, _, _
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
  var out : VsOut;
  out.pos = vec4<f32>(nx * 2.0 - 1.0, 1.0 - ny * 2.0, 0.0, 1.0);
  out.uv = uv;
  out.fromColor = fromColor;
  out.toColor = toColor;
  out.params = vec2<f32>(params.x, params.y);
  return out;
}

@fragment
fn fs_grad(in : VsOut) -> @location(0) vec4<f32> {
  var t : f32;
  if (in.params.y > 0.5) {
    // Radial: 0 at center, 1 at the farthest corner (dist to (0.5,0.5) / 0.5√2).
    let d = in.uv - vec2<f32>(0.5, 0.5);
    t = clamp(length(d) / 0.7071068, 0.0, 1.0);
  } else {
    // Linear along the angle direction, projected onto [0,1].
    let dir = vec2<f32>(cos(in.params.x), sin(in.params.x));
    // Project uv onto dir, remap so the rect spans [0,1] for axis-aligned angles.
    let proj = dot(in.uv, dir);
    // For unit-square uv, proj ranges within [min,max]; normalize by the
    // direction's L1 footprint so 0..1 maps edge→edge for 0/90/180/270°.
    let span = abs(dir.x) + abs(dir.y);
    let lo = min(0.0, dir.x) + min(0.0, dir.y);
    t = clamp((proj - lo) / max(span, 1.0e-4), 0.0, 1.0);
  }
  return mix(in.fromColor, in.toColor, t);
}
`;

/**
 * WGSL for the GLOW pipeline: a feathered, additive radial blob. Each instance
 * is a bounding QUAD around the glow — `[cx, cy, radius, _, colorRGBA,
 * intensity, _, _, _]` — and the fragment computes a smooth gaussian-ish falloff
 * from center (full) to edge (zero). The color is scaled by `intensity` so the
 * core can exceed 1.0 (HDR) and feed bloom. Drawn with additive blend.
 */
const GLOW_SHADER = /* wgsl */ `
struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) local : vec2<f32>,     // [-1,1]^2 within the glow quad
  @location(1) color : vec4<f32>,
  @location(2) intensity : f32,
};

@vertex
fn vs_glow(
  @builtin(vertex_index) vi : u32,
  @location(0) center : vec4<f32>,    // cx, cy, radius, _
  @location(1) color : vec4<f32>,
  @location(2) extra : vec4<f32>,     // intensity, _, _, _
) -> VsOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
  );
  let c = corners[vi];
  let nx = center.x + c.x * center.z;
  let ny = center.y + c.y * center.z;
  var out : VsOut;
  out.pos = vec4<f32>(nx * 2.0 - 1.0, 1.0 - ny * 2.0, 0.0, 1.0);
  out.local = c;
  out.color = color;
  out.intensity = extra.x;
  return out;
}

@fragment
fn fs_glow(in : VsOut) -> @location(0) vec4<f32> {
  let r = length(in.local);
  // Smooth gaussian-like falloff: 1 at center → 0 at the edge (r=1).
  let falloff = exp(-4.0 * r * r) * (1.0 - smoothstep(0.0, 1.0, r));
  let rgb = in.color.rgb * in.intensity * falloff;
  return vec4<f32>(rgb, in.color.a * falloff);
}
`;

/**
 * WGSL for the LINE pipeline: each instance carries the FOUR pre-expanded quad
 * corners (start-left, start-right, end-left, end-right, in normalized coords)
 * plus a color. The vertex stage selects the corner for the two triangles; the
 * fragment is a flat color. Expansion (normal offset by width/2) is computed on
 * the CPU via the shared `expandLineToQuad` helper. Instance layout:
 * `[c0xy, c1xy, c2xy, c3xy, colorRGBA]` = 12 floats.
 */
const LINE_SHADER = /* wgsl */ `
struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) color : vec4<f32>,
};

@vertex
fn vs_line(
  @builtin(vertex_index) vi : u32,
  @location(0) c01 : vec4<f32>,   // c0.xy, c1.xy
  @location(1) c23 : vec4<f32>,   // c2.xy, c3.xy
  @location(2) color : vec4<f32>,
) -> VsOut {
  // Two triangles from the 4 corners: [0,1,2] and [2,1,3].
  var idx = array<u32, 6>(0u, 1u, 2u, 2u, 1u, 3u);
  let sel = idx[vi];
  var p : vec2<f32>;
  if (sel == 0u) { p = c01.xy; }
  else if (sel == 1u) { p = c01.zw; }
  else if (sel == 2u) { p = c23.xy; }
  else { p = c23.zw; }
  var out : VsOut;
  out.pos = vec4<f32>(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  out.color = color;
  return out;
}

@fragment
fn fs_line(in : VsOut) -> @location(0) vec4<f32> {
  return in.color;
}
`;

/** Additive blend: dst = src*1 + dst*1. Used for glows + additive primitives. */
const ADDITIVE_BLEND: GpuBlendStateLike = {
  color: { srcFactor: "one", dstFactor: "one", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
};

/** Standard source-over alpha blend. */
const ALPHA_BLEND: GpuBlendStateLike = {
  color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
};

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
 * WGSL for the FEEDBACK COMPOSITE pass: `combined = scene + history * decay`.
 * Reads the freshly-rendered HDR scene AND the persistent (previous-frame)
 * history texture, scales the history by `decay`, and adds it to the scene. The
 * result is the trail-accumulated frame that feeds bloom + tonemap and is then
 * stored back into history. binding 0 = feedback params uniform (decay in `.x`),
 * 1 = HDR scene texture, 2 = sampler, 3 = history texture.
 */
const FEEDBACK_SHADER = /* wgsl */ `
${FULLSCREEN_VS}

struct FeedbackParams {
  decay : f32,
  padA : f32,
  padB : f32,
  padC : f32,
};

@group(0) @binding(0) var<uniform> params : FeedbackParams;
@group(0) @binding(1) var sceneTex : texture_2d<f32>;
@group(0) @binding(2) var srcSampler : sampler;
@group(0) @binding(3) var historyTex : texture_2d<f32>;

@fragment
fn fs_feedback(in : VsOut) -> @location(0) vec4<f32> {
  let scene = textureSample(sceneTex, srcSampler, in.uv).rgb;
  let history = textureSample(historyTex, srcSampler, in.uv).rgb;
  return vec4<f32>(scene + history * params.decay, 1.0);
}
`;

/**
 * WGSL for a plain COPY pass: sample a source texture and write it through
 * unchanged. Used to copy the feedback-combined result back into the HDR scene
 * target (so bloom + post read it unchanged). binding 0 = source, 1 = sampler.
 */
const COPY_SHADER = /* wgsl */ `
${FULLSCREEN_VS}

@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var srcSampler : sampler;

@fragment
fn fs_copy(in : VsOut) -> @location(0) vec4<f32> {
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

/**
 * An ordered draw command accumulated during a frame. The scene pass replays
 * these in submission order so primitives composite correctly. Consecutive
 * commands of the same `kind` + `blend` are coalesced into one instanced draw
 * by {@link WebgpuRenderer.endFrame}.
 */
type SceneCommand =
  | { kind: "rect"; blend: BlendMode; rect: NormalizedRect }
  | { kind: "gradient"; blend: BlendMode; rect: NormalizedRect; fill: GradientFill }
  | { kind: "glow"; glow: GlowSpec }
  | { kind: "line"; blend: BlendMode; line: LineSpec };

/** A coalesced run of same-kind/same-blend commands → one instanced draw. */
interface DrawBatch {
  kind: SceneCommand["kind"];
  blend: BlendMode;
  /** Indices into the per-frame command list this batch covers. */
  commands: SceneCommand[];
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

interface ResolvedFeedback {
  enabled: boolean;
  decay: number;
}

/**
 * A growable per-kind instance buffer: owns a `GPUBuffer` (vertex usage), its
 * capacity in instances, and a CPU staging `Float32Array`. {@link ensure} grows
 * the GPU + CPU storage to fit `count` instances; {@link upload} writes the
 * staged data. Keeps the per-primitive buffer churn in one tested place.
 */
class InstanceBuffer {
  buffer: GpuBufferLike | null = null;
  capacity = 0;
  data: Float32Array = new Float32Array(0);

  constructor(private readonly floatsPerInstance: number) {}

  private get bytesPerInstance(): number {
    return this.floatsPerInstance * 4;
  }

  /** Grow to hold at least `count` instances (doubling, min 64). */
  ensure(device: GpuDeviceLike, count: number): void {
    if (this.buffer && this.capacity >= count) return;
    const capacity = Math.max(count, this.capacity * 2, 64);
    this.buffer?.destroy?.();
    this.buffer = device.createBuffer({
      size: capacity * this.bytesPerInstance,
      usage: BUFFER_USAGE.VERTEX | BUFFER_USAGE.COPY_DST,
    });
    this.capacity = capacity;
    this.data = new Float32Array(capacity * this.floatsPerInstance);
  }

  /** Upload the first `count` instances of the staged data to the GPU buffer. */
  upload(device: GpuDeviceLike, count: number): void {
    if (!this.buffer || count <= 0) return;
    device.queue.writeBuffer(
      this.buffer,
      0,
      this.data.buffer,
      this.data.byteOffset,
      count * this.bytesPerInstance,
    );
  }

  destroy(): void {
    this.buffer?.destroy?.();
    this.buffer = null;
    this.capacity = 0;
    this.data = new Float32Array(0);
  }
}

export class WebgpuRenderer implements Renderer {
  readonly backend: RendererBackend = "webgpu";

  private readonly canvas: WebgpuCanvasLike;
  private readonly gpu: GpuNavigatorLike;
  private device: GpuDeviceLike | null = null;
  private context: GpuCanvasContextLike | null = null;

  /**
   * Scene-primitive pipelines. Each solid/gradient/line primitive comes in an
   * alpha and an additive blend variant (selected per batch by the current
   * blend mode); the glow is inherently additive light, so it has only the
   * additive variant. All target the HDR offscreen texture, so bright glows feed
   * bloom. Built once in {@link init}.
   */
  private rectPipelineAlpha: GpuRenderPipelineLike | null = null;
  private rectPipelineAdd: GpuRenderPipelineLike | null = null;
  private gradientPipelineAlpha: GpuRenderPipelineLike | null = null;
  private gradientPipelineAdd: GpuRenderPipelineLike | null = null;
  private linePipelineAlpha: GpuRenderPipelineLike | null = null;
  private linePipelineAdd: GpuRenderPipelineLike | null = null;
  private glowPipeline: GpuRenderPipelineLike | null = null;

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

  // Feedback / trail pipelines + their bind-group layouts.
  /** Feedback composite: scene + history*decay (uniform + scene + sampler + history). */
  private feedbackPipeline: GpuRenderPipelineLike | null = null;
  private feedbackBindGroupLayout: GpuBindGroupLayoutLike | null = null;
  /** Plain copy (combined → HDR scene target): texture + sampler. */
  private copyPipeline: GpuRenderPipelineLike | null = null;
  private copyBindGroupLayout: GpuBindGroupLayoutLike | null = null;

  private format = "bgra8unorm";
  private size: DrawingBufferSize = { width: 0, height: 0 };

  /** Per-frame accumulation: the background and the ordered draw commands. */
  private background: RgbaColor = { r: 0, g: 0, b: 0, a: 1 };
  private commands: SceneCommand[] = [];
  private frameOpen = false;
  /** Current blend mode for primitives issued next. Reset to alpha per frame. */
  private blendMode: BlendMode = "alpha";

  /**
   * Per-kind instance buffers (+ capacity in instances and CPU staging). Each
   * primitive kind has its own growable vertex buffer; a frame uploads each
   * kind's instances once and the scene pass issues coalesced instanced draws.
   */
  private rectBuffer = new InstanceBuffer(FLOATS_PER_INSTANCE);
  private gradientBuffer = new InstanceBuffer(FLOATS_PER_GRADIENT);
  private glowBuffer = new InstanceBuffer(FLOATS_PER_GLOW);
  private lineBuffer = new InstanceBuffer(FLOATS_PER_LINE);

  /** Offscreen HDR target (created on resize) + post-pass resources. */
  private hdrTexture: GpuTextureLike | null = null;
  private hdrView: GpuTextureViewLike | null = null;
  private sampler: GpuSamplerLike | null = null;
  private postUniformBuffer: GpuBufferLike | null = null;
  private bloomUniformBuffer: GpuBufferLike | null = null;
  private feedbackUniformBuffer: GpuBufferLike | null = null;
  private postBindGroup: GpuBindGroupLike | null = null;

  /** Downsampled bloom mip chain (created on resize). */
  private bloomMips: BloomMip[] = [];

  /**
   * Ping-pong HDR "history" textures for the feedback / trail buffer (created
   * on resize). Each frame the feedback pass READS `history[historyRead]`
   * (last frame's combined output) and WRITES the new combined output into
   * `history[1 - historyRead]`; then `historyRead` flips. Two textures avoid a
   * read/write hazard. History resets (cleared) on resize. `historyPrimed`
   * tracks whether the read texture holds a real prior frame yet (it is cleared
   * to black on the first feedback frame after a resize/enable so trails start
   * from nothing rather than garbage).
   */
  private historyTex: [GpuTextureLike, GpuTextureLike] | null = null;
  private historyView: [GpuTextureViewLike, GpuTextureViewLike] | null = null;
  private historyRead = 0;
  private historyPrimed = false;

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
  /** Feedback / trail state. Disabled by default; presets opt in. */
  private feedback: ResolvedFeedback = {
    enabled: DEFAULT_FEEDBACK_ENABLED,
    decay: DEFAULT_FEEDBACK_DECAY,
  };
  /** Set when composite params changed and the uniform buffer needs reupload. */
  private postParamsDirty = true;
  /** Set when the feedback decay changed and its uniform needs reupload. */
  private feedbackParamsDirty = true;

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

    // SCENE PRIMITIVE pipelines → HDR offscreen target. Built ONCE. Each
    // solid/gradient/line primitive has an alpha + additive variant; the glow is
    // inherently additive light (one variant). The scene pass selects the right
    // pipeline per coalesced batch.

    // RECT: instanced unit quads, [rect.xyzw, color.rgba] per instance.
    const rectModule = device.createShaderModule({ code: QUAD_SHADER });
    const rectVertex = {
      module: rectModule,
      entryPoint: "vs_main",
      buffers: [
        {
          arrayStride: BYTES_PER_INSTANCE,
          stepMode: "instance" as const,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x4" },
            { shaderLocation: 1, offset: 16, format: "float32x4" },
          ],
        },
      ],
    };
    this.rectPipelineAlpha = device.createRenderPipeline({
      layout: "auto",
      vertex: rectVertex,
      fragment: {
        module: rectModule,
        entryPoint: "fs_main",
        targets: [{ format: HDR_FORMAT, blend: ALPHA_BLEND }],
      },
      primitive: { topology: "triangle-list" },
    });
    this.rectPipelineAdd = device.createRenderPipeline({
      layout: "auto",
      vertex: rectVertex,
      fragment: {
        module: rectModule,
        entryPoint: "fs_main",
        targets: [{ format: HDR_FORMAT, blend: ADDITIVE_BLEND }],
      },
      primitive: { topology: "triangle-list" },
    });

    // GRADIENT: instanced quads with [rect, from, to, params] per instance.
    const gradientModule = device.createShaderModule({ code: GRADIENT_SHADER });
    const gradientVertex = {
      module: gradientModule,
      entryPoint: "vs_grad",
      buffers: [
        {
          arrayStride: BYTES_PER_GRADIENT,
          stepMode: "instance" as const,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x4" },
            { shaderLocation: 1, offset: 16, format: "float32x4" },
            { shaderLocation: 2, offset: 32, format: "float32x4" },
            { shaderLocation: 3, offset: 48, format: "float32x4" },
          ],
        },
      ],
    };
    this.gradientPipelineAlpha = device.createRenderPipeline({
      layout: "auto",
      vertex: gradientVertex,
      fragment: {
        module: gradientModule,
        entryPoint: "fs_grad",
        targets: [{ format: HDR_FORMAT, blend: ALPHA_BLEND }],
      },
      primitive: { topology: "triangle-list" },
    });
    this.gradientPipelineAdd = device.createRenderPipeline({
      layout: "auto",
      vertex: gradientVertex,
      fragment: {
        module: gradientModule,
        entryPoint: "fs_grad",
        targets: [{ format: HDR_FORMAT, blend: ADDITIVE_BLEND }],
      },
      primitive: { topology: "triangle-list" },
    });

    // GLOW: instanced feathered quads, [center(cx,cy,r,_), color, extra(intensity)].
    const glowModule = device.createShaderModule({ code: GLOW_SHADER });
    this.glowPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: glowModule,
        entryPoint: "vs_glow",
        buffers: [
          {
            arrayStride: BYTES_PER_GLOW,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x4" },
              { shaderLocation: 1, offset: 16, format: "float32x4" },
              { shaderLocation: 2, offset: 32, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: {
        module: glowModule,
        entryPoint: "fs_glow",
        // Glows always accumulate light additively.
        targets: [{ format: HDR_FORMAT, blend: ADDITIVE_BLEND }],
      },
      primitive: { topology: "triangle-list" },
    });

    // LINE: instanced quads from 4 pre-expanded corners, [c01, c23, color].
    const lineModule = device.createShaderModule({ code: LINE_SHADER });
    const lineVertex = {
      module: lineModule,
      entryPoint: "vs_line",
      buffers: [
        {
          arrayStride: BYTES_PER_LINE,
          stepMode: "instance" as const,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x4" },
            { shaderLocation: 1, offset: 16, format: "float32x4" },
            { shaderLocation: 2, offset: 32, format: "float32x4" },
          ],
        },
      ],
    };
    this.linePipelineAlpha = device.createRenderPipeline({
      layout: "auto",
      vertex: lineVertex,
      fragment: {
        module: lineModule,
        entryPoint: "fs_line",
        targets: [{ format: HDR_FORMAT, blend: ALPHA_BLEND }],
      },
      primitive: { topology: "triangle-list" },
    });
    this.linePipelineAdd = device.createRenderPipeline({
      layout: "auto",
      vertex: lineVertex,
      fragment: {
        module: lineModule,
        entryPoint: "fs_line",
        targets: [{ format: HDR_FORMAT, blend: ADDITIVE_BLEND }],
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

    // FEEDBACK composite pipeline: scene + history*decay → combined HDR. Layout
    // is uniform(decay) + scene texture + sampler + history texture.
    const feedbackLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 0x2, buffer: { type: "uniform" } },
        { binding: 1, visibility: 0x2, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 2, visibility: 0x2, sampler: { type: "filtering" } },
        { binding: 3, visibility: 0x2, texture: { sampleType: "float", viewDimension: "2d" } },
      ],
    });
    this.feedbackBindGroupLayout = feedbackLayout;
    const feedbackPipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [feedbackLayout],
    });
    const feedbackModule = device.createShaderModule({ code: FEEDBACK_SHADER });
    this.feedbackPipeline = device.createRenderPipeline({
      layout: feedbackPipelineLayout,
      vertex: { module: feedbackModule, entryPoint: "vs_fullscreen" },
      fragment: {
        module: feedbackModule,
        entryPoint: "fs_feedback",
        targets: [{ format: HDR_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });

    // COPY pipeline (combined → HDR scene target): texture + sampler. Reuses the
    // upsample-style two-binding layout shape but as its own layout for clarity.
    const copyLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 0x2, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 1, visibility: 0x2, sampler: { type: "filtering" } },
      ],
    });
    this.copyBindGroupLayout = copyLayout;
    const copyPipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [copyLayout],
    });
    const copyModule = device.createShaderModule({ code: COPY_SHADER });
    this.copyPipeline = device.createRenderPipeline({
      layout: copyPipelineLayout,
      vertex: { module: copyModule, entryPoint: "vs_fullscreen" },
      fragment: {
        module: copyModule,
        entryPoint: "fs_copy",
        targets: [{ format: HDR_FORMAT }],
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
    this.feedbackUniformBuffer = device.createBuffer({
      size: FEEDBACK_UNIFORM_BYTES,
      usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
    });
    this.postParamsDirty = true;
    this.feedbackParamsDirty = true;

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
    if (config.feedback) {
      this.applyFeedback(config.feedback);
    }
  }

  private applyFeedback(feedback: FeedbackConfig): void {
    if (feedback.enabled != null) {
      if (feedback.enabled !== this.feedback.enabled) {
        this.feedback.enabled = feedback.enabled;
        // Re-priming history when (re)enabling so trails start from black, not
        // whatever stale content the history textures hold.
        this.historyPrimed = false;
      }
    }
    if (feedback.decay != null) {
      const d = feedback.decay;
      const next = Number.isFinite(d) ? Math.min(Math.max(d, 0), MAX_FEEDBACK_DECAY) : DEFAULT_FEEDBACK_DECAY;
      if (next !== this.feedback.decay) {
        this.feedback.decay = next;
        this.feedbackParamsDirty = true;
      }
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
    this.commands = [];
    this.blendMode = "alpha";
    this.frameOpen = true;
  }

  setBlendMode(mode: BlendMode): void {
    this.blendMode = mode;
  }

  drawRect(rect: NormalizedRect): void {
    this.require("drawRect");
    this.requireFrame("drawRect");
    if (rect.w <= 0 || rect.h <= 0) return;
    this.commands.push({ kind: "rect", blend: this.blendMode, rect });
  }

  drawGradientRect(rect: NormalizedRect, fill: GradientFill): void {
    this.require("drawGradientRect");
    this.requireFrame("drawGradientRect");
    if (rect.w <= 0 || rect.h <= 0) return;
    this.commands.push({ kind: "gradient", blend: this.blendMode, rect, fill });
  }

  drawGlow(glow: GlowSpec): void {
    this.require("drawGlow");
    this.requireFrame("drawGlow");
    if (glow.radius <= 0) return;
    // Glow is always additive light; blend mode does not apply to it.
    this.commands.push({ kind: "glow", glow });
  }

  drawLine(line: LineSpec): void {
    this.require("drawLine");
    this.requireFrame("drawLine");
    if (line.width <= 0) return;
    this.commands.push({ kind: "line", blend: this.blendMode, line });
  }

  private requireFrame(op: string): void {
    if (!this.frameOpen) {
      throw new Error(`WebgpuRenderer: ${op}() called outside beginFrame().`);
    }
  }

  endFrame(): void {
    const { device, context, postPipeline } = this.require("endFrame");
    this.requireFrame("endFrame");
    this.frameOpen = false;

    if (!this.hdrView || !this.postBindGroup) {
      this.ensureTargets();
    }
    const hdrView = this.hdrView;
    const postBindGroup = this.postBindGroup;
    if (!hdrView || !postBindGroup) {
      throw new Error("WebgpuRenderer: offscreen HDR target unavailable.");
    }

    // Coalesce the ordered command list into batches (runs of same kind+blend),
    // stage each kind's instances into its growable buffer, and remember the
    // per-batch instance offset so the scene pass can issue one draw per batch.
    const batches = coalesce(this.commands);
    const staged = this.stageBatches(device, batches);

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

    // Upload feedback decay when dirty (only consumed when feedback is active).
    if (this.feedbackParamsDirty && this.feedbackUniformBuffer) {
      const params = new Float32Array([this.feedback.decay, 0, 0, 0]);
      device.queue.writeBuffer(
        this.feedbackUniformBuffer,
        0,
        params.buffer,
        params.byteOffset,
        FEEDBACK_UNIFORM_BYTES,
      );
      this.feedbackParamsDirty = false;
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
    // Replay batches IN ORDER so primitives composite correctly. Each batch sets
    // its pipeline + vertex buffer (per kind/blend) and issues ONE instanced draw.
    for (const draw of staged) {
      scenePass.setPipeline(draw.pipeline);
      scenePass.setVertexBuffer(0, draw.buffer);
      scenePass.draw(6, draw.instanceCount, 0, draw.firstInstance);
    }
    scenePass.end();

    // ── FEEDBACK / TRAIL PASSES (optional) → blend in the decayed history ──
    // When feedback is active, composite the previous frame's combined output
    // (the "history" texture) into the freshly-rendered scene scaled by `decay`,
    // then copy that combined result back INTO the HDR scene target so bloom +
    // post read it unchanged. The combined result is ALSO what gets stored as
    // the next frame's history (it lives in the write-history texture after the
    // feedback pass), so prior frames fade out geometrically over time.
    //
    // Ping-pong: read history[historyRead], write history[1-historyRead]. On the
    // first feedback frame after a resize/enable the read texture is not yet
    // primed, so the feedback pass is skipped (the scene IS the first history)
    // and we just seed history from the scene — trails start from nothing.
    const feedbackActive = this.feedback.enabled && this.historyView != null;
    if (feedbackActive) {
      this.runFeedback(device, encoder, hdrView);
    }

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
   * Run the feedback / trail chain for this frame, mutating `hdrView` in place so
   * the rest of the pipeline (bloom + post) sees the trail-accumulated result.
   *
   * Two cases:
   *  - NOT primed yet (first feedback frame after resize/enable): there is no
   *    valid prior frame, so we just SEED history from the current scene (copy
   *    hdr → write-history) and leave the scene untouched (no trail this frame).
   *  - primed: `combined = scene + readHistory * decay` written into the
   *    write-history texture, then copied back into `hdrView` so bloom/post read
   *    the combined frame. The write-history holds the combined result, which
   *    becomes next frame's read-history after the ping-pong flip.
   *
   * Either way `historyRead` flips at the end so the texture just written becomes
   * next frame's read source.
   */
  private runFeedback(
    device: GpuDeviceLike,
    encoder: GpuCommandEncoderLike,
    hdrView: GpuTextureViewLike,
  ): void {
    const feedback = this.feedbackPipeline;
    const copy = this.copyPipeline;
    const feedbackLayout = this.feedbackBindGroupLayout;
    const copyLayout = this.copyBindGroupLayout;
    const sampler = this.sampler;
    const feedbackUniform = this.feedbackUniformBuffer;
    const views = this.historyView;
    if (!feedback || !copy || !feedbackLayout || !copyLayout || !sampler || !feedbackUniform || !views) {
      return;
    }
    const readView = views[this.historyRead];
    const writeView = views[1 - this.historyRead]!;

    if (!this.historyPrimed) {
      // SEED: copy the current scene into the write-history texture. No trail is
      // applied this frame (there is no prior frame to blend). The scene target
      // is left as-is so this frame renders plainly.
      this.fullscreenPass(
        encoder,
        writeView,
        copy,
        this.makeUpsampleBindGroup(device, copyLayout, sampler, hdrView),
        { r: 0, g: 0, b: 0, a: 1 },
      );
      this.historyPrimed = true;
    } else {
      // COMPOSITE: combined = scene + readHistory*decay → write-history texture.
      this.fullscreenPass(
        encoder,
        writeView,
        feedback,
        device.createBindGroup({
          layout: feedbackLayout,
          entries: [
            { binding: 0, resource: { buffer: feedbackUniform } },
            { binding: 1, resource: hdrView },
            { binding: 2, resource: sampler },
            { binding: 3, resource: readView! },
          ],
        }),
        { r: 0, g: 0, b: 0, a: 1 },
      );
      // COPY the combined result back into the HDR scene target so bloom + post
      // (whose bind groups reference hdrView) read the trail-accumulated frame.
      this.fullscreenPass(
        encoder,
        hdrView,
        copy,
        this.makeUpsampleBindGroup(device, copyLayout, sampler, writeView),
        { r: 0, g: 0, b: 0, a: 1 },
      );
    }

    // Ping-pong: the texture we just wrote becomes next frame's read source.
    this.historyRead = 1 - this.historyRead;
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
    this.fullscreenPass(
      encoder,
      mip0.viewA,
      bright,
      this.makeBloomBindGroup(device, bloomLayout, sampler, bloomUniform, hdrView),
    );

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

    // Release the prior HDR target + bloom mips + history before allocating anew.
    this.hdrTexture?.destroy?.();
    this.releaseBloomMips();
    this.releaseHistory();

    const texture = device.createTexture({
      size: { width, height },
      format: HDR_FORMAT,
      usage: TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.TEXTURE_BINDING,
    });
    const view = texture.createView();
    this.hdrTexture = texture;
    this.hdrView = view;

    // (Re)create the feedback / trail history ping-pong pair at full resolution.
    // History resets on resize: re-priming ensures trails restart from black
    // rather than blending stale (or differently-sized) content.
    const makeHistory = (): GpuTextureLike =>
      device.createTexture({
        size: { width, height },
        format: HDR_FORMAT,
        usage: TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.TEXTURE_BINDING,
      });
    const h0 = makeHistory();
    const h1 = makeHistory();
    this.historyTex = [h0, h1];
    this.historyView = [h0.createView(), h1.createView()];
    this.historyRead = 0;
    this.historyPrimed = false;

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

  /** Destroy and clear the feedback / trail history textures. */
  private releaseHistory(): void {
    if (this.historyTex) {
      this.historyTex[0].destroy?.();
      this.historyTex[1].destroy?.();
    }
    this.historyTex = null;
    this.historyView = null;
    this.historyRead = 0;
    this.historyPrimed = false;
  }

  /**
   * Stage every batch's instances into its per-kind buffer, upload once per
   * kind, and return the per-batch GPU draw descriptors (pipeline + buffer +
   * instance range) in batch order. Instances for each kind are packed
   * contiguously across batches of that kind, so `firstInstance` lets each batch
   * draw its slice from the single shared buffer.
   */
  private stageBatches(device: GpuDeviceLike, batches: DrawBatch[]): StagedDraw[] {
    // Count instances per kind to size each buffer once.
    let rectN = 0;
    let gradN = 0;
    let glowN = 0;
    let lineN = 0;
    for (const b of batches) {
      if (b.kind === "rect") rectN += b.commands.length;
      else if (b.kind === "gradient") gradN += b.commands.length;
      else if (b.kind === "glow") glowN += b.commands.length;
      else lineN += b.commands.length;
    }
    if (rectN) this.rectBuffer.ensure(device, rectN);
    if (gradN) this.gradientBuffer.ensure(device, gradN);
    if (glowN) this.glowBuffer.ensure(device, glowN);
    if (lineN) this.lineBuffer.ensure(device, lineN);

    const staged: StagedDraw[] = [];
    let rectCursor = 0;
    let gradCursor = 0;
    let glowCursor = 0;
    let lineCursor = 0;
    for (const b of batches) {
      const count = b.commands.length;
      if (count === 0) continue;
      if (b.kind === "rect") {
        const first = rectCursor;
        for (const cmd of b.commands) {
          if (cmd.kind !== "rect") continue;
          writeRectInstance(this.rectBuffer.data, rectCursor, cmd.rect);
          rectCursor++;
        }
        staged.push({
          pipeline: b.blend === "additive" ? this.rectPipelineAdd! : this.rectPipelineAlpha!,
          buffer: this.rectBuffer.buffer!,
          firstInstance: first,
          instanceCount: count,
        });
      } else if (b.kind === "gradient") {
        const first = gradCursor;
        for (const cmd of b.commands) {
          if (cmd.kind !== "gradient") continue;
          writeGradientInstance(this.gradientBuffer.data, gradCursor, cmd.rect, cmd.fill);
          gradCursor++;
        }
        staged.push({
          pipeline:
            b.blend === "additive" ? this.gradientPipelineAdd! : this.gradientPipelineAlpha!,
          buffer: this.gradientBuffer.buffer!,
          firstInstance: first,
          instanceCount: count,
        });
      } else if (b.kind === "glow") {
        const first = glowCursor;
        for (const cmd of b.commands) {
          if (cmd.kind !== "glow") continue;
          writeGlowInstance(this.glowBuffer.data, glowCursor, cmd.glow);
          glowCursor++;
        }
        staged.push({
          pipeline: this.glowPipeline!,
          buffer: this.glowBuffer.buffer!,
          firstInstance: first,
          instanceCount: count,
        });
      } else {
        const first = lineCursor;
        for (const cmd of b.commands) {
          if (cmd.kind !== "line") continue;
          writeLineInstance(this.lineBuffer.data, lineCursor, cmd.line);
          lineCursor++;
        }
        staged.push({
          pipeline: b.blend === "additive" ? this.linePipelineAdd! : this.linePipelineAlpha!,
          buffer: this.lineBuffer.buffer!,
          firstInstance: first,
          instanceCount: count,
        });
      }
    }

    // Upload each kind's staged data once.
    if (rectN) this.rectBuffer.upload(device, rectN);
    if (gradN) this.gradientBuffer.upload(device, gradN);
    if (glowN) this.glowBuffer.upload(device, glowN);
    if (lineN) this.lineBuffer.upload(device, lineN);

    return staged;
  }

  private require(op: string): {
    device: GpuDeviceLike;
    context: GpuCanvasContextLike;
    postPipeline: GpuRenderPipelineLike;
  } {
    const device = this.device;
    const context = this.context;
    const postPipeline = this.postPipeline;
    if (
      !device ||
      !context ||
      !postPipeline ||
      !this.rectPipelineAlpha ||
      !this.rectPipelineAdd ||
      !this.gradientPipelineAlpha ||
      !this.gradientPipelineAdd ||
      !this.glowPipeline ||
      !this.linePipelineAlpha ||
      !this.linePipelineAdd
    ) {
      throw new Error(`WebgpuRenderer: ${op}() called before init().`);
    }
    return { device, context, postPipeline };
  }

  dispose(): void {
    this.rectBuffer.destroy();
    this.gradientBuffer.destroy();
    this.glowBuffer.destroy();
    this.lineBuffer.destroy();
    this.hdrTexture?.destroy?.();
    this.hdrTexture = null;
    this.hdrView = null;
    this.releaseBloomMips();
    this.releaseHistory();
    this.postUniformBuffer?.destroy?.();
    this.postUniformBuffer = null;
    this.bloomUniformBuffer?.destroy?.();
    this.bloomUniformBuffer = null;
    this.feedbackUniformBuffer?.destroy?.();
    this.feedbackUniformBuffer = null;
    this.postBindGroup = null;
    this.postBindGroupLayout = null;
    this.bloomBindGroupLayout = null;
    this.upsampleBindGroupLayout = null;
    this.feedbackPipeline = null;
    this.feedbackBindGroupLayout = null;
    this.copyPipeline = null;
    this.copyBindGroupLayout = null;
    this.sampler = null;
    this.rectPipelineAlpha = null;
    this.rectPipelineAdd = null;
    this.gradientPipelineAlpha = null;
    this.gradientPipelineAdd = null;
    this.linePipelineAlpha = null;
    this.linePipelineAdd = null;
    this.glowPipeline = null;
    this.postPipeline = null;
    this.brightPipeline = null;
    this.blurPipeline = null;
    this.upsamplePipeline = null;
    this.context?.unconfigure?.();
    this.context = null;
    this.device = null;
    this.commands = [];
    this.blendMode = "alpha";
    this.frameOpen = false;
    this.exposure = DEFAULT_EXPOSURE;
    this.bloom = {
      enabled: DEFAULT_BLOOM_ENABLED,
      threshold: DEFAULT_BLOOM_THRESHOLD,
      intensity: DEFAULT_BLOOM_INTENSITY,
      radius: DEFAULT_BLOOM_RADIUS,
    };
    this.vignette = { enabled: DEFAULT_VIGNETTE_ENABLED, amount: DEFAULT_VIGNETTE_AMOUNT };
    this.feedback = { enabled: DEFAULT_FEEDBACK_ENABLED, decay: DEFAULT_FEEDBACK_DECAY };
    this.postParamsDirty = true;
    this.feedbackParamsDirty = true;
  }
}

/** Clamp a value to a finite, non-negative number, falling back to `fallback`. */
function clampNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** A resolved per-batch GPU draw: which pipeline + buffer + instance range. */
interface StagedDraw {
  pipeline: GpuRenderPipelineLike;
  buffer: GpuBufferLike;
  firstInstance: number;
  instanceCount: number;
}

/**
 * Coalesce an ordered command list into runs of the same `kind` + `blend`, so a
 * run of consecutive same-type primitives becomes ONE instanced draw. Order is
 * preserved exactly, so compositing is identical to issuing the commands one at
 * a time. Glow commands carry no blend (always additive); they coalesce on kind
 * alone. Exported-internal pure helper — unit tested directly.
 */
export function coalesce(commands: SceneCommand[]): DrawBatch[] {
  const batches: DrawBatch[] = [];
  for (const cmd of commands) {
    const blend: BlendMode = cmd.kind === "glow" ? "additive" : cmd.blend;
    const last = batches[batches.length - 1];
    if (last && last.kind === cmd.kind && last.blend === blend) {
      last.commands.push(cmd);
    } else {
      batches.push({ kind: cmd.kind, blend, commands: [cmd] });
    }
  }
  return batches;
}

/** Write a rect instance [x,y,w,h, r,g,b,a] at `index` into `data`. */
function writeRectInstance(data: Float32Array, index: number, rect: NormalizedRect): void {
  const base = index * FLOATS_PER_INSTANCE;
  data[base] = rect.x;
  data[base + 1] = rect.y;
  data[base + 2] = rect.w;
  data[base + 3] = rect.h;
  data[base + 4] = rect.color.r;
  data[base + 5] = rect.color.g;
  data[base + 6] = rect.color.b;
  data[base + 7] = rect.color.a;
}

/** Write a gradient instance [rect(4), from(4), to(4), params(4)] at `index`. */
function writeGradientInstance(
  data: Float32Array,
  index: number,
  rect: NormalizedRect,
  fill: GradientFill,
): void {
  const base = index * FLOATS_PER_GRADIENT;
  data[base] = rect.x;
  data[base + 1] = rect.y;
  data[base + 2] = rect.w;
  data[base + 3] = rect.h;
  data[base + 4] = fill.from.r;
  data[base + 5] = fill.from.g;
  data[base + 6] = fill.from.b;
  data[base + 7] = fill.from.a;
  data[base + 8] = fill.to.r;
  data[base + 9] = fill.to.g;
  data[base + 10] = fill.to.b;
  data[base + 11] = fill.to.a;
  data[base + 12] = Number.isFinite(fill.angle) ? (fill.angle as number) : 0;
  data[base + 13] = fill.radial ? 1 : 0;
  data[base + 14] = 0;
  data[base + 15] = 0;
}

/** Write a glow instance [cx,cy,radius,_, color(4), intensity,_,_,_] at `index`. */
function writeGlowInstance(data: Float32Array, index: number, glow: GlowSpec): void {
  const base = index * FLOATS_PER_GLOW;
  const intensity =
    glow.intensity == null || !Number.isFinite(glow.intensity) ? 1 : Math.max(glow.intensity, 0);
  data[base] = glow.x;
  data[base + 1] = glow.y;
  data[base + 2] = glow.radius;
  data[base + 3] = 0;
  data[base + 4] = glow.color.r;
  data[base + 5] = glow.color.g;
  data[base + 6] = glow.color.b;
  data[base + 7] = glow.color.a;
  data[base + 8] = intensity;
  data[base + 9] = 0;
  data[base + 10] = 0;
  data[base + 11] = 0;
}

/** Write a line instance [c0.xy, c1.xy, c2.xy, c3.xy, color(4)] at `index`. */
function writeLineInstance(data: Float32Array, index: number, line: LineSpec): void {
  const [c0, c1, c2, c3] = expandLineToQuad(line);
  const base = index * FLOATS_PER_LINE;
  data[base] = c0.x;
  data[base + 1] = c0.y;
  data[base + 2] = c1.x;
  data[base + 3] = c1.y;
  data[base + 4] = c2.x;
  data[base + 5] = c2.y;
  data[base + 6] = c3.x;
  data[base + 7] = c3.y;
  data[base + 8] = line.color.r;
  data[base + 9] = line.color.g;
  data[base + 10] = line.color.b;
  data[base + 11] = line.color.a;
}
