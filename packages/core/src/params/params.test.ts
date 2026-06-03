import { describe, expect, it } from "vitest";

import { ZERO_MOOD } from "../audio/mood.js";
import type { AudioFeatureFrame } from "../audio/features.js";
import type { DirectorState } from "../director/director.js";
import { defineParams, numberRange, type ParamSchema } from "./schema.js";
import { getNumberPath } from "./bindings.js";
import { resolveParams, type ResolveContext } from "./resolve.js";
import { createParamSet, ParamSet } from "./param-set.js";

/** A neutral feature frame; override only what a test needs. */
function frame(overrides: Partial<AudioFeatureFrame> = {}): AudioFeatureFrame {
  return {
    bands: [],
    bass: 0,
    mid: 0,
    treble: 0,
    rms: 0,
    onset: false,
    spectralCentroid: 0,
    spectralRolloff: 0,
    spectralFlux: 0,
    loudnessShort: 0,
    loudnessLong: 0,
    dynamics: 0,
    tempo: 0,
    beatPhase: 0,
    onsetDensity: 0,
    mood: { ...ZERO_MOOD },
    time: 0,
    ...overrides,
  };
}

/** A resting director snapshot; override only what a test needs. */
function director(overrides: Partial<DirectorState> = {}): DirectorState {
  return {
    section: 0,
    timeInSection: 0,
    elapsed: 0,
    intensity: 0,
    motion: 1,
    bloom: 0,
    density: 1,
    contrast: 0.5,
    paletteIndex: 0,
    prevPaletteIndex: 0,
    paletteBlend: 1,
    hueRotation: 0,
    seed: 0,
    ...overrides,
  } as DirectorState;
}

/** Build a resolve context. */
function ctx(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    features: frame(),
    director: director(),
    time: 0,
    dt: 1 / 60,
    ...overrides,
  };
}

const NUMBER: ParamSchema = {
  key: "radius",
  label: "Radius",
  group: "Geometry",
  type: "number",
  default: 0.5,
  min: 0,
  max: 10,
};

describe("defineParams / schema", () => {
  it("freezes and rejects empty + duplicate keys", () => {
    expect(() => defineParams([{ ...NUMBER, key: "  " }])).toThrow(/non-empty/);
    expect(() =>
      defineParams([NUMBER, { ...NUMBER }]),
    ).toThrow(/duplicate/);
    const frozen = defineParams([NUMBER]);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen[0])).toBe(true);
  });

  it("rejects an enum with no options", () => {
    expect(() =>
      defineParams([
        { key: "mode", label: "Mode", type: "enum", default: "a", options: [] },
      ]),
    ).toThrow(/at least one option/);
  });

  it("applies number range defaults and order-corrects inverted ranges", () => {
    expect(numberRange({ key: "x", label: "x", type: "number", default: 0 })).toEqual([0, 1]);
    expect(
      numberRange({ key: "x", label: "x", type: "number", default: 0, min: 5, max: 1 }),
    ).toEqual([1, 5]);
  });
});

describe("getNumberPath", () => {
  it("reads dotted paths and guards missing/non-numeric leaves", () => {
    const root = { a: { b: 3 }, flag: true, str: "x" };
    expect(getNumberPath(root, "a.b")).toBe(3);
    expect(getNumberPath(root, "flag")).toBe(1);
    expect(getNumberPath(root, "missing.path")).toBeUndefined();
    expect(getNumberPath(root, "str")).toBeUndefined();
  });
});

describe("resolveParams — binding sources", () => {
  it("const returns the schema default when no value/binding given", () => {
    const r = resolveParams([NUMBER], {}, ctx());
    expect(r.values.radius).toBe(0.5);
  });

  it("const returns an explicit value (clamped to range)", () => {
    const r = resolveParams([NUMBER], { radius: { source: "const", value: 100 } }, ctx());
    expect(r.values.radius).toBe(10); // clamped to max
  });

  it("audio:bass tracks the frame's bass over the param range", () => {
    const schema = [NUMBER];
    const bindings = { radius: { source: "audio", path: "bass" } as const };
    const lo = resolveParams(schema, bindings, ctx({ features: frame({ bass: 0 }) }));
    const hi = resolveParams(schema, bindings, ctx({ features: frame({ bass: 1 }) }));
    expect(lo.values.radius).toBeCloseTo(0); // 0 → outMin (0)
    expect(hi.values.radius).toBeCloseTo(10); // 1 → outMax (10)
    const mid = resolveParams(schema, bindings, ctx({ features: frame({ bass: 0.5 }) }));
    expect(mid.values.radius).toBeCloseTo(5);
  });

  it("audio:mood.energy reads a nested feature path", () => {
    const r = resolveParams(
      [NUMBER],
      { radius: { source: "audio", path: "mood.energy" } },
      ctx({ features: frame({ mood: { ...ZERO_MOOD, energy: 0.5 } }) }),
    );
    expect(r.values.radius).toBeCloseTo(5);
  });

  it("director:intensity tracks the director state", () => {
    const bindings = { radius: { source: "director", path: "intensity" } as const };
    const r = resolveParams([NUMBER], bindings, ctx({ director: director({ intensity: 0.25 }) }));
    expect(r.values.radius).toBeCloseTo(2.5);
  });

  it("lfo oscillates with time", () => {
    const schema: ParamSchema[] = [
      { key: "x", label: "x", type: "number", default: 0, min: 0, max: 1 },
    ];
    const bindings = { x: { source: "lfo", shape: "sine", rate: 1 } as const };
    // sine at phase 0 → 0.5; at quarter cycle (t=0.25, rate=1) → 1.0; half → 0.5.
    const a = resolveParams(schema, bindings, ctx({ time: 0 }));
    const b = resolveParams(schema, bindings, ctx({ time: 0.25 }));
    const c = resolveParams(schema, bindings, ctx({ time: 0.5 }));
    expect(a.values.x).toBeCloseTo(0.5, 5);
    expect(b.values.x).toBeCloseTo(1.0, 5);
    expect(c.values.x).toBeCloseTo(0.5, 5);
  });

  it("random is seed-reproducible and holds by default", () => {
    const schema: ParamSchema[] = [
      { key: "x", label: "x", type: "number", default: 0, min: 0, max: 1 },
    ];
    const bindings = { x: { source: "random", seed: 12345 } as const };
    const r1 = resolveParams(schema, bindings, ctx());
    const r2 = resolveParams(schema, bindings, ctx());
    // Same seed, same first sample.
    expect(r1.values.x).toBe(r2.values.x);
    // Sample-and-hold: next frame (threading state) keeps the held value.
    const held = resolveParams(schema, bindings, ctx(), r1.state);
    expect(held.values.x).toBe(r1.values.x);
  });

  it("random everyFrame advances deterministically", () => {
    const schema: ParamSchema[] = [
      { key: "x", label: "x", type: "number", default: 0, min: 0, max: 1 },
    ];
    const bindings = { x: { source: "random", seed: 7, everyFrame: true } as const };
    const r1 = resolveParams(schema, bindings, ctx());
    const r2 = resolveParams(schema, bindings, ctx(), r1.state);
    expect(r2.values.x).not.toBe(r1.values.x);
    // Re-running from the same starting state reproduces the same sequence.
    const r2b = resolveParams(schema, bindings, ctx(), r1.state);
    expect(r2b.values.x).toBe(r2.values.x);
  });
});

describe("resolveParams — manual override beats auto", () => {
  it("returns the manual value while bound manual, even with a live source", () => {
    const schema = [NUMBER];
    // Manual wins regardless of audio context.
    const r = resolveParams(
      schema,
      { radius: { source: "manual", value: 3 } },
      ctx({ features: frame({ bass: 1 }) }),
    );
    expect(r.values.radius).toBe(3);
  });

  it("ParamSet: manual overrides audio until re-bound to auto", () => {
    const set = new ParamSet([NUMBER], {
      bindings: { radius: { source: "audio", path: "bass" } },
    });
    // Auto first.
    expect(set.resolve(ctx({ features: frame({ bass: 1 }) })).radius).toBeCloseTo(10);
    // Manual override.
    set.setManual("radius", 2);
    expect(set.resolve(ctx({ features: frame({ bass: 1 }) })).radius).toBe(2);
    // Re-bind to auto → tracks audio again.
    set.bind("radius", { source: "audio", path: "bass" });
    expect(set.resolve(ctx({ features: frame({ bass: 0.5 }) })).radius).toBeCloseTo(5);
  });
});

describe("resolveParams — smoothing", () => {
  it("moves the resolved value gradually after a step in the source", () => {
    const schema = [NUMBER];
    const bindings = {
      radius: { source: "audio", path: "bass", smoothing: 0.8 } as const,
    };
    // Settle at 0.
    let state = resolveParams(schema, bindings, ctx({ features: frame({ bass: 0 }) })).state;
    // Step bass to 1; the resolved value should rise gradually, not jump to 10.
    const f1 = resolveParams(schema, bindings, ctx({ features: frame({ bass: 1 }) }), state);
    expect(f1.values.radius).toBeGreaterThan(0);
    expect(f1.values.radius).toBeLessThan(10);
    state = f1.state;
    const f2 = resolveParams(schema, bindings, ctx({ features: frame({ bass: 1 }) }), state);
    // Still climbing toward 10.
    expect(f2.values.radius).toBeGreaterThan(f1.values.radius as number);
    expect(f2.values.radius).toBeLessThan(10);
  });
});

describe("resolveParams — types & mapping", () => {
  it("enum resolves a const string and an audio number selects by index", () => {
    const schema: ParamSchema[] = [
      {
        key: "mode",
        label: "Mode",
        type: "enum",
        default: "a",
        options: [{ value: "a" }, { value: "b" }, { value: "c" }],
      },
    ];
    expect(
      resolveParams(schema, { mode: { source: "const", value: "b" } }, ctx()).values.mode,
    ).toBe("b");
    // Numeric source maps [0,1] across 3 options: 0→a, 0.5→b, ~1→c.
    expect(
      resolveParams(schema, { mode: { source: "audio", path: "bass" } }, ctx({ features: frame({ bass: 0 }) })).values.mode,
    ).toBe("a");
    expect(
      resolveParams(schema, { mode: { source: "director", path: "intensity" } }, ctx({ director: director({ intensity: 0.5 }) })).values.mode,
    ).toBe("b");
    expect(
      resolveParams(schema, { mode: { source: "director", path: "intensity" } }, ctx({ director: director({ intensity: 1 }) })).values.mode,
    ).toBe("c");
  });

  it("color resolves const/manual strings and falls back to default for auto", () => {
    const schema: ParamSchema[] = [
      { key: "tint", label: "Tint", type: "color", default: "#000000" },
    ];
    expect(
      resolveParams(schema, { tint: { source: "const", value: "#ff8800" } }, ctx()).values.tint,
    ).toBe("#ff8800");
    expect(
      resolveParams(schema, { tint: { source: "manual", value: "#abcdef" } }, ctx()).values.tint,
    ).toBe("#abcdef");
    // Auto source on a color is not meaningful → default.
    expect(
      resolveParams(schema, { tint: { source: "audio", path: "bass" } }, ctx({ features: frame({ bass: 1 }) })).values.tint,
    ).toBe("#000000");
  });

  it("explicit outMin/outMax range mapping overrides the param range", () => {
    const r = resolveParams(
      [NUMBER],
      { radius: { source: "audio", path: "bass", outMin: 100, outMax: 200 } },
      ctx({ features: frame({ bass: 0.5 }) }),
    );
    expect(r.values.radius).toBeCloseTo(150);
  });

  it("missing audio path falls back to the schema default", () => {
    const r = resolveParams(
      [NUMBER],
      { radius: { source: "audio", path: "does.not.exist" } },
      ctx(),
    );
    expect(r.values.radius).toBe(0.5);
  });
});

describe("ParamSet — introspection & controller API", () => {
  it("getSchema/getResolved reflect declared params + live values", () => {
    const set = createParamSet([NUMBER], {
      bindings: { radius: { source: "audio", path: "bass" } },
    });
    expect(set.getSchema().map((s) => s.key)).toEqual(["radius"]);
    // Before resolve(), resolved values are the declared defaults.
    expect(set.getResolved().radius).toBe(0.5);
    expect(set.get("radius")).toBe(0.5);
    // After resolve(), live values reflect the bound source.
    set.resolve(ctx({ features: frame({ bass: 1 }) }));
    expect(set.getResolved().radius).toBeCloseTo(10);
    expect(set.get("radius")).toBeCloseTo(10);
    // Bindings introspectable.
    expect(set.getBinding("radius")).toEqual({ source: "audio", path: "bass" });
  });

  it("throws on unknown param keys", () => {
    const set = createParamSet([NUMBER]);
    expect(() => set.get("nope")).toThrow(/unknown param/);
    expect(() => set.setManual("nope", 1)).toThrow(/unknown param/);
    expect(() => set.bind("nope", { source: "const" })).toThrow(/unknown param/);
  });

  it("unbind reverts a param to its default", () => {
    const set = createParamSet([NUMBER], {
      bindings: { radius: { source: "const", value: 7 } },
    });
    expect(set.resolve(ctx()).radius).toBe(7);
    set.unbind("radius");
    expect(set.resolve(ctx()).radius).toBe(0.5);
    expect(set.getBinding("radius")).toBeUndefined();
  });
});
