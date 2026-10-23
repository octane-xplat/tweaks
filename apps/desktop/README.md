# Octane Tweaks — desktop panel

Desktop companion app for `@octane-xplat/tweaks`: connects to a dev server's
`/__octane_tweaks` websocket, lists the mounted `useTweak` entries, edits them
live, and sends `save` / `revert`. Same shared UI runs on macOS (experimental
AppKit renderer, JSC host) and in a browser (used for e2e).

## Layout

- `src/model.ts` — pure panel model (connection state, latest `state` message,
  input→send validation, dirty counting incl. `unmountedDirty`, save results,
  reconnect backoff). Unit-tested with `node --test`.
- `src/transport.macos.ts` — WebSocket client over `NWConnection`
  (Network.framework). The JSC host has no `WebSocket`, and
  `NSURLSessionWebSocketTask` is unreachable through the bundled node-api
  metadata (`webSocketTaskWithURL` returns an object with the plain
  `NSURLSessionTask` prototype — no ws selectors). Handshake + frame codec are
  implemented by hand; local `ws://` only, no TLS.
- `src/transport.web.ts` — browser `WebSocket`.
- `src/servers.macos.ts` — polls `~/.octane-xplat/tweaks/servers/*.json` (2s)
  via NSFileManager/NSString.
- `src/servers.web.ts` — single server from `?url=…&token=…` query params.
- `src/window.macos.ts` / `window.web.ts` — keep-on-top (NSWindow level); the
  toggle is hidden on web.
- `src/App.tsrx` — shared panel UI (`@octane-xplat/ui` components with macOS
  leaves; state via `createStore`/`useStore` from `@octane-xplat/ui/data`).
- `src/main.macos.ts` — window creation (~380×720, "Octane Tweaks"), root
  mount/unmount, terminate on last window close, `TWEAKS_PANEL_SELFTEST` hook.
- `src/main.web.tsrx` + `index.html` — web build entry.
- `link-host-deps.mjs` — postinstall that materializes `app/node_modules/
  {vite,octane,@nativescript/macos-node-api}` symlinks (the CLI resolves those
  literally; pnpm's hoisted linker doesn't create member dep dirs).

## Run

```sh
pnpm install                              # also runs link-host-deps.mjs
pnpm --filter playground dev              # a dev server to connect to (port 5200)

# Browser build (fast iteration, used by e2e):
pnpm --filter @octane-xplat/tweaks-desktop dev:web
# open http://localhost:5211/?url=ws://127.0.0.1:5200/__octane_tweaks&token=…

# macOS app (Apple Silicon):
pnpm --filter @octane-xplat/tweaks-desktop xplat doctor
pnpm --filter @octane-xplat/tweaks-desktop dev          # xplat dev macos
pnpm --filter @octane-xplat/tweaks-desktop build        # packaged .app + dmg → artifacts/
```

## Verify

- `node --test apps/desktop/test/model.test.mts` — model unit tests.
- `node test/e2e.mjs` — Chromium e2e: playground + panel web server, drives the
  real panel UI (slider/switch/select/color, mounted filtering,
  unmounted-dirty footer, Save writeback + app state preservation).
- `TWEAKS_PANEL_SELFTEST=1 ./artifacts/macos-arm64/OctaneTweaks.app/Contents/MacOS/OctaneTweaks`
  — dev-only hook: after the first `state`, sends `set` for the first number
  entry through the real transport and logs follow-up state. Logs land in
  stdout of the app process.

## Upstream limitations

- **`NSURLSessionWebSocketTask` is unreachable in the JSC host** (evidence:
  `webSocketTaskWithURL` returned an object whose prototype lists only
  `NSURLSessionTask` members — `receive`/`send`/`resume` printed `undefined`
  for the ws selectors in `/tmp/panel-app.log`). `transport.macos.ts` therefore
  hand-rolls the client over `NWConnection`; framing lives in
  `src/ws-frames.ts` (plain `ws://`, no TLS). To reproduce: log
  `Object.getOwnPropertyNames(Object.getPrototypeOf(task))` in any bundle
  launched through the packaged app or `xplat dev macos`.
- **Packaging expects isolated `node_modules`.** `xplat dev/build` resolves
  `app/node_modules/{vite,octane,@nativescript/macos-node-api}` literally, but
  the official consumer template mandates `nodeLinker: hoisted` (deps land in
  the workspace root). `link-host-deps.mjs` (postinstall) materializes the
  three symlinks; it self-heals after `pnpm dev:published`'s node_modules wipe.
- **Published `macos-renderer@0.17.1` ships no `libxplatmason.dylib`.** Its
  loader (`src/mason.ts`) only checks `XPLAT_MASON_LIB` and monorepo cwd paths,
  so packaged consumers get `masonview lays out nothing`. `pnpm dev` passes
  `XPLAT_MASON_LIB` at `links/octane-xplat/packages/macos-renderer/native/
  xplatmason/libxplatmason.dylib` when the checkout is linked (see
  `dev-macos.mjs`). **Packaged .app currently lays out empty** until the
  renderer ships the dylib.
- **No color picker in `@octane-xplat/ui`** — hex TextInput + swatch only.

## Verified / limits

- Verified: package build (`xplat build --targets macos` → signed .app + dmg),
  transport connect/`state` receive, selftest `set` → playground DOM change +
  dirty broadcast — through host logs and a browser assertion.
- NOT verified: OS-level input on AppKit controls (clicking the native
  slider/switch), keep-on-top effect, visual appearance (no stylesheets on
  AppKit — inline props only).
- Known gaps in the framework/bridge: `NSURLSessionWebSocketTask` metadata
  absent (worked around with NWConnection); `xplat dev macos`'s
  `app/node_modules/...` checks assume isolated-layout node_modules
  (worked around with `link-host-deps.mjs` postinstall).
