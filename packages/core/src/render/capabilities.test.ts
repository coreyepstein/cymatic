import { describe, expect, it } from "vitest";

import { selectBackend, type RendererEnvironment } from "./capabilities.js";

/** A fake `navigator.gpu` — presence of `requestAdapter` is all that matters. */
const fakeGpu = { requestAdapter: () => Promise.resolve(null) };

describe("selectBackend", () => {
  it("selects webgpu when a gpu entrypoint is present (preferred)", () => {
    const env: RendererEnvironment = { gpu: fakeGpu, hasWebgl: () => true };
    expect(selectBackend(env)).toBe("webgpu");
  });

  it("prefers webgpu over webgl even when both are available", () => {
    const env: RendererEnvironment = { gpu: fakeGpu, hasWebgl: () => true };
    expect(selectBackend(env)).toBe("webgpu");
  });

  it("falls back to webgl when webgpu is absent but webgl is available", () => {
    const env: RendererEnvironment = { gpu: null, hasWebgl: () => true };
    expect(selectBackend(env)).toBe("webgl");
  });

  it("returns none when neither backend is available (headless/Node)", () => {
    const env: RendererEnvironment = { gpu: null, hasWebgl: () => false };
    expect(selectBackend(env)).toBe("none");
  });

  it("treats a gpu without requestAdapter as unavailable", () => {
    const env: RendererEnvironment = {
      gpu: {} as unknown as RendererEnvironment["gpu"],
      hasWebgl: () => true,
    };
    expect(selectBackend(env)).toBe("webgl");
  });
});
