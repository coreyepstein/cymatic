import { describe, expect, it } from "vitest";

import { version as coreVersion } from "@cymatic/core";
import { presetIds } from "@cymatic/presets";

describe("gallery app", () => {
  it("can read the core version it renders", () => {
    expect(coreVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("renders against the shipped preset catalog", () => {
    // The presets package now ships a populated catalog (US-006+); every entry
    // must be a non-empty id and ids must be unique.
    expect(presetIds.length).toBeGreaterThan(0);
    expect(presetIds.every((id) => id.length > 0)).toBe(true);
    expect(new Set(presetIds).size).toBe(presetIds.length);
  });
});
