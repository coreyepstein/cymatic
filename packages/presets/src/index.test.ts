import { describe, expect, it } from "vitest";

import { builtAgainstCore, presetIds, version } from "./index.js";

describe("@cymatic/presets", () => {
  it("exposes a semver-shaped version", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("re-exports the core version it was built against", () => {
    expect(builtAgainstCore).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("starts with an empty preset catalog", () => {
    expect(presetIds).toEqual([]);
  });
});
