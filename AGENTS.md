# Octane Xplat Tweaks

Live-tweakable values (`useTweak`) for Octane Xplat apps, edited from a desktop
panel, written back to source only on Save.

## Layout

- `packages/tweaks` — `@octane-xplat/tweaks`: runtime hook + shared protocol
  types. Ships source (`src/`) with `web`/`native`/`default` export conditions,
  like framework leaf packages. Hook code lives in `.tsx`.
- `packages/vite` — `@octane-xplat/tweaks-vite`: Vite plugin (Node only). Emits
  JS to `dist/` with tsc. Plugin goes **before** the Octane plugins.
- `apps/playground` — private web app used for e2e verification.
- `links` — `dev:octane` pnpmfile hook + tests.

## Commands

```sh
pnpm install
pnpm dev:octane        # link framework packages to links/octane-xplat checkout
pnpm dev:published     # revert a dev:octane install back to published packages
pnpm test              # unit tests (node --test, TS type stripping)
pnpm typecheck         # all packages
pnpm build             # emit packages/vite dist + tweaks types
pnpm --filter playground dev    # playground dev server
pnpm --filter playground test:e2e  # Playwright e2e (needs playwright chromium)
```

## Conventions

- pnpm only; exact pins; workspace deps use `workspace:*`.
- `.ts`/`.mts` test and source files must stay erasable-syntax (Node ≥22.18
  type stripping): no enums, namespaces, parameter properties.
- Protocol contract lives in `packages/tweaks/src/protocol.ts`; the plugin and
  the future panel both import it from `@octane-xplat/tweaks/protocol`.
