/**
 * Renderer-backend capability detection.
 *
 * The engine supports two GPU backends — WebGPU (preferred) and WebGL (the
 * fallback). This module decides which backend is available without touching
 * any real device: it only probes for the presence of the relevant browser
 * APIs. The environment it probes is fully injectable so the selection logic is
 * deterministic and testable in Node, where neither API exists.
 */

/** The rendering backends the engine can target. */
export type RendererBackend = "webgpu" | "webgl";

/**
 * Result of {@link selectBackend}: either a usable backend, or `"none"` when
 * the environment exposes neither WebGPU nor WebGL.
 */
export type BackendSelection = RendererBackend | "none";

/**
 * Minimal structural shape of `navigator.gpu`. We intentionally avoid pulling
 * in the full `@webgpu/types` package; presence of `requestAdapter` is all the
 * selection logic needs to treat WebGPU as available.
 */
export interface GpuLike {
  requestAdapter(...args: unknown[]): unknown;
}

/**
 * Probes the environment for the WebGL backend. Defaults to creating a throwaway
 * canvas and asking for a `webgl2`/`webgl` context, but is fully injectable.
 */
export type WebglProbe = () => boolean;

/**
 * The environment {@link selectBackend} inspects. Every field is optional so an
 * empty object models a headless (Node) environment — which selects `"none"`.
 */
export interface RendererEnvironment {
  /** The WebGPU entrypoint, normally `navigator.gpu`. */
  gpu?: GpuLike | null;
  /** Returns whether a WebGL context can be created. */
  hasWebgl?: WebglProbe;
}

/**
 * Default WebGL probe: attempts to obtain a `webgl2` (then `webgl`) context from
 * a freshly created `<canvas>`. Returns `false` in any environment without a
 * working `document.createElement("canvas")` (e.g. Node).
 */
export function defaultHasWebgl(): boolean {
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    return false;
  }
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl");
    return gl != null;
  } catch {
    return false;
  }
}

/**
 * Reads the ambient browser environment into a {@link RendererEnvironment}.
 * Safe to call in Node: missing globals collapse to absent capabilities.
 */
export function detectEnvironment(): RendererEnvironment {
  const gpu =
    typeof navigator !== "undefined"
      ? ((navigator as Navigator & { gpu?: GpuLike }).gpu ?? null)
      : null;
  return { gpu, hasWebgl: defaultHasWebgl };
}

/**
 * Picks the best available backend for an environment:
 *
 *  - WebGPU when `env.gpu` is present (preferred for performance + compute),
 *  - WebGL when WebGPU is absent but a WebGL context can be created,
 *  - `"none"` when neither is available (e.g. a headless/Node environment).
 *
 * Pure and synchronous: it only inspects API presence, never instantiates a
 * device, so it is deterministic and unit-testable.
 */
export function selectBackend(env: RendererEnvironment = detectEnvironment()): BackendSelection {
  if (env.gpu != null && typeof env.gpu.requestAdapter === "function") {
    return "webgpu";
  }
  const hasWebgl = env.hasWebgl ?? defaultHasWebgl;
  if (hasWebgl()) {
    return "webgl";
  }
  return "none";
}
