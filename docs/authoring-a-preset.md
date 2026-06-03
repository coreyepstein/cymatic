# Authoring a preset

A **preset** is the unit of authored visual content in cymatic. It targets the
backend-agnostic `Renderer` and the per-frame `AudioFeatureFrame` — it never
touches raw WebGPU/WebGL. Because of that, the same preset runs live on a canvas
and deterministically in the offline exporter, on whichever backend
`createRenderer` selected.

A v2 (cinematic) preset goes further than reacting to instantaneous audio: it
reads the **auto-director's** `DirectorState` to evolve over a whole track,
declares a **`params` schema** of tunable knobs with default bindings, samples
color from the **director palette**, and uses the cinematic primitives
(`drawGradientRect` / `drawGlow` / `drawLine` / `setBlendMode`) plus
`setPostEffects` (bloom / feedback). All of that is optional and
backward-compatible — a preset that ignores it behaves exactly as before.

Everything below is from the public `@cymatic/core` surface (verify against
`packages/core/src/index.ts`). For the big picture of how the four layers fit
together, read [cinematic-engine.md](./cinematic-engine.md) first.

## The two authoring paths

- **`composePreset`** — the high-leverage path. You list one or more **layers**
  (render passes) and get a registry-ready `PresetDefinition` with correct
  lifecycle wiring for free. Prefer this.
- **`definePreset`** — the low-level path. You provide a `create()` factory that
  returns a raw `Preset` implementing `init` / `resize` / `update` / `dispose`
  yourself. `composePreset` is built on top of it.

Both return a `PresetDefinition`: inert metadata plus a `create()` factory.
Register the definition so hosts can resolve it by id.

## The lifecycle

A `Preset` mirrors the renderer lifecycle:

- `init(ctx)` — one-time setup; `ctx` is `{ renderer, width, height, dpr }`.
- `resize(width, height, dpr)` — backing store resized (device pixels + DPR).
- `update(features, time, dt, frameContext?)` — produce one frame. The optional
  4th arg is a `PresetFrameContext` — `{ director?, params? }` — threaded in by
  the host (the React layer / exporter) so cinematic presets can read the
  director's macro state and any pre-resolved params. Omitting it is fine; the
  preset just falls back to a resting director state.
- `dispose()` — release resources.

A preset that uses `composePreset` (below) never implements `update` by hand —
each layer's `draw` receives the resolved `director` and `params` for the frame
directly.

The renderer draws in **normalized device coordinates**: the frame spans
`x: [0, 1]` (left→right) and `y: [0, 1]` (top→bottom), so presets are
resolution-independent and never deal in pixels. Between
`renderer.beginFrame(bg)` and `renderer.endFrame()` the backends implement:

- `drawRect({ x, y, w, h, color })` — a filled rectangle.
- `drawGradientRect(rect, fill)` — a linear or radial color ramp.
- `drawGlow({ x, y, radius, color, intensity? })` — a soft, feathered
  **additive** light blob (the workhorse for particles / light).
- `drawLine({ x0, y0, x1, y1, width, color })` — a stroked segment.
- `setBlendMode("alpha" | "additive")` — sets blending for subsequent
  `drawRect` / `drawGradientRect` / `drawLine` (`drawGlow` is always additive).

Colors are `RgbaColor` with channels nominally in `[0, 1]`; values **above 1**
are allowed (HDR) so a glow blooms on WebGPU.

## A minimal cinematic preset with `composePreset`

This draws a single glowing orb that pulses with bass, brightens on the beat,
and — crucially — **samples its color from the director's crossfading palette**
and turns **bloom** on so it actually glows. It declares two `params` (glow and
bloom) with default bindings to the director, so it both evolves over a song and
is live-tweakable in the gallery. Every value comes from the public
`@cymatic/core` surface — no GL/GPU.

```ts
import {
  composePreset,
  clamp01,
  band,
  mapFeature,
  sampleBlended,
  rotateHue,
  PALETTE_CATALOG,
  type DirectorState,
  type Layer,
  type RgbaColor,
} from "@cymatic/core";

// Sample one evolving color from the director: crossfade the two palettes by
// `paletteBlend`, then rotate hue by `hueRotation` (turns → degrees).
function directorColor(d: DirectorState, t: number): RgbaColor {
  const n = PALETTE_CATALOG.length;
  const from = PALETTE_CATALOG[d.prevPaletteIndex % n]!;
  const to = PALETTE_CATALOG[d.paletteIndex % n]!;
  const base = sampleBlended(from, to, clamp01(d.paletteBlend), clamp01(t));
  return rotateHue(base, d.hueRotation * 360);
}

// A factory so each create() gets its own layer instance (state-free here).
function makeOrbLayer(): Layer {
  return {
    id: "orb.glow",
    // `draw` receives the resolved director + params for this frame.
    draw({ renderer, features, director, params }) {
      const glow = clamp01(Number(params.glow ?? 0.6));
      const bloom = clamp01(Number(params.bloom ?? director.bloom));

      // Cinematic post-FX: bloom scaled by the song, a light feedback trail,
      // and a subtle vignette. WebGPU honours these; WebGL no-ops them.
      renderer.setPostEffects({
        exposure: 1.05,
        bloom: { enabled: true, threshold: 0.65, intensity: 0.4 + bloom, radius: 1.4 },
        vignette: { enabled: true, amount: 0.3 },
        feedback: { enabled: true, decay: 0.85 },
      });

      // A deep, palette-tinted void rather than flat black.
      const voidColor = directorColor(director, 0.05);
      renderer.beginFrame({ r: voidColor.r * 0.1, g: voidColor.g * 0.1, b: voidColor.b * 0.12, a: 1 });

      // The orb: size from bass + the director's intensity, brightness pushed
      // into HDR (intensity > 1) on the beat so bloom blooms it.
      const bass = band(features, "bass");
      const size = mapFeature(clamp01(bass * 0.6 + director.intensity * 0.5), 0.1, 0.4);
      const beat = features.onset ? 1.6 : 1;
      renderer.drawGlow({
        x: 0.5,
        y: 0.5,
        radius: size,
        color: directorColor(director, 0.75),
        intensity: (0.6 + glow * 1.6 + director.intensity) * beat,
      });

      renderer.endFrame();
    },
  };
}

export const orb = composePreset({
  id: "custom.orb",
  name: "Orb",
  description: "A glowing orb that pulses with bass and crossfades color over the track.",
  tags: ["custom", "color-field", "cinematic"],
  // Declared knobs the gallery auto-renders as controls.
  params: [
    { key: "glow", label: "Glow", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: "bloom", label: "Bloom", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
  ],
  // Default bindings: both build with the song via the director's macro signals.
  bindings: {
    glow: { source: "director", path: "intensity", outMin: 0.3, outMax: 1, smoothing: 0.6 },
    bloom: { source: "director", path: "bloom", smoothing: 0.6 },
  },
  layers: () => [makeOrbLayer()], // factory → independent state per instance
});
```

Pass `layers` as a **factory** (`() => [...]`) whenever a layer holds
per-instance state, so each `create()` gets its own. A plain array is fine for
fully stateless layers.

### What each `draw` receives

`composePreset` hands every layer a `LayerFrame`:

- `renderer` — the backend-agnostic renderer (a frame is already open if you set
  a `background` factory; otherwise call `beginFrame` / `endFrame` yourself).
- `features` — the current `AudioFeatureFrame`.
- `director` — the resolved `DirectorState` for this frame. **Always present**:
  the host's live director when running, or a deterministic
  `restingDirectorState` otherwise, so you can read `director.*` unconditionally.
- `params` — resolved param values keyed by your schema's keys (empty when no
  `params` were declared).
- `time` / `dt` / `width` / `height` / `paramSet`.

### Letting `composePreset` own the frame

If you give `composePreset` a `background` factory, it opens the frame to that
color before any layer draws and closes it after — so your layers only issue
draw primitives and never `beginFrame` / `endFrame`. The factory receives the
resolved `LayerFrame`, so the background can itself evolve with the director:

```ts
export const orb = composePreset({
  id: "custom.orb",
  name: "Orb",
  background: (_features, _time, frame) => {
    const c = directorColor(frame!.director, 0.05);
    return { r: c.r * 0.1, g: c.g * 0.1, b: c.b * 0.12, a: 1 };
  },
  layers: () => [
    {
      id: "orb.glow",
      draw({ renderer, director }) {
        renderer.drawGlow({ x: 0.5, y: 0.5, radius: 0.25, color: directorColor(director, 0.75), intensity: 1.4 });
      },
    },
  ],
});
```

A multi-layer preset stacks passes in draw order: a background-clearing layer
first, detail layers on top.

## The `params` schema and bindings

A preset declares its tunable knobs as `params` and wires each to a default
`binding`. The schema is inert and introspectable, so the gallery auto-renders a
control panel from it without running the preset, and a host can re-bind or set
manual overrides live through the per-instance `ParamSet`.

Schema entry types (`ParamSchema`):

- `{ type: "number", min?, max?, step?, default }` — a numeric slider.
- `{ type: "color", default }` — a CSS-style color string.
- `{ type: "enum", options: [{ value, label? }], default }` — a fixed choice.

Each key's `binding` (`ParamBinding`) says where the value comes from each frame:

- `{ source: "const", value? }` — fixed (defaults to the schema default).
- `{ source: "audio", path }` — a dotted feature path (`"bass"`,
  `"mood.energy"`, `"spectralCentroid"`).
- `{ source: "director", path }` — a dotted director path (`"intensity"`,
  `"bloom"`, `"motion"`, `"paletteBlend"`).
- `{ source: "lfo", shape?, rate?, depth? }` — a deterministic oscillator on `dt`.
- `{ source: "random", seed?, everyFrame?, intervalSeconds? }` — seeded randomness.
- `{ source: "manual", value }` — an explicit value that **overrides** automation.

Numeric `audio` / `director` / `lfo` / `random` bindings also accept
`smoothing` (EMA) and an `inMin/inMax → outMin/outMax` range map. Manual
overrides always beat automation; re-`bind`ing to an auto source clears them.

## Audio bindings

The `features` object handed to every `draw` is an `AudioFeatureFrame`:

- `bass` / `mid` / `treble` — grouped band energies in `[0, 1]`.
- `rms` — overall loudness in `[0, 1]`.
- `bands` — the full per-band spectrum (array, `[0, 1]`).
- `onset` — a boolean beat flag for the current frame.
- `spectralCentroid` / `spectralRolloff` / `spectralFlux` — spectral shape and
  rate-of-change, each normalized.
- `loudnessShort` / `loudnessLong` / `dynamics` — the punchy-vs-sustained
  envelope.
- `tempo` / `beatPhase` / `onsetDensity` — beat-grid awareness.
- `mood` — a smoothed `MoodVector` (`energy`, `brightness`, `busyness`,
  `valence`, `dynamics`), each in `[0, 1]`.
- `time` — the frame's clock time in seconds.

The `bindings` primitives turn that frame into reactive values:

- `band(features, "bass" | "mid" | "treble")` and `bandAt(features, i)` — read a
  grouped or indexed band.
- `level(features)` — overall loudness.
- `mapFeature(value, lo, hi)` — map a `[0, 1]` feature into a target range.
- `onBeat(features, cb)` — run `cb` when `features.onset` is set; returns the
  flag. (Read `features.onset` directly when you just want the boolean.)
- `smoothBand(name, smoothing)` returns a `BandSmoother` whose `.push(features)`
  applies exponential smoothing — keep one **per instance** for jitter-free
  motion (store it in a layer closure, as the reference preset does).

For motion, the `easing` primitives (`easeOutCubic`, `lerp`, `mapRange`,
`Smoother`, …) and the color primitives round out the toolkit. The cinematic
palette catalog is `PALETTE_CATALOG` (ordered, matching `PALETTE_NAMES` and the
director's index space) — e.g. `ember`, `nocturne`, `aurora`, `ultraviolet`,
`ice`, `neon` — and the originals stay on the `palettes` map (`palettes.sunset`
/ `.aqua` / `.mono`). Build your own with `palette(name, stops)`, and
sample/mix/transform colors with `sample`, `sampleRamp`, `sampleBlended`,
`blendPalettes`, `rotateHue`, `mixColor`, `withAlpha`, `rgb`, and `hex`.

## Color from the director

Sampling color from the `DirectorState` is what makes color **evolve over a
track**. The director crossfades between two catalog palettes by `paletteBlend`
on section changes and slowly rotates hue by `hueRotation` (in turns). The
`directorColor` helper in the example above (`sampleBlended` of the two palettes,
then `rotateHue`) is the canonical pattern — every shipped preset uses it (see
the `directorColor` export in each pack's `common.ts`).

## Cinematic post-FX

Drive the post-processing chain from a layer with `renderer.setPostEffects(cfg)`.
It is a **partial merge** — only the keys you pass change — so it is cheap to
call every frame and scale, say, `bloom.intensity` by the director:

```ts
renderer.setPostEffects({
  exposure: 1.05,
  bloom: { enabled: true, threshold: 0.65, intensity: 0.4 + director.bloom, radius: 1.4 },
  vignette: { enabled: true, amount: 0.32 },
  feedback: { enabled: true, decay: 0.9 }, // luminous motion trails
});
```

These run on **WebGPU** (the scene routes through an HDR target so bright,
additive draws bloom); on **WebGL** they no-op to a clean basic look. Use
`setBlendMode("additive")` + `drawGlow` with `intensity > 1` to feed the bloom.

## The low-level path: `definePreset`

When you need full control of the loop, implement `Preset` directly:

```ts
import { definePreset, type Preset, band } from "@cymatic/core";

export const raw = definePreset({
  id: "custom.raw",
  name: "Raw",
  create(): Preset {
    return {
      init() {},
      resize() {},
      update(features) {
        // You own beginFrame/endFrame here; draw via the renderer captured in init().
        void band(features, "bass");
      },
      dispose() {},
    };
  },
});
```

`composePreset` is just this with the frame + layer wiring done for you, so
reach for `definePreset` only when the layer model gets in your way.

## Registering and resolving

A `PresetDefinition` is inert until registered. Register into the shared default
registry (or your own `PresetRegistry` for isolation):

```ts
import { defaultPresetRegistry } from "@cymatic/core";
import { pulse } from "./pulse.js";

defaultPresetRegistry.register(pulse); // throws on a duplicate id unless { replace: true }

const instance = defaultPresetRegistry.create("custom.pulse"); // a fresh Preset
```

For a reusable pack, follow `@cymatic/presets`: export your definitions and a
`registerX(registry, options)` helper, then register on import as a side effect.

## Naming guardrail

Preset ids and names must reference **movements, styles, or techniques** — never
trademarks or living artists. See [CONTRIBUTING.md](../CONTRIBUTING.md#preset-naming)
for the rule and examples.

## A real reference

`packages/presets/src/geometric/op-grid.ts` (`opGridPreset`) is a complete,
tested **cinematic** preset: gradient-filled tiles that glow, additive cores
that pulse on the beat, color sampled from the director's crossfading palette,
bloom + feedback via `setPostEffects`, and a full `params` schema with
audio/director bindings. Its shared helpers live in
`packages/presets/src/geometric/common.ts` (`directorColor`, `geometricPostFx`,
`hot`, `BeatFlash`). Read both alongside this guide.

For the simplest possible primitive-only preset (no director / params),
`packages/core/src/preset/example-preset.ts` (`examplePreset`) is bass-reactive
bars over a beat-reactive background.
