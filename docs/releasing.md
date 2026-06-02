# Releasing cymatic

This repo publishes four public packages to npm under the `@cymatic/*` scope:

- `@cymatic/core`
- `@cymatic/presets`
- `@cymatic/react`
- `@cymatic/export`

The gallery app (`@cymatic/gallery`) is `"private": true` and is **never**
published.

Versioning is managed with [changesets](https://github.com/changesets/changesets).
The four public packages are **linked** (see `.changeset/config.json`), so they
always version in lockstep: any release bumps all four to the same version, even
if only one package changed. This keeps the published surface coherent — a user
on `@cymatic/react@1.2.0` can rely on `@cymatic/core@1.2.0` existing.

## TL;DR

```sh
# 1. While working: describe your change for the changelog
pnpm changeset

# 2. When ready to cut a release (usually on main): apply the bumps
pnpm changeset version

# 3. Commit the version bumps + changelogs, then tag and push
git commit -am "release: vX.Y.Z"
git tag vX.Y.Z
git push && git push --tags
```

Pushing the `vX.Y.Z` tag triggers `.github/workflows/release.yml`, which builds,
re-runs the full gate, and publishes all four packages to npm with provenance.

## Step by step

### 1. Add a changeset for your change

After making a change that should ship, run:

```sh
pnpm changeset
```

This prompts for which packages changed and the bump type (patch / minor /
major), then writes a markdown file to `.changeset/`. Commit that file with your
PR. Because the packages are linked, picking a bump for one effectively sets the
floor for all four — but still pick the bump that honestly describes *your*
change; changesets picks the highest across the linked group.

If a change genuinely needs no release (docs, CI, internal refactor), record
that explicitly so `changeset status` stays clean:

```sh
pnpm changeset --empty
```

### 2. Version the packages

When you're ready to cut a release (typically from an up-to-date `main`):

```sh
pnpm changeset version
```

This consumes all pending changeset files, bumps the four package versions in
lockstep, updates internal `workspace:*` dependency ranges, and writes
`CHANGELOG.md` entries. Review the diff.

### 3. Commit, tag, and push

```sh
git commit -am "release: vX.Y.Z"   # use the new version from package.json
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

### 4. CI publishes

The push of the `vX.Y.Z` tag triggers the **Release** workflow
(`.github/workflows/release.yml`). It:

1. Skips entirely unless the `NPM_TOKEN` repository secret is configured (so
   forks and token-less clones never fail red).
2. Installs with the frozen lockfile and runs `pnpm build`.
3. Re-runs the full gate: `pnpm typecheck`, `pnpm lint`, `pnpm test`.
4. Publishes the public packages with:

   ```sh
   pnpm -r --filter '!@cymatic/gallery' publish --access public --provenance --no-git-checks
   ```

   `@cymatic/gallery` is private and skipped automatically; the filter is
   belt-and-suspenders. `--provenance` plus the workflow's
   `permissions: { id-token: write }` attaches a signed
   [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
   statement linking each published tarball back to this repo and the
   triggering workflow run.

The workflow also triggers on a published GitHub Release, so you can drive a
release from the GitHub UI instead of pushing a tag if you prefer.

## Required repository setup

- **`NPM_TOKEN`** — a repository secret holding an npm
  [automation token](https://docs.npmjs.com/creating-and-viewing-access-tokens)
  with publish rights to the `@cymatic` scope. Without it the workflow is a
  no-op.
- The publishing npm account/org must allow the OIDC-based provenance flow
  (default for public packages on npm).

## Verifying locally before a release (dry run)

You can validate the publishable file set for all four public packages without
publishing anything:

```sh
pnpm build
pnpm -r --filter '!@cymatic/gallery' publish --dry-run --no-git-checks
```

This packs each public package and reports the files that would be published,
without contacting the registry to actually publish. Confirm each tarball
contains only `dist/` (plus the implicit `package.json`, `README`, `LICENSE`).

## Notes

- Provenance is also declared per-package in each public `package.json` via
  `publishConfig: { "access": "public", "provenance": true }`, so an ad-hoc
  `pnpm publish` from a maintainer machine carries the same metadata.
- `.npmrc` sets `minimum-release-age=1440`, delaying *installation* of npm
  releases newer than 24h. This is an install-side supply-chain guard and does
  not affect our own publishes.
