# Muxing audio onto an exported render

The `@cymatic/export` pipeline produces **silent** video: either a compressed
video stream (via WebCodecs, in the browser) or a sequence of PNG frames (the
`FrameSequenceSink` fallback). It deliberately does **not** embed the original
audio — re-encoding audio is out of scope and best left to `ffmpeg`, which is
the standard, deterministic tool for muxing. This note documents the two mux
recipes.

In both cases the render is deterministic: exporting `N` seconds at `F` fps
yields exactly `N * F` frames, so the video timeline lines up with the source
audio with no drift as long as you pass the same `-framerate F`.

## 1. PNG frame sequence → video with audio

The `FrameSequenceSink` writes `frame-00000.png`, `frame-00001.png`, … into a
directory. Encode those frames at the export fps and mux the original audio on
in a single pass:

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

Notes:

- `-framerate` (an **input** option, before `-i`) sets the rate the PNGs are
  interpreted at. Keep it equal to the `fps` you passed to `renderOffline`.
- The padding in `%05d` must match `FrameSequenceOptions.pad` (default `5`) and
  the `prefix` (default `frame-`).
- For a WebM target instead: `-c:v libvpx-vp9 -c:a libopus output.webm`.

## 2. WebCodecs silent video → add audio (remux, no video re-encode)

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
the audio step is a documented, reproducible CLI invocation.
