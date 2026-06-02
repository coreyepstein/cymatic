# Offline render — export a music video

`@cymatic/export` renders a preset to a file **deterministically**,
frame-for-frame, decoupled from wall-clock time. The same preset that drives a
live canvas drives the export, so what you see live is what you ship.

The exporter produces **silent** output — either a compressed video (via
WebCodecs, in the browser) or a sequence of PNG frames (the dependency-free
fallback). The original audio is muxed back on afterward with ffmpeg. This keeps
the package codec-light and the audio step a documented, reproducible CLI call.

Verify the API surface against `packages/export/src/index.ts`; the ffmpeg
recipes mirror `packages/export/AUDIO-MUX.md`.

## Install

```sh
pnpm add @cymatic/export @cymatic/core @cymatic/presets
```

## The pieces

- **`renderOffline(options)`** — the driver. Steps a core `OfflineClock` at a
  fixed `1/fps`, samples audio features with the core `OfflineSampler` at each
  frame's exact time, runs `preset.update`, captures the frame, and writes it to
  a sink. Returns `{ frameCount, features }`.
- **`FrameSource`** — `{ capture(index, time): Uint8Array }`. Reads back the
  just-rendered frame as tightly-packed RGBA8 pixels. In the browser this wraps
  your renderer's read-back; in Node tests a stub returns a deterministic
  buffer.
- **`FrameSink`** — consumes captured frames in order. Two ship:
  - `WebCodecsEncoderSink` — encodes to mp4/webm via the browser `VideoEncoder`
    (gate with `isWebCodecsAvailable()`).
  - `FrameSequenceSink` — emits one PNG per frame (Node / unsupported browsers).
- **`selectFrameSink({ webcodecs, frameSequence })`** — picks the right sink for
  the current environment automatically and returns `{ kind, sink }` so you can
  point the muxer at a video vs a PNG directory.
- **`frameCountFor(duration, fps)`** — `Math.round(duration * fps)`; the exact
  frame count `renderOffline` will produce.

## Render

```ts
import {
  renderOffline,
  selectFrameSink,
  type FrameSource,
} from "@cymatic/export";
import { defaultPresetRegistry } from "@cymatic/core";
import "@cymatic/presets";

const fps = 60;
const width = 1920;
const height = 1080;

const preset = defaultPresetRegistry.create("particle.fluid");

// `audio` is a decoded AudioBuffer (browser) or a structurally-compatible stub.
// Pick the sink for this environment: a WebCodecs encoder when available, else
// a PNG frame-sequence writer.
const { kind, sink } = selectFrameSink({
  webcodecs: { width, height, fps },
  frameSequence: { dir: "frames" }, // writes frame-00000.png, frame-00001.png, …
});

// Capture the just-rendered frame as RGBA8 pixels. Wire this to your real
// renderer read-back in the browser; a stub keeps Node runs deterministic.
const frameSource: FrameSource = {
  capture: () => new Uint8Array(width * height * 4),
};

const result = await renderOffline({
  preset,
  audio,
  config: { fps, width, height, duration: 12 },
  frameSource,
  sink,
  // Optional: forward OfflineSampler tuning (band count, fftSize, smoothing).
  // samplerOptions: { ... },
  // Optional: pass your real core Renderer so the preset draws into it.
  // renderer,
});

console.log(`${kind}: rendered ${result.frameCount} frames`);
```

Notes:

- `renderOffline` calls `preset.init` (with a `null` renderer when you omit
  `renderer`, so purely state-driven presets still step in Node), then
  `preset.resize`, then steps every frame, then `sink.finish()` and
  `preset.dispose()`.
- Frame `i` is rendered at clock time `i / fps`; frame 0 uses `dt = 0`,
  subsequent frames `dt = 1 / fps`. The sampler is called exactly once per
  frame, in monotonic order — that is what makes its stateful smoothing/onset
  detection reproducible.
- Exporting `N` seconds at `F` fps yields exactly `N * F` frames (rounded), so
  the video timeline lines up with the source audio with no drift.

## Mux the audio on with ffmpeg

The render is silent; add the original audio with ffmpeg. Use the same
`-framerate` you exported at so the timeline stays aligned.

### 1. PNG frame sequence → video with audio

`FrameSequenceSink` writes `frame-00000.png`, `frame-00001.png`, … into a
directory. Encode and mux in one pass:

```sh
ffmpeg \
  -framerate 60 \                 # MUST match the export fps
  -i frames/frame-%05d.png \      # the PNG sequence (zero-pad width = 5)
  -i input.wav \                  # the ORIGINAL decoded audio source
  -c:v libx264 -pix_fmt yuv420p \ # H.264, broadly compatible
  -c:a aac -b:a 192k \            # encode audio to AAC
  -shortest \                     # stop at the shorter of video/audio
  -movflags +faststart \          # web-streamable mp4
  output.mp4
```

- `-framerate` is an **input** option (before `-i`); keep it equal to the `fps`
  you passed to `renderOffline`.
- The `%05d` padding must match `FrameSequenceOptions.pad` (default `5`) and the
  `prefix` (default `frame-`).
- For WebM instead: `-c:v libvpx-vp9 -c:a libopus output.webm`.

### 2. WebCodecs silent video → add audio (remux, no re-encode)

If you muxed the `WebCodecsEncoderSink` chunks into a silent `.mp4`/`.webm`
already, just add the audio track without re-encoding the video:

```sh
ffmpeg \
  -i silent.mp4 \                 # silent video from the WebCodecs path
  -i input.wav \                  # the ORIGINAL decoded audio source
  -c:v copy \                     # keep the encoded video as-is (fast, lossless)
  -c:a aac -b:a 192k \
  -shortest \
  -movflags +faststart \
  output.mp4
```

`-c:v copy` avoids a second video encode, so quality is preserved and the mux is
near-instant. Drop `-movflags +faststart` for WebM.

## Why ffmpeg and not in-package muxing

Audio (re)encoding and container muxing pull in heavy, format-coupled
dependencies and platform codecs. ffmpeg already does this correctly and
deterministically across platforms, so the package stays dependency-light and
the audio step is a documented, reproducible CLI invocation. The canonical copy
of these recipes lives in `packages/export/AUDIO-MUX.md`.
