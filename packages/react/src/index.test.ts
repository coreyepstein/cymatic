import { describe, expect, it } from "vitest";

import { builtAgainstCore, version } from "./index.js";

describe("@cymatic/react", () => {
  it("exposes a semver-shaped version", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("re-exports the core version it was built against", () => {
    expect(builtAgainstCore).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
