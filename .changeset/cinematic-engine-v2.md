---
"@cymatic/core": minor
"@cymatic/presets": minor
"@cymatic/react": minor
"@cymatic/export": minor
---

cymatic v2: the cinematic engine.

Visuals are now cinematic by default — a glowing, bloom-lit substrate plus an
auto-director that evolves the look across a whole song.

- **Substrate + post-FX** (`@cymatic/core`): new renderer primitives
  `drawGradientRect`, `drawGlow`, `drawLine`, and `setBlendMode`, plus
  `setPostEffects` (`PostEffectsConfig` — bloom, vignette, exposure, feedback
  trails). On WebGPU these run through an HDR target so bright/audio-hot regions
  bloom; on WebGL they no-op to a clean basic look. Presets never branch on the
  backend.
- **Auto-director** (`@cymatic/core`): `Director` / `DirectorState` and the
  section model (`Section` / `SECTIONS` / `SectionTracker`) — a deterministic
  real-time engine that tracks a track's arc (intro → build → … → outro) and
  evolves intensity, motion, bloom, density, contrast, a crossfading palette,
  and hue rotation over the song. Works for live mic and file playback.
- **Mood-reactive analysis** (`@cymatic/core`): `MoodVector` / `computeMood`,
  plus expanded `AudioFeatureFrame` fields (spectral centroid/rolloff/flux,
  short/long loudness, dynamics, tempo, beat phase, onset density, mood).
- **Parameter system** (`@cymatic/core`): a declarative, introspectable
  named-parameter framework — `ParamSchema` / `ParamSet` / `resolveParams` with
  audio / director / LFO / random / manual bindings — powering the gallery's
  live control panel.
- **Palette catalog** (`@cymatic/core`): a cinematic palette catalog
  (`PALETTE_CATALOG` / `PALETTE_NAMES`) and color helpers `sampleRamp`,
  `sampleBlended`, and `rotateHue`.
- **React bindings** (`@cymatic/react`): new `<Visualizer />` props
  `directorEnabled`, `directorSeed`, and `onDirectorState`, plus `paramSet` on
  the imperative handle for live parameter controls.
- **Presets** (`@cymatic/presets`): all 12 presets rebuilt as cinematic — they
  sample color from the director's crossfading palette, use additive glow +
  bloom, and expose a `params` schema with default audio/director bindings.

All additions are backward-compatible: the new `update` frame context and
director/param surfaces are optional, and presets that ignore them behave as
before. The director and param system are pure and seedable, so offline renders
remain deterministic.
