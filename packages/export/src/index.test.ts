import { describe, expect, it } from "vitest";

import { builtAgainstCore, supportedFormats, version } from "./index.js";

describe("@cymatic/export", () => {
  it("exposes a semver-shaped version", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("re-exports the core version it was built against", () => {
    expect(builtAgainstCore).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("starts with no export formats wired up", () => {
    expect(supportedFormats).toEqual([]);
  });
});
