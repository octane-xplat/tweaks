# Develop against a local Octane checkout

The default install uses published `@octane-xplat/*` packages. To use a local
Octane checkout, run from this repository root:

```sh
pnpm -C /path/to/octane-xplat install
pnpm -C /path/to/octane-xplat exec turbo run build --filter=@octane-xplat/cli --filter=@octane-xplat/lint
ln -s /path/to/octane-xplat links/octane-xplat
pnpm dev:octane
```

Replace `/path/to/octane-xplat` with your checkout path. The link is ignored by
Git. `dev:octane` prints its effective dependency changes, then installs a local
mirror without changing `package.json`, `pnpm-workspace.yaml`, or the committed
lockfile:

- Framework packages declared by any workspace member link to the matching
  checkout packages. `workspace:*` deps between this repo's own packages stay
  internal.
- Shared external dependencies follow the checkout's workspace catalog, mobile
  app, and declared framework package manifests. Its compatibility manifest
  supplies remaining managed pins. Dependencies used only by this repo stay as
  declared.
- Framework patches come from the checkout's `patchedDependencies`, with paths
  resolved against that checkout. Published framework patch entries are replaced;
  app-owned patches remain.
- Dependency overrides and explicit release-age exceptions come from the
  checkout. Conflicting overrides, external versions, app/framework patches,
  missing patches, or mismatched package names fail the install.
- If any workspace manifest still declares the old
  `@triniwiz/nativescript-masonkit` name (NativeScript plugin discovery), the
  hook aliases it to the checkout's `@octane-xplat/nativescript-masonkit` pin.

The checkout must have its own dependencies installed first; the hook uses its
`yaml` parser. Re-run `pnpm dev:octane` after updating the checkout to refresh
the mirror. Lifecycle scripts are skipped.

Verify the installed package links with:

```sh
realpath node_modules/@octane-xplat/ui apps/playground/node_modules/@octane-xplat/ui
```

Every path should be under your checkout. To restore the published packages,
run `pnpm dev:published`. It retries `pnpm install --frozen-lockfile` and, if
version-satisfied `link:` installs remain (pnpm does not revert them on its
own), removes the workspace's generated node_modules directories first. Ordinary installs and CI do not select the
local hook. The link can stay in place; remove it with
`unlink links/octane-xplat` when no longer needed.

Run the local-hook regression tests after installing dependencies:

```sh
node --test links/octane-config.test.cjs
```
