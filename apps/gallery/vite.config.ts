import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        // The main gallery SPA.
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        // The V2-02 bloom verification harness (driven by e2e, not user-facing).
        "bloom-harness": fileURLToPath(new URL("./bloom-harness.html", import.meta.url)),
        // The V2-03 rich-primitives verification harness (e2e, not user-facing).
        "primitives-harness": fileURLToPath(new URL("./primitives-harness.html", import.meta.url)),
        // The V2-04 feedback / trail verification harness (e2e, not user-facing).
        "feedback-harness": fileURLToPath(new URL("./feedback-harness.html", import.meta.url)),
        // The V2-10 cinematic geometric verification harness (e2e, not user-facing).
        "geometric-harness": fileURLToPath(new URL("./geometric-harness.html", import.meta.url)),
      },
    },
  },
  test: {
    environment: "node",
    // Playwright specs under e2e/ are driven by `pnpm e2e`, not vitest.
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
