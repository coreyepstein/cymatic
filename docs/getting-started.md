# Getting started

This guide gets a live cymatic visualizer on screen — from install to a canvas
reacting to audio. It covers both ways to feed it live audio: an `<audio>`
element and the microphone.

## Install

```sh
pnpm add @cymatic/core @cymatic/react @cymatic/presets
```

- **`@cymatic/core`** — the engine: audio analysis (FFT bands, RMS, onset/beat
  detection), the backend-agnostic renderer, primitives, and the preset
  contract.
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

## Inputs at a glance

Provide **exactly one** of these (or none for an idle preview):

| Prop                  | Source                                              |
| --------------------- | --------------------------------------------------- |
| `src="/track.mp3"`    | A media URL — an `<audio>` element is created.      |
| `audioElement={ref}`  | An existing `HTMLMediaElement` (or a ref to one).   |
| `microphone`          | Live microphone capture via `getUserMedia`.         |
| `audioBuffer={buffer}`| A decoded `AudioBuffer` (e.g. from a dropped file). |

## Next steps

- [Authoring a preset](./authoring-a-preset.md) — build your own visuals with
  `definePreset` / `composePreset` and the primitives.
- [Offline render](./offline-render.md) — export a track to a music video.
- The [`apps/gallery`](../apps/gallery) app is a full working example (preset
  switcher + drag-and-drop audio + mic).
