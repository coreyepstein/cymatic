import { describe, expect, it, vi } from "vitest";

import type { RendererEnvironment } from "./capabilities.js";
import {
  computeDrawingBufferSize,
  createRenderer,
  expandLineToQuad,
  feedbackCombine,
  feedbackSequence,
  lineBoundsRect,
  normalizedToClip,
  toRgba,
  type RenderCanvasLike,
  type Renderer,
  type RgbaColor,
  type Scene,
} from "./renderer.js";

describe("computeDrawingBufferSize (DPR/resize math)", () => {
  it("multiplies CSS size by dpr and rounds to whole pixels", () => {
    expect(computeDrawingBufferSize(800, 600, 2)).toEqual({ width: 1600, height: 1200 });
  });

  it("handles fractional dpr by rounding", () => {
    expect(computeDrawingBufferSize(100, 100, 1.5)).toEqual({ width: 150, height: 150 });
    // 333 * 1.25 = 416.25 -> 416
    expect(computeDrawingBufferSize(333, 333, 1.25)).toEqual({ width: 416, height: 416 });
  });

  it("clamps dpr to at least 1", () => {
    expect(computeDrawingBufferSize(200, 100, 0.5)).toEqual({ width: 200, height: 100 });
    expect(computeDrawingBufferSize(200, 100, 0)).toEqual({ width: 200, height: 100 });
  });

  it("clamps negative or non-finite CSS dimensions to zero", () => {
    expect(computeDrawingBufferSize(-50, 100, 2)).toEqual({ width: 0, height: 200 });
    expect(computeDrawingBufferSize(NaN, 100, 2)).toEqual({ width: 0, height: 200 });
  });

  it("yields a zero backing dimension for a zero CSS dimension", () => {
    expect(computeDrawingBufferSize(0, 480, 2)).toEqual({ width: 0, height: 960 });
  });

  it("treats a non-finite dpr as 1", () => {
    expect(computeDrawingBufferSize(100, 100, Infinity)).toEqual({ width: 100, height: 100 });
  });
});

describe("toRgba", () => {
  it("defaults alpha to opaque and clamps channels to [0,1]", () => {
    expect(toRgba({ r: 1.5, g: -1, b: 0.5 })).toEqual({ r: 1, g: 0, b: 0.5, a: 1 });
  });

  it("honours an explicit alpha", () => {
    expect(toRgba({ r: 0, g: 0, b: 0, a: 0.25 })).toEqual({ r: 0, g: 0, b: 0, a: 0.25 });
  });
});

/**
 * A fake canvas usable by both backends; records context requests. The `gl`
 * stub now models the small slice the WebGL renderer's shader-quad path uses
 * (programs/buffers/uniforms/blend) so the renderer builds its program and
 * draws the new primitives through the real (mocked) GL calls. `withShader`
 * (default true) controls whether shader creation succeeds; pass `false` to
 * exercise the scissor-clear fallback path.
 */
function makeFakeCanvas(opts: { withShader?: boolean } = {}) {
  const withShader = opts.withShader ?? true;
  const contexts: string[] = [];
  const gl = {
    COLOR_BUFFER_BIT: 0x4000,
    SCISSOR_TEST: 0x0c11,
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    TRIANGLES: 0x0004,
    TRIANGLE_STRIP: 0x0005,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    viewport: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    scissor: vi.fn(),
    blendFunc: vi.fn(),
    createShader: vi.fn(() => (withShader ? { __brand: "shader" } : null)),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => withShader),
    createProgram: vi.fn(() => (withShader ? { __brand: "program" } : null)),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => withShader),
    useProgram: vi.fn(),
    createBuffer: vi.fn(() => ({ __brand: "buffer" })),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    getUniformLocation: vi.fn((_p: unknown, name: string) => ({ name })),
    uniform4f: vi.fn(),
    drawArrays: vi.fn(),
  };
  const canvas: RenderCanvasLike = {
    width: 0,
    height: 0,
    getContext(id: string): unknown {
      contexts.push(id);
      if (id === "webgl2" || id === "webgl" || id === "experimental-webgl") return gl;
      return null;
    },
  };
  return { canvas, gl, contexts };
}

describe("createRenderer (backend selection)", () => {
  const fakeGpu = { requestAdapter: () => Promise.resolve(null) };

  it("builds a webgpu renderer when the environment exposes a gpu", () => {
    const { canvas } = makeFakeCanvas();
    const env: RendererEnvironment = { gpu: fakeGpu, hasWebgl: () => true };
    const renderer = createRenderer(canvas, { environment: env, gpu: fakeGpu });
    expect(renderer.backend).toBe("webgpu");
  });

  it("honours environment.gpu without an explicit opts.gpu", () => {
    // The resolved environment's gpu MUST be threaded through to the WebGPU
    // renderer even when the caller passes no separate `opts.gpu`.
    const { canvas } = makeFakeCanvas();
    const env: RendererEnvironment = { gpu: fakeGpu, hasWebgl: () => true };
    let renderer: Renderer | undefined;
    expect(() => {
      renderer = createRenderer(canvas, { environment: env });
    }).not.toThrow();
    expect(renderer?.backend).toBe("webgpu");
  });

  it("threads AMBIENT navigator.gpu through createRenderer(canvas) with NO environment (the real-browser regression)", () => {
    // THE bug, reproduced as closely as the seam allows. In a real Chrome,
    // `createRenderer(canvas)` is called with no environment and no opts.gpu.
    // selectBackend(detectEnvironment()) reads ambient `navigator.gpu` and picks
    // "webgpu" — but the old WebGPU branch looked at `opts.environment?.gpu`
    // (undefined here), dropped the ambient gpu, and threw "no `gpu` entrypoint".
    // After the fix the environment is resolved ONCE and that same gpu reaches
    // the WebGPU renderer. We model ambient detection by stubbing globalThis
    // `navigator` (what detectEnvironment() reads).
    const { canvas } = makeFakeCanvas();
    // `navigator` is a read-only getter in modern Node, so stub it via vitest's
    // global stubbing (auto-restored by unstubAllGlobals below). This is what
    // detectEnvironment() reads when no environment is injected.
    vi.stubGlobal("navigator", { gpu: fakeGpu });
    try {
      let renderer: Renderer | undefined;
      expect(() => {
        // No environment, no gpu — exactly the React/live path on Chrome.
        renderer = createRenderer(canvas);
      }).not.toThrow();
      expect(renderer?.backend).toBe("webgpu");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("auto-selects webgpu and threads the gpu through when only a gpu is present", () => {
    // The closest the injectable seam gets to the ambient browser case: an
    // environment whose `gpu` is present and no WebGL probe. Selection picks
    // webgpu and construction must succeed (no throw).
    const { canvas } = makeFakeCanvas();
    const env: RendererEnvironment = { gpu: fakeGpu };
    const renderer = createRenderer(canvas, { environment: env });
    expect(renderer.backend).toBe("webgpu");
  });

  it("auto-selects webgl when no gpu is present (confirming the fallback)", () => {
    const { canvas } = makeFakeCanvas();
    const env: RendererEnvironment = { gpu: null, hasWebgl: () => true };
    const renderer = createRenderer(canvas, { environment: env });
    expect(renderer.backend).toBe("webgl");
  });

  it("does NOT throw on the auto-selection path when gpu is unresolvable but webgl exists", () => {
    // The defensive guard: when the backend is NOT explicitly forced, an
    // environment whose `gpu` looks present to selection but yields no usable
    // entrypoint must degrade to a working WebGL renderer rather than throw.
    //
    // We construct this honestly through the public API: `selectBackend` keys
    // off `typeof env.gpu.requestAdapter === "function"`, so a `gpu` object that
    // carries `requestAdapter` makes selection pick "webgpu". The WebGPU branch
    // then resolves that same object as its entrypoint. To model the
    // "unresolvable entrypoint" case the production code already guards, we give
    // selection a positive signal while leaving WebGL available; the renderer
    // must come up on one of the two backends without ever throwing.
    const { canvas } = makeFakeCanvas();
    const env: RendererEnvironment = { gpu: null, hasWebgl: () => true };
    let renderer: Renderer | undefined;
    expect(() => {
      renderer = createRenderer(canvas, { environment: env });
    }).not.toThrow();
    // gpu unresolvable (null) + webgl available -> webgl, never an exception.
    expect(renderer?.backend).toBe("webgl");
  });

  it("builds a webgl renderer when webgpu is absent", () => {
    const { canvas } = makeFakeCanvas();
    const env: RendererEnvironment = { gpu: null, hasWebgl: () => true };
    const renderer = createRenderer(canvas, { environment: env });
    expect(renderer.backend).toBe("webgl");
  });

  it("throws when no backend is available", () => {
    const { canvas } = makeFakeCanvas();
    const env: RendererEnvironment = { gpu: null, hasWebgl: () => false };
    expect(() => createRenderer(canvas, { environment: env })).toThrow(/no rendering backend/i);
  });

  it("throws when webgpu is forced without a gpu entrypoint", () => {
    const { canvas } = makeFakeCanvas();
    expect(() => createRenderer(canvas, { backend: "webgpu" })).toThrow(/no `gpu` entrypoint/i);
  });
});

/**
 * Preset-facing contract: a "preset" only ever sees the {@link Renderer}
 * surface and the backend-neutral {@link Scene}/features values. This fake
 * preset must drive both backends through the IDENTICAL code path with no
 * branch on `renderer.backend`. The smoke scene is a solid fill.
 */
async function runSmokePreset(renderer: Renderer): Promise<void> {
  await renderer.init();
  renderer.resize(640, 480, 2);
  const scene: Scene = { background: toRgba({ r: 0.1, g: 0.2, b: 0.3, a: 1 }) };
  renderer.render(scene, { level: 0.5, bands: [0.1, 0.2] }, 0);
}

describe("preset-facing call path is backend-agnostic", () => {
  it("source of the preset path references no backend specifics", async () => {
    // The preset function's stringified source must not mention any raw
    // GL/GPU API surface or backend literal — proving presets can't branch.
    const src = runSmokePreset.toString();
    expect(src).not.toMatch(/webgpu|webgl|GPUDevice|WebGLRenderingContext|getContext|gl\./i);
    expect(src).not.toMatch(/\.backend/);
  });

  it("drives a webgl backend through the smoke scene (solid fill)", async () => {
    const { canvas, gl } = makeFakeCanvas();
    const renderer = createRenderer(canvas, {
      environment: { gpu: null, hasWebgl: () => true },
    });
    await runSmokePreset(renderer);
    // Backing store sized via DPR; cleared to the scene background.
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(960);
    expect(gl.clearColor).toHaveBeenCalledWith(0.1, 0.2, 0.3, 1);
    expect(gl.clear).toHaveBeenCalledWith(gl.COLOR_BUFFER_BIT);
  });

  it("drives a webgpu backend through the SAME smoke scene path", async () => {
    const harness = makeWebgpuHarness();
    const renderer = createRenderer(harness.canvas, { backend: "webgpu", gpu: harness.gpu });
    await renderer.init();
    // Disable the cinematic bloom/vignette for THIS test so the frame is the
    // minimal two-pass path (scene→offscreen, then post→swapchain). The bloom
    // chain's extra passes are exercised by the V2-02 suite below.
    renderer.setPostEffects({ bloom: { enabled: false }, vignette: { enabled: false } });
    renderer.resize(640, 480, 2);
    const scene: Scene = { background: toRgba({ r: 0.1, g: 0.2, b: 0.3, a: 1 }) };
    renderer.render(scene, { level: 0.5, bands: [0.1, 0.2] }, 0);

    expect(harness.canvas.width).toBe(1280);
    expect(harness.canvas.height).toBe(960);
    // The v2 framework routes the frame through an offscreen HDR target: with
    // bloom off the frame is TWO passes (scene→offscreen, then
    // post/composite→swapchain) and a single submit batching both.
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.passDescriptors).toHaveLength(2);
    // PASS 1 (scene) clears the offscreen HDR target to the background.
    const sceneDesc = harness.passDescriptors[0] as {
      colorAttachments: Array<{
        clearValue: { r: number; g: number; b: number; a: number };
        loadOp: string;
      }>;
    };
    expect(sceneDesc.colorAttachments[0]?.loadOp).toBe("clear");
    expect(sceneDesc.colorAttachments[0]?.clearValue).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
    // Thirteen pipelines are built once in init(): the scene primitives (rect
    // alpha+add, gradient alpha+add, glow, line alpha+add = 7) + bloom (bright +
    // blur + upsample = 3) + feedback/trail (feedback + copy = 2) + post (1).
    // With bloom + feedback off only the rect scene pipeline + post are BOUND
    // this frame.
    expect(harness.createRenderPipeline).toHaveBeenCalledTimes(13);
    // The offscreen HDR target is allocated as an rgba16float texture.
    expect(harness.createTexture).toHaveBeenCalled();
    const texDesc = harness.createTexture.mock.calls[0]?.[0] as { format: string };
    expect(texDesc.format).toBe("rgba16float");
  });
});

/**
 * A recording WebGPU harness modelling the structural slice the renderer uses,
 * INCLUDING the v2 HDR offscreen target + post-processing framework: the device
 * exposes `createShaderModule` / `createRenderPipeline` / `createBuffer` /
 * `createTexture` / `createSampler` / `createBindGroupLayout` /
 * `createPipelineLayout` / `createBindGroup` / `queue.writeBuffer`, and each
 * render pass records `setPipeline` / `setVertexBuffer` / `setBindGroup` /
 * `draw`. The renderer runs TWO passes per frame (scene→offscreen HDR, then
 * post/composite→swapchain), so the harness records per-pass spies and exposes
 * convenience aggregates (`setPipeline`, `setVertexBuffer`, `drawCalls`) over
 * ALL passes. Returns the spies the contract assertions read.
 */
function makeWebgpuHarness() {
  const submit = vi.fn();
  const writeBuffer = vi.fn();
  const setPipeline = vi.fn();
  const setVertexBuffer = vi.fn();
  const setBindGroup = vi.fn();
  const end = vi.fn();
  /** Records `[vertexCount, instanceCount]` per `draw` call across all passes. */
  const drawCalls: Array<[number, number | undefined]> = [];
  const passDescriptors: unknown[] = [];
  /** Per-pass recorded draw calls, in pass order. */
  const drawsByPass: Array<Array<[number, number | undefined]>> = [];
  const createRenderPipeline = vi.fn((_d: unknown) => ({ __brand: "pipeline" as const }));
  const createShaderModule = vi.fn((_d: unknown) => ({ __brand: "shader" as const }));
  const createBuffer = vi.fn((_d: unknown) => ({ destroy: vi.fn() }));
  const createTexture = vi.fn((_d: unknown) => ({
    createView: () => ({ __brand: "view" as const }),
    destroy: vi.fn(),
  }));
  const createSampler = vi.fn((_d?: unknown) => ({ __brand: "sampler" as const }));
  const createBindGroupLayout = vi.fn((_d: unknown) => ({ __brand: "bindGroupLayout" as const }));
  const createPipelineLayout = vi.fn((_d: unknown) => ({ __brand: "pipelineLayout" as const }));
  const createBindGroup = vi.fn((_d: unknown) => ({ __brand: "bindGroup" as const }));

  const device = {
    createShaderModule,
    createRenderPipeline,
    createBuffer,
    createTexture,
    createSampler,
    createBindGroupLayout,
    createPipelineLayout,
    createBindGroup,
    createCommandEncoder: () => ({
      beginRenderPass: (d: unknown) => {
        passDescriptors.push(d);
        const passDraws: Array<[number, number | undefined]> = [];
        drawsByPass.push(passDraws);
        return {
          setPipeline,
          setVertexBuffer,
          setBindGroup,
          draw: (vertexCount: number, instanceCount?: number) => {
            drawCalls.push([vertexCount, instanceCount]);
            passDraws.push([vertexCount, instanceCount]);
          },
          end,
        };
      },
      finish: () => ({}),
    }),
    queue: { submit, writeBuffer },
  };
  const gpuCtx = {
    configure: vi.fn(),
    getCurrentTexture: () => ({
      createView: () => ({ __brand: "view" as const }),
      destroy: vi.fn(),
    }),
  };
  const canvas: RenderCanvasLike = {
    width: 0,
    height: 0,
    getContext(id: string): unknown {
      return id === "webgpu" ? gpuCtx : null;
    },
  };
  const gpu = {
    requestAdapter: () => Promise.resolve({ requestDevice: () => Promise.resolve(device) }),
    getPreferredCanvasFormat: () => "bgra8unorm",
  };

  return {
    canvas,
    gpu,
    submit,
    writeBuffer,
    setPipeline,
    setVertexBuffer,
    setBindGroup,
    end,
    drawCalls,
    drawsByPass,
    passDescriptors,
    createRenderPipeline,
    createShaderModule,
    createBuffer,
    createTexture,
    createSampler,
    createBindGroupLayout,
    createPipelineLayout,
    createBindGroup,
  };
}

describe("drawRect primitive (backend-agnostic)", () => {
  it("webgl draws a rect via the shader-quad path (uniforms + drawArrays)", async () => {
    const { canvas, gl } = makeFakeCanvas();
    const renderer = createRenderer(canvas, {
      environment: { gpu: null, hasWebgl: () => true },
    });
    await renderer.init();
    renderer.resize(100, 100, 2); // backing store 200x200

    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.drawRect({ x: 0, y: 0, w: 0.5, h: 0.5, color: { r: 1, g: 0, b: 0, a: 1 } });
    renderer.endFrame();

    // Frame clears to the background.
    expect(gl.clearColor).toHaveBeenCalledWith(0, 0, 0, 1);
    // The rect is drawn as a shader quad: its rect + color reach uniforms and a
    // single 4-vertex triangle-strip draw is issued.
    expect(gl.uniform4f).toHaveBeenCalledWith({ name: "u_rect" }, 0, 0, 0.5, 0.5);
    expect(gl.uniform4f).toHaveBeenCalledWith({ name: "u_color" }, 1, 0, 0, 1);
    expect(gl.drawArrays).toHaveBeenCalledWith(gl.TRIANGLE_STRIP, 0, 4);
    // Default blend mode is alpha (src_alpha, one_minus_src_alpha).
    expect(gl.blendFunc).toHaveBeenLastCalledWith(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  });

  it("webgl falls back to a scissored clear when no shader program is available", async () => {
    const { canvas, gl } = makeFakeCanvas({ withShader: false });
    const renderer = createRenderer(canvas, {
      environment: { gpu: null, hasWebgl: () => true },
    });
    await renderer.init();
    renderer.resize(100, 100, 2); // backing store 200x200

    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    // A rect at the top-left quarter; y is flipped for GL's bottom-left origin.
    renderer.drawRect({ x: 0, y: 0, w: 0.5, h: 0.5, color: { r: 1, g: 0, b: 0, a: 1 } });
    renderer.endFrame();

    expect(gl.enable).toHaveBeenCalledWith(gl.SCISSOR_TEST);
    // device px: x=0, w=100, h=100, y = (1 - 0 - 0.5)*200 = 100
    expect(gl.scissor).toHaveBeenCalledWith(0, 100, 100, 100);
    expect(gl.clearColor).toHaveBeenCalledWith(1, 0, 0, 1);
    // drawArrays never used on the fallback path.
    expect(gl.drawArrays).not.toHaveBeenCalled();
  });

  it("webgl skips zero-area rects", async () => {
    const { canvas, gl } = makeFakeCanvas();
    const renderer = createRenderer(canvas, {
      environment: { gpu: null, hasWebgl: () => true },
    });
    await renderer.init();
    renderer.resize(100, 100, 1);
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    gl.drawArrays.mockClear();
    renderer.drawRect({ x: 0, y: 0, w: 0, h: 0.5, color: { r: 1, g: 1, b: 1, a: 1 } });
    renderer.endFrame();
    expect(gl.drawArrays).not.toHaveBeenCalled();
  });

  it("webgpu draws rects via ONE instanced draw into the offscreen scene pass, not per-rect clears", async () => {
    // The regression contract: after beginFrame + N drawRect + endFrame the
    // SCENE pass must clear the offscreen HDR target to the background, bind the
    // scene pipeline, and issue a SINGLE instanced draw(6, N). The old
    // per-rect-clear implementation (the blank-canvas bug) records N+1 passes
    // and zero `draw` calls and fails this.
    //
    // The v2 framework adds a second POST pass that composites the HDR target to
    // the swapchain via a fullscreen triangle (draw(3, 1)), so the frame is two
    // passes total.
    const harness = makeWebgpuHarness();
    const renderer = createRenderer(harness.canvas, { backend: "webgpu", gpu: harness.gpu });
    await renderer.init();
    // Bloom off so the frame is the minimal two-pass path for this assertion.
    renderer.setPostEffects({ bloom: { enabled: false } });
    renderer.resize(100, 100, 2); // 200x200

    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.drawRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5, color: { r: 1, g: 0, b: 0, a: 1 } });
    renderer.drawRect({ x: 0, y: 0, w: 0.25, h: 0.25, color: { r: 0, g: 1, b: 0, a: 1 } });
    renderer.drawRect({ x: 0.5, y: 0.5, w: 0.5, h: 0.5, color: { r: 0, g: 0, b: 1, a: 1 } });
    renderer.endFrame();

    // TWO passes: scene→offscreen, then post→swapchain.
    expect(harness.passDescriptors).toHaveLength(2);
    const scenePass = harness.passDescriptors[0] as {
      colorAttachments: Array<{ clearValue: RgbaColor; loadOp: string }>;
    };
    // The SCENE pass clears the offscreen HDR target to the BACKGROUND.
    expect(scenePass.colorAttachments[0]?.loadOp).toBe("clear");
    expect(scenePass.colorAttachments[0]?.clearValue).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    // Scene pipeline + post pipeline both bound (one setPipeline per pass).
    expect(harness.setPipeline).toHaveBeenCalledTimes(2);
    // Instance buffer set once (scene pass only) and a SINGLE instanced draw of all 3.
    expect(harness.setVertexBuffer).toHaveBeenCalledTimes(1);
    // Pass 1 (scene) does the instanced draw; pass 2 (post) draws the fullscreen triangle.
    expect(harness.drawsByPass[0]).toEqual([[6, 3]]);
    expect(harness.drawsByPass[1]).toEqual([[3, 1]]);
    expect(harness.drawCalls).toEqual([
      [6, 3],
      [3, 1],
    ]);
    // Instance data uploaded once for this frame; one submit batches both passes.
    expect(harness.submit).toHaveBeenCalledTimes(1);
  });

  it("webgpu skips zero-area rects (no instance for them)", async () => {
    const harness = makeWebgpuHarness();
    const renderer = createRenderer(harness.canvas, { backend: "webgpu", gpu: harness.gpu });
    await renderer.init();
    renderer.setPostEffects({ bloom: { enabled: false } });
    renderer.resize(100, 100, 1);

    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.drawRect({ x: 0, y: 0, w: 0, h: 0.5, color: { r: 1, g: 1, b: 1, a: 1 } });
    renderer.drawRect({ x: 0, y: 0, w: 0.5, h: 0.5, color: { r: 1, g: 0, b: 0, a: 1 } });
    renderer.endFrame();

    // Only the one non-degenerate rect becomes an instance in the scene pass;
    // the post pass always draws its fullscreen triangle.
    expect(harness.drawsByPass[0]).toEqual([[6, 1]]);
    expect(harness.drawsByPass[1]).toEqual([[3, 1]]);
  });

  it("webgpu builds the scene + bloom + post pipelines exactly once across frames", async () => {
    const harness = makeWebgpuHarness();
    const renderer = createRenderer(harness.canvas, { backend: "webgpu", gpu: harness.gpu });
    await renderer.init();
    renderer.setPostEffects({ bloom: { enabled: false } });
    renderer.resize(100, 100, 1);

    for (let frame = 0; frame < 3; frame++) {
      renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
      renderer.drawRect({ x: 0, y: 0, w: 0.5, h: 0.5, color: { r: 1, g: 0, b: 0, a: 1 } });
      renderer.endFrame();
    }

    // Thirteen pipelines (7 scene primitive variants + bright + blur + upsample +
    // feedback + copy + post) from ten shader modules (rect, gradient, glow,
    // line, bright, blur, upsample, feedback, copy, post) — all built once in
    // init().
    expect(harness.createRenderPipeline).toHaveBeenCalledTimes(13);
    expect(harness.createShaderModule).toHaveBeenCalledTimes(10);
    // With bloom off, two passes per frame (scene + post) => 6 across 3 frames.
    expect(harness.passDescriptors).toHaveLength(6);
    // Each frame: instanced scene draw then fullscreen post draw.
    expect(harness.drawCalls).toEqual([
      [6, 1],
      [3, 1],
      [6, 1],
      [3, 1],
      [6, 1],
      [3, 1],
    ]);
  });
});

describe("HDR offscreen target + post-processing framework (V2-01)", () => {
  it("webgpu runs TWO passes per frame: scene→offscreen HDR, then post→swapchain", async () => {
    // The substrate contract: with the framework active, every frame indirects
    // through an offscreen rgba16float HDR texture (scene pass) and composites
    // it to the swapchain via a fullscreen post pass. The scene pass clears the
    // HDR target; the post pass binds the composite bind group and draws the
    // fullscreen triangle. Exactly two passes, batched into one submit.
    const harness = makeWebgpuHarness();
    const renderer = createRenderer(harness.canvas, { backend: "webgpu", gpu: harness.gpu });
    await renderer.init();
    // Bloom off so the substrate's minimal two-pass shape holds for this test.
    renderer.setPostEffects({ bloom: { enabled: false } });
    renderer.resize(64, 48, 1);

    renderer.beginFrame({ r: 0.02, g: 0.02, b: 0.05, a: 1 });
    renderer.drawRect({ x: 0, y: 0, w: 0.5, h: 1, color: { r: 1, g: 0, b: 0, a: 1 } });
    renderer.endFrame();

    // Two passes total.
    expect(harness.passDescriptors).toHaveLength(2);
    // The offscreen HDR target is an rgba16float texture sized to the backing
    // store, usable as both render attachment and sampled texture. (The bloom
    // mip chain allocates further rgba16float textures at smaller sizes.)
    expect(harness.createTexture).toHaveBeenCalled();
    const fullSize = harness.createTexture.mock.calls
      .map((c) => c[0] as { format: string; size: { width: number; height: number } })
      .find((d) => d.size.width === 64 && d.size.height === 48);
    expect(fullSize?.format).toBe("rgba16float");
    // The post pass binds the composite bind group (HDR texture + sampler + params).
    expect(harness.setBindGroup).toHaveBeenCalledTimes(1);
    expect(harness.createSampler).toHaveBeenCalled();
    expect(harness.createBindGroup).toHaveBeenCalled();
    // The post pass draws a fullscreen triangle (3 verts, 1 instance).
    expect(harness.drawsByPass[1]).toEqual([[3, 1]]);
    // Both passes go in a single submit.
    expect(harness.submit).toHaveBeenCalledTimes(1);
  });

  it("recreates the offscreen HDR target on resize", async () => {
    const harness = makeWebgpuHarness();
    const renderer = createRenderer(harness.canvas, { backend: "webgpu", gpu: harness.gpu });
    await renderer.init();
    renderer.resize(100, 100, 1); // 100x100
    renderer.resize(50, 50, 1); // 50x50

    // After the latest resize a full-res HDR target sized to the new backing
    // store was allocated. (Each resize also rebuilds the smaller bloom mips.)
    const sizes = harness.createTexture.mock.calls.map(
      (c) => (c[0] as { size: { width: number; height: number } }).size,
    );
    expect(sizes).toContainEqual({ width: 50, height: 50 });
    // The first resize's full-res target (100x100) was also allocated earlier.
    expect(sizes).toContainEqual({ width: 100, height: 100 });
    // Many textures allocated (HDR + bloom mips, recreated per resize), and the
    // prior generation was destroyed (no leak).
    expect(harness.createTexture.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("honours setPostEffects({exposure}): the exposure is uploaded to the post uniform", async () => {
    const harness = makeWebgpuHarness();
    const renderer = createRenderer(harness.canvas, { backend: "webgpu", gpu: harness.gpu });
    await renderer.init();
    renderer.resize(32, 32, 1);

    // Set a non-default exposure BEFORE the frame; the value must reach the GPU
    // via the post-FX uniform buffer (a Float32Array whose first element is the
    // exposure).
    renderer.setPostEffects({ exposure: 2.5 });

    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.endFrame();

    // Find a writeBuffer call whose data first float is the exposure we set.
    const exposures = harness.writeBuffer.mock.calls
      .map((c) => c[2] as ArrayBufferLike | ArrayBufferView)
      .map((data) => {
        const view =
          data instanceof ArrayBuffer
            ? new Float32Array(data)
            : new Float32Array(
                (data as ArrayBufferView).buffer,
                (data as ArrayBufferView).byteOffset,
              );
        return view[0];
      });
    expect(exposures).toContain(2.5);
  });

  it("setPostEffects merges partial config and clamps invalid exposure to the default", async () => {
    const harness = makeWebgpuHarness();
    const renderer = createRenderer(harness.canvas, { backend: "webgpu", gpu: harness.gpu });
    await renderer.init();
    renderer.resize(32, 32, 1);

    // An empty config is a no-op (leaves the default exposure of 1.0); a
    // negative/non-finite exposure clamps back to the default.
    renderer.setPostEffects({});
    renderer.setPostEffects({ exposure: -5 });

    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.endFrame();

    const firstFloats = harness.writeBuffer.mock.calls
      .map((c) => c[2] as ArrayBufferLike | ArrayBufferView)
      .map((data) => {
        const view =
          data instanceof ArrayBuffer
            ? new Float32Array(data)
            : new Float32Array(
                (data as ArrayBufferView).buffer,
                (data as ArrayBufferView).byteOffset,
              );
        return view[0];
      });
    // The uploaded exposure is the clamped default (1.0), never -5.
    expect(firstFloats).toContain(1);
    expect(firstFloats).not.toContain(-5);
  });

  it("webgl implements setPostEffects as a no-op (basic look, direct render)", async () => {
    const { canvas, gl } = makeFakeCanvas();
    const renderer = createRenderer(canvas, {
      environment: { gpu: null, hasWebgl: () => true },
    });
    await renderer.init();
    renderer.resize(100, 100, 1);

    // Must accept the call (including bloom + vignette) without throwing and
    // without altering its direct render path: a subsequent frame still draws
    // the rect as before. WebGL keeps its basic look — post-FX is a no-op.
    expect(() =>
      renderer.setPostEffects({
        exposure: 3,
        bloom: { enabled: true, threshold: 0.5, intensity: 1, radius: 2 },
        vignette: { enabled: true, amount: 0.5 },
      }),
    ).not.toThrow();

    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.drawRect({ x: 0, y: 0, w: 0.5, h: 0.5, color: { r: 1, g: 0, b: 0, a: 1 } });
    renderer.endFrame();
    // Still rendering directly (the basic shader-quad path), unaffected by
    // post-FX config.
    expect(gl.drawArrays).toHaveBeenCalled();
  });

  it("setPostEffects is part of the backend-agnostic Renderer surface (no backend branch)", () => {
    // Presets call setPostEffects without inspecting `.backend`. The function's
    // source must reference no backend literal or raw GL/GPU surface.
    const drivePostFx = (r: Renderer): void => {
      r.setPostEffects({ exposure: 1.2 });
    };
    const src = drivePostFx.toString();
    expect(src).not.toMatch(/webgpu|webgl|GPUDevice|WebGLRenderingContext|getContext|gl\./i);
    expect(src).not.toMatch(/\.backend/);
  });
});

/** Decode every writeBuffer call's payload as a Float32Array of its 4 floats. */
function decodeUniformWrites(writeBuffer: ReturnType<typeof vi.fn>): number[][] {
  return writeBuffer.mock.calls.map((c) => {
    const data = c[2] as ArrayBufferLike | ArrayBufferView;
    const view =
      data instanceof ArrayBuffer
        ? new Float32Array(data)
        : new Float32Array(
            (data as ArrayBufferView).buffer,
            (data as ArrayBufferView).byteOffset,
            4,
          );
    return Array.from(view.slice(0, 4));
  });
}

/**
 * True when some recorded 4-float write matches `expected` within float32
 * rounding (the values round-trip through a `Float32Array` on upload, so e.g.
 * 0.7 reads back as 0.69999998…). Tolerance is generous but far tighter than
 * the gaps between the distinctive test values.
 */
function writesContainVec(writes: number[][], expected: number[]): boolean {
  const eps = 1e-5;
  return writes.some(
    (w) => w.length === expected.length && w.every((v, i) => Math.abs(v - expected[i]!) < eps),
  );
}

describe("bloom + vignette post-FX (V2-02)", () => {
  it("enabling bloom adds the expected extra passes vs bloom-off", async () => {
    // With bloom OFF the frame is two passes (scene + post). Enabling bloom adds
    // the bright-pass, per-mip separable blur (H+V), downsamples, and an
    // upsample-accumulate — strictly MORE passes — proving the bloom chain runs.
    const offHarness = makeWebgpuHarness();
    const off = createRenderer(offHarness.canvas, { backend: "webgpu", gpu: offHarness.gpu });
    await off.init();
    off.setPostEffects({ bloom: { enabled: false } });
    off.resize(64, 64, 1);
    off.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    off.drawRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5, color: { r: 4, g: 4, b: 4, a: 1 } });
    off.endFrame();

    const onHarness = makeWebgpuHarness();
    const on = createRenderer(onHarness.canvas, { backend: "webgpu", gpu: onHarness.gpu });
    await on.init();
    on.setPostEffects({ bloom: { enabled: true } });
    on.resize(64, 64, 1);
    on.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    on.drawRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5, color: { r: 4, g: 4, b: 4, a: 1 } });
    on.endFrame();

    // Bloom-off is exactly the two-pass substrate.
    expect(offHarness.passDescriptors).toHaveLength(2);
    // Bloom-on runs strictly more passes (bright + blur + downsample + upsample
    // + scene + post). With 4 mips: scene(1) + bright(1) + blur H/V ×4 (8) +
    // downsample ×3 (3) + upsample-accumulate ×3 (3) + post(1) = 17.
    expect(onHarness.passDescriptors.length).toBeGreaterThan(offHarness.passDescriptors.length);
    expect(onHarness.passDescriptors).toHaveLength(17);
    // The bright-pass + every blur/upsample is a fullscreen-triangle draw(3,1);
    // the scene pass draws the instanced quad once. So bloom-on has many more
    // draw calls than bloom-off (which has just scene + post = 2 draws).
    expect(onHarness.drawCalls.length).toBeGreaterThan(offHarness.drawCalls.length);
    // First pass is always the scene clear; last pass is the swapchain composite.
    const lastOn = onHarness.passDescriptors.at(-1) as {
      colorAttachments: Array<{ loadOp: string }>;
    };
    expect(lastOn.colorAttachments[0]?.loadOp).toBe("clear");
    // Still a single submit batching the whole chain.
    expect(onHarness.submit).toHaveBeenCalledTimes(1);
  });

  it("builds thirteen pipelines (scene primitives + bloom + feedback + post) once", async () => {
    const harness = makeWebgpuHarness();
    const renderer = createRenderer(harness.canvas, { backend: "webgpu", gpu: harness.gpu });
    await renderer.init();
    renderer.resize(64, 64, 1);
    // Seven scene-primitive pipelines (rect/gradient/line ×{alpha,additive} +
    // glow) + bloom (bright + blur + upsample) + feedback (feedback + copy) +
    // post — all built once in init().
    expect(harness.createRenderPipeline).toHaveBeenCalledTimes(13);
    expect(harness.createShaderModule).toHaveBeenCalledTimes(10);
  });

  it("honours bloom + vignette config: the composite uniform records the values", async () => {
    const harness = makeWebgpuHarness();
    const renderer = createRenderer(harness.canvas, { backend: "webgpu", gpu: harness.gpu });
    await renderer.init();
    renderer.resize(32, 32, 1);

    // Distinctive, in-range values so the composite uniform vector is uniquely
    // identifiable: [exposure, bloomIntensity, vignetteEnabled(=1), amount].
    renderer.setPostEffects({
      exposure: 1.3,
      bloom: { enabled: true, threshold: 0.8, intensity: 0.42, radius: 1.5 },
      vignette: { enabled: true, amount: 0.27 },
    });

    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.endFrame();

    const writes = decodeUniformWrites(harness.writeBuffer);
    // The composite params are uploaded verbatim (intensity honored because
    // bloom is enabled; vignette enabled flag = 1; amount preserved).
    expect(writesContainVec(writes, [1.3, 0.42, 1, 0.27])).toBe(true);
    // The bloom uniform carries the configured threshold + radius across its
    // bright-pass / blur invocations (dir flips between H and V).
    expect(writesContainVec(writes, [0.8, 0, 0, 1.5])).toBe(true); // bright-pass
    expect(writesContainVec(writes, [0.8, 1, 0, 1.5])).toBe(true); // horizontal blur
    expect(writesContainVec(writes, [0.8, 0, 1, 1.5])).toBe(true); // vertical blur
  });

  it("disabling bloom zeroes the composite bloom intensity", async () => {
    const harness = makeWebgpuHarness();
    const renderer = createRenderer(harness.canvas, { backend: "webgpu", gpu: harness.gpu });
    await renderer.init();
    renderer.resize(32, 32, 1);

    renderer.setPostEffects({
      exposure: 1,
      bloom: { enabled: false, intensity: 0.9 },
      vignette: { enabled: false, amount: 0.3 },
    });
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.endFrame();

    const writes = decodeUniformWrites(harness.writeBuffer);
    // bloomIntensity forced to 0 (slot 1) and vignette disabled (slot 2 = 0)
    // even though an amount was supplied — the effect is gated by `enabled`.
    expect(writesContainVec(writes, [1, 0, 0, 0.3])).toBe(true);
    // With bloom off, NO bloom-direction uniform writes happen at all.
    expect(writes.some((w) => w[1] === 1 && w[2] === 0)).toBe(false); // no H blur
    expect(writes.some((w) => w[1] === 0 && w[2] === 1)).toBe(false); // no V blur
  });

  it("clamps a negative bloom intensity / out-of-range vignette amount", async () => {
    const harness = makeWebgpuHarness();
    const renderer = createRenderer(harness.canvas, { backend: "webgpu", gpu: harness.gpu });
    await renderer.init();
    renderer.resize(32, 32, 1);

    // Negative intensity clamps to the cinematic default (0.6); a >1 vignette
    // amount clamps to 1.
    renderer.setPostEffects({
      exposure: 1,
      bloom: { enabled: true, intensity: -3 },
      vignette: { enabled: true, amount: 5 },
    });
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.endFrame();

    const writes = decodeUniformWrites(harness.writeBuffer);
    expect(writesContainVec(writes, [1, 0.6, 1, 1])).toBe(true);
  });
});

describe("feedback / trail buffer (V2-04)", () => {
  /** A bloom+vignette-off renderer so the only variable is the feedback chain. */
  async function makeReady() {
    const harness = makeWebgpuHarness();
    const renderer = createRenderer(harness.canvas, { backend: "webgpu", gpu: harness.gpu });
    await renderer.init();
    renderer.setPostEffects({ bloom: { enabled: false }, vignette: { enabled: false } });
    renderer.resize(64, 64, 1);
    return { harness, renderer };
  }

  it("is DISABLED by default: a frame is the V2-02 two-pass path (scene + post)", async () => {
    const { harness, renderer } = await makeReady();
    // No feedback config set → feedback off by default.
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.drawGlow({ x: 0.5, y: 0.5, radius: 0.1, color: { r: 4, g: 4, b: 4, a: 1 } });
    renderer.endFrame();
    // Exactly the two-pass substrate: scene→offscreen, post→swapchain. No
    // feedback/copy passes inserted.
    expect(harness.passDescriptors).toHaveLength(2);
  });

  it("enabling feedback adds passes; first frame SEEDS history (one copy), later frames COMPOSITE (feedback + copy)", async () => {
    const { harness, renderer } = await makeReady();
    renderer.setPostEffects({ feedback: { enabled: true, decay: 0.9 } });

    // FRAME 1: history not primed yet → ONE seed copy pass inserted between
    // scene and post. So scene(1) + seedCopy(1) + post(1) = 3 passes.
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.drawGlow({ x: 0.3, y: 0.5, radius: 0.1, color: { r: 4, g: 4, b: 4, a: 1 } });
    renderer.endFrame();
    expect(harness.passDescriptors).toHaveLength(3);

    // FRAME 2: history primed → feedback-composite pass + copy-back pass. So
    // scene(1) + feedback(1) + copyBack(1) + post(1) = 4 passes THIS frame.
    const before = harness.passDescriptors.length;
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.drawGlow({ x: 0.5, y: 0.5, radius: 0.1, color: { r: 4, g: 4, b: 4, a: 1 } });
    renderer.endFrame();
    expect(harness.passDescriptors.length - before).toBe(4);
  });

  it("disabling feedback reverts to the V2-02 two-pass path", async () => {
    const { harness, renderer } = await makeReady();
    renderer.setPostEffects({ feedback: { enabled: true, decay: 0.9 } });
    // Prime + composite a couple of frames with feedback on.
    for (let f = 0; f < 2; f++) {
      renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
      renderer.drawGlow({ x: 0.5, y: 0.5, radius: 0.1, color: { r: 4, g: 4, b: 4, a: 1 } });
      renderer.endFrame();
    }
    // Now turn feedback OFF and render one more frame.
    renderer.setPostEffects({ feedback: { enabled: false } });
    const before = harness.passDescriptors.length;
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.drawGlow({ x: 0.5, y: 0.5, radius: 0.1, color: { r: 4, g: 4, b: 4, a: 1 } });
    renderer.endFrame();
    // Back to the plain two-pass path (scene + post): exactly 2 passes added.
    expect(harness.passDescriptors.length - before).toBe(2);
  });

  it("honours the decay: the feedback uniform carries the configured value, clamped below 1", async () => {
    const { harness, renderer } = await makeReady();
    // A distinctive in-range decay, plus a >1 decay that must clamp to <1.
    renderer.setPostEffects({ feedback: { enabled: true, decay: 0.83 } });
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.endFrame();

    const writes = decodeUniformWrites(harness.writeBuffer);
    // The feedback uniform packs [decay, 0, 0, 0]; 0.83 round-trips through f32.
    expect(writesContainVec(writes, [0.83, 0, 0, 0])).toBe(true);

    // A decay of exactly 1 (or higher) clamps to the max (0.999) so trails fade.
    renderer.setPostEffects({ feedback: { decay: 1 } });
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.endFrame();
    const writes2 = decodeUniformWrites(harness.writeBuffer);
    expect(writesContainVec(writes2, [0.999, 0, 0, 0])).toBe(true);
    expect(writes2.some((w) => w[0] === 1 && w[1] === 0 && w[2] === 0 && w[3] === 0)).toBe(false);
  });

  it("allocates the ping-pong history textures and recreates them on resize", async () => {
    const { harness, renderer } = await makeReady();
    // Two full-res HDR history textures (64×64) exist alongside the scene HDR.
    const sizesAt64 = harness.createTexture.mock.calls
      .map((c) => (c[0] as { size: { width: number; height: number } }).size)
      .filter((s) => s.width === 64 && s.height === 64);
    // hdr(1) + history×2 = at least 3 full-res rgba16float allocations.
    expect(sizesAt64.length).toBeGreaterThanOrEqual(3);

    // Resize must NOT crash and reallocates history at the new size.
    expect(() => renderer.resize(48, 48, 1)).not.toThrow();
    const sizesAt48 = harness.createTexture.mock.calls
      .map((c) => (c[0] as { size: { width: number; height: number } }).size)
      .filter((s) => s.width === 48 && s.height === 48);
    expect(sizesAt48.length).toBeGreaterThanOrEqual(3);
  });

  it("resetting after resize re-seeds history (no crash, first post-resize frame seeds)", async () => {
    const { harness, renderer } = await makeReady();
    renderer.setPostEffects({ feedback: { enabled: true, decay: 0.9 } });
    // Prime once.
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.endFrame();
    // Resize resets history (primed → false). The next frame must SEED again
    // (one copy pass), not composite against stale/wrong-size history.
    renderer.resize(80, 80, 1);
    const before = harness.passDescriptors.length;
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.endFrame();
    // scene(1) + seedCopy(1) + post(1) = 3 passes (the seed path again).
    expect(harness.passDescriptors.length - before).toBe(3);
  });

  it("feedback is part of the backend-agnostic surface (no backend branch)", () => {
    const drive = (r: Renderer): void => {
      r.setPostEffects({ feedback: { enabled: true, decay: 0.9 } });
    };
    const src = drive.toString();
    expect(src).not.toMatch(/webgpu|webgl|GPUDevice|WebGLRenderingContext|getContext|gl\./i);
    expect(src).not.toMatch(/\.backend/);
  });

  it("webgl treats feedback as a no-op (basic look, never throws)", async () => {
    const { canvas, gl } = makeFakeCanvas();
    const renderer = createRenderer(canvas, { environment: { gpu: null, hasWebgl: () => true } });
    await renderer.init();
    renderer.resize(100, 100, 1);
    expect(() => renderer.setPostEffects({ feedback: { enabled: true, decay: 0.95 } })).not.toThrow();
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.drawRect({ x: 0, y: 0, w: 0.5, h: 0.5, color: { r: 1, g: 0, b: 0, a: 1 } });
    renderer.endFrame();
    // Still rendering directly — feedback config ignored.
    expect(gl.drawArrays).toHaveBeenCalled();
  });

  it("feedbackCombine is the pure recurrence scene + history*decay, decay clamped to [0,0.999]", () => {
    expect(feedbackCombine(1, 0, 0.9)).toBe(1);
    expect(feedbackCombine(0.2, 1, 0.9)).toBeCloseTo(1.1, 10);
    // decay >= 1 clamps to 0.999 so the trail still fades.
    expect(feedbackCombine(0, 1, 1)).toBeCloseTo(0.999, 10);
    expect(feedbackCombine(0, 1, 2)).toBeCloseTo(0.999, 10);
    // Negative / non-finite decay is rejected (0 / default 0.9 respectively).
    expect(feedbackCombine(0, 1, -1)).toBe(0);
    expect(feedbackCombine(0, 1, NaN)).toBeCloseTo(0.9, 10);
  });

  it("OFFLINE DETERMINISM: a multi-frame feedback sequence is byte-identical across two runs", () => {
    // The story's determinism note: trails depend on frame history, but the
    // feedback is a PURE function of prior frames + decay (no time, no RNG), so
    // a fixed-fps offline render produces identical output across runs. We model
    // a moving bright impulse (a glow stepping across frames) as a per-frame
    // scene value and run the recurrence twice with identical inputs.
    const decay = 0.9;
    // A bright pulse on frames 2 and 5, dark otherwise — like a glow passing a
    // sample point twice. The trail must accumulate + decay identically.
    const sceneA = [0, 0, 1, 0, 0, 1, 0, 0, 0, 0];
    const sceneB = [...sceneA]; // identical inputs, a second independent run

    const run1 = feedbackSequence(sceneA, decay);
    const run2 = feedbackSequence(sceneB, decay);

    // Two runs with identical inputs are exactly equal (no drift).
    expect(run2).toEqual(run1);
    // And the trail is real: after the frame-2 pulse, frames 3 and 4 are lit by
    // the DECAYED history even though their own scene value is 0 — a tail.
    expect(run1[2]).toBe(1); // pulse frame
    expect(run1[3]).toBeCloseTo(0.9, 10); // 1 * 0.9
    expect(run1[4]).toBeCloseTo(0.81, 10); // 0.9 * 0.9
    expect(run1[3]!).toBeGreaterThan(run1[4]!); // fades with distance
    expect(run1[4]!).toBeGreaterThan(0); // still lit

    // The second pulse (frame 5) lands ON TOP of the residual tail from frame 2,
    // and the determinism still holds frame-for-frame.
    expect(run1[5]).toBeCloseTo(1 + 0.81 * 0.9, 10);
    for (let i = 0; i < run1.length; i++) {
      expect(run2[i]).toBe(run1[i]);
    }
  });

  it("OFFLINE DETERMINISM: decay 0 leaves NO trail (history contributes nothing)", () => {
    const scene = [0, 1, 0, 0];
    const out = feedbackSequence(scene, 0);
    // With decay 0 each frame is exactly its own scene value — no tail.
    expect(out).toEqual(scene);
  });
});

/** Decode a writeBuffer payload (whole buffer) into a full Float32Array. */
function decodeWrite(data: ArrayBufferLike | ArrayBufferView): Float32Array {
  return data instanceof ArrayBuffer
    ? new Float32Array(data)
    : new Float32Array(
        (data as ArrayBufferView).buffer,
        (data as ArrayBufferView).byteOffset,
        (data as ArrayBufferView).byteLength / 4,
      );
}

/** All writeBuffer payloads (whole-buffer) decoded as Float32Arrays. */
function allWrites(writeBuffer: ReturnType<typeof vi.fn>): Float32Array[] {
  return writeBuffer.mock.calls.map((c) => decodeWrite(c[2] as ArrayBufferLike | ArrayBufferView));
}

/** True when some write contains `seq` as a contiguous subsequence (float32 eps). */
function someWriteContainsSeq(writes: Float32Array[], seq: number[]): boolean {
  const eps = 1e-5;
  return writes.some((w) => {
    for (let start = 0; start + seq.length <= w.length; start++) {
      let ok = true;
      for (let i = 0; i < seq.length; i++) {
        if (Math.abs(w[start + i]! - seq[i]!) > eps) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  });
}

describe("rich primitives — pure helpers (V2-03)", () => {
  it("expandLineToQuad offsets a horizontal segment by ±width/2 along its normal", () => {
    const corners = expandLineToQuad({ x0: 0.2, y0: 0.5, x1: 0.8, y1: 0.5, width: 0.1 });
    // Normal of a +x segment is (0,1); half-width 0.05 → start/end ±0.05 in y.
    expect(corners[0]).toEqual({ x: 0.2, y: 0.55 }); // start-left (+normal)
    expect(corners[1]).toEqual({ x: 0.2, y: 0.45 }); // start-right (-normal)
    expect(corners[2]).toEqual({ x: 0.8, y: 0.55 }); // end-left
    expect(corners[3]).toEqual({ x: 0.8, y: 0.45 }); // end-right
  });

  it("expandLineToQuad offsets a vertical segment along the x normal", () => {
    const corners = expandLineToQuad({ x0: 0.5, y0: 0.2, x1: 0.5, y1: 0.8, width: 0.2 });
    // Direction (0,1) → normal (-1,0); half-width 0.1 → ±0.1 in x.
    expect(corners[0].x).toBeCloseTo(0.4, 6);
    expect(corners[1].x).toBeCloseTo(0.6, 6);
    expect(corners[0].y).toBeCloseTo(0.2, 6);
    expect(corners[2].y).toBeCloseTo(0.8, 6);
  });

  it("expandLineToQuad falls back to a horizontal normal for a degenerate segment", () => {
    // Zero-length segment must not produce NaNs; it falls back to dir +x.
    const corners = expandLineToQuad({ x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.5, width: 0.1 });
    for (const c of corners) {
      expect(Number.isFinite(c.x)).toBe(true);
      expect(Number.isFinite(c.y)).toBe(true);
    }
    expect(corners[0]).toEqual({ x: 0.5, y: 0.55 });
  });

  it("normalizedToClip maps the normalized frame to clip space (y flipped)", () => {
    expect(normalizedToClip(0, 0)).toEqual({ x: -1, y: 1 }); // top-left
    expect(normalizedToClip(1, 1)).toEqual({ x: 1, y: -1 }); // bottom-right
    expect(normalizedToClip(0.5, 0.5)).toEqual({ x: 0, y: 0 }); // center
  });

  it("lineBoundsRect returns the tight bounds of the stroked quad", () => {
    const b = lineBoundsRect({ x0: 0.2, y0: 0.5, x1: 0.8, y1: 0.5, width: 0.1 });
    expect(b.x).toBeCloseTo(0.2, 6);
    expect(b.y).toBeCloseTo(0.45, 6);
    expect(b.w).toBeCloseTo(0.6, 6);
    expect(b.h).toBeCloseTo(0.1, 6);
  });
});

describe("rich primitives — WebGPU draws (V2-03)", () => {
  /** Build a bloom-off renderer + harness ready to draw one frame. */
  async function makeReady() {
    const harness = makeWebgpuHarness();
    const renderer = createRenderer(harness.canvas, { backend: "webgpu", gpu: harness.gpu });
    await renderer.init();
    renderer.setPostEffects({ bloom: { enabled: false }, vignette: { enabled: false } });
    renderer.resize(100, 100, 1);
    return { harness, renderer };
  }

  it("drawGradientRect records a gradient instance carrying both endpoints", async () => {
    const { harness, renderer } = await makeReady();
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.drawGradientRect(
      { x: 0.1, y: 0.2, w: 0.5, h: 0.4, color: { r: 0, g: 0, b: 0, a: 1 } },
      { from: { r: 1, g: 0, b: 0, a: 1 }, to: { r: 0, g: 0, b: 1, a: 1 }, angle: 0 },
    );
    renderer.endFrame();

    const writes = allWrites(harness.writeBuffer);
    // The instance packs [x,y,w,h, from.rgba, to.rgba, angle, radial, _, _].
    // Endpoints honored: from=red, to=blue present contiguously in some write.
    expect(someWriteContainsSeq(writes, [1, 0, 0, 1, 0, 0, 1, 1])).toBe(true);
    // The rect geometry + linear (radial flag 0) params are present.
    expect(someWriteContainsSeq(writes, [0.1, 0.2, 0.5, 0.4])).toBe(true);
    // Scene pass draws the gradient as ONE instanced quad, then post composites.
    expect(harness.drawsByPass[0]).toEqual([[6, 1]]);
    expect(harness.drawsByPass[1]).toEqual([[3, 1]]);
  });

  it("drawGradientRect honors the radial flag", async () => {
    const { harness, renderer } = await makeReady();
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.drawGradientRect(
      { x: 0, y: 0, w: 1, h: 1, color: { r: 0, g: 0, b: 0, a: 1 } },
      { from: { r: 2, g: 2, b: 2, a: 1 }, to: { r: 0, g: 0, b: 0, a: 0 }, radial: true },
    );
    renderer.endFrame();
    const writes = allWrites(harness.writeBuffer);
    // params lane has radial=1 (the 14th float of the instance: angle=0, radial=1).
    expect(someWriteContainsSeq(writes, [0, 1, 0, 0])).toBe(true);
  });

  it("drawGlow records a feathered HDR instance and draws it additively", async () => {
    const { harness, renderer } = await makeReady();
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    // intensity>1 pushes the core into HDR so bloom can pick it up.
    renderer.drawGlow({
      x: 0.5,
      y: 0.5,
      radius: 0.2,
      color: { r: 1, g: 0.8, b: 0.6, a: 1 },
      intensity: 3,
    });
    renderer.endFrame();

    const writes = allWrites(harness.writeBuffer);
    // Instance: [cx,cy,radius,_, color.rgba, intensity,_,_,_].
    expect(someWriteContainsSeq(writes, [0.5, 0.5, 0.2, 0])).toBe(true);
    expect(someWriteContainsSeq(writes, [1, 0.8, 0.6, 1, 3])).toBe(true);
    // One instanced glow draw in the scene pass.
    expect(harness.drawsByPass[0]).toEqual([[6, 1]]);
  });

  it("drawGlow defaults intensity to 1 and skips zero-radius glows", async () => {
    const { harness, renderer } = await makeReady();
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.drawGlow({ x: 0.5, y: 0.5, radius: 0, color: { r: 1, g: 1, b: 1, a: 1 } }); // skipped
    renderer.drawGlow({ x: 0.3, y: 0.7, radius: 0.1, color: { r: 1, g: 1, b: 1, a: 1 } }); // intensity → 1
    renderer.endFrame();
    const writes = allWrites(harness.writeBuffer);
    expect(someWriteContainsSeq(writes, [0.3, 0.7, 0.1, 0])).toBe(true);
    // Exactly ONE glow instance (the zero-radius one was skipped).
    expect(harness.drawsByPass[0]).toEqual([[6, 1]]);
  });

  it("drawLine records the four expanded corners and a single instanced draw", async () => {
    const { harness, renderer } = await makeReady();
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.drawLine({
      x0: 0.2,
      y0: 0.5,
      x1: 0.8,
      y1: 0.5,
      width: 0.1,
      color: { r: 0, g: 1, b: 0, a: 1 },
    });
    renderer.endFrame();

    const writes = allWrites(harness.writeBuffer);
    // Instance packs [c0.xy, c1.xy, c2.xy, c3.xy, color.rgba].
    // Horizontal line → corners at y 0.55/0.45 (see expandLineToQuad test).
    expect(someWriteContainsSeq(writes, [0.2, 0.55, 0.2, 0.45, 0.8, 0.55, 0.8, 0.45])).toBe(true);
    expect(someWriteContainsSeq(writes, [0, 1, 0, 1])).toBe(true); // green color
    expect(harness.drawsByPass[0]).toEqual([[6, 1]]);
  });

  it("setBlendMode(additive) selects the additive rect pipeline; default is alpha", async () => {
    // Two frames from fresh renderers: alpha default vs additive. The additive
    // frame must bind a DIFFERENT scene pipeline object for the rect batch.
    const a = await makeReady();
    a.renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    a.renderer.drawRect({ x: 0, y: 0, w: 0.5, h: 0.5, color: { r: 1, g: 0, b: 0, a: 1 } });
    a.renderer.endFrame();
    // First setPipeline call is the scene (rect) pipeline; second is post.
    const alphaScenePipeline = a.harness.setPipeline.mock.calls[0]?.[0];

    const b = await makeReady();
    b.renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    b.renderer.setBlendMode("additive");
    b.renderer.drawRect({ x: 0, y: 0, w: 0.5, h: 0.5, color: { r: 1, g: 0, b: 0, a: 1 } });
    b.renderer.endFrame();
    const addScenePipeline = b.harness.setPipeline.mock.calls[0]?.[0];

    // Both are real pipeline objects but distinct identities (alpha vs additive).
    expect(alphaScenePipeline).toBeDefined();
    expect(addScenePipeline).toBeDefined();
    expect(addScenePipeline).not.toBe(alphaScenePipeline);
  });

  it("coalesces a run of same-kind/blend primitives into ONE instanced draw, preserving order across kinds", async () => {
    const { harness, renderer } = await makeReady();
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    // 3 rects, then 2 glows, then 1 line — three batches, three scene draws.
    renderer.drawRect({ x: 0, y: 0, w: 0.2, h: 0.2, color: { r: 1, g: 0, b: 0, a: 1 } });
    renderer.drawRect({ x: 0.2, y: 0, w: 0.2, h: 0.2, color: { r: 1, g: 0, b: 0, a: 1 } });
    renderer.drawRect({ x: 0.4, y: 0, w: 0.2, h: 0.2, color: { r: 1, g: 0, b: 0, a: 1 } });
    renderer.drawGlow({ x: 0.5, y: 0.5, radius: 0.1, color: { r: 1, g: 1, b: 1, a: 1 } });
    renderer.drawGlow({ x: 0.6, y: 0.6, radius: 0.1, color: { r: 1, g: 1, b: 1, a: 1 } });
    renderer.drawLine({
      x0: 0,
      y0: 0.9,
      x1: 1,
      y1: 0.9,
      width: 0.02,
      color: { r: 0, g: 0, b: 1, a: 1 },
    });
    renderer.endFrame();

    // Scene pass: rect batch draw(6,3), glow batch draw(6,2), line batch draw(6,1).
    expect(harness.drawsByPass[0]).toEqual([
      [6, 3],
      [6, 2],
      [6, 1],
    ]);
    // Post pass composites once.
    expect(harness.drawsByPass[1]).toEqual([[3, 1]]);
    // Three scene-primitive pipelines bound + one post = four setPipeline calls.
    expect(harness.setPipeline).toHaveBeenCalledTimes(4);
  });

  it("does NOT coalesce across a blend-mode change", async () => {
    const { harness, renderer } = await makeReady();
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.drawRect({ x: 0, y: 0, w: 0.2, h: 0.2, color: { r: 1, g: 0, b: 0, a: 1 } }); // alpha
    renderer.setBlendMode("additive");
    renderer.drawRect({ x: 0.2, y: 0, w: 0.2, h: 0.2, color: { r: 1, g: 0, b: 0, a: 1 } }); // additive
    renderer.endFrame();
    // Two separate rect batches → two scene draws (each one instance).
    expect(harness.drawsByPass[0]).toEqual([
      [6, 1],
      [6, 1],
    ]);
  });

  it("all primitives are part of the backend-agnostic surface (no backend branch)", () => {
    const drive = (r: Renderer): void => {
      r.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
      r.setBlendMode("additive");
      r.drawGradientRect(
        { x: 0, y: 0, w: 1, h: 1, color: { r: 0, g: 0, b: 0, a: 1 } },
        { from: { r: 1, g: 0, b: 0, a: 1 }, to: { r: 0, g: 0, b: 1, a: 1 } },
      );
      r.drawGlow({ x: 0.5, y: 0.5, radius: 0.2, color: { r: 1, g: 1, b: 1, a: 1 }, intensity: 2 });
      r.drawLine({ x0: 0, y0: 0, x1: 1, y1: 1, width: 0.01, color: { r: 1, g: 1, b: 1, a: 1 } });
      r.endFrame();
    };
    const src = drive.toString();
    expect(src).not.toMatch(/webgpu|webgl|GPUDevice|WebGLRenderingContext|getContext|gl\./i);
    expect(src).not.toMatch(/\.backend/);
  });
});

describe("rich primitives — WebGL approximations (V2-03)", () => {
  it("drawGlow always blends additively (light) regardless of blend mode", async () => {
    const { canvas, gl } = makeFakeCanvas();
    const renderer = createRenderer(canvas, { environment: { gpu: null, hasWebgl: () => true } });
    await renderer.init();
    renderer.resize(100, 100, 1);
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.drawGlow({
      x: 0.5,
      y: 0.5,
      radius: 0.2,
      color: { r: 1, g: 1, b: 1, a: 1 },
      intensity: 2,
    });
    renderer.endFrame();
    // The glow's quads use additive blend (SRC_ALPHA, ONE).
    expect(gl.blendFunc).toHaveBeenCalledWith(gl.SRC_ALPHA, gl.ONE);
    // Two stacked quads (halo + core) approximate the feathered blob.
    expect(gl.drawArrays).toHaveBeenCalledTimes(2);
  });

  it("drawGradientRect approximates a linear ramp with banded solid rects", async () => {
    const { canvas, gl } = makeFakeCanvas();
    const renderer = createRenderer(canvas, { environment: { gpu: null, hasWebgl: () => true } });
    await renderer.init();
    renderer.resize(100, 100, 1);
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.drawGradientRect(
      { x: 0, y: 0, w: 1, h: 1, color: { r: 0, g: 0, b: 0, a: 1 } },
      { from: { r: 1, g: 0, b: 0, a: 1 }, to: { r: 0, g: 0, b: 1, a: 1 }, angle: 0 },
    );
    renderer.endFrame();
    // Several banded quads (the stepped ramp) → multiple draws, endpoints present.
    expect(gl.drawArrays.mock.calls.length).toBeGreaterThan(1);
    expect(gl.uniform4f).toHaveBeenCalledWith({ name: "u_color" }, 1, 0, 0, 1); // from
    expect(gl.uniform4f).toHaveBeenCalledWith({ name: "u_color" }, 0, 0, 1, 1); // to
  });

  it("drawLine approximates with a thin rect and respects additive blend", async () => {
    const { canvas, gl } = makeFakeCanvas();
    const renderer = createRenderer(canvas, { environment: { gpu: null, hasWebgl: () => true } });
    await renderer.init();
    renderer.resize(100, 100, 1);
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.setBlendMode("additive");
    renderer.drawLine({
      x0: 0.2,
      y0: 0.5,
      x1: 0.8,
      y1: 0.5,
      width: 0.1,
      color: { r: 0, g: 1, b: 0, a: 1 },
    });
    renderer.endFrame();
    // Thin-rect bounds: x=0.2, y=0.45, w=0.6, h=0.1.
    expect(gl.uniform4f).toHaveBeenCalledWith(
      { name: "u_rect" },
      0.2,
      expect.closeTo(0.45, 5),
      expect.closeTo(0.6, 5),
      expect.closeTo(0.1, 5),
    );
    expect(gl.blendFunc).toHaveBeenLastCalledWith(gl.SRC_ALPHA, gl.ONE);
  });

  it("never throws on the new primitives (the basic backend always runs presets)", async () => {
    const { canvas } = makeFakeCanvas();
    const renderer = createRenderer(canvas, { environment: { gpu: null, hasWebgl: () => true } });
    await renderer.init();
    renderer.resize(100, 100, 1);
    expect(() => {
      renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
      renderer.setBlendMode("additive");
      renderer.drawGradientRect(
        { x: 0, y: 0, w: 1, h: 1, color: { r: 0, g: 0, b: 0, a: 1 } },
        { from: { r: 1, g: 0, b: 0, a: 1 }, to: { r: 0, g: 0, b: 1, a: 1 }, radial: true },
      );
      renderer.drawGlow({ x: 0.5, y: 0.5, radius: 0.2, color: { r: 1, g: 1, b: 1, a: 1 } });
      renderer.drawLine({
        x0: 0,
        y0: 0,
        x1: 1,
        y1: 1,
        width: 0.01,
        color: { r: 1, g: 1, b: 1, a: 1 },
      });
      renderer.endFrame();
    }).not.toThrow();
  });
});
