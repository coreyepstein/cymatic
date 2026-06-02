import { describe, expect, it } from "vitest";

import { version as coreVersion } from "@cymatic/core";
import { allPresets, presetIds } from "@cymatic/presets";

import { buildSnippet, presetIdentifier } from "./snippet.js";

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

  it("exposes a definition for every catalog id (used by the sidebar)", () => {
    // The gallery sidebar lists allPresets and switches by id; each definition
    // must carry a name and a working factory so a live switch can instantiate.
    expect(allPresets.length).toBe(presetIds.length);
    for (const def of allPresets) {
      expect(def.name.length).toBeGreaterThan(0);
      expect(typeof def.create).toBe("function");
    }
  });
});

describe("install/usage snippet", () => {
  it("references the selected preset id", () => {
    const id = presetIds[0]!;
    const snippet = buildSnippet(id);
    expect(snippet).toContain(`defaultPresetRegistry.create("${id}")`);
    expect(snippet).toContain("npm i @cymatic/react @cymatic/presets");
    expect(snippet).toContain("import { Visualizer }");
  });

  it("derives a safe identifier from a dotted/hyphenated preset id", () => {
    expect(presetIdentifier("geometric.op-grid")).toBe("geometricOpGrid");
    expect(presetIdentifier("")).toBe("preset");
  });
});
