# Authoring a preset

A **preset** is the unit of authored visual content in cymatic. It targets the
backend-agnostic `Renderer` and the per-frame `AudioFeatureFrame` — it never
touches raw WebGPU/WebGL. Because of that, the same preset runs live on a canvas
and deterministically in the offline exporter, on whichever backend
`createRenderer` selected.

Everything below is from the public `@cymatic/core` surface (verify against
`packages/core/src/index.ts`).

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
- `update(features, time, dt)` — produce one frame from audio + time.
- `dispose()` — release resources.

The renderer draws in **normalized device coordinates**: the frame spans
`x: [0, 1]` (left→right) and `y: [0, 1]` (top→bottom), so presets are
resolution-independent and never deal in pixels. The one shape primitive every
backend implements is `drawRect({ x, y, w, h, color })`, issued between
`renderer.beginFrame(bg)` and `renderer.endFrame()`.

## A minimal preset with `composePreset`

This pulses a single full-frame rectangle with bass and flips its palette
position on each beat. Every value comes from the public primitive surface
(`band` / `mapFeature` / `palettes` / `sample`) — no GL/GPU.

```ts
import {
  composePreset,
  palettes,
  sample,
  mapFeature,
  band,
  type Layer,
} from "@cymatic/core";

// A factory so each create() gets its own (here, stateless) layer instance.
function makePulseLayer(): Layer {
  // `palettes` holds the built-in palettes (sunset / aqua / ember / mono).
  const pal = palettes.sunset;

  return {
    id: "pulse.fill",
    // `draw` is the only required hook; `init` / `resize` / `dispose` are optional.
    draw({ renderer, features }) {
      // Map bass [0,1] onto a brightness range; flash brighter on a beat.
      const bass = band(features, "bass"); // 0..1
      const t = mapFeature(bass, 0.1, 1) + (features.onset ? 0.2 : 0);
      const color = sample(pal, Math.min(1, t));

      // This layer owns the frame, so it opens and closes it itself.
      renderer.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
      renderer.drawRect({ x: 0.1, y: 0.1, w: 0.8, h: 0.8, color });
      renderer.endFrame();
    },
  };
}

export const pulse = composePreset({
  id: "custom.pulse",
  name: "Pulse",
  description: "A single rectangle that brightens with bass and flashes on a beat.",
  tags: ["custom", "geometric"],
  layers: () => [makePulseLayer()], // factory → independent state per instance
});
```

Pass `layers` as a **factory** (`() => [...]`) whenever a layer holds
per-instance state, so each `create()` gets its own. A plain array is fine for
fully stateless layers.

### Letting `composePreset` own the frame

If you give `composePreset` a `background` factory, it opens the frame to that
color before any layer draws and closes it after — so your layers only call
`drawRect` and never `beginFrame` / `endFrame`:

```ts
export const pulse = composePreset({
  id: "custom.pulse",
  name: "Pulse",
  background: () => ({ r: 0, g: 0, b: 0, a: 1 }),
  layers: () => [
    {
      id: "pulse.fill",
      draw({ renderer, features }) {
        const color = sample(palettes.sunset, band(features, "bass"));
        renderer.drawRect({ x: 0.1, y: 0.1, w: 0.8, h: 0.8, color });
      },
    },
  ],
});
```

A multi-layer preset stacks passes in draw order: a background-clearing layer
first, detail layers on top.

## Audio bindings

The `features` object handed to every `draw` is an `AudioFeatureFrame`:

- `bass` / `mid` / `treble` — grouped band energies in `[0, 1]`.
- `rms` — overall loudness in `[0, 1]`.
- `bands` — the full per-band spectrum (array, `[0, 1]`).
- `onset` — a boolean beat flag for the current frame.
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
`Smoother`, …) and the color primitives round out the toolkit: read built-in
palettes from `palettes` (`palettes.sunset` / `.aqua` / `.ember` / `.mono`),
build your own with `palette(name, stops)`, and sample/mix colors with
`sample`, `mixColor`, `withAlpha`, `rgb`, and `hex`.

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

`packages/core/src/preset/example-preset.ts` (`examplePreset`) is a complete,
tested preset built only from the public primitive surface — bass-reactive bars
over a beat-reactive background. Read it alongside this guide.
