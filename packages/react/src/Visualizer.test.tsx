// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AnalyserOptions,
  AudioFeatureFrame,
  Preset,
  Renderer,
} from "@cymatic/core";

// ---------------------------------------------------------------------------
// Test doubles. jsdom has no WebGL/WebGPU, so we mock the core factory to hand
// back a fake renderer and a fake input adapter. This exercises the React
// lifecycle (init → frames → dispose) without a real GPU or AudioContext.
// ---------------------------------------------------------------------------

const rendererDispose = vi.fn();
const micStop = vi.fn();
const micDispose = vi.fn(async () => {});

function makeFakeRenderer(): Renderer {
  return {
    backend: "webgl",
    init: vi.fn(async () => {}),
    resize: vi.fn(),
    drawingBufferSize: { width: 300, height: 150 },
    render: vi.fn(),
    beginFrame: vi.fn(),
    drawRect: vi.fn(),
    endFrame: vi.fn(),
    setPostEffects: vi.fn(),
    dispose: rendererDispose,
  };
}

const fakeAnalyser = {
  analyserNode: {} as AnalyserNode,
  read: vi.fn(
    (time: number): AudioFeatureFrame => ({
      bands: [0.1, 0.2],
      bass: 0.1,
      mid: 0.2,
      treble: 0.3,
      rms: 0.4,
      onset: false,
      spectralCentroid: 0,
      spectralRolloff: 0,
      spectralFlux: 0,
      loudnessShort: 0,
      loudnessLong: 0,
      dynamics: 0,
      tempo: 0,
      beatPhase: 0,
      onsetDensity: 0,
      mood: { energy: 0, brightness: 0, busyness: 0, valence: 0, dynamics: 0 },
      time,
    }),
  ),
};

vi.mock("@cymatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cymatic/core")>();
  return {
    ...actual,
    createRenderer: vi.fn(() => makeFakeRenderer()),
    connectMicrophoneSource: vi.fn(async (_opts?: AnalyserOptions) => ({
      analyser: fakeAnalyser,
      context: {} as AudioContext,
      stream: { getTracks: () => [{ stop: micStop }] } as unknown as MediaStream,
      source: {} as MediaStreamAudioSourceNode,
      dispose: async () => {
        micStop();
        await micDispose();
      },
    })),
  };
});

/** A stub preset that records the lifecycle calls it receives. */
function makeStubPreset(): Preset & {
  calls: { init: number; resize: number; update: number; dispose: number };
} {
  const calls = { init: 0, resize: 0, update: 0, dispose: 0 };
  return {
    calls,
    init: vi.fn(() => {
      calls.init++;
    }),
    resize: vi.fn(() => {
      calls.resize++;
    }),
    update: vi.fn(() => {
      calls.update++;
    }),
    dispose: vi.fn(() => {
      calls.dispose++;
    }),
  };
}

// Import AFTER vi.mock so the component picks up the mocked core.
import { Visualizer, type VisualizerRef } from "./index.js";
import { createRenderer } from "@cymatic/core";

const mockCreateRenderer = vi.mocked(createRenderer);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("<Visualizer />", () => {
  it("mounts a canvas and runs the preset lifecycle (init + resize)", async () => {
    const preset = makeStubPreset();
    const { container } = render(<Visualizer preset={preset} microphone />);

    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();

    await waitFor(() => {
      expect(preset.calls.init).toBe(1);
    });
    // applyResize drives a preset.resize during setup.
    expect(preset.calls.resize).toBeGreaterThanOrEqual(1);
  });

  it("invokes onFeatures with frames once the clock ticks", async () => {
    const preset = makeStubPreset();
    const onFeatures = vi.fn();
    render(<Visualizer preset={preset} microphone onFeatures={onFeatures} />);

    await waitFor(() => {
      expect(onFeatures).toHaveBeenCalled();
    });
    const frame = onFeatures.mock.calls[0]?.[0] as AudioFeatureFrame;
    expect(frame).toMatchObject({ bass: 0.1, mid: 0.2 });
  });

  it("disposes renderer, stops mic, and cancels rAF on unmount", async () => {
    const cancelSpy = vi.spyOn(globalThis, "cancelAnimationFrame");
    const preset = makeStubPreset();
    const { unmount } = render(<Visualizer preset={preset} microphone />);

    await waitFor(() => {
      expect(preset.calls.init).toBe(1);
    });

    unmount();

    await waitFor(() => {
      expect(rendererDispose).toHaveBeenCalled();
    });
    expect(micStop).toHaveBeenCalled();
    expect(cancelSpy).toHaveBeenCalled();
    cancelSpy.mockRestore();
  });

  it("does not start the clock when paused, but still inits", async () => {
    const preset = makeStubPreset();
    const onFeatures = vi.fn();
    render(<Visualizer preset={preset} microphone paused onFeatures={onFeatures} />);

    await waitFor(() => {
      expect(preset.calls.init).toBe(1);
    });
    // Give any pending rAF a chance; paused means no frames should fire.
    await new Promise((r) => setTimeout(r, 30));
    expect(onFeatures).not.toHaveBeenCalled();
  });

  it("exposes ready / features via an imperative ref", async () => {
    const preset = makeStubPreset();
    const ref = createRef<VisualizerRef>();
    render(<Visualizer ref={ref} preset={preset} microphone />);

    await waitFor(() => {
      expect(ref.current?.ready).toBe(true);
    });
  });

  it("renders an idle preview with no audio input", async () => {
    const preset = makeStubPreset();
    const { container } = render(<Visualizer preset={preset} />);
    await waitFor(() => {
      expect(preset.calls.init).toBe(1);
    });
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("falls back to webgl when a webgpu renderer's init() rejects at runtime", async () => {
    // REGRESSION: WebGPU can be selected (navigator.gpu exists) yet still fail
    // in init() — adapter blocklisted, device creation rejects, etc. The hook
    // must dispose the dead WebGPU renderer and transparently rebuild forcing
    // backend "webgl", mounting successfully with no unhandled rejection and no
    // surfaced error.
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    const webgpuDispose = vi.fn();
    const failingWebgpu: Renderer = {
      ...makeFakeRenderer(),
      backend: "webgpu",
      // init rejects once — the first (webgpu) attempt.
      init: vi.fn(async () => {
        throw new Error("WebGPU device acquisition failed (adapter blocklisted)");
      }),
      dispose: webgpuDispose,
    };
    const recoveredWebgl = makeFakeRenderer(); // backend: "webgl"

    // First create() yields the failing webgpu renderer; the retry yields webgl.
    mockCreateRenderer
      .mockImplementationOnce(() => failingWebgpu)
      .mockImplementationOnce(() => recoveredWebgl);

    const preset = makeStubPreset();
    const ref = createRef<VisualizerRef>();
    render(<Visualizer ref={ref} preset={preset} microphone />);

    // The preset only inits once the (recovered) renderer is up.
    await waitFor(() => {
      expect(preset.calls.init).toBe(1);
    });

    // The dead webgpu renderer was disposed and a webgl renderer was rebuilt.
    expect(webgpuDispose).toHaveBeenCalledTimes(1);
    expect(mockCreateRenderer).toHaveBeenCalledTimes(2);
    const secondCallOpts = mockCreateRenderer.mock.calls[1]?.[1];
    expect(secondCallOpts).toMatchObject({ backend: "webgl" });

    // Mounted cleanly with no surfaced engine error.
    await waitFor(() => {
      expect(ref.current?.ready).toBe(true);
    });
    expect(ref.current?.error).toBeNull();

    // No unhandled rejection escaped the fallback.
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
  });
});
