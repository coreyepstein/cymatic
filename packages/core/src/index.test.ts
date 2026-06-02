import { describe, expect, it } from "vitest";

import { name, version } from "./index.js";

describe("@cymatic/core", () => {
  it("exposes a semver-shaped version", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exposes its package name", () => {
    expect(name).toBe("@cymatic/core");
  });
});
