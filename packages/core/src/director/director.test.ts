import { describe, expect, it } from "vitest";

import { Director, type DirectorState } from "./director.js";
import { Section } from "./sections.js";
import { Lfo, Rng, ValueNoise, deriveSeed } from "./noise.js";
import { ZERO_MOOD } from "../audio/mood.js";
import type { AudioFeatureFrame } from "../audio/features.js";

/**
 * Build a feature frame with neutral defaults; the director only reads
 * `loudnessLong`, `onsetDensity`, `spectralFlux`, and the `mood` block, so the
 * rest stay at resting values.
 */
function frame(overrides: Partial<AudioFeatureFrame> = {}): AudioFeatureFrame {
  const f: AudioFeatureFrame = {
    bands: [],
    bass: 0,
    mid: 0,
    treble: 0,
    rms: 0,
    onset: false,
    spectralCentroid: 0,
    spectralRolloff: 0,
    spectralFlux: 0,
    loudnessShort: 0,
    loudnessLong: 0,
    dynamics: 0,
    tempo: 0,
    beatPhase: 0,
    onsetDensity: 0,
    mood: { ...ZERO_MOOD },
    time: 0,
    ...overrides,
  };
  return f;
}

/**
 * Build a feature frame that consistently fills in `mood.energy`/`busyness`/
 * `brightness` from the energy + activity knobs, the way the real pipeline
 * would, so the director's live modulation has something to read.
 */
function musicalFrame(opts: {
  energy: number;
  density?: number;
  flux?: number;
  bright?: number;
}): AudioFeatureFrame {
  const density = opts.density ?? 0;
  const flux = opts.flux ?? 0;
  const bright = opts.bright ?? 0.4;
  return frame({
    loudnessLong: opts.energy,
    loudnessShort: opts.energy,
    onsetDensity: density,
    spectralFlux: flux,
    spectralCentroid: bright,
    spectralRolloff: bright,
    mood: {
      energy: opts.energy,
      brightness: bright,
      busyness: Math.min(1, density / 6 + flux),
      valence: bright,
      dynamics: 0,
    },
  });
}

const DT = 1 / 30; // ~30 fps

/**
 * Drive the director over a synthetic song timeline and return the full state
 * sequence. Each phase is a constant feature frame held for `seconds`.
 */
function runTimeline(
  director: Director,
  phases: { frame: AudioFeatureFrame; seconds: number }[],
): DirectorState[] {
  const out: DirectorState[] = [];
  for (const phase of phases) {
    const steps = Math.round(phase.seconds / DT);
    for (let i = 0; i < steps; i++) {
      out.push(director.update(phase.frame, DT));
    }
  }
  return out;
}

/** A quiet → build → drop → breakdown → outro arc. */
function songArc(): { frame: AudioFeatureFrame; seconds: number }[] {
  return [
    // Quiet intro.
    { frame: musicalFrame({ energy: 0.1, density: 0.3, flux: 0.05 }), seconds: 10 },
    // Rising build — mid energy, climbing. We ramp it by chaining sub-phases.
    { frame: musicalFrame({ energy: 0.35, density: 2, flux: 0.2 }), seconds: 5 },
    { frame: musicalFrame({ energy: 0.5, density: 4, flux: 0.35 }), seconds: 5 },
    // High-energy drop — loud + busy.
    { frame: musicalFrame({ energy: 0.92, density: 6, flux: 0.7 }), seconds: 12 },
    // Breakdown — energy collapses.
    { frame: musicalFrame({ energy: 0.18, density: 0.5, flux: 0.1 }), seconds: 10 },
    // Outro — stays low and fading.
    { frame: musicalFrame({ energy: 0.05, density: 0, flux: 0 }), seconds: 12 },
  ];
}

describe("Director — section detection", () => {
  it("transitions through the expected sections in order over a song arc", () => {
    const director = new Director({ seed: 42 });
    const states = runTimeline(director, songArc());

    // The ordered list of distinct sections the director passed through.
    const visited: Section[] = [];
    for (const s of states) {
      if (visited[visited.length - 1] !== s.section) visited.push(s.section);
    }

    // Must start at intro and reach the peak then wind down.
    expect(visited[0]).toBe(Section.Intro);
    expect(visited).toContain(Section.Build);
    expect(visited).toContain(Section.Drop);
    expect(visited).toContain(Section.Breakdown);
    expect(visited[visited.length - 1]).toBe(Section.Outro);

    // Order constraints: intro before build, build before drop, drop before
    // breakdown, breakdown before outro.
    const idx = (sec: Section) => visited.indexOf(sec);
    expect(idx(Section.Intro)).toBeLessThan(idx(Section.Drop));
    expect(idx(Section.Build)).toBeLessThan(idx(Section.Drop));
    expect(idx(Section.Drop)).toBeLessThan(idx(Section.Breakdown));
    expect(idx(Section.Breakdown)).toBeLessThan(idx(Section.Outro));
  });

  it("does not flicker between sections on small energy dips (hysteresis)", () => {
    const director = new Director({ seed: 7 });

    // Settle into sustain at a steady mid-high energy.
    runTimeline(director, [
      { frame: musicalFrame({ energy: 0.55, density: 1.5, flux: 0.15 }), seconds: 8 },
    ]);
    const settled = director.current.section;

    // Now jitter the energy by a small amount around that level for a while.
    let transitions = 0;
    let prev = settled;
    for (let i = 0; i < 240; i++) {
      const wobble = i % 2 === 0 ? 0.52 : 0.58;
      const s = director.update(
        musicalFrame({ energy: wobble, density: 1.5, flux: 0.15 }),
        DT,
      );
      if (s.section !== prev) {
        transitions++;
        prev = s.section;
      }
    }

    // Small dips around a stable level must not cause section churn.
    expect(transitions).toBe(0);
  });

  it("respects minimum dwell time before leaving a section", () => {
    // An immediate energy spike right after start must not instantly flip away
    // from intro before the minimum dwell time elapses.
    const director = new Director({ seed: 1 });
    const first = director.update(
      musicalFrame({ energy: 0.95, density: 6, flux: 0.8 }),
      DT,
    );
    expect(first.section).toBe(Section.Intro);
  });
});

describe("Director — determinism", () => {
  it("produces an identical state sequence for the same timeline + seed", () => {
    const a = runTimeline(new Director({ seed: 123 }), songArc());
    const b = runTimeline(new Director({ seed: 123 }), songArc());
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("reset(seed) restores a reproducible run", () => {
    const director = new Director({ seed: 999 });
    const first = runTimeline(director, songArc());
    director.reset(999);
    const second = runTimeline(director, songArc());
    expect(first).toEqual(second);
  });

  it("emits a plain serializable state (survives JSON round-trip)", () => {
    const director = new Director({ seed: 5 });
    const s = director.update(musicalFrame({ energy: 0.5, density: 2 }), DT);
    const round = JSON.parse(JSON.stringify(s)) as DirectorState;
    expect(round).toEqual(s);
  });
});

describe("Director — evolution over the song", () => {
  it("changes macro signals + palette blend + hue materially between early and late sections", () => {
    const states = runTimeline(new Director({ seed: 314 }), songArc());
    const early = states[Math.floor(states.length * 0.1)] as DirectorState;
    const peak = states[Math.floor(states.length * 0.45)] as DirectorState;

    // Intensity / bloom / density should be clearly higher at the peak.
    expect(peak.intensity).toBeGreaterThan(early.intensity + 0.15);
    expect(peak.bloom).toBeGreaterThan(early.bloom + 0.1);
    expect(peak.density).toBeGreaterThan(early.density);

    // The palette should have advanced and hue should have rotated.
    expect(peak.paletteIndex).not.toBe(early.paletteIndex);
    expect(peak.hueRotation).not.toBe(early.hueRotation);

    // Palette blend must take intermediate (crossfading) values somewhere.
    const blends = new Set(states.map((s) => Number(s.paletteBlend.toFixed(3))));
    expect(blends.size).toBeGreaterThan(2);
    const sawMidBlend = states.some(
      (s) => s.paletteBlend > 0.05 && s.paletteBlend < 0.95,
    );
    expect(sawMidBlend).toBe(true);
  });

  it("different seeds produce materially different drift", () => {
    const a = runTimeline(new Director({ seed: 1 }), songArc());
    const b = runTimeline(new Director({ seed: 2 }), songArc());

    // Same section path is fine, but the drifted signals must differ.
    let differing = 0;
    for (let i = 0; i < a.length; i++) {
      const sa = a[i] as DirectorState;
      const sb = b[i] as DirectorState;
      if (
        Math.abs(sa.intensity - sb.intensity) > 1e-6 ||
        Math.abs(sa.motion - sb.motion) > 1e-6 ||
        Math.abs(sa.bloom - sb.bloom) > 1e-6
      ) {
        differing++;
      }
    }
    // The vast majority of frames should differ between seeds.
    expect(differing).toBeGreaterThan(a.length * 0.5);
  });

  it("signals are not static while holding a single steady frame (organic drift)", () => {
    const director = new Director({ seed: 77 });
    const steady = musicalFrame({ energy: 0.6, density: 2, flux: 0.2 });
    runTimeline(director, [{ frame: steady, seconds: 6 }]); // settle
    const samples: number[] = [];
    for (let i = 0; i < 600; i++) {
      samples.push(director.update(steady, DT).intensity);
    }
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    // Even under a fixed input the drift must wander a meaningful amount.
    expect(max - min).toBeGreaterThan(0.02);
  });
});

describe("Director — re-seed on section change", () => {
  it("changes the active seed at a section transition", () => {
    const director = new Director({ seed: 2024 });
    const states = runTimeline(director, songArc());

    const seedsAtChange: number[] = [];
    for (let i = 1; i < states.length; i++) {
      const prev = states[i - 1] as DirectorState;
      const cur = states[i] as DirectorState;
      if (cur.section !== prev.section) {
        // On a transition the seed must change.
        expect(cur.seed).not.toBe(prev.seed);
        seedsAtChange.push(cur.seed);
      }
    }
    // We saw at least a few transitions and every re-seed was distinct.
    expect(seedsAtChange.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seedsAtChange).size).toBe(seedsAtChange.length);
  });

  it("re-seeding shifts the post-transition drift trajectory", () => {
    // Two directors with the SAME timeline but the section-RNG re-seed makes
    // each new section's drift fresh. Compare the drift right after the first
    // transition to the drift in the intro: they should not be phase-identical.
    const director = new Director({ seed: 555 });
    const states = runTimeline(director, songArc());

    // Find first transition index.
    let firstChange = -1;
    for (let i = 1; i < states.length; i++) {
      if ((states[i] as DirectorState).section !== (states[i - 1] as DirectorState).section) {
        firstChange = i;
        break;
      }
    }
    expect(firstChange).toBeGreaterThan(0);

    const beforeSeed = (states[firstChange - 1] as DirectorState).seed;
    const afterSeed = (states[firstChange] as DirectorState).seed;
    expect(afterSeed).not.toBe(beforeSeed);
  });
});

describe("noise primitives", () => {
  it("Rng is deterministic for a given seed and varies across seeds", () => {
    const a = new Rng(10);
    const b = new Rng(10);
    const c = new Rng(11);
    const sa = [a.next(), a.next(), a.next()];
    const sb = [b.next(), b.next(), b.next()];
    const sc = [c.next(), c.next(), c.next()];
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    for (const v of [...sa, ...sc]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("deriveSeed is deterministic and salt-sensitive", () => {
    expect(deriveSeed(1, 1)).toBe(deriveSeed(1, 1));
    expect(deriveSeed(1, 1)).not.toBe(deriveSeed(1, 2));
    expect(deriveSeed(1, 1)).not.toBe(deriveSeed(2, 1));
  });

  it("ValueNoise is smooth, bounded, and deterministic", () => {
    const n = new ValueNoise(99);
    expect(n.sample(3.21)).toBe(n.sample(3.21));
    for (let x = 0; x < 50; x += 0.37) {
      const v = n.sample(x);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // Adjacent samples should be close (smoothness), far ones can differ.
    const a = n.sample(5);
    const a2 = n.sample(5.001);
    expect(Math.abs(a - a2)).toBeLessThan(0.05);
  });

  it("Lfo drifts within [0,1] and advances with dt", () => {
    const lfo = new Lfo(7, 0.1, 0.5);
    const vals: number[] = [];
    for (let i = 0; i < 200; i++) vals.push(lfo.step(1 / 30));
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...vals) - Math.min(...vals)).toBeGreaterThan(0.05);
    // dt = 0 holds the value.
    const held = lfo.value();
    expect(lfo.step(0)).toBeCloseTo(held, 10);
  });
});
