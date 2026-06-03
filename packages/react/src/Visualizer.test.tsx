// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AnalyserOptions,
  AudioFeatureFrame,
  DirectorState,
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
    // The hook creates its renderer through the core's graceful-fallback helper.
    // Mock it (not the lower-level createRenderer) so jsdom needs no real
    // GPU/WebGL: by default it returns an initialized fake WebGL renderer. The
    // helper's own WebGPU→WebGL fallback logic is unit-tested in @cymatic/core.
    createRendererWithFallback: vi.fn(async () => {
      const r = makeFakeRenderer();
      await r.init();
      return r;
    }),
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
import { createRendererWithFallback } from "@cymatic/core";

const mockCreateRendererWithFallback = vi.mocked(createRendererWithFallback);

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

  it("emits director state per frame; toggling off yields a resting state", async () => {
    // With the director enabled, the per-frame callback receives an evolving
    // DirectorState; disabling it yields the resting state (intensity 0).
    const preset = makeStubPreset();
    const onDirectorState = vi.fn();
    const { rerender } = render(
      <Visualizer preset={preset} microphone onDirectorState={onDirectorState} directorEnabled />,
    );

    await waitFor(() => {
      expect(onDirectorState).toHaveBeenCalled();
    });
    const enabledState = onDirectorState.mock.calls.at(-1)?.[0] as DirectorState;
    expect(enabledState).toHaveProperty("section");
    expect(enabledState).toHaveProperty("intensity");

    onDirectorState.mockClear();
    rerender(
      <Visualizer
        preset={preset}
        microphone
        onDirectorState={onDirectorState}
        directorEnabled={false}
      />,
    );
    await waitFor(() => {
      expect(onDirectorState).toHaveBeenCalled();
    });
    // The resting state is a calm intro: zero intensity, neutral motion.
    const restingState = onDirectorState.mock.calls.at(-1)?.[0] as DirectorState;
    expect(restingState.intensity).toBe(0);
    expect(restingState.section).toBe("intro");
  });

  it("surfaces the preset's ParamSet via the imperative ref", async () => {
    // A preset can expose a ParamSet; the hook surfaces it after init so a host
    // can drive live controls. A preset without one surfaces null.
    const fakeParamSet = { getSchema: () => [] } as unknown as Preset["paramSet"];
    const preset = { ...makeStubPreset(), paramSet: fakeParamSet };
    const ref = createRef<VisualizerRef>();
    render(<Visualizer ref={ref} preset={preset} microphone />);

    await waitFor(() => {
      expect(ref.current?.paramSet).toBe(fakeParamSet);
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

  it("mounts on the WebGL renderer the core fallback helper returns", async () => {
    // REGRESSION: WebGPU can be selected (navigator.gpu exists) yet still fail
    // in init() — null adapter on a GPU-less runner, device rejects, etc. The
    // hook delegates that recovery to `createRendererWithFallback`, which
    // transparently brings up WebGL. The hook must wire that renderer and mount
    // ready with NO surfaced error and NO unhandled rejection. (The helper's own
    // dispose-dead-WebGPU + rebuild-WebGL logic is unit-tested in @cymatic/core.)
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    // The helper returns a WebGL renderer (the post-fallback result).
    const recoveredWebgl = makeFakeRenderer(); // backend: "webgl"
    mockCreateRendererWithFallback.mockImplementationOnce(async () => {
      await recoveredWebgl.init();
      return recoveredWebgl;
    });

    const preset = makeStubPreset();
    const ref = createRef<VisualizerRef>();
    render(<Visualizer ref={ref} preset={preset} microphone />);

    // The preset inits once the (recovered) renderer is up.
    await waitFor(() => {
      expect(preset.calls.init).toBe(1);
    });

    // The hook created its renderer through the graceful-fallback helper.
    expect(mockCreateRendererWithFallback).toHaveBeenCalledTimes(1);

    // Mounted cleanly on the WebGL backend with no surfaced engine error.
    await waitFor(() => {
      expect(ref.current?.ready).toBe(true);
    });
    expect(ref.current?.error).toBeNull();

    // No unhandled rejection escaped the fallback.
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
  });

  it("surfaces an engine error when the renderer cannot come up on any backend", async () => {
    // When neither backend is usable, the helper rejects; the hook surfaces that
    // as a renderer error rather than silently rendering nothing.
    const failing = new Error("WebgpuRenderer: no GPU adapter available.");
    mockCreateRendererWithFallback.mockRejectedValueOnce(failing);

    const preset = makeStubPreset();
    const ref = createRef<VisualizerRef>();
    render(<Visualizer ref={ref} preset={preset} microphone />);

    await waitFor(() => {
      expect(ref.current?.error).toBe(failing);
    });
    // The preset never inits when the renderer never comes up.
    expect(preset.calls.init).toBe(0);
  });
});
