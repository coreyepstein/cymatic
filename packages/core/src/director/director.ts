/**
 * Auto-director — a stateful, real-time song-arc engine.
 *
 * The director gives the visuals a sense of *where they are in a song* and
 * evolves the look over the whole track, for both live mic and file playback
 * (no precomputed analysis required). Each frame it:
 *
 *  1. updates a smoothed energy envelope and its slope,
 *  2. advances the {@link SectionTracker} (intro → build → … → outro) with
 *     hysteresis,
 *  3. re-seeds its drift generators on every section change so each section
 *     feels fresh (the "more randomness + color change" requirement),
 *  4. drives organic LFO/value-noise drift into a set of normalized macro
 *     signals,
 *  5. crossfades between palettes on section changes and slowly rotates hue.
 *
 * The emitted {@link DirectorState} is a plain, serializable object presets can
 * read directly. `update` is deterministic given the same `(frame stream, seed,
 * dt stream)` — there is no `Math.random` / `Date.now`; time advances only via
 * the `dt` passed in, so it behaves identically under the realtime and offline
 * clocks. Call {@link Director.reset} to restart from a known seed.
 */

import { clamp01, ema, type AudioFeatureFrame } from "../audio/features.js";
import { PALETTE_NAMES, type PaletteName } from "../primitives/palette.js";
import { Lfo, Rng, deriveSeed } from "./noise.js";
import {
  DEFAULT_SECTION_THRESHOLDS,
  Section,
  SectionTracker,
  type SectionInput,
  type SectionThresholds,
} from "./sections.js";

/**
 * The ordered palette rotation the director crossfades through — the full
 * cinematic catalog (see {@link PALETTE_NAMES}). Section changes advance the
 * active palette; `paletteBlend` ramps the crossfade. Consumers resolve a name
 * to a {@link Palette} via the `palettes` map and feed `sampleBlended` /
 * `rotateHue` with `paletteBlend` / `hueRotation`.
 */
export const DIRECTOR_PALETTE_ORDER: readonly PaletteName[] = PALETTE_NAMES;

/**
 * A plain, serializable snapshot of the director's macro signals for a frame.
 * Presets read these to evolve their look over the song. All ratio-like fields
 * are normalized; multipliers are centered near 1.
 */
export interface DirectorState {
  /** The section the director currently believes it is in. */
  section: Section;
  /** Seconds spent in the current section. */
  timeInSection: number;
  /** Seconds since the track / director started (monotonic). */
  elapsed: number;
  /** Master visual energy in `[0, 1]`. */
  intensity: number;
  /** Speed multiplier for motion, typically ~`[0.5, 2]`. */
  motion: number;
  /** Suggested bloom intensity in `[0, 1]`. */
  bloom: number;
  /** Particle / element count multiplier, typically ~`[0.5, 2]`. */
  density: number;
  /** Contrast multiplier in `[0, 1]` (relative). */
  contrast: number;
  /** Index of the *target* palette in {@link DIRECTOR_PALETTE_ORDER}. */
  paletteIndex: number;
  /** Index of the palette being crossfaded *from*. */
  prevPaletteIndex: number;
  /** Crossfade progress from `prevPaletteIndex` → `paletteIndex`, `[0, 1]`. */
  paletteBlend: number;
  /** Slowly-advancing hue rotation in turns `[0, 1)` (1 == full circle). */
  hueRotation: number;
  /** The seed currently driving this section's drift generators. */
  seed: number;
}

/** Construct the resting {@link DirectorState} for a given seed. */
function initialState(seed: number): DirectorState {
  return {
    section: Section.Intro,
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
    seed,
  };
}

/**
 * A deterministic, neutral {@link DirectorState} for hosts that do NOT run a
 * live {@link Director} (V2-10). Cinematic presets read `director.*` every
 * frame; threading this resting state when no director is supplied lets them
 * stay unconditional (no `?.`/branching) while behaving sensibly — a calm
 * intro look (low intensity, neutral motion/density, first palette). Pure: the
 * same `seed` always yields the same snapshot.
 */
export function restingDirectorState(seed = DEFAULTS.seed): DirectorState {
  return initialState(seed);
}

/** Tuning for the {@link Director}. All fields optional. */
export interface DirectorOptions {
  /** Initial seed for the deterministic drift generators. Default `0x1a2b3c4d`. */
  seed?: number;
  /** Section-classifier thresholds. Defaults to {@link DEFAULT_SECTION_THRESHOLDS}. */
  thresholds?: SectionThresholds;
  /**
   * EMA smoothing for the energy envelope in `[0, 1)`. Higher = slower / more
   * stable. Default `0.9`.
   */
  energySmoothing?: number;
  /**
   * EMA smoothing applied to the emitted macro signals in `[0, 1)`. Keeps them
   * from snapping on section changes. Default `0.85`.
   */
  signalSmoothing?: number;
  /** Seconds for a palette crossfade to complete after a section change. Default `4`. */
  paletteCrossfadeSeconds?: number;
  /** Hue rotation speed in turns per second. Default `0.01` (~100s per circle). */
  hueRotationPerSecond?: number;
  /** Onset density (onsets/sec) mapping to a full "busy" reading. Default `6`. */
  onsetDensityFull?: number;
}

interface ResolvedOptions {
  seed: number;
  thresholds: SectionThresholds;
  energySmoothing: number;
  signalSmoothing: number;
  paletteCrossfadeSeconds: number;
  hueRotationPerSecond: number;
  onsetDensityFull: number;
}

const DEFAULTS: ResolvedOptions = {
  seed: 0x1a2b3c4d,
  thresholds: DEFAULT_SECTION_THRESHOLDS,
  energySmoothing: 0.9,
  signalSmoothing: 0.85,
  paletteCrossfadeSeconds: 4,
  hueRotationPerSecond: 0.01,
  onsetDensityFull: 6,
};

/** Per-signal LFOs that give each macro channel its own organic drift. */
interface DriftBank {
  intensity: Lfo;
  motion: Lfo;
  bloom: Lfo;
  density: Lfo;
  contrast: Lfo;
}

/**
 * Section "personality" — the baseline level each macro signal targets while in
 * that section, before drift and live audio modulation. Multipliers are
 * centered near 1; the rest are `[0, 1]` baselines.
 */
interface SectionProfile {
  intensity: number;
  motion: number;
  bloom: number;
  density: number;
  contrast: number;
}

const SECTION_PROFILES: Record<Section, SectionProfile> = {
  [Section.Intro]: { intensity: 0.2, motion: 0.7, bloom: 0.25, density: 0.6, contrast: 0.45 },
  [Section.Build]: { intensity: 0.5, motion: 1.0, bloom: 0.4, density: 0.9, contrast: 0.6 },
  [Section.Sustain]: { intensity: 0.65, motion: 1.1, bloom: 0.5, density: 1.1, contrast: 0.6 },
  [Section.Drop]: { intensity: 0.95, motion: 1.6, bloom: 0.85, density: 1.5, contrast: 0.85 },
  [Section.Breakdown]: { intensity: 0.4, motion: 0.8, bloom: 0.35, density: 0.7, contrast: 0.5 },
  [Section.Outro]: { intensity: 0.15, motion: 0.6, bloom: 0.2, density: 0.5, contrast: 0.4 },
};

/**
 * The auto-director. Construct once, call {@link Director.update} every frame
 * with the latest feature frame and the frame's `dt` (seconds), and read the
 * returned {@link DirectorState}.
 */
export class Director {
  private readonly opts: ResolvedOptions;
  private tracker: SectionTracker;
  private state: DirectorState;

  /** Smoothed long-term energy envelope and its previous value (for slope). */
  private energy = 0;
  private prevEnergy = 0;
  /** Smoothed slope estimate (energy per second). */
  private energySlope = 0;

  private drift: DriftBank;
  private sectionRng: Rng;

  constructor(options: DirectorOptions = {}) {
    this.opts = {
      seed: options.seed ?? DEFAULTS.seed,
      thresholds: options.thresholds ?? DEFAULTS.thresholds,
      energySmoothing: clamp01(options.energySmoothing ?? DEFAULTS.energySmoothing),
      signalSmoothing: clamp01(options.signalSmoothing ?? DEFAULTS.signalSmoothing),
      paletteCrossfadeSeconds:
        options.paletteCrossfadeSeconds && options.paletteCrossfadeSeconds > 0
          ? options.paletteCrossfadeSeconds
          : DEFAULTS.paletteCrossfadeSeconds,
      hueRotationPerSecond:
        options.hueRotationPerSecond ?? DEFAULTS.hueRotationPerSecond,
      onsetDensityFull:
        options.onsetDensityFull && options.onsetDensityFull > 0
          ? options.onsetDensityFull
          : DEFAULTS.onsetDensityFull,
    };
    this.tracker = new SectionTracker(this.opts.thresholds);
    this.state = initialState(this.opts.seed);
    this.sectionRng = new Rng(this.opts.seed);
    this.drift = this.makeDrift(this.opts.seed);
  }

  /** Reset all internal state to a fresh start under `seed` (default: configured seed). */
  reset(seed: number = this.opts.seed): void {
    this.tracker.reset();
    this.state = initialState(seed);
    this.energy = 0;
    this.prevEnergy = 0;
    this.energySlope = 0;
    this.sectionRng = new Rng(seed);
    this.drift = this.makeDrift(seed);
  }

  /** A read-only view of the latest emitted state (without advancing). */
  get current(): DirectorState {
    return { ...this.state };
  }

  /** The number of palettes the director rotates through. */
  static get paletteCount(): number {
    return DIRECTOR_PALETTE_ORDER.length;
  }

  /**
   * Advance the director by `dt` seconds with the latest feature `frame` and
   * return the next {@link DirectorState}. Deterministic given the same
   * `(frame, dt)` stream and initial seed.
   */
  update(frame: AudioFeatureFrame, dt: number): DirectorState {
    const step = Math.max(0, dt);
    const t = this.opts;

    // --- 1. Energy envelope + slope ------------------------------------------
    // Prefer the already-smoothed long loudness; fall back to mood energy.
    const rawEnergy = clamp01(
      frame.loudnessLong > 0 ? frame.loudnessLong : frame.mood.energy,
    );
    this.prevEnergy = this.energy;
    this.energy = ema(this.energy, rawEnergy, t.energySmoothing);
    if (step > 0) {
      const instSlope = (this.energy - this.prevEnergy) / step;
      // Heavily smooth the slope so frame-to-frame wobble around a steady level
      // averages toward zero and cannot flip the rising/falling classification.
      this.energySlope = ema(this.energySlope, instSlope, 0.95);
    }

    const elapsed = this.state.elapsed + step;

    // --- 2. Section state machine --------------------------------------------
    const density = clamp01(frame.onsetDensity / t.onsetDensityFull);
    const flux = clamp01(frame.spectralFlux);
    const sectionInput: SectionInput = {
      energy: this.energy,
      energySlope: this.energySlope,
      density,
      flux,
      elapsed,
    };
    const changed = this.tracker.step(step, sectionInput);
    const section = this.tracker.section;

    // --- 3. Re-seed + palette advance on a section transition ----------------
    let seed = this.state.seed;
    let paletteIndex = this.state.paletteIndex;
    let prevPaletteIndex = this.state.prevPaletteIndex;
    let paletteBlend = this.state.paletteBlend;
    if (changed) {
      // Fresh, deterministic seed for the new section → new drift feel.
      seed = this.sectionRng.nextSeed();
      this.drift = this.makeDrift(seed);
      // Advance the palette and start a fresh crossfade from the current one.
      prevPaletteIndex = paletteIndex;
      paletteIndex = (paletteIndex + 1) % DIRECTOR_PALETTE_ORDER.length;
      paletteBlend = 0;
    }

    // Advance the palette crossfade toward 1.
    if (paletteBlend < 1) {
      paletteBlend = clamp01(
        paletteBlend + step / t.paletteCrossfadeSeconds,
      );
    }

    // --- 4. Drift the macro signals ------------------------------------------
    const profile = SECTION_PROFILES[section];
    const dIntensity = this.drift.intensity.step(step); // [0,1]
    const dMotion = this.drift.motion.step(step);
    const dBloom = this.drift.bloom.step(step);
    const dDensity = this.drift.density.step(step);
    const dContrast = this.drift.contrast.step(step);

    // Live-audio modulation: the immediate mood energy/busyness nudges signals
    // on top of the section baseline so the visuals breathe with the music.
    const liveEnergy = frame.mood.energy;
    const liveBusy = frame.mood.busyness;
    const liveBright = frame.mood.brightness;

    // Targets blend: section baseline + drift (±) + live audio.
    const intensityTarget = clamp01(
      profile.intensity * (0.7 + 0.6 * dIntensity) + 0.35 * liveEnergy,
    );
    // Motion / density are multipliers centered near 1; drift swings ±~0.3.
    const motionTarget =
      profile.motion * (0.85 + 0.3 * dMotion) * (0.9 + 0.3 * liveBusy);
    const densityTarget =
      profile.density * (0.85 + 0.3 * dDensity) * (0.9 + 0.3 * liveBusy);
    const bloomTarget = clamp01(
      profile.bloom * (0.7 + 0.6 * dBloom) + 0.3 * liveEnergy,
    );
    const contrastTarget = clamp01(
      profile.contrast * (0.8 + 0.4 * dContrast) + 0.2 * liveBright,
    );

    // --- 5. Smooth emitted signals + rotate hue ------------------------------
    const s = t.signalSmoothing;
    const intensity = ema(this.state.intensity, intensityTarget, s);
    const motion = ema(this.state.motion, motionTarget, s);
    const bloom = ema(this.state.bloom, bloomTarget, s);
    const densityOut = ema(this.state.density, densityTarget, s);
    const contrast = ema(this.state.contrast, contrastTarget, s);

    // Hue rotates continuously; intensity speeds it up slightly so busy
    // sections shift color faster. Wrap into [0, 1).
    const hueDelta = t.hueRotationPerSecond * (1 + 0.5 * intensity) * step;
    let hueRotation = this.state.hueRotation + hueDelta;
    hueRotation -= Math.floor(hueRotation);

    this.state = {
      section,
      timeInSection: this.tracker.dwell,
      elapsed,
      intensity,
      motion,
      bloom,
      density: densityOut,
      contrast,
      paletteIndex,
      prevPaletteIndex,
      paletteBlend,
      hueRotation,
      seed,
    };
    return { ...this.state };
  }

  /** Build a fresh, deterministic drift bank from `seed`. */
  private makeDrift(seed: number): DriftBank {
    // Each channel gets its own derived seed + a distinct base frequency so the
    // signals drift independently rather than in lockstep.
    return {
      intensity: new Lfo(deriveSeed(seed, 1), 0.035, 0.6),
      motion: new Lfo(deriveSeed(seed, 2), 0.06, 0.5),
      bloom: new Lfo(deriveSeed(seed, 3), 0.045, 0.6),
      density: new Lfo(deriveSeed(seed, 4), 0.05, 0.55),
      contrast: new Lfo(deriveSeed(seed, 5), 0.04, 0.5),
    };
  }
}
