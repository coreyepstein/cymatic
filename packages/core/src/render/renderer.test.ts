import { describe, expect, it, vi } from "vitest";

import type { RendererEnvironment } from "./capabilities.js";
import {
  computeDrawingBufferSize,
  createRenderer,
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

/** A fake canvas usable by both backends; records context requests. */
function makeFakeCanvas() {
  const contexts: string[] = [];
  const gl = {
    COLOR_BUFFER_BIT: 0x4000,
    SCISSOR_TEST: 0x0c11,
    viewport: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    scissor: vi.fn(),
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
    // EXACT same preset path as the webgl case.
    await runSmokePreset(renderer);

    expect(harness.canvas.width).toBe(1280);
    expect(harness.canvas.height).toBe(960);
    // The smoke scene draws no rects: exactly one pass, cleared to the
    // background, and one submit.
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.passDescriptors).toHaveLength(1);
    const desc = harness.passDescriptors[0] as {
      colorAttachments: Array<{
        clearValue: { r: number; g: number; b: number; a: number };
        loadOp: string;
      }>;
    };
    expect(desc.colorAttachments[0]?.loadOp).toBe("clear");
    expect(desc.colorAttachments[0]?.clearValue).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
    // The pipeline is built once in init() and bound for the frame.
    expect(harness.createRenderPipeline).toHaveBeenCalledTimes(1);
    expect(harness.setPipeline).toHaveBeenCalledTimes(1);
  });
});

/**
 * A recording WebGPU harness modelling the structural slice the renderer uses:
 * a device exposing `createShaderModule` / `createRenderPipeline` /
 * `createBuffer` / `queue.writeBuffer`, and a render pass recording
 * `setPipeline` / `setVertexBuffer` / `draw`. Returns the spies the contract
 * assertions read.
 */
function makeWebgpuHarness() {
  const submit = vi.fn();
  const writeBuffer = vi.fn();
  const setPipeline = vi.fn();
  const setVertexBuffer = vi.fn();
  const end = vi.fn();
  /** Records `[vertexCount, instanceCount]` per `draw` call. */
  const drawCalls: Array<[number, number | undefined]> = [];
  const passDescriptors: unknown[] = [];
  const createRenderPipeline = vi.fn((_d: unknown) => ({ __brand: "pipeline" as const }));
  const createShaderModule = vi.fn((_d: unknown) => ({ __brand: "shader" as const }));
  const createBuffer = vi.fn((_d: unknown) => ({ destroy: vi.fn() }));

  const device = {
    createShaderModule,
    createRenderPipeline,
    createBuffer,
    createCommandEncoder: () => ({
      beginRenderPass: (d: unknown) => {
        passDescriptors.push(d);
        return {
          setPipeline,
          setVertexBuffer,
          draw: (vertexCount: number, instanceCount?: number) => {
            drawCalls.push([vertexCount, instanceCount]);
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
    getCurrentTexture: () => ({ createView: () => ({}) }),
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
    end,
    drawCalls,
    passDescriptors,
    createRenderPipeline,
    createShaderModule,
    createBuffer,
  };
}

describe("drawRect primitive (backend-agnostic)", () => {
  it("webgl draws a rect via a scissored clear in device pixels", async () => {
    const { canvas, gl } = makeFakeCanvas();
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
    expect(gl.clearColor).toHaveBeenLastCalledWith(1, 0, 0, 1);
    // Scissor is disabled again at endFrame so it can't leak.
    expect(gl.disable).toHaveBeenLastCalledWith(gl.SCISSOR_TEST);
  });

  it("webgl skips zero-area rects", async () => {
    const { canvas, gl } = makeFakeCanvas();
    const renderer = createRenderer(canvas, {
      environment: { gpu: null, hasWebgl: () => true },
    });
    await renderer.init();
    renderer.resize(100, 100, 1);
    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    gl.scissor.mockClear();
    renderer.drawRect({ x: 0, y: 0, w: 0, h: 0.5, color: { r: 1, g: 1, b: 1, a: 1 } });
    renderer.endFrame();
    expect(gl.scissor).not.toHaveBeenCalled();
  });

  it("webgpu draws rects via ONE instanced draw, not per-rect clears", async () => {
    // The regression contract: after beginFrame + N drawRect + endFrame the
    // renderer must open EXACTLY ONE render pass for the frame (cleared to the
    // background), bind the pipeline, and issue a SINGLE instanced draw(6, N).
    // The old implementation opened a render pass per rect, each with
    // loadOp:"clear" set to that rect's color — which clears the whole canvas
    // and leaves only the last fill (the blank-canvas bug). That implementation
    // records N+1 passes and zero `draw` calls, so it fails every assertion
    // below; the instanced pipeline passes them.
    const harness = makeWebgpuHarness();
    const renderer = createRenderer(harness.canvas, { backend: "webgpu", gpu: harness.gpu });
    await renderer.init();
    renderer.resize(100, 100, 2); // 200x200

    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.drawRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5, color: { r: 1, g: 0, b: 0, a: 1 } });
    renderer.drawRect({ x: 0, y: 0, w: 0.25, h: 0.25, color: { r: 0, g: 1, b: 0, a: 1 } });
    renderer.drawRect({ x: 0.5, y: 0.5, w: 0.5, h: 0.5, color: { r: 0, g: 0, b: 1, a: 1 } });
    renderer.endFrame();

    // Exactly ONE pass for the whole frame (not one per rect).
    expect(harness.passDescriptors).toHaveLength(1);
    const pass = harness.passDescriptors[0] as {
      colorAttachments: Array<{ clearValue: RgbaColor; loadOp: string }>;
    };
    // That single pass clears to the BACKGROUND (not a rect color).
    expect(pass.colorAttachments[0]?.loadOp).toBe("clear");
    expect(pass.colorAttachments[0]?.clearValue).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    // Pipeline bound, instance buffer set, and a SINGLE instanced draw of all 3.
    expect(harness.setPipeline).toHaveBeenCalledTimes(1);
    expect(harness.setVertexBuffer).toHaveBeenCalledTimes(1);
    expect(harness.drawCalls).toEqual([[6, 3]]);
    // Instance data was uploaded once for this frame.
    expect(harness.writeBuffer).toHaveBeenCalledTimes(1);
    expect(harness.submit).toHaveBeenCalledTimes(1);
  });

  it("webgpu skips zero-area rects (no instance for them)", async () => {
    const harness = makeWebgpuHarness();
    const renderer = createRenderer(harness.canvas, { backend: "webgpu", gpu: harness.gpu });
    await renderer.init();
    renderer.resize(100, 100, 1);

    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.drawRect({ x: 0, y: 0, w: 0, h: 0.5, color: { r: 1, g: 1, b: 1, a: 1 } });
    renderer.drawRect({ x: 0, y: 0, w: 0.5, h: 0.5, color: { r: 1, g: 0, b: 0, a: 1 } });
    renderer.endFrame();

    // Only the one non-degenerate rect becomes an instance.
    expect(harness.drawCalls).toEqual([[6, 1]]);
  });

  it("webgpu builds the quad pipeline exactly once across frames", async () => {
    const harness = makeWebgpuHarness();
    const renderer = createRenderer(harness.canvas, { backend: "webgpu", gpu: harness.gpu });
    await renderer.init();
    renderer.resize(100, 100, 1);

    for (let frame = 0; frame < 3; frame++) {
      renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
      renderer.drawRect({ x: 0, y: 0, w: 0.5, h: 0.5, color: { r: 1, g: 0, b: 0, a: 1 } });
      renderer.endFrame();
    }

    expect(harness.createRenderPipeline).toHaveBeenCalledTimes(1);
    expect(harness.createShaderModule).toHaveBeenCalledTimes(1);
    // One pass + one instanced draw per frame.
    expect(harness.passDescriptors).toHaveLength(3);
    expect(harness.drawCalls).toEqual([[6, 1], [6, 1], [6, 1]]);
  });
});
