/**
 * WebGL implementation of the backend-agnostic {@link Renderer}.
 *
 * Browser-only: it obtains a `webgl2`/`webgl` context from a canvas. The frame
 * is cleared to the scene background, then each primitive is drawn as a tasteful
 * SOLID-color approximation: rects (and the bounding rect of a line, and a glow's
 * disc) are filled via a small shader that draws screen-space quads, so we can
 * honour alpha AND additive blending through GL blend funcs. Gradients become a
 * few banded solid rects (a stepped ramp); glows become a solid-ish disc; lines
 * become a thin rect. WebGL keeps a "basic look" — no HDR, no bloom — but never
 * throws and never requires presets to branch on the backend.
 *
 * It holds no knowledge of presets — presets target {@link Renderer} and never
 * see this class.
 */

import type { RendererBackend } from "../capabilities.js";
import {
  computeDrawingBufferSize,
  lineBoundsRect,
  type BlendMode,
  type DrawingBufferSize,
  type GlowSpec,
  type GradientFill,
  type LineSpec,
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

/**
 * Structural subset of `WebGLRenderingContext` this renderer uses. We model the
 * scissor-clear path (cheap solid fills) AND a tiny shader-quad path (so we can
 * apply additive blending, which `clear` cannot). All members are optional-free
 * here, but the shader path degrades gracefully if program creation fails.
 */
interface GlLike {
  readonly COLOR_BUFFER_BIT: number;
  readonly SCISSOR_TEST: number;
  readonly BLEND: number;
  readonly SRC_ALPHA: number;
  readonly ONE: number;
  readonly ONE_MINUS_SRC_ALPHA: number;
  readonly TRIANGLES: number;
  readonly TRIANGLE_STRIP: number;
  readonly ARRAY_BUFFER: number;
  readonly STATIC_DRAW: number;
  readonly DYNAMIC_DRAW: number;
  readonly FLOAT: number;
  readonly VERTEX_SHADER: number;
  readonly FRAGMENT_SHADER: number;
  readonly COMPILE_STATUS: number;
  readonly LINK_STATUS: number;
  viewport(x: number, y: number, width: number, height: number): void;
  clearColor(r: number, g: number, b: number, a: number): void;
  clear(mask: number): void;
  enable(cap: number): void;
  disable(cap: number): void;
  scissor(x: number, y: number, width: number, height: number): void;
  blendFunc(sfactor: number, dfactor: number): void;
  createShader(type: number): unknown;
  shaderSource(shader: unknown, source: string): void;
  compileShader(shader: unknown): void;
  getShaderParameter(shader: unknown, pname: number): unknown;
  createProgram(): unknown;
  attachShader(program: unknown, shader: unknown): void;
  linkProgram(program: unknown): void;
  getProgramParameter(program: unknown, pname: number): unknown;
  useProgram(program: unknown): void;
  createBuffer(): unknown;
  bindBuffer(target: number, buffer: unknown): void;
  bufferData(target: number, data: ArrayBufferView, usage: number): void;
  getAttribLocation(program: unknown, name: string): number;
  enableVertexAttribArray(index: number): void;
  vertexAttribPointer(
    index: number,
    size: number,
    type: number,
    normalized: boolean,
    stride: number,
    offset: number,
  ): void;
  getUniformLocation(program: unknown, name: string): unknown;
  uniform4f(location: unknown, x: number, y: number, z: number, w: number): void;
  drawArrays(mode: number, first: number, count: number): void;
}

/** A solid quad to draw this frame, in normalized coords, with its color/blend. */
interface QuadDraw {
  x: number;
  y: number;
  w: number;
  h: number;
  color: RgbaColor;
  additive: boolean;
}

/** Vertex shader: a per-draw rect in normalized coords → clip space. */
const VS = `
attribute vec2 a_corner;          // unit quad corner in [0,1]
uniform vec4 u_rect;              // x, y, w, h (normalized, y-down)
void main() {
  float nx = u_rect.x + a_corner.x * u_rect.z;
  float ny = u_rect.y + a_corner.y * u_rect.w;
  gl_Position = vec4(nx * 2.0 - 1.0, 1.0 - ny * 2.0, 0.0, 1.0);
}
`;

/** Fragment shader: a flat color (HDR clamped to [0,1] by the float framebuffer). */
const FS = `
precision mediump float;
uniform vec4 u_color;
void main() {
  gl_FragColor = u_color;
}
`;

/** Number of solid bands a gradient is approximated with. */
const GRADIENT_BANDS = 5;

export class WebglRenderer implements Renderer {
  readonly backend: RendererBackend = "webgl";

  private readonly canvas: WebglCanvasLike;
  private gl: GlLike | null = null;
  private size: DrawingBufferSize = { width: 0, height: 0 };

  /** Per-frame state. */
  private frameOpen = false;
  private blendMode: BlendMode = "alpha";
  /** Accumulated solid quads for this frame, drawn in order at endFrame. */
  private quads: QuadDraw[] = [];

  /** Shader-quad resources (lazily built; null if creation failed). */
  private program: unknown = null;
  private quadBuffer: unknown = null;
  private cornerLoc = -1;
  private rectLoc: unknown = null;
  private colorLoc: unknown = null;
  private programReady = false;

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
    this.buildProgram(ctx);
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
    this.frameOpen = true;
    this.blendMode = "alpha";
    this.quads = [];
  }

  setBlendMode(mode: BlendMode): void {
    this.blendMode = mode;
  }

  drawRect(rect: NormalizedRect): void {
    this.requireGl("drawRect");
    if (rect.w <= 0 || rect.h <= 0) return;
    this.pushQuad(rect.x, rect.y, rect.w, rect.h, rect.color, this.blendMode === "additive");
  }

  drawGradientRect(rect: NormalizedRect, fill: GradientFill): void {
    this.requireGl("drawGradientRect");
    if (rect.w <= 0 || rect.h <= 0) return;
    const additive = this.blendMode === "additive";
    // Tasteful solid approximation: a few banded solid rects stepping the ramp.
    // Radial bands shrink toward the center; linear bands slice along the axis.
    if (fill.radial) {
      // Concentric rects from the full rect (outer = `to`) inward (center = `from`).
      for (let i = GRADIENT_BANDS - 1; i >= 0; i--) {
        const t = i / (GRADIENT_BANDS - 1); // 1 at outer, 0 at center
        const scale = (i + 1) / GRADIENT_BANDS;
        const w = rect.w * scale;
        const h = rect.h * scale;
        const x = rect.x + (rect.w - w) / 2;
        const y = rect.y + (rect.h - h) / 2;
        this.pushQuad(x, y, w, h, lerpColor(fill.from, fill.to, t), additive);
      }
      return;
    }
    // Linear: choose the dominant axis from the angle (horizontal vs vertical
    // bands) — a banded approximation, not a true ramp.
    const angle = fill.angle ?? 0;
    const vertical = Math.abs(Math.sin(angle)) > Math.abs(Math.cos(angle));
    for (let i = 0; i < GRADIENT_BANDS; i++) {
      const t = i / (GRADIENT_BANDS - 1);
      const color = lerpColor(fill.from, fill.to, t);
      if (vertical) {
        const h = rect.h / GRADIENT_BANDS;
        this.pushQuad(rect.x, rect.y + i * h, rect.w, h, color, additive);
      } else {
        const w = rect.w / GRADIENT_BANDS;
        this.pushQuad(rect.x + i * w, rect.y, w, rect.h, color, additive);
      }
    }
  }

  drawGlow(glow: GlowSpec): void {
    this.requireGl("drawGlow");
    if (glow.radius <= 0) return;
    // Solid disc/rect approximation, ALWAYS additive (a glow is light). We
    // approximate the gaussian core with two stacked rects: a wider, dimmer
    // halo and a brighter inner core — enough to read as a soft blob.
    const intensity =
      glow.intensity == null || !Number.isFinite(glow.intensity) ? 1 : Math.max(glow.intensity, 0);
    const core = scaleColor(glow.color, intensity);
    const halo = scaleColor(glow.color, intensity * 0.4);
    const r = glow.radius;
    // Outer halo (2r square) then inner core (1r square), both additive.
    this.pushQuad(glow.x - r, glow.y - r, 2 * r, 2 * r, halo, true);
    this.pushQuad(glow.x - r / 2, glow.y - r / 2, r, r, core, true);
  }

  drawLine(line: LineSpec): void {
    this.requireGl("drawLine");
    if (line.width <= 0) return;
    // Thin-rect approximation: the axis-aligned bounds of the expanded quad.
    const bounds = lineBoundsRect(line);
    if (bounds.w <= 0 || bounds.h <= 0) return;
    this.pushQuad(
      bounds.x,
      bounds.y,
      bounds.w,
      bounds.h,
      line.color,
      this.blendMode === "additive",
    );
  }

  endFrame(): void {
    const gl = this.gl;
    if (!gl) return;
    this.frameOpen = false;

    // Draw the accumulated quads with the shader path when available (so we can
    // honour additive blending); otherwise fall back to scissored clears (alpha
    // only — additive degrades to a plain fill, never throws).
    if (this.programReady && this.quads.length > 0) {
      this.flushQuads(gl);
    } else {
      this.flushQuadsScissor(gl);
    }
    this.quads = [];
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
  }

  setPostEffects(_config: PostEffectsConfig): void {
    // No-op for the WebGL backend: cinematic post-processing (HDR offscreen
    // target, tonemap/exposure, bloom, vignette, feedback/trails, …) is
    // WebGPU-only. WebGL keeps its basic direct-render look. Accepting and
    // ignoring the config keeps the preset/React call site backend-agnostic —
    // callers never branch.
  }

  private pushQuad(
    x: number,
    y: number,
    w: number,
    h: number,
    color: RgbaColor,
    additive: boolean,
  ): void {
    if (w <= 0 || h <= 0) return;
    this.quads.push({ x, y, w, h, color, additive });
  }

  /** Shader-quad flush: draws every accumulated quad with per-quad blend. */
  private flushQuads(gl: GlLike): void {
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.cornerLoc);
    gl.vertexAttribPointer(this.cornerLoc, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    for (const q of this.quads) {
      gl.blendFunc(gl.SRC_ALPHA, q.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform4f(this.rectLoc, q.x, q.y, q.w, q.h);
      gl.uniform4f(this.colorLoc, q.color.r, q.color.g, q.color.b, q.color.a);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  /** Fallback flush via scissored clears (alpha approximation, no blend). */
  private flushQuadsScissor(gl: GlLike): void {
    const { width, height } = this.size;
    gl.enable(gl.SCISSOR_TEST);
    for (const q of this.quads) {
      const px = Math.round(q.x * width);
      const pw = Math.round(q.w * width);
      const ph = Math.round(q.h * height);
      const py = Math.round((1 - q.y - q.h) * height);
      if (pw <= 0 || ph <= 0) continue;
      gl.scissor(px, py, pw, ph);
      gl.clearColor(q.color.r, q.color.g, q.color.b, q.color.a);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  /**
   * Build the solid-quad shader program. Best-effort: if any step fails we leave
   * `programReady = false` and the renderer falls back to the scissor path. A
   * unit quad (two triangles as a strip) lives in a static buffer.
   */
  private buildProgram(gl: GlLike): void {
    try {
      const vs = gl.createShader(gl.VERTEX_SHADER);
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      if (!vs || !fs) return;
      gl.shaderSource(vs, VS);
      gl.compileShader(vs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) return;
      gl.shaderSource(fs, FS);
      gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) return;
      const program = gl.createProgram();
      if (!program) return;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;

      const buffer = gl.createBuffer();
      if (!buffer) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      // Unit-quad corners as a triangle strip: (0,0)(1,0)(0,1)(1,1).
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

      this.program = program;
      this.quadBuffer = buffer;
      this.cornerLoc = gl.getAttribLocation(program, "a_corner");
      this.rectLoc = gl.getUniformLocation(program, "u_rect");
      this.colorLoc = gl.getUniformLocation(program, "u_color");
      this.programReady = this.cornerLoc >= 0;
    } catch {
      // Any failure (e.g. a partial mock context) leaves us on the scissor path.
      this.programReady = false;
    }
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
    this.program = null;
    this.quadBuffer = null;
    this.programReady = false;
    this.quads = [];
    this.frameOpen = false;
  }
}

/** Linearly interpolate two RGBA colors at `t ∈ [0,1]` (HDR-safe). */
function lerpColor(a: RgbaColor, b: RgbaColor, t: number): RgbaColor {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: a.a + (b.a - a.a) * t,
  };
}

/** Scale a color's RGB by `s` (keeping alpha) — used for glow intensity/halo. */
function scaleColor(c: RgbaColor, s: number): RgbaColor {
  return { r: c.r * s, g: c.g * s, b: c.b * s, a: c.a };
}
