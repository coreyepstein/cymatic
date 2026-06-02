/**
 * Section state machine for the auto-director.
 *
 * Classifies "where we are in a song" from the running energy envelope and a
 * few activity signals, with hysteresis (thresholds + a minimum dwell time) so
 * the classification does not flicker between sections on small dips.
 *
 * The transition function is a pure function of `(prevState, input)`. The
 * {@link Director} owns an instance of {@link SectionTracker} and feeds it the
 * smoothed feature signals each frame.
 *
 * Everything here is deterministic and wall-clock free — time advances only via
 * the `dt` passed in.
 */

/** The coarse part of a song the director currently believes it is in. */
export enum Section {
  /** Quiet, building up — the opening. */
  Intro = "intro",
  /** Energy rising over time — tension building toward a peak. */
  Build = "build",
  /** Steady, high-ish energy holding flat — the main groove. */
  Sustain = "sustain",
  /** Peak energy / busiest moment — the payoff. */
  Drop = "drop",
  /** Energy collapses after a peak — the comedown. */
  Breakdown = "breakdown",
  /** Low energy at/after the end — fading out. */
  Outro = "outro",
}

/** Ordered list of sections, useful for tests and indexing. */
export const SECTIONS: readonly Section[] = [
  Section.Intro,
  Section.Build,
  Section.Sustain,
  Section.Drop,
  Section.Breakdown,
  Section.Outro,
];

/** Smoothed signals the section classifier consumes (all in `[0, 1]`). */
export interface SectionInput {
  /** Long-term loudness envelope in `[0, 1]` — the master "how loud now". */
  energy: number;
  /** Signed slope of `energy` per second — positive = rising, negative = falling. */
  energySlope: number;
  /** Normalized onset density in `[0, 1]` — how busy / driving it is. */
  density: number;
  /** Normalized spectral flux in `[0, 1]` — rate of spectral change. */
  flux: number;
  /** Seconds elapsed since the track started (monotonic). */
  elapsed: number;
}

/** Tunable thresholds for the classifier. All have sensible defaults. */
export interface SectionThresholds {
  /** Below this energy the track reads as quiet (intro/outro/breakdown). */
  quietEnergy: number;
  /** At/above this energy + activity the track reads as a peak (drop). */
  highEnergy: number;
  /** Energy slope (per second) above which energy counts as "rising". */
  risingSlope: number;
  /** Energy slope (per second) below which energy counts as "falling". */
  fallingSlope: number;
  /** Density at/above which a high-energy moment reads as a drop. */
  dropDensity: number;
  /** Minimum seconds to stay in a section before switching (hysteresis). */
  minDwellSeconds: number;
  /** Seconds of low energy near the start that still counts as intro. */
  introGraceSeconds: number;
}

/** Default thresholds, tuned for typical mixed-energy music. */
export const DEFAULT_SECTION_THRESHOLDS: SectionThresholds = {
  quietEnergy: 0.28,
  highEnergy: 0.62,
  risingSlope: 0.015,
  fallingSlope: -0.015,
  dropDensity: 0.45,
  minDwellSeconds: 2.5,
  introGraceSeconds: 6,
};

/**
 * Decide which section best fits `input`, ignoring hysteresis. This is the raw
 * classification; the tracker layers dwell-time hysteresis on top so it does
 * not flicker. Pure.
 */
export function classifySection(
  prev: Section,
  input: SectionInput,
  thresholds: SectionThresholds = DEFAULT_SECTION_THRESHOLDS,
): Section {
  const { energy, energySlope, density, flux } = input;
  const t = thresholds;
  const rising = energySlope >= t.risingSlope;
  const falling = energySlope <= t.fallingSlope;
  const activity = Math.max(density, flux);

  // Peak: loud AND busy → a drop, regardless of where we came from.
  if (energy >= t.highEnergy && activity >= t.dropDensity) {
    return Section.Drop;
  }

  // Quiet handling: distinguish the opening from a mid-song breakdown and the
  // final fade. The intro grace window lets a slow opener read as intro even if
  // it is briefly flat.
  if (energy < t.quietEnergy) {
    if (input.elapsed <= t.introGraceSeconds && !falling) {
      return Section.Intro;
    }
    // Once we have peaked at least once, a quiet stretch is a breakdown unless
    // it is also fading (handled by the tracker via "have we dropped yet").
    return prev === Section.Drop || prev === Section.Sustain
      ? Section.Breakdown
      : prev === Section.Breakdown || prev === Section.Outro
        ? prev
        : Section.Intro;
  }

  // Mid energy.
  if (rising) return Section.Build;
  if (falling) return Section.Breakdown;
  // Flat-ish at a workable level → sustain.
  return Section.Sustain;
}

/**
 * Stateful section classifier with hysteresis. Holds the current section, the
 * time spent in it, and whether the track has peaked yet (so a late quiet
 * stretch can be recognised as an outro rather than another breakdown).
 */
export class SectionTracker {
  private readonly thresholds: SectionThresholds;
  private current: Section = Section.Intro;
  private timeInSection = 0;
  private hasPeaked = false;
  /** Rolling count of consecutive seconds at very low energy after a peak. */
  private lowEnergyRun = 0;

  constructor(thresholds: SectionThresholds = DEFAULT_SECTION_THRESHOLDS) {
    this.thresholds = thresholds;
  }

  /** Reset to the opening state. */
  reset(): void {
    this.current = Section.Intro;
    this.timeInSection = 0;
    this.hasPeaked = false;
    this.lowEnergyRun = 0;
  }

  /** The section currently believed to be active. */
  get section(): Section {
    return this.current;
  }

  /** Seconds spent in the current section. */
  get dwell(): number {
    return this.timeInSection;
  }

  /**
   * Advance the tracker by `dt` seconds with the latest `input`. Returns `true`
   * if the section changed on this step (so callers can re-seed on transition).
   */
  step(dt: number, input: SectionInput): boolean {
    const t = this.thresholds;
    this.timeInSection += Math.max(0, dt);

    if (input.energy >= t.highEnergy) this.hasPeaked = true;

    // Track sustained low energy late in the track → outro.
    if (input.energy < t.quietEnergy) {
      this.lowEnergyRun += Math.max(0, dt);
    } else {
      this.lowEnergyRun = 0;
    }

    let candidate = classifySection(this.current, input, t);

    // Promote a long quiet tail (after we have peaked) to outro.
    if (
      this.hasPeaked &&
      input.energy < t.quietEnergy &&
      this.lowEnergyRun >= t.minDwellSeconds &&
      input.energySlope <= 0
    ) {
      candidate = Section.Outro;
    }

    // Hysteresis: do not leave a section before the minimum dwell time, and
    // never bounce backwards out of outro (the track is ending).
    if (candidate === this.current) return false;
    if (this.timeInSection < t.minDwellSeconds) return false;
    if (this.current === Section.Outro && candidate !== Section.Outro) {
      return false;
    }

    this.current = candidate;
    this.timeInSection = 0;
    return true;
  }
}
