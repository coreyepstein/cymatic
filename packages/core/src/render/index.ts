/**
 * Public renderer surface for @cymatic/core.
 *
 * The engine and presets target a single backend-agnostic {@link Renderer}.
 * {@link createRenderer} picks WebGPU (preferred) or WebGL (fallback) once via
 * capability detection; downstream code — presets especially — never branches
 * on the backend. See `renderer.ts` for the documented interface.
 */

export type {
  RendererBackend,
  BackendSelection,
  RendererEnvironment,
  GpuLike,
  WebglProbe,
} from "./capabilities.js";
export { selectBackend, detectEnvironment, defaultHasWebgl } from "./capabilities.js";

export type {
  Renderer,
  Scene,
  RenderFeatures,
  RgbaColor,
  BlendMode,
  NormalizedRect,
  GradientFill,
  GlowSpec,
  LineSpec,
  Vec2,
  DrawingBufferSize,
  RenderCanvasLike,
  CreateRendererOptions,
  PostEffectsConfig,
  BloomConfig,
  VignetteConfig,
  FeedbackConfig,
} from "./renderer.js";
export {
  createRenderer,
  computeDrawingBufferSize,
  toRgba,
  expandLineToQuad,
  normalizedToClip,
  lineBoundsRect,
  feedbackCombine,
  feedbackSequence,
} from "./renderer.js";

export type { WebglCanvasLike, WebglRendererOptions } from "./webgl/webgl-renderer.js";
export { WebglRenderer } from "./webgl/webgl-renderer.js";

export type {
  WebgpuCanvasLike,
  WebgpuRendererOptions,
  GpuNavigatorLike,
} from "./webgpu/webgpu-renderer.js";
export { WebgpuRenderer } from "./webgpu/webgpu-renderer.js";
