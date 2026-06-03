# The cinematic engine

cymatic's v2 visuals are not a spectrum chart bolted onto a canvas. They come
from **four cooperating layers**, all living in `@cymatic/core` and all pure /
deterministic enough to reproduce exactly in an offline render. A preset is the
thing that wires them together.

```
audio ─▶ [1] audio + mood analysis ─▶ [3] auto-director ─┐
                     │                                    ├─▶ preset.update(...)
                     └────────────────────────────────────┤        │
                                       [4] param system ◀──┘        ▼
                                                          [2] substrate + post-FX
```

Everything below is verifiable against `packages/core/src/index.ts`.

## 1. Audio + mood analysis

The analyser turns the raw signal into a smoothed `AudioFeatureFrame` each
frame. Alongside the familiar fields (`bands`, `bass` / `mid` / `treble`, `rms`,
`onset`) it carries richer cinematic signals:

- `spectralCentroid`, `spectralRolloff`, `spectralFlux` — spectral shape and
  rate-of-change.
- `loudnessShort` / `loudnessLong` / `dynamics` — punchy-vs-sustained envelope.
- `tempo`, `beatPhase`, `onsetDensity` — beat-grid awareness.
- `mood` — a smoothed `MoodVector` (`energy`, `brightness`, `busyness`,
  `valence`, `dynamics`), each in `[0, 1]`. Compute it standalone with
  `computeMood(features, prevMood)` (start from `ZERO_MOOD`). `valence` is a
  heuristic proxy, not true musical valence.

These are pure DSP — Node-testable, no `Date.now` / `Math.random`.

## 2. Substrate + post-FX

The backend-agnostic `Renderer` is what presets draw through. Beyond
`drawRect`, the cinematic substrate adds, between `beginFrame` / `endFrame`:

- `drawGradientRect(rect, fill)` — a linear or radial color ramp
  (`GradientFill`).
- `drawGlow(glow)` — a soft, feathered **additive** light blob (`GlowSpec`); an
  `intensity > 1` pushes the core into HDR so bloom picks it up.
- `drawLine(line)` — a stroked segment (`LineSpec`).
- `setBlendMode("alpha" | "additive")` — governs `drawRect` /
  `drawGradientRect` / `drawLine` for the rest of the frame (`drawGlow` is
  always additive light).

Post-processing is one backend-agnostic call:

```ts
renderer.setPostEffects({
  exposure: 1.05,
  bloom: { enabled: true, threshold: 0.65, intensity: 0.8, radius: 1.4 },
  vignette: { enabled: true, amount: 0.32 },
  feedback: { enabled: true, decay: 0.9 }, // luminous motion trails
});
```

`setPostEffects` is a partial merge — only the keys you pass change. On **WebGPU**
the scene routes through an offscreen HDR (`rgba16float`) target and these stages
run; on **WebGL** they no-op to a clean basic look. Presets never branch on the
backend.

## 3. Auto-director

The `Director` is a stateful, real-time engine that gives the visuals a sense of
*where they are in a song*. Each frame, `director.update(features, dt)` returns a
serializable `DirectorState`:

- `section` — `intro` → `build` → `sustain` → `drop` → `breakdown` → `outro`
  (with hysteresis), plus `timeInSection` / `elapsed`.
- `intensity`, `motion`, `bloom`, `density`, `contrast` — normalized macro
  signals that build and drop with the track.
- `paletteIndex`, `prevPaletteIndex`, `paletteBlend`, `hueRotation` — the
  crossfading palette + slow hue drift. The director rotates through
  `DIRECTOR_PALETTE_ORDER` (the full `PALETTE_NAMES` catalog), re-seeding its
  drift on every section change so each section feels fresh.

It works for live mic *and* file playback (no precomputed analysis), and is
deterministic given the same `(features, dt, seed)` stream — so offline renders
reproduce. `restingDirectorState(seed)` is the neutral fallback for hosts that
don't run a live director.

A preset samples one evolving color from the state by crossfading the two
palettes and rotating hue:

```ts
import { sampleBlended, rotateHue, PALETTE_CATALOG } from "@cymatic/core";

function directorColor(d, t) {
  const from = PALETTE_CATALOG[d.prevPaletteIndex % PALETTE_CATALOG.length];
  const to = PALETTE_CATALOG[d.paletteIndex % PALETTE_CATALOG.length];
  const base = sampleBlended(from, to, d.paletteBlend, t); // t in [0,1]
  return rotateHue(base, d.hueRotation * 360); // hueRotation is in turns
}
```

## 4. Param system

Presets expose tunable knobs as a declarative `params` schema (`ParamSchema[]`)
and wire each key to a `ParamBinding` that says where its value comes from each
frame:

- `const` — a fixed value.
- `audio` — a dotted path into the frame (`"bass"`, `"mood.energy"`).
- `director` — a dotted path into the director state (`"intensity"`,
  `"bloom"`).
- `lfo` — a deterministic oscillator advanced on `dt`.
- `random` — seeded randomness (sample-and-hold or resampling).
- `manual` — an explicit value that **overrides** automation.

Resolution is pure (`resolveParams`, or the stateful `ParamSet` controller that
adds per-binding smoothing / LFO / random state). Because the schema is inert
and introspectable, a host renders controls from it without running the preset —
which is exactly how the gallery's live control panel works (`getSchema` /
`setManual` / `bind` / `getResolved`). Manual overrides always beat automation,
and re-binding to an auto source clears them.

## How a preset ties it together

With `composePreset`, the four layers arrive pre-wired. Each layer's `draw`
receives `{ renderer, features, director, params, dt, ... }`: read `features`
for instantaneous reaction, `director` for song-arc evolution and color,
`params` for the resolved knobs, and issue draws + `setPostEffects` through the
`renderer`. See [authoring-a-preset.md](./authoring-a-preset.md) for a complete,
minimal example, and `packages/presets/src/geometric/op-grid.ts` for a real one.
