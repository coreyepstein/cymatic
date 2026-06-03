// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createParamSet,
  restingDirectorState,
  type ParamSchema,
  type ParamSet,
} from "@cymatic/core";

import { ControlPanel } from "./ControlPanel.js";

afterEach(cleanup);

/** A representative schema covering all three control kinds + grouping. */
const SCHEMA: readonly ParamSchema[] = [
  { key: "glow", label: "Glow", group: "Light", type: "number", min: 0, max: 1, step: 0.01, default: 0.5 },
  { key: "bloom", label: "Bloom", group: "Light", type: "number", min: 0, max: 2, step: 0.1, default: 1 },
  { key: "tint", label: "Tint", group: "Color", type: "color", default: "#ff8800" },
  {
    key: "mode",
    label: "Mode",
    group: "Color",
    type: "enum",
    default: "warm",
    options: [
      { value: "warm", label: "Warm" },
      { value: "cool", label: "Cool" },
    ],
  },
];

function makeParamSet(): ParamSet {
  return createParamSet(SCHEMA, {
    bindings: { glow: { source: "director", path: "intensity" } },
  });
}

function renderPanel(
  overrides: Partial<Parameters<typeof ControlPanel>[0]> = {},
): { paramSet: ParamSet; onSeedChange: ReturnType<typeof vi.fn>; onToggleDirector: ReturnType<typeof vi.fn> } {
  // Resolve a single, stable ParamSet instance the panel will poll for, so the
  // returned handle and the panel observe the same object.
  const paramSet = overrides.getParamSet ? (overrides.getParamSet() as ParamSet) : makeParamSet();
  const { getParamSet: _ignored, ...rest } = overrides;
  const onSeedChange = vi.fn();
  const onToggleDirector = vi.fn();
  render(
    <ControlPanel
      getParamSet={() => paramSet}
      director={restingDirectorState()}
      directorEnabled
      onToggleDirector={onToggleDirector}
      seed={42}
      onSeedChange={onSeedChange}
      {...rest}
    />,
  );
  return { paramSet, onSeedChange, onToggleDirector };
}

describe("ControlPanel", () => {
  it("renders one control per schema param, grouped", async () => {
    renderPanel();
    // The panel polls getParamSet on an interval; wait for the controls to mount.
    await waitFor(() => {
      expect(screen.getByTestId("param-glow")).toBeTruthy();
    });
    expect(screen.getByTestId("param-bloom")).toBeTruthy();
    expect(screen.getByTestId("param-tint")).toBeTruthy();
    expect(screen.getByTestId("param-mode")).toBeTruthy();

    // Groups render as titles.
    expect(screen.getByText("Light")).toBeTruthy();
    expect(screen.getByText("Color")).toBeTruthy();

    // Number → slider, color → color input, enum → dropdown.
    const glow = screen.getByTestId("param-glow");
    expect(glow.querySelector('input[type="range"]')).toBeTruthy();
    expect(screen.getByTestId("param-tint").querySelector('input[type="color"]')).toBeTruthy();
    expect(screen.getByTestId("param-mode").querySelector("select")).toBeTruthy();
  });

  it("moving a slider installs a manual override via setManual", async () => {
    const { paramSet } = renderPanel();
    await waitFor(() => expect(screen.getByTestId("param-glow")).toBeTruthy());

    const slider = screen
      .getByTestId("param-glow")
      .querySelector('input[type="range"]') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "0.9" } });

    const binding = paramSet.getBinding("glow");
    expect(binding?.source).toBe("manual");
    // The manual binding carries the slider value verbatim (resolved next frame).
    expect(binding?.source === "manual" ? binding.value : null).toBeCloseTo(0.9, 5);
  });

  it("changing the enum dropdown sets the manual value", async () => {
    const { paramSet } = renderPanel();
    await waitFor(() => expect(screen.getByTestId("param-mode")).toBeTruthy());

    const select = screen.getByTestId("param-mode").querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "cool" } });

    const binding = paramSet.getBinding("mode");
    expect(binding?.source).toBe("manual");
    expect(binding?.source === "manual" ? binding.value : null).toBe("cool");
  });

  it("reset-to-auto re-binds a manually overridden param to its default binding", async () => {
    const { paramSet } = renderPanel();
    await waitFor(() => expect(screen.getByTestId("param-glow")).toBeTruthy());

    // Override, then click Auto to revert to the captured default binding.
    const slider = screen
      .getByTestId("param-glow")
      .querySelector('input[type="range"]') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "0.1" } });
    expect(paramSet.getBinding("glow")?.source).toBe("manual");

    const autoBtn = screen
      .getByTestId("param-glow")
      .querySelector("button.mode-btn") as HTMLButtonElement;
    fireEvent.click(autoBtn);

    expect(paramSet.getBinding("glow")?.source).toBe("director");
  });

  it("randomize installs manual overrides for every param", async () => {
    const { paramSet } = renderPanel();
    // Wait until the controls actually mount (the button exists even while the
    // ParamSet is still loading, just disabled), then randomize.
    await waitFor(() => expect(screen.getByTestId("param-glow")).toBeTruthy());

    fireEvent.click(screen.getByTestId("randomize"));

    for (const key of ["glow", "bloom", "tint", "mode"]) {
      expect(paramSet.getBinding(key)?.source).toBe("manual");
    }
    // The randomized number stays within range.
    const glowBinding = paramSet.getBinding("glow");
    const glow = glowBinding?.source === "manual" ? (glowBinding.value as number) : NaN;
    expect(glow).toBeGreaterThanOrEqual(0);
    expect(glow).toBeLessThanOrEqual(1);
  });

  it("director toggle calls back, and the seed input forwards changes", async () => {
    const { onToggleDirector, onSeedChange } = renderPanel();

    const toggle = screen.getByLabelText("Auto-director") as HTMLInputElement;
    fireEvent.click(toggle);
    expect(onToggleDirector).toHaveBeenCalledWith(false);

    const seedInput = screen.getByLabelText("Director seed") as HTMLInputElement;
    fireEvent.change(seedInput, { target: { value: "1234" } });
    expect(onSeedChange).toHaveBeenCalledWith(1234);
  });

  it("shows the live director section + palette in the HUD", () => {
    renderPanel();
    // The resting state is the intro section.
    expect(screen.getByTestId("hud-section").textContent?.toLowerCase()).toContain("intro");
    expect(screen.getByTestId("hud-palette")).toBeTruthy();
  });

  it("collapses to free up the canvas", () => {
    renderPanel();
    const toggle = screen.getByLabelText(/collapse control panel/i);
    fireEvent.click(toggle);
    // Collapsed: the parameter section is unmounted.
    expect(screen.queryByTestId("randomize")).toBeNull();
  });

  it("handles a preset with no params gracefully", async () => {
    const empty = createParamSet([]);
    renderPanel({ getParamSet: () => empty });
    await waitFor(() => {
      expect(screen.getByText(/exposes no parameters/i)).toBeTruthy();
    });
  });
});
