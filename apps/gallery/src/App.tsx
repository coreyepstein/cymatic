import type { JSX } from "react";

import { version as coreVersion } from "@cymatic/core";
import { presetIds } from "@cymatic/presets";
import { version as reactBindingsVersion } from "@cymatic/react";

export function App(): JSX.Element {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        fontFamily: "system-ui, sans-serif",
        background: "#0b0b0f",
        color: "#f4f4f5",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <h1 style={{ fontWeight: 600, letterSpacing: "-0.02em" }}>cymatic</h1>
        <p style={{ opacity: 0.7 }}>A tasteful web audio visualizer. Gallery coming soon.</p>
        <p style={{ opacity: 0.5, fontSize: "0.85rem" }}>
          core {coreVersion} · react {reactBindingsVersion} · {presetIds.length} presets
        </p>
      </div>
    </main>
  );
}
