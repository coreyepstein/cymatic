/**
 * Public auto-director surface for @cymatic/core (V2-07).
 *
 * The director is a stateful, deterministic real-time engine that tracks where
 * a track is in its arc (intro → build → sustain → drop → breakdown → outro)
 * and evolves a set of normalized macro signals — intensity, motion, bloom,
 * density, contrast, palette crossfade, and hue rotation — over the whole song.
 * It re-seeds its organic drift on every section change so each section feels
 * fresh, and works for both live mic and file playback (no precomputed
 * analysis). Pure, Node-testable, and wall-clock free.
 */

export type {
  DirectorState,
  DirectorOptions,
} from "./director.js";
export { Director, DIRECTOR_PALETTE_ORDER } from "./director.js";

export { Section, SECTIONS, SectionTracker, classifySection } from "./sections.js";
export type { SectionInput, SectionThresholds } from "./sections.js";
export { DEFAULT_SECTION_THRESHOLDS } from "./sections.js";

export { Rng, ValueNoise, Lfo, deriveSeed } from "./noise.js";
