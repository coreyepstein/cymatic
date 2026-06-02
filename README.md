# cymatic

[![CI](https://github.com/coreyepstein/cymatic/actions/workflows/ci.yml/badge.svg)](https://github.com/coreyepstein/cymatic/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A tasteful, open-source web audio visualizer library. cymatic turns any audio —
a media element, a live microphone, or a decoded buffer — into reactive visuals
rendered on a `<canvas>`, and can also render a track to a **music video**
offline, frame-for-frame.

<!-- A hero GIF lives at docs/media/hero.gif — to be added. -->
<!-- ![cymatic presets in motion](docs/media/hero.gif) -->

## Why cymatic

- **WebGPU with a WebGL fallback.** A single backend-agnostic `Renderer` picks
  WebGPU when available and falls back to WebGL automatically. Presets target
  the renderer and never branch on the backend.
- **Live and offline.** The same preset drives a real-time canvas (rAF clock)
  and a deterministic offline render (fixed `1/fps` clock) — so what you see
  live is what you export.
- **Agnostic core, thin React layer.** All audio analysis (FFT bands,
  RMS/loudness, onset/beat detection) and rendering live in `@cymatic/core`.
  `@cymatic/react` is a thin, SSR-safe wrapper: a `<Visualizer />` component and
  hooks, nothing more.
- **12 tasteful presets across 4 art directions.** Geometric, color-field,
  generative, and particle packs — named for movements and techniques, never
  artists or trademarks.
- **In-browser export.** Render to mp4/webm via WebCodecs when available, or to
  a PNG sequence everywhere else, then mux the original audio back on with
  ffmpeg.

## Install

```sh
pnpm add @cymatic/core @cymatic/react @cymatic/presets
```

`@cymatic/core` is the engine, `@cymatic/react` the React bindings, and
`@cymatic/presets` the bundled preset packs. For offline rendering, also add
`@cymatic/export`.

## Quick start (React)

Importing `@cymatic/presets` registers every bundled preset into the shared
`defaultPresetRegistry` as a side effect. Resolve one to a `Preset` instance by
id and hand it to `<Visualizer />`:

```tsx
import { Visualizer } from "@cymatic/react";
import { defaultPresetRegistry } from "@cymatic/core";
import "@cymatic/presets"; // side-effect: registers all presets by id

// Create a fresh, stateful instance of a preset by its id.
const preset = defaultPresetRegistry.create("geometric.op-grid");

export function MyVisualizer() {
  // `microphone` captures live mic audio. Swap for `src`, `audioElement`,
  // or `audioBuffer` to visualize other sources.
  return <Visualizer preset={preset} microphone />;
}
```

Other audio inputs (provide exactly one):

```tsx
// A media URL — an <audio> element is created, loaded, and analysed.
<Visualizer preset={preset} src="/track.mp3" />

// An existing media element (or a ref to one).
<Visualizer preset={preset} audioElement={audioRef} />

// A decoded AudioBuffer (e.g. from a dropped file).
<Visualizer preset={preset} audioBuffer={buffer} />

// No input mounts an idle preview.
<Visualizer preset={preset} />
```

## Quick start (vanilla core)

No React required. Resolve a preset, create a renderer for your canvas, wire an
analyser to an input, and drive the preset each frame with a `RealtimeClock`.
The clock advances on `requestAnimationFrame`; subscribe to read time and the
analyser's latest feature frame:

```ts
import {
  createRenderer,
  RealtimeClock,
  connectMicrophoneSource,
  defaultPresetRegistry,
} from "@cymatic/core";
import "@cymatic/presets";

const canvas = document.querySelector("canvas")!;

// createRenderer() is synchronous and backend-agnostic — it picks WebGPU or
// WebGL for you. Acquire the device with renderer.init().
const renderer = createRenderer(canvas);
await renderer.init();

const preset = defaultPresetRegistry.create("colorfield.field");
const { width, height } = renderer.drawingBufferSize;
await preset.init({ renderer, width, height, dpr: window.devicePixelRatio || 1 });

// connectMicrophoneSource() requests the mic and returns a wired analyser.
const { analyser } = await connectMicrophoneSource();

const clock = new RealtimeClock();
let last = 0;
clock.subscribe((c) => {
  const time = c.now();
  const dt = Math.max(0, time - last);
  last = time;
  const features = analyser.read(time); // current AudioFeatureFrame
  preset.update(features, time, dt);
});
clock.start();
```

> The React layer wires this same sequence for you inside effects, and handles
> resize, DPR, teardown, and input switching. Reach for vanilla core when you
> need full control of the loop.

## Quick start (offline render — music video)

`@cymatic/export` steps the preset deterministically frame-by-frame and captures
each frame. It produces **silent** video; the original audio is muxed back on
with ffmpeg afterward.

```ts
import { renderOffline, selectFrameSink, type FrameSource } from "@cymatic/export";
import { defaultPresetRegistry } from "@cymatic/core";
import "@cymatic/presets";

const preset = defaultPresetRegistry.create("particle.fluid");

// `selectFrameSink` returns a WebCodecs encoder when available, else a PNG
// frame-sequence sink. `audio` is a decoded AudioBuffer (browser) or a
// compatible stub (Node).
const { sink } = selectFrameSink({
  webcodecs: { width: 1920, height: 1080, fps: 60 },
  frameSequence: { dir: "frames" },
});

// A FrameSource reads back the just-rendered frame as RGBA8 pixels. In the
// browser this wraps your renderer's read-back; this stub keeps the example
// runnable. See docs/offline-render.md for a real one.
const frameSource: FrameSource = {
  capture: () => new Uint8Array(1920 * 1080 * 4),
};

const result = await renderOffline({
  preset,
  audio,
  config: { fps: 60, width: 1920, height: 1080, duration: 12 },
  frameSource,
  sink,
});

console.log(`rendered ${result.frameCount} frames`);
```

Then mux the audio on (PNG-sequence path shown — see
[docs/offline-render.md](docs/offline-render.md) for the WebCodecs remux):

```sh
ffmpeg -framerate 60 -i frames/frame-%05d.png -i input.wav \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 192k \
  -shortest -movflags +faststart output.mp4
```

## Preset gallery

Twelve presets across four art directions (resolve any by `id`):

### Geometric — Swiss / Bauhaus

| id | name |
| --- | --- |
| `geometric.op-grid` | Op Grid |
| `geometric.modular` | Modular |
| `geometric.concentric` | Concentric |

### Color-field — luminous gradient atmospheres

| id | name |
| --- | --- |
| `colorfield.field` | Field |
| `colorfield.wash` | Soft Horizon |
| `colorfield.bands` | Bands |

### Generative — algorithmic (flow fields, reaction-diffusion, plotter)

| id | name |
| --- | --- |
| `generative.flow-field` | Flow Field |
| `generative.reaction` | Reaction |
| `generative.plotter` | Plotter |

### Particle — particle systems, advected dye, point cloud

| id | name |
| --- | --- |
| `particle.particles` | Particles |
| `particle.fluid` | Fluid |
| `particle.light-3d` | Light 3D |

`@cymatic/presets` also exports `allPresets` (every definition in display order)
and `presetIds` (their ids) for building your own picker.

<!-- Per-preset preview GIFs belong under docs/media/<preset-id>.gif — to be added. -->

## Docs

- [Getting started](docs/getting-started.md) — install, live mode (audio
  element + microphone), and a first visualizer.
- [Authoring a preset](docs/authoring-a-preset.md) — `definePreset`,
  `composePreset`, the primitives, and audio bindings.
- [Offline render](docs/offline-render.md) — the export API and the ffmpeg mux
  steps for a music video.
- [Releasing](docs/releasing.md) — the changeset → version → tag → CI-publish
  flow for maintainers.

## Gallery app

A live gallery (preset switcher + drag-and-drop audio + mic) lives in
[`apps/gallery`](apps/gallery). Run it locally:

```sh
pnpm install
pnpm build
pnpm --filter @cymatic/gallery dev
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the monorepo layout, dev setup, and
the preset-naming guardrail.

## License

[MIT](./LICENSE) © Corey Epstein
