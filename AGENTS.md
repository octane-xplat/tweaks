# Octane Xplat Tweaks

Live-tweakable values (`useTweak`) for Octane Xplat apps, edited from a desktop
panel, written back to source only on Save.

## Layout

- `packages/tweaks` — `@octane-xplat/tweaks`: runtime hook + shared protocol
  types, plus the Vite plugin at the `./vite` subpath (`src/vite/`, Node only,
  emitted JS to `dist/vite/` via `tsconfig.vite.build.json`; plugin goes
  **before** the Octane plugins). Ships source (`src/`) with
  `web`/`native`/`default` export conditions, like framework leaf packages.
  Hook code lives in `.tsx`.
- `apps/playground` — private web app used for e2e verification.
- `apps/desktop` — private panel app (`@octane-xplat/tweaks-desktop`): shared
  UI for the macOS AppKit renderer (JSC host) and a web build used for e2e.
- `links` — `dev:octane` pnpmfile hook + tests.

## Commands

```sh
pnpm install
pnpm dev:octane        # link framework packages to links/octane-xplat checkout
pnpm dev:published     # revert a dev:octane install back to published packages
pnpm test              # unit tests (node --test, TS type stripping)
pnpm typecheck         # all packages
pnpm build             # tweaks typegen + emit packages/tweaks dist/vite
pnpm --filter playground dev    # playground dev server
pnpm --filter playground test:e2e  # Playwright e2e (needs playwright chromium)
pnpm --filter @octane-xplat/tweaks-desktop dev:web   # panel web build :5211
pnpm --filter @octane-xplat/tweaks-desktop dev       # macOS app via xplat dev
pnpm --filter @octane-xplat/tweaks-desktop build     # packaged .app → artifacts/
pnpm --filter @octane-xplat/tweaks-desktop test:e2e  # panel web e2e
pnpm test:ios            # iOS simulator verification: scaffolds the pinned
                         # create-octane-xplat template into artifacts/ios/,
                         # packs+installs the tweaks packages, applies
                         # fixtures/ios-app, runs xplat dev <UDID> + assertions
                         # (`--app <dir>` reuses a prepared app)
pnpm test:android        # Android emulator verification: same flow into
                         # artifacts/android/ with --targets=android, reusing
                         # fixtures/ios-app; boots the first octane* AVD
                         # (ANDROID_AVD/ANDROID_SERIAL override), runs
                         # xplat dev <serial> + assertions. Self-wraps in a
                         # goddard resource reservation (android:<AVD>)
                         # unless GODDARD_RESOURCE_RESERVATION is set.
```

## Conventions

- pnpm only; exact pins; workspace deps use `workspace:*`.
- `.ts`/`.mts` test and source files must stay erasable-syntax (Node ≥22.18
  type stripping): no enums, namespaces, parameter properties.
- Protocol contract lives in `packages/tweaks/src/protocol.ts`; the plugin and
  the future panel both import it from `@octane-xplat/tweaks/protocol`.

Styles: `src/vite` also extracts static CSS — bamboo `css({…})` calls in
`.ts`/`.tsx` and inline `style={{…}}` in `.tsx`/`.tsrx` — into a style
manifest. Style drafts edit live (inline via `useTweakStyles`/`__tw` from
`@octane-xplat/tweaks/dev`; bamboo via `__twCss` marker classes + a web
MutationObserver leaf) and are written back on Save through `planStyleEdit`.
Bamboo preview compiles drafts through `loadConfigAndCreateContext` in-memory
(optional `@bamboocss/node`, degrades to `preview:'unavailable'`); the native
`__twCss` leaf is a pass-through — bamboo sites mount on web only. Protocol v3 adds `pick`/`picked` for web
click-to-pick (`state.picking`; panel filter via `pickFilter`).
