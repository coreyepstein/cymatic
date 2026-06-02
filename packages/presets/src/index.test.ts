import { describe, expect, it } from "vitest";

import { allPresets, builtAgainstCore, presetIds, version } from "./index.js";

describe("@cymatic/presets", () => {
  it("exposes a semver-shaped version", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("re-exports the core version it was built against", () => {
    expect(builtAgainstCore).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("ships at least three presets with unique ids", () => {
    expect(allPresets.length).toBeGreaterThanOrEqual(3);
    expect(new Set(presetIds).size).toBe(presetIds.length);
  });
});
