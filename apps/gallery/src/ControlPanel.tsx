/**
 * The gallery control panel + director HUD (V2-14).
 *
 * Drives the active preset's live look entirely through the core controllers —
 * it owns no param/director logic of its own:
 *
 *  - **Parameter panel**: auto-introspects the preset's {@link ParamSet} schema
 *    and renders one control per param (number → slider, color → picker, enum →
 *    dropdown), grouped by `group`. Each control writes through
 *    `paramSet.setManual(key, value)`.
 *  - **Per-param mode**: Auto (the preset's default binding drives it) vs Manual
 *    (the control's value overrides automation, which the resolver supports).
 *    "Auto" re-binds the param to its captured default binding.
 *  - **Randomize / Seed**: randomize sets a manual value within range for every
 *    param; the seed control reseeds the director (via the parent) so the
 *    generated look re-rolls.
 *  - **Director HUD**: an on/off toggle plus a live read-out of section,
 *    intensity, energy/brightness (mood), and the current palette.
 *
 * It re-renders on a light interval to pick up the freshly-mounted ParamSet and
 * the latest resolved values, and on each (throttled) director-state tick for
 * the HUD. No browser globals are touched at import time.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";

import {
  numberRange,
  optionLabel,
  PALETTE_NAMES,
  type DirectorState,
  type ParamBinding,
  type ParamBindings,
  type ParamSchema,
  type ParamSet,
} from "@cymatic/core";

/** A deterministic, dependency-free PRNG for the Randomize button. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Round to the param's step grid (purely cosmetic for sliders). */
function snap(value: number, step: number | undefined): number {
  if (!step || step <= 0) return value;
  return Math.round(value / step) * step;
}

/** Group schema params by their `group` (preserving first-seen order). */
function groupSchema(
  schema: readonly ParamSchema[],
): readonly { group: string; params: readonly ParamSchema[] }[] {
  const order: string[] = [];
  const byGroup = new Map<string, ParamSchema[]>();
  for (const p of schema) {
    const g = p.group ?? "Parameters";
    if (!byGroup.has(g)) {
      byGroup.set(g, []);
      order.push(g);
    }
    byGroup.get(g)!.push(p);
  }
  return order.map((group) => ({ group, params: byGroup.get(group)! }));
}

export interface ControlPanelProps {
  /**
   * A getter for the active preset's {@link ParamSet}. A getter (not the value)
   * because the host surfaces it through an imperative ref that does not
   * re-render; the panel polls it to detect a freshly-mounted preset.
   */
  getParamSet: () => ParamSet | null;
  /** The current live director state for the HUD (or `null` before the first frame). */
  director: DirectorState | null;
  /** Whether the auto-director is enabled. */
  directorEnabled: boolean;
  /** Toggle the auto-director. */
  onToggleDirector: (enabled: boolean) => void;
  /** The current director seed. */
  seed: number;
  /** Set the director seed (reseeds the live director / preset RNG). */
  onSeedChange: (seed: number) => void;
}

/** A pretty title-case label from a director section / palette key. */
function pretty(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

export function ControlPanel(props: ControlPanelProps): JSX.Element {
  const {
    getParamSet,
    director,
    directorEnabled,
    onToggleDirector,
    seed,
    onSeedChange,
  } = props;

  const [collapsed, setCollapsed] = useState(false);

  // The panel does not own the ParamSet — it polls the host-provided getter so
  // it picks up the instance once the preset mounts (and clears it on switch).
  const [paramSet, setParamSet] = useState<ParamSet | null>(null);
  // A monotonically increasing tick forces a re-read of resolved values so the
  // live "Auto" values animate in the read-outs without per-frame re-renders.
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      const next = getParamSet();
      setParamSet((prev) => (prev === next ? prev : next));
      setTick((t) => (t + 1) % 1_000_000);
    }, 250);
    return () => window.clearInterval(id);
  }, [getParamSet]);

  // Capture each param's *default* binding the first time we see a ParamSet, so
  // "reset to auto" can re-point a manually-overridden param at its original
  // source. Keyed by the ParamSet identity so a preset switch re-captures.
  const defaultsRef = useRef<{
    set: ParamSet | null;
    bindings: ParamBindings;
  }>({ set: null, bindings: {} });
  if (paramSet && defaultsRef.current.set !== paramSet) {
    defaultsRef.current = { set: paramSet, bindings: paramSet.getBindings() };
  }

  const schema = useMemo<readonly ParamSchema[]>(
    () => paramSet?.getSchema() ?? [],
    [paramSet],
  );
  const groups = useMemo(() => groupSchema(schema), [schema]);

  /** True when `key` currently carries a manual override. */
  const isManual = useCallback(
    (key: string): boolean => paramSet?.getBinding(key)?.source === "manual",
    [paramSet],
  );

  const setManual = useCallback(
    (key: string, value: number | string): void => {
      paramSet?.setManual(key, value);
      setTick((t) => (t + 1) % 1_000_000);
    },
    [paramSet],
  );

  /** Re-bind `key` to its captured default binding (revert to auto). */
  const resetToAuto = useCallback(
    (key: string): void => {
      if (!paramSet) return;
      const original: ParamBinding | undefined =
        defaultsRef.current.bindings[key];
      if (original) paramSet.bind(key, original);
      else paramSet.unbind(key);
      setTick((t) => (t + 1) % 1_000_000);
    },
    [paramSet],
  );

  const randomize = useCallback((): void => {
    if (!paramSet) return;
    const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
    for (const p of schema) {
      if (p.type === "number") {
        const [min, max] = numberRange(p);
        setManual(p.key, snap(min + rng() * (max - min), p.step));
      } else if (p.type === "enum") {
        const i = Math.floor(rng() * p.options.length) % p.options.length;
        setManual(p.key, p.options[i]!.value);
      } else {
        // color → a random hex.
        const hex = Math.floor(rng() * 0xffffff)
          .toString(16)
          .padStart(6, "0");
        setManual(p.key, `#${hex}`);
      }
    }
  }, [paramSet, schema, seed, setManual]);

  const resetAll = useCallback((): void => {
    for (const p of schema) resetToAuto(p.key);
  }, [schema, resetToAuto]);

  const shuffleSeed = useCallback((): void => {
    onSeedChange(Math.floor(Math.random() * 0xffffffff) >>> 0);
  }, [onSeedChange]);

  // ---- HUD read-outs --------------------------------------------------------
  const hud = director;
  const paletteName = hud
    ? (PALETTE_NAMES[hud.paletteIndex % PALETTE_NAMES.length] ?? "—")
    : "—";

  return (
    <div className={`panel${collapsed ? " collapsed" : ""}`} data-testid="control-panel">
      <div className="panel-header">
        <span className="panel-title">Director &amp; Params</span>
        <button
          type="button"
          className="panel-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand control panel" : "Collapse control panel"}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? "▸" : "▾"}
        </button>
      </div>

      {!collapsed ? (
        <div className="panel-body">
          {/* ---- Director controls + HUD ---- */}
          <section className="panel-section" data-testid="director-hud">
            <div className="panel-section-head">
              <span>Director</span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={directorEnabled}
                  onChange={(e) => onToggleDirector(e.target.checked)}
                  aria-label="Auto-director"
                />
                <span className="switch-track" aria-hidden="true" />
                <span className="switch-label">{directorEnabled ? "Auto" : "Off"}</span>
              </label>
            </div>

            <div className="hud">
              <div className="hud-row">
                <span className="hud-key">Section</span>
                <span className="hud-val hud-section" data-testid="hud-section">
                  {hud ? pretty(hud.section) : "—"}
                </span>
              </div>
              <Meter label="Intensity" value={hud?.intensity ?? 0} testid="hud-intensity" />
              <Meter
                label="Energy"
                value={director ? clamp01(directorEnergy(director)) : 0}
                testid="hud-energy"
              />
              <Meter
                label="Brightness"
                value={director ? clamp01(director.contrast) : 0}
                testid="hud-brightness"
              />
              <Meter label="Motion" value={hud ? clamp01((hud.motion - 0.5) / 1.5) : 0} />
              <div className="hud-row">
                <span className="hud-key">Palette</span>
                <span className="hud-val hud-palette" data-testid="hud-palette">
                  {pretty(paletteName)}
                </span>
              </div>
            </div>

            <div className="seed-row">
              <label className="seed-label" htmlFor="director-seed">
                Seed
              </label>
              <input
                id="director-seed"
                className="seed-input"
                type="number"
                value={seed}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) onSeedChange(v >>> 0);
                }}
                aria-label="Director seed"
              />
              <button type="button" className="mini-btn" onClick={shuffleSeed}>
                Shuffle
              </button>
            </div>
          </section>

          {/* ---- Parameter panel ---- */}
          <section className="panel-section">
            <div className="panel-section-head">
              <span>Parameters</span>
              <div className="param-actions">
                <button
                  type="button"
                  className="mini-btn"
                  onClick={randomize}
                  disabled={schema.length === 0}
                  data-testid="randomize"
                >
                  Randomize
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={resetAll}
                  disabled={schema.length === 0}
                >
                  Reset all
                </button>
              </div>
            </div>

            {schema.length === 0 ? (
              <p className="panel-empty">This preset exposes no parameters.</p>
            ) : (
              groups.map(({ group, params }) => (
                <div className="param-group" key={group}>
                  <div className="param-group-title">{group}</div>
                  {params.map((p) => (
                    <ParamControl
                      key={p.key}
                      schema={p}
                      manual={isManual(p.key)}
                      value={paramSet?.get(p.key)}
                      onManual={(v) => setManual(p.key, v)}
                      onReset={() => resetToAuto(p.key)}
                    />
                  ))}
                </div>
              ))
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * The director does not expose a single "energy" field; its intensity already
 * folds in live energy. We surface intensity as the headline and derive a
 * secondary energy read-out from the bloom signal (which tracks loudness) so the
 * HUD shows a couple of distinct macros evolving.
 */
function directorEnergy(d: DirectorState): number {
  return d.bloom;
}

interface MeterProps {
  label: string;
  value: number;
  testid?: string;
}

/** A labeled 0–1 bar read-out. */
function Meter({ label, value, testid }: MeterProps): JSX.Element {
  const pct = Math.round(clamp01(value) * 100);
  return (
    <div className="hud-row">
      <span className="hud-key">{label}</span>
      <span className="meter" data-testid={testid}>
        <span className="meter-fill" style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

interface ParamControlProps {
  schema: ParamSchema;
  manual: boolean;
  value: number | string | undefined;
  onManual: (value: number | string) => void;
  onReset: () => void;
}

/** One auto-rendered control for a single param, with an Auto/Manual mode toggle. */
function ParamControl({
  schema,
  manual,
  value,
  onManual,
  onReset,
}: ParamControlProps): JSX.Element {
  const mode = manual ? "manual" : "auto";

  return (
    <div className={`param${manual ? " manual" : ""}`} data-testid={`param-${schema.key}`}>
      <div className="param-head">
        <label className="param-label" htmlFor={`param-${schema.key}`}>
          {schema.label}
        </label>
        <div className="param-mode">
          <button
            type="button"
            className={`mode-btn${mode === "auto" ? " active" : ""}`}
            onClick={onReset}
            aria-pressed={mode === "auto"}
            title="Re-bind to the preset's default (audio/director)"
          >
            Auto
          </button>
          <span className={`mode-btn${mode === "manual" ? " active" : ""}`} aria-hidden="true">
            Manual
          </span>
        </div>
      </div>

      {schema.type === "number" ? (
        <NumberControl schema={schema} value={value} onManual={onManual} />
      ) : schema.type === "color" ? (
        <ColorControl schema={schema} value={value} onManual={onManual} />
      ) : (
        <EnumControl schema={schema} value={value} onManual={onManual} />
      )}
    </div>
  );
}

function NumberControl({
  schema,
  value,
  onManual,
}: {
  schema: Extract<ParamSchema, { type: "number" }>;
  value: number | string | undefined;
  onManual: (value: number) => void;
}): JSX.Element {
  const [min, max] = numberRange(schema);
  const step = schema.step ?? ((max - min) / 100 || 0.01);
  const num = typeof value === "number" ? value : schema.default;
  return (
    <div className="param-row">
      <input
        id={`param-${schema.key}`}
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={num}
        onChange={(e) => onManual(Number(e.target.value))}
        aria-label={schema.label}
      />
      <span className="param-value">
        {Number.isInteger(num) ? num : num.toFixed(3)}
      </span>
    </div>
  );
}

function ColorControl({
  schema,
  value,
  onManual,
}: {
  schema: Extract<ParamSchema, { type: "color" }>;
  value: number | string | undefined;
  onManual: (value: string) => void;
}): JSX.Element {
  const color = typeof value === "string" ? value : schema.default;
  return (
    <div className="param-row">
      <input
        id={`param-${schema.key}`}
        className="color-input"
        type="color"
        value={normalizeHex(color)}
        onChange={(e) => onManual(e.target.value)}
        aria-label={schema.label}
      />
      <span className="param-value mono">{color}</span>
    </div>
  );
}

function EnumControl({
  schema,
  value,
  onManual,
}: {
  schema: Extract<ParamSchema, { type: "enum" }>;
  value: number | string | undefined;
  onManual: (value: string) => void;
}): JSX.Element {
  const current = typeof value === "string" ? value : schema.default;
  return (
    <div className="param-row">
      <select
        id={`param-${schema.key}`}
        className="dropdown"
        value={current}
        onChange={(e) => onManual(e.target.value)}
        aria-label={schema.label}
      >
        {schema.options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {optionLabel(opt)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Coerce an arbitrary CSS color string into a `#rrggbb` the picker accepts. */
function normalizeHex(input: string): string {
  const s = input.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  return "#7c7cff";
}
