# Contributing to cymatic

Thanks for your interest in cymatic. This guide covers the repo layout, local
dev setup, the test expectations every change must meet, and the one hard rule
on preset naming.

## Monorepo layout

cymatic is a pnpm + Turborepo monorepo. Code lives in two trees:

```
packages/
  core/      @cymatic/core     — the engine: audio analysis (FFT bands, RMS,
                                 onset/beat detection), the backend-agnostic
                                 Renderer (WebGPU → WebGL), primitives, and the
                                 preset/layer contract. No React, no DOM at
                                 import time. The source of truth for the API.
  react/     @cymatic/react    — a thin, SSR-safe React wrapper: the <Visualizer/>
                                 component and the useVisualizer / useAudioFeatures
                                 hooks. All rendering and DSP stays in core.
  presets/   @cymatic/presets  — the bundled preset packs (geometric, color-field,
                                 generative, particle), authored only against the
                                 public core surface.
  export/    @cymatic/export   — the deterministic offline render-to-file pipeline
                                 (renderOffline + frame sinks); audio is muxed on
                                 with ffmpeg (see packages/export/AUDIO-MUX.md).

apps/
  gallery/   @cymatic/gallery  — a live demo app (preset switcher + drag-and-drop
                                 audio + mic). Not published.
```

Dependency direction is one-way: `react`, `presets`, and `export` all depend on
`core`; `core` depends on nothing internal. Keep it that way — anything
backend- or React-agnostic belongs in `core`.

## Dev setup

You need Node and [pnpm](https://pnpm.io). From the repo root:

```sh
pnpm install      # install all workspace deps
pnpm build        # turbo run build — builds every package in dependency order
pnpm test         # turbo run test — runs the unit suites
pnpm typecheck    # turbo run typecheck
pnpm lint         # turbo run lint
```

These root scripts fan out across the workspace via Turborepo. To work on a
single package, use a pnpm filter, e.g. `pnpm --filter @cymatic/core test`.

Formatting is Prettier: `pnpm format` writes, `pnpm format:check` verifies.

## Running the gallery

The gallery is the fastest way to see a change end-to-end. Build the packages
first (it consumes their workspace builds), then start the dev server:

```sh
pnpm install
pnpm build
pnpm --filter @cymatic/gallery dev
```

Vite serves it locally (it prints the URL). The gallery has a preset switcher,
drag-and-drop audio, and a mic toggle, so you can exercise every input path and
every preset against real audio. Its Playwright e2e lives in
`apps/gallery/e2e` (`pnpm --filter @cymatic/gallery e2e`).

## Test expectations

Tests run with [Vitest](https://vitest.dev) (`vitest run`); the gallery adds
Playwright for end-to-end coverage.

- **Every change ships with tests.** Bug fixes ship a regression test that fails
  before the fix and passes after. New behavior ships unit coverage.
- **The DSP and primitives are pure and Node-testable.** Audio features, beat
  detection, easing, palettes, bindings, the preset/layer contract, and the
  offline driver all run without a browser or GPU — test them directly with
  deterministic inputs. (See the `*.test.ts` files colocated with each module,
  e.g. `packages/presets/src/geometric/geometric.test.ts`.)
- **Presets are tested behaviorally**, not pixel-for-pixel: assert the response
  curve (e.g. "more bass → strictly more X", "a beat injects a flash"), not exact
  colors. Export determinism is tested by asserting identical output across two
  runs with identical input.
- **Never loosen an assertion or skip a failing test to get green.** Fix the root
  cause. No `test.skip`, no weakened expectations, no false positives — unit,
  integration, and e2e are held to the same bar.
- The full gate before a PR is `pnpm build && pnpm typecheck && pnpm lint &&
  pnpm test` from the root, all passing.

## Authoring presets

See [docs/authoring-a-preset.md](./docs/authoring-a-preset.md) for the
`definePreset` / `composePreset` API, the primitives, and audio bindings. New
presets go in the matching pack under `packages/presets/src/` and register into
the shared registry via their pack's `registerX` helper.

### Preset naming

This is a hard rule, enforced in review:

> Preset ids and names reference **movements, styles, or techniques** — never
> trademarks or the names of living artists.

- **Good:** `geometric.op-grid` ("Op Grid"), `colorfield.field` ("Field"),
  `generative.flow-field` ("Flow Field"), `particle.fluid` ("Fluid"). These name
  a technique or movement (Op art, color-field painting, flow fields, fluid
  advection).
- **Not allowed:** any registered trademark, brand, or product name, and the
  name of any living artist — as an id, a display name, a description, or a
  tag. Historical movements and public-domain techniques are fine; trading on a
  specific person's or company's identity is not.

When in doubt, name the **technique** the preset uses, not the artist who made
it famous.

## Pull requests

- Branch from `main`; keep the change focused.
- Run the full gate (build / typecheck / lint / test) locally before opening the
  PR — CI runs the same.
- Describe the behavior change and link any related issue. Include a short note
  on how you tested it (which preset, which input path).
