import { describe, expect, it, vi } from "vitest";

import { definePreset, PresetRegistry, type Preset } from "./preset.js";

function stubPreset(): Preset {
  return {
    init: vi.fn(),
    resize: vi.fn(),
    update: vi.fn(),
    dispose: vi.fn(),
  };
}

describe("definePreset", () => {
  it("trims the id and freezes the definition", () => {
    const def = definePreset({ id: "  a.b  ", name: "AB", create: stubPreset });
    expect(def.id).toBe("a.b");
    expect(Object.isFrozen(def)).toBe(true);
  });

  it("rejects an empty id", () => {
    expect(() => definePreset({ id: "   ", name: "x", create: stubPreset })).toThrow(/non-empty/);
  });

  it("each create() yields an independent instance", () => {
    const def = definePreset({ id: "x", name: "x", create: stubPreset });
    const a = def.create();
    const b = def.create();
    expect(a).not.toBe(b);
  });
});

describe("PresetRegistry", () => {
  it("registers, looks up, and instantiates by id", () => {
    const reg = new PresetRegistry();
    const def = definePreset({ id: "p1", name: "P1", create: stubPreset });
    reg.register(def);
    expect(reg.has("p1")).toBe(true);
    expect(reg.get("p1")).toBe(def);
    expect(reg.size).toBe(1);
    const instance = reg.create("p1");
    expect(typeof instance.update).toBe("function");
  });

  it("throws on duplicate id unless replace is set", () => {
    const reg = new PresetRegistry();
    reg.register(definePreset({ id: "dup", name: "a", create: stubPreset }));
    expect(() =>
      reg.register(definePreset({ id: "dup", name: "b", create: stubPreset })),
    ).toThrow(/already registered/);
    const replacement = definePreset({ id: "dup", name: "c", create: stubPreset });
    reg.register(replacement, { replace: true });
    expect(reg.get("dup")).toBe(replacement);
  });

  it("throws when instantiating an unknown id", () => {
    const reg = new PresetRegistry();
    expect(() => reg.create("nope")).toThrow(/no preset registered/);
  });

  it("lists definitions in insertion order", () => {
    const reg = new PresetRegistry();
    reg.register(definePreset({ id: "a", name: "a", create: stubPreset }));
    reg.register(definePreset({ id: "b", name: "b", create: stubPreset }));
    expect(reg.list().map((d) => d.id)).toEqual(["a", "b"]);
  });
});
