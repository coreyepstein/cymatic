// @vitest-environment node
import { describe, expect, it } from "vitest";

/**
 * SSR-import safety. Under the `node` environment there is no `window`,
 * `document`, or `navigator`. The acceptance criterion is that importing the
 * built React surface in such a context must NOT throw — all browser access is
 * confined to effects, never module top-level or render.
 */
describe("SSR safety", () => {
  it("has no DOM globals in this environment", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
  });

  it("imports the module under Node without throwing", async () => {
    await expect(import("./index.js")).resolves.toBeDefined();
  });

  it("exposes the public surface after a Node import", async () => {
    const mod = await import("./index.js");
    // Visualizer is a forwardRef exotic component — an object, not a plain
    // function — but it must be a defined, renderable React element type.
    expect(mod.Visualizer).toBeDefined();
    expect((mod.Visualizer as { $$typeof?: symbol }).$$typeof).toBe(
      Symbol.for("react.forward_ref"),
    );
    expect(typeof mod.useVisualizer).toBe("function");
    expect(typeof mod.useAudioFeatures).toBe("function");
    expect(mod.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(mod.builtAgainstCore).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("does not invoke browser APIs merely by referencing the hook", async () => {
    // Referencing (not calling-in-render) the hook must be inert. We cannot run
    // a hook outside React, but importing + reading its identity must be safe.
    const { useVisualizer } = await import("./hooks.js");
    expect(useVisualizer.name).toBe("useVisualizer");
  });
});
