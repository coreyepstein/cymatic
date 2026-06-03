# Getting started

This guide gets a live cymatic visualizer on screen — from install to a canvas
reacting to audio. It covers both ways to feed it live audio: an `<audio>`
element and the microphone.

## Install

```sh
pnpm add @cymatic/core @cymatic/react @cymatic/presets
```

- **`@cymatic/core`** — the engine: audio + mood analysis (FFT bands, RMS,
  onset/beat detection, spectral features, `MoodVector`), the backend-agnostic
  renderer with cinematic primitives + post-FX, the auto-director, the parameter
  system, and the preset contract.
- **`@cymatic/react`** — a thin, SSR-safe React wrapper: the `<Visualizer />`
  component plus the `useVisualizer` / `useAudioFeatures` hooks.
- **`@cymatic/presets`** — the bundled preset packs. Importing it registers
  every preset into `defaultPresetRegistry` as a side effect.

For offline rendering (export to a music video), also add `@cymatic/export` —
see [offline-render.md](./offline-render.md).

## Your first visualizer

`<Visualizer />` renders and manages its own `<canvas>` and drives the engine
lifecycle (renderer, analyser, clock, resize, teardown) inside React effects.
You give it a `preset` and exactly one audio input.

Resolve a preset by id from the shared registry. Importing `@cymatic/presets`
is what registers the ids, so keep that side-effect import:

```tsx
import { Visualizer } from "@cymatic/react";
import { defaultPresetRegistry } from "@cymatic/core";
import "@cymatic/presets"; // side-effect: registers all presets by id

const preset = defaultPresetRegistry.create("colorfield.field");

export function Preview() {
  // No audio input → an idle preview that runs the render loop with empty
  // feature frames. Add an input below to make it react.
  return <Visualizer preset={preset} />;
}
```

`defaultPresetRegistry.create(id)` returns a fresh, stateful `Preset` instance.
Browse every shipped id in the [preset gallery](../README.md#preset-gallery).

## Live mode 1 — an `<audio>` element

Point the visualizer at a media URL and it creates, loads, and analyses an
`<audio>` element for you:

```tsx
<Visualizer preset={preset} src="/track.mp3" />
```

If you already manage your own `<audio>` element (e.g. with your own transport
controls), pass it — or a ref to it — instead. The visualizer taps the element
for analysis without taking over playback:

```tsx
import { useRef } from "react";
import { Visualizer } from "@cymatic/react";
import { defaultPresetRegistry } from "@cymatic/core";
import "@cymatic/presets";

export function Player() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const preset = defaultPresetRegistry.create("geometric.op-grid");

  return (
    <>
      <audio ref={audioRef} src="/track.mp3" controls />
      <Visualizer preset={preset} audioElement={audioRef} />
    </>
  );
}
```

> Browsers gate Web Audio behind a user gesture. When you pass `src`, playback
> is attempted automatically but may be blocked until the user interacts; when
> you pass your own `audioElement`, drive playback with its own controls.

## Live mode 2 — the microphone

Set `microphone` to capture live mic audio. The first render triggers a
`getUserMedia` permission prompt:

```tsx
<Visualizer preset={preset} microphone />
```

If permission is denied (or no GPU/audio backend is available), the visualizer
surfaces the error via its ref rather than throwing during render:

```tsx
import { useRef, useEffect } from "react";
import { Visualizer, type VisualizerRef } from "@cymatic/react";
import { defaultPresetRegistry } from "@cymatic/core";
import "@cymatic/presets";

export function MicVisualizer() {
  const ref = useRef<VisualizerRef>(null);
  const preset = defaultPresetRegistry.create("particle.fluid");

  useEffect(() => {
    if (ref.current?.error) {
      console.warn("visualizer setup failed:", ref.current.error);
    }
  });

  return <Visualizer ref={ref} preset={preset} microphone />;
}
```

## Reading audio features

To drive your own UI from the analysis (a level meter, beat flashes, …), pass
an `onFeatures` callback. It fires once per rendered frame with the current
`AudioFeatureFrame` and does **not** re-render your component:

```tsx
<Visualizer
  preset={preset}
  microphone
  onFeatures={(f) => {
    // f.bass / f.mid / f.treble / f.rms in [0, 1]; f.onset is a beat flag;
    // f.bands is the per-band spectrum; f.time is the frame's clock time.
  }}
/>
```

For a declarative read (re-renders each frame), use the `useVisualizer` /
`useAudioFeatures` hooks directly instead of the component.

## Cinematic effects + the auto-director

cymatic's presets are cinematic by default: a glowing, bloom-lit substrate plus
an **auto-director** that evolves the look across a whole song (building and
dropping with the music, crossfading palettes on section changes). None of this
needs extra wiring — just mount a preset with audio.

The director is **on by default**. You control it with three optional props:

```tsx
import { Visualizer } from "@cymatic/react";
import { defaultPresetRegistry } from "@cymatic/core";
import "@cymatic/presets";

const preset = defaultPresetRegistry.create("geometric.op-grid");

export function Cinematic() {
  return (
    <Visualizer
      preset={preset}
      src="/track.mp3"
      directorEnabled       // default true; set false to fall back to audio/manual params
      directorSeed={42}     // seeds the deterministic drift; change it to re-roll the look live
      onDirectorState={(d) => {
        // d.section ("intro" | "build" | … | "outro"), d.intensity, d.bloom,
        // d.motion, d.density, d.paletteBlend, d.hueRotation — for a HUD/overlay.
      }}
    />
  );
}
```

- `directorEnabled` — toggle the director without tearing down the engine. When
  off, presets fall back to their audio / manual param bindings.
- `directorSeed` — seeds the director's deterministic palette/drift generators.
  Changing it reseeds live (no teardown), so the generated look re-rolls.
- `onDirectorState` — fires once per frame with the current `DirectorState`.

> **WebGPU vs WebGL.** Cinematic post-FX (bloom, feedback trails) run on
> **WebGPU**. On the WebGL fallback the same presets render their full geometry
> and color, just without the bloom — a clean basic look. The renderer picks the
> backend for you; you can force one for testing via the `renderer` prop
> (`renderer={{ backend: "webgl" }}`).

### Live parameter controls

Every preset exposes a typed `params` schema. Read the preset's `ParamSet` off
the visualizer's `ref` to build your own controls (the gallery does exactly
this):

```tsx
import { useRef } from "react";
import { Visualizer, type VisualizerRef } from "@cymatic/react";

const ref = useRef<VisualizerRef>(null);
// After mount: ref.current?.paramSet is the active preset's ParamSet (or null).
// const schema = ref.current?.paramSet?.getSchema();
// ref.current?.paramSet?.setManual("glowIntensity", 0.9); // manual beats automation
```

## Inputs at a glance

Provide **exactly one** of these (or none for an idle preview):

| Prop                  | Source                                              |
| --------------------- | --------------------------------------------------- |
| `src="/track.mp3"`    | A media URL — an `<audio>` element is created.      |
| `audioElement={ref}`  | An existing `HTMLMediaElement` (or a ref to one).   |
| `microphone`          | Live microphone capture via `getUserMedia`.         |
| `audioBuffer={buffer}`| A decoded `AudioBuffer` (e.g. from a dropped file). |

## Next steps

- [Cinematic engine](./cinematic-engine.md) — how the substrate/post-FX, audio +
  mood analysis, director, and param layers fit together.
- [Authoring a preset](./authoring-a-preset.md) — build your own cinematic
  visuals with `composePreset`, the director palette, post-FX, and a `params`
  schema.
- [Offline render](./offline-render.md) — export a track to a music video.
- The [`apps/gallery`](../apps/gallery) app is a full working example (preset
  switcher + drag-and-drop audio + mic).
