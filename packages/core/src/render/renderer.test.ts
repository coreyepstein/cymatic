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
    const submit = vi.fn();
    const end = vi.fn();
    const passDescriptors: unknown[] = [];
    const device = {
      createCommandEncoder: () => ({
        beginRenderPass: (d: unknown) => {
          passDescriptors.push(d);
          return { end };
        },
        finish: () => ({}),
      }),
      queue: { submit },
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

    const renderer = createRenderer(canvas, { backend: "webgpu", gpu });
    // EXACT same preset path as the webgl case.
    await runSmokePreset(renderer);

    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(960);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    const desc = passDescriptors[0] as {
      colorAttachments: Array<{ clearValue: { r: number; g: number; b: number; a: number } }>;
    };
    expect(desc.colorAttachments[0]?.clearValue).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
  });
});

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

  it("webgpu draws a rect via a scissored load-pass", async () => {
    const submit = vi.fn();
    const scissorCalls: number[][] = [];
    const passDescriptors: unknown[] = [];
    const device = {
      createCommandEncoder: () => ({
        beginRenderPass: (d: unknown) => {
          passDescriptors.push(d);
          return {
            setScissorRect: (x: number, y: number, w: number, h: number) =>
              scissorCalls.push([x, y, w, h]),
            end: vi.fn(),
          };
        },
        finish: () => ({}),
      }),
      queue: { submit },
    };
    const gpuCtx = {
      configure: vi.fn(),
      getCurrentTexture: () => ({ createView: () => ({}) }),
    };
    const canvas: RenderCanvasLike = {
      width: 0,
      height: 0,
      getContext: (id: string) => (id === "webgpu" ? gpuCtx : null),
    };
    const gpu = {
      requestAdapter: () => Promise.resolve({ requestDevice: () => Promise.resolve(device) }),
      getPreferredCanvasFormat: () => "bgra8unorm",
    };
    const renderer = createRenderer(canvas, { backend: "webgpu", gpu });
    await renderer.init();
    renderer.resize(100, 100, 2); // 200x200

    renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
    renderer.drawRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5, color: { r: 1, g: 0, b: 0, a: 1 } });
    renderer.endFrame();

    // device px: x=50, y=50, w=100, h=100
    expect(scissorCalls).toEqual([[50, 50, 100, 100]]);
    // The rect pass clears just its region to the fill color.
    const rectPass = passDescriptors[1] as {
      colorAttachments: Array<{ clearValue: RgbaColor; loadOp: string }>;
    };
    expect(rectPass.colorAttachments[0]?.clearValue).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
