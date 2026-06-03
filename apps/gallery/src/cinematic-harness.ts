/**
 * V2-15 cinematic verification harness (real browser, real GPU pass — no mocks).
 *
 * Where the per-pack harnesses (V2-10..13) hand-set a {@link DirectorState} to
 * isolate one variable, THIS harness drives the actual song-arc engine: a real
 * {@link Director} fed by a synthetic feature/energy timeline that ramps
 * intro → build → drop → breakdown over the equivalent of ~12s, advanced by an
 * {@link OfflineClock} so timing is deterministic and reproducible. That is the
 * closest thing to "play a whole song" without faking real audio, and it
 * exercises the exact code path that makes the look evolve over a track
 * (section transitions, palette crossfades, hue rotation, drift re-seeding).
 *
 * It exposes `window.__cineHarness` so a Playwright spec can:
 *   1. run the arc and capture canvas frames at multiple points (intro vs drop
 *      vs breakdown) to prove the look develops MATERIALLY, not a static loop;
 *   2. render with bloom forced ON (drop-level) vs a no-bloom baseline to prove
 *      bright-halo spread;
 *   3. run the SAME arc under two different director seeds and prove divergence;
 *   4. measure average per-frame time for a representative cinematic preset
 *      (bloom + feedback) over N frames at a realistic resolution.
 *
 * Honours whatever backend the browser provides (WebGPU runs the full bloom/
 * feedback chain; WebGL is the documented fallback). The spec reports backend.
 */

import {
  createRenderer,
  defaultPresetRegistry,
  restingDirectorState,
  Director,
  OfflineClock,
  type AudioFeatureFrame,
  type DirectorState,
  type Preset,
  type Renderer,
} from "@cymatic/core";
// Import for the registration side-effect so presets resolve by id.
import "@cymatic/presets";

/** Backing store size — a realistic small-cinematic resolution for CI perf. */
const W = 320;
const H = 320;
const FPS = 60;

/**
 * A normalized synthetic "song" energy/activity envelope at time `t` (seconds)
 * over a ~12s arc. The shape is what the {@link Director}'s section classifier
 * keys on (long loudness + onset density + spectral flux), so this drives a real
 * intro → build → drop → breakdown progression rather than a hand-set state:
 *
 *   0–2.5s   intro     — quiet, flat (energy ~0.12)
 *   2.5–5.5s build     — energy ramps upward (rising slope → Build)
 *   5.5–9s   drop      — loud + busy (energy ~0.92, dense → Drop)
 *   9–12s    breakdown — energy collapses (falling → Breakdown)
 */
function songEnergy(t: number): number {
  if (t < 2.5) return 0.12;
  if (t < 5.5) return 0.12 + (0.78 * (t - 2.5)) / 3.0; // ramp 0.12 → 0.9
  if (t < 9.0) return 0.92;
  // Breakdown: decay from 0.92 toward 0.16.
  return Math.max(0.16, 0.92 - (0.76 * (t - 9.0)) / 3.0);
}

/** A full {@link AudioFeatureFrame} synthesized from the song envelope at `t`. */
function arcFrame(t: number): AudioFeatureFrame {
  const e = songEnergy(t);
  // Busyness/flux track energy so the classifier sees a real drop (loud AND
  // busy) in the middle, and a calm intro/breakdown at the edges.
  const busy = e;
  const flux = 0.15 + 0.6 * e;
  const density = 6 * e; // onsets/sec; ~0.7 → "busy" at full energy
  const bright = 0.3 + 0.5 * e;
  return {
    bands: new Array<number>(16).fill(0.2 + 0.7 * e),
    bass: 0.2 + 0.7 * e,
    mid: 0.2 + 0.6 * e,
    treble: 0.15 + 0.6 * e,
    rms: e,
    onset: Math.floor(t * 4) % 2 === 0 && e > 0.3,
    spectralCentroid: 0.4 + 0.3 * e,
    spectralRolloff: 0.4 + 0.3 * e,
    spectralFlux: flux,
    loudnessShort: e,
    loudnessLong: e,
    dynamics: 0.4 + 0.3 * e,
    tempo: 124,
    beatPhase: (t % 0.5) * 2,
    onsetDensity: density,
    mood: { energy: e, brightness: bright, busyness: busy, valence: 0.55, dynamics: 0.5 },
    time: t,
  };
}

/** Section the synthetic arc is in at time `t` (label only, for logging). */
function arcLabel(t: number): "intro" | "build" | "drop" | "breakdown" {
  if (t < 2.5) return "intro";
  if (t < 5.5) return "build";
  if (t < 9.0) return "drop";
  return "breakdown";
}

/** One captured arc point: the time, the director's own section, and the seed. */
export interface ArcSample {
  /** Elapsed seconds at capture. */
  t: number;
  /** The arc label (synthetic intent). */
  label: string;
  /** The section the live Director classified (its own state). */
  section: string;
  /** The director's emitted bloom signal at capture. */
  bloom: number;
}

interface CineHarness {
  /** Select a preset by id, building a fresh instance. */
  select(id: string): Promise<void>;
  /** The resolved backend ("webgpu" | "webgl"). */
  backend(): string;
  /**
   * Run the synthetic song arc under a real {@link Director} (seeded by `seed`)
   * up to `untilSeconds`, presenting the final frame. Returns the arc sample at
   * the stop point. Each call restarts the arc from t=0 so captures are
   * independent and reproducible.
   */
  runArc(seed: number, untilSeconds: number): Promise<ArcSample>;
  /**
   * Run the arc to `untilSeconds` with bloom forced to `bloom` (0 = no-bloom
   * baseline, ~0.9 = full cinematic bloom), overriding ONLY the director's bloom
   * channel so the rest of the look is byte-for-byte identical between calls.
   * Presents the final frame. Use an early/dim section so the glow has dark room
   * to spread into (a saturated full-energy field has nowhere to bloom).
   */
  renderBloom(seed: number, bloom: number, untilSeconds: number): Promise<void>;
  /**
   * Measure average per-frame time (ms) for the current preset under the drop
   * section (bloom + feedback active) over `frames` update+present steps. Returns
   * the mean ms/frame measured by `performance.now()` in the real browser.
   */
  measurePerf(seed: number, frames: number): Promise<number>;
}

declare global {
  interface Window {
    __cineHarness?: CineHarness;
    __cineHarnessReady?: boolean;
    __cineHarnessError?: string;
  }
}

/** Yield two rAFs so the compositor presents the swapchain before a screenshot. */
function present(): Promise<void> {
  return new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

async function boot(): Promise<void> {
  const canvas = document.getElementById("c") as HTMLCanvasElement | null;
  if (!canvas) throw new Error("cinematic-harness: canvas #c missing");

  const renderer: Renderer = createRenderer(canvas);
  await renderer.init();
  renderer.resize(W, H, 1);

  let preset: Preset | null = null;

  /**
   * Drive the live Director through the synthetic arc from t=0 to `untilSeconds`
   * using a fixed-step OfflineClock, calling `preset.update` each frame with the
   * director's evolving state. Optionally clamp the director's bloom channel to a
   * fixed value (for the bloom on/off comparison). Returns the final arc sample.
   */
  function driveArc(
    seed: number,
    untilSeconds: number,
    bloomOverride: number | null,
  ): ArcSample {
    if (!preset) throw new Error("cinematic-harness: no preset selected");
    const clock = new OfflineClock({ fps: FPS });
    const director = new Director({ seed });
    const dt = 1 / FPS;
    let state: DirectorState = restingDirectorState(seed);
    let t = 0;
    // +half a frame of slack so floating point lands ON the requested second.
    while (t <= untilSeconds + dt * 0.5) {
      const frame = arcFrame(t);
      state = director.update(frame, dt);
      if (bloomOverride !== null) state = { ...state, bloom: bloomOverride };
      preset.update(frame, t, dt, { director: state });
      clock.tick();
      t = clock.now();
    }
    return {
      t: Number((t - dt).toFixed(4)),
      label: arcLabel(Math.min(untilSeconds, t - dt)),
      section: state.section,
      bloom: Number(state.bloom.toFixed(4)),
    };
  }

  const harness: CineHarness = {
    backend: () => renderer.backend,
    select: async (id: string): Promise<void> => {
      preset?.dispose();
      preset = defaultPresetRegistry.create(id);
      await preset.init({ renderer, width: W, height: H, dpr: 1 });
    },
    runArc: async (seed: number, untilSeconds: number): Promise<ArcSample> => {
      const sample = driveArc(seed, untilSeconds, null);
      await present();
      return sample;
    },
    renderBloom: async (
      seed: number,
      bloom: number,
      untilSeconds: number,
    ): Promise<void> => {
      // Run to the requested section with bloom pinned to the requested level so
      // it is the only varying input between the on/off captures.
      driveArc(seed, untilSeconds, bloom);
      await present();
    },
    measurePerf: async (seed: number, frames: number): Promise<number> => {
      if (!preset) throw new Error("cinematic-harness: no preset selected");
      // Warm up into the drop so feedback/bloom buffers are allocated and the
      // GPU pipelines are hot before timing (mirrors steady-state playback).
      driveArc(seed, 7.0, null);
      await present();

      const director = new Director({ seed });
      const dt = 1 / FPS;
      // Pre-roll the director to the drop so each timed frame is steady-state.
      let state: DirectorState = restingDirectorState(seed);
      let t = 0;
      const clock = new OfflineClock({ fps: FPS });
      while (t < 7.0) {
        state = director.update(arcFrame(t), dt);
        clock.tick();
        t = clock.now();
      }

      const start = performance.now();
      for (let i = 0; i < frames; i++) {
        state = director.update(arcFrame(t), dt);
        preset!.update(arcFrame(t), t, dt, { director: state });
        clock.tick();
        t = clock.now();
      }
      // Force a present so all submitted GPU work is accounted for, then read the
      // wall-clock span. We divide by `frames` for the mean ms/frame.
      await present();
      const elapsed = performance.now() - start;
      return elapsed / frames;
    },
  };

  window.__cineHarness = harness;
  window.__cineHarnessReady = true;
}

boot().catch((err: unknown) => {
  window.__cineHarnessError = err instanceof Error ? err.message : String(err);
  window.__cineHarnessReady = true;
});
