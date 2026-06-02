/**
 * Builds a minimal copy-paste install + usage snippet for a given preset id.
 * Kept pure (no DOM) so it is trivially unit-testable.
 */

/** Convert a preset id like `geometric.op-grid` to a valid identifier. */
export function presetIdentifier(id: string): string {
  const camel = id
    .replace(/[^a-zA-Z0-9]+(.)?/g, (_m, chr: string | undefined) =>
      chr ? chr.toUpperCase() : "",
    )
    .replace(/^[^a-zA-Z_$]+/, "");
  return camel.length > 0 ? camel : "preset";
}

/** A minimal React usage example referencing the selected preset's id. */
export function buildSnippet(presetId: string): string {
  return `# install
npm i @cymatic/react @cymatic/presets

# usage (React)
import { Visualizer } from "@cymatic/react";
import { defaultPresetRegistry } from "@cymatic/core";
import "@cymatic/presets"; // registers all presets by id

const preset = defaultPresetRegistry.create("${presetId}");

export function MyVisualizer() {
  return <Visualizer preset={preset} microphone />;
}`;
}
