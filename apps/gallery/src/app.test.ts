import { describe, expect, it } from "vitest";

import { version as coreVersion } from "@cymatic/core";
import { presetIds } from "@cymatic/presets";

describe("gallery app", () => {
  it("can read the core version it renders", () => {
    expect(coreVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("renders against an initially-empty preset catalog", () => {
    expect(presetIds.length).toBe(0);
  });
});
