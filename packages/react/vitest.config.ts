import { defineConfig } from "vitest/config";

/**
 * The React bindings are exercised under jsdom (component mount/unmount via
 * @testing-library/react). Only this package opts into jsdom; the rest of the
 * monorepo stays on the default node environment.
 *
 * The SSR-safety test (`ssr-safety.test.ts`) overrides this back to `node` via
 * a per-file `// @vitest-environment node` pragma so it asserts the module
 * imports cleanly with no DOM present.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: false,
  },
});
